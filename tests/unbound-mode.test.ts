// Unbound U1: entering and leaving Unbound (electron/unbound/mode.ts, host.ts) with fake windows. The normal companion comes back
// exactly as she was; quitting while in Unbound restores and saves nothing; the Unbound window's requests are answered only
// from its own top frame; clicks go through except while the window says the cursor is on her.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnboundMode, type PetPort, type UnboundWindowPort } from '../electron/unbound/mode';
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource } from '../electron/unbound/source';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS, parseUnboundControlPatch, type UnboundControlView, type UnboundScene } from '../shared/unbound/scene';
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

function setup(options: Partial<UnboundHostPorts> & { developer?: boolean } = {}) {
  const ipc = new FakeIpc(), pet = new FakePet(), windows: FakeWindow[] = [], views: UnboundControlView[] = [];
  let developer = options.developer ?? true, restored = 0, wanted = true;
  const reading: { send?: (value: 'fullscreen' | 'clear') => void; stopped: number } = { stopped: 0 };
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\Users\\someone\\models\\her.pmx', url: 'mmd-asset://token/her.pmx', name: 'her.pmx' },
    motion: { path: 'C:\\Users\\someone\\motions\\stand.vmd', url: 'mmd-asset://t2/stand.vmd', name: 'stand.vmd' } };
  const host = new UnboundHost({
    ipcMain: ipc, pet: () => pet, petWanted: () => wanted, developerMode: () => developer,
    source: () => unboundSource(settings, null), reviewed: async () => true, display: () => DISPLAY,
    measure: async () => [{ widthCm: 34, heightCm: 22, source: 'edid', internal: true }],
    openWindow: bounds => { const win = new FakeWindow(bounds); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    fullscreen: { start: send => { reading.send = send; }, stop: () => { reading.stopped++; } },
    restored: () => { restored++; }, publish: view => { views.push(view); },
    readyTimeoutMs: 600_000, ...options, // only the tests that check the timeout pass their own (below)
  });
  return { host, ipc, pet, windows, views, reading, settings, get restored() { return restored; }, setDeveloper: (on: boolean) => { developer = on; }, setWanted: (on: boolean) => { wanted = on; } };
}
/** Enters, answers the window's scene request and reports her on screen. */
async function enter(t: ReturnType<typeof setup>) {
  t.host.apply({ active: true });
  await settle();
  const win = t.windows.at(-1)!;
  const scene = await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event()) as UnboundScene;
  await t.ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true, modelHeightM: 1.6 });
  await settle();
  return { win, scene };
}

test('entering: the pet stays until she is on screen in Unbound, then only its window hides', async () => {
  const t = setup();
  t.host.apply({ active: true });
  await settle();
  assert.equal(t.host.state, 'entering');
  assert.equal(t.pet.visible, true, 'the pet is still there while the Unbound window loads');
  const win = t.windows[0];
  assert.deepEqual(win.bounds, DISPLAY.workArea, 'over the work area, never the taskbar');
  assert.equal(win.visible, false);
  const scene = await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event()) as UnboundScene;
  assert.equal(scene.world.mapping, 'physical');
  assert.equal(scene.world.screen.source, 'measured');
  assert.equal(scene.reviewed, true);
  assert.equal(scene.modelUrl, 'mmd-asset://token/her.pmx');
  assert.ok(!JSON.stringify(scene).includes('C:\\\\') && !JSON.stringify(scene).includes('"path"'), 'no file path reaches the window');
  await t.ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true });
  await settle();
  assert.equal(t.host.state, 'unbound');
  assert.equal(t.pet.visible, false);
  assert.equal(win.visible, true);
  assert.deepEqual(t.pet.calls, ['hide']);
  // The host's settings sync keeps her hidden (显示桌宠 itself is unchanged).
  assert.deepEqual(t.host.petSettings({ visible: true, alwaysOnTop: true }), { visible: false, alwaysOnTop: true });
  assert.equal(t.views.at(-1)!.state, 'unbound');
});

