// The wiring golden (scripts/dev/wiring-golden.mjs; docs/claude/2026-11-16-wiring-rewrite-plan.md step 0,
// docs/claude/2026-11-16-wiring-steps-0-2.md): the IPC handlers and their control-window flag, the preload one to one, the channels
// the host sends, and the order of start-up, quitting, the 1-second clock, secureWindow and saveSettings. Every step of the wiring
// rewrite must leave it unchanged; an intended change regenerates it (and says why in the commit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGolden, DATA_MAP_ROW_FILES, GOLDEN_FILE, privacyOrder } from '../scripts/dev/wiring-golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGENERATE = 'regenerate with `node scripts/dev/wiring-golden.mjs --write` only if the change is intended, and say why in the commit';

const live = buildGolden(ROOT);

test('the wiring matches the golden (tests/fixtures/wiring-golden.json)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, GOLDEN_FILE), 'utf8'));
  for (const key of Object.keys(golden)) assert.deepEqual(live[key], golden[key], `wiring golden: "${key}" changed; ${REGENERATE}`);
  assert.deepEqual(Object.keys(live).sort(), Object.keys(golden).sort(), `wiring golden: sections changed; ${REGENERATE}`);
});

test('the preload and the host handlers match one to one', () => {
  assert.deepEqual(live.preload.invokeWithoutHandler, [], 'the preload invokes a desk: method no host handler registers');
  assert.deepEqual(live.preload.subscribeWithoutSender, [], 'the preload subscribes to a channel the host never sends');
  assert.deepEqual(live.preload.sentWithoutSubscriber, [], 'the host sends a desk: channel no preload listens to');
  // A handler the preload does not call is one only the agent channel reuses (electron/safety/agent-channel/bridge.ts).
  const agentOnly = live.preload.handlerWithoutInvoke.filter((m) => !live.agentChannel.recorded.includes(m));
  assert.deepEqual(agentOnly, [], 'a host handler that neither the preload nor the agent channel uses');
  assert.deepEqual(live.handlers.registeredTwice, [], 'a desk: method registered twice (ipcMain.handle would throw)');
  assert.equal(live.handlers.computedFlag, undefined, 'a handler whose control-window flag is not a literal: the golden cannot pin it');
});

test('every operation the agent channel may reuse is registered while its recorder listens', () => {
  assert.deepEqual(live.agentChannel.notRecorded, []);
  assert.ok(live.agentChannel.recorded.length > 40);
});

test('the golden is not empty where it matters', () => {
  assert.ok(live.counts.handlers > 300 && live.counts.controlOnly > 100 && live.counts.eitherWindow > 100);
  assert.ok(live.order.readyChain.includes('registerIPC()'));
  assert.ok(live.order.clock.includes('if (!scope)') && live.order.clock.includes('  return'));
  assert.ok(live.order.beforeQuit.some((q) => q.registration === "app.on('before-quit')" && q.steps[0].startsWith('appJournal.appQuitting(')));
  assert.ok(live.order.secureWindow.events.length > 10);
  assert.ok(live.order.saveSettings.length > 20);
  // Wiring rewrite step 4: saveSettings' and sync's step lists are expanded in place (the save keeps its 43 steps). Step 5 adds one line:
  // the saved step savedCompanionContext moved to electron/wiring/brain-wiring.ts reads the stores through needs
  // (`const { store, characterCards } = needs`, docs/claude/2026-11-17-wiring-step-5.md); its own line is unchanged.
  // I-162 step 1 (docs/claude/2026-11-19-character-voice-step1.md): saveCardPersona's voice step adds six lines (a voice choice saved for
  // the active character moves her card's voice along).
  // 2026-11-25 (docs/claude/2026-11-25-no-interrupt.md): savedCompanionContext waits for her reply when it would restart her chat process (+5 lines), saveStopsSpeech stops only for another model (-2).
  assert.equal(live.order.saveSettings.length, 55);
  assert.ok(live.order.sync.includes('companionCommands?.refresh()') && live.order.sync.includes('updateTray()') && live.order.sync.length > 60);
  // Wiring rewrite step 4e: the mood publish (her cue's claim among its steps).
  assert.ok(live.order.moodPublish?.some((step) => step.startsWith('const claimant = ')) && live.order.moodPublish.includes("broadcast('desk:mood', withBodyPose(visibleView))"));
  // The cue chain (electron/wiring/initiative-wiring.ts CUE_CHAIN): her hand first, then the opening choice; the publish asks it.
  assert.deepEqual(live.order.cueChain?.map((step) => step.slice(0, step.indexOf(':'))), ['hands', 'opening']);
  assert.ok(live.order.moodPublish.includes('const claimant = claimMoodCue(view)'));
});

