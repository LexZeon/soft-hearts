// The control window loaded late (overhaul step 8, docs/claude/2026-11-17-lazy-loading-step8.md; electron/wiring/late-controls-wiring.ts),
// a developer switch that is off by default: its page loads on the first show or the first action push; an action push (「带我去」's page,
// a Claude task proposal, an agent-channel action, Unbound typing's line) is held until the page asked for its character cards and got the
// answer (the last call its start-up waits for), then delivered in order; state pushes go out as before. The renderer's start-up order this
// relies on is pinned below. Then the whole app under the stand-ins, with the switch off (both load) and on (only the companion loads).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { runStandIn, standInTimeout } from './helpers/app-stand-in/spawn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** electron/wiring/late-controls-wiring.ts and the ipc-wiring.ts it uses, one module instance each, with a fake ipcMain. */
function loadLate(fakes: Record<string, unknown>): { late: Record<string, any>; ipc: Record<string, any> } {
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
  const late = load(path.join(ROOT, 'electron/wiring/late-controls-wiring.ts'));
  return { late, ipc: load(path.join(ROOT, 'electron/wiring/ipc-wiring.ts')) };
}
type Handler = (event: unknown, ...args: unknown[]) => unknown;
function world() {
  const handlers = new Map<string, Handler>();
  const { late, ipc } = loadLate({ electron: { ipcMain: { handle(channel: string, handler: Handler) { handlers.set(channel, handler); } } } });
  const delivered: [string, unknown][] = [];
  let shown = 0;
  const mainFrame = { id: 1 };
  const controls = { webContents: { id: 1, mainFrame, send: (channel: string, value: unknown) => { delivered.push([channel, value]); }, isDestroyed: () => false }, show: () => { shown++; } };
  const pet = { webContents: { id: 2, mainFrame: { id: 2 } } };
  ipc.wireIpc({ windows: () => [controls, pet], controls: () => controls });
  ipc.partIpc('cards').host('getCharacterCards', () => ({ cards: [] }), false);
  const cards = (win: { webContents: { id: number; mainFrame: unknown } }) => handlers.get('desk:getCharacterCards')!({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  let loads = 0;
  const handle = late.deferControlsLoad(controls, async () => { loads++; });
  return { late, handle, controls, pet, delivered, cards, shown: () => shown, loads: () => loads };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('the switch: off unless SOFT_HEARTS_LATE_CONTROLS is 1', () => {
  const { late } = world();
  assert.equal(late.lateControlsRequested({}), false);
  assert.equal(late.lateControlsRequested({ SOFT_HEARTS_LATE_CONTROLS: '0' }), false);
  assert.equal(late.lateControlsRequested({ SOFT_HEARTS_LATE_CONTROLS: '1' }), true);
});

test('the page loads on the first show (once); state pushes go out as before', async () => {
  const w = world();
  assert.equal(w.handle.state(), 'waiting');
  assert.equal(w.loads(), 0, 'nothing loads before it is shown');
  w.controls.webContents.send('desk:journal', { lines: 1 });
  assert.deepEqual(w.delivered, [['desk:journal', { lines: 1 }]], 'a state push is sent as before (the page reads the state itself when it loads)');
  w.controls.show(); w.controls.show();
  assert.equal(w.shown(), 2);
  assert.equal(w.loads(), 1, 'loaded once, on the first show');
  assert.equal(w.handle.state(), 'loading');
});

test('an action push is held until the page asked for its cards and got them, then delivered in order; one from the pet does not count', async () => {
  const w = world();
  w.controls.webContents.send('desk:unbound-say', 'hello');
  assert.equal(w.loads(), 1, 'an action push starts the load (Unbound typing reaches the chat box with the window hidden)');
  w.controls.show();
  w.controls.webContents.send('desk:control-navigate', { destination: 'her-folder' });
  assert.deepEqual(w.delivered, [], 'held while the page loads');
  await w.cards(w.pet);
  await tick();
  assert.deepEqual(w.delivered, [], 'the pet asking for cards is not the control window being ready');
  await w.cards(w.controls);
  assert.deepEqual(w.delivered, [], 'not before the answer went out');
  await tick();
  assert.equal(w.handle.state(), 'ready');
  assert.deepEqual(w.delivered, [['desk:unbound-say', 'hello'], ['desk:control-navigate', { destination: 'her-folder' }]]);
  w.controls.webContents.send('desk:codex-task-proposal', 'p');
  assert.deepEqual(w.delivered.at(-1), ['desk:codex-task-proposal', 'p'], 'once ready, an action push goes at once');
});

test('the control window\'s start-up asks for its cards last, after every listener the held pushes need', () => {
  const sf = ts.createSourceFile('src/main.ts', read('src/main.ts'), ts.ScriptTarget.Latest, true);
  const init = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'init');
  assert.ok(init?.body);
  const steps = init!.body!.statements.map(s => s.getText(sf));
  const awaits = steps.filter(text => /\bawait\b/.test(text));
  assert.match(awaits.at(-1)!, /await window\.desktop\.getCharacterCards\(\)/, 'getCharacterCards is the last call init waits for');
  const at = (name: string) => steps.findIndex(text => text.includes(`${name}(`));
  const ready = steps.findIndex(text => text.includes('getCharacterCards'));
  for (const step of ['mountControlWindow', 'wireReplyExtras', 'mountControlTools']) assert.ok(at(step) >= 0 && at(step) < ready, `${step} runs before it`);
  // the four held channels are listened to in those steps
  assert.match(read('src/wiring/control-window-wiring.ts'), /onAgentChannelAction\(/);
  assert.match(read('src/wiring/control-window-wiring.ts'), /onCodexTaskProposal\(/);
  assert.match(read('src/wiring/control-window-wiring.ts'), /onUnboundSay\?\.\(/);
  assert.match(read('src/wiring/initiative-wiring.ts'), /onControlNavigate\(/);
});

test('the whole app: switch off, both pages load at start-up; switch on, only the pet\'s, and the control window\'s on its first show', { timeout: standInTimeout(2) }, async () => {
  const off = await runStandIn({ methods: ['getSettings'] });
  assert.deepEqual([...(off.loadedAtBoot ?? [])].sort(), ['controls', 'pet']);
  const on = await runStandIn({ env: { SOFT_HEARTS_LATE_CONTROLS: '1' }, methods: ['getSettings', 'openControls'] });
  assert.deepEqual(on.dialogs, []);
  assert.deepEqual(on.uncaught, []);
  assert.deepEqual(on.shellsUnfilled, []);
  assert.ok(!('error' in (on.methods?.getSettings ?? {})), 'the handlers answer as before');
  // The stand-in's fresh profile gets the bundled model at start-up, so initialControlsVisible is false: the control window stays unloaded.
  assert.deepEqual(on.loadedAtBoot, ['pet'], 'only the pet at start-up');
  assert.deepEqual(on.loaded, ['pet', 'controls'], 'openControls loaded the control window');
  assert.equal(on.controlsVisible, true, 'and showed it');
});
