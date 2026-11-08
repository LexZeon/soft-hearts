import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECORDING_ON_MARKER, UserProfileStore, type UserProfileOptions } from '../electron/user-profile';

const scope = { characterId: 'character-a', providerScope: 'provider-a' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(run: (value: { store: UserProfileStore; directory: string; caseDirectory: string; advance: (ms: number) => void; now: () => number }) => Promise<void>, options: UserProfileOptions = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime-tests');
  await mkdir(root, { recursive: true });
  const caseDirectory = await mkdtemp(path.join(root, 'case-'));
  const directory = path.join(caseDirectory, 'profiles');
  let clock = 1000;
  const store = new UserProfileStore(directory, { ...options, now: () => clock });
  try { await run({ store, directory, caseDirectory, advance: ms => { clock += ms; }, now: () => clock }); }
  finally {
    // P-001: switching saves in the background; let it finish before the folder is removed (else ENOTEMPTY now and then).
    await store.settled().catch(() => undefined);
    store.dispose();
    assert.equal(path.dirname(path.resolve(caseDirectory)), root);
    assert.ok(path.basename(caseDirectory).startsWith('case-'));
    await rm(caseDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
function receipt(text: string, id: string, at: number) { return { requestId: id, messageId: 'message-' + id, source: 'text' as const, text, acceptedAt: at }; }
function begin(store: UserProfileStore, input: Parameters<UserProfileStore['acceptUserMessage']>[0]) { return store.beginObservation(store.acceptUserMessage(input)); }
async function add(store: UserProfileStore, body: string, id: string, at: number, kind: 'fact' | 'preference' = 'fact') {
  const ticket = begin(store, receipt(body, id, at)); assert.ok(ticket);
  return store.completeObservation(ticket, id, [{ kind, quoteStart: 0, quoteEnd: body.length }]);
}
async function profileFile(directory: string) { const files = (await readdir(directory)).filter(n => n !== 'recording.json'); assert.equal(files.length, 1); return path.join(directory, files[0]); }

test('default/view stays off; real private sidecar is isolated by character and provider, without touching ordinary memory', async () => fixture(async ({ store, directory, caseDirectory, now }) => {
  const ordinary = path.join(caseDirectory, 'memories.jsonl'); await writeFile(ordinary, 'ordinary-memory-sentinel');
  const initial = await store.activate(scope); assert.equal(initial?.enabled, false); assert.deepEqual(store.view().entries, []);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
  assert.equal(begin(store, receipt('我喜欢安静。', 'off', now())), null);
  store.setEnabled(true);
  assert.deepEqual(await add(store, '我喜欢安静。', 'first', now(), 'preference'), { status: 'saved', added: 1 });
  const view = store.view(); view.entries[0].text = 'mutated outside'; assert.equal(store.view().entries[0].text, '我喜欢安静。');
  const bytes = await readFile(await profileFile(directory), 'utf8'); assert.ok(!bytes.includes(scope.characterId)); assert.ok(!bytes.includes(scope.providerScope));
  assert.equal((await store.activate({ ...scope, providerScope: 'provider-b' }))?.entries.length, 0);
  assert.equal((await store.activate({ ...scope, characterId: 'character-b' }))?.entries.length, 0);
  const restored = await store.activate(scope); assert.equal(restored?.enabled, true); /* P-001: the last switch is remembered */ assert.equal(restored?.entries[0].text, '我喜欢安静。');
  assert.equal(await readFile(ordinary, 'utf8'), 'ordinary-memory-sentinel');
}));

test('fresh direct-human evidence and successful exact reply are required; malformed, invented and credential candidates are dropped once', async () => fixture(async ({ store, now, advance }) => {
  await store.activate(scope); store.setEnabled(true);
  assert.equal(begin(store, receipt('旧消息', 'old', now() - 1)), null);
  assert.equal(begin(store, { ...receipt('背景声音', 'ambient', now()), source: 'ambient' as never }), null);
  const body = '我喜欢安静。', ticket = begin(store, receipt(body, 'good', now())); assert.ok(ticket);
  const result = await store.completeObservation(ticket, 'good', [
    { kind: 'fact', quoteStart: 0, quoteEnd: body.length, text: '并非用户原话' },
    { kind: 'fact', quoteStart: 0, quoteEnd: 99999 },
    { kind: 'fact', quoteStart: 0, quoteEnd: body.length, confirmed: true },
    { kind: 'preference', quoteStart: 0, quoteEnd: body.length }
  ]);
  assert.equal(result.added, 1); assert.equal((await store.completeObservation(ticket, 'good', [])).status, 'ignored');
  assert.equal(begin(store, receipt(body, 'good', now())), null);
  const wrong = begin(store, receipt('我喜欢茶。', 'wrong', now())); assert.ok(wrong);
  assert.equal((await store.completeObservation(wrong, 'different-reply', [{ kind: 'fact', quoteStart: 0, quoteEnd: 6 }])).status, 'ignored');
  const sensitive = 'api_key=synthetic-placeholder', secret = begin(store, receipt(sensitive, 'credential', now())); assert.ok(secret);
  assert.equal((await store.completeObservation(secret, 'credential', [{ kind: 'fact', quoteStart: 0, quoteEnd: sensitive.length }])).added, 0);
  const expired = begin(store, receipt('我喜欢白天。', 'expired', now())); assert.ok(expired); advance(120001);
  assert.equal((await store.completeObservation(expired, 'expired', [{ kind: 'fact', quoteStart: 0, quoteEnd: 7 }])).status, 'ignored');
  assert.equal(store.view().entries.length, 1);
}));

test('off/cancel/scope invalidate pending observations and context, with no off-period backfill on reenable', async () => fixture(async ({ store, now, advance }) => {
  await store.activate(scope); store.setEnabled(true); await add(store, '我喜欢轻音乐。', 'saved', now());
  const context = store.createContext([store.view().entries[0].id]); assert.ok(context); assert.ok(store.readContext(context)?.includes('我喜欢轻音乐'));
  const old = begin(store, receipt('我需要安静。', 'late', now())); assert.ok(old);
  const acceptedAt = now(); advance(10); store.setEnabled(false);
  assert.equal(store.readContext(context), null); assert.equal(store.createContext([store.view().entries[0].id]), null);
  assert.equal((await store.completeObservation(old, 'late', [{ kind: 'fact', quoteStart: 0, quoteEnd: 7 }])).status, 'ignored');
  store.setEnabled(true); assert.equal(begin(store, receipt('关闭期间消息', 'backfill', acceptedAt)), null);
  const cancelled = begin(store, receipt('我需要早点休息。', 'cancel', now())); assert.ok(cancelled); store.cancelPending();
  assert.equal((await store.completeObservation(cancelled, 'cancel', [])).status, 'ignored');
  const context2 = store.createContext([store.view().entries[0].id]); assert.ok(context2); await store.activate({ ...scope, providerScope: 'other' });
  assert.equal(store.readContext(context2), null); assert.equal(store.view().enabled, true, 'last choice follows the user to the other scope (2026-11-07)');
}));

test('manual edit while off wins over old completion and deletion removes text durably without automatic resurrection', async () => fixture(async ({ store, directory, now }) => {
  await store.activate(scope); store.setEnabled(true); const body = '我喜欢晚上工作。'; await add(store, body, 'first', now());
  const old = begin(store, receipt(body, 'old-update', now())); assert.ok(old);
  const entry = store.view().entries[0]; store.setEnabled(false);
  const edited = await store.editEntry(entry.id, { text: '我现在喜欢早上工作。', kind: 'preference' }, store.view().revision);
  assert.equal(edited.enabled, false); assert.equal(edited.entries[0].manual, true);
  assert.equal((await store.completeObservation(old, 'old-update', [{ kind: 'fact', quoteStart: 0, quoteEnd: body.length }])).status, 'ignored');
  const deleted = await store.deleteEntry(entry.id, edited.revision); assert.deepEqual(deleted.entries, []);
  const bytes = await readFile(await profileFile(directory), 'utf8'); assert.ok(!bytes.includes(body)); assert.ok(!bytes.includes('我现在喜欢早上工作'));
  store.setEnabled(true); assert.equal((await add(store, body, 'replay-new-id', now())).added, 0);
  await store.activate(scope); store.setEnabled(true); assert.equal((await add(store, body, 'replay-after-load', now())).added, 0);
  assert.deepEqual(store.view().entries, []);
}));

test('pending inference is separately visible but never injected until a manual confirmation', async () => fixture(async ({ store, now }) => {
  await store.activate(scope); store.setEnabled(true); const body = '我最近常常熬夜。';
  const ticket = begin(store, receipt(body, 'inference', now())); assert.ok(ticket);
  await store.completeObservation(ticket, 'inference', [{ kind: 'pending_inference', quoteStart: 0, quoteEnd: body.length, text: '可能习惯晚上工作。' }]);
  const entry = store.view().entries[0]; assert.equal(entry.kind, 'pending_inference'); assert.equal(store.createContext([entry.id]), null);
  store.setEnabled(false); await store.editEntry(entry.id, { kind: 'fact', text: '我经常晚上工作。' }, store.view().revision);
  store.setEnabled(true); const context = store.createContext([entry.id]); assert.ok(context);
  assert.ok(store.readContext(context)?.includes('user-corrected')); assert.ok(!store.readContext(context)?.includes('可能习惯'));
}));

test('off during atomic temporary write rejects the guarded rename and leaves old sidecar bytes intact', async () => {
  let pause = false; const entered = deferred(), release = deferred();
  await fixture(async ({ store, directory, now }) => {
    await store.activate(scope); store.setEnabled(true); await add(store, '我喜欢茶。', 'first', now());
    const file = await profileFile(directory), before = await readFile(file, 'utf8'); pause = true;
    const pending = add(store, '我喜欢咖啡。', 'late-write', now()); await entered.promise;
    store.setEnabled(false); release.resolve(); assert.equal((await pending).status, 'ignored');
    // P-001: turning off also saves the switch (the marker goes). Wait for that save, then check what must hold: the late
    // write never landed, the old entry is untouched, and no temporary file is left. (Reading before the save settled
    // made this test flaky: a second file could be the switch save's temporary file mid-write.)
    await store.settled();
    const after = await readFile(file, 'utf8');
    assert.ok(!after.includes('我喜欢咖啡'), 'the late write never lands');
    assert.equal(JSON.parse(after).entries.length, JSON.parse(before).entries.length);
    assert.ok(before.includes(RECORDING_ON_MARKER) && !after.includes(RECORDING_ON_MARKER), 'only the switch changed');
    assert.equal((await readdir(directory)).filter(n => n !== 'recording.json').length, 1);
    assert.equal(store.view().entries.length, 1); assert.equal(store.view().enabled, false);
  }, { atomic: { writeFile: async (file, data, options) => { await writeFile(file, data, options); if (pause) { entered.resolve(); await release.promise; } } } });
});

test('failed persistence preserves old bytes/revision and a manual same-revision retry succeeds', async () => {
  let fail = false;
  const { rename } = await import('node:fs/promises');
  await fixture(async ({ store, directory, now }) => {
    await store.activate(scope); store.setEnabled(true); await add(store, '我喜欢茶。', 'saved', now());
    const before = store.view(), file = await profileFile(directory), bytes = await readFile(file, 'utf8'); fail = true;
    await assert.rejects(store.editEntry(before.entries[0].id, { kind: 'preference', text: '我喜欢水。' }, before.revision));
    assert.equal(store.view().revision, before.revision); assert.deepEqual(store.view().entries, before.entries); assert.equal(await readFile(file, 'utf8'), bytes);
    fail = false; const retried = await store.editEntry(before.entries[0].id, { kind: 'preference', text: '我喜欢水。' }, before.revision);
    assert.equal(retried.entries[0].text, '我喜欢水。'); assert.equal(retried.revision, before.revision + 1);
  }, { atomic: { rename: async (from, to) => { if (fail) throw Object.assign(Error('synthetic write failure'), { code: 'EIO' }); await rename(from, to); } } });
});

test('invalid sidecar is rejected and preserved instead of silently defaulting or overwriting it', async () => fixture(async ({ store, directory, now }) => {
  await store.activate(scope); store.setEnabled(true); await add(store, '我喜欢茶。', 'saved', now());
  const file = await profileFile(directory), data = JSON.parse(await readFile(file, 'utf8')); data.entries[0].key = '0'.repeat(64);
  const invalid = JSON.stringify(data); await writeFile(file, invalid);
  await assert.rejects(store.activate(scope)); assert.equal(await readFile(file, 'utf8'), invalid);
  assert.equal((await store.activate({ ...scope, providerScope: 'unrelated' }))?.enabled, true, 'last choice follows the user (2026-11-07), the damaged file stays untouched');
}));

test('same-millisecond disable/re-enable cannot revive old or off-period acceptance proofs, while a fresh message remains valid', async () => fixture(async ({ store, now }) => {
  await store.activate(scope); store.setEnabled(true);
  const old = store.acceptUserMessage(receipt('我喜欢茶。', 'old-enabled', now())); assert.ok(old);
  store.setEnabled(false);
  const offMessage = receipt('我喜欢安静。', 'off-message', now());
  assert.equal(store.acceptUserMessage(offMessage), null);
  store.setEnabled(true);
  assert.equal(store.beginObservation(old), null);
  assert.equal(store.acceptUserMessage(offMessage), null);
  assert.equal(store.beginObservation(receipt('raw receipt is not authority', 'raw', now()) as never), null);
  const fresh = store.acceptUserMessage(receipt('我喜欢白天。', 'fresh', now())); assert.ok(fresh);
  assert.equal(store.beginObservation({ ...fresh }), null);
  const ticket = store.beginObservation(fresh); assert.ok(ticket);
  assert.equal(store.beginObservation(fresh), null);
  assert.equal((await store.completeObservation(ticket, 'fresh', [{ kind: 'fact', quoteStart: 0, quoteEnd: '我喜欢白天。'.length }])).added, 1);
}));

test('single-ticket cancellation during temporary write blocks its rename without cancelling a newer observation', async () => {
  let pause = false; const entered = deferred(), release = deferred();
  await fixture(async ({ store, directory, now }) => {
    await store.activate(scope); store.setEnabled(true); await add(store, '我喜欢茶。', 'first', now());
    const file = await profileFile(directory), bytes = await readFile(file, 'utf8'); pause = true;
    const body = '我喜欢咖啡。', ticket = begin(store, receipt(body, 'single-cancel', now())); assert.ok(ticket);
    const pending = store.completeObservation(ticket, 'single-cancel', [{ kind: 'fact', quoteStart: 0, quoteEnd: body.length }]);
    await entered.promise;
    assert.equal((await store.completeObservation(ticket, 'single-cancel', [])).status, 'ignored');
    store.cancelObservation(ticket);
    const later = begin(store, receipt('我需要休息。', 'later', now())); assert.ok(later);
    release.resolve(); assert.equal((await pending).status, 'ignored');
    assert.equal(await readFile(file, 'utf8'), bytes); assert.equal(store.view().enabled, true);
    pause = false;
    assert.equal((await store.completeObservation(later, 'later', [{ kind: 'fact', quoteStart: 0, quoteEnd: '我需要休息。'.length }])).added, 1);
  }, { atomic: { writeFile: async (file, data, options) => { await writeFile(file, data, options); if (pause) { entered.resolve(); await release.promise; } } } });
});

test('abandoned acceptance is exactly releasable and expiry cleanup restores capacity without timers', async () => fixture(async ({ store, now, advance }) => {
  await store.activate(scope); store.setEnabled(true);
  const captures = Array.from({ length: 16 }, (_, i) => store.acceptUserMessage(receipt('我喜欢安静。', 'held-' + i, now())));
  assert.ok(captures.every(Boolean));
  assert.equal(store.acceptUserMessage(receipt('我喜欢白天。', 'full', now())), null);
  assert.equal(store.releaseAcceptance({ ...captures[0]! }), false);
  assert.equal(store.releaseAcceptance(captures[0]!), true);
  const replacement = store.acceptUserMessage(receipt('我喜欢白天。', 'replacement', now())); assert.ok(replacement);
  assert.equal(store.releaseAcceptance(captures[0]!), false);
  const ticket = store.beginObservation(replacement); assert.ok(ticket); store.cancelObservation(ticket);
  advance(120001);
  const fresh = store.acceptUserMessage(receipt('我需要休息。', 'after-expiry', now())); assert.ok(fresh);
  assert.equal(store.beginObservation(captures[1]), null);
  assert.ok(store.beginObservation(fresh));
}));
