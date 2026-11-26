/**
 * I-154 follow-up, batch B (docs/claude/2026-11-21-unbound-full-BG.md): 猜拳, 递东西 and 牵手 out in full-screen Unbound. The parts that are
 * not the frame loop (that is tests/unbound-full-games-gene.test.ts):
 *  - where her games are shown (playSurface) and which answers only stop (isPlayEnding);
 *  - the host's games bridge: only the window she is shown in, your own acts only while she can be touched, endings always; the same host
 *    methods; nothing without the ports; the real host routes the requests and sends events only to her window;
 *  - her own life gives way: playing is an interaction one rank under a pull (the arbiter, the life host);
 *  - the preload's nine game members on fixed channels; the page's pieces (the free hand keeps its beat, holding hands keeps her arm from a
 *    pull, the controls own their press and take the mouse).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from 'three';
import { UNBOUND_GAME_EVENTS, UNBOUND_GAME_REQUESTS, isPlayEnding, playSurface } from '../shared/unbound/games';
import { UnboundGamesBridge, type UnboundGamesPorts } from '../electron/unbound/games-bridge';
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import type { PetPort as HomePort } from '../electron/unbound/mode'; // no-pet-ok: the host's port name for the companion window
import { unboundSource } from '../electron/unbound/source';
import { createUnboundApi, UNBOUND_API_KEYS, type UnboundIpc } from '../electron/unbound/preload-api';
import { UNBOUND_GAMES_API_KEYS } from '../electron/unbound/games-preload-api';
import { arbitrate, interactionOf, INTERACTION_WORDS } from '../shared/unbound/life/arbiter';
import { LifeHost, type LifeLink, type LifePorts } from '../electron/unbound/life';
import { NEUTRAL_MOOD } from '../shared/unbound/director';
import type { LifeCommand } from '../shared/unbound/life/types';
import { UNBOUND_REQUESTS } from '../shared/unbound/scene';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import type { PeekPorts } from '../electron/unbound/peek';
import { CURIOUS } from './helpers/unbound-peek';
import { HerOutGames, withOutGames } from '../src/unbound/her/out-games';
import { HerOutPlay } from '../src/unbound/her/out-play';
import { HerOut } from '../src/unbound/her/out-page';
import { NEUTRAL_HAND_STYLE } from '../shared/behaviors/hands/knobs';
import type { WindowFaceFrame } from '../src/unbound/window-mode/window-face';
import type { WindowGamesFrame } from '../src/unbound/window-mode/window-games';
import { NEUTRAL_GAZE } from '../src/unbound/window-mode/window-face';

const R = UNBOUND_GAME_REQUESTS;

// ---- the rules ------------------------------------------------------------------------------------------------------------------------
test('where her games are: out (held) only the Unbound window, and only while she is shown there; at home the companion window as before', () => {
  assert.deepEqual(playSurface({ held: true, outShown: true, companionShown: false }), { surface: 'unbound', shown: true });
  assert.deepEqual(playSurface({ held: true, outShown: false, companionShown: true }), { surface: 'unbound', shown: false }, 'stepped back, entering or leaving: not shown');
  assert.deepEqual(playSurface({ held: false, outShown: true, companionShown: true }), { surface: 'companion', shown: true });
  assert.deepEqual(playSurface({ held: false, outShown: true, companionShown: false }), { surface: 'companion', shown: false }, 'at home a hidden companion is hidden');
});

test('an answer that only stops is an ending (taken even when she cannot be touched); a start, a reward or anything unknown is not', () => {
  for (const action of ['said', 'skipped', 'decline', 'quit']) assert.equal(isPlayEnding(R.rpsRespond, { id: 'm', action }), true, action);
  assert.equal(isPlayEnding(R.rpsRespond, { id: 'm', action: 'accept' }), false, 'accepting starts a match');
  assert.equal(isPlayEnding(R.rpsThrow, { gameId: 'm', round: 1, hand: 'rock', source: 'click' }), false, 'a throw');
  for (const outcome of ['not-taken', 'interrupted']) assert.equal(isPlayEnding(R.giveAnswer, { id: 'g', outcome }), true, outcome);
  assert.equal(isPlayEnding(R.giveAnswer, { id: 'g', outcome: 'taken' }), false, 'taking what she holds out (a mood moment)');
  for (const outcome of ['not-taken', 'interrupted', 'let-go']) assert.equal(isPlayEnding(R.handsAnswer, { id: 'h', outcome }), true, outcome);
  assert.equal(isPlayEnding(R.handsAnswer, { id: 'h', outcome: 'taken' }), false, 'touching her hand (a mood moment)');
  assert.equal(isPlayEnding(R.handsRequest, { use: 'hold' }), false, 'asking for her hand');
  assert.equal(isPlayEnding(R.giveAnswer, null), false); assert.equal(isPlayEnding('unbound:other', { outcome: 'interrupted' }), false);
});

// ---- the bridge -----------------------------------------------------------------------------------------------------------------------
class Win { visible = true; destroyed = false; isVisible() { return this.visible; } isDestroyed() { return this.destroyed; } }
function bridgeWorld(withPorts = true) {
  const state = { out: true, shown: new Win() as Win | null, touchable: true }, sent: [Win, string, unknown][] = [], calls: string[] = [];
  const ports: UnboundGamesPorts = {
    rps: { view: () => ({ id: 'm1' }), throwHand: v => { calls.push(`throw ${JSON.stringify(v)}`); return 'accepted'; }, respond: v => { calls.push(`respond ${(v as { action: string }).action}`); return true; } },
    give: { answer: v => { calls.push(`give ${(v as { outcome: string }).outcome}`); return true; } },
    hands: { answer: v => { calls.push(`hands ${(v as { outcome: string }).outcome}`); return true; }, request: () => { calls.push('request'); return true; } },
  };
  const bridge = new UnboundGamesBridge<Win>(() => withPorts ? ports : undefined, { shown: () => state.shown, out: () => state.out, touchable: () => state.touchable,
    send: (win, channel, value) => sent.push([win, channel, value]) });
  const handlers = new Map<string, (win: Win, ...args: unknown[]) => unknown>();
  bridge.register((channel, op) => handlers.set(channel, op));
  return { state, sent, calls, bridge, call: (channel: string, win: Win, value?: unknown) => handlers.get(channel)!(win, value) };
}

test('games bridge: only the window she is shown in, while out; your acts only while she can be touched; an ending always; the same host methods', () => {
  const w = bridgeWorld(), win = w.state.shown!;
  assert.equal(w.call(R.rpsThrow, win, { gameId: 'm1', round: 1, hand: 'rock', source: 'click' }), 'accepted');
  assert.equal(w.call(R.rpsThrow, new Win(), { gameId: 'm1', round: 1, hand: 'rock', source: 'click' }), false, 'another window');
  w.state.touchable = false;
  assert.equal(w.call(R.giveAnswer, win, { id: 'g', outcome: 'taken' }), false, 'stepped back or in a peek: not your act');
  assert.equal(w.call(R.handsRequest, win, { use: 'hold' }), false);
  assert.equal(w.call(R.giveAnswer, win, { id: 'g', outcome: 'interrupted' }), true, 'an ending still closes');
  assert.equal(w.call(R.rpsRespond, win, { id: 'm1', action: 'skipped' }), true);
  w.state.touchable = true; win.visible = false;
  assert.equal(w.call(R.handsAnswer, win, { id: 'h', outcome: 'taken' }), false, 'her window hidden');
  assert.equal(w.call(R.handsAnswer, win, { id: 'h', outcome: 'let-go' }), true);
  win.visible = true; w.state.out = false;
  assert.equal(w.call(R.handsAnswer, win, { id: 'h', outcome: 'let-go' }), false, 'not out: nothing at all');
  assert.equal(w.call(R.rpsGet, win), null, 'no view unless out and shown');
  w.state.out = true;
  assert.deepEqual(w.call(R.rpsGet, win), { id: 'm1' });
  assert.deepEqual(w.calls, ['throw {"gameId":"m1","round":1,"hand":"rock","source":"click"}', 'give interrupted', 'respond skipped', 'hands let-go']);
  // Sending: to her window while out; nothing to send to otherwise.
  assert.equal(w.bridge.send('give', { type: 'offer' }), true);
  assert.deepEqual(w.sent.map(([target, channel]) => [target === win, channel]), [[true, UNBOUND_GAME_EVENTS.give]]);
  w.state.out = false; assert.equal(w.bridge.send('rps', null), false);
  w.state.out = true; w.state.shown = null; assert.equal(w.bridge.send('rps', null), false, 'entering: no window yet');
  // canPlay: out, shown, visible, touchable.
  w.state.shown = win; assert.equal(w.bridge.canPlay(), true);
  w.state.touchable = false; assert.equal(w.bridge.canPlay(), false);
  w.state.touchable = true; win.destroyed = true; assert.equal(w.bridge.canPlay(), false);
  // Without the ports every request is refused (accepted ones throw; refused ones answer false).
  const bare = bridgeWorld(false);
  assert.throws(() => bare.call(R.rpsThrow, bare.state.shown!, { gameId: 'm1', round: 1, hand: 'rock', source: 'click' }), /尚未接入/);
  assert.throws(() => bare.call(R.rpsGet, bare.state.shown!), /尚未接入/);
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

test('host: her games\' requests answer only her window\'s top frame, through the game hosts\' own methods; an event reaches only her window', async () => {
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
    games: () => ({ give: { answer: value => { taken.push(value); return true; } }, rps: { view: () => ({ id: 'm9' }), throwHand: () => 'accepted', respond: () => true } }),
  };
  const host = new UnboundHost(ports);
  host.apply({ active: true }); await settle();
  const win = windows.at(-1)!;
  assert.equal(await ipc.call(R.giveAnswer, win.event(), { id: 'g', outcome: 'taken' }), false, 'still coming out: not shown yet');
  assert.equal(host.games.send('give', { type: 'offer' }), false, 'nothing is sent before she is shown');
  await ipc.call(UNBOUND_REQUESTS.getScene, win.event()); await ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true, modelHeightM: 1.6 }); await settle();
  assert.equal(host.games.canPlay(), true);
  assert.equal(await ipc.call(R.giveAnswer, win.event(), { id: 'g', outcome: 'taken' }), true);
  await assert.rejects(ipc.call(R.giveAnswer, win.event({}), { id: 'g', outcome: 'taken' }), /未授权/, 'another frame');
  assert.deepEqual(await ipc.call(R.rpsGet, win.event()), { id: 'm9' });
  fullscreen.send!('fullscreen');
  assert.equal(host.games.canPlay(), true, 'I-199: in front of a full-screen program her games are still shown');
  host.apply({ peekNow: true });
  assert.equal(await ipc.call(R.giveAnswer, win.event(), { id: 'g', outcome: 'taken' }), true, '2026-11-23: during a peek your act is yours (no forced click-through)');
  assert.equal(await ipc.call(R.giveAnswer, win.event(), { id: 'g', outcome: 'interrupted' }), true, 'its end still closes');
  await assert.rejects(ipc.call(R.handsAnswer, win.event(), { id: 'h', outcome: 'let-go' }), /尚未接入/, 'hands not connected here');
  assert.equal(host.games.send('hands', { type: 'cancel', id: 'h' }), true);
  assert.deepEqual(win.sent.filter(([channel]) => channel.startsWith('unbound:hands')).map(([, value]) => value), [{ type: 'cancel', id: 'h' }]);
  fullscreen.send!('clear');
  assert.equal(host.games.canPlay(), true, '2026-11-23: during a peek too (no forced click-through; a game starting ends the peek: a new action of hers)');
  assert.deepEqual(taken, [{ id: 'g', outcome: 'taken' }, { id: 'g', outcome: 'taken' }, { id: 'g', outcome: 'interrupted' }]);
  host.exit();
});

// ---- her own life gives way ----------------------------------------------------------------------------------------------------------
test('arbiter: playing with her is an interaction one rank under a pull: a running walk yields to it, nothing new starts, her gaze is yours', () => {
  const base = { inCall: false, pulled: false, typing: false, waiting: false, clicked: false, replying: false, readingAloud: false };
  assert.equal(interactionOf({ ...base, playing: true }), 'play');
  assert.equal(interactionOf({ ...base, playing: true, pulled: true }), 'pull', 'a pull is above it');
  assert.equal(interactionOf({ ...base, playing: true, inCall: true }), 'call');
  assert.equal(interactionOf({ ...base, playing: true, typing: true }), 'play', 'above typing');
  assert.equal(interactionOf(base), null);
  assert.equal(INTERACTION_WORDS.play, '你在和她玩');
  const knobs = { gapSeconds: 10, afterUserSeconds: 10 };
  assert.deepEqual(arbitrate({ now: 0, interaction: 'play', quiet: null, running: { id: 'w', level: 'place', easing: false }, wants: [], lastNoticeableEndAt: null, interactionEndedAt: null, knobs }),
    { kind: 'yield', id: 'w', reason: 'user' });
});

test('life host: while a game, an offer or her reach is on, her action eases out at once and nothing new starts', () => {
  const state = { now: 1_000_000, playing: false, sent: [] as LifeCommand[] };
  const ports: LifePorts = {
    clock: () => state.now, random: () => 0.5, readings: () => ({ idleSeconds: 120, state: 'pause' }), asleep: () => false, inCall: () => false, waiting: () => false,
    typing: () => false, readingAloud: () => false, mood: () => ({ ...NEUTRAL_MOOD }), lastInteractionAt: () => null, answered: () => true, every: () => () => {},
    playing: () => state.playing,
  };
  const link: LifeLink = { shown: () => true, fullscreen: () => false, out: () => true, send: command => state.sent.push(command), here: () => ({ across: 0.78, size: 4.275 / (8 + 0.55) }),
    toWorld: spot => ({ xM: (spot.across - 0.5) * 3, depthM: 4.275 / spot.size - 0.55 }), arrived: () => {}, peekActive: () => false, interruptPeek: () => {}, changed: () => {} };
  const host = new LifeHost(ports, link);
  host.trial('shift');
  state.playing = true;
  state.now += 1_000; host.tick();
  const cancel = state.sent.find(c => c.type === 'cancel');
  assert.ok(cancel && cancel.type === 'cancel' && cancel.reason === 'user', 'her action eases out');
  assert.deepEqual(state.sent.filter(c => c.type === 'attend').at(-1), { type: 'attend', on: true, why: 'user' });
  const start = state.sent.find(c => c.type === 'start') as Extract<LifeCommand, { type: 'start' }>;
  host.report({ id: start.id, phase: 'done' });
  const before = state.sent.filter(c => c.type === 'start').length;
  for (let i = 0; i < 120; i++) { state.now += 1_000; host.tick(); }
  assert.equal(state.sent.filter(c => c.type === 'start').length, before, 'nothing starts while you play');

});

// ---- the preload ---------------------------------------------------------------------------------------------------------------------
test('preload: the nine game members go to fixed channels, each answer must be one object, events carry the value only', async () => {
  for (const key of UNBOUND_GAMES_API_KEYS) assert.ok((UNBOUND_API_KEYS as readonly string[]).includes(key), key);
  const invoked: [string, unknown[]][] = [], listeners = new Map<string, (event: unknown, value: unknown) => void>();
  const ipc: UnboundIpc = { invoke: async (channel, ...args) => { invoked.push([channel, args]); return true; }, on: (channel, listener) => { listeners.set(channel, listener); }, removeListener: () => {} };
  const api = createUnboundApi(ipc);
  await api.rpsGet(); await api.rpsThrow({ gameId: 'm', round: 1, hand: 'rock', source: 'click' }); await api.rpsRespond({ id: 'm', action: 'said' });
  await api.giveAnswer({ id: 'g', outcome: 'taken' }); await api.handsAnswer({ id: 'h', outcome: 'let-go' }); await api.handsRequest({ use: 'hold' });
  assert.deepEqual(invoked.map(([channel]) => channel), [R.rpsGet, R.rpsThrow, R.rpsRespond, R.giveAnswer, R.handsAnswer, R.handsRequest]);
  await assert.rejects(api.giveAnswer('taken' as never), TypeError); await assert.rejects(api.handsRequest([] as never), TypeError);
  const seen: unknown[][] = [];
  api.rpsEvents((...args: unknown[]) => seen.push(['rps', ...args])); api.onGive((...args: unknown[]) => seen.push(['give', ...args])); api.onHands((...args: unknown[]) => seen.push(['hands', ...args]));
  for (const [channel, value] of [[UNBOUND_GAME_EVENTS.rps, null], [UNBOUND_GAME_EVENTS.give, { type: 'cancel', id: 'g' }], [UNBOUND_GAME_EVENTS.hands, { type: 'cancel', id: 'h' }]] as const)
    listeners.get(channel)!({ sender: 'the IPC event' }, value);
  assert.deepEqual(seen, [['rps', null], ['give', { type: 'cancel', id: 'g' }], ['hands', { type: 'cancel', id: 'h' }]]);
  for (const channel of [...Object.values(R), ...Object.values(UNBOUND_GAME_EVENTS)]) assert.match(channel, /^unbound:[a-z-]+$/);
});

// ---- the page's pieces ---------------------------------------------------------------------------------------------------------------
const Z = { pitch: 0, yaw: 0, roll: 0 };
const FACE: WindowFaceFrame = { expr: {}, exprNamed: {}, head: Z, torso: Z, hands: null, lids: 0, softLids: 0, ownsPat: false, blush: 0, blushPath: 'none', blushSize: 50, gaze: NEUTRAL_GAZE };
const hand = (weight: number) => ({ weight, pose: 'aim' as const, wave: 0 });

test('the games\' arms over her: the side they hold takes their arm, the free hand keeps a beat of hers; nothing of the games is the same frame', () => {
  const none: WindowGamesFrame = { hands: { left: null, right: null }, activity: null, torso: Z, head: false };
  assert.equal(withOutGames(FACE, none, {}), FACE);
  assert.equal(withOutGames(FACE, null, {}), FACE);
  const beat = { left: hand(0.7), right: hand(0.5) };
  const game: WindowGamesFrame = { hands: { left: null, right: hand(1) as never }, activity: null, torso: { pitch: 0.05, yaw: 0.1, roll: 0 }, head: true };
  const out = withOutGames(FACE, game, { hands: beat as never });
  assert.equal(out.hands!.right, game.hands.right, 'the game\'s arm');
  assert.equal(out.hands!.left, beat.left, 'her beat on the free hand goes on');
  assert.deepEqual(out.torso, { pitch: 0.05, yaw: 0.1, roll: 0 }, 'the reach\'s lean added');
});

test('holding hands keeps her hand and arm from a pull (the rest can be pulled); a start tells the page once; the controls own their press', () => {
  const her = new HerOut({} as HTMLElement, null, { camera: null as never, pixels: () => 0, canTouch: () => true });
  assert.equal(her.pullRefused('arm'), false);
  let started = 0;
  her.games.onStart = () => started++;
  assert.equal(her.games.stage.startHands({ use: 'hold', style: NEUTRAL_HAND_STYLE }), true);
  assert.equal(her.pullRefused('arm'), true, 'her hand is taken');
  assert.equal(her.pullRefused('torso'), false, 'the rest of her');
  assert.equal(her.busy, true);
  assert.equal(started, 1);
  let pressed = 0;
  her.pagePress(() => pressed++, null);
  Object.defineProperty(her, 'play', { value: { owns: (target: unknown) => target === 'control', dispose() {} } });
  her.pagePress(() => pressed++, 'control' as never);
  her.pagePress(() => pressed++, 'her' as never);
  assert.equal(pressed, 2, 'a press on a game control is the control’s own (not a click on her, not a pull)');
  her.dispose();
  const games = new HerOutGames(new Scene(), () => ({ camera: null as never, width: 800, height: 600 }));
  games.stage.setRps({ id: 'm', phase: 'invite' } as never);
  assert.equal(games.starts, 0, 'an invitation is not a start (only buttons)');
  assert.equal(games.stage.captureGivePicture(), null, 'no picture of her leaves this page');
  // The click layer: a control's box takes the mouse; its press is its own.
  const box = { left: 100, top: 100, right: 140, bottom: 140, width: 40, height: 40 };
  const button = { hidden: false, getBoundingClientRect: () => box, closest: (selector: string) => selector.includes('.rps-overlay') ? button : null };
  const root = { querySelectorAll: () => [button] } as unknown as HTMLElement;
  const play = new HerOutPlay(root, { api: null, games, bubble: { shown: false, receive: () => {} }, blocked: () => false, head: () => null });
  assert.ok(play.distance(120, 120) <= 0 && play.covers(120, 120));
  assert.ok(Math.abs(play.distance(150, 120) - 10) < 1e-9);
  button.hidden = true;
  assert.equal(play.distance(120, 120), Infinity, 'a hidden control takes nothing');
  assert.equal(play.owns(button as never), true);
  assert.equal(play.owns({ closest: () => null } as never), false);
  assert.equal(play.owns(null), false);
  games.dispose();
});
