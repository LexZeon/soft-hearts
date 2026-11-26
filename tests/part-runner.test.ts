// The part runner in isolate mode (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan docs/claude/2026-11-16-wiring-rewrite-plan.md
// section 3): a unit that is not core is switched off alone when its start throws, or when its ticks / callbacks throw 3 times in a row;
// a core unit (and anything the runner was not told about) stays fatal; the reason keeps a category and error.name, never the message;
// a switched-off unit's desk: handlers answer PART_OFF after the guard; strict mode changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { PART_FAILURES_TO_OFF, PART_OFF, createPartRunner, failPartRequest, failureName, stepAs, stepUnitOf, unitSteps, useRunner, type PartDeclaration, type PartOffEntry } from '../electron/wiring/parts-wiring';
import { clockTick, type ClockScope } from '../electron/wiring/clock-wiring';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SENSES: PartDeclaration = { id: 'senses', units: ['face-check', 'pose-sensing', 'user-activity'], ipc: { 'face-check': ['getFaceCheck', 'setFaceCheck'] } };
const STAGE: PartDeclaration = { id: 'stage', units: ['pet-window', 'single-emoji'], core: ['pet-window'] };
const secret = () => new TypeError('C:\\Users\\someone\\private\\file.txt could not be read: 你好');

function isolate(extra: Partial<Parameters<typeof createPartRunner>[0]> = {}) {
  const offs: PartOffEntry[] = [], lines: string[] = [];
  const runner = createPartRunner({ mode: 'isolate', onOff: entry => offs.push(entry), log: line => lines.push(line), now: () => 1234, ...extra });
  runner.add(SENSES); runner.add(STAGE);
  return { runner, offs, lines };
}

test('isolate: a start that throws switches that unit off alone; the reason is the category and error.name, never the message', async () => {
  const { runner, offs, lines } = isolate();
  assert.equal(await runner.startUnit('senses', 'face-check', async () => { throw secret(); }), undefined);
  assert.equal(runner.startUnitSync('senses', 'pose-sensing', () => 'pose'), 'pose');
  assert.equal(await runner.startUnit('senses', 'user-activity', async () => 7), 7);
  assert.ok(runner.isOff('senses', 'face-check'));
  assert.ok(!runner.isOff('senses', 'pose-sensing') && !runner.isOff('senses', 'user-activity'));
  assert.deepEqual(offs, [{ part: 'senses', unit: 'face-check', category: 'start', when: 'start', reason: 'start:TypeError', at: 1234 }]);
  assert.deepEqual(runner.health().off, offs);
  const everything = JSON.stringify({ offs, lines, health: runner.health() });
  assert.ok(!everything.includes('private') && !everything.includes('你好') && !everything.includes('could not'), 'no message reaches the reason, the log line or the view');
  // a synchronous start that throws too
  runner.startUnitSync('stage', 'single-emoji', () => { throw new RangeError('x'); });
  assert.equal(runner.health().off.at(-1)?.reason, 'start:RangeError');
});

test('isolate: core units, and units or parts the runner was not told about, stay fatal exactly as before', async () => {
  const { runner, offs } = isolate();
  const boom = new Error('pet window');
  await assert.rejects(runner.startUnit('stage', 'pet-window', async () => { throw boom; }), error => error === boom);
  assert.throws(() => runner.startUnitSync('stage', 'pet-window', () => { throw boom; }), error => error === boom);
  await assert.rejects(runner.startUnit('stage', 'not-declared', async () => { throw boom; }), error => error === boom);
  await assert.rejects(runner.startUnit('brain', 'companion', async () => { throw boom; }), error => error === boom);
  assert.throws(() => runner.tick('stage', 'pet-window', () => { throw boom; }), error => error === boom);
  assert.throws(() => runner.callback('brain', 'companion', () => { throw boom; })(), error => error === boom);
  assert.throws(() => runner.cleanup('stage', 'pet-window', () => { throw boom; })(), error => error === boom);
  assert.deepEqual(offs, []);
});

