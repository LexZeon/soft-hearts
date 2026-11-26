// Parts made on first use (overhaul step 8, docs/claude/2026-11-17-lazy-loading-step8.md; electron/wiring/lazy-wiring.ts): a lazy part leaves
// one shell per handler with the handler's own flags; nothing is made until a call comes; the first call makes it once and answers what the
// real handler answers; a declaration that does not match the real registration is refused; a unit whose making fails answers PART_OFF.
// Then the two lazy parts of 连接任务和安全 (Claude tasks, the test commands): their declarations match their real registration and the
// wiring golden's flags, and in the whole app they are made only when called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerLazy, type LazyMethod } from '../electron/wiring/lazy-wiring';
import { createPartRunner, useRunner, PART_OFF } from '../electron/wiring/parts-wiring';
import { registerClaudeTaskIpc } from '../electron/safety/claude-tasks/ipc';
import { CLAUDE_TASK_METHODS, TEST_COMMAND_METHODS } from '../electron/wiring/safety-lazy-wiring';
import { runStandIn } from './helpers/app-stand-in/spawn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Operation = (...args: any[]) => unknown;
/** A part's registrar that keeps what was registered (method → operation, flags). */
function registrar() {
  const shells = new Map<string, { operation: Operation; scoped: boolean; controlOnly: boolean }>();
  return { shells, ipc: {
    host: (method: string, operation: Operation, controlOnly = true) => { shells.set(method, { operation, scoped: false, controlOnly }); },
    scopedHost: (method: string, operation: Operation, controlOnly = true) => { shells.set(method, { operation, scoped: true, controlOnly }); },
  } };
}
const METHODS: readonly LazyMethod[] = [{ method: 'getThing', controlOnly: false }, { method: 'senderThing', scoped: true, controlOnly: true }];

test('a lazy part: shells with the declared flags; made once, on the first call; each call answers what the real handler answers', () => {
  const r = registrar();
  let made = 0;
  const handle = registerLazy(r.ipc, { part: 'safety', methods: METHODS,
    create: () => { made++; },
    register: ({ host, scopedHost }) => { host('getThing', (x: number) => x * 2, false); scopedHost('senderThing', (sender: number, x: string) => `${sender}:${x}`); } });
  assert.deepEqual([...r.shells].map(([method, s]) => [method, s.scoped, s.controlOnly]), [['getThing', false, false], ['senderThing', true, true]]);
  assert.equal(made, 0, 'nothing is made before a call');
  assert.equal(handle.made(), false);
  assert.equal(r.shells.get('getThing')!.operation(21), 42, 'the first call answers the real handler\'s answer (a shell never answers by itself)');
  assert.equal(r.shells.get('senderThing')!.operation(7, 'x'), '7:x', 'a scoped handler gets the sender first, as before');
  assert.equal(made, 1, 'made once');
  assert.equal(handle.made(), true);
});

test('a lazy part whose real registration differs from its declaration is refused on its first call', () => {
  for (const register of [
    (ipc: any) => { ipc.host('getThing', () => 1, true); ipc.scopedHost('senderThing', () => 2); }, // another flag
    (ipc: any) => { ipc.host('getThing', () => 1, false); }, // one missing
    (ipc: any) => { ipc.host('getThing', () => 1, false); ipc.scopedHost('senderThing', () => 2); ipc.host('extra', () => 3); }, // one more
  ]) {
    const r = registrar();
    registerLazy(r.ipc, { part: 'safety', methods: METHODS, create: () => undefined, register });
    assert.throws(() => r.shells.get('getThing')!.operation(), /lazy part safety/);
  }
});

test('a lazy unit whose making fails (isolate mode) is off: its first call and every later one answer PART_OFF', () => {
  const runner = createPartRunner({ mode: 'isolate' });
  runner.add({ id: 'safety', units: ['claude-tasks'] });
  useRunner(runner);
  try {
    const r = registrar();
    let registered = 0;
    registerLazy(r.ipc, { part: 'safety', unit: 'claude-tasks', methods: METHODS,
      create: () => { runner.startUnitSync('safety', 'claude-tasks', () => { throw new TypeError('broken'); }); },
      register: () => { registered++; } });
    assert.throws(() => r.shells.get('getThing')!.operation(), new RegExp(PART_OFF));
    assert.throws(() => r.shells.get('senderThing')!.operation(1), new RegExp(PART_OFF));
    assert.equal(registered, 0, 'nothing of the part is registered');
    assert.deepEqual(runner.health().off.map(entry => entry.reason), ['start:TypeError']);
  } finally { useRunner(null); }
});

test('Claude tasks and the test command: the declarations are their real registrations and the golden\'s flags', () => {
  const collected: LazyMethod[] = [];
  const stub = {} as never;
  registerClaudeTaskIpc((method, _operation, controlOnly = true) => { collected.push({ method, controlOnly }); },
    { service: stub, toggle: stub, confirmEnable: async () => false, openTaskConfirmation: () => undefined, broadcast: () => undefined });
  assert.deepEqual([...CLAUDE_TASK_METHODS].sort((a, b) => a.method.localeCompare(b.method)), collected.sort((a, b) => a.method.localeCompare(b.method)));
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/wiring-golden.json'), 'utf8'));
  for (const entry of [...CLAUDE_TASK_METHODS, ...TEST_COMMAND_METHODS])
    assert.ok((entry.controlOnly ? golden.handlers.controlOnly : golden.handlers.eitherWindow).includes(entry.method), `${entry.method}: the golden's flag`);
  assert.deepEqual(TEST_COMMAND_METHODS, [{ method: 'runTestCommand', scoped: true, controlOnly: false }]);
  assert.match(fs.readFileSync(path.join(ROOT, 'electron/wiring/safety-wiring.ts'), 'utf8'), /scopedHost\('runTestCommand', \(sender, text\) => \{ lookTurns\.userTurn\(\); return testCommands\.accept\(sender, text\); \}, false\)/);
});

test('the whole app: Claude tasks answer through their shells (made on the first call); the test command answers as before', { timeout: 120_000 }, async () => {
  const report = await runStandIn({ methods: ['claudeTasksEnabled', 'listCodexTasks', 'codexTaskCapabilities'] });
  assert.deepEqual(report.dialogs, []);
  assert.deepEqual(report.uncaught, []);
  assert.deepEqual(report.shellsUnfilled, []);
  assert.equal(report.methods?.claudeTasksEnabled?.value, false, 'off by default, as before');
  assert.deepEqual(report.methods?.listCodexTasks?.value, []);
  assert.equal((report.methods?.codexTaskCapabilities?.value as { enabled?: boolean } | undefined)?.enabled, false);
});
