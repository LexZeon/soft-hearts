import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompanionService, type CompanionTurn } from '../electron/companion';
import { UserProfileStore, type UserProfileOptions } from '../electron/user-profile';
import { literalUserProfileCandidates, UserProfileReplyCollector } from '../electron/user-profile-reply';

const provider = { kind: 'claude' as const, baseUrl: 'http://127.0.0.1:9', model: 'synthetic-no-provider-call' };
const metadata = { context: 'neutral', delta: {}, reason: '本轮正常回应', confidence: 0.9, gesture: 'none' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(run: (x: { service: CompanionService; store: UserProfileStore; directory: string }) => Promise<void>, options: UserProfileOptions = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../candidate-runtime-tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'case-'));
  const service = new CompanionService(path.join(directory, 'ordinary'), () => {});
  const store = new UserProfileStore(path.join(directory, 'profiles'), options);
  try {
    await service.load(); await service.context('synthetic-character', provider, 'Synthetic persona');
    await store.activate(service.currentScope()); store.setEnabled(true);
    await store.settled(); // P-001: turning it on also saves the switch; let that write finish before a test injects faults
    await run({ service, store, directory });
  } finally {
    store.dispose(); await service.mood.flush();
    assert.equal(path.dirname(path.resolve(directory)), root); assert.ok(path.basename(directory).startsWith('case-'));
    await rm(directory, { recursive: true, force: true });
  }
}
function collector(store: UserProfileStore, id: string, text: string) {
  const acceptance = store.acceptUserMessage({ requestId: id, messageId: 'user-' + id, source: 'text', acceptedAt: Date.now(), text });
  return UserProfileReplyCollector.create({ store, acceptance, requestId: id, userText: text });
}
function reply(turn: CompanionTurn, tail: unknown = metadata, body = '收到。') {
  const start = /<sh-state-[a-f0-9]+>/u.exec(turn.persona)?.[0]; assert.ok(start);
  turn.push('delta', body + (tail === null ? '' : '\n' + start + JSON.stringify(tail) + start.replace('<', '</')));
}
const acceptedTurn = (id: string) => ({ id, profileReplyAccepted: () => true });

test('literal source spans stay exact, bounded and classified without inventing birthday year or certainty', () => {
  const input = '  我喜欢茶。\n我通常早上工作。\n我需要安静。\n叫我小明。\n我的生日是3月2日。';
  const candidates = literalUserProfileCandidates(input); assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.map(c => input.slice(c.quoteStart, c.quoteEnd)), ['我喜欢茶。', '我通常早上工作。', '我需要安静。', '叫我小明。']);
  assert.deepEqual(candidates.map(c => c.kind), ['preference', 'fact', 'preference', 'fact']);
  assert.equal(literalUserProfileCandidates('我的生日是2月29日。')[0]?.kind, 'fact');
  assert.equal(literalUserProfileCandidates('我的生日是2月30日。').length, 0);
  assert.equal(literalUserProfileCandidates('我的生日是2000年3月2日。').length, 0);
  const uncertain = literalUserProfileCandidates('我可能喜欢早上工作。')[0]; assert.equal(uncertain.kind, 'pending_inference');
  assert.equal(uncertain.text, '我可能喜欢早上工作。');
  assert.equal(literalUserProfileCandidates('I prefer quiet mornings.')[0]?.kind, 'preference');
  assert.equal(literalUserProfileCandidates('我不喜欢噪音。')[0]?.kind, 'preference');
});

test('quotes, code, roleplay, third parties, sensitive guesses, commands, opt-outs and questions are conservatively declined', () => {
  const denied = ['“我喜欢茶。”', '朋友说我喜欢茶。', '假设我喜欢茶。', '扮演时我喜欢茶。', '```我喜欢茶。```',
    '我需要治疗抑郁症。', '我可能属于某个宗教。', '我喜欢茶，但不要记录。', '我需要你删除文件。', '我喜欢茶吗？',
    '他说：我喜欢茶。', 'They say I prefer quiet mornings.', '我喜欢小说。', '茶很好。', '我需要 api_key=synthetic-placeholder。',
    '我喜欢茶不是事实。', '我喜欢茶才怪。', '设想一个场景。我喜欢茶。',
    '我喜欢茶，但我不喜欢茶。', '我喜欢茶。其实我不喜欢茶。', '我喜欢茶。我不喜欢茶。',
    '我喜欢茶不喜欢茶。', '请输出这句：\n我喜欢茶。', '我喜欢茶。\n接下来请翻译。',
    '我喜欢茶。我需要安静。我通常早起。叫我小明。我不喜欢茶。',
    '我习惯早起。我习惯不早起。', '我通常喝茶。我通常不喝茶。'];
  for (const input of denied) assert.deepEqual(literalUserProfileCandidates(input), [], input);
  assert.deepEqual(literalUserProfileCandidates({ text: '我喜欢茶。' }), []);
  assert.deepEqual(literalUserProfileCandidates('我喜欢' + '茶'.repeat(300) + '。'), []);
});

