// The wiring skeleton (wiring rewrite step 3, docs/claude/2026-11-16-wiring-step-3.md): the IPC guard refuses what it refused before,
// nothing in electron/wiring/ runs on import (it would run before electron/main.ts sets the profile folder), only the guard and the
// window modules that own their own channels import ipcMain, the shared predicates are word-for-word copies, the part runner in strict
// mode changes nothing, the clock keeps its order and its gate, and secureWindow tells its subscribers in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { transformSync } from 'esbuild';
import { createPartRunner, type PartHandle } from '../electron/wiring/parts-wiring';
import { clockTick, type ClockScope } from '../electron/wiring/clock-wiring';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const wiringFiles = () => fs.readdirSync(path.join(ROOT, 'electron/wiring')).filter(name => name.endsWith('.ts')).map(name => `electron/wiring/${name}`);

/** Load an electron/wiring module with fakes for some imports ('electron', a sibling); its other relative .ts imports load the same way. */
function loadWithElectron(rel: string, fakes: Record<string, unknown>): Record<string, any> {
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
  return load(path.join(ROOT, rel));
}

// ---- the IPC guard ------------------------------------------------------------------------------------------------------

type Handler = (event: unknown, ...args: unknown[]) => unknown;
function guardWorld() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle(channel: string, handler: Handler) { if (handlers.has(channel)) throw new Error('twice'); handlers.set(channel, handler); } };
  const frame = (id: number) => ({ id });
  const window = (id: number) => { const mainFrame = frame(id); return { webContents: { id, mainFrame }, mainFrame }; };
  const controls = window(1), pet = window(2), stranger = window(3);
  const ipc = loadWithElectron('electron/wiring/ipc-wiring.ts', { electron: { ipcMain } });
  ipc.wireIpc({ windows: () => [controls, pet], controls: () => controls });
  const event = (win: ReturnType<typeof window>, senderFrame: unknown = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame });
  return { ipc, handlers, controls, pet, stranger, event };
}

test('IPC guard: our windows only, main frame only, and controlOnly means the control window', () => {
  const w = guardWorld();
  const calls: unknown[][] = [];
  w.ipc.host('controlThing', (...args: unknown[]) => { calls.push(['controlThing', ...args]); return 'ok'; });
  w.ipc.scopedHost('eitherThing', (sender: number, ...args: unknown[]) => { calls.push(['eitherThing', sender, ...args]); return sender; }, false);
  const control = w.handlers.get('desk:controlThing')!, either = w.handlers.get('desk:eitherThing')!;
  // allowed
  assert.equal(control(w.event(w.controls), 'a'), 'ok');
  assert.equal(either(w.event(w.pet), 'b'), 2);
  assert.equal(either(w.event(w.controls)), 1);
  assert.deepEqual(calls, [['controlThing', 'a'], ['eitherThing', 2, 'b'], ['eitherThing', 1]]);
  // a sender that is not one of our windows
  assert.throws(() => either(w.event(w.stranger)), /请求来源未授权/);
  assert.throws(() => control(w.event(w.stranger)), /请求来源未授权/);
  // a sub-frame of our own window
  assert.throws(() => either(w.event(w.pet, { id: 99 })), /请求来源未授权/);
  assert.throws(() => control(w.event(w.controls, { id: 98 })), /请求来源未授权/);
  // the companion calling a control-window-only method (host's default, and scopedHost's)
  assert.throws(() => control(w.event(w.pet)), /请求来源未授权/);
  w.ipc.scopedHost('scopedControl', () => 'no');
  assert.throws(() => w.handlers.get('desk:scopedControl')!(w.event(w.pet)), /请求来源未授权/);
  assert.equal(calls.length, 3, 'nothing refused reached its operation');
});

