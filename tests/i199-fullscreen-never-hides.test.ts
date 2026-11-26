// I-199:
// a full-screen program in front never hides, moves or demotes her. Through the real UnboundHost with fake windows (the fakes are
// unbound-mode.test.ts's) and the always-on-top band model of pet-topmost-band.test.ts: // no-pet-ok: an existing test file name
//  - the reading never hides her window, never ends a peek, never changes "shown" (her bubble, clicks, pulls and touches go on);
//  - she is raised once on the reading's arrival (an event), never again on the one-second timer, never on 'clear';
//  - a topmost full-screen program shown after her is below her after that one raise; Start, the tray or the snip overlay shown after
//    that stay above her (I-062);
//  - the reading reaches her as information (her own peeks and walks give it as their reason to wait; the control view says it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { type PetPort } from '../electron/unbound/mode'; // no-pet-ok: the mode's existing port type
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource } from '../electron/unbound/source';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS, type UnboundControlView } from '../shared/unbound/scene';
import { PEEK_BLOCK_WORDS, type PeekCommand } from '../shared/unbound/director';
import type { PeekPorts } from '../electron/unbound/peek';
import type { LifePorts } from '../electron/unbound/life';
import { LIFE_QUIET_WORDS } from '../shared/unbound/life/arbiter';
import { raisePet, PetTopmostGuard, type TopmostLevel } from '../electron/stage/pet-topmost'; // no-pet-ok: the stage part's existing names
import { CURIOUS } from './helpers/unbound-peek';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

/** The always-on-top band (front first); ordinary windows are never in it, so anything in it is above them. */
class Band {
  order: string[] = ['taskbar'];
  above(a: string, b: string): boolean { return this.order.includes(a) && this.order.includes(b) && this.order.indexOf(a) < this.order.indexOf(b); }
  raise(id: string): void { this.order = [id, ...this.order.filter(x => x !== id)]; }
}

class FakeHome implements PetPort { // no-pet-ok: the mode's existing port type
  visible = true; minimized = false; destroyed = false;
  bounds: Rect = { x: 1100, y: 330, width: 400, height: 560 };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds: Rect) { this.bounds = { ...bounds }; }
  hide() { this.visible = false; }
  showInactive() { this.visible = true; }
}
class FakeWindow implements UnboundWindowLike {
  readonly frame = {};
  readonly sent: [string, unknown][] = [];
  visible = false; destroyed = false; ignoring: [boolean, unknown][] = []; bounds: Rect | null = null; raises = 0; hides = 0; shows = 0; activations = 0;
  private gone: (() => void)[] = [];
  readonly webContents = { id: 77, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push([channel, value]); }, isDestroyed: () => this.destroyed };
  constructor(readonly band: Band, bounds?: Rect) { this.bounds = bounds ?? null; band.raise('her'); } // made with the style (window.ts applyPetTopmost; no-pet-ok: an existing function name)
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.shows++; this.visible = true; }
  hide() { this.hides++; this.visible = false; }
  /** As electron-host.ts: raiseUnboundWindow → raisePet on the real window (here: the band). */ // no-pet-ok: an existing function name
  raise() {
    this.raises++;
    const band = this.band;
    // no-pet-ok: an existing function name
    raisePet({ isDestroyed: () => this.destroyed, isVisible: () => this.isVisible(), isMinimized: () => false, isAlwaysOnTop: () => band.order.includes('her'),
      setAlwaysOnTop: (flag: boolean, _level?: TopmostLevel) => { if (flag) band.raise('her'); else band.order = band.order.filter(x => x !== 'her'); },
      moveTop: () => band.raise('her') });
  }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }) { this.ignoring.push([ignore, options]); }
  setBounds(bounds: Rect) { this.bounds = bounds; }
  onGone(callback: () => void) { this.gone.push(callback); }
  event(frame: unknown = this.frame): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: frame }; }
}
class FakeIpc {
  readonly handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: UnboundIpcEvent, ...args: unknown[]) => unknown) { this.handlers.set(channel, listener); }
  removeHandler(channel: string) { this.handlers.delete(channel); }
  async call(channel: string, event: UnboundIpcEvent, ...args: unknown[]) { return this.handlers.get(channel)!(event, ...args); }
}

const DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };

function setup() {
  const ipc = new FakeIpc(), band = new Band(), windows: FakeWindow[] = [], views: UnboundControlView[] = [];
  const reading: { send?: (value: 'fullscreen' | 'clear') => void } = {};
  const touches: unknown[] = [];
  let now = 5_000_000, timers: { ms: number; run: () => void }[] = [];
  const every = (ms: number, run: () => void) => { const timer = { ms, run }; timers.push(timer); return () => { timers = timers.filter(t => t !== timer); }; };
  const peek: PeekPorts = {
    clock: () => now, random: () => 0.5, idleSeconds: () => 0, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true, every,
  };
  const life: LifePorts = {
    clock: () => now, random: () => 0.5, readings: () => ({ idleSeconds: 0, state: 'busy' }), asleep: () => false, inCall: () => false, waiting: () => false,
    typing: () => false, readingAloud: () => false, mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true, every,
  };
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\m\\her.pmx', url: 'mmd-asset://token/her.pmx', name: 'her.pmx' } };
  const home = new FakeHome();
  const ports: UnboundHostPorts = {
    ipcMain: ipc, pet: () => home, petWanted: () => true, developerMode: () => true, // no-pet-ok: the host's existing port names
    source: () => unboundSource(settings, null), reviewed: async () => true, display: () => DISPLAY, measure: async () => null,
    openWindow: bounds => { const win = new FakeWindow(band, bounds); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    fullscreen: { start: send => { reading.send = send; }, stop: () => {} },
    restored: () => {}, publish: view => { views.push(view); }, readyTimeoutMs: 600_000, peek, life, touch: report => { touches.push(report); },
  };
  const host = new UnboundHost(ports);
  return {
    host, ipc, band, windows, views, reading, touches,
    /** The host's one-second beat `n` times (the peek's and her life's tick). */
    seconds(n: number) { for (let i = 0; i < n; i++) { now += 1000; for (const t of [...timers]) if (t.ms >= 1000) t.run(); } },
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

test('a full-screen program never hides her: the window stays shown, clicks, touches, pulls and her bubble go on', async () => {
  const t = setup(), win = await enter(t);
  t.host.stream({ id: 'r1', kind: 'chat', type: 'delta', text: '嗯，' });
  const rev = t.host.readAloud.revision;
  t.host.readAloud.report({ id: 'r1', rev, text: '嗯，', visible: true });
  assert.equal(t.host.readAloud.isPresentationCurrent('嗯，'), true, 'painted before the full-screen program came');
  const ignoredBefore = win.ignoring.length;
  t.reading.send!('fullscreen');
  t.seconds(5);
  assert.equal(win.visible, true, 'still shown');
  assert.equal(win.hides, 0, 'never hidden');
  assert.equal(win.ignoring.length, ignoredBefore, 'click-through not touched by the reading');
  assert.equal(t.host.view().fullscreen, true, 'the control view says it (information)');
  assert.deepEqual(await t.ipc.call(UNBOUND_REQUESTS.interactive, win.event(), true), { interactive: true }, 'the cursor on her: she takes the click');
  await t.ipc.call(UNBOUND_REQUESTS.touch, win.event(), { part: 'head' });
  assert.equal(t.touches.length, 1, 'a click on her is taken');
  // Her bubble can be seen and proven: read-aloud keeps working in front of the full-screen program (nothing was invalidated).
  assert.equal(t.host.readAloud.canShow(), true, 'her bubble can be seen');
  assert.equal(t.host.readAloud.isHere(), true);
  assert.equal(t.host.readAloud.isPresentationCurrent('嗯，'), true, 'the paint receipt from before the reading still counts (not invalidated)');
  const pull = await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'start' }) as { accepted: boolean };
  assert.equal(pull.accepted, true, 'a pull in front of a full-screen program is taken');
  t.reading.send!('clear');
  assert.equal(win.shows, 1, 'shown once at the entry only (no re-show on clear)');
  assert.equal(t.host.view().fullscreen, false);
});

test('a full-screen program never ends a peek; a trial still starts while one is in front', async () => {
  const t = setup(), win = await enter(t);
  t.host.apply({ peekNow: true });
  assert.equal(t.host.peek?.active, true);
  t.reading.send!('fullscreen');
  assert.equal(peekCommands(win).filter(c => c.type === 'cancel').length, 0, 'no cancel');
  assert.equal(t.host.peek?.active, true, 'she goes on');
  const u = setup(), w2 = await enter(u);
  u.reading.send!('fullscreen');
  u.host.apply({ peekNow: true });
  assert.ok(peekCommands(w2).some(c => c.type === 'start'), 'asked for: not held back by the full-screen program');
});

test('raised once on the arrival of a full-screen program (an event), never on the one-second timer, never on clear', async () => {
  const t = setup(), win = await enter(t);
  assert.equal(win.raises, 0, 'nothing raised before any reading');
  t.reading.send!('fullscreen');
  assert.equal(win.raises, 1);
  t.reading.send!('fullscreen'); // the same reading again (the probe sends only changes; the host checks too)
  t.seconds(120);
  assert.equal(win.raises, 1, 'no re-raise on the timer while it stays');
  t.reading.send!('clear');
  t.seconds(10);
  assert.equal(win.raises, 1, 'none when it goes');
  t.reading.send!('fullscreen');
  assert.equal(win.raises, 2, 'the next arrival is a new moment');
  t.host.exit();
  t.reading.send?.('clear'); t.reading.send?.('fullscreen');
  assert.equal(win.raises, 2, 'nothing once she is back home');
});

test('layering (I-062 kept): above a topmost full-screen player after its arrival; Start, the tray and the snip overlay shown after it stay above her', async () => {
  const t = setup(), win = await enter(t), band = t.band;
  band.raise('player'); // a full-screen player that pins itself topmost, shown after her
  assert.ok(band.above('player', 'her'), 'before the reading: it covers her');
  t.reading.send!('fullscreen');
  assert.ok(band.above('her', 'player'), 'the arrival raises her once: she is on the video');
  for (const later of ['start-menu', 'tray-flyout', 'snip-overlay']) {
    band.raise(later);
    t.seconds(30);
    // The companion's guard only reads the style (I-062); it never lifts her over a later topmost window either.
    // no-pet-ok: the stage part's existing guard name
    new PetTopmostGuard({ window: () => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isAlwaysOnTop: () => band.order.includes('her'),
      setAlwaysOnTop: () => band.raise('her'), moveTop: () => band.raise('her') }), wanted: () => true }).check();
    assert.ok(band.above(later, 'her'), `${later} shown after her stays above her`);
  }
  assert.ok(band.above('her', 'player'), 'still on the video');
  assert.ok(band.order.includes('taskbar') && win.bounds && win.bounds.height === DISPLAY.workArea.height, 'her window covers only the work area, never the taskbar');
});

test('the reading reaches her as information: her own peeks and walks give it as their reason to wait (autonomous only)', async () => {
  const t = setup();
  await enter(t);
  t.seconds(2);
  assert.notEqual(t.host.peek?.view().blocked, PEEK_BLOCK_WORDS.fullscreen);
  t.reading.send!('fullscreen');
  t.seconds(2);
  assert.equal(t.host.peek?.view().blocked, PEEK_BLOCK_WORDS.fullscreen, 'her peek knows (and waits on its own)');
  assert.equal(t.host.life?.view().why, LIFE_QUIET_WORDS.fullscreen, 'her free time knows; she is still shown (not 「她不在外面」)');
  assert.equal(t.views.at(-1)?.fullscreen, true);
  t.reading.send!('clear');
  t.seconds(2);
  assert.notEqual(t.host.life?.view().why, LIFE_QUIET_WORDS.fullscreen);
});
