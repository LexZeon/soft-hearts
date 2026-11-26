import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { UserProfileStore, type UserProfileView } from '../electron/memory/user-profile';
import { UserProfileManagement } from '../electron/memory/user-profile-management';
import { ProfileViewGate } from '../src/memory/ProfileViewGate';
// Reads as text (test-affected selects this test when they change): 'electron/main.ts' (wiring rewrite step 4d: with electron/wiring/*.ts).
import { wiringSource } from './helpers/wiring-source';

const expected = (view: UserProfileView) => ({ scopeId: view.scopeId, generation: view.generation, revision: view.revision });

test('actual scoped host callbacks and renderer gate use current profile identity through manage and switch', async () => {
  // Wiring rewrite step 4d: the handlers are read across electron/main.ts and electron/wiring/*.ts (记忆's are in memory-wiring.ts).
  const source = wiringSource();
  const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true);
  const names = ['getUserProfile', 'setUserProfileEnabled', 'editUserProfile', 'deleteUserProfile'];
  const handlers = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'scopedHost'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && names.includes(node.arguments[0].text)) {
      assert.equal(node.arguments[2]?.getText(tree), 'false');
      assert.ok(!handlers.has(node.arguments[0].text));
      handlers.set(node.arguments[0].text, node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(handlers.size, names.length);
  const temporaryRoot = fileURLToPath(new URL('./owned-temp/profile-host-wiring/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, 'case-'));
  const profiles = new UserProfileStore(directory);
  const gate = new ProfileViewGate();
  const management = new UserProfileManagement(profiles, view => { gate.event(view); });
  // I-144b: deleteUserProfile now goes into the recycle bin first (main.ts recycleSingle; covered by tests/i144b-recycle-items.test.ts). Here the
  // bin passes straight through, so this test keeps checking only which profile the handlers act on.
  // Step 7: 「允许记录」 off first asks whether a part that owns her data is off (privacyRefusal: tests/privacy-part-off.test.ts); none here.
  const environment: { userProfileManagement: UserProfileManagement | undefined; recycleSingle: (take: unknown, remove: () => unknown) => unknown; privacyRefusal: () => Error | null; field: (value: unknown, name: string) => unknown } =
    { userProfileManagement: management, recycleSingle: (_take, remove) => remove(), privacyRefusal: () => null,
      field: (value, name) => value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined };
  const callbacks = new Map<string, (...args: unknown[]) => unknown>();
  for (const [name, handler] of handlers) {
    const expression = ts.transpileModule(`(${handler.getText(tree)})`, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    callbacks.set(name, runInNewContext(expression, environment));
  }
  const get = () => callbacks.get('getUserProfile')!() as UserProfileView | null;
  const call = (name: string, request: unknown) => callbacks.get(name)!(42, request) as UserProfileView | Promise<UserProfileView>;
  try {
    assert.equal(get(), null);
    await management.activate({ characterId: 'host-a', providerScope: 'provider-a' });
    let view = get(); assert.ok(view); assert.equal(view.enabled, false);
    assert.deepEqual(gate.view, view);
    view = await call('setUserProfileEnabled', { ...expected(view), enabled: true });
    assert.equal(view.enabled, true); assert.deepEqual(gate.view, view);
    const body = 'I prefer a quiet reply.';
    const proof = profiles.acceptUserMessage({ requestId: 'accepted-a', messageId: 'human-a', source: 'text', acceptedAt: Date.now(), text: body });
    assert.ok(proof);
    const observation = profiles.beginObservation(proof); assert.ok(observation);
    await profiles.completeObservation(observation, 'accepted-a', [{ kind: 'preference', quoteStart: 0, quoteEnd: body.length }]);
    management.publishCurrent();
    view = get(); assert.ok(view);
    const beforeEdit = view;
    view = await call('editUserProfile', { ...expected(view), id: view.entries[0].id,
      edit: { kind: 'preference', text: 'Please keep replies concise.' } });
    assert.equal(view.entries[0].manual, true);
    assert.equal(view.entries[0].text, 'Please keep replies concise.');
    assert.deepEqual(gate.view, view);
    await assert.rejects(async () => call('deleteUserProfile', { ...expected(beforeEdit), id: view!.entries[0].id }), /已变化/);
    view = await call('deleteUserProfile', { ...expected(view), id: view.entries[0].id });
    assert.equal(view.entries.length, 0);
    const oldScope = view;
    management.suspendScope();
    assert.equal(get(), null); assert.equal(gate.view, null);
    assert.throws(() => call('setUserProfileEnabled', { ...expected(oldScope), enabled: true }), /已变化/);
    await management.activate({ characterId: 'host-b', providerScope: 'provider-a' });
    const current = get(); assert.ok(current);
    assert.notEqual(current.scopeId, oldScope.scopeId); assert.equal(current.enabled, true, 'the user\'s last choice follows to the new character (2026-11-07)');
    assert.equal(gate.response(oldScope.scopeId, oldScope), false);
    assert.deepEqual(gate.view, current);
    environment.userProfileManagement = undefined;
    assert.equal(get(), null);
    assert.throws(() => call('setUserProfileEnabled', { ...expected(current), enabled: true }), /暂时不可用/);
  } finally {
    management.dispose();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(temporaryRoot));
    assert.ok(path.basename(directory).startsWith('case-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