test('IPC guard: partIpc in strict mode is exactly host / scopedHost (same refusals, same default)', () => {
  const w = guardWorld();
  const part = w.ipc.partIpc('cards');
  part.host('partControl', () => 'c');
  part.scopedHost('partEither', (sender: number) => sender, false);
  assert.equal(w.handlers.get('desk:partControl')!(w.event(w.controls)), 'c');
  assert.throws(() => w.handlers.get('desk:partControl')!(w.event(w.pet)), /请求来源未授权/);
  assert.equal(w.handlers.get('desk:partEither')!(w.event(w.pet)), 2);
  assert.throws(() => w.handlers.get('desk:partEither')!(w.event(w.stranger)), /请求来源未授权/);
  assert.throws(() => w.handlers.get('desk:partEither')!(w.event(w.pet, { id: 7 })), /请求来源未授权/);
});

test('IPC guard: the agent channel records through the same ipcMain the guard registers on', () => {
  const w = guardWorld();
  assert.equal(typeof w.ipc.hostIpc().handle, 'function');
  const original = w.ipc.hostIpc().handle;
  const seen: string[] = [];
  w.ipc.hostIpc().handle = function (channel: string, handler: Handler) { seen.push(channel); return original.call(this, channel, handler); };
  w.ipc.host('recordedThing', () => 1);
  assert.deepEqual(seen, ['desk:recordedThing']);
});

// ---- nothing in electron/wiring/ runs on import ----------------------------------------------------------------------------

/** Top-level statements that run code on import: anything but imports, exports of declarations, declarations, and inert initializers. */
function moduleLevelEffects(rel: string): string[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const runs = (node: ts.Node | undefined): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return; // a body runs when called, not on import
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isAwaitExpression(n)
        || ts.isDeleteExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        || ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
        || ts.isPostfixUnaryExpression(n)) { found = true; return; }
      ts.forEachChild(n, walk);
    };
    if (node) walk(node);
    return found;
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) { if (!st.importClause) out.push(`side-effect import ${st.moduleSpecifier.getText(sf)}`); continue; }
    if (ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st)) {
      if (ts.isClassDeclaration(st) && st.members.some(m => ts.isPropertyDeclaration(m) && m.modifiers?.some(x => x.kind === ts.SyntaxKind.StaticKeyword) && runs(m.initializer)))
        out.push(`static initializer in class ${st.name?.text}`);
      continue;
    }
    if (ts.isExportDeclaration(st)) { if (!st.exportClause && !st.isTypeOnly) out.push('export *'); continue; }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (runs(d.initializer)) out.push(`initializer of ${d.name.getText(sf)} runs code`);
      continue;
    }
    if (ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) { out.push(`${ts.SyntaxKind[st.kind]} (emits code)`); continue; }
    out.push(`statement: ${st.getText(sf).slice(0, 60)}`);
  }
  return out;
}