// ---- 记忆 (wiring rewrite step 4d): the order deleting a character and turning 「允许记录」 off go through the stores -------------------

test('the privacy order comes from the data map: forgetting, finding back, recording off, clearing the diary', () => {
  const p = live.privacy;
  assert.ok(p && p.forgetCapture.length > 25, 'every row the bin takes');
  assert.deepEqual(p.forgetRemove.slice(0, 3), ['character-avatars', 'character-response', 'character-cards'], 'the card goes first (the one step that may refuse: the last card)');
  assert.equal(p.forgetRestore[0], 'character-cards', 'and comes back first');
  assert.deepEqual(p.forgetRestore.slice(-3), ['memory-keywords', 'memory-vectors', 'recycle-bin'], 'what is rebuilt from the rest goes back last');
  assert.deepEqual(p.recordingOff, ['upcoming-marks', 'her-note', 'moving-memory', 'rps', 'feeding', 'hands', 'voiceprint']); // Unbound v1 step 3: the voiceprint goes too
  assert.deepEqual(p.diaryCleared, ['rps', 'feeding']);
});

test('a swapped data-map row or order rule changes the privacy golden (not the order the parts register in)', () => {
  const copy = (edit) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-golden-privacy-'));
    for (const file of ['electron/foundation/data-map.ts', ...DATA_MAP_ROW_FILES, 'electron/memory/recycle/character.ts', 'electron/memory/privacy-wiring.ts', 'shared/foundation/assistant-name.ts']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
    }
    edit(root);
    try { return privacyOrder(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  assert.deepEqual(copy(() => {}), live.privacy, 'a copy of the three files gives the same order');
  const swapRows = (a, b) => (root) => {
    const file = path.join(root, DATA_MAP_ROW_FILES.find((f) => fs.readFileSync(path.join(root, f), 'utf8').includes(`{ id: '${a}'`)));
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const at = (id) => lines.findIndex((line) => line.trimStart().startsWith(`{ id: '${id}'`));
    const i = at(a), j = at(b);
    assert.ok(i > 0 && j > i, `rows ${a} and ${b} start on their own lines`);
    const end = (k) => { let e = k; while (!/\},\s*(\/\/.*)?\r?$/.test(lines[e])) e++; return e; };
    const ra = lines.slice(i, end(i) + 1), rb = lines.slice(j, end(j) + 1);
    lines.splice(j, rb.length, ...ra); lines.splice(i, ra.length, ...rb);
    fs.writeFileSync(file, lines.join('\n'));
  };
  assert.notDeepEqual(copy(swapRows('her-note', 'moving-memory')).recordingOff, live.privacy.recordingOff, 'two recording-off rows swapped');
  assert.notDeepEqual(copy(swapRows('rps', 'feeding')).forgetRemove, live.privacy.forgetRemove, 'two forget rows swapped');
  assert.notDeepEqual(copy((root) => {
    const file = path.join(root, 'electron/memory/recycle/character.ts');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("['memory-keywords', 'memory-vectors', 'recycle-bin']", "['memory-vectors', 'memory-keywords', 'recycle-bin']"));
  }).forgetRestore, live.privacy.forgetRestore, 'the last-restored rule changed');
  assert.notDeepEqual(copy((root) => {
    const file = path.join(root, 'electron/memory/privacy-wiring.ts');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('for (const id of recordingOffIds()) {', 'for (const id of Object.keys(registry) as RecordingOffId[]) {'));
  }).recordingOff, live.privacy.recordingOff, 'a runner that walks the registry (the order the stores were registered in) instead of the table');
});

