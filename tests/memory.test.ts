import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, appendFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MEMORY_SCOPES_FILE, MemoryStore } from "../electron/memory";
import { DEFAULT_MEMORY_CONFIG, deriveMemoryMetadata, memoryWeightAt, validateMemoryConfig, type MemoryScope } from "../shared/memory";

const now = 1_800_000_000_000;
const scope: MemoryScope = { characterId: "gene", providerScope: "codex:model-a" };
const otherCharacter: MemoryScope = { characterId: "other", providerScope: scope.providerScope };
const otherProvider: MemoryScope = { characterId: scope.characterId, providerScope: "https://new.example/v1:model-b" };
async function withStore(run: (store: MemoryStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "soft-memory-test-"));
  try { const store = new MemoryStore(directory); await store.load(); await run(store, directory); await store.flush(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
/** The journal and, beside it, only the list of which character and connection each scope is (I-021 删除一致性): no text in it. */
async function onlyTheArchive(directory: string, words: string[]) {
  assert.deepEqual((await readdir(directory)).sort(), ["memories.jsonl", MEMORY_SCOPES_FILE]);
  const scopes = await readFile(path.join(directory, MEMORY_SCOPES_FILE), "utf8");
  for (const word of words) assert.ok(!scopes.includes(word), `${MEMORY_SCOPES_FILE} holds no conversation text`);
  assert.deepEqual(Object.keys(JSON.parse(scopes)).sort(), ["scopes", "version"]);
}
async function complete(store: MemoryStore, id: string, text: string, at = now, archiveScope = scope, conversationId = "conversation") {
  const handle = await store.beginTurn(archiveScope, { id, userText: text, at, conversationId });
  await store.appendAssistant(archiveScope, id, `回应：${text}`, at + 1);
  await store.finishTurn(archiveScope, id, "complete", at + 2);
  return handle;
}

test("full originals and millisecond times survive restart; bounded pages never truncate storage", async () => {
  await withStore(async (store, directory) => {
    const userText = "完整原文😀\n".repeat(2000) + "USER_END";
    const assistantText = "流式正文🫶\n".repeat(2000) + "ASSISTANT_END";
    const handle = await store.beginTurn(scope, { id: "long", userText, at: now });
    await store.appendAssistant(scope, "long", assistantText, now + 123);
    await store.finishTurn(scope, "long", "complete", now + 250);
    const restored = new MemoryStore(directory); await restored.load();
    const first = restored.read(scope, handle.recordId, {}, now)!;
    assert.equal(first.messages[0].createdAt, now);
    assert.equal(first.messages[1].createdAt, now + 123);
    assert.equal(first.messages[1].updatedAt, now + 250);
    assert.equal(Array.from(first.messages[0].content).length, 4000);
    for (const [index, expected] of [userText, assistantText].entries()) {
      let result = ""; let offset = 0;
      while (true) {
        const page = restored.read(scope, handle.recordId, { messageOffset: index, messageLimit: 1, textOffset: offset }, now)!.messages[0];
        result += page.content;
        if (page.nextTextOffset === undefined) break;
        offset = page.nextTextOffset;
      }
      assert.equal(result, expected);
    }
    await onlyTheArchive(directory, ["USER_END", "ASSISTANT_END", "完整原文"]);
  });
});

test("stopped, errored and interrupted streams retain only produced text and do not duplicate a turn", async () => {
  await withStore(async (store, directory) => {
    const first = await store.beginTurn(scope, { id: "stopped", userText: "先说一半", at: now });
    assert.deepEqual(await store.beginTurn(scope, { id: "stopped", userText: "retry must not replace original", at: now + 1 }), first);
    await store.appendAssistant(scope, "stopped", "已输出部分", now + 2);
    assert.equal(await store.finishTurn(scope, "stopped", "stopped", now + 3), true);
    assert.equal(await store.appendAssistant(scope, "stopped", "LATE", now + 4), false);
    await store.beginTurn(scope, { id: "error", userText: "发生错误", at: now + 5 });
    await store.appendAssistant(scope, "error", "错误前正文", now + 6);
    await store.finishTurn(scope, "error", "error", now + 7);
    await store.beginTurn(scope, { id: "interrupted", userText: "程序退出", at: now + 8 });
    await store.appendAssistant(scope, "interrupted", "退出前正文", now + 9);
    const restored = new MemoryStore(directory); await restored.load();
    const page = restored.read(scope, first.recordId, { messageLimit: 10 }, now + 10)!;
    assert.equal(page.messages.length, 6);
    assert.deepEqual(page.messages.filter(message => message.role === "assistant").map(message => [message.content, message.status]), [
      ["已输出部分", "stopped"], ["错误前正文", "error"], ["退出前正文", "interrupted"],
    ]);
    assert.equal(await restored.appendAssistant(scope, "interrupted", "LATE", now + 11), false);
  });
});

test("ten turns, inactivity, explicit topic change and new conversations split whole turns with continuation links", async () => {
  await withStore(async store => {
    let first = "";
    for (let index = 0; index < 10; index++) { const handle = await complete(store, `turn-${index}`, "一起聊电影", now + index * 10); first ||= handle.recordId; assert.equal(handle.recordId, first); }
    const continuation = await complete(store, "turn-10", "继续聊电影", now + 110);
    assert.notEqual(continuation.recordId, first);
    assert.equal(store.read(scope, continuation.recordId, {}, now + 200)?.continuationOf, first);
    const gap = await complete(store, "after-gap", "继续聊电影", now + 110 + 2 + 15 * 60_000);
    assert.equal(store.read(scope, gap.recordId, {}, now + 1_000_000)?.continuationOf, continuation.recordId);
    const topic = await complete(store, "topic", "换个话题，聊音乐", now + 1_000_000);
    assert.equal(store.read(scope, topic.recordId, {}, now + 1_000_001)?.continuationOf, undefined);
    const conversation = await complete(store, "conversation", "还是音乐", now + 1_000_010, scope, "new-conversation");
    assert.notEqual(conversation.recordId, topic.recordId);
    assert.equal(store.list(scope, {}, now + 1_000_020).total, 5);
    await store.seal(scope);
    const sealed = await complete(store, "after-seal", "音乐", now + 1_000_030, scope, "new-conversation");
    assert.notEqual(sealed.recordId, conversation.recordId);
    assert.equal(store.list(scope, {}, now + 1_000_040).total, 6);
  });
});

test("manual title, tags and category survive subsequent automatic organization and reload", async () => {
  await withStore(async (store, directory) => {
    const handle = await complete(store, "one", "聊电影《小森林》");
    await store.edit(scope, handle.recordId, { title: "我的手动标题", tags: ["私有标签", "小森林"], category: "设定/偏好" });
    await complete(store, "two", "接着聊音乐", now + 100);
    const restored = new MemoryStore(directory); await restored.load();
    const record = restored.read(scope, handle.recordId, {}, now + 200)!;
    assert.equal(record.title, "我的手动标题");
    assert.deepEqual(record.tags, ["私有标签", "小森林"]);
    assert.equal(record.category, "设定/偏好");
    assert.equal(record.weight, 20);
  });
});

test("character and provider scopes isolate lists, original reads, edits, retrieval and reinforcement", async () => {
  await withStore(async (store, directory) => {
    const handle = await complete(store, "private", "电影《隐私原文》");
    await complete(store, "other-character", "别的角色", now, otherCharacter);
    await complete(store, "other-provider", "新的连接", now, otherProvider);
    assert.equal(store.list(scope, {}, now).total, 1);
    assert.equal(store.list(otherCharacter, {}, now).total, 1);
    assert.equal(store.read(otherCharacter, handle.recordId, {}, now), undefined);
    assert.deepEqual(store.retrieve(otherProvider, "电影", {}, now), []);
    assert.equal(await store.reinforce(otherCharacter, handle.recordId, { eventId: "e", episodeId: "p", at: now }), undefined);
    await assert.rejects(store.edit(otherProvider, handle.recordId, { title: "非法越界" }));
    assert.equal(await store.delete(otherProvider, handle.recordId), false);
    const archive = await readFile(path.join(directory, "memories.jsonl"), "utf8");
    assert.ok(!archive.includes(otherProvider.providerScope));
  });
});

test("retrieval is read-only and explicit recall refuses ambiguous broad topics", async () => {
  await withStore(async store => {
    const old = await complete(store, "forest", "那天下雨，一起聊电影《小森林》");
    await store.seal(scope);
    const another = await complete(store, "rain", "雨天一起聊电影《千与千寻》", now + 10);
    const query = "还记得上次下雨时聊的电影吗";
    assert.deepEqual(store.detectExplicitRecall(scope, query), []);
    assert.equal(store.retrieve(scope, query, {}, now + 20).length, 2);
    assert.equal(store.read(scope, old.recordId, {}, now + 20)?.weight, 20);
    assert.deepEqual(store.detectExplicitRecall(scope, "还记得上次我们聊的《小森林》吗"), [old.recordId]);
    assert.deepEqual(store.detectExplicitRecall(scope, "今天又想看《小森林》"), []);
    assert.deepEqual(store.detectExplicitRecall(scope, "还记得上次聊的《千与千寻》吗", another.recordId), []);
    assert.equal(store.read(scope, old.recordId, {}, now + 30)?.weight, 20);
  });
});

test("recollection reinforcement uses rolling windows, caps, episode deduplication and real-time decay across restarts", async () => {
  await withStore(async (store, directory) => {
    const { recordId } = await complete(store, "weight", "电影《小森林》");
    const gains = [];
    for (let index = 0; index < 5; index++) gains.push(await store.reinforce(scope, recordId, { eventId: `event${index}`, episodeId: `episode${index}`, at: now }));
    assert.deepEqual(gains, [30, 35, 37, 37, 37]);
    assert.equal(await store.reinforce(scope, recordId, { eventId: "event-retry", episodeId: "episode0", at: now }), 37);
    const restored = new MemoryStore(directory); await restored.load();
    assert.equal(await restored.reinforce(scope, recordId, { eventId: "event0", episodeId: "new-episode", at: now }), 37);
    const dayLater = now + 24 * 3_600_000;
    const expected = memoryWeightAt(37, now, dayLater) + 10;
    assert.equal(await restored.reinforce(scope, recordId, { eventId: "next-day", episodeId: "next-day", at: dayLater }), expected);
    await restored.configure({ mentionGains: [100, 100, 100] });
    assert.equal(await restored.reinforce(scope, recordId, { eventId: "cap", episodeId: "cap", at: dayLater }), 100);
    assert.equal(restored.read(scope, recordId, {}, dayLater + 30 * 86_400_000)?.weight, 60);
    assert.equal(restored.read(scope, recordId, {}, dayLater + 60 * 86_400_000)?.weight, 40);
  });
});

test("deleting removes the original journal bytes, indexes and late writes without deleting independent records", async () => {
  await withStore(async (store, directory) => {
    const removed = await store.beginTurn(scope, { id: "delete", userText: "REMOVE_THIS_PRIVATE_ORIGINAL", at: now });
    await store.appendAssistant(scope, "delete", "REMOVE_THIS_PRIVATE_REPLY", now + 1);
    await store.finishTurn(scope, "delete", "stopped", now + 2);
    await store.seal(scope);
    const kept = await complete(store, "keep", "KEEP_THIS_ORIGINAL", now + 3);
    assert.equal(await store.delete(scope, removed.recordId), true);
    assert.equal(await store.appendAssistant(scope, "delete", "LATE_RECOVERY", now + 4), false);
    await assert.rejects(store.beginTurn(scope, { id: "delete", userText: "retry", at: now + 5 }));
    const journal = await readFile(path.join(directory, "memories.jsonl"), "utf8");
    assert.ok(!journal.includes("REMOVE_THIS_PRIVATE"));
    assert.ok(journal.includes("KEEP_THIS_ORIGINAL"));
    const restored = new MemoryStore(directory); await restored.load();
    assert.equal(restored.read(scope, removed.recordId, {}, now + 10), undefined);
    assert.equal(restored.read(scope, kept.recordId, {}, now + 10)?.title, "KEEP_THIS_ORIGINAL");
    assert.deepEqual(restored.retrieve(scope, "REMOVE_THIS_PRIVATE", {}, now + 10), []);
    await assert.rejects(restored.beginTurn(scope, { id: "delete", userText: "retry", at: now + 11 }));
    await onlyTheArchive(directory, ["REMOVE_THIS_PRIVATE", "KEEP_THIS_ORIGINAL"]);
  });
});

test("concurrent streaming appends serialize in order and journal growth tracks new text instead of rewriting the archive", async () => {
  await withStore(async (store, directory) => {
    await store.beginTurn(scope, { id: "stream", userText: "UNIQUE_LONG_PREFIX".repeat(1000), at: now });
    const before = (await readFile(path.join(directory, "memories.jsonl"), "utf8")).length;
    const chunks = Array.from({ length: 80 }, (_, index) => `${index},`);
    await Promise.all(chunks.map((delta, index) => store.appendAssistant(scope, "stream", delta, now + index)));
    await store.finishTurn(scope, "stream", "complete", now + 100);
    const after = (await readFile(path.join(directory, "memories.jsonl"), "utf8")).length;
    assert.ok(after - before < 30_000, "appends must not duplicate previous long originals");
    const id = store.list(scope, {}, now + 200).records[0].id;
    assert.equal(store.read(scope, id, {}, now + 200)?.messages[1].content, chunks.join(""));
  });
});

test("bounded list, read and recall pages preserve independent underlying records", async () => {
  await withStore(async store => {
    for (let index = 0; index < 6; index++) { await complete(store, `record${index}`, `电影《电影${index}》${"长正文".repeat(3000)}`, now + index * 100); await store.seal(scope); }
    const page = store.list(scope, { limit: 2, offset: 2, tag: "电影" }, now + 1000);
    assert.equal(page.records.length, 2); assert.equal(page.total, 6);
    const recalled = store.retrieve(scope, "电影", { maxRecords: 999, maxChars: 999999 }, now + 1000);
    assert.ok(recalled.length <= 3);
    assert.ok(recalled.reduce((sum, record) => sum + Array.from(record.excerpt).length, 0) <= 3000);
    const original = store.read(scope, page.records[0].id, { messageLimit: 999, textLimit: 99999 }, now + 1000)!;
    assert.ok(original.messages.length <= 10);
    assert.ok(original.messages.every(message => Array.from(message.content).length <= 4000));
    page.records[0].title = "must not mutate archive";
    assert.notEqual(store.read(scope, page.records[0].id, {}, now + 1000)?.title, page.records[0].title);
  });
});

test("incomplete trailing append recovers acknowledged text and reports the possible lost tail; interior corruption preserves the source", async () => {
  await withStore(async (store, directory) => {
    const { recordId } = await store.beginTurn(scope, { id: "tail", userText: "已完整写入", at: now });
    await store.appendAssistant(scope, "tail", "有效片段", now + 1);
    const file = path.join(directory, "memories.jsonl");
    await appendFile(file, '{"type":"delta","delta":"未完整');
    const restored = new MemoryStore(directory); await restored.load();
    assert.ok(restored.getNotice()?.includes("未完成"));
    assert.equal(restored.read(scope, recordId, {}, now + 2)?.messages[1].content, "有效片段");
    assert.equal(restored.read(scope, recordId, {}, now + 2)?.messages[1].status, "interrupted");
    const invalid = (await readFile(file, "utf8")) + "NOT_JSON\n";
    await writeFile(file, invalid);
    const broken = new MemoryStore(directory);
    await assert.rejects(broken.load(), /原文件已保留/);
    assert.equal(await readFile(file, "utf8"), invalid);
  });
});

test("trial config is validated, persisted and detached; local metadata stays faithful without model calls", async () => {
  await withStore(async (store, directory) => {
    assert.equal(memoryWeightAt(100, now, now - 100), 100);
    assert.equal(memoryWeightAt(20, now, now + 365 * 86_400_000), 20);
    assert.throws(() => validateMemoryConfig({ mentionGains: [1, 5, 2] }));
    assert.throws(() => validateMemoryConfig({ unknown: true }));
    assert.throws(() => validateMemoryConfig({ recallRecords: 4 }));
    assert.throws(() => validateMemoryConfig({ baseWeight: 50, maxWeight: 20 }));
    await store.configure({ segmentTurns: 2, segmentGapMinutes: 5 });
    const publicConfig = store.getConfig(); publicConfig.mentionGains[0] = 99;
    assert.equal(store.getConfig().mentionGains[0], 10);
    const restored = new MemoryStore(directory); await restored.load();
    assert.equal(restored.getConfig().segmentTurns, 2);
    const metadata = deriveMemoryMetadata("雨天聊电影《千与千寻》", ["雨天"]);
    assert.deepEqual(metadata.tags, ["千与千寻", "雨天", "电影"]);
    assert.equal(metadata.title, "雨天聊电影《千与千寻》");
    assert.equal(DEFAULT_MEMORY_CONFIG.baseWeight, 20);
    await assert.rejects(store.edit(scope, "nonexistent", { title: "x" }));
  });
});

test("persistent recall episodes survive restart, seal and new conversations, and renew only after leaving or a real gap", async () => {
  await withStore(async (store, directory) => {
    const { recordId } = await complete(store, "old-experience", "雨天一起聊电影《小森林》");
    await store.seal(scope);
    const text = "还记得上次聊的《小森林》吗";
    assert.deepEqual(await store.noteUserRecall(scope, text, { eventId: "note1", at: now }), [recordId]);
    assert.equal(store.read(scope, recordId, {}, now)?.weight, 30);
    const conversation = await complete(store, "new-chat", "这段故事真不错", now, scope, "another-conversation");
    assert.deepEqual(await store.noteUserRecall(scope, "嗯", { eventId: "brief-ack", at: now, excludeRecordId: conversation.recordId }), []);
    const restored = new MemoryStore(directory); await restored.load();
    assert.deepEqual(await restored.noteUserRecall(scope, text, { eventId: "note-after-restart", at: now, excludeRecordId: conversation.recordId }), []);
    assert.deepEqual(await restored.noteUserRecall(scope, text, { eventId: "note1", at: now, excludeRecordId: conversation.recordId }), []);
    assert.equal(restored.read(scope, recordId, {}, now)?.weight, 30);
    await restored.noteUserRecall(scope, "今天工作很忙，先说工作的事", { eventId: "unrelated-work", at: now });
    assert.deepEqual(await restored.noteUserRecall(scope, text, { eventId: "independent-recall", at: now, excludeRecordId: conversation.recordId }), [recordId]);
    assert.equal(restored.read(scope, recordId, {}, now)?.weight, 35);
    const later = now + 15 * 60_000;
    assert.deepEqual(await restored.noteUserRecall(scope, text, { eventId: "after-real-gap", at: later, excludeRecordId: conversation.recordId }), [recordId]);
    assert.equal(restored.read(scope, recordId, {}, later)?.weight, memoryWeightAt(35, now, later) + 2);
  });
});

test("assistant-suggested recollections need source-specific substantial user confirmation; simple retrieval and acknowledgements never reinforce", async () => {
  await withStore(async store => {
    const { recordId } = await complete(store, "old-film", "聊电影《小森林》");
    await store.seal(scope);
    assert.equal(store.retrieve(scope, "《小森林》", {}, now).length, 1);
    assert.equal(store.read(scope, recordId, {}, now)?.weight, 20);
    assert.deepEqual(await store.noteUserRecall(scope, "嗯", { eventId: "tiny-ack", at: now, confirmedRecordId: recordId }), []);
    assert.deepEqual(await store.noteUserRecall(scope, "你说的那件事情我知道了", { eventId: "generic-ack", at: now, confirmedRecordId: recordId }), []);
    assert.deepEqual(await store.noteUserRecall(scope, "对，就是《小森林》，我后来又看了一遍", { eventId: "specific-confirm", at: now, confirmedRecordId: recordId }), [recordId]);
    assert.equal(store.read(scope, recordId, {}, now)?.weight, 30);
    await store.noteUserRecall(scope, "Yes, that was lovely", { eventId: "english-ack", at: now });
    assert.deepEqual(await store.noteUserRecall(scope, "还记得上次《小森林》吗", { eventId: "same-episode", at: now }), []);
    assert.equal(store.read(scope, recordId, {}, now)?.weight, 30);
  });
});

test("deletion also removes persisted recall targets and their derived topic tags", async () => {
  await withStore(async (store, directory) => {
    const { recordId } = await complete(store, "private-named-experience", "聊电影《私密独特片名》");
    await store.noteUserRecall(scope, "还记得上次《私密独特片名》吗", { eventId: "source-recall", at: now });
    await store.delete(scope, recordId);
    const raw = await readFile(path.join(directory, "memories.jsonl"), "utf8");
    assert.ok(!raw.includes("私密独特片名"));
    assert.ok(!raw.includes(recordId));
    const restored = new MemoryStore(directory); await restored.load();
    assert.deepEqual(await restored.noteUserRecall(scope, "还记得上次《私密独特片名》吗", { eventId: "deleted-recall", at: now }), []);
  });
});