test(`isolate: a tick or callback is switched off after ${PART_FAILURES_TO_OFF} throws in a row; a success in between starts again; while off it is skipped`, () => {
  const { runner, offs } = isolate();
  let runs = 0, fail = true;
  const tick = () => runner.tick('senses', 'user-activity', () => { runs++; if (fail) throw new Error('tick'); return 'ran'; });
  assert.equal(tick(), undefined); assert.equal(tick(), undefined);
  fail = false; assert.equal(tick(), 'ran');
  fail = true; assert.equal(tick(), undefined); assert.equal(tick(), undefined);
  assert.ok(!runner.isOff('senses', 'user-activity'), 'two in a row after a success: still on');
  assert.equal(tick(), undefined);
  assert.ok(runner.isOff('senses', 'user-activity'));
  assert.equal(offs.at(-1)?.reason, 'tick:Error');
  assert.equal(offs.at(-1)?.when, 'running');
  const before = runs; fail = false;
  assert.equal(tick(), undefined, 'skipped while off');
  assert.equal(runs, before);
  // callbacks count the same way, separately per unit
  let cb = 0;
  const wrapped = runner.callback('senses', 'pose-sensing', (n: number) => { cb++; if (n < 0) throw new SyntaxError('cb'); return n * 2; });
  assert.equal(wrapped(2), 4);
  for (let i = 0; i < PART_FAILURES_TO_OFF; i++) assert.equal(wrapped(-1), undefined);
  assert.ok(runner.isOff('senses', 'pose-sensing'));
  assert.equal(offs.at(-1)?.reason, 'callback:SyntaxError');
  assert.equal(wrapped(5), undefined);
  assert.equal(cb, 1 + PART_FAILURES_TO_OFF);
  assert.equal(offs.length, 2, 'each unit is reported once');
});

test('isolate: a cleanup step always runs, even while its unit is off; its throw is caught so the next step runs', () => {
  const { runner } = isolate();
  runner.startUnitSync('senses', 'face-check', () => { throw new Error('start'); });
  const done: string[] = [];
  const step = runner.cleanup('senses', 'face-check', (what: string) => { done.push(what); if (what === 'bad') throw new Error('x'); });
  step('release camera');
  step('bad');
  done.push('next step');
  assert.deepEqual(done, ['release camera', 'bad', 'next step']);
});

test('strict: nothing is caught, counted, skipped or switched off; a callback is the same function', async () => {
  const runner = createPartRunner({ mode: 'strict' });
  runner.add(SENSES);
  const boom = new Error('x');
  await assert.rejects(runner.startUnit('senses', 'face-check', async () => { throw boom; }), error => error === boom);
  assert.throws(() => runner.startUnitSync('senses', 'face-check', () => { throw boom; }), error => error === boom);
  for (let i = 0; i < 5; i++) assert.throws(() => runner.tick('senses', 'face-check', () => { throw boom; }), error => error === boom);
  const fn = (a: number) => a + 1;
  assert.equal(runner.callback('senses', 'face-check', fn), fn);
  assert.equal(runner.cleanup('senses', 'face-check', fn), fn);
  assert.deepEqual(runner.health().off, []);
  assert.equal(runner.isOff('senses', 'face-check'), false);
});

test('health: listeners hear each change; firstOff finds an off unit among many; unitOf maps a handler to its unit', () => {
  const { runner } = isolate();
  const views: number[] = [];
  const stop = runner.onHealth(view => views.push(view.off.length));
  runner.startUnitSync('senses', 'face-check', () => { throw new Error('x'); });
  stop();
  runner.startUnitSync('stage', 'single-emoji', () => { throw new Error('x'); });
  assert.deepEqual(views, [1]);
  assert.equal(runner.firstOff([{ part: 'senses', unit: 'pose-sensing' }, { part: 'stage', unit: 'single-emoji' }])?.unit, 'single-emoji');
  assert.equal(runner.firstOff([{ part: 'senses', unit: 'pose-sensing' }]), null);
  assert.equal(runner.unitOf('senses', 'setFaceCheck'), 'face-check');
  assert.equal(runner.unitOf('senses', 'getPoseSensing'), null);
  assert.equal(runner.unitOf('stage', 'getFaceCheck'), null);
});

