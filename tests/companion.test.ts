import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService, memoryProviderScope, type CompanionTurn } from '../electron/companion';
import type { ProviderConfig } from '../shared/contracts';
import type { MemoryScope } from '../shared/memory';

const providerA: ProviderConfig = { kind: 'claude', baseUrl: 'https://first.example/v1', model: 'a' };
const providerB: ProviderConfig = { kind: 'claude', baseUrl: 'https://second.example/v1', model: 'b' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function withService(run: (service: CompanionService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-companion-test-'));
  const service = new CompanionService(directory, () => {});
  try { await service.load(); await service.context('gene', providerA, 'Gene'); await run(service, directory); }
  finally { await service.flush().catch(() => {}); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-companion-test-')); await rm(directory, { recursive: true, force: true }); }
}
function appraisal(turn: CompanionTurn, body = '你好。', delta = { O: 3 }): string {
  const opening = turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];
  assert.ok(opening, 'a request-specific protocol marker must be in the persona');
  return `${body}\n${opening}${JSON.stringify({ context: 'support', delta, confidence: 0.9, reason: '受到关心' })}${opening.replace('<', '</')}`;
}

test('normal replies archive displayed text only and apply exactly one chat response plus one bounded appraisal', async () => {
  await withService(async service => {
    const events: string[] = []; const original = service.mood.event.bind(service.mood);
    service.mood.event = (event, character) => { events.push(event.type); original(event, character); };
    const output: string[] = [];
    const turn = await service.begin('message', '你好', 'Gene', (type, text) => { if (type === 'delta') output.push(text); });
    turn.push('delta', appraisal(turn));
    const firstFinish = turn.finish('complete');
    assert.equal(turn.finish('complete'), firstFinish);
    await firstFinish;
    turn.push('delta', 'LATE');
    assert.equal(output.join(''), '你好。');
    assert.deepEqual(events, ['chat', 'appraisal']);
    assert.ok(service.mood.get().snapshot.values.O > 50);
    const record = service.memory.read(turn.scope, turn.recordId)!;
    assert.deepEqual(record.messages.map(message => [message.role, message.content, message.status]), [['user', '你好', 'complete'], ['assistant', '你好。', 'complete']]);
    assert.ok(!record.messages.some(message => message.content.includes('sh-state')));
  });
});

test('a model/window expression generation change preserves the reply and semantic values without replaying a late blush', async () => {
  await withService(async service => {
    const output: string[] = [];
    const turn = await service.begin('before-model-change', '原创支持测试', 'Gene', (type, text) => { if (type === 'delta') output.push(text); });
    service.mood.invalidate();
    turn.push('delta', appraisal(turn, '保留正常正文。', { O: 6 }));
    await turn.finish('complete');
    assert.equal(output.join(''), '保留正常正文。');
    assert.ok(service.mood.get().snapshot.values.O > 50);
    assert.equal(service.mood.get().snapshot.blush, null);
    assert.equal(service.mood.get().snapshot.cue, null);
    assert.equal(service.memory.list(service.currentScope()).total, 1);
  });
});

test('new conversation invalidates output and appraisal synchronously while preserving the stopped original and all past memory', async () => {
  await withService(async service => {
    const output: string[] = [];
    const turn = await service.begin('old-turn', '旧对话原文', 'Gene', (type, text) => { if (type === 'delta') output.push(text); });
    turn.push('delta', '已经产生的正文');
    const entered = deferred(), release = deferred(); const originalSeal = service.memory.seal.bind(service.memory);
    service.memory.seal = async scope => { entered.resolve(); await release.promise; await originalSeal(scope); };
    const reset = service.newConversation();
    turn.push('delta', appraisal(turn, 'LATE_APPRAISAL'));
    assert.throws(() => service.currentScope(), /切换/);
    await entered.promise; release.resolve(); await reset;
    await turn.finish('complete');
    assert.equal(output.join(''), '已经产生的正文');
    const old = service.memory.read(turn.scope, turn.recordId)!;
    assert.equal(old.messages[1].status, 'stopped');
    assert.equal(old.messages[1].content, '已经产生的正文');
    assert.equal(service.mood.get().snapshot.values.O, 50);
    const next = await service.begin('new-turn', '新对话', 'Gene', () => {});
    assert.notEqual(next.recordId, turn.recordId);
    await next.finish('complete');
    assert.equal(service.memory.list(service.currentScope()).total, 2);
  });
});

test('queued context switches and reset capture their own scopes and commit in invocation order', async () => {
  await withService(async service => {
    const entered = deferred(), release = deferred(); const sealed: MemoryScope[] = [];
    const originalSeal = service.memory.seal.bind(service.memory);
    service.memory.seal = async scope => { sealed.push({ ...scope }); if (sealed.length === 1) { entered.resolve(); await release.promise; } await originalSeal(scope); };
    const other = service.context('other', providerB, 'Other');
    await entered.promise;
    const reset = service.newConversation();
    const third = service.context('third', providerA, 'Third');
    assert.throws(() => service.begin('during-switch', '不能借用旧范围', 'Old', () => {}), /切换/);
    release.resolve();
    await Promise.all([other, reset, third]);
    assert.deepEqual(service.currentScope(), { characterId: 'third', providerScope: memoryProviderScope(providerA) });
    assert.equal(service.mood.get().characterId, 'third');
    assert.deepEqual(sealed.map(scope => scope.characterId), ['gene', 'other', 'other']);
  });
});

test('in-flight begin invalidated during an await cleans its streaming slot and never rewards the stale character', async () => {
  await withService(async service => {
    const originalScope = service.currentScope();
    const entered = deferred(), release = deferred(); const note = service.memory.noteUserRecall.bind(service.memory);
    service.memory.noteUserRecall = async (...args) => { entered.resolve(); await release.promise; return note(...args); };
    const events: string[] = []; const moodEvent = service.mood.event.bind(service.mood);
    service.mood.event = (event, character) => { events.push(`${character}:${event.type}`); moodEvent(event, character); };
    const pending = service.begin('setup-race', '已接受但尚在准备', 'Gene', () => { throw new Error('must not emit'); });
    const rejected = assert.rejects(pending, /已改变/);
    await entered.promise;
    const switched = service.context('other', providerB, 'Other');
    release.resolve();
    await rejected; await switched;
    const old = service.memory.list(originalScope).records[0];
    assert.equal(service.memory.read(originalScope, old.id)?.messages[1].status, 'stopped');
    assert.deepEqual(events, []);
    const next = await service.begin('other-turn', '新角色正常', 'Other', () => {});
    await next.finish('complete');
    assert.equal(service.memory.list(service.currentScope()).total, 1);
  });
});

test('begin setup errors after accepting user text release the archive slot and permit the next request', async () => {
  await withService(async service => {
    const original = service.memory.retrieve.bind(service.memory);
    service.memory.retrieve = () => { throw new Error('synthetic retrieval failure'); };
    await assert.rejects(service.begin('failed-setup', '保存这条原文', 'Gene', () => {}), /synthetic/);
    service.memory.retrieve = original;
    const scope = service.currentScope();
    const first = service.memory.list(scope).records[0];
    assert.equal(service.memory.read(scope, first.id)?.messages[1].status, 'error');
    const next = await service.begin('next-valid', '下一条可以正常开始', 'Gene', () => {});
    next.push('delta', '正常回复'); await next.finish('complete');
    assert.equal(service.memory.read(scope, next.recordId, { messageLimit: 10 })?.messages[3].content, '正常回复');
  });
});

test('deletion fences late streams before its await and cannot reset or contaminate a newly selected provider', async () => {
  await withService(async (service, directory) => {
    const output: string[] = [];
    const turn = await service.begin('delete-turn', 'DELETE_PRIVATE_ORIGINAL', 'Gene', (type, text) => { if (type === 'delta') output.push(text); });
    turn.push('delta', 'DELETE_PRIVATE_REPLY');
    const entered = deferred(), release = deferred(); const originalDelete = service.memory.delete.bind(service.memory);
    service.memory.delete = async (...args) => { entered.resolve(); await release.promise; return originalDelete(...args); };
    const removing = service.removeMemory(turn.recordId);
    await entered.promise;
    const switching = service.context('other', providerB, 'Other');
    turn.push('delta', appraisal(turn, 'LATE_DELETED_REPLY'));
    release.resolve();
    assert.equal(await removing, true); await switching;
    await turn.finish('complete');
    assert.equal(output.join(''), 'DELETE_PRIVATE_REPLY');
    assert.equal(service.memory.read(turn.scope, turn.recordId), undefined);
    assert.equal(service.currentScope().characterId, 'other');
    assert.equal(service.mood.get().snapshot.values.O, 50);
    const source = await readFile(path.join(directory, 'memories.jsonl'), 'utf8');
    assert.ok(!source.includes('DELETE_PRIVATE'));
    assert.ok(!source.includes('LATE_DELETED'));
  });
});

test('retrieval alone does not qualify a later acknowledgement; only an actually named assistant recollection does', async () => {
  await withService(async service => {
    const scope = service.currentScope(), at = Date.now();
    const old = await service.memory.beginTurn(scope, { id: 'source', userText: '一起聊电影《小森林》', at });
    await service.memory.appendAssistant(scope, 'source', '我们聊过这部电影。', at);
    await service.memory.finishTurn(scope, 'source', 'complete', at); await service.memory.seal(scope);
    const first = await service.begin('not-mentioned', '电影', 'Gene', () => {});
    first.push('delta', '今天想聊些什么呢？'); await first.finish('complete');
    const second = await service.begin('not-confirmed', '对，就是《小森林》，我后来又看了一遍', 'Gene', () => {});
    assert.equal(service.memory.read(scope, old.recordId)?.weight, 20);
    second.push('delta', '《小森林》里那些生活细节确实很舒服。'); await second.finish('complete');
    const third = await service.begin('confirmed', '对，就是《小森林》，我后来又看了一遍', 'Gene', () => {});
    const weight = service.memory.read(scope, old.recordId)!.weight;
    assert.ok(weight > 29.99 && weight <= 30);
    await third.finish('complete');
  });
});

test('provider changes never reuse old recall text; API key rotations alone preserve the same non-secret scope', async () => {
  await withService(async service => {
    assert.equal(memoryProviderScope(providerA), memoryProviderScope({ ...providerA, baseUrl: '  https://first.example/v1/' }));
    const old = await service.begin('private-scope', '电影《OLD_PROVIDER_PRIVATE》', 'Gene', () => {});
    old.push('delta', '旧连接中的私人正文'); await old.finish('complete');
    await service.context('gene', providerB, 'Gene');
    assert.equal(service.memory.list(service.currentScope()).total, 0);
    const next = await service.begin('new-scope', '还记得《OLD_PROVIDER_PRIVATE》吗', 'Gene', () => {});
    assert.ok(!next.persona.includes('旧连接中的私人正文'));
    assert.ok(!next.persona.includes('<private-memory-data>'));
    await next.finish('complete');
  });
});

test('graceful flush closes partial turns and completed request IDs cannot be replayed into fresh UI output', async () => {
  await withService(async service => {
    const output: string[] = [];
    const partial = await service.begin('partial-on-exit', '退出时保留', 'Gene', (type, text) => { if (type === 'delta') output.push(text); });
    partial.push('delta', '尚未结束的正文');
    await service.flush();
    partial.push('delta', 'LATE');
    assert.equal(service.memory.read(partial.scope, partial.recordId)?.messages[1].status, 'stopped');
    assert.equal(output.join(''), '尚未结束的正文');
    await assert.rejects(service.begin('partial-on-exit', '重试不能覆盖', 'Gene', () => { throw new Error('no output'); }), /已经结束/);
    assert.equal(service.memory.read(partial.scope, partial.recordId)?.messages[0].content, '退出时保留');
  });
});

test('duplicate active request IDs cannot create two parsers or append duplicate originals', async () => {
  await withService(async service => {
    const first = await service.begin('same-request', '唯一用户原文', 'Gene', () => {});
    await assert.rejects(service.begin('same-request', '不能新增第二份原文', 'Gene', () => {}), /重复启动/);
    first.push('delta', '唯一回复'); await first.finish('complete');
    const record = service.memory.read(first.scope, first.recordId)!;
    assert.equal(record.messages.length, 2);
    assert.equal(record.messages[1].content, '唯一回复');
  });
});

test('failed reset or deletion cannot strand the unchanged scope behind the transition fence', async () => {
  await withService(async service => {
    const scope = service.currentScope();
    const originalSeal = service.memory.seal.bind(service.memory);
    service.memory.seal = async () => { throw new Error('synthetic seal failure'); };
    await assert.rejects(service.newConversation(), /synthetic/);
    assert.deepEqual(service.currentScope(), scope);
    service.memory.seal = originalSeal;
    const turn = await service.begin('valid-after-failure', '原文', 'Gene', () => {}); await turn.finish('complete');
    const originalDelete = service.memory.delete.bind(service.memory);
    service.memory.delete = async () => { throw new Error('synthetic delete failure'); };
    await assert.rejects(service.removeMemory(turn.recordId), /synthetic/);
    assert.deepEqual(service.currentScope(), scope);
    assert.equal(service.memory.read(scope, turn.recordId)?.messages[0].content, '原文');
    service.memory.delete = originalDelete;
  });
});

test('linked archive deletion is fenced before its first await; failure preserves the normal record and a later new turn', async () => {
  await withService(async service => {
    const scope = service.currentScope();
    const old = await service.begin('linked-old', '公开旧原文', 'Gene', () => {}); await old.finish('complete');
    const entered = deferred(), release = deferred();
    const removed = service.removeMemory(old.recordId, async callbackScope => {
      assert.deepEqual(callbackScope, scope); entered.resolve(); await release.promise;
      throw new Error('linked archive unavailable');
    });
    assert.throws(() => service.currentScope(), /切换/);
    assert.throws(() => service.begin('during-delete', '不能加入旧范围', 'Gene', () => {}), /切换/);
    await entered.promise;
    assert.ok(service.memory.read(scope, old.recordId), 'normal original remains until linked archive succeeds');
    release.resolve(); await assert.rejects(removed, /linked archive unavailable/);
    assert.deepEqual(service.currentScope(), scope); assert.ok(service.memory.read(scope, old.recordId));
    const next = await service.begin('after-delete-failure', '公开新回合', 'Gene', () => {});
    next.push('delta', '新回合仍保留。'); await next.finish('complete');
    assert.equal(service.memory.read(scope, next.recordId)!.messages.at(-1)!.content, '新回合仍保留。');
  });
});

test('a corrupt mood file is preserved with a visible error while text memory remains usable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-companion-test-'));
  const source = '{broken mood file';
  const service = new CompanionService(directory, () => {});
  try {
    await writeFile(path.join(directory, 'mood-state.json'), source);
    await service.load(); await service.context('gene', providerA, 'Gene');
    assert.match(service.mood.get().storageError ?? '', /原 mood-state.json 已保留/);
    const turn = await service.begin('memory-still-works', '仍保存文字', 'Gene', () => {});
    turn.push('delta', '文字记忆正常'); await turn.finish('complete');
    assert.equal(service.memory.read(turn.scope, turn.recordId)?.messages[1].content, '文字记忆正常');
    await assert.rejects(service.flush());
    assert.equal(await readFile(path.join(directory, 'mood-state.json'), 'utf8'), source);
  } finally { await service.flush().catch(() => {}); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-companion-test-')); await rm(directory, { recursive: true, force: true }); }
});