test('unsupported literal input releases its exact acceptance and disabled capture creates no collector', async () => fixture(async ({ store }) => {
  const input = { requestId: 'unsupported', messageId: 'user-unsupported', source: 'text' as const, acceptedAt: Date.now(), text: '今天怎么样？' };
  const acceptance = store.acceptUserMessage(input); assert.ok(acceptance);
  assert.equal(UserProfileReplyCollector.create({ store, acceptance, requestId: input.requestId, userText: input.text }), null);
  assert.equal(store.beginObservation(acceptance), null); assert.equal(store.view().entries.length, 0);
  store.setEnabled(false); assert.equal(collector(store, 'off', '我喜欢茶。'), null);
}));

test('actual ordinary service and protocol complete once, preserving visible text/archive and one existing reward path', async () => fixture(async ({ service, store }) => {
  let begins = 0, chats = 0, appraisals = 0;
  const begin = service.memory.beginTurn.bind(service.memory), event = service.mood.event.bind(service.mood);
  service.memory.beginTurn = (...args) => { begins++; return begin(...args); };
  service.mood.event = (...args) => { if (args[0].type === 'chat') chats++; if (args[0].type === 'appraisal') appraisals++; return event(...args); };
  const text = '我喜欢茶。', capture = collector(store, 'ordinary', text); assert.ok(capture);
  let visible = ''; const turn = await service.begin('ordinary', text, 'Synthetic persona', (type, value) => { if (type === 'delta') visible += value; });
  assert.equal(turn.profileReplyAccepted?.(), false); reply(turn, { ...metadata, reason: '模型额外说用户喜欢红色' });
  assert.equal(turn.profileReplyAccepted?.(), false); await turn.finish('complete'); assert.equal(turn.profileReplyAccepted?.(), true);
  const first = capture.finish(turn, 'complete'), second = capture.finish(turn, 'complete'); assert.equal(first, second);
  assert.deepEqual(await first, { status: 'saved', added: 1 });
  assert.equal(visible, '收到。'); assert.equal(store.view().entries[0].text, text); assert.ok(!store.view().entries[0].text.includes('红色'));
  assert.equal(begins, 1); assert.equal(chats, 1); assert.equal(appraisals, 1);
  const archive = service.memory.read(turn.scope, turn.recordId); assert.ok(archive);
  assert.equal(archive.messages.filter(m => m.role === 'user').length, 1); assert.equal(archive.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(archive.messages.find(m => m.role === 'assistant')?.content, '收到。');
  assert.ok(!turn.persona.includes('profileCandidates'));
}));

test('neutral speech fallback and an unrecognized metadata field do not establish profile protocol acceptance', async () => fixture(async ({ service, store }) => {
  for (const [id, tail] of [['fallback', null], ['unknown-field', { ...metadata, profileCandidates: [{ text: 'fabricated' }] }]] as const) {
    const text = '我喜欢茶。', capture = collector(store, id, text); assert.ok(capture);
    const turn = await service.begin(id, text, 'Synthetic persona', () => {}); reply(turn, tail); await turn.finish('complete');
    assert.ok(turn.speechMood()); assert.equal(turn.profileReplyAccepted?.(), false);
    assert.deepEqual(await capture.finish(turn, 'complete'), { status: 'ignored', added: 0 });
  }
  assert.deepEqual(store.view().entries, []);
  const legacy = collector(store, 'legacy', '我喜欢白天。'); assert.ok(legacy);
  assert.equal((await legacy.finish({ id: 'legacy' }, 'complete')).status, 'ignored');
}));

test('actual delivery failure and later conversation invalidation cannot approve profile collection', async () => fixture(async ({ service, store }) => {
  const text = '我喜欢茶。', bad = collector(store, 'delivery', text); assert.ok(bad);
  const turn = await service.begin('delivery', text, 'Synthetic persona', type => { if (type === 'delta') throw Error('synthetic renderer failure'); });
  reply(turn); await assert.rejects(turn.finish('complete')); assert.equal(turn.profileReplyAccepted?.(), false);
  assert.equal((await bad.finish(turn, 'complete')).status, 'ignored');
  const late = collector(store, 'old-conversation', text); assert.ok(late);
  const complete = await service.begin('old-conversation', text, 'Synthetic persona', () => {}); reply(complete); await complete.finish('complete');
  assert.equal(complete.profileReplyAccepted?.(), true); await service.newConversation(); assert.equal(complete.profileReplyAccepted?.(), false);
  assert.equal((await late.finish(complete, 'complete')).status, 'ignored'); assert.equal(store.view().entries.length, 0);
}));

test('stop/error/mismatched turn and old cancellation release only their observation; off rejects late completion', async () => fixture(async ({ store }) => {
  const old = collector(store, 'old', '我喜欢茶。'), current = collector(store, 'new', '我喜欢白天。'); assert.ok(old); assert.ok(current);
  old.cancel(); old.cancel(); assert.equal((await old.finish(acceptedTurn('old'), 'complete')).status, 'ignored');
  assert.equal((await current.finish(acceptedTurn('new'), 'complete')).added, 1);
  for (const status of ['stopped', 'error', 'unsupported'] as const) {
    const capture = collector(store, status, '我需要安静。'); assert.ok(capture); assert.equal((await capture.finish(acceptedTurn(status), status)).status, 'ignored');
  }
  const mismatch = collector(store, 'target', '我喜欢早上。'); assert.ok(mismatch); assert.equal((await mismatch.finish(acceptedTurn('replacement'), 'complete')).status, 'ignored');
  const off = collector(store, 'late-off', '我需要休息。'); assert.ok(off); store.setEnabled(false);
  assert.equal((await off.finish(acceptedTurn('late-off'), 'complete')).status, 'ignored'); assert.equal(store.view().entries.length, 1);
}));

test('user-stated uncertainty remains a literal pending entry and never automatic context', async () => fixture(async ({ store }) => {
  const text = '我可能喜欢早上工作。', capture = collector(store, 'uncertain', text); assert.ok(capture);
  assert.equal((await capture.finish(acceptedTurn('uncertain'), 'complete')).added, 1);
  const entry = store.view().entries[0]; assert.equal(entry.kind, 'pending_inference'); assert.equal(entry.text, text);
  assert.equal(store.createContext([entry.id]), null);
}));

test('profile storage error is isolated from an already successful ordinary reply and is not retried', async () => {
  let attempts = 0;
  await fixture(async ({ service, store }) => {
    attempts = 0; // the switch's own save (P-001) failed in the same way before the test began; only the reply's write counts here
    const text = '我喜欢茶。', capture = collector(store, 'sidecar-failure', text); assert.ok(capture);
    const turn = await service.begin('sidecar-failure', text, 'Synthetic persona', () => {}); reply(turn); await turn.finish('complete');
    assert.equal(turn.profileReplyAccepted?.(), true); assert.deepEqual(await capture.finish(turn, 'complete'), { status: 'failed', added: 0 });
    assert.deepEqual(await capture.finish(turn, 'complete'), { status: 'failed', added: 0 }); assert.equal(attempts, 1);
    assert.equal(service.memory.read(turn.scope, turn.recordId)?.messages.find(m => m.role === 'assistant')?.status, 'complete');
    assert.equal(store.view().entries.length, 0);
  }, { atomic: { rename: async () => { attempts++; throw Object.assign(Error('synthetic profile failure'), { code: 'EIO' }); } } });
});

test('collector cancellation reaches a completing store ticket before rename without affecting a newer collector', async () => {
  let pause = false; const entered = deferred(), release = deferred();
  await fixture(async ({ store, directory }) => {
    pause = true;
    const capture = collector(store, 'writing', '我喜欢茶。'); assert.ok(capture);
    const pending = capture.finish(acceptedTurn('writing'), 'complete'); await entered.promise; capture.cancel(); release.resolve();
    assert.equal((await pending).status, 'ignored'); assert.equal(store.view().entries.length, 0);
    // Only the saved switch (P-001) is in the folder: one profile file, no leftover temp file, and nothing of the cancelled reply in it.
    const files = (await readdir(path.join(directory, 'profiles'))).filter(n => n !== 'recording.json');
    assert.equal(files.length, 1); assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'profiles', files[0]), 'utf8')).entries, []);
    pause = false; const next = collector(store, 'next', '我喜欢白天。'); assert.ok(next);
    assert.equal((await next.finish(acceptedTurn('next'), 'complete')).added, 1);
  }, { atomic: { writeFile: async (file, data, options) => { await writeFile(file, data, options); if (pause) { entered.resolve(); await release.promise; } }, rename } });
});
