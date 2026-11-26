import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../electron/memory/memory';
import { CallBudget } from '../scripts/lib/fidelity-run';
import { FIDELITY_CARDS } from '../scripts/lib/fidelity-scenarios';
import {
  applyDrops, parseDropList, armInputs, armsFor, armStats, buildSeedRecords, buildSheet, dayNumberAt, fakeSummaryAsk, isProfilePath, loadSnapshot, locatePoint, makeSummaries, markTimes,
  moodAt, needsMarker, nextUserMessage, parseMoodEntries, parsePoints, planRuns, profileHostContext, runReplay, scopeKeyOf, sheetContext, tallyPicks, timeMarker,
  togetherDaysBefore, weightsAt, writeReplayOutputs, loadCachedRecords, type ReplayReply, type Timed,
} from '../scripts/lib/i134-replay';
import { SUMMARY_INSTRUCTION, summaryHostContext, buildSummaryPrompt } from '../scripts/lib/i134-summary-prompt';
import { countLeaks } from '../scripts/lib/i112-i115-blind';

const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
const msg = (i: number, role: 'user' | 'assistant', at: number): Timed => ({ role, content: `m${i}`, createdAt: at });

test('time markers: a new local day or a gap of 3 hours or more, never the first message, local H:mm', () => {
  assert.equal(timeMarker(local(11, 5, 21, 30)), '【11月5日 21:30】');
  assert.equal(timeMarker(local(1, 2, 9, 5)), '【1月2日 09:05】');
  assert.equal(needsMarker(null, local(11, 5, 21)), false);
  assert.equal(needsMarker(local(11, 5, 21), local(11, 5, 23, 59)), false);
  assert.equal(needsMarker(local(11, 5, 21), local(11, 6, 0, 10)), true, 'another day, only 3 hours later by the clock is not needed');
  assert.equal(needsMarker(local(11, 5, 10), local(11, 5, 13)), true, 'exactly 3 hours');
  assert.equal(needsMarker(local(11, 5, 10), local(11, 5, 12, 59)), false);
  const marked = markTimes([msg(0, 'user', local(11, 5, 10)), msg(1, 'assistant', local(11, 5, 10, 1)), msg(2, 'user', local(11, 5, 14)), msg(3, 'assistant', local(11, 6, 8))]);
  assert.deepEqual(marked.map(m => m.content), ['m0', 'm1', '【11月5日 14:00】m2', '【11月6日 08:00】m3']);
});

test('mood lookup: last label at or before the point, hers only, known labels only, `to` or `labelAfter`', () => {
  const lines = [
    JSON.stringify({ type: 'mood-label', characterId: 'c1', from: 'calm', to: 'happy', at: 100 }),
    JSON.stringify({ type: 'mood-label', characterId: 'other', from: 'calm', to: 'sad', at: 150 }),
    JSON.stringify({ type: 'mood-label', characterId: 'c1', labelAfter: 'sad', at: 200 }),
    JSON.stringify({ type: 'mood-label', characterId: 'c1', to: 'not-a-label', at: 250 }),
    JSON.stringify({ type: 'mood-event', characterId: 'c1', labelAfter: 'angry', at: 260 }),
    'not json "mood-label"', '',
  ];
  const entries = parseMoodEntries(lines, 'c1');
  assert.deepEqual(entries.map(e => [e.at, e.label]), [[100, 'happy'], [200, 'sad']]);
  assert.equal(moodAt(entries, 99), null);
  assert.equal(moodAt(entries, 100), 'happy');
  assert.equal(moodAt(entries, 199), 'happy');
  assert.equal(moodAt(entries, 5000), 'sad');
});

