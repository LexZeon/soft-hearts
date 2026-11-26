// Overhaul step 8 (docs/claude/2026-11-17-lazy-loading-step8.md): the windows start loading before the parts that do not draw have started.
// A desk: call that comes before its handler is registered waits in an IPC shell (electron/wiring/ipc-wiring.ts openIpcShells) and then runs
// through the real handler, guard included; the agent channel's recorder still records the real handlers; a shell nothing fills answers
// "no handler" once the shells close; the shell list is exactly the wiring golden's handlers. Then the whole app under the stand-ins: the
// companion window's first calls, made while the ready chain still starts parts, get the same answers as calls made after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { IPC_SHELL_METHODS } from '../electron/wiring/ipc-shells-wiring';
import { recordAgentOperations } from '../electron/safety/agent-channel/bridge';
import { runStandIn } from './helpers/app-stand-in/spawn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** electron/wiring/ipc-wiring.ts with a fake ipcMain (its sibling imports load the same way). */
function loadIpcWiring(fakes: Record<string, unknown>): Record<string, any> {
  const cache = new Map<string, Record<string, any>>();
  const load = (file: string): Record<string, any> => {
    const hit = cache.get(file);
    if (hit) return hit;
    const module = { exports: {} as Record<string, any> };
    cache.set(file, module.exports);
    const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
    const localRequire = createRequire(file);
    const requireFn = (name: string) => name in fakes ? fakes[name]
      : name.startsWith('.') && fs.existsSync(path.resolve(path.dirname(file), name + '.ts')) ? load(path.resolve(path.dirname(file), name + '.ts'))
      : localRequire(name);
    new Function('module', 'exports', 'require', '__dirname', code)(module, module.exports, requireFn, path.dirname(file));
    cache.set(file, module.exports);
    return module.exports;
  };
  return load(path.join(ROOT, 'electron/wiring/ipc-wiring.ts'));
}