test('failureName keeps a plain identifier only', () => {
  assert.equal(failureName(new TypeError('m')), 'TypeError');
  const odd = new Error('m'); odd.name = 'C:\\path with spaces';
  assert.equal(failureName(odd), 'Error');
  assert.equal(failureName('a string'), 'NonError');
  assert.equal(failureName(null), 'NonError');
});

test('SOFT_HEARTS_FAIL_PART: honoured only unpackaged, in a profile inside the temporary folder, for a unit that can be switched off', async () => {
  const temp = os.tmpdir();
  const inTemp = path.join(temp, 'soft-hearts-test', 'profile');
  assert.deepEqual(failPartRequest({ SOFT_HEARTS_FAIL_PART: 'senses:face-check' }, { packaged: false, profile: inTemp, temp }), { part: 'senses', unit: 'face-check' });
  assert.equal(failPartRequest({ SOFT_HEARTS_FAIL_PART: 'senses:face-check' }, { packaged: true, profile: inTemp, temp }), null);
  assert.equal(failPartRequest({ SOFT_HEARTS_FAIL_PART: 'senses:face-check' }, { packaged: false, profile: path.join(os.homedir(), 'AppData', 'Roaming', 'soft-hearts-claude-dev'), temp }), null);
  assert.equal(failPartRequest({ SOFT_HEARTS_FAIL_PART: 'senses:face-check' }, { packaged: false, profile: temp, temp }), null, 'the temporary folder itself is not a profile in it');
  assert.equal(failPartRequest({ SOFT_HEARTS_FAIL_PART: 'senses face-check' }, { packaged: false, profile: inTemp, temp }), null);
  assert.equal(failPartRequest({}, { packaged: false, profile: inTemp, temp }), null);
  // the runner: the injected unit's first start throws once; a core unit is never injected
  const offs: PartOffEntry[] = [];
  const runner = createPartRunner({ mode: 'isolate', inject: { part: 'senses', unit: 'face-check' }, onOff: entry => offs.push(entry) });
  runner.add(SENSES);
  let ran = false;
  await runner.startUnit('senses', 'face-check', async () => { ran = true; });
  assert.equal(ran, false);
  assert.deepEqual(offs.map(entry => entry.reason), ['start:InjectedPartFailure']);
  const core = createPartRunner({ mode: 'isolate', inject: { part: 'stage', unit: 'pet-window' } });
  core.add(STAGE);
  assert.equal(core.startUnitSync('stage', 'pet-window', () => 'ran'), 'ran');
  // Step 8: the windows load while the parts start, so the unit's callbacks may run before its start: the injected failure waits for the
  // start (a unit broken from its start is off for `start`), or for the end of the starts when the unit has none.
  const early: PartOffEntry[] = [];
  const before = createPartRunner({ mode: 'isolate', inject: { part: 'senses', unit: 'face-check' }, onOff: entry => early.push(entry) });
  before.add(SENSES);
  let called = 0;
  const callback = before.callback('senses', 'face-check', () => { called++; });
  callback(); callback(); callback();
  assert.equal(called, 3, 'before its start, its callbacks run as they are');
  assert.equal(early.length, 0);
  await before.startUnit('senses', 'face-check', async () => undefined);
  assert.deepEqual(early.map(entry => entry.reason), ['start:InjectedPartFailure']);
  const noStart = createPartRunner({ mode: 'isolate', inject: { part: 'senses', unit: 'face-check' }, onOff: entry => early.push(entry) });
  noStart.add(SENSES);
  const tick = () => noStart.tick('senses', 'face-check', () => 'ticked');
  assert.equal(tick(), 'ticked');
  noStart.startsDone();
  tick(); tick(); tick();
  assert.deepEqual(early.map(entry => entry.reason), ['start:InjectedPartFailure', 'tick:InjectedPartFailure'], 'with no start, its third tick after the starts switches it off');
});

// ---- partIpc: a switched-off unit's handlers answer PART_OFF, after the guard ------------------------------------------------------