test('arm inputs: A/C/D see 23 before + current, B sees everything before, markers identical in both', () => {
  const messages: Timed[] = Array.from({ length: 41 }, (_, i) => msg(i, i % 2 === 0 ? 'user' : 'assistant', local(11, 5, 8) + i * 60_000));
  messages[30] = { ...messages[30]!, createdAt: local(11, 6, 9) }; // a marker lands inside both windows
  for (let i = 31; i < 41; i++) messages[i] = { ...messages[i]!, createdAt: local(11, 6, 9) + (i - 30) * 60_000 };
  const marked = markTimes(messages);
  const index = 40;
  const a = armInputs('A', marked, index), b = armInputs('B', marked, index), c = armInputs('C', marked, index), d = armInputs('D', marked, index);
  assert.equal(a.history.length, 23);
  assert.equal(a.history.length + 1, 24, 'same total as validation.ts');
  assert.equal(b.history.length, 40);
  assert.deepEqual(a.history, b.history.slice(-23));
  assert.deepEqual(c, a); assert.deepEqual(d, a);
  assert.equal(a.user, 'm40');
  assert.ok(b.history[30]!.content.startsWith('【11月6日 09:00】'));
  assert.equal(armInputs('A', marked, 5).history.length, 5, 'short chats are not padded');
  assert.equal(nextUserMessage(marked, 38), 'm40');
  assert.equal(nextUserMessage(marked, 40), null);
  assert.equal(sheetContext(marked, 40).length, 4);
  const long = markTimes([msg(0, 'user', 1_000_000), msg(1, 'user', 1_000_001)]);
  long[0]!.content = '长'.repeat(300);
  assert.equal(Array.from(sheetContext(long, 1)[0]!.text).length, 201);
});

test('points: parsed strictly, the user message found by exact createdAt, a clear error when missing', () => {
  assert.deepEqual(parsePoints('[{"id":"p01","at":1700000000000}]'), [{ id: 'p01', at: 1700000000000 }]);
  assert.throws(() => parsePoints('[]'), /非空数组/u);
  assert.throws(() => parsePoints('[{"id":"p01","at":1},{"id":"p01","at":2}]'), /重复/u);
  assert.throws(() => parsePoints('[{"id":"a b","at":1}]'), /id/u);
  assert.throws(() => parsePoints('[{"id":"p1","at":"x"}]'), /at/u);
  const messages = [msg(0, 'user', 10), msg(1, 'assistant', 10), msg(2, 'user', 20)];
  assert.equal(locatePoint(messages, { id: 'p1', at: 20 }), 2);
  assert.equal(locatePoint(messages, { id: 'p1', at: 10 }), 0, 'the user message, not her reply with the same time');
  assert.throws(() => locatePoint(messages, { id: 'p9', at: 15 }), /p9.*找不到/u);
});

test('relationship numbers: day count from the first message, together days before the point', () => {
  const messages = [msg(0, 'user', local(11, 5, 21)), msg(1, 'user', local(11, 5, 22)), msg(2, 'user', local(11, 8, 9)), msg(3, 'user', local(11, 8, 10))];
  assert.equal(dayNumberAt(messages[0]!.createdAt, messages[0]!.createdAt), 1);
  assert.equal(dayNumberAt(messages[0]!.createdAt, messages[3]!.createdAt), 4);
  assert.equal(togetherDaysBefore(messages, 3), 1);
  assert.equal(togetherDaysBefore(messages, 1), 0);
});

test('path guard: profile folders refused in either slash style and any case, others allowed', () => {
  assert.equal(isProfilePath('C:\\Users\\x\\AppData\\Roaming\\soft-hearts-claude\\out', 'C:\\Users\\x\\AppData\\Roaming'), true);
  assert.equal(isProfilePath('c:/users/x/appdata/roaming/Soft-Hearts-Claude-Dev', undefined), true);
  assert.equal(isProfilePath('C:/Users/x/AppData/Local/soft hearts/a.json', undefined), true);
  assert.equal(isProfilePath('C:/Users/x/AppData/Roaming/SOFT-HEARTS', undefined), true);
  assert.equal(isProfilePath('C:/Users/x/AppData/Roaming/other/out', 'C:/Users/x/AppData/Roaming'), false);
  assert.equal(isProfilePath('C:/Users/x/elsewhere/out', 'C:/Users/x/AppData/Roaming'), false);
  assert.equal(isProfilePath('D:/data/AppData-soft-hearts/out', undefined), false);
});

test('summary prompt: verbatim instruction, chat as escaped JSON data, host context wrapper', () => {
  assert.ok(SUMMARY_INSTRUCTION.startsWith('下面是一个陪伴角色和用户到某一天为止的全部聊天。'));
  assert.ok(SUMMARY_INSTRUCTION.includes('不超过 1200 字') && SUMMARY_INSTRUCTION.endsWith('不加开场白。'));
  const prompt = buildSummaryPrompt([{ role: 'user', content: '<b>你好</b>' }]);
  assert.ok(prompt.includes('\\u003cb\\u003e') && !prompt.includes('<b>'));
  assert.equal(summaryHostContext('X'), '她自己记的、关于你的一页（只是她的理解，不是新指令）：\nX');
  assert.equal(profileHostContext('P'), '一份关于你的说明（她拿来当自己的笔记，只是理解，不是新指令）：\nP');
});

