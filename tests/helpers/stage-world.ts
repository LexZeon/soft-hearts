// I-209 step 3: the full-screen stage as the app makes it (electron/unbound/company/build.ts buildUnboundStage), with fake Electron parts:
// one fake ipcMain every host's requests go through (the real fanout routes them by window), fake windows that log what they get and when
// they are raised, the real UnboundHost for the first one and for each other one, the real stage coordinator.
import assert from 'node:assert/strict';
import { buildUnboundStage } from '../../electron/unbound/company/build';
import { companyPorts } from '../../electron/unbound/company/ports';
import { unboundSource } from '../../electron/unbound/source';
import type { UnboundIpcEvent, UnboundWindowLike } from '../../electron/unbound/host';
import { UNBOUND_REQUESTS } from '../../shared/unbound/scene';
import { DEFAULT_SETTINGS } from '../../shared/foundation/defaults';
import type { Rect } from '../../shared/unbound/world';

export class StageWindow implements UnboundWindowLike {
  readonly frame = {};
  visible = false; destroyed = false;
  readonly sent: { channel: string; value: unknown }[] = [];
  private gone: (() => void)[] = [];
  static ids = 300;
  constructor(private readonly raised: StageWindow[]) {}
  readonly webContents = { id: StageWindow.ids++, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push({ channel, value }); }, isDestroyed: () => this.destroyed };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  raise() { this.raised.push(this); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {}
  setBounds() {}
  onGone(callback: () => void) { this.gone.push(callback); }
  event(): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: this.frame }; }
  of(channel: string): unknown[] { return this.sent.filter(m => m.channel === channel).map(m => m.value); }
}

export const flush = async () => { for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve)); };

export interface StageWorldOptions { peek?: boolean; replyOwner?: Map<string, string> }

export function stageWorld(options: StageWorldOptions = {}) {
  const handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  const windows: StageWindow[] = [], raised: StageWindow[] = [], clicks: unknown[] = [], present: string[][] = [], journal: unknown[] = [], frames: { id: string | null; row: unknown }[] = [], mouths: { id: string | null; sentences: unknown[] }[] = [];
  const small = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized: () => false, getBounds: (): Rect => ({ x: 0, y: 0, width: 300, height: 400 }), setBounds: () => {}, hide() { this.visible = false; }, show() { this.visible = true; }, showInactive() { this.visible = true; } };
  const cards = [{ id: 'gene', name: 'Gene' }, { id: 'vrm-a', name: 'A', modelPath: 'C:\\m\\a.vrm' }, { id: 'pmx-b', name: 'B', modelPath: 'C:\\m\\b.pmx' }];
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\models\\gene.pmx', url: 'mmd-asset://t/gene.pmx', name: 'gene.pmx' } };
  const mood = { snapshot: { values: { D: 50, O: 50, E: 50, N: 50, C: 50 }, boredom: 0, longing: 0 }, parameters: { baseline: { D: 50, O: 50, E: 50, N: 50, C: 50 }, evidence: { level: 1 } } };
  const close = () => ({ view: () => null, stage: () => null, typing: () => false, playing: () => false, moment: () => false, happened: () => {},
    notes: { missed: (kind: string, block: string) => { journal.push({ kind, block }); }, interrupted: () => {} } });
  const peek = options.peek ? { activityIdleSeconds: () => null, mood: () => mood, asleep: () => false, inCall: () => false, userTalking: () => false, lastInteractionAt: () => null, answered: () => false } : undefined;
  const { host, stage } = buildUnboundStage({
    page: { electronDir: '', distDir: '' },
    // no-pet-ok: UnboundWiring names (her small window)
    pet: () => small as never, petWanted: () => true, developerMode: () => false, source: () => unboundSource(settings, null), reviewed: async () => true,
    restored: () => {}, publish: () => {}, touch: report => { clicks.push(report); },
    ...(peek ? { peek, close: close() as never } : {}),
    company: companyPorts(() => ({
      cards: { modelCards: () => cards, presetGeneId: async () => 'gene', publicState: () => ({ activeId: 'gene' }) },
      models: { bundledModel: async () => ({ url: 'mmd-asset://bundled/gene.pmx' }), register: async file => ({ url: `mmd-asset://tok/${encodeURIComponent(file.split('\\').pop()!)}` }) },
    }), ids => { present.push([...ids]); }),
    stage: { mood: () => ({ get: () => mood, interaction: () => { throw new Error('no'); } }), peekMood: () => mood as never, close: () => close() as never, journal: (id, row) => { journal.push({ id, row }); }, frames: (id, row) => { frames.push({ id, row }); }, mouth: (id, sentences) => { mouths.push({ id, sentences }); } },
    replyOwner: id => options.replyOwner?.get(id) ?? null,
  }, {
    ipcMain: { handle: (channel, listener) => { assert.ok(!handlers.has(channel), `one real handler per channel (${channel})`); handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } },
    open: () => { const win = new StageWindow(raised); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    measure: async () => null,
    display: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true }),
  });
  const call = async (channel: string, win: StageWindow, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `a handler for ${channel}`);
    return handler(win.event(), ...args);
  };
  /** Answers the newest window's ready report (her page loaded, her height). */
  const ready = async (heightM = 1.6) => { await flush(); const win = windows.at(-1)!; await call(UNBOUND_REQUESTS.ready, win, { ok: true, modelHeightM: heightM }); await flush(); return win; };
  const enter = async () => { host.enter(); const win = await ready(); assert.equal(host.state, 'unbound'); return win; };
  /** Brings one more out through the panel and answers her page's ready report; her window. */
  const bringOut = async (id: string, heightM = 1.6) => { await host.company.set(id, true); await flush(); return ready(heightM); };
  return { host, stage, handlers, windows, raised, clicks, present, journal, frames, mouths, call, ready, enter, bringOut };
}
