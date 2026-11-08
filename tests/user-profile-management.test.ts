import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserProfileManagement } from '../electron/user-profile-management';
import { UserProfileStore, type UserProfileOptions, type UserProfileView, type UserProfileScope } from '../electron/user-profile';

const scopeA = { characterId: 'management-a', providerScope: 'provider-a' };
const scopeB = { characterId: 'management-b', providerScope: 'provider-a' };
const expected = (view: UserProfileView) => ({ scopeId: view.scopeId, generation: view.generation, revision: view.revision });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(run: (f: {
  store: UserProfileStore; management: UserProfileManagement; directory: string;
  views: (UserProfileView | null)[]; failViewer(): void;
}) => Promise<void>, options: UserProfileOptions = {}, currentScope?: () => UserProfileScope | null) {
  const root = fileURLToPath(new URL('./owned-temp/user-profile-management/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'case-'));
  const views: (UserProfileView | null)[] = [];
  let viewerThrows = false;
  const store = new UserProfileStore(directory, { ...options, now: () => 10_000 });
  const management = new UserProfileManagement(store, view => {
    views.push(view === null ? null : structuredClone(view));
    if (viewerThrows) throw Error('synthetic viewer failure');
  }, currentScope);
  try { await run({ store, management, directory, views, failViewer: () => { viewerThrows = true; } }); }
  finally {
    // P-001: the switch saves in the background; let it finish before the folder is removed (else ENOTEMPTY now and then).
    await store.settled().catch(() => undefined);
    management.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root));
    assert.ok(path.basename(directory).startsWith('case-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}
async function seed(store: UserProfileStore, management: UserProfileManagement) {
  const before = management.get(); assert.ok(before);
  management.setEnabled({ ...expected(before), enabled: true });
  const body = 'I prefer quiet mornings.';
  const proof = store.acceptUserMessage({ requestId: 'accepted-seed', messageId: 'message-seed', source: 'text', acceptedAt: 10_000, text: body });
  assert.ok(proof);
  const ticket = store.beginObservation(proof); assert.ok(ticket);
  assert.deepEqual(await store.completeObservation(ticket, 'accepted-seed', [{ kind: 'preference', quoteStart: 0, quoteEnd: body.length }]), { status: 'saved', added: 1 });
  const view = management.get(); assert.ok(view); assert.equal(view.entries.length, 1);
  return view;
}

test('management rejects stale typed expectations and descriptor/extra fields before any persistence', async () => {
  let writes = 0;
  await fixture(async ({ store, management }) => {
    await management.activate(scopeA);
    const view = await seed(store, management), count = writes;
    const id = view.entries[0].id;
    let getterCalls = 0;
    const descriptor = { ...expected(view), enabled: true };
    Object.defineProperty(descriptor, 'enabled', { enumerable: true, get() { getterCalls++; return true; } });
    for (const request of [descriptor, { ...expected(view), enabled: true, path: 'unexpected' },
      { ...expected(view), scopeId: 'f'.repeat(64), enabled: true },
      { ...expected(view), generation: view.generation + 1, enabled: true },
      { ...expected(view), revision: view.revision + 1, enabled: true },
      { ...expected(view), enabled: 1 }]) assert.throws(() => management.setEnabled(request));
    const nested = { text: 'changed', kind: 'fact' };
    Object.defineProperty(nested, 'text', { enumerable: true, get() { getterCalls++; return 'changed'; } });
    await assert.rejects(management.edit({ ...expected(view), id, edit: nested }));
    await assert.rejects(management.delete({ ...expected(view), id, unexpected: true }));
    assert.equal(getterCalls, 0);
    assert.equal(writes, count);
    assert.deepEqual(management.get(), view);
    const off = management.setEnabled({ ...expected(view), enabled: false });
    assert.equal(off.enabled, false);
    assert.throws(() => management.setEnabled({ ...expected(view), enabled: true }));
    assert.equal(writes, count);
    assert.equal(management.get()?.enabled, false);
  }, { atomic: { writeFile: async (...args) => { writes++; return writeFile(...args); } } });
});

test('activation publishes null first, suppresses old async results and preserves consent only for the same scope', async () => {
  await fixture(async ({ store, management, views }) => {
    const old = management.activate(scopeA);
    assert.equal(management.get(), null); assert.deepEqual(views, [null]);
    const current = management.activate(scopeB);
    assert.equal(management.get(), null); assert.deepEqual(views, [null, null]);
    assert.equal(await old, null);
    const b = await current; assert.ok(b); assert.equal(b.enabled, false);
    assert.deepEqual(views, [null, null, b]);
    const enabled = management.setEnabled({ ...expected(b), enabled: true });
    const publicationCount = views.length;
    assert.deepEqual(await management.activate(scopeB), enabled);
    assert.equal(views.length, publicationCount);
    const proof = store.acceptUserMessage({ requestId: 'old', messageId: 'old', source: 'text', acceptedAt: 10_000, text: 'old human text' });
    assert.ok(proof);
    const aPromise = management.activate(scopeA);
    assert.equal(management.get(), null); assert.equal(views.at(-1), null);
    assert.equal(store.beginObservation(proof), null);
    const a = await aPromise; assert.ok(a); assert.equal(a.enabled, true, 'last choice follows the user (2026-11-07)'); assert.notEqual(a.scopeId, b.scopeId);
    assert.throws(() => management.setEnabled({ ...expected(enabled), enabled: false }));
    assert.deepEqual(management.get(), a);
  });
});

test('a held old-scope manual write cannot publish or persist over a new activation', { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred(); let hold = false;
  await fixture(async ({ store, management, directory, views }) => {
    await management.activate(scopeA); const a = await seed(store, management);
    const file = path.join(directory, (await readdir(directory)).filter(n => n !== 'recording.json')[0]), oldBytes = await readFile(file, 'utf8');
    hold = true;
    const editing = management.edit({ ...expected(a), id: a.entries[0].id, edit: { text: 'late old edit', kind: 'fact' } });
    const rejected = assert.rejects(editing, { message: '用户画像未能保存，请重新读取后重试。' });
    try {
      await Promise.race([entered.promise, editing.then(
        () => { throw Error('Edit completed before the held write'); },
        () => { throw Error('Edit rejected before the held write'); },
      )]);
      const start = views.length;
      const switching = management.activate(scopeB);
      assert.equal(management.get(), null); assert.equal(views.at(-1), null);
      release.resolve(); await rejected;
      const b = await switching; assert.ok(b); assert.equal(b.enabled, true, 'last choice follows the user (2026-11-07)'); assert.equal(b.entries.length, 0);
      assert.deepEqual(views.slice(start), [null, b]);
      assert.deepEqual(management.get(), b);
      assert.equal(await readFile(file, 'utf8'), oldBytes);
      assert.deepEqual((await readdir(directory)).filter(n => n !== 'recording.json'), [path.basename(file)]);
    } finally { release.resolve(); await rejected; }
  }, { atomic: { writeFile: async (...args) => { await writeFile(...args); if (hold) { entered.resolve(); await release.promise; } } } });
});

test('viewer exceptions retain no consent and filesystem failures return only sanitized management errors', async () => {
  let failRename = false;
  await fixture(async ({ store, management, directory, failViewer }) => {
    await management.activate(scopeA); const view = await seed(store, management);
    const context = store.createContext([view.entries[0].id]); assert.ok(context);
    const proof = store.acceptUserMessage({ requestId: 'pending', messageId: 'pending', source: 'text', acceptedAt: 10_000, text: 'pending human text' }); assert.ok(proof);
    failViewer();
    const off = management.setEnabled({ ...expected(view), enabled: false });
    assert.equal(off.enabled, false); assert.equal(store.readContext(context), null); assert.equal(store.beginObservation(proof), null);
    await store.settled(); // P-001: the switch's own save lands first, so `before` is the file the failed edit must leave alone
    const file = path.join(directory, (await readdir(directory)).filter(n => n !== 'recording.json')[0]), before = await readFile(file, 'utf8');
    failRename = true;
    await assert.rejects(management.edit({ ...expected(off), id: off.entries[0].id, edit: { text: 'manual replacement', kind: 'fact' } }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, '用户画像未能保存，请重新读取后重试。');
      assert.equal(error.message.includes(directory), false);
      return true;
    });
    assert.equal(management.get()?.enabled, false);
    assert.deepEqual(management.get()?.entries, off.entries);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual((await readdir(directory)).filter(n => n !== 'recording.json'), [path.basename(file)]);
    management.dispose(); assert.equal(management.get(), null);
  }, { atomic: { rename: async (...args) => { if (failRename) throw Error(`synthetic filesystem failure at ${args[1]}`); await rename(...args); } } });
});

test('host scope guard and pre-I/O suspension revoke old manual writes without activating a fictitious scope', { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred();
  let active: UserProfileScope | null = scopeA, hold = false;
  await fixture(async ({ store, management, directory, views }) => {
    await management.activate(scopeA);
    const old = await seed(store, management);
    active = scopeB;
    assert.equal(management.get(), null);
    assert.throws(() => management.setEnabled({ ...expected(old), enabled: true }), /已变化/);
    active = scopeA;
    const file = path.join(directory, (await readdir(directory)).filter(n => n !== 'recording.json')[0]);
    const before = await readFile(file, 'utf8');
    hold = true;
    const editing = management.edit({ ...expected(old), id: old.entries[0].id,
      edit: { text: 'late transition write', kind: 'fact' } });
    const rejected = assert.rejects(editing, /未能保存/);
    try {
      await entered.promise;
      management.suspendScope();
      assert.equal(management.get(), null); assert.equal(views.at(-1), null);
      assert.throws(() => store.view(), /尚未就绪/);
      release.resolve(); await rejected;
      assert.equal(await readFile(file, 'utf8'), before);
      assert.deepEqual((await readdir(directory)).filter(n => n !== 'recording.json'), [path.basename(file)]);
      active = scopeB;
      const next = await management.activate(scopeB);
      assert.ok(next); assert.equal(next.enabled, true, 'last choice follows the user (2026-11-07)'); assert.equal(next.entries.length, 0);
      assert.ok(next.generation > old.generation);
    } finally { release.resolve(); await rejected; }
  }, { atomic: { writeFile: async (...args) => { await writeFile(...args); if (hold) { entered.resolve(); await release.promise; } } } }, () => active);
});