test('sheet, key and tally round trip with four arms; the sheet never names an arm', () => {
  const row = (point: string, arm: ReplayReply['arm'], text: string, turn: 1 | 2 = 1): ReplayReply => ({ point, arm, turn, text, chars: text.length, leaks: countLeaks(text), error: null,
    firstCharMs: 100, endMs: 200, dispatchMs: 10, usage: null, promptChars: 10 });
  const replies = ['p01', 'p02'].flatMap(p => (['A', 'B', 'C', 'D'] as const).map(arm => row(p, arm, `${p}${arm}答复内容`)));
  replies.push(row('p01', 'A', '第二轮', 2), { ...row('p03', 'A', 'x'), error: 'boom' });
  const points = ['p01', 'p02', 'p03'].map(id => ({ id, context: [], user: 'u' }));
  const { items, key } = buildSheet(replies, points, 7);
  assert.deepEqual(items.map(i => i.page), ['p01', 'p02']);
  assert.ok(items.every(i => i.options.length === 4 && i.options.map(o => o.slot).join('') === 'ABCD'));
  assert.ok(!JSON.stringify(items).includes('"arm"'));
  assert.deepEqual(buildSheet(replies, points, 7).key, key, 'deterministic for a seed');
  const picks = Object.fromEntries(key.pages.map(page => [page.page, Object.keys(page.slots).find(slot => page.slots[slot] === 'D')!]));
  assert.deepEqual(tallyPicks(picks, key), { answered: 2, pages: 2, wins: { D: 2 }, arms: ['A', 'B', 'C', 'D'] });
  const stats = armStats(replies, 'A');
  assert.equal(stats.replies, 2); assert.equal(stats.errors, 1);
  assert.equal(armStats(replies, 'A', 2).replies, 1);
  assert.deepEqual(armsFor(false), ['A', 'B', 'C']);
  assert.deepEqual(armsFor(true), ['A', 'B', 'C', 'D']);
});

// ---- a tiny synthetic snapshot ---------------------------------------------------------------------------------------------------

