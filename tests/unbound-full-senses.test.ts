/**
 * I-154 follow-up, batches D and F (docs/claude/2026-11-21-unbound-full-D.md): her senses out in full-screen Unbound. The privacy shape: only
 * what the companion window already gets (where pose says you are, the music samples), only to the window she is shown in, only while each
 * source is on, stopped at once when it turns off ("别看" included), never a frame or a sound; her facts back once (the companion window's are
 * not taken while she is out). Then the page side: the reading and the samples reach her layers and go away at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PerspectiveCamera } from 'three';
import { HER_FACT_KINDS, UNBOUND_SENSE_EVENTS, danceSources, isHerFactKind, companionFactAllowed } from '../shared/unbound/sense-relay';
import { UNBOUND_REQUESTS } from '../shared/unbound/scene';
import { SENSE_RELAY, UnboundSenseBridge } from '../electron/unbound/sense-bridge';
import { UnboundMoodBridge } from '../electron/unbound/mood-bridge';
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import type { PetPort as HomePort } from '../electron/unbound/mode'; // no-pet-ok: the host's port name for the companion window
import { unboundSource } from '../electron/unbound/source';
import { createUnboundApi, UNBOUND_API_KEYS, type UnboundIpc } from '../electron/unbound/preload-api';
import { UNBOUND_SENSE_API_KEYS } from '../electron/unbound/sense-preload-api';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import { HerOutGaze, composeLook, lookToward, screenPointM } from '../src/unbound/her/out-gaze';
import { DANCE_FRESH_MS, HerOutSenses, outMusicEnv, showBlockedBy } from '../src/unbound/her/out-senses';
import { musicYieldReason } from '../src/unbound/window-mode/window-music';
import { MUSIC_STALL_GRACE_MS } from '../src/senses/music-hearing';
import { fullMotionEnv } from '../src/unbound/her/out-motions';
import { NO_MOTION_BLOCKS } from '../src/unbound/window-mode/window-face-rig';
import { UNITS_PER_M } from '../src/unbound/figure';
import { songSample } from './helpers/frame-stats';

const READING = Object.freeze({ present: true, facing: 'toward', energy: 0.2, point: Object.freeze({ x: 0.3, y: 0.1, dx: 1.5, dy: 2.4 }), screen: null });
const frameOf = (source: 'system-audio' | 'microphone', time: number, sample: Record<string, number> | null = { time, rms: 0.3, low: 0.4, mid: 0.2, high: 0.1 }) =>
  ({ id: `cap-${source}`, source, revision: 1, sample });
const OWNER = 'pet'; // no-pet-ok: the capture host's owner name for the companion window (shared/senses/audio-capture.ts)
const capture = (dance: { system?: boolean; mic?: boolean }) => ({ revision: 3, slots: {
  'system-audio': dance.system === undefined ? null : { id: 'cap-system-audio', owner: OWNER, revision: 1, dance: dance.system },
  microphone: dance.mic === undefined ? null : { id: 'cap-microphone', owner: OWNER, revision: 1, dance: dance.mic } } });

// ---- the shared rules ----------------------------------------------------------------------------------------------------------------
test('rules: her fact kinds are closed; while she is out the companion window\'s facts of these kinds are not taken; dance sources from the capture state', () => {
  assert.deepEqual([...HER_FACT_KINDS], ['gaze', 'music-reaction', 'music-verdict', 'music-tier', 'stage-state']);
  assert.equal(isHerFactKind('launch'), false); assert.equal(isHerFactKind('gaze'), true);
  for (const kind of HER_FACT_KINDS) { assert.equal(companionFactAllowed(kind, true), false, `${kind} out`); assert.equal(companionFactAllowed(kind, false), true, `${kind} home`); }
  assert.equal(companionFactAllowed('blush-stage', true), true, 'other facts still come from the companion window');
  assert.deepEqual([...danceSources(capture({ system: true, mic: false }))], ['system-audio']);
  assert.deepEqual([...danceSources(capture({ system: false }))], []);
  assert.deepEqual([...danceSources(null)], []);
  assert.deepEqual([...danceSources({ slots: { 'system-audio': { dance: 'yes' } } })], [], 'only a real true');
});

// ---- the bridge alone ----------------------------------------------------------------------------------------------------------------
function bridge() {
  const state = { shown: null as string | null, poseOn: false, sent: [] as [string, string, unknown][], facts: [] as [string, unknown][] };
  const b = new UnboundSenseBridge<string>(() => ({ poseSensing: () => state.poseOn, fact: (kind, value) => { state.facts.push([kind, value]); return true; } }),
    { shown: () => state.shown, send: (win, channel, value) => state.sent.push([win, channel, value]) });
  return { b, state };
}

test('sense bridge: where pose says you are goes only while pose sensing runs, only to the window she is shown in, checked; off sends one null at once', () => {
  const { b, state } = bridge();
  b.relay(SENSE_RELAY.userGaze, READING);
  assert.equal(state.sent.length, 0, 'not shown: nothing');
  state.shown = 'w1';
  b.relay(SENSE_RELAY.userGaze, READING);
  assert.equal(state.sent.length, 0, 'pose sensing off: nothing of the camera goes out');
  state.poseOn = true;
  b.relay(SENSE_RELAY.userGaze, { ...READING, frame: 'data:image/jpeg;base64,AAAA', face: { x: 0.5, y: 0.4 } });
  assert.equal(state.sent.length, 1);
  const [win, channel, value] = state.sent[0];
  assert.equal(win, 'w1'); assert.equal(channel, UNBOUND_SENSE_EVENTS.userGaze);
  assert.deepEqual(Object.keys(value as object).sort(), ['energy', 'facing', 'point', 'present', 'screen'], 'only the reading\'s own fields: never a frame or a face');
  b.relay(SENSE_RELAY.userGaze, { present: 'yes' });
  assert.equal(state.sent.length, 1, 'malformed: nothing');
  b.relay(SENSE_RELAY.userGaze, null);
  assert.deepEqual(state.sent.at(-1), ['w1', UNBOUND_SENSE_EVENTS.userGaze, null], 'nothing fresh: null');
  state.poseOn = false;
  const beforeOff = state.sent.length;
  b.relay(SENSE_RELAY.poseSensing, false);
  assert.equal(state.sent.length, beforeOff + 1, 'off: one more event, at once');
  assert.deepEqual(state.sent.at(-1), ['w1', UNBOUND_SENSE_EVENTS.userGaze, null], 'off: forget at once');
  const count = state.sent.length;
  b.relay(SENSE_RELAY.userGaze, READING);
  assert.equal(state.sent.length, count, 'after off, nothing more');
  state.shown = null; state.poseOn = true;
  b.relay(SENSE_RELAY.userGaze, READING);
  assert.equal(state.sent.length, count, 'she went home: nothing');
});

test('sense bridge: a music frame goes only while that source\'s dance is on, checked, only to her window; the last dance off sends one null', () => {
  const { b, state } = bridge();
  state.shown = 'w1';
  b.relay(SENSE_RELAY.dance, frameOf('system-audio', 1));
  assert.equal(state.sent.length, 0, 'no dance on: nothing');
  assert.equal(b.relay('desk:audio-capture-state', capture({ system: true, mic: false })), false, 'the capture state still goes to the companion windows');
  b.relay(SENSE_RELAY.dance, frameOf('microphone', 1));
  assert.equal(state.sent.length, 0, 'the microphone\'s dance is off');
  b.relay(SENSE_RELAY.dance, { ...frameOf('system-audio', 2), pcm: [1, 2, 3] });
  assert.equal(state.sent.length, 0, 'anything but the frame\'s own fields is refused');
  b.relay(SENSE_RELAY.dance, frameOf('system-audio', 2));
  assert.deepEqual(state.sent.at(-1), ['w1', UNBOUND_SENSE_EVENTS.dance, frameOf('system-audio', 2)]);
  b.relay(SENSE_RELAY.dance, frameOf('system-audio', 3, null));
  assert.equal(state.sent.length, 1, 'a failed analysis is not relayed (the capture state turns that dance off next)');
  b.relay('desk:audio-capture-state', capture({ system: false, mic: false }));
  assert.deepEqual(state.sent.at(-1), ['w1', UNBOUND_SENSE_EVENTS.dance, null], 'dance off: stop at once');
  b.relay(SENSE_RELAY.dance, frameOf('system-audio', 4));
  assert.equal(state.sent.length, 2, 'after off, nothing more');
});

test('sense bridge: her facts only of the closed kinds, only from the window she is shown in', () => {
  const { b, state } = bridge();
  const handlers = new Map<string, (win: string, ...args: unknown[]) => unknown>();
  b.register((channel, operation) => handlers.set(channel, operation));
  const fact = handlers.get(UNBOUND_REQUESTS.herFact)!;
  assert.equal(fact('w1', 'gaze', { kind: 'shy' }), false, 'not shown');
  state.shown = 'w1';
  assert.equal(fact('w2', 'gaze', { kind: 'shy' }), false, 'another window');
  assert.equal(fact('w1', 'launch', null), false, 'not one of hers');
  assert.equal(fact('w1', 'gaze', { kind: 'shy' }), true);
  assert.equal(fact('w1', 'music-tier', { tier: 'nod', score: 0.4 }), true);
  assert.deepEqual(state.facts, [['gaze', { kind: 'shy' }], ['music-tier', { tier: 'nod', score: 0.4 }]]);
});

test('mood bridge: a sense relay never goes on as a broadcast; 惊喜 / 害羞 previews only as the closed recipe', () => {
  const sent: [string, unknown][] = [], win = { isVisible: () => true };
  const mood = new UnboundMoodBridge(() => ({ get: () => ({}), interaction: () => ({}), senses: () => ({ poseSensing: () => true, fact: () => true }) }),
    { current: () => win, shown: () => win, touchable: () => true, send: (_w, channel, value) => sent.push([channel, value]) });
  mood.relay(SENSE_RELAY.poseSensing, true);
  mood.relay(SENSE_RELAY.userGaze, READING);
  assert.deepEqual(sent.map(([c]) => c), [UNBOUND_SENSE_EVENTS.userGaze]);
  mood.relay('desk:expression-preview', 'shy');
  mood.relay('desk:expression-preview', { recipe: 'shy', curve: [1] });
  mood.relay('desk:expression-preview', 'wink');
  assert.deepEqual(sent.slice(1), [[UNBOUND_SENSE_EVENTS.expressionPreview, 'shy']]);
});

// ---- the real host ------------------------------------------------------------------------------------------------------------------
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
class FakeHome implements HomePort {
  visible = true; bounds: Rect = { x: 1100, y: 330, width: 400, height: 560 };
  isDestroyed() { return false; } isVisible() { return this.visible; } isMinimized() { return false; }
  getBounds() { return { ...this.bounds }; } setBounds(bounds: Rect) { this.bounds = { ...bounds }; } hide() { this.visible = false; } showInactive() { this.visible = true; }
}
class FakeWindow implements UnboundWindowLike {
  readonly frame = {}; readonly sent: [string, unknown][] = []; visible = false; destroyed = false; private gone: (() => void)[] = [];
  readonly webContents = { id: 77, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push([channel, value]); }, isDestroyed: () => this.destroyed };
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible && !this.destroyed; } showInactive() { this.visible = true; } hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {} setBounds() {} onGone(callback: () => void) { this.gone.push(callback); }
  event(frame: unknown = this.frame): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: frame }; }
}
class FakeIpc {
  readonly handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: UnboundIpcEvent, ...args: unknown[]) => unknown) { this.handlers.set(channel, listener); }
  removeHandler(channel: string) { this.handlers.delete(channel); }
  async call(channel: string, event: UnboundIpcEvent, ...args: unknown[]) { return this.handlers.get(channel)!(event, ...args); }
}
const DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };

test('host: her senses reach only her shown window (not while she comes out), her facts only from its top frame; quitting removes the request', async () => {
  const ipc = new FakeIpc(), windows: FakeWindow[] = [], facts: [string, unknown][] = [], state = { poseOn: true };
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\m\\her.pmx', url: 'mmd-asset://token/her.pmx', name: 'her.pmx' } };
  const ports: UnboundHostPorts = {
    // no-pet-ok: the host's port names for the companion window
    ipcMain: ipc, pet: () => new FakeHome(), petWanted: () => true, developerMode: () => true, source: () => unboundSource(settings, null), reviewed: async () => true,
    display: () => DISPLAY, measure: async () => null, openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    restored: () => {}, publish: () => {}, readyTimeoutMs: 600_000, headTimeoutMs: 600_000,
    mood: { get: () => ({}), interaction: () => ({}), senses: () => ({ poseSensing: () => state.poseOn, fact: (kind, value) => { facts.push([kind, value]); return true; } }) },
  };
  const host = new UnboundHost(ports);
  try { // an assertion that fails still closes the host (no timers left behind)
  host.apply({ active: true }); await settle();
  const win = windows.at(-1)!;
  host.mood(SENSE_RELAY.userGaze, READING);
  assert.equal(win.sent.filter(([c]) => c === UNBOUND_SENSE_EVENTS.userGaze).length, 0, 'still coming out: nothing');
  assert.equal(await ipc.call(UNBOUND_REQUESTS.herFact, win.event(), 'gaze', { kind: 'shy' }), false, 'not shown yet');
  await ipc.call(UNBOUND_REQUESTS.getScene, win.event()); await ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true, modelHeightM: 1.6 }); await settle();
  host.mood(SENSE_RELAY.userGaze, READING);
  assert.deepEqual(win.sent.filter(([c]) => c === UNBOUND_SENSE_EVENTS.userGaze).map(([, v]) => v), [READING]);
  assert.equal(await ipc.call(UNBOUND_REQUESTS.herFact, win.event(), 'gaze', { kind: 'shy' }), true);
  await assert.rejects(ipc.call(UNBOUND_REQUESTS.herFact, win.event({}), 'gaze', { kind: 'shy' }), /未授权/, 'another frame');
  assert.deepEqual(facts, [['gaze', { kind: 'shy' }]]);
  } finally { host.exit(); host.quit(); }
  assert.equal(ipc.handlers.has(UNBOUND_REQUESTS.herFact), false, 'its request goes with the host');
});

// ---- the wiring --------------------------------------------------------------------------------------------------------------------
function sensesWiring(state: { out: boolean }) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'wiring', 'unbound-senses-wiring.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const relayed: [string, unknown][] = [], reads: unknown[] = [], shared: [string, unknown][] = [];
  const senseFeeds = { fact: () => false, tier: () => false, poseOn: false, held: false };
  const unbound = { get state() { return state.out ? 'unbound' : 'normal'; }, windowRect: () => ({ x: 0, y: 0, width: 1536, height: 912 }), mood: (c: string, v: unknown) => relayed.push([c, v]) };
  const stubs: Record<string, unknown> = {
    electron: { screen: { getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 960 } }) } },
    '../unbound': { SENSE_RELAY }, '../../shared/unbound': { companionFactAllowed }, './unbound-wiring': { senseFeeds, unbound, unboundStage: () => ({ relayAll: (c: string, v: unknown) => shared.push([c, v]) }) },
  };
  const module = { exports: {} as { relayPoseSensing(on: boolean): void; relayCameraHeld(held: boolean): void; relayUserGaze(read: (w: unknown, d: unknown) => unknown): void;
    relayDance(frame: unknown): void; companionFact(kind: unknown, fromCompanion: boolean): boolean; relayStageMusic(channel: string, value: unknown): void } };
  new Function('require', 'module', 'exports', js)((name: string) => { if (!(name in stubs)) throw new Error(`unexpected import ${name}`); return stubs[name]; }, module, module.exports);
  return { w: module.exports, relayed, reads, senseFeeds, shared };
}

test('wiring: the reading against her window only while she is out; "别看" counts as off at once; the companion window\'s facts of her kinds not while she is out', () => {
  const state = { out: false }, { w, relayed, senseFeeds, shared } = sensesWiring(state);
  w.relayPoseSensing(true);
  assert.equal(senseFeeds.poseOn, true);
  w.relayUserGaze(() => READING);
  assert.deepEqual(relayed, [[SENSE_RELAY.poseSensing, true]], 'at home: no reading for her full-screen window');
  state.out = true;
  let asked: unknown[] = [];
  w.relayUserGaze((win, display) => { asked = [win, display]; return READING; });
  assert.deepEqual(relayed.at(-1), [SENSE_RELAY.userGaze, READING]);
  assert.deepEqual(asked, [{ x: 0, y: 0, width: 1536, height: 912 }, { x: 0, y: 0, width: 1536, height: 960 }], 'measured against her Unbound window and its display');
  w.relayCameraHeld(true);
  assert.deepEqual(relayed.at(-1), [SENSE_RELAY.poseSensing, false], '"别看": off for her page at once');
  assert.equal(senseFeeds.held, true);
  w.relayCameraHeld(false);
  assert.deepEqual(relayed.at(-1), [SENSE_RELAY.poseSensing, true]);
  w.relayDance(frameOf('system-audio', 1));
  assert.deepEqual(relayed.at(-1), [SENSE_RELAY.dance, frameOf('system-audio', 1)]);
  // I-209 step 4 (perceive once): the same frame, which sources dance and the music settings reach the others on stage; nothing else does.
  assert.deepEqual(shared, [[SENSE_RELAY.dance, frameOf('system-audio', 1)]]);
  w.relayStageMusic('desk:audio-capture-state', { dance: [] }); w.relayStageMusic('desk:music-settings', { strength: 1 }); w.relayStageMusic('desk:mood', {}); w.relayStageMusic(SENSE_RELAY.userGaze, READING);
  assert.deepEqual(shared.map(([channel]) => channel), [SENSE_RELAY.dance, 'desk:audio-capture-state', 'desk:music-settings'], 'never her mood view, never where pose says you are');
  assert.equal(w.companionFact('gaze', true), false, 'out: her page tells it');
  assert.equal(w.companionFact('blush-stage', true), true);
  state.out = false;
  const before = relayed.length;
  w.relayDance(frameOf('system-audio', 2));
  assert.equal(relayed.length, before, 'at home: no frame for her full-screen window');
  assert.equal(w.companionFact('gaze', true), true, 'at home: the companion window tells it');
  assert.equal(w.companionFact('gaze', false), false, 'never from another window');
});

// ---- the preload --------------------------------------------------------------------------------------------------------------------
test('preload: the four sense members on fixed channels; events carry the value only', async () => {
  for (const key of UNBOUND_SENSE_API_KEYS) assert.ok((UNBOUND_API_KEYS as readonly string[]).includes(key), key);
  const invoked: [string, unknown[]][] = [], listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const ipc: UnboundIpc = { invoke: async (channel, ...args) => { invoked.push([channel, args]); return true; }, on: (channel, listener) => { listeners.set(channel, listener); }, removeListener: () => {} };
  const api = createUnboundApi(ipc), got: unknown[] = [];
  api.onUserGaze(v => got.push(['gaze', v])); api.onDance(v => got.push(['dance', v])); api.onExpressionPreview(v => got.push(['show', v]));
  listeners.get(UNBOUND_SENSE_EVENTS.userGaze)!({ sender: 'x' }, READING);
  listeners.get(UNBOUND_SENSE_EVENTS.dance)!({}, null);
  listeners.get(UNBOUND_SENSE_EVENTS.expressionPreview)!({}, 'shy');
  assert.deepEqual(got, [['gaze', READING], ['dance', null], ['show', 'shy']]);
  await api.herFact('gaze', { kind: 'shy' });
  assert.deepEqual(invoked, [[UNBOUND_REQUESTS.herFact, ['gaze', { kind: 'shy' }]]]);
  await assert.rejects(api.herFact(5 as never, null), /kind/);
});

// ---- the page ----------------------------------------------------------------------------------------------------------------------
function laptopCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(40, 1.6, 0.05 * UNITS_PER_M, 400 * UNITS_PER_M);
  camera.position.set(0, 1.2 * UNITS_PER_M, 0.6 * UNITS_PER_M); camera.updateMatrixWorld(true);
  return camera;
}

test('page gaze: a reading lives 3 s and goes at once on null; where you sit moves sideways on the screen plane; her look toward you is the full direction', () => {
  const gaze = new HerOutGaze(), camera = laptopCamera(), head = { x: 0, y: 1.5, z: -3 };
  gaze.set(READING);
  assert.equal(gaze.fresh, true);
  gaze.set({ ...READING, energy: 7 });
  assert.equal(gaze.fresh, false, 'malformed: dropped');
  gaze.set(READING); gaze.set(null);
  assert.equal(gaze.fresh, false, 'null: forgotten at once');
  gaze.set(READING);
  for (let i = 0; i < 200; i++) gaze.frame({ dt: 1 / 60, allowed: true, thinking: false, speaking: false, mood: null, head, heading: 0, camera });
  assert.equal(gaze.fresh, false, 'older than 3 s: not used');
  const centre = screenPointM({ x: 0, y: 0 }, camera)!, right = screenPointM({ x: 0.5, y: 0 }, camera)!;
  assert.ok(Math.abs(centre.x) < 1e-6 && Math.abs(centre.z) < 1e-9);
  assert.ok(right.x > 0.05, `half the window to the right is to the right on the screen plane (${right.x.toFixed(3)} m)`);
  const at = lookToward(head, { x: 0, y: 1.2, z: 0.6 }, 0);
  assert.ok(Math.abs(at.yaw) < 1e-9 && at.pitch > 0, 'facing you, below her head: straight, a little down');
  const side = lookToward(head, { x: 1, y: 1.5, z: 0.6 }, 0);
  assert.ok(side.yaw > 0.2, `you to her left (your right): yaw + (${side.yaw.toFixed(3)})`);
  const base = { yaw: 0.1, pitch: 0 }, toUser = { yaw: 0.4, pitch: 0.05 };
  assert.deepEqual(composeLook(base, { toUser, choice: null }), base, 'chooser not engaged: her own look exactly');
  assert.deepEqual(composeLook(base, { toUser, choice: { user: 1, mouse: 0, away: 0, awayX: 0, awayY: 0 } }), toUser);
  const half = composeLook(null, { toUser, choice: { user: 0.5, mouse: 0.5, away: 0, awayX: 0, awayY: 0 } })!;
  assert.ok(Math.abs(half.yaw - 0.2) < 1e-12, 'blended with where she faces');
});

test('page gaze: with you facing her she starts looking at you and says so once; sensing off lets go (a stop the host journals)', () => {
  const events: unknown[] = [], gaze = new HerOutGaze(e => events.push(e), () => 0.5), camera = laptopCamera(), head = { x: 0.8, y: 1.5, z: -3 };
  let engaged = 0;
  for (let i = 0; i < 60 * 8; i++) {
    if (i % 12 === 0) gaze.set(READING);
    const f = gaze.frame({ dt: 1 / 60, allowed: true, thinking: false, speaking: false, mood: null, head, heading: 0, camera })!;
    if (f.choice && f.choice.user > 0.5) engaged++;
  }
  assert.ok(engaged > 60, `she looks at you for a while (${engaged} frames)`);
  assert.deepEqual(events.filter(e => (e as { kind: string }).kind === 'start').length, 1, 'one start');
  gaze.set(null);
  for (let i = 0; i < 60 * 10; i++) gaze.frame({ dt: 1 / 60, allowed: true, thinking: false, speaking: false, mood: null, head, heading: 0, camera });
  assert.ok(events.some(e => (e as { kind: string; why?: string }).kind === 'stop' && (e as { why: string }).why === 'off'), 'sensing off: she stops looking at you');
});

const quietFace = { musicFace: () => null as never, hasSpeechFace: false };
test('page music: samples are heard only while frames come; the host\'s null stops it at once, a stall shorter than the grace does not (2026-11-22), longer silence does; her facts go back by kind', async () => {
  let now = 1000;
  const facts: [string, unknown][] = [], api = { herFact: async (kind: string, value: unknown) => { facts.push([kind, value]); return true; } } as never;
  const senses = new HerOutSenses(api, () => ({ usable: false, parts: [], missing: [], reason: '' }) as never, quietFace, () => {}, () => now);
  await new Promise(resolve => setTimeout(resolve, 50)); // the music code loads on demand
  const env = fullMotionEnv({ shown: true, adjusting: false, pulled: false, walking: false, contact: null, speaking: false, preparing: false, thinking: false, lidsHeld: 0, blink: 0,
    mouthOff: false, eyesOff: false }, null, NO_MOTION_BLOCKS);
  const input = { env, view: null, walking: false, base: null, game: false, proxy: null, yawn: null, sleepCue: () => null, gates: null, fullBody: true, cover: () => {} };
  senses.frame(1 / 60, input);
  assert.equal(senses.music.getState().hearing, false);
  senses.dance(frameOf('system-audio', 1)); senses.frame(1 / 60, input);
  assert.equal(senses.music.getState().hearing, true, 'a frame: she hears');
  senses.dance(null);
  assert.equal(senses.music.getState().hearing, false, 'the host\'s null: off at once');
  senses.dance(frameOf('system-audio', 2)); senses.frame(1 / 60, input);
  now += 400; senses.frame(1 / 60, input);
  assert.equal(senses.music.getState().hearing, true, 'a 400 ms stall (the host busy with a 一起看 frame): still hearing, the recognizer not reset');
  assert.equal(DANCE_FRESH_MS, MUSIC_STALL_GRACE_MS, 'the window\'s grace');
  now += DANCE_FRESH_MS + 1; senses.frame(1 / 60, input);
  assert.equal(senses.music.getState().hearing, false, 'silent past the grace: off');
  senses.dance({ ...frameOf('system-audio', 3), extra: 1 }); senses.frame(1 / 60, input);
  assert.equal(senses.music.getState().hearing, false, 'malformed: nothing');
  // A song for a few seconds: her verdict and tier go back to the host as her facts (the companion window's records, written once there).
  for (let i = 0; i < 30 * 8; i++) { now += 1000 / 30; const song = songSample(i); senses.dance(frameOf('system-audio', 10 + i / 30, { time: 10 + i / 30, rms: song.rms, low: song.low, mid: song.mid, high: song.high })); senses.frame(1 / 30, input); }
  await new Promise(resolve => setTimeout(resolve, 0));
  senses.dispose();
  assert.ok(facts.length > 0 && facts.every(([kind]) => ['music-reaction', 'music-tier', 'music-verdict', 'stage-state'].includes(kind)), `her music facts, by kind (${facts.map(([k]) => k).join(', ')})`);
});

test('page music: the dance yields to her walk and to a pull (a touch) as the window\'s owners; the show\'s own gate; the window never sets walking', () => {
  const base = { view: null, shown: true, speaking: false, adjusting: false, behaviorBlocked: false, touched: false, manualHead: false, asleep: false };
  assert.equal(musicYieldReason(base, true), null);
  assert.equal(musicYieldReason({ ...base, walking: true }, true), 'walking');
  assert.equal(musicYieldReason({ ...base, touched: true, walking: true }, true), 'direct-interaction', 'a touch is the window\'s and comes first');
  const state = { shown: true, adjusting: false, pulled: true, walking: true, contact: null, speaking: false, preparing: false, thinking: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false };
  const env = fullMotionEnv(state, null, NO_MOTION_BLOCKS);
  assert.equal(outMusicEnv(env, true).walking, true);
  assert.equal(outMusicEnv(env, true).touched, true, 'a pull is a touch');
  assert.equal(showBlockedBy(env), true, 'a pull holds the show');
  assert.equal(showBlockedBy(fullMotionEnv({ ...state, pulled: false }, null, NO_MOTION_BLOCKS)), false, 'her walk does not hold the show (upper body and head only)');
});
