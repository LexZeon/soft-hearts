// Unbound U2, peek-lens through the real UnboundHost with fake windows (the fakes are unbound-mode.test.ts's): while she plays a
// peek the Unbound window is click-through whatever the page asks; key or mouse input that goes on backs her off (a reply and a
// full-screen program do not, I-192 / I-199); the page's reports are taken only from the shown window's top frame; leaving Unbound stops everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { type PetPort } from '../electron/unbound/mode';
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource } from '../electron/unbound/source';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS, type UnboundControlView, type UnboundScene } from '../shared/unbound/scene';
import type { PeekCommand } from '../shared/unbound/director';
import type { PeekPorts } from '../electron/unbound/peek';
import { CURIOUS } from './helpers/unbound-peek';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

class FakePet implements PetPort {
  visible = true; minimized = false; destroyed = false; calls: string[] = [];
  bounds: Rect = { x: 1100, y: 330, width: 400, height: 560 };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds: Rect) { this.calls.push('setBounds'); this.bounds = { ...bounds }; }
  hide() { this.calls.push('hide'); this.visible = false; }
  showInactive() { this.calls.push('show'); this.visible = true; }
}
class FakeWindow implements UnboundWindowLike {
  readonly frame = {};
  readonly sent: [string, unknown][] = [];
  visible = false; destroyed = false; ignoring: [boolean, unknown][] = []; bounds: Rect | null = null;
  private gone: (() => void)[] = [];
  readonly webContents = { id: 77, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push([channel, value]); }, isDestroyed: () => this.destroyed };
  constructor(bounds?: Rect) { this.bounds = bounds ?? null; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }) { this.ignoring.push([ignore, options]); }
  setBounds(bounds: Rect) { this.bounds = bounds; }
  onGone(callback: () => void) { this.gone.push(callback); }
  /** An IPC event from this window's top frame (or another frame). */
  event(frame: unknown = this.frame): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: frame }; }
}
class FakeIpc {
  readonly handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: UnboundIpcEvent, ...args: unknown[]) => unknown) { assert.ok(!this.handlers.has(channel), channel); this.handlers.set(channel, listener); }
  removeHandler(channel: string) { this.handlers.delete(channel); }
  async call(channel: string, event: UnboundIpcEvent, ...args: unknown[]) { return this.handlers.get(channel)!(event, ...args); }
}

const DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };

function setup() {
  const ipc = new FakeIpc(), pet = new FakePet(), windows: FakeWindow[] = [], views: UnboundControlView[] = [];
  const reading: { send?: (value: 'fullscreen' | 'clear') => void } = {};
  let now = 5_000_000, idle: number | null = 0, timers: { ms: number; run: () => void }[] = [];
  const peek: PeekPorts = {
    clock: () => now, random: () => 0.5, idleSeconds: () => idle, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true,
    every: (ms, run) => { const timer = { ms, run }; timers.push(timer); return () => { timers = timers.filter(t => t !== timer); }; },
  };
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\m\\her.pmx', url: 'mmd-asset://token/her.pmx', name: 'her.pmx' } };
  const ports: UnboundHostPorts = {
    ipcMain: ipc, pet: () => pet, petWanted: () => true, developerMode: () => true,
    source: () => unboundSource(settings, null), reviewed: async () => true, display: () => DISPLAY, measure: async () => null,
    openWindow: bounds => { const win = new FakeWindow(bounds); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    fullscreen: { start: send => { reading.send = send; }, stop: () => {} },
    restored: () => {}, publish: view => { views.push(view); }, readyTimeoutMs: 600_000, peek,
  };
  const host = new UnboundHost(ports);
  return {
    host, ipc, windows, views, reading,
    set idle(v: number | null) { idle = v; },
    /** Runs the 200 ms polls `n` times. */
    poll(n = 1) { for (let i = 0; i < n; i++) { now += 200; for (const t of [...timers]) if (t.ms < 1000) t.run(); } },
    timers: () => timers.map(t => t.ms).sort((a, b) => a - b),
  };
}
async function enter(t: ReturnType<typeof setup>) {
  t.host.apply({ active: true });
  await settle();
  const win = t.windows.at(-1)!;
  await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event());
  await t.ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true, modelHeightM: 1.6 });
  await settle();
  return win;
}
const peekCommands = (win: FakeWindow) => win.sent.filter(([channel]) => channel === UNBOUND_EVENTS.peek).map(([, value]) => value as PeekCommand);

test('2026-11-23: a peek never forces click-through: her own hit test decides at every beat (a click on her does not end the close family; a large pull does, on the page)', async () => {
  const t = setup(), win = await enter(t);
  const forced = win.ignoring.length;
  t.host.apply({ peekNow: true });
  const start = peekCommands(win).find(c => c.type === 'start')!;
  assert.ok(start && start.type === 'start' && start.trial);
  for (const phase of ['notice', 'walk', 'lean', 'hold', 'back', 'settle'] as const) {
    await t.ipc.call(UNBOUND_REQUESTS.peekReport, win.event(), { id: start.id, phase });
    assert.deepEqual(await t.ipc.call(UNBOUND_REQUESTS.interactive, win.event(), true), { interactive: true }, `${phase}: on her, she takes the mouse`);
  }
  assert.ok(!win.ignoring.slice(forced).some(([ignore]) => ignore), 'the host never forced the window click-through');
  assert.equal(t.views.at(-1)?.peek?.phase, 'settle');
});