// ---- the extractor on a small fake repo: moving code between files keeps the golden ------------------------------------------

const PRELOAD = `import { ipcRenderer } from 'electron';
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(\`desk:\${method}\`, ...args);
function subscribe(channel: string, callback: (v: unknown) => void) { ipcRenderer.on(channel, (_e, v) => callback(v)); }
export const api = { a: () => invoke('getA'), b: () => invoke('setB'), c: () => invoke('getC'), d: () => invoke('getD'), e: () => invoke('fixedE'),
  onA: (cb: any) => subscribe('desk:a', cb) };
`;
const BRIDGE = `export const AGENT_HOST_OPERATIONS: readonly string[] = Object.freeze(['setB', 'getC']);
export const AGENT_PET_OPERATIONS: readonly string[] = Object.freeze([]);
export function recordAgentOperations(ipc: any) { return { done() { return new Map(); } }; }
`;
const PART = `type Register = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;
export function registerPartIpc(register: Register): void {
  register('getC', () => 1, false);
  const fixed = (method: string, op: () => unknown, controlOnly: boolean) => register(method, () => op(), controlOnly);
  fixed('fixedE', () => 2, false);
  for (const name of ['getD'] as const) register(name, () => 3);
}
`;
const mainWith = (registerBody, readyBody, extraImports = '') => `import { app, ipcMain } from 'electron';
import { registerPartIpc } from './part/ipc';
import { recordAgentOperations } from './safety/agent-channel/bridge';
${extraImports}
declare const controls: any; declare function windows(): any[];
function broadcast(channel: string, value: unknown) { for (const w of windows()) w.webContents.send(channel, value); }
function host(method: string, operation: (...args: any[]) => unknown, controlOnly = true): void { scopedHost(method, (_s, ...a) => operation(...a), controlOnly); }
function scopedHost(method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly = true): void {
  ipcMain.handle(\`desk:\${method}\`, (event, ...args) => operation(event.sender.id, ...args));
}
function registerIPC(): void {
  const agentOperations = recordAgentOperations(ipcMain);
${registerBody}
  agentOperations.done();
}
app.whenReady().then(async () => {
${readyBody}
  registerIPC();
  setInterval(() => { tick(); }, 1_000);
});
app.on('before-quit', () => { stop(); });
function secureWindow(win: any) { win.on('hide', () => hidden()); }
declare function tick(): void; declare function stop(): void; declare function hidden(): void; declare function load(): Promise<void>; declare function draw(): void;
`;

function fakeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-golden-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const base = {
  'electron/safety/preload.ts': PRELOAD,
  'electron/safety/agent-channel/bridge.ts': BRIDGE,
  'electron/part/ipc.ts': PART,
};
const SAVE = `  host('saveSettings', (value: unknown) => mutate(async () => { first(); await second(); }));
declare function mutate(f: () => Promise<void>): void; declare function first(): void; declare function second(): Promise<void>;`;