test('exiting: the normal pet comes back exactly as she was', async () => {
  const t = setup();
  const { win } = await enter(t);
  t.pet.bounds = { x: 0, y: 0, width: 400, height: 560 }; // something moved the hidden window
  t.host.apply({ active: false });
  assert.equal(t.host.state, 'normal');
  assert.equal(win.destroyed, true);
  assert.equal(t.pet.visible, true);
  assert.deepEqual(t.pet.bounds, { x: 1100, y: 330, width: 400, height: 560 });
  assert.equal(t.restored, 1, 'then the host\'s ordinary settings sync');
  assert.deepEqual(t.host.petSettings({ visible: true }), { visible: true });
  assert.equal(t.reading.stopped >= 1, true, 'the full-screen watcher stopped');
});

test('a pet that was hidden stays hidden, and 显示桌宠 turned off meanwhile is respected', async () => {
  const hidden = setup();
  hidden.pet.visible = false;
  await enter(hidden);
  hidden.host.exit();
  assert.equal(hidden.pet.visible, false);
  assert.ok(!hidden.pet.calls.includes('show'));
  const off = setup();
  await enter(off);
  off.setWanted(false);
  off.host.exit();
  assert.equal(off.pet.visible, false);
});

test('quitting while in Unbound restores and saves nothing; the next start is normal mode', async () => {
  const t = setup();
  const { win } = await enter(t);
  t.host.quit();
  assert.equal(t.host.state, 'normal');
  assert.equal(win.destroyed, true);
  assert.equal(t.pet.visible, false, 'no flash of the pet while the app closes');
  assert.equal(t.restored, 0, 'no settings sync, nothing written');
  assert.equal(t.ipc.handlers.size, 0);
  // A new process starts with a new host: normal mode, nothing to undo.
  const next = setup();
  assert.equal(next.host.state, 'normal');
  assert.deepEqual(next.host.petSettings({ visible: true }), { visible: true });
});

test('Unbound v1 step 1: in and out work in any mode; the knobs stay developer-only; developer mode going off keeps her out', async () => {
  const t = setup({ developer: false });
  assert.equal(t.host.view().available, false, 'the developer panel switch still shows only in developer mode');
  for (const knob of [{ depthM: 3 }, { debug: true }, { peekNow: true }, { speechBeat: true }, { active: true, depthM: 3 }])
    assert.throws(() => t.host.apply(knob), /开发者模式/, JSON.stringify(knob));
  assert.equal(t.windows.length, 0, 'a refused patch does not enter either');
  await enter(t);
  assert.equal(t.host.state, 'unbound');
  const on = setup();
  await enter(on);
  on.setDeveloper(false);
  await new Promise(resolve => setTimeout(resolve, 1_700)); // the old 1.5 s developer-mode check would have sent her back by now
  assert.equal(on.host.state, 'unbound');
  on.host.apply({ active: false });
  assert.equal(on.host.state, 'normal');
  assert.equal(on.pet.visible, true);
});

test('Unbound v1 step 1: every state change reaches modeChanged after the host handled it', async () => {
  const states: string[] = [];
  const t = setup({ modeChanged: state => { states.push(`${state}:${t.host.view().state}`); } });
  await enter(t);
  t.host.exit();
  assert.deepEqual(states, ['entering:entering', 'unbound:unbound', 'normal:normal']);
  const failStates: string[] = [];
  const failing = setup({ readyFirstMs: 20, readyTimeoutMs: 20, modeChanged: state => { failStates.push(state); } });
  failing.host.apply({ active: true });
  await new Promise(resolve => setTimeout(resolve, 80)); await settle();
  assert.deepEqual(failStates, ['entering', 'normal'], 'an entry that fails ends in normal too (the bundle puts things back)');
});