type Handler = (event: unknown, ...args: unknown[]) => unknown;
/** An ipcMain like Electron's: handle is an own property; a second handler for a channel throws; removeHandler drops it. */
function shellWorld() {
  const handlers = new Map<string, Handler>();
  const ipcMain: Record<string, any> = {
    handle(channel: string, handler: Handler) { if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`); handlers.set(channel, handler); },
    removeHandler(channel: string) { handlers.delete(channel); },
  };
  const original = ipcMain.handle;
  const window = (id: number) => { const mainFrame = { id }; return { webContents: { id, mainFrame } }; };
  const controls = window(1), pet = window(2), stranger = window(3);
  const ipc = loadIpcWiring({ electron: { ipcMain } });
  ipc.wireIpc({ windows: () => [controls, pet], controls: () => controls });
  const event = (win: ReturnType<typeof window>) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  /** A renderer's invoke: whatever the channel's handler is now (a shell, the real one, or none: Electron's own error). */
  const invoke = async (win: ReturnType<typeof window>, method: string, ...args: unknown[]) => {
    const handler = handlers.get(`desk:${method}`);
    if (!handler) throw new Error(`No handler registered for 'desk:${method}'`);
    return await handler(event(win), ...args);
  };
  return { ipc, ipcMain, original, handlers, controls, pet, stranger, invoke };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a call before its handler is registered waits in its shell, then runs through the real handler and its guard', async () => {
  const w = shellWorld();
  w.ipc.openIpcShells(['getThing', 'controlThing']);
  const answers: unknown[] = [];
  const early = w.invoke(w.pet, 'getThing', 'a').then(value => answers.push(value));
  const second = w.invoke(w.controls, 'getThing', 'b').then(value => answers.push(value));
  const refused = w.invoke(w.pet, 'controlThing').then(() => 'answered', (error: Error) => error.message);
  const stranger = w.invoke(w.stranger, 'getThing').then(() => 'answered', (error: Error) => error.message);
  await settle();
  assert.deepEqual(answers, [], 'nothing answers before the part registered (a shell never answers by itself)');
  const ran: unknown[] = [];
  w.ipc.host('getThing', (value: string) => { ran.push(value); return `thing ${value}`; }, false);
  w.ipc.host('controlThing', () => 'control');
  await Promise.all([early, second]);
  assert.deepEqual(answers, ['thing a', 'thing b'], 'the calls that waited run in the order they came, with their own arguments');
  assert.equal(await refused, '请求来源未授权。', 'the guard still refuses the pet a control-window method');
  assert.equal(await stranger, '请求来源未授权。', 'and a window that is not ours');
  assert.deepEqual(ran, ['a', 'b'], 'nothing refused reached the operation');
  assert.equal(await w.invoke(w.pet, 'getThing', 'c'), 'thing c', 'once filled, a call runs at once');
});

test('the agent channel recorder records the real handlers through the shells; a second registration still throws', () => {
  const w = shellWorld();
  w.ipc.openIpcShells(['getSettings', 'getThing']);
  const recorder = recordAgentOperations(w.ipc.hostIpc());
  w.ipc.host('getSettings', () => 'settings', false);
  w.ipc.host('getThing', () => 'thing', false);
  const recorded = recorder.done();
  assert.ok(recorded.has('getSettings'), 'a whitelisted operation is recorded');
  assert.ok(!recorded.has('getThing'), 'one off the whitelist is not');
  const event = { sender: w.pet.webContents, senderFrame: w.pet.webContents.mainFrame };
  assert.equal(recorded.get('getSettings')!(event as never), 'settings', 'the recorded handler is the real one (it answers at once, not a shell)');
  assert.throws(() => w.ipc.host('getThing', () => 'again'), /second handler/);
});

test('closing the shells: ipcMain.handle is as it was; a shell nothing filled fails its waiting calls and later ones as "no handler"', async () => {
  const w = shellWorld();
  const before = Object.getOwnPropertyDescriptor(w.ipcMain, 'handle');
  w.ipc.openIpcShells(['filled', 'never']);
  assert.equal(w.ipc.ipcShellsOpen(), true);
  const waiting = w.invoke(w.controls, 'never').then(() => 'answered', (error: Error) => error.message);
  w.ipc.host('filled', () => 1);
  w.ipc.closeIpcShells();
  assert.equal(w.ipc.ipcShellsOpen(), false);
  assert.deepEqual(w.ipc.ipcShellsUnfilled(), ['never']);
  assert.equal(await waiting, "No handler registered for 'desk:never'");
  await assert.rejects(w.invoke(w.controls, 'never'), /No handler registered/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(w.ipcMain, 'handle'), before, 'ipcMain.handle is the one it was');
  w.ipc.host('later', () => 2);
  assert.equal(await w.invoke(w.controls, 'later'), 2, 'a registration after closing goes straight to ipcMain');
  assert.equal(await w.invoke(w.controls, 'filled'), 1);
});

// 2026-11-17 candidate smoke (docs/claude/2026-11-17-candidate-smoke-fix.md): the packaged smoke installs its main-process boundary at the
// first window, which since step 8 comes while the app still starts its parts. Its Claude task refusal used to replace desk:startCodexTask
// right then: the replacement took the open shell, the app's own registration threw "second handler" and the start failed behind a modal
// error box. Now the boundary leaves the app's channels alone, and the refusal goes in once the app answered (afterAppReady).
test('the packaged smoke\'s boundary at the first window leaves the app\'s IPC alone; its task refusal after the start is the live handler', async () => {
  const smoke = await import(new URL('../scripts/lib/smoke-isolation.mjs', import.meta.url).href);
  const w = shellWorld();
  const session = { defaultSession: { webRequest: { onBeforeRequest() {} }, setPermissionCheckHandler() {}, setPermissionRequestHandler() {} } };
  const expected = { marker: 'synthetic-marker', taskProbe: 'probe-0123456789abcdef' };
  const context = createContext({ Date, Error, Object, expected, electron: { app: {}, session, desktopCapturer: { getSources() {} }, ipcMain: w.ipcMain } });
  const inMain = (fn: Function) => runInContext(`(${fn.toString()})(electron, expected)`, context);
  w.ipc.openIpcShells(['getSettings', ...smoke.SMOKE_REFUSED_TASK_METHODS]);
  const early = w.invoke(w.controls, 'getSettings');
  inMain(smoke.installMainBoundary); // the first window: the app is still starting its parts
  // The app's registration, as registerIPC makes it (the Claude task part is lazy: its shells register through partIpc's host).
  assert.doesNotThrow(() => { w.ipc.host('getSettings', () => 'settings', false); for (const method of smoke.SMOKE_REFUSED_TASK_METHODS) w.ipc.host(method, () => 'the app\'s task'); },
    'the app registers its own task handlers after the smoke\'s boundary went in');
  w.ipc.closeIpcShells();
  assert.deepEqual(w.ipc.ipcShellsUnfilled(), []);
  assert.equal(await early, 'settings', 'the window\'s early call answers once the app registered: afterAppReady\'s signal');
  inMain(smoke.installTaskRefusal);
  for (const method of smoke.SMOKE_REFUSED_TASK_METHODS) {
    assert.equal((await w.invoke(w.controls, method, { smokeTaskProbe: expected.taskProbe }) as { smokeTaskRefusal?: string }).smokeTaskRefusal, method, `${method}: the smoke's refusal answers its probe`);
    await assert.rejects(w.invoke(w.controls, method, { prompt: 'x' }), /No agent execution/, `${method}: any other call is refused`);
  }
  const boundary = runInContext('globalThis.__safeSmokeBoundary', context);
  assert.equal(boundary.taskRefusal, true);
  assert.equal(boundary.taskProbes, 3);
  assert.equal(boundary.taskAttempts, 3, 'every real call is counted');
  assert.throws(() => inMain(smoke.installTaskRefusal), /already installed/);
});