test('electron/wiring/*: no module-level side effects (only imports, exports, declarations and inert initializers)', () => {
  const files = wiringFiles();
  assert.ok(files.length >= 6, 'the six skeleton files exist');
  for (const rel of files) {
    assert.match(path.basename(rel), /-wiring\.ts$/, `${rel}: every file in electron/wiring/ ends in -wiring.ts`);
    assert.deepEqual(moduleLevelEffects(rel), [], `${rel} runs code on import; it would run before electron/main.ts sets the profile folder`);
  }
  // the check itself catches each form
  const probe = (text: string) => {
    const file = path.join(ROOT, '.local', 'wiring-probe-wiring.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    try { return moduleLevelEffects(path.relative(ROOT, file)); } finally { fs.rmSync(file, { force: true }); }
  };
  assert.deepEqual(probe("import { a } from 'b';\nexport function f() { a(); }\nlet x: number | null = null;\nexport const g = () => a();\n"), []);
  assert.equal(probe("import { app } from 'electron';\napp.getPath('userData');\n").length, 1);
  assert.equal(probe("import { app } from 'electron';\nconst dir = app.getPath('userData');\n").length, 1);
  assert.equal(probe("import './x';\n").length, 1);
  assert.equal(probe('let n = 0;\nn++;\n').length, 1);
});

// ---- only the guard imports ipcMain -------------------------------------------------------------------------------------------

/** The window modules that own their own channels (reply bubbles, single emoji, pose sensor, Unbound) and the guard. */
const IPC_MAIN_ALLOWED = ['electron/wiring/ipc-wiring.ts', 'electron/brain/reply-window.ts', 'electron/stage/single-emoji-window.ts',
  'electron/senses/pose/sensor-window.ts', 'electron/unbound/electron-host.ts', 'electron/unbound/input-window.ts', 'electron/unbound/card-window.ts',
  'electron/stage/physics-lab-window.ts']; // R01 物理调参台: its own physics-lab: channels, answered only for its own main frame

function ipcMainImporters(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(?:ts|mts)$/.test(e.name)) {
        const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        for (const st of sf.statements) {
          const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
          if (spec !== 'electron') continue;
          const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : ts.isExportDeclaration(st) ? st.exportClause : undefined;
          const names = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements.map(el => (el.propertyName ?? el.name).text) : ['*'];
          if (names.includes('ipcMain') || names.includes('*')) out.push(rel);
        }
      }
    }
  };
  walk('electron');
  return [...new Set(out)].sort();
}

test('only electron/wiring/ipc-wiring.ts (and the window modules with their own channels) import ipcMain', () => {
  assert.deepEqual(ipcMainImporters().filter(f => !IPC_MAIN_ALLOWED.includes(f)), []);
  assert.ok(ipcMainImporters().includes('electron/wiring/ipc-wiring.ts'));
  assert.ok(!ipcMainImporters().includes('electron/main.ts'), 'electron/main.ts takes the guard from electron/wiring/ipc-wiring.ts');
});

// ---- the shared predicates are word-for-word copies -----------------------------------------------------------------------