type Handler = (event: unknown, ...args: unknown[]) => unknown;
/** electron/wiring/ipc-wiring.ts and the parts-wiring.ts it uses, loaded once with a fake ipcMain (one module instance each). */
function ipcWorld() {
  const handlers = new Map<string, Handler>();
  const fakes: Record<string, unknown> = { electron: { ipcMain: { handle(channel: string, handler: Handler) { handlers.set(channel, handler); } } } };
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
  const ipc = load(path.join(ROOT, 'electron/wiring/ipc-wiring.ts'));
  const parts = load(path.join(ROOT, 'electron/wiring/parts-wiring.ts'));
  const window = (id: number) => { const mainFrame = { id }; return { webContents: { id, mainFrame } }; };
  const controls = window(1), pet = window(2), stranger = window(3);
  ipc.wireIpc({ windows: () => [controls, pet], controls: () => controls });
  const call = (method: string, win = controls, ...args: unknown[]) => handlers.get(`desk:${method}`)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);
  return { ipc, parts, call, controls, pet, stranger };
}

test('partIpc: a switched-off unit answers PART_OFF (the guard still refuses strangers first); other handlers and other parts answer as before', () => {
  const w = ipcWorld();
  const runner = w.parts.createPartRunner({ mode: 'isolate' });
  runner.add(SENSES);
  w.parts.useRunner(runner);
  const senses = w.ipc.partIpc('senses'), stage = w.ipc.partIpc('stage');
  const ran: string[] = [];
  senses.host('getFaceCheck', () => { ran.push('get'); return 'view'; });
  senses.scopedHost('setFaceCheck', (sender: number, on: unknown) => { ran.push(`set ${sender} ${on}`); return on; }, false);
  senses.host('getPoseSensing', () => 'pose');
  stage.host('getFaceCheck2', () => 'stage');
  assert.equal(w.call('getFaceCheck'), 'view');
  assert.equal(w.call('setFaceCheck', w.pet, true), true);
  runner.startUnitSync('senses', 'face-check', () => { throw new Error('x'); });
  assert.throws(() => w.call('getFaceCheck'), (error: Error) => error.name === 'PartOffError' && error.message.startsWith(PART_OFF) && /senses\/face-check/.test(error.message));
  assert.throws(() => w.call('setFaceCheck', w.pet, false), /PART_OFF/);
  assert.throws(() => w.call('getFaceCheck', w.stranger), /请求来源未授权/, 'the guard answers before PART_OFF');
  assert.equal(w.call('getPoseSensing'), 'pose', 'a handler of no unit is answered');
  assert.equal(w.call('getFaceCheck2'), 'stage', 'another part is answered');
  assert.deepEqual(ran, ['get', 'set 2 true'], 'a refused call never reached its operation');
  w.parts.useRunner(null);
  assert.equal(w.call('getFaceCheck'), 'view', 'without a runner (strict, tests) nothing is refused');
});

// ---- the clock and the step lists, with the app's runner in isolate mode ----------------------------------------------------------

function clockScope(throwing: string | null) {
  const calls: string[] = [];
  const note = (name: string) => () => { calls.push(name); if (name === throwing) throw new TypeError(`${name} broke`); };
  const view = { snapshot: { cue: null, phase: 'idle' }, expressions: true };
  const s: ClockScope = {
    diaryWriter: { tick: note('diary') }, reviewWriter: { tick: note('review') }, herNote: { writer: { tick: note('herNote') } } as never,
    syncFatigueActivity: note('fatigue'), screenGlance: { watchTick: note('glance') },
    userActivity: { tick: note('activity'), presence: () => ({ presence: 'here' }) } as never,
    innerLoopHost: { opening: { tick: note('opening') }, loop: { sweep: note('sweep') } } as never, impulse: { tick: note('impulse') },
    companion: { mood: { moments: { presence: note('presence') }, tick: note('mood.tick'), get: () => view }, herLifeTick: note('herLife'), stageMoods: { tick: note('stageMoods') } } as never,
    faceCheck: { host: { notePresence: note('face') } } as never,
    refreshVisionContext: () => { calls.push('vision'); return 'scope-1'; }, companionCanExpress: () => true, proactiveVisionEnabled: false,
    media: { state: { screenSharing: false }, sharesCameraFrames: () => false } as never, fatigueActivity: { current: () => ({}) as never },
    ambientComments: null, ambientAudio: null, readingActive: () => false, rps: { host: { sweep: note('rps') } } as never,
    moodCueOwner: null, proactiveVision: { start: async () => { calls.push('look'); } } as never, visionEligible: () => true,
  };
  return { calls, s };
}
const ALL_TICK = ['diary', 'review', 'herNote', 'fatigue', 'glance', 'activity', 'opening', 'impulse', 'presence', 'face', 'vision', 'sweep', 'mood.tick', 'herLife', 'stageMoods', 'rps'];
const CLOCK_PARTS: PartDeclaration[] = [{ id: 'memory', units: ['diary', 'period-review', 'her-note'] }, { id: 'mood', units: ['fatigue-activity'] },
  { id: 'senses', units: ['screen-glance', 'user-activity', 'face-check', 'proactive-vision'] }, { id: 'initiative', units: ['inner-loop', 'impulse', 'rps'] }];