test('the shell list is exactly the wiring golden\'s handlers (a new handler goes into electron/wiring/ipc-shells-wiring.ts too)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/wiring-golden.json'), 'utf8'));
  const handlers = [...golden.handlers.controlOnly, ...golden.handlers.eitherWindow].sort();
  assert.deepEqual([...IPC_SHELL_METHODS], handlers, 'electron/wiring/ipc-shells-wiring.ts lists every desk: handler, sorted');
});

test('the whole app: the pet window\'s first calls, made while parts still start, wait and get the answers calls after the start get', { timeout: 120_000 }, async () => {
  const early = ['getUiLanguage', 'getSettings', 'getModelPhysicsSettings', 'getMusicSettings', 'getCharacterCards'];
  const report = await runStandIn({ early, methods: early });
  assert.deepEqual(report.dialogs, []);
  assert.equal(report.quit, false);
  assert.deepEqual(report.uncaught, [], 'no window event during the start threw');
  assert.equal(report.shellsOpen, false, 'the shells closed with the last registration');
  assert.deepEqual(report.shellsUnfilled, [], 'every shelled method was registered by the app');
  for (const method of early) {
    const call = report.early?.[method];
    assert.ok(call, `${method} was called early`);
    assert.equal(call.shellsOpen, true, `${method} came while the ready chain was still starting parts`);
    assert.equal(call.error, undefined, `${method} answered: ${call.error}`);
    assert.ok(!call.pending, `${method} did not hang`);
    // The packaged smoke relies on it (scripts/lib/smoke-isolation.mjs afterAppReady; docs/claude/2026-11-17-candidate-smoke-fix.md): an early
    // call answers only after the app's whole registration, so a window's answered getSettings means every handler is the app's own.
    assert.equal(call.answeredShellsOpen, false, `${method} answered only after the last registration closed the shells`);
    assert.deepEqual(call.value, report.methods?.[method]?.value, `${method}: the early answer is the one after the start`);
  }
});