test('she never appears: the attempt ends, the pet never moved, the reason is shown', async () => {
  const late = setup({ readyFirstMs: 30, readyTimeoutMs: 30 });
  late.host.apply({ active: true });
  await new Promise(resolve => setTimeout(resolve, 80)); await settle();
  assert.equal(late.host.state, 'normal');
  assert.equal(late.windows[0].destroyed, true);
  assert.equal(late.pet.visible, true);
  assert.deepEqual(late.pet.calls, []);
  assert.match(late.host.view().error ?? '', /她的窗口 \d+ 秒里没有开始加载（电脑可能太忙了）/); // the wait itself: tests/unbound-entry-wait.test.ts
  const failed = setup();
  failed.host.apply({ active: true });
  await settle();
  await failed.ipc.call(UNBOUND_REQUESTS.ready, failed.windows[0].event(), { ok: false, error: '她没能出现：还没有选模型。' });
  await settle();
  assert.equal(failed.host.state, 'normal');
  assert.match(failed.host.view().error ?? '', /还没有选模型/);
  // Leaving while she is still loading cancels it.
  const cancelled = setup();
  cancelled.host.apply({ active: true });
  await settle();
  cancelled.host.apply({ active: false });
  await settle();
  assert.equal(cancelled.host.state, 'normal');
  assert.equal(cancelled.windows[0].destroyed, true);
  assert.equal(cancelled.pet.visible, true);
});

test('the window going away by itself (closed, page crashed) brings the pet back', async () => {
  const t = setup();
  const { win } = await enter(t);
  win.destroy();
  assert.equal(t.host.state, 'normal');
  assert.equal(t.pet.visible, true);
});

test('only the Unbound window\'s own top frame is answered', async () => {
  const t = setup();
  const { win } = await enter(t);
  const stranger: UnboundIpcEvent = { sender: { id: 5, mainFrame: {} }, senderFrame: undefined };
  stranger.senderFrame = stranger.sender.mainFrame;
  for (const channel of Object.values(UNBOUND_REQUESTS)) {
    await assert.rejects(t.ipc.call(channel, stranger, true), /未授权/, `${channel} from another window`);
    await assert.rejects(t.ipc.call(channel, win.event({ child: true }), true), /未授权/, `${channel} from a sub-frame`);
  }
  assert.ok(!win.ignoring.some(([ignore]) => ignore === false), 'nobody else switched click-through off');
  t.host.exit();
  await assert.rejects(t.ipc.call(UNBOUND_REQUESTS.getScene, win.event()), /未授权/, 'a closed window has nothing to ask');
});

test('click-through: off only while the window says the cursor is on her, also with a full-screen program in front (I-199)', async () => {
  const t = setup();
  const { win } = await enter(t);
  win.ignoring.length = 0;
  assert.deepEqual(await t.ipc.call(UNBOUND_REQUESTS.interactive, win.event(), true), { interactive: true });
  assert.deepEqual(win.ignoring.at(-1), [false, { forward: true }]);
  assert.deepEqual(await t.ipc.call(UNBOUND_REQUESTS.interactive, win.event(), false), { interactive: false });
  assert.deepEqual(win.ignoring.at(-1), [true, { forward: true }]);
  await assert.rejects(t.ipc.call(UNBOUND_REQUESTS.interactive, win.event(), 'yes'), /参数/);
  // A full-screen program in front (I-199): information only; she stays shown on it and still takes a click on her.
  t.reading.send!('fullscreen');
  assert.equal(win.visible, true);
  assert.equal(t.host.view().fullscreen, true);
  assert.deepEqual(await t.ipc.call(UNBOUND_REQUESTS.interactive, win.event(), true), { interactive: true });
  assert.deepEqual(win.ignoring.at(-1), [false, { forward: true }]);
  t.reading.send!('clear');
  assert.equal(win.visible, true);
  assert.equal(t.host.view().fullscreen, false);
});