test('fake repo: handlers in main, in a part, through a local helper and a loop; flags; the agent window; the order lists', () => {
  const root = fakeRepo({ ...base, 'electron/main.ts': mainWith(`  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  await load();\n  draw();') });
  try {
    const g = buildGolden(root);
    assert.deepEqual(g.handlers.controlOnly, ['getD', 'saveSettings', 'setB']);
    assert.deepEqual(g.handlers.eitherWindow, ['fixedE', 'getA', 'getC']);
    assert.deepEqual(g.registrarSites, ['registerPartIpc(…)']);
    assert.deepEqual(g.agentChannel.recorded, ['getC', 'setB']);
    assert.deepEqual(g.preload.invokeWithoutHandler, []);
    assert.deepEqual(g.preload.handlerWithoutInvoke, ['saveSettings']);
    assert.deepEqual(g.sentChannels, ['desk:a']);
    assert.deepEqual(g.order.readyChain, ['await load()', 'draw()', 'registerIPC()', 'setInterval(fn, 1000)']);
    assert.deepEqual(g.order.clock, ['tick()']);
    assert.deepEqual(g.order.saveSettings, ['mutate(fn) =>', '  first()', '  await second()']);
    assert.deepEqual(g.order.secureWindow.events, [{ on: "win.on('hide')", steps: ['hidden()'] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fake repo: moving handlers and a stretch of the ready chain into electron/wiring/*.ts keeps the golden', () => {
  const before = fakeRepo({ ...base, 'electron/main.ts': mainWith(`  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  await load();\n  draw();') });
  const after = fakeRepo({ ...base,
    'electron/main.ts': mainWith(`  wireA(host, scopedHost);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  await startA();', "import { wireA, startA } from './wiring/a-wiring';"),
    'electron/wiring/a-wiring.ts': `type R = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;
export function wireA(host: R, scopedHost: R): void { host('getA', () => 1, false); scopedHost('setB', () => 2); }
export async function startA(): Promise<void> { await load(); draw(); }
declare function load(): Promise<void>; declare function draw(): void;
` });
  try {
    const a = buildGolden(before);
    const b = buildGolden(after);
    assert.deepEqual(b.handlers, a.handlers);
    assert.deepEqual(b.agentChannel, a.agentChannel);
    assert.deepEqual(b.order, a.order);
    assert.deepEqual(b.preload, a.preload);
    assert.deepEqual(b.registrarSites, ['wireA(…)', 'registerPartIpc(…)']);
  } finally {
    fs.rmSync(before, { recursive: true, force: true });
    fs.rmSync(after, { recursive: true, force: true });
  }
});

test('fake repo: a changed flag, a dropped handler or a reordered step changes the golden', () => {
  const variants = {
    base: mainWith(`  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  await load();\n  draw();'),
    flag: mainWith(`  host('getA', () => 1);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  await load();\n  draw();'),
    dropped: mainWith(`  host('getA', () => 1, false);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  await load();\n  draw();'),
    order: mainWith(`  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  draw();\n  await load();'),
    late: mainWith(`  host('getA', () => 1, false);\n  agentOperations.done();\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n  broadcast('desk:a', 1);\n${SAVE}`, '  await load();\n  draw();'),
  };
  const goldens = {};
  for (const [name, main] of Object.entries(variants)) {
    const root = fakeRepo({ ...base, 'electron/main.ts': main });
    try { goldens[name] = buildGolden(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  assert.deepEqual(goldens.flag.handlers.eitherWindow, ['fixedE', 'getC']);
  assert.deepEqual(goldens.dropped.preload.invokeWithoutHandler, ['setB']);
  assert.notDeepEqual(goldens.order.order.readyChain, goldens.base.order.readyChain);
  assert.deepEqual(goldens.late.agentChannel.notRecorded, ['getC', 'setB']); // registered after the recorder stopped
});

test('fake repo: secureWindow dispatching to subscribers, its security half and the guards in electron/wiring/*.ts keep the golden (wiring rewrite step 3)', () => {
  const secureBefore = `function secureWindow(win: any) { const owner = win === pet ? 'pet' : 'controls'; win.on('hide', () => hidden(owner)); win.webContents.on('will-navigate', (e: any) => e.preventDefault()); win.webContents.on('destroyed', () => gone()); }
declare const pet: any; declare function gone(): void;`;
  const registerBody = `  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n${SAVE}`;
  const readyBody = "  host('getC2', () => 3);\n  await load();";
  const before = fakeRepo({ ...base, 'electron/main.ts': mainWith(registerBody, readyBody).replace("function secureWindow(win: any) { win.on('hide', () => hidden()); }", secureBefore) });
  // After: the guards live in ipc-wiring (main imports them), secureWindow in lifecycle-wiring dispatches to main's subscriber, which
  // calls the shell's security half at its old place. The ready chain still calls host(...): a guard is not inlined.
  const mainAfter = mainWith(registerBody, readyBody,
    "import { host, scopedHost } from './wiring/ipc-wiring';\nimport { wireLifecycle } from './wiring/lifecycle-wiring';\nimport { guardNavigation } from './wiring/shell-wiring';")
    .replace(/function host\([^\n]*\n/, '').replace(/function scopedHost\([^]*?\n}\n/, '')
    .replace("function secureWindow(win: any) { win.on('hide', () => hidden()); }", `wireLifecycle([events]);
function events(win: any, owner: string) { win.on('hide', () => hidden(owner)); guardNavigation(win); win.webContents.on('destroyed', () => gone()); }
declare function gone(): void;`);
  const after = fakeRepo({ ...base, 'electron/main.ts': mainAfter,
    'electron/wiring/ipc-wiring.ts': `import { ipcMain } from 'electron';
export function host(method: string, operation: (...args: any[]) => unknown, controlOnly = true): void { scopedHost(method, (_s, ...a) => operation(...a), controlOnly); }
export function scopedHost(method: string, operation: (sender: number, ...args: any[]) => unknown, controlOnly = true): void {
  ipcMain.handle(\`desk:\${method}\`, (event: any, ...args: any[]) => operation(event.sender.id, ...args));
}
`,
    'electron/wiring/lifecycle-wiring.ts': `type Sub = (win: any, owner: string, id: number) => void;
let subscribers: readonly Sub[] = [];
export function wireLifecycle(list: readonly Sub[]): void { subscribers = [...list]; }
export function secureWindow(win: any, pet: any = null) { const owner = win === pet ? 'pet' : 'controls'; for (const subscribe of subscribers) subscribe(win, owner, 1); }
`,
    'electron/wiring/shell-wiring.ts': `export function guardNavigation(win: any): void { win.webContents.on('will-navigate', (e: any) => e.preventDefault()); }
` });
  try {
    const a = buildGolden(before);
    const b = buildGolden(after);
    assert.deepEqual(a.order.secureWindow.events.map((e) => e.on), ["win.on('hide')", "win.webContents.on('will-navigate')", "win.webContents.on('destroyed')"]);
    assert.ok(a.order.readyChain.includes("host('getC2', fn)"), 'the guard call is a step of the ready chain');
    assert.deepEqual(b.order, a.order);
    assert.deepEqual(b.handlers, a.handlers);
    assert.deepEqual(b.agentChannel, a.agentChannel);
  } finally {
    fs.rmSync(before, { recursive: true, force: true });
    fs.rmSync(after, { recursive: true, force: true });
  }
});

test('fake repo: a part registering through partIpc inside the recorder keeps its handlers recorded; outside it they are not (wiring rewrite step 4)', () => {
  const registerBody = (call) => `  host('getA', () => 1, false);\n${call}\n  registerPartIpc(host);\n${SAVE}`;
  const before = fakeRepo({ ...base, 'electron/main.ts': mainWith(`  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n${SAVE}`, '  await load();') });
  const part = `type R = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;
export function wireB() { return { id: 'b', units: ['b'], register(ipc: { host: R; scopedHost: R }) { const { scopedHost } = ipc; scopedHost('setB', () => 2); }, provides: {} }; }
`;
  const imports = "import { wireB } from './wiring/b-wiring';\ndeclare function partIpc(part: string): any;\nconst b = wireB();";
  const inside = fakeRepo({ ...base, 'electron/wiring/b-wiring.ts': part, 'electron/main.ts': mainWith(registerBody("  b.register(partIpc('b'));"), '  await load();', imports) });
  const outside = fakeRepo({ ...base, 'electron/wiring/b-wiring.ts': part,
    'electron/main.ts': mainWith(registerBody(''), '  await load();', imports).replace('  registerIPC();', "  registerIPC();\n  b.register(partIpc('b'));") });
  try {
    const a = buildGolden(before), b = buildGolden(inside), c = buildGolden(outside);
    assert.deepEqual(b.handlers, a.handlers);
    assert.deepEqual(b.agentChannel, a.agentChannel);
    assert.deepEqual(b.order, a.order);
    assert.deepEqual(b.registrarSites, ['b.register(…)', 'registerPartIpc(…)'], 'the part shows as a place the wiring hands its registrars');
    assert.deepEqual(c.agentChannel.notRecorded, ['setB'], 'registered after the recorder stopped');
  } finally {
    for (const root of [before, inside, outside]) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fake repo: saveSettings and sync as ordered step lists in electron/wiring/*.ts keep the golden; reordering two steps changes it (wiring rewrite step 4)', () => {
  // Before: saveSettings and sync write every step in their own bodies (as electron/main.ts did).
  const saveBefore = `  host('saveSettings', (value: unknown, baseline: unknown) => mutate(async () => {
    const next = check(value);
    keep(next);
    if (baseline !== undefined) clears(next, baseline);
    persona(next);
    try { const saved = await persist(next); await context(); echo(); return saved; } finally { await settle(); }
  }));
declare function mutate(f: () => Promise<unknown>): void; declare function check(v: unknown): any; declare function keep(n: unknown): void; declare function clears(n: unknown, b: unknown): void;
declare function persona(n: unknown): void; declare function persist(n: unknown): Promise<unknown>; declare function context(): Promise<void>; declare function echo(): void; declare function settle(): Promise<void>;`;
  const before = fakeRepo({ ...base, 'electron/main.ts': mainWith(`  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n${saveBefore}`, '  await load();') });
  // After: the settings wiring owns the save and sync; their steps are lists electron/main.ts gives, in order.
  const settingsWiring = `type R = (method: string, operation: (...args: any[]) => unknown, controlOnly?: boolean) => void;
type Prepare = (next: any, baseline: unknown) => void; type Applied = () => void | Promise<void>; type Step = () => void;
let savePrepare: readonly Prepare[] = []; let saveApplied: readonly Applied[] = []; let syncSteps: readonly Step[] = [];
export function wireSaveSettings(prepare: readonly Prepare[], applied: readonly Applied[]): void { savePrepare = [...prepare]; saveApplied = [...applied]; }
export function wireSettingsSync(steps: readonly Step[]): void { syncSteps = [...steps]; }
export function keepIntents(next: any): void { keep(next); }
export function wireS() {
  function sync(): void { own(); for (const step of syncSteps) step(); }
  return { id: 's', units: ['s'], register(ipc: { host: R; scopedHost: R }) { const { host } = ipc;
    host('saveSettings', (value: unknown, baseline: unknown) => mutate(async () => {
      const next = check(value);
      for (const step of savePrepare) step(next, baseline);
      try { const saved = await persist(next); for (const step of saveApplied) await step(); return saved; } finally { await settle(); }
    }));
  }, provides: { sync } };
}
declare function mutate(f: () => Promise<unknown>): void; declare function check(v: unknown): any; declare function keep(n: unknown): void;
declare function persist(n: unknown): Promise<unknown>; declare function settle(): Promise<void>; declare function own(): void;
`;
  const steps = (prepare, sync) => `import { wireS, wireSaveSettings, wireSettingsSync, keepIntents } from './wiring/settings-wiring';
declare function partIpc(part: string): any;
const s = wireS();
wireSaveSettings([${prepare}], [savedContext, savedEcho]);
wireSettingsSync([${sync}]);
function saveClears(next: any, baseline: unknown): void { if (baseline !== undefined) clears(next, baseline); }
function savePersona(next: any): void { persona(next); }
async function savedContext(): Promise<void> { await context(); }
function savedEcho(): void { echo(); }
function syncFirst(): void { first(); }
function syncSecond(): void { second(); }
declare function clears(n: unknown, b: unknown): void; declare function persona(n: unknown): void; declare function context(): Promise<void>; declare function echo(): void;
declare function first(): void; declare function second(): void;`;
  const register = `  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n  s.register(partIpc('s'));`;
  const repo = (prepare, sync) => fakeRepo({ ...base, 'electron/wiring/settings-wiring.ts': settingsWiring, 'electron/main.ts': mainWith(register, '  await load();', steps(prepare, sync)) });
  const after = repo('keepIntents, saveClears, savePersona', 'syncFirst, syncSecond');
  const swapped = repo('keepIntents, savePersona, saveClears', 'syncFirst, syncSecond');
  const swappedSync = repo('keepIntents, saveClears, savePersona', 'syncSecond, syncFirst');
  try {
    const a = buildGolden(before), b = buildGolden(after), c = buildGolden(swapped), d = buildGolden(swappedSync);
    assert.deepEqual(a.order.saveSettings, ['mutate(fn) =>', '  const next = check(value)', '  keep(next)', '  if (baseline !== undefined)', '    clears(next, baseline)', '  persona(next)',
      '  try', '    const saved = await persist(next)', '    await context()', '    echo()', '    return saved', '  finally', '    await settle()']);
    assert.deepEqual(b.order.saveSettings, a.order.saveSettings, 'the step lists expand to the same steps, in place');
    assert.deepEqual(b.order.sync, ['own()', 'first()', 'second()']);
    assert.deepEqual(b.handlers, a.handlers);
    assert.notDeepEqual(c.order.saveSettings, b.order.saveSettings, 'two save steps swapped');
    assert.deepEqual(c.order.saveSettings.slice(3, 6), ['  persona(next)', '  if (baseline !== undefined)', '    clears(next, baseline)']);
    assert.deepEqual(d.order.sync, ['own()', 'second()', 'first()'], 'two sync steps swapped');
    assert.deepEqual(d.order.saveSettings, b.order.saveSettings);
  } finally {
    for (const root of [before, after, swapped, swappedSync]) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fake repo: the mood publish is pinned step by step; the cue chain is pinned in its order, and two steps swapped change it (wiring rewrite step 4e)', () => {
  const ready = `  companion = new CompanionService('dir', view => {
    gate.setScope(view.token);
    const claimant = claimMoodCue(view);
    broadcast('desk:a', claimant);
  });`;
  const chain = (steps) => `declare const hands: any; declare const opening: any;
let owner: unknown = null;
const CUE_CHAIN: readonly { id: string; claims(cue: unknown, view: unknown): string | null }[] = [
${steps}
];
export function claimMoodCue(view: any): string | null {
  let claimant: string | null = null;
  for (const step of CUE_CHAIN) { claimant = step.claims(view.cue, view); if (claimant !== null) break; }
  owner = claimant;
  return claimant;
}
`;
  const hands = "  { id: 'hands', claims: cue => hands.host.claimCue(cue) ? 'hands' : null },";
  const opening = "  { id: 'opening', claims: (cue, view) => opening.claim(cue, { memorial: () => false }, view) },";
  const imports = "import { claimMoodCue } from './wiring/initiative-wiring';\ndeclare class CompanionService { constructor(dir: string, publish: (view: any) => void); }\nlet companion: CompanionService; declare const gate: any;";
  const register = `  host('getA', () => 1, false);\n  scopedHost('setB', () => 2);\n  registerPartIpc(host);\n${SAVE}`;
  const repo = (steps) => fakeRepo({ ...base, 'electron/wiring/initiative-wiring.ts': chain(steps), 'electron/main.ts': mainWith(register, ready, imports) });
  const inOrder = repo(`${hands}\n${opening}`), swapped = repo(`${opening}\n${hands}`);
  const noChain = fakeRepo({ ...base, 'electron/main.ts': mainWith(register, '  await load();') });
  try {
    const a = buildGolden(inOrder), b = buildGolden(swapped);
    assert.deepEqual(a.order.moodPublish, ['gate.setScope(view.token)', 'const claimant = claimMoodCue(view)', "broadcast('desk:a', claimant)"]);
    assert.deepEqual(a.order.cueChain, ["hands: cue => hands.host.claimCue(cue) ? 'hands' : null", 'opening: (cue, view) => opening.claim(cue, { memorial: () => false }, view)']);
    assert.notDeepEqual(b.order.cueChain, a.order.cueChain, 'her hand and the opening swapped');
    assert.deepEqual(b.order.cueChain, [...a.order.cueChain].reverse());
    assert.deepEqual(b.order.moodPublish, a.order.moodPublish, 'the publish itself is the same; only the chain changed');
    const none = buildGolden(noChain);
    assert.equal(none.order.cueChain, undefined, 'no chain, no section');
    assert.equal(none.order.moodPublish, undefined, 'no mood publish, no section');
  } finally {
    for (const root of [inOrder, swapped, noChain]) fs.rmSync(root, { recursive: true, force: true });
  }
});
