/**
 * I-154 follow-up (docs/claude/2026-11-20-unbound-full-shares.md): full-screen Unbound gets the window's face and touches from one shared set.
 * Here the parts that are not the frame loop (that is tests/unbound-full-face-gene.test.ts):
 *  - the shared rules: her face's goals over an owner (the window's frame unchanged), the touch session's mood inputs;
 *  - the host's narrow mood bridge: the view only to her window, a touch's input only from the window she is shown in, while she can be
 *    touched (an ending always closes); the preload's three new members on fixed channels;
 *  - the touch input on the full-screen page end to end: a stroke on her scalp reaches a real mood host as the companion window's does,
 *    nothing is sent while the page says she cannot be touched, a pinch on her cheek owns the press.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { layFace } from '../src/unbound/her/face-goals';
import { HerOutFace, faceLook, glance } from '../src/unbound/her/out-face';
import { cardOf, heldUpdate, holdView } from '../src/unbound/her/model-card';
import { StageModelProfile } from '../src/stage/model-profile';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { HerOut, herTouchable } from '../src/unbound/her/out-page';
import { HerOutTouch } from '../src/unbound/her/out-touch';
import { MoodTouchSession, TOUCH_SESSION_TAIL_MS, type LocalMoodInput } from '../src/mood/touch-session';
import { REST_TARGETS } from '../src/unbound/motion/generator';
import { NEUTRAL_GAZE } from '../src/unbound/window-mode/window-face';
import { UnboundMoodBridge, isTouchEnding } from '../electron/unbound/mood-bridge';
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import type { PetPort as HomePort } from '../electron/unbound/mode'; // no-pet-ok: the host's port name for the companion window
import { unboundSource } from '../electron/unbound/source';
import { createUnboundApi, UNBOUND_API_KEYS, type UnboundIpc } from '../electron/unbound/preload-api';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS } from '../shared/unbound/scene';
import { MoodHost } from '../electron/mood/mood';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import type { PeekPorts } from '../electron/unbound/peek';
import type { MoodInput, MoodView } from '../shared/mood/mood-runtime';
import { CURIOUS } from './helpers/unbound-peek';

// ---- the shared rules --------------------------------------------------------------------------------------------------------------

const ZERO = { pitch: 0, yaw: 0, roll: 0 };
const faceGoals = (over: Partial<Parameters<typeof layFace>[1] & object> = {}) => ({ expr: { smileEyes: 0.4 }, exprNamed: { 'ウィンク': 0.2 },
  head: { pitch: 0.1, yaw: 0.05, roll: 0 }, torso: { pitch: 0, yaw: 0.02, roll: 0 }, hands: null, ...over });

test('her face over an owner: the window frame is what it was (no owner slots: the face\'s own object), and an owner keeps what is its own', () => {
  const owner = { ...REST_TARGETS };
  const face = faceGoals({ neck: { pitch: 0.03, yaw: 0, roll: 0 }, pelvis: { lateral: 0.01, forward: 0, vertical: 0 } });
  const laid = layFace(owner, face);
  assert.equal(laid.expr, face.expr, 'no owner slots: the face\'s object itself (WindowBody before the move)');
  assert.equal(laid.exprNamed, face.exprNamed);
  assert.deepEqual(laid.head, face.head); assert.deepEqual(laid.torso, face.torso); assert.deepEqual(laid.neck, face.neck);
  assert.deepEqual(laid.pelvis, face.pelvis);
  assert.equal(laid.eyes, REST_TARGETS.eyes, 'the look stays the owner\'s (no target means: where she faces)');
  assert.equal(laid.hands, undefined);
  // An owner that walks and smiles (a beat, her life): its place, its look, its slots kept; the face adds on top and takes the larger slot.
  const walker = { ...REST_TARGETS, place: { x: 0.4, z: -3 }, eyes: { yaw: 0.2, pitch: 0 }, head: { pitch: -0.05, yaw: 0, roll: 0 },
    expr: { smileEyes: 0.7, surprise: 0.3 }, hands: { right: { pose: 'v' } } as never };
  const over = layFace(walker, face);
  assert.deepEqual(over.place, walker.place); assert.deepEqual(over.eyes, walker.eyes);
  assert.ok(Math.abs(over.head.pitch - 0.05) < 1e-12, 'heads add');
  assert.deepEqual(over.expr, { smileEyes: 0.7, surprise: 0.3 });
  assert.equal(over.hands, walker.hands, 'no face hands: the owner\'s');
  assert.equal(layFace(walker, null), walker);
  assert.deepEqual(walker.head, { pitch: -0.05, yaw: 0, roll: 0 }, 'the owner\'s own object is not changed');
  assert.deepEqual(layFace(walker, faceGoals({ head: ZERO, torso: ZERO, expr: {}, exprNamed: {} })).expr, walker.expr);
});

test('her own glance becomes a look only when it is one: asleep none, tiny none, the window\'s gains and limits', () => {
  assert.equal(glance({ ...NEUTRAL_GAZE }), null);
  assert.equal(glance({ ...NEUTRAL_GAZE, x: 0.5, allowed: false }), null);
  const look = glance({ ...NEUTRAL_GAZE, x: 0.5, y: 0.5 })!;
  assert.ok(Math.abs(look.yaw - 0.24) < 1e-12 && Math.abs(look.pitch + 0.14) < 1e-12, JSON.stringify(look));
  assert.deepEqual(glance({ ...NEUTRAL_GAZE, x: 9 })!.yaw, 0.48);
});

test('touch session: the companion\'s mood inputs (no session for a hover; the end after the tail; a reset drops it; food first, then eating)', () => {
  const sent: LocalMoodInput[] = [], timers: { run: () => void; ms: number; live: boolean }[] = [];
  const session = new MoodTouchSession(input => sent.push(input), { set: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer; }, clear: timer => { (timer as { live: boolean }).live = false; } });
  session.state({ phase: 'rua-hover', sessionId: 's0' }); session.state({ phase: 'cheek-hover', sessionId: 's0' });
  assert.equal(sent.length, 0, 'a dwell opens nothing');
  session.state({ phase: 'rua', sessionId: 's1' });
  session.event({ type: 'rua', id: 's1-dose-1', sessionId: 's1', activeMs: 200 });
  session.state({ phase: 'idle', sessionId: null });
  assert.equal(sent.length, 2, 'the end waits');
  assert.equal(timers.at(-1)!.ms, TOUCH_SESSION_TAIL_MS);
  timers.at(-1)!.run();
  assert.deepEqual(sent.at(-1), { type: 'phase', phase: 'idle', sessionId: 's1' });
  assert.equal(session.lastSession, '');
  session.state({ phase: 'cheek', sessionId: 's2' }); session.state({ phase: 'idle', sessionId: null }); session.resetLocal();
  const pending = timers.at(-1)!; pending.run();
  assert.ok(!sent.some(input => input.type === 'phase' && input.phase === 'idle' && input.sessionId === 's2'), 'a reset drops the pending end');
  session.state({ phase: 'feeding-wait', sessionId: 's3' }); session.state({ phase: 'feeding-ready', sessionId: 's3' }); session.state({ phase: 'feeding-accepted', sessionId: 's3' });
  session.event({ type: 'food', id: 's3-food', sessionId: 's3' });
  assert.deepEqual(sent.slice(-4).map(input => input.type === 'phase' ? input.phase : input.type), ['food-wait', 'food-ready', 'food', 'food-eating']);
});

// ---- the host's mood bridge -----------------------------------------------------------------------------------------------------------

test('mood bridge rules: only the window she is shown in, visible and touchable; an ending always closes; the view relayed is what getMood answers', async () => {
  const shown = { isVisible: () => true }, other = { isVisible: () => true };
  let touchable = true, visible = true, current: typeof shown | null = shown;
  const sent: [unknown, string, unknown][] = [], taken: unknown[] = [];
  const handlers = new Map<string, (win: typeof shown, ...args: unknown[]) => unknown>();
  const bridge = new UnboundMoodBridge(() => ({ get: () => ({ revision: 0 }), interaction: value => { taken.push(value); return { taken: true }; } }),
    { current: () => current, shown: () => current, touchable: () => touchable, send: (win, channel, value) => sent.push([win, channel, value]) });
  bridge.register((channel, op) => handlers.set(channel, op));
  shown.isVisible = () => visible;
  const pat = { type: 'phase', phase: 'rua', sessionId: 'a', token: 't' }, end = { type: 'phase', phase: 'idle', sessionId: 'a', token: 't' };
  assert.deepEqual(await handlers.get(UNBOUND_REQUESTS.moodInteraction)!(shown, pat), { taken: true });
  assert.throws(() => handlers.get(UNBOUND_REQUESTS.moodInteraction)!(other, pat), /可以碰/, 'another window');
  touchable = false;
  assert.throws(() => handlers.get(UNBOUND_REQUESTS.moodInteraction)!(shown, pat), /可以碰/, 'stepped back or a peek');
  assert.ok(bridge.accepts(shown, end), 'an ending closes anyway');
  touchable = true; visible = false;
  assert.equal(bridge.accepts(shown, pat), false, 'hidden');
  assert.equal(bridge.accepts(shown, end), true);
  assert.equal(isTouchEnding({ type: 'phase', phase: 'rua' }), false);
  assert.deepEqual(handlers.get(UNBOUND_REQUESTS.getMood)!(shown), { revision: 0 }, 'before any broadcast: the mood host\'s view');
  bridge.relay('desk:other', { x: 1 }); bridge.relay('desk:mood', null);
  assert.deepEqual(sent, []);
  bridge.relay('desk:mood', { revision: 4 });
  assert.deepEqual(sent, [[shown, UNBOUND_EVENTS.mood, { revision: 4 }]]);
  assert.deepEqual(handlers.get(UNBOUND_REQUESTS.getMood)!(shown), { revision: 4 });
  current = null; bridge.relay('desk:mood', { revision: 5 });
  assert.equal(sent.length, 1, 'no window, nothing sent');
  const bare = new UnboundMoodBridge(() => undefined, { current: () => shown, shown: () => shown, touchable: () => true, send: () => {} }), bareHandlers = new Map<string, (win: typeof shown, ...args: unknown[]) => unknown>();
  bare.register((channel, op) => bareHandlers.set(channel, op));
  assert.throws(() => bareHandlers.get(UNBOUND_REQUESTS.moodInteraction)!(shown, pat), /尚未接入/);
  assert.equal(taken.length, 1);
});

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

test('host: the mood requests are answered only for her window\'s top frame; a touch\'s input only while she is shown and touchable; a new view reaches her', async () => {
  const ipc = new FakeIpc(), windows: FakeWindow[] = [], taken: unknown[] = [];
  const fullscreen: { send?: (value: 'fullscreen' | 'clear') => void } = {};
  const peek: PeekPorts = { clock: () => 5_000_000, random: () => 0.5, idleSeconds: () => 0, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true, every: () => () => {} };
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\m\\her.pmx', url: 'mmd-asset://token/her.pmx', name: 'her.pmx' } };
  const ports: UnboundHostPorts = {
    // no-pet-ok: the host's port names for the companion window
    ipcMain: ipc, pet: () => new FakeHome(), petWanted: () => true, developerMode: () => true, source: () => unboundSource(settings, null), reviewed: async () => true,
    display: () => DISPLAY, measure: async () => null, openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    fullscreen: { start: send => { fullscreen.send = send; }, stop: () => {} }, restored: () => {}, publish: () => {}, readyTimeoutMs: 600_000, headTimeoutMs: 600_000, peek,
    mood: { get: () => ({ revision: 1 }), interaction: value => { taken.push(value); return { revision: 2 }; } },
  };
  const host = new UnboundHost(ports);
  host.apply({ active: true }); await settle();
  const win = windows.at(-1)!;
  assert.deepEqual(await ipc.call(UNBOUND_REQUESTS.getMood, win.event()), { revision: 1 }, 'readable while she is still coming out');
  await ipc.call(UNBOUND_REQUESTS.getScene, win.event()); await ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true, modelHeightM: 1.6 }); await settle();
  const pat = { type: 'phase', phase: 'rua', sessionId: 'x', token: 't' };
  assert.deepEqual(await ipc.call(UNBOUND_REQUESTS.moodInteraction, win.event(), pat), { revision: 2 });
  await assert.rejects(ipc.call(UNBOUND_REQUESTS.moodInteraction, win.event({}), pat), /未授权/, 'another frame');
  await assert.rejects(ipc.call(UNBOUND_REQUESTS.getMood, { sender: { id: 5, mainFrame: win.frame }, senderFrame: win.frame }), /未授权/, 'another window');
  fullscreen.send!('fullscreen');
  assert.deepEqual(await ipc.call(UNBOUND_REQUESTS.moodInteraction, win.event(), pat), { revision: 2 }, 'I-199: in front of a full-screen program she is still there to touch');
  fullscreen.send!('clear');
  host.apply({ peekNow: true });
  assert.ok(await ipc.call(UNBOUND_REQUESTS.moodInteraction, win.event(), pat), '2026-11-23: during a peek she can be touched (no forced click-through; a touch does not end the close family)');
  assert.equal(taken.length, 3);
  host.mood('desk:mood', { revision: 9 });
  assert.deepEqual(win.sent.filter(([channel]) => channel === UNBOUND_EVENTS.mood).map(([, value]) => value), [{ revision: 9 }]);
  host.exit();
});

test('preload: the three mood members go to fixed channels; a touch\'s input must be one object', async () => {
  const invoked: [string, unknown[]][] = [], listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const ipc: UnboundIpc = { invoke: async (channel, ...args) => { invoked.push([channel, args]); return null; }, on: (channel, listener) => { listeners.set(channel, listener); }, removeListener: () => {} };
  const api = createUnboundApi(ipc);
  for (const key of ['getMood', 'onMood', 'moodInteraction']) assert.ok((UNBOUND_API_KEYS as readonly string[]).includes(key), key);
  await api.getMood(); await api.moodInteraction({ type: 'phase', phase: 'rua', sessionId: 's', token: 't' } as MoodInput);
  await assert.rejects(api.moodInteraction('rua' as unknown as MoodInput), TypeError);
  await assert.rejects(api.moodInteraction([] as unknown as MoodInput), TypeError);
  assert.deepEqual(invoked.map(([channel]) => channel), [UNBOUND_REQUESTS.getMood, UNBOUND_REQUESTS.moodInteraction]);
  const seen: unknown[][] = [];
  api.onMood((...args: unknown[]) => seen.push(args));
  listeners.get(UNBOUND_EVENTS.mood)!({ sender: 'event' }, { revision: 3 });
  assert.deepEqual(seen, [[{ revision: 3 }]], 'only the view');
});

// ---- the touch input on the full-screen page, end to end -------------------------------------------------------------------------------

class Style { [key: string]: unknown; cursor = ''; getPropertyValue(name: string) { return typeof this[name] === 'string' ? this[name] as string : ''; }
  getPropertyPriority() { return ''; } setProperty(name: string, value: string) { this[name] = value; } removeProperty(name: string) { this[name] = ''; return ''; } }
class Node extends EventTarget {
  children: Node[] = []; style = new Style(); textContent = ''; hidden = false; dataset: Record<string, string> = {}; readonly captured = new Set<number>();
  constructor(readonly ownerDocument: DocumentFixture) { super(); }
  append(...nodes: Node[]) { this.children.push(...nodes); } remove() {} setAttribute() {} contains(node: unknown) { return node === this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1536, height: 912 }; }
  setPointerCapture(id: number) { this.captured.add(id); } hasPointerCapture(id: number) { return this.captured.has(id); } releasePointerCapture(id: number) { this.captured.delete(id); }
}
class DocumentFixture extends EventTarget {
  readonly body: Node; readonly documentElement: Node; hidden = false;
  constructor(readonly defaultView: EventTarget & { performance: { now(): number } }) { super(); this.body = new Node(this); this.documentElement = this.body; }
  createElement() { return new Node(this); }
}

async function touchFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-full-touch-'));
  let now = 10_000, touchable = true;
  const host = new MoodHost(directory, () => {}, () => now);
  await host.load(); host.activate('gene');
  const listeners: ((view: MoodView) => void)[] = [], sent: MoodInput[] = [];
  const view = Object.assign(new EventTarget(), { performance: { now: () => now } });
  const owner = new DocumentFixture(view), surface = owner.createElement(); owner.body.append(surface);
  const views: (MoodView | null)[] = [], contacts: unknown[] = [];
  const touch = new HerOutTouch(surface as unknown as HTMLElement, {
    getMood: async () => host.get(), onMood: callback => { listeners.push(callback); return () => {}; },
    moodInteraction: async input => { sent.push(input); return host.interaction(input); },
  }, {
    region: () => ({ x: 700, y: 200, radius: 40, referenceWidth: 80, mouthX: 700, mouthY: 260, mouthRadius: 20,
      cheeks: [{ side: 'left', x: 670, y: 245, axisXX: 12, axisXY: 0, axisYX: 0, axisYY: 14, referenceWidth: 80 }] }),
    canTouch: () => touchable, view: value => views.push(value), contact: value => contacts.push(value),
  });
  touch.start(); await settle();
  t.after(async () => { touch.dispose(); await host.flush(); await rm(directory, { recursive: true, force: true }); });
  const pointer = (type: string, x: number, y: number, at: number, buttons = 0) => {
    now = at;
    surface.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, pointerId: 1, button: 0, buttons, pointerType: 'mouse', isPrimary: true }));
  };
  return { host, touch, sent, views, contacts, pointer, setTouchable: (value: boolean) => { touchable = value; }, clock: (value: number) => { now = value; } };
}

test('full-screen touch: a stroke on her scalp reaches the mood host as the companion window\'s does, and lifts her mood', async t => {
  const f = await touchFixture(t);
  assert.equal(f.views.at(-1)?.token, f.host.get().token, 'her face got the view');
  const before = f.host.get().snapshot.values.O;
  // 1.25 head widths a second: a stroke, not a swipe; the host's clock moves with it (its pat budget grows with time).
  for (let i = 0; i <= 16; i++) { f.pointer('pointermove', 695 + (i % 2) * 5, 195, 10_000 + i * 50); await settle(); }
  assert.equal(f.touch.phase, 'rua');
  assert.ok(f.sent.some(input => input.type === 'phase' && input.phase === 'rua'), 'the session opened');
  assert.ok(f.sent.some(input => input.type === 'rua' && input.activeMs > 0), 'a measured dose');
  assert.ok(f.host.get().snapshot.values.O > before, `her mood rose (${before} → ${f.host.get().snapshot.values.O})`);
  assert.ok(f.contacts.some(value => (value as { contact?: boolean } | null)?.contact === true), 'her face felt the hand');
});

test('full-screen touch: nothing is sent while the page says she cannot be touched; a press on her cheek is a pinch the page\'s pull leaves alone', async t => {
  const f = await touchFixture(t);
  f.setTouchable(false);
  for (let i = 0; i <= 8; i++) f.pointer('pointermove', 690 + (i % 2) * 20, 195, 10_000 + i * 50);
  await settle();
  assert.equal(f.sent.length, 0, 'a peek, hidden, faded: no touch');
  assert.equal(f.touch.pinching, false);
  f.setTouchable(true);
  f.pointer('pointermove', 670, 245, 11_000); f.pointer('pointerdown', 670, 245, 11_010, 1);
  assert.equal(f.touch.pinching, true, 'the press is the pinch\'s');
  f.pointer('pointermove', 690, 250, 11_200, 1);
  f.pointer('pointerup', 690, 250, 11_400, 0);
  await settle();
  assert.equal(f.touch.pinching, false);
  assert.ok(f.sent.some(input => input.type === 'phase' && input.phase === 'cheek'), 'the pinch reached the host');
});

// ---- the page's own rules (src/unbound/main.ts calls these; pure, so a broken rule fails here) --------------------------------------------

test('page rules: touchable as for a click (shown, no forced click-through, visible); a pinch keeps the page\'s click and pull off its press; an owner\'s look and a walk keep her glance off', () => {
  assert.equal(herTouchable({ peekForcing: false, presence: 1, hidden: false }), true);
  assert.equal(herTouchable({ peekForcing: true, presence: 1, hidden: false }), false, 'a peek forces click-through');
  assert.equal(herTouchable({ peekForcing: false, presence: 0.3, hidden: false }), false, 'still fading in');
  assert.equal(herTouchable({ peekForcing: false, presence: 1, hidden: true }), false, 'the page hidden');
  const her = new HerOut({} as HTMLElement, null, { camera: null as never, pixels: () => 0, canTouch: () => true });
  let pressed = 0;
  her.pagePress(() => pressed++);
  assert.equal(pressed, 1, 'a press on her goes to the page');
  Object.defineProperty(her, 'pinching', { get: () => true });
  her.pagePress(() => pressed++);
  assert.equal(pressed, 1, 'a pinch owns the press');
  her.dispose();
  const thinking = { ...NEUTRAL_GAZE, x: 0.4, y: 0.3 };
  assert.ok(faceLook({ ...REST_TARGETS }, thinking, false), 'her own glance');
  assert.equal(faceLook({ ...REST_TARGETS }, thinking, true), null, 'walking: her walk looks where she goes');
  assert.equal(faceLook({ ...REST_TARGETS, eyes: { yaw: 0.1, pitch: 0 } }, thinking, false), null, 'a peek or her life looking: theirs');
});

// ---- her capability card out here (model-card.ts): your choices follow her into full-screen ----------------------------------------------

test('her card out here: your choices from the host\'s record (能脸红 off stays off), another model\'s update ignored, haiku only once matched', async () => {
  const fixture = await loadPublicGeneForTargets();
  try {
    const profile = new StageModelProfile(fixture.mesh, { reviewed: false });
    const record = (choices: Record<string, 'on' | 'off'>) => ({ checkVersion: 1, checkedAt: 1, choices, haiku: {}, asked: null, updatedAt: 1 });
    const plain = cardOf(null, profile)!;
    assert.equal(plain.blush.enabled, true, 'detected on this model');
    const held = holdView({ modelKey: 'm1', modelUrl: 'x', profile: null, record: record({ blush: 'off', tears: 'off' }) }, profile)!;
    assert.equal(held.matched, false, 'no host profile copy: not matched (haiku\'s matches are not used)');
    const card = cardOf(held, profile)!;
    assert.equal(card.blush.enabled, false, 'your 能脸红 off'); assert.equal(card.tears.enabled, false, 'your 能流泪 off');
    assert.equal(heldUpdate(held, { modelKey: 'other', record: record({}) }), null, 'another model\'s update');
    const back = heldUpdate(held, { modelKey: 'm1', record: record({ blush: 'on' }) })!;
    assert.equal(cardOf(back, profile)!.blush.enabled, true, 'turned back on: on at once');
    assert.equal(holdView('junk', profile), null);
    assert.equal(cardOf(held, null), null);
    // Her face on it: 能脸红 off means no blush at all (the window's rule, window-face.ts blushOff).
    const face = new HerOutFace();
    face.attach({ body: { head: null, heightM: 1.6, setSlotMorphs: () => {} }, mesh: fixture.mesh, profile, painter: null, reviewed: false, standard: false, url: 'gene' });
    face.setCard(card);
    assert.equal(face.face.blushOff(), true);
    face.setCard(cardOf(back, profile));
    assert.equal(face.face.blushOff(), false);
    face.attach(null);
  } finally { fixture.close(); }
});

test('mood bridge: the capability record is read only by her window and its updates relayed; nothing else is relayed', async () => {
  const win = { isVisible: () => true }, sent: [string, unknown][] = [];
  const handlers = new Map<string, (w: typeof win, ...args: unknown[]) => unknown>();
  const bridge = new UnboundMoodBridge(() => ({ get: () => ({}), interaction: () => ({}), card: async () => ({ modelKey: 'm1' }) }),
    { current: () => win, shown: () => win, touchable: () => true, send: (_w, channel, value) => sent.push([channel, value]) });
  bridge.register((channel, op) => handlers.set(channel, op));
  assert.deepEqual(await handlers.get(UNBOUND_REQUESTS.getModelCard)!(win), { modelKey: 'm1' });
  bridge.relay('desk:model-capabilities', { modelKey: 'm1', record: {} });
  bridge.relay('desk:characters', { cards: [] });
  bridge.relay('desk:model-capability-preview', { id: 'blush' });
  assert.deepEqual(sent, [[UNBOUND_EVENTS.modelCard, { modelKey: 'm1', record: {} }]]);
  const bare = new UnboundMoodBridge(() => ({ get: () => ({}), interaction: () => ({}) }), { current: () => win, shown: () => win, touchable: () => true, send: () => {} });
  const bareHandlers = new Map<string, (w: typeof win, ...args: unknown[]) => unknown>();
  bare.register((channel, op) => bareHandlers.set(channel, op));
  assert.throws(() => bareHandlers.get(UNBOUND_REQUESTS.getModelCard)!(win), /尚未接入/);
});