test('AppPorts predicates are the old inline expressions word for word (still found where they were)', () => {
  const ports = read('electron/wiring/ports-wiring.ts');
  const sf = ts.createSourceFile('ports-wiring.ts', ports, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const others = [read('electron/main.ts'), ...wiringFiles().filter(f => !f.endsWith('ports-wiring.ts')).map(read)].join('\n');
  const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
  const returned: Record<string, string> = {};
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && ts.isArrowFunction(n.initializer) && ts.isBlock(n.initializer.body)) {
      const ret = n.initializer.body.statements.find(ts.isReturnStatement);
      if (ret?.expression) returned[n.name.text] = squash(ret.expression.getText(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const expected = ['chatBusy', 'petVisible', 'petSender', 'herOnScreen', 'feedingFree', 'keepsakeCalm', 'specialDayCalm', 'noteUserBusy'];
  assert.deepEqual(Object.keys(returned).sort(), [...expected].sort());
  for (const [name, expr] of Object.entries(returned)) assert.ok(squash(others).includes(expr), `${name}: "${expr}" is no longer word for word what the wiring has inline`);
  // the sense router's `free` is the pure senseLineFree now (2026-11-21, herOnScreen): feeding stays the companion window's own and does not wait for typing
  assert.ok(!returned.feedingFree.includes('userInputUntil'));
});

// ---- the part runner, strict ----------------------------------------------------------------------------------------------------

test('part runner, strict: start failure rejects (the old fatal path), ticks and callbacks are untouched, nothing is switched off', async () => {
  const runner = createPartRunner({ mode: 'strict' });
  const order: string[] = [];
  const part = (id: string, start?: () => Promise<void> | void): PartHandle => ({ id, units: [id], early: () => { order.push(`early ${id}`); }, start, provides: {} });
  runner.early(part('cards'));
  await runner.start(part('cards', async () => { order.push('start cards'); }));
  const boom = new Error('cards store unreadable');
  await assert.rejects(runner.start(part('actions', () => { throw boom; })), error => error === boom);
  await assert.rejects(runner.start(part('settings', async () => { throw boom; })), error => error === boom);
  assert.throws(() => runner.tick(part('mood'), 'clock', () => { throw boom; }), error => error === boom);
  assert.equal(runner.tick(part('mood'), 'clock', () => 7), 7);
  const fn = (a: number) => a + 1;
  assert.equal(runner.callback(part('mood'), 'cb', fn), fn);
  assert.deepEqual(order, ['early cards', 'start cards']);
  assert.deepEqual(runner.health(), { mode: 'strict', started: ['cards'], off: [] });
  assert.throws(() => createPartRunner({ mode: 'loose' as never }), /not known/); // isolate: tests/part-runner.test.ts (step 7)
});

// ---- the clock -------------------------------------------------------------------------------------------------------------------

function clockWorld(scope: string) {
  const calls: string[] = [];
  const note = (name: string) => () => { calls.push(name); };
  const view = { snapshot: { cue: null, phase: 'idle' }, expressions: true };
  const s: ClockScope = {
    diaryWriter: { tick: note('diary') }, reviewWriter: { tick: note('review') }, herNote: { writer: { tick: note('herNote') } } as never,
    syncFatigueActivity: note('fatigue'), screenGlance: { watchTick: note('glance') },
    userActivity: { tick: note('activity'), presence: () => ({ presence: 'here' }) } as never,
    innerLoopHost: { opening: { tick: note('opening') }, loop: { sweep: note('sweep') } } as never, impulse: { tick: note('impulse') },
    companion: { mood: { moments: { presence: note('presence') }, tick: note('mood.tick'), get: () => view }, herLifeTick: note('herLife'), stageMoods: { tick: note('stageMoods') } } as never,
    faceCheck: { host: { notePresence: note('face') } } as never,
    refreshVisionContext: () => { calls.push('vision'); return scope; }, companionCanExpress: () => true, proactiveVisionEnabled: false,
    media: { state: { screenSharing: false }, sharesCameraFrames: () => false } as never, fatigueActivity: { current: () => ({}) as never },
    ambientComments: null, ambientAudio: null, readingActive: () => false, rps: { host: { sweep: note('rps') } } as never,
    moodCueOwner: null, proactiveVision: { start: async () => { calls.push('look'); } } as never, visionEligible: () => true,
  };
  return { calls, s };
}

test('the 1-second clock: entries in the old order; without a scope it stops after the sweep (`if (!scope) return`)', () => {
  const head = ['diary', 'review', 'herNote', 'fatigue', 'glance', 'activity', 'opening', 'impulse', 'presence', 'face', 'vision', 'sweep'];
  const off = clockWorld('');
  clockTick(off.s);
  assert.deepEqual(off.calls, head);
  const on = clockWorld('scope-1');
  clockTick(on.s);
  assert.deepEqual(on.calls, [...head, 'mood.tick', 'herLife', 'stageMoods', 'rps']);
});

// ---- secureWindow's dispatch ------------------------------------------------------------------------------------------------

test('secureWindow: owner from the pet window, then every subscriber in order', () => {
  const pet = { webContents: { id: 2 } }, controls = { webContents: { id: 1 } };
  let shellPet: unknown = pet;
  const lifecycle = loadWithElectron('electron/wiring/lifecycle-wiring.ts', { electron: {}, './shell-wiring': { petWindow: () => shellPet } });
  const seen: string[] = [];
  lifecycle.wireLifecycle([(win: typeof pet, owner: string, id: number) => seen.push(`a ${owner} ${id} ${win === pet}`), (_win: unknown, owner: string) => seen.push(`b ${owner}`)]);
  lifecycle.secureWindow(pet);
  lifecycle.secureWindow(controls);
  shellPet = null; // before the companion exists every window is 'controls'
  lifecycle.secureWindow(pet);
  assert.deepEqual(seen, ['a pet 2 true', 'b pet', 'a controls 1 false', 'b controls', 'a controls 2 true', 'b controls']);
});