test('the clock, isolate: a throwing entry no longer stops the entries after it; after three it is switched off and skipped, the rest unchanged', () => {
  const offs: PartOffEntry[] = [];
  const runner = createPartRunner({ mode: 'isolate', onOff: entry => offs.push(entry) });
  for (const part of CLOCK_PARTS) runner.add(part);
  useRunner(runner);
  try {
    for (let second = 1; second <= 3; second++) {
      const tick = clockScope('review');
      clockTick(tick.s);
      assert.deepEqual(tick.calls, ALL_TICK, `second ${second}: every entry ran, in order`);
    }
    assert.deepEqual(offs.map(entry => `${entry.part}/${entry.unit} ${entry.reason}`), ['memory/period-review tick:TypeError']);
    const after = clockScope(null);
    clockTick(after.s);
    assert.deepEqual(after.calls, ALL_TICK.filter(name => name !== 'review'), 'the switched-off entry is skipped; the order of the rest is the same');
    // a core entry (her mood) still fails as before: it throws out of the tick
    assert.throws(() => clockTick(clockScope('mood.tick').s), /mood\.tick broke/);
  } finally { useRunner(null); }
});

test('the clock, strict (the rewrite\'s mode): a throwing entry throws out of the tick as before', () => {
  const runner = createPartRunner({ mode: 'strict' });
  for (const part of CLOCK_PARTS) runner.add(part);
  useRunner(runner);
  try {
    const tick = clockScope('review');
    assert.throws(() => clockTick(tick.s), /review broke/);
    assert.deepEqual(tick.calls, ['diary', 'review']);
  } finally { useRunner(null); }
});

test('a list step: as a cleanup it always runs and a throw or a rejected promise lets the next one run; as a callback it is skipped while off', async () => {
  const offs: PartOffEntry[] = [];
  const runner = createPartRunner({ mode: 'isolate', onOff: entry => offs.push(entry) });
  runner.add({ id: 'senses', units: ['media'] });
  runner.add({ id: 'mood', units: ['mood-judge'] });
  useRunner(runner);
  try {
    const done: string[] = [];
    const revoke = () => { done.push('revoke'); throw new Error('x'); };
    const flush = async () => { done.push('flush'); throw new Error('y'); };
    const trunk = () => { done.push('trunk'); };
    unitSteps('senses', 'media', revoke, flush);
    const steps = [stepAs(revoke, 'cleanup'), stepAs(trunk, 'cleanup')];
    for (let i = 0; i < 4; i++) for (const step of steps) step();
    assert.equal(done.filter(d => d === 'revoke').length, 4, 'a cleanup runs even after its unit was switched off');
    assert.equal(done.filter(d => d === 'trunk').length, 4);
    assert.ok(runner.isOff('senses', 'media'));
    assert.equal(await stepAs(flush, 'cleanup')(), undefined, 'a rejected flush resolves: the next flush runs');
    assert.equal(stepUnitOf(trunk), null);
    // a callback: skipped while off
    let judged = 0;
    const judge = () => { judged++; throw new Error('judge'); };
    unitSteps('mood', 'mood-judge', judge);
    const wrapped = stepAs(judge, 'callback');
    for (let i = 0; i < 5; i++) wrapped();
    assert.equal(judged, 3);
    // a step of no unit runs as it is: its throw is the caller's, as before
    assert.throws(() => stepAs(() => { throw new Error('as before'); }, 'cleanup')(), /as before/);
  } finally { useRunner(null); }
});
