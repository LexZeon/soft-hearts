// 「三人同框（Beta）」 (I-209): the switch in 「还在试用的功能」. Off on stable, on in development and source runs,
// the user's saved choice wins; off: the full-screen panel has no 「谁在场」, nobody else can be asked out, those already out walk out and stay
// gone; on: as before. Through the real UnboundHost with fake windows (the same world as i209-company-presence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelGateDefault, resolveChannelGate, type GateChannel } from '../shared/foundation/channel-defaults';
import { UnboundHost, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { unboundSource } from '../electron/unbound/source';
import { companyPorts } from '../electron/unbound/company/ports';
import { UNBOUND_REQUESTS } from '../shared/unbound/scene';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { Rect } from '../shared/unbound/world';

test('threeOnStage: on on stable too, in development and in source runs; a saved choice wins', () => {
  assert.equal(channelGateDefault('threeOnStage', 'stable'), true);
  for (const channel of ['development', '', null, undefined] as GateChannel[]) assert.equal(channelGateDefault('threeOnStage', channel), true, String(channel));
  assert.equal(resolveChannelGate('threeOnStage', { threeOnStage: false }, 'stable'), false);
  assert.equal(resolveChannelGate('threeOnStage', { threeOnStage: false }, 'development'), false);
  assert.equal(resolveChannelGate('threeOnStage', { threeOnStage: null }, 'stable'), true);
});

class FakeWindow implements UnboundWindowLike {
  readonly frame = {};
  visible = false; destroyed = false;
  readonly sent: { channel: string; value: unknown }[] = [];
  private gone: (() => void)[] = [];
  static ids = 77;
  readonly webContents = { id: FakeWindow.ids++, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push({ channel, value }); }, isDestroyed: () => this.destroyed };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {}
  setBounds() {}
  onGone(callback: () => void) { this.gone.push(callback); }
  event(): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: this.frame }; }
}
const flush = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };

function companyWorld() {
  const handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  const windows: FakeWindow[] = [];
  const small = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized: () => false, getBounds: (): Rect => ({ x: 0, y: 0, width: 300, height: 400 }), setBounds: () => {}, hide() { this.visible = false; }, show() { this.visible = true; }, showInactive() { this.visible = true; } };
  const cardState = { active: 'gene', cards: [{ id: 'gene', name: 'Gene' }, { id: 'vrm-a', name: 'A', modelPath: 'C:\\m\\a.vrm' }, { id: 'pmx-b', name: 'B', modelPath: 'C:\\m\\b.pmx' }, { id: 'c-none', name: 'C' }] as { id: string; name: string; modelPath?: string }[] };
  const registered: string[] = [], notices: string[] = [], present: string[][] = [], gate = { on: true };
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\models\\gene.pmx', url: 'mmd-asset://t/gene.pmx', name: 'gene.pmx' } };
  const host = new UnboundHost({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } },
    // no-pet-ok: UnboundHostPorts names (her small window)
    pet: () => small as never, petWanted: () => true, developerMode: () => false, source: () => unboundSource(settings, null), reviewed: async () => true,
    display: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true }),
    measure: async () => null, openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    restored: () => {}, publish: () => {},
    company: companyPorts(() => ({
      cards: { modelCards: () => cardState.cards, presetGeneId: async () => 'gene', publicState: () => ({ activeId: cardState.active }) },
      models: { bundledModel: async () => ({ url: 'mmd-asset://bundled/gene.pmx' }), register: async file => { registered.push(file); return { url: `mmd-asset://tok/${encodeURIComponent(file.split('\\').pop()!)}` }; } },
    }), ids => { present.push([...ids]); }, () => gate.on),
  });
  const notice = host.notice.bind(host);
  host.notice = (text: string) => { notices.push(text); notice(text); };
  const call = async (channel: string, win: FakeWindow, ...args: unknown[]) => handlers.get(channel)!(win.event(), ...args);
  const enter = async () => {
    host.enter(); await flush();
    const win = windows.at(-1)!;
    await call(UNBOUND_REQUESTS.ready, win, { ok: true, modelHeightM: 1.6 }); await flush();
    assert.equal(host.state, 'unbound');
    return win;
  };
  return { host, windows, handlers, call, enter, cardState, registered, notices, present, flush, gate };
}

test('switch off: the panel has no 「谁在场」 and nobody else can be asked out', async () => {
  const w = companyWorld(); w.gate.on = false;
  await w.enter();
  const look = await w.host.company.look();
  assert.deepEqual(look.entries, [], 'no rows: companyRows draws nothing for fewer than two entries');
  await w.host.company.set('vrm-a', true); await w.flush();
  assert.deepEqual(w.present.filter(ids => ids.length), [], 'nobody came out');
  w.gate.on = true; w.host.refresh(); await w.flush();
  assert.equal((await w.host.company.look()).entries.length, 4, 'on again: the rows are back');
  assert.deepEqual(w.present.filter(ids => ids.length), [], 'and nobody was quietly remembered from while it was off');
  w.host.quit();
});

test('switch on: asking someone out works as before', async () => {
  const w = companyWorld();
  await w.enter();
  await w.host.company.set('vrm-a', true); await w.flush();
  assert.deepEqual(w.present.at(-1), ['vrm-a']);
  w.host.quit();
});

test('switching it off while they are out sends them off the stage (told once, to the stage that walks them out), and they do not come back when it goes on', async () => {
  const w = companyWorld();
  await w.enter();
  await w.host.company.set('vrm-a', true); await w.host.company.set('pmx-b', true); await w.flush();
  assert.deepEqual(w.present.at(-1), ['vrm-a', 'pmx-b']);
  w.gate.on = false; w.host.refresh(); await w.flush();
  assert.deepEqual(w.present.at(-1), [], 'everyone else is sent back (the stage walks each one out first, electron/unbound/company/stage.ts)');
  w.gate.on = true; w.host.refresh(); await w.flush();
  assert.deepEqual(w.present.at(-1), [], 'on again: still nobody until the user asks');
  w.host.quit();
});