test('her reply reaches the bubble; knobs move her world; the control window\'s input is strict', async () => {
  const t = setup();
  const { win, scene } = await enter(t);
  t.host.stream({ id: 'r1', kind: 'chat', type: 'delta', text: '嗯，' });
  t.host.stream({ id: 'r1', kind: 'chat', type: 'status', text: 'internal' });
  t.host.stream({ id: 'a1', kind: 'agent', type: 'delta', text: 'not hers' });
  t.host.stream({ id: 'r1', kind: 'chat', type: 'done', text: '' });
  assert.deepEqual(win.sent.filter(([channel]) => channel === UNBOUND_EVENTS.bubble).map(([, value]) => value),
    [{ id: 'r1', type: 'delta', text: '嗯，', rev: 1 }, { id: 'r1', type: 'done', text: '', rev: 1 }]); // read-aloud: each piece carries its revision
  win.sent.length = 0;
  const farther = Math.ceil(scene.world.placement.depthM) + 3; // 2026-11-25: she comes out near (waist-up), so the test moves her back
  const view = t.host.apply({ depthM: farther });
  assert.equal(view.depthM, farther);
  const pushed = win.sent.find(([channel]) => channel === UNBOUND_EVENTS.scene)?.[1] as UnboundScene;
  assert.equal(pushed.world.placement.depthM, farther);
  const across = (p: { xM: number; depthM: number }) => p.xM * 0.55 / (0.55 + p.depthM);
  assert.ok(Math.abs(across(pushed.world.placement) - across(scene.world.placement)) < 1e-9, 'along the line of sight: the same place across the screen, only bigger');
  assert.ok(pushed.world.placement.xM > scene.world.placement.xM);
  assert.ok(pushed.revision > scene.revision);
  win.sent.length = 0;
  t.host.refresh();
  assert.equal(win.sent.length, 0, 'nothing changed: no scene');
  t.settings.pet = { ...t.settings.pet, breath: 0.2 };
  t.host.refresh();
  assert.equal((win.sent.at(-1)?.[1] as UnboundScene).breath, 0.2);
  for (const bad of [null, {}, { active: 'yes' }, { depthM: 0.1 }, { depthM: 40 }, { viewerDistanceCm: 5 }, { debug: 1 }, { active: true, extra: 1 }])
    assert.throws(() => parseUnboundControlPatch(bad), JSON.stringify(bad));
  assert.deepEqual(parseUnboundControlPatch({ viewerDistanceCm: 60, debug: true }), { viewerDistanceCm: 60, debug: true });
});

test('the window sees asset URLs only, never the files behind them', () => {
  const source = unboundSource({ ...DEFAULT_SETTINGS, model: { path: 'D:\\private\\Akiko\\model.pmx', url: 'mmd-asset://a/model.pmx', name: 'model.pmx' },
    motion: { path: 'D:\\private\\stand.vmd', url: 'mmd-asset://b/stand.vmd', name: 'stand.vmd' }, motionLayers: { gesture: null, expression: null } }, null);
  assert.equal(JSON.stringify(source).includes('private'), false);
  assert.deepEqual(source.motion, { pose: 'mmd-asset://b/stand.vmd', gesture: null, expression: null, legacy: false });
});

test('the mode alone: an entry cancelled while the window was being made leaves nothing behind', async () => {
  let release!: (win: UnboundWindowPort) => void;
  const pet = new FakePet(), win = new FakeWindow();
  const mode = new UnboundMode({ pet: () => pet, petWanted: () => true, open: () => new Promise(resolve => { release = resolve; }),
    restored: () => {}, changed: () => {} });
  const entering = mode.enter();
  assert.equal(mode.state, 'entering');
  mode.exit();
  release(win);
  await entering;
  assert.equal(mode.state, 'normal');
  assert.equal(win.destroyed, true);
  assert.equal(pet.visible, true);
  assert.deepEqual(pet.calls, []);
});