test('2026-11-23: key or mouse input that goes on during a peek never sends a cancel (nothing polls it); a reply does not; nor a full-screen program (I-199)', async () => {
  const t = setup(), win = await enter(t);
  t.idle = 0;
  t.host.apply({ peekNow: true });
  for (let i = 0; i < 40; i++) { t.idle = 0.05; t.poll(1); }
  assert.equal(peekCommands(win).filter(c => c.type === 'cancel').length, 0, 'keys and the mouse going on: no cancel');
  // A reply mid-peek: she stays (she holds while she speaks, up to the cap).
  const u = setup(), w2 = await enter(u);
  u.host.apply({ peekNow: true });
  u.host.stream({ id: 'r', kind: 'chat', type: 'delta', text: '嗯' });
  assert.equal(peekCommands(w2).filter(c => c.type === 'cancel').length, 0, 'a reply does not back her off');
  // A full-screen program (I-199): information only, the peek goes on.
  const v = setup(), w3 = await enter(v);
  v.host.apply({ peekNow: true });
  v.reading.send?.('fullscreen');
  assert.equal(peekCommands(w3).filter(c => c.type === 'cancel').length, 0, 'a full-screen program does not back her off');
  assert.equal(v.host.peek?.active, true);
});

test('reports only from the shown window\'s top frame; leaving Unbound stops the director and its tick', async () => {
  const t = setup(), win = await enter(t);
  t.host.apply({ peekNow: true });
  const id = (peekCommands(win).find(c => c.type === 'start') as { id: string }).id;
  await assert.rejects(t.ipc.call(UNBOUND_REQUESTS.peekReport, win.event({ other: true }), { id, phase: 'done' }), /未授权/);
  assert.equal(t.host.peek?.active, true);
  assert.deepEqual(t.timers(), [1000], 'the once-a-second tick only (nothing polls your input)');
  t.host.apply({ active: false });
  assert.equal(t.host.peek?.active, false);
  assert.deepEqual(t.timers(), [], 'no timers left');
  assert.throws(() => t.host.apply({ peekNow: true }), /现在不行/);
});

test('the scene carries the softness knob, and the knobs change the director', async () => {
  const t = setup(), win = await enter(t);
  t.host.apply({ peekSoftness: 0.6, peekIdleSeconds: 45, peekCooldownMinutes: 30, peekPerHour: 1 });
  const scene = win.sent.filter(([channel]) => channel === UNBOUND_EVENTS.scene).map(([, value]) => value as UnboundScene).at(-1)!;
  assert.equal(scene.peekSoftness, 0.6);
  assert.deepEqual(t.host.view().peek?.knobs, { idleSeconds: 45, maxIdleSeconds: 900, cooldownMinutes: 30, perHour: 1, softness: 0.6 });
});

test('E3 (on by default in Unbound since step 2): the opening beat is in the first scene, the developer switch turns it off and on, and junk is refused', async () => {
  const t = setup(), win = await enter(t);
  const scenes = () => win.sent.filter(([channel]) => channel === UNBOUND_EVENTS.scene).map(([, value]) => value as UnboundScene);
  assert.equal(t.host.view().speechBeat, true);
  t.host.apply({ speechBeat: false });
  assert.equal(t.host.view().speechBeat, false);
  assert.ok(!('speechBeat' in scenes().at(-1)!), 'off: not in the scene at all');
  t.host.apply({ speechBeat: true });
  assert.equal(scenes().at(-1)?.speechBeat, true);
  assert.equal(t.host.view().speechBeat, true);
  assert.throws(() => t.host.apply({ speechBeat: 'yes' }), /开关格式不正确/);
});

test('I-159 E: a pull let go at the eyes station sets her place (the face station) and plays the peek; your mouse after it is nothing; a let-go that is not near plays none; a pull during the peek is accepted (2026-11-23: a large one ends it on the page)', async () => {
  const t = setup(), win = await enter(t);
  const place = { xM: 0.2, depthM: 0.8 };
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'start' });
  const walked = { part: 'torso', side: null, strength: 0.7, heldMs: 4000, ended: 'released', steps: 6 };
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'report', report: walked, place });
  assert.equal(peekCommands(win).length, 0, 'not near: no peek');
  t.idle = 2;
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'report', report: walked, place, near: true });
  const scene = win.sent.filter(([channel]) => channel === UNBOUND_EVENTS.scene).map(([, v]) => v as UnboundScene).at(-1)!;
  assert.equal(scene.world.placement.depthM, 0.8, 'her place first (so the peek ends where the page puts her)');
  const start = peekCommands(win).find(c => c.type === 'start');
  assert.ok(start && start.type === 'start' && start.trial && start.armAfterMs === 1000);
  for (let i = 0; i < 20; i++) { t.idle = 0.05; t.poll(1); } // the hand leaves the mouse, wiggles, goes on: none of it is anything
  assert.equal(peekCommands(win).filter(c => c.type === 'cancel').length, 0, 'your mouse after the let-go never sends her back');
  assert.equal((await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'start' }) as { accepted: boolean }).accepted, true, 'a pull during the peek is taken (the page ended the peek when it grew large)');
  const quiet = setup(), w2 = await enter(quiet);
  await quiet.ipc.call(UNBOUND_REQUESTS.pull, w2.event(), { phase: 'report', report: walked, near: true });
  assert.equal(peekCommands(w2).length, 0, 'near without a place is nothing');
});