const SCOPE = { characterId: 'char-1', providerScope: 'prov-1' };
interface Fixture { dir: string; atOf: (turn: number) => number; cleanup: () => Promise<void> }
async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i134-test-snapshot-'));
  const store = new MemoryStore(dir);
  await store.load();
  const times = [local(11, 5, 21, 0), local(11, 5, 21, 5), local(11, 6, 9, 0), local(11, 6, 9, 3), local(11, 6, 20, 0), local(11, 7, 8, 0), local(11, 7, 8, 5), local(11, 7, 12, 0)];
  for (const [i, at] of times.entries()) {
    const id = `t${i}`;
    await store.beginTurn(SCOPE, { id, userText: `今天第${i}件事，我吃了牛肉面`, at, conversationId: 'conv' });
    await store.appendAssistant(SCOPE, id, `嗯，第${i}件，听起来不错`, at + 1000);
    await store.finishTurn(SCOPE, id, 'complete', at + 2000);
  }
  await store.seal(SCOPE); await store.flush();
  await mkdir(path.join(dir, 'journal'));
  await writeFile(path.join(dir, 'journal', '2026-11-06.jsonl'), [
    JSON.stringify({ v: 1, type: 'mood-label', characterId: 'char-1', from: 'calm', to: 'happy', at: local(11, 6, 8, 0) }),
    JSON.stringify({ v: 1, type: 'mood-label', characterId: 'char-1', from: 'happy', to: 'sad', at: local(11, 7, 7, 0) }),
  ].join('\n') + '\n');
  return { dir, atOf: turn => times[turn]!, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('snapshot: loaded read-only from a scratch copy, scope picked by message count, moods read', async () => {
  const fx = await fixture();
  try {
    const before = await readFile(path.join(fx.dir, 'memories.jsonl'), 'utf8');
    const snapshot = await loadSnapshot(fx.dir);
    assert.equal(snapshot.messages.length, 16);
    assert.deepEqual(snapshot.scope, SCOPE);
    assert.equal(moodAt(snapshot.moods, fx.atOf(5)), 'sad');
    assert.equal(moodAt(snapshot.moods, fx.atOf(2)), 'happy');
    assert.equal(await readFile(path.join(fx.dir, 'memories.jsonl'), 'utf8'), before, 'the snapshot file is untouched');
    await snapshot.close();
    await assert.rejects(loadSnapshot(fx.dir, { characterId: 'nobody' }), /找不到/u);
  } finally { await fx.cleanup(); }
});

test('seeding: only records and messages strictly before the point come back, under the new scope', async () => {
  const fx = await fixture();
  const target = await mkdtemp(path.join(os.tmpdir(), 'i134-test-target-'));
  try {
    const snapshot = await loadSnapshot(fx.dir);
    const point = fx.atOf(3);
    const newScope = { characterId: 'fresh', providerScope: 'fresh-provider' };
    const records = buildSeedRecords(snapshot.cache, weightsAt(snapshot.store, snapshot.scope, point), point, scopeKeyOf(newScope));
    const texts = (records as { messages: { content: string }[] }[]).flatMap(r => r.messages.map(m => m.content)).join('|');
    assert.ok(texts.includes('第2件事') && texts.includes('第2件，'));
    assert.ok(!texts.includes('第3件事') && !texts.includes('第4件事'), 'the point and everything later are dropped');
    const store = new MemoryStore(target);
    await store.load();
    assert.ok(await store.restoreRecords(records, newScope) > 0);
    const page = store.list(newScope, {});
    assert.equal(page.total, records.length);
    const seeded = store.conversationMessages(newScope, 0, Number.MAX_SAFE_INTEGER);
    assert.equal(seeded.length, 6, 'turns 0 to 2, both sides');
    assert.ok(seeded.every(m => m.createdAt < point));
    await snapshot.close();
  } finally { await fx.cleanup(); await rm(target, { recursive: true, force: true }); }
});

test('summaries: one per day from the messages before that day; failure of the day check; fake costs nothing', async () => {
  const fx = await fixture();
  try {
    const snapshot = await loadSnapshot(fx.dir);
    const made = await makeSummaries(snapshot.messages, ['2026-11-06', '2026-11-07'], fakeSummaryAsk);
    assert.ok(made['2026-11-06']!.includes('4 条消息') && made['2026-11-07']!.includes('10 条消息'));
    await assert.rejects(makeSummaries(snapshot.messages, ['2026-11-05'], fakeSummaryAsk), /没有聊天/u);
    await assert.rejects(makeSummaries(snapshot.messages, ['2026-13-40'], fakeSummaryAsk), /不存在|YYYY/u);
    await snapshot.close();
  } finally { await fx.cleanup(); }
});

test('fake end to end: arms A/B/C without a profile, A/B/C/D with one; latency turn only for A and B; outputs and resume', async () => {
  const fx = await fixture();
  const out = await mkdtemp(path.join(os.tmpdir(), 'i134-test-out-'));
  try {
    const snapshot = await loadSnapshot(fx.dir);
    const points = [{ id: 'p01', at: fx.atOf(2) }, { id: 'p02', at: fx.atOf(5) }];
    const summaries = { '2026-11-06': '摘要一', '2026-11-07': '摘要二' };
    const base = { snapshot, points, card: FIDELITY_CARDS[0]!, model: '', binary: process.execPath, binaryArgs: [path.join(import.meta.dirname, '..', 'scripts', 'lib', 'prompt-eval-fake-claude.mjs')],
      prewarmMs: 0, seed: 11, summaries, latencyPoints: 1 };
    // Without a profile: D is not planned at all (and asking for it is an error).
    assert.throws(() => planRuns({ ...base, arms: ['A', 'D'] }), /profile-file/u);
    const plain = await runReplay({ ...base, budget: new CallBudget(0, Infinity, Infinity, false), arms: armsFor(false) });
    assert.equal(plain.stopped, null);
    assert.deepEqual([...new Set(plain.replies.map(r => r.arm))].sort(), ['A', 'B', 'C']);
    assert.equal(plain.replies.filter(r => r.turn === 1).length, 6);
    assert.deepEqual(plain.replies.filter(r => r.turn === 2).map(r => r.arm).sort(), ['A', 'B'], 'latency turn: first point, A and B only');
    assert.ok(plain.replies.every(r => !r.error && r.text.length > 0 && r.firstCharMs !== null && r.usage !== null));
    // Arm B carries the whole earlier chat, A and C the window; C carries the summary on top.
    const prompt = (arm: string) => plain.replies.find(r => r.point === 'p02' && r.arm === arm && r.turn === 1)!.promptChars!;
    assert.equal(prompt('B'), prompt('A'), 'with fewer than 23 earlier messages the two windows coincide');
    assert.ok(prompt('C') > prompt('A'), 'C adds the summary');

    const withProfile = await runReplay({ ...base, budget: new CallBudget(0, Infinity, Infinity, false), arms: armsFor(true), profile: '她喜欢牛肉面' });
    assert.equal(withProfile.stopped, null);
    assert.equal(withProfile.replies.filter(r => r.turn === 1).length, 8);
    const promptD = withProfile.replies.find(r => r.point === 'p02' && r.arm === 'D')!.promptChars!;
    const promptA = withProfile.replies.find(r => r.point === 'p02' && r.arm === 'A')!.promptChars!;
    assert.ok(promptD > promptA + 10, 'D carries the profile text on top of A');

    const written = await writeReplayOutputs(out, withProfile.replies, withProfile.points, 11, armsFor(true), { fake: true });
    for (const file of Object.values(written.files)) assert.ok((await readFile(file, 'utf8')).length > 0, file);
    assert.ok(written.items.every(item => item.options.length === 4));
    assert.ok((await readFile(written.files.summary, 'utf8')).includes('D 画像'));
    const key = JSON.parse(await readFile(written.files.key, 'utf8'));
    assert.equal(key.pages.length, 2);

    // Resume: everything kept means nothing is planned; one dropped reply is asked again (with its latency twin when it had one).
    const done = planRuns({ ...base, arms: armsFor(true), profile: 'x', kept: withProfile.replies });
    assert.equal(done.calls, 0);
    const partial = withProfile.replies.filter(r => !(r.point === 'p01' && r.arm === 'B'));
    const again = planRuns({ ...base, arms: armsFor(true), profile: 'x', kept: partial });
    assert.equal(again.calls, 2, 'p01 B has the latency turn too');
    // Missing summary for arm C fails before any call.
    assert.throws(() => planRuns({ ...base, arms: ['C'], summaries: { '2026-11-06': 'x' } }), /缺 2026-11-07 的摘要/u);
    await snapshot.close();
  } finally { await fx.cleanup(); await rm(out, { recursive: true, force: true }); }
});

test('drop-messages: dropped replies leave history, summaries and seeded records; empty records go; user messages stay', async () => {
  const fx = await fixture();
  try {
    assert.throws(() => parseDropList('{}'), /数组/u);
    assert.throws(() => parseDropList('["x"]'), /数组/u);
    const drop = parseDropList(JSON.stringify([fx.atOf(2) + 1000, fx.atOf(7) + 1000, 123]));
    const snapshot = await loadSnapshot(fx.dir, { dropAssistantAt: drop });
    assert.equal(snapshot.dropped, 2);
    assert.equal(snapshot.messages.length, 14);
    assert.ok(snapshot.messages.some(m => m.role === 'user' && m.createdAt === fx.atOf(2)), 'her reply goes, the user message of the turn stays');
    assert.ok(!snapshot.messages.some(m => m.role === 'assistant' && m.createdAt === fx.atOf(2) + 1000));
    const marked = markTimes(snapshot.messages);
    const index = locatePoint(snapshot.messages, { id: 'p', at: fx.atOf(5) });
    assert.ok(!armInputs('B', marked, index).history.some(m => m.content.includes('第2件，')));
    const point = fx.atOf(5);
    const texts = (buildSeedRecords(snapshot.cache, weightsAt(snapshot.store, snapshot.scope, point), point, 'a'.repeat(64)) as { messages: { content: string }[] }[]).flatMap(r => r.messages.map(m => m.content)).join('|');
    assert.ok(!texts.includes('第2件，') && texts.includes('第2件事') && texts.includes('第1件，'));
    const made = await makeSummaries(snapshot.messages, ['2026-11-07'], fakeSummaryAsk);
    assert.ok(made['2026-11-07']!.includes('9 条消息'), 'summary input has one reply fewer');
    await snapshot.close();
    // A record whose only messages are dropped replies disappears.
    const only = applyDrops([], [{ summary: { id: 'r' } as never, messages: [{ role: 'assistant', createdAt: 5 } as never] }], new Set([5]));
    assert.equal(only.cache.length, 0);
  } finally { await fx.cleanup(); }
});

test('cached records read whole messages even when they are longer than one text page', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'i134-test-long-'));
  try {
    const store = new MemoryStore(dir);
    await store.load();
    const long = '很长'.repeat(3000);
    await store.beginTurn(SCOPE, { id: 'x', userText: long, at: local(11, 5, 10), conversationId: 'c' });
    await store.appendAssistant(SCOPE, 'x', '好', local(11, 5, 10) + 1);
    await store.finishTurn(SCOPE, 'x', 'complete', local(11, 5, 10) + 2);
    await store.flush();
    const cache = loadCachedRecords(store, SCOPE);
    assert.equal(cache[0]!.messages[0]!.content, long);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('I-134 replay: a refusal is kept as an outcome on --resume unless --retry-refused', async () => {
  const { keepOnResume, isRefused } = await import('../scripts/lib/i134-replay');
  const { CLAUDE_REFUSED_MESSAGE } = await import('../electron/brain/claude');
  const base = { point: 'p01', arm: 'B' as const, turn: 1 as const, text: '在呢', chars: 2, leaks: { labels: 0, english: 0, digits: 0, brackets: 0 }, firstCharMs: null, endMs: null, dispatchMs: null, usage: null, promptChars: null };
  const refused = { ...base, chars: 40, error: CLAUDE_REFUSED_MESSAGE };
  const failed = { ...base, chars: 40, error: '额度用完了' };
  assert.equal(isRefused(refused), true);
  assert.equal(keepOnResume(refused), true);
  assert.equal(keepOnResume(refused, true), false);
  assert.equal(keepOnResume(failed), false);
  assert.equal(keepOnResume({ ...base, chars: 12, error: null }), true);
});

test('I-134 replay: ranking tally makes ranks dense, counts ties, firsts, lasts and pairs, and skips incomplete pages', async () => {
  const { tallyRanks, rankSheetHtml } = await import('../scripts/lib/i134-replay');
  const key = { seed: 1, pages: [
    { page: 'p01', slots: { A: 'B', B: 'A', C: 'C' } },
    { page: 'p02', slots: { A: 'A', B: 'C', C: 'D', D: 'B' } },
    { page: 'p03', slots: { A: 'A', B: 'B' } },
  ] } as const;
  const t = tallyRanks({ ranks: { p01: { A: 1, B: 3, C: 3 }, p02: { A: 2, B: 2, C: 2, D: 2 }, p03: { A: 1 } }, skipped: ['p04'] }, key as never);
  assert.equal(t.ranked, 2);
  assert.equal(t.skipped, 1);
  // p01: B (slot A) rank 1; A and C tie at dense 2. p02: all tied at 1.
  assert.equal(t.meanRank.B, 1);
  assert.equal(t.meanRank.A, 1.5);
  assert.equal(t.best.B, 2);
  assert.equal(t.worst.A, 1);
  assert.equal(t.worst.B, 0);
  assert.equal(t.worst.D, 0);
  assert.deepEqual(t.pairs['A>B'], { better: 0, worse: 1, tied: 1 });
  assert.deepEqual(t.pairs['A>C'], { better: 0, worse: 0, tied: 2 });
  const html = rankSheetHtml([{ page: 'p01', context: [{ role: 'user', text: '<b>x</b>' }], user: 'hi', options: [{ slot: 'A', text: 'a' }] }]);
  assert.ok(html.includes('ranks.json'));
  assert.ok(!html.includes('<b>x</b>'));
});

test('I-134 replay: arm E sees the whole local day plus N messages before it', async () => {
  const { armInputs, dayStartMs } = await import('../scripts/lib/i134-replay');
  const day1 = dayStartMs('2026-11-10'), day2 = dayStartMs('2026-11-11');
  const marked = [
    ...Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `d1-${i}`, createdAt: day1 + 3_600_000 + i * 60_000 })),
    ...Array.from({ length: 4 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `d2-${i}`, createdAt: day2 + 3_600_000 + i * 60_000 })),
    { role: 'user' as const, content: 'now', createdAt: day2 + 7_200_000 },
  ];
  const e2 = armInputs('E', marked, 10, 2);
  assert.deepEqual(e2.history.map(m => m.content), ['d1-4', 'd1-5', 'd2-0', 'd2-1', 'd2-2', 'd2-3']);
  assert.equal(e2.user, 'now');
  assert.equal(armInputs('E', marked, 10, 0).history.length, 4);
  assert.equal(armInputs('E', marked, 10, 100).history.length, 10);
});
