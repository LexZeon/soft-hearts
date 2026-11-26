// The entry's wait (shared/unbound/entry-wait.ts, docs/claude/2026-11-19-unbound-entry-load.md): 45 s for her page to start, then
// 20 s without a forward step of its load, 90 s in all; the page's reporter (src/unbound/load-progress.ts); the host running it
// (electron/unbound/host.ts); and the privacy side: an entry that runs out turns no sense on and leaves the user's own switches as
// they were.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY_CAP_MS, ENTRY_FIRST_MS, ENTRY_QUIET_MS, EntryWait, entryWaitMessage, parseLoadProgress, startEntryWait } from '../shared/unbound/entry-wait';
import { LoadReporter } from '../src/unbound/load-progress';
import { UnboundHost, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { UnboundEntry } from '../electron/unbound/entry';
import { PermissionBundle, failedNotice, type BundleFacts, type BundleItem } from '../electron/unbound/permission-bundle';
import { unboundSource } from '../electron/unbound/source';
import { UNBOUND_REQUESTS, type UnboundState } from '../shared/unbound/scene';
import { createUnboundApi, UNBOUND_API_KEYS } from '../electron/unbound/preload-api';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { Rect } from '../shared/unbound/world';

// ---- the rule ---------------------------------------------------------------------------------------------------------------

test('the rule: 45 s for the page to start; then 20 s without a forward step ends it, each forward step starts the 20 s again; 90 s in all', () => {
  assert.equal(ENTRY_FIRST_MS, 45_000);
  assert.equal(ENTRY_QUIET_MS, 20_000);
  assert.equal(ENTRY_CAP_MS, 90_000);
  const wait = new EntryWait(0);
  assert.equal(wait.deadline(), 45_000, 'nothing reported yet: her page may be slow to start on a busy machine (measured 13–60 s)');
  assert.equal(wait.ended(44_999), null);
  assert.deepEqual(wait.ended(45_000), { kind: 'first', step: null });
  const slow = new EntryWait(0);
  assert.ok(slow.progress({ step: 'page' }, 30_000), 'the page started at 30 s: the old flat 20 s had already ended this');
  assert.equal(slow.deadline(), 50_000);
  assert.ok(slow.progress({ step: 'model', loaded: 0, total: 2_000_000 }, 45_000));
  assert.equal(slow.ended(60_000), null, 'still moving');
  assert.ok(slow.progress({ step: 'model', loaded: 900_000, total: 2_000_000 }, 60_000));
  assert.equal(slow.deadline(), 80_000);
  assert.deepEqual(slow.ended(80_000), { kind: 'quiet', step: 'model', loaded: 900_000, total: 2_000_000 });
  // A load that keeps crawling is still capped.
  const crawl = new EntryWait(0);
  for (let t = 0, bytes = 1; t < 90_000; t += 10_000, bytes++) assert.ok(crawl.progress({ step: 'model', loaded: bytes }, t));
  assert.equal(crawl.deadline(), 90_000);
  assert.equal(crawl.ended(89_999), null);
  assert.equal(crawl.ended(90_000)?.kind, 'cap');
});

test('the rule: only a step forward counts (a later step, or more bytes of the same file); repeats and steps back extend nothing', () => {
  const wait = new EntryWait(0);
  assert.ok(wait.progress({ step: 'motion' }, 5_000));
  assert.equal(wait.progress({ step: 'motion' }, 15_000), false, 'the same step again');
  assert.equal(wait.progress({ step: 'model', loaded: 10 }, 16_000), false, 'a step back');
  assert.equal(wait.deadline(), 25_000, 'still counted from the last forward step');
  assert.ok(wait.progress({ step: 'textures' }, 24_000));
  assert.equal(wait.progress({ step: 'draw' }, 50_000), false, 'after the end nothing revives it');
  const bytes = new EntryWait(0);
  assert.ok(bytes.progress({ step: 'model', loaded: 100 }, 1_000));
  assert.equal(bytes.progress({ step: 'model', loaded: 100 }, 2_000), false);
  assert.equal(bytes.progress({ step: 'model', loaded: 50 }, 3_000), false);
  assert.equal(bytes.progress({ step: 'model' }, 4_000), false, 'no bytes is not more bytes');
  assert.ok(bytes.progress({ step: 'model', loaded: 101 }, 5_000));
});

test('the page\'s report is read strictly', () => {
  assert.deepEqual(parseLoadProgress({ step: 'model', loaded: 12.7, total: 100 }), { step: 'model', loaded: 12, total: 100 });
  assert.deepEqual(parseLoadProgress({ step: 'draw' }), { step: 'draw' });
  for (const bad of [null, 'model', [], { step: 'fly' }, { step: 'model', loaded: -1 }, { step: 'model', loaded: Number.NaN }, { step: 'model', loaded: '5' },
    { step: 'model', total: 5e9 }, { step: 'model', path: 'C:\\x.pmx' }]) assert.equal(parseLoadProgress(bad), null, JSON.stringify(bad));
});

test('the messages say where she got stuck, in Chinese', () => {
  assert.equal(entryWaitMessage({ kind: 'first', step: null }), '她的窗口 45 秒里没有开始加载（电脑可能太忙了）。');
  assert.equal(entryWaitMessage({ kind: 'cap', step: null }), '等了 90 秒，她的窗口还没开始加载（电脑可能太忙了）。');
  assert.equal(entryWaitMessage({ kind: 'quiet', step: 'model', loaded: 500, total: 2000 }), '她卡在「读模型文件」（25%），20 秒没有进展（模型没有加载完）。');
  assert.equal(entryWaitMessage({ kind: 'quiet', step: 'draw' }), '她卡在「第一次画她」，20 秒没有进展（模型没有加载完）。');
  assert.equal(entryWaitMessage({ kind: 'cap', step: 'textures' }), '等了 90 秒她还没出现，停在「读贴图」。');
});

test('the host\'s timer follows the deadline: moved by each forward report, one message at the end, nothing after stop', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const ends: string[] = [];
    const wait = startEntryWait(message => ends.push(message));
    mock.timers.tick(30_000);
    assert.equal(wait.report({ step: 'page' }), true);
    mock.timers.tick(15_000);
    assert.equal(wait.report({ step: 'model', loaded: 1 }), true);
    assert.equal(wait.report({ step: 'model', loaded: 1 }), false);
    assert.equal(wait.report({ step: 'nonsense' }), false);
    mock.timers.tick(19_999);
    assert.deepEqual(ends, [], 'still waiting at 64.999 s: it moved at 45 s');
    mock.timers.tick(1);
    assert.equal(ends.length, 1);
    assert.match(ends[0], /卡在「读模型文件」/);
    assert.equal(wait.report({ step: 'draw' }), false, 'over');
    mock.timers.tick(100_000);
    assert.equal(ends.length, 1, 'once');
    const stopped: string[] = [];
    const quiet = startEntryWait(message => stopped.push(message));
    quiet.stop();
    mock.timers.tick(200_000);
    assert.deepEqual(stopped, []);
    // Callers that pass a long quiet time (the other host tests) keep a start time and a cap at least as long.
    const long: string[] = [];
    startEntryWait(message => long.push(message), { quietMs: 600_000 });
    mock.timers.tick(599_999);
    assert.deepEqual(long, []);
    mock.timers.tick(1);
    assert.equal(long.length, 1);
  } finally { mock.timers.reset(); }
});

test('the page\'s reporter: a new step at once, bytes at most every 250 ms, nothing after finish, a failing send never throws', () => {
  const sent: unknown[] = [];
  let now = 0;
  const reporter = new LoadReporter(progress => { sent.push(progress); }, () => now);
  reporter.step('page');
  reporter.bytes('model', 10, 100);
  now = 100; reporter.bytes('model', 20, 100);
  now = 260; reporter.bytes('model', 30);
  reporter.step('parsed');
  reporter.finish();
  reporter.step('draw');
  assert.deepEqual(sent, [{ step: 'page' }, { step: 'model', loaded: 10, total: 100 }, { step: 'model', loaded: 30 }, { step: 'parsed' }]);
  const throwing = new LoadReporter(() => { throw new Error('ipc gone'); });
  assert.doesNotThrow(() => throwing.step('page'));
  const rejecting = new LoadReporter(() => Promise.reject(new Error('ipc gone')));
  assert.doesNotThrow(() => rejecting.step('page'));
});

test('the preload gains one request, `loading`, on its fixed channel; nothing else', async () => {
  assert.ok(UNBOUND_API_KEYS.includes('loading'));
  const calls: unknown[][] = [];
  const api = createUnboundApi({ invoke: async (...args) => { calls.push(args); }, on: () => {}, removeListener: () => {} });
  await api.loading({ step: 'model', loaded: 1 });
  assert.deepEqual(calls, [[UNBOUND_REQUESTS.loading, { step: 'model', loaded: 1 }]]);
});

test('the 「她没能出来」 notice: the reason, then that no sense was turned on and the user\'s own stay on', () => {
  const notice = failedNotice('她卡在「读贴图」，20 秒没有进展（模型没有加载完）。');
  assert.equal(notice.title, '她没能出来');
  assert.equal(notice.detail, '她卡在「读贴图」，20 秒没有进展（模型没有加载完）。\n\n这次没有替你打开摄像头、麦克风、屏幕或电脑的声音（它们只在她出来以后才开）；你自己原来开着的，照旧开着。');
  assert.equal(failedNotice(null).detail, '这次没有替你打开摄像头、麦克风、屏幕或电脑的声音（它们只在她出来以后才开）；你自己原来开着的，照旧开着。');
});

// ---- the host, with the entry and the permission bundle ------------------------------------------------------------------------

class FakeWindow implements UnboundWindowLike {
  readonly frame = {};
  visible = false; destroyed = false;
  private gone: (() => void)[] = [];
  readonly webContents = { id: 91, mainFrame: this.frame, send: () => {}, isDestroyed: () => this.destroyed };
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {}
  setBounds() {}
  onGone(callback: () => void) { this.gone.push(callback); }
  event(frame: unknown = this.frame): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: frame }; }
}

/** Real host, entry and bundle; fake windows, switches and clock (setTimeout and Date only; the test settles with setImmediate). */
function world(initial: Partial<BundleFacts> = {}) {
  const handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  const small = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized: () => false, getBounds: (): Rect => ({ x: 0, y: 0, width: 300, height: 400 }), setBounds: () => {}, hide() { this.visible = false; }, showInactive() { this.visible = true; } };
  const windows: FakeWindow[] = [];
  const facts: BundleFacts = { camera: false, images: false, microphone: false, screen: false, listen: false, face: false, ...initial };
  const calls: string[] = [], notices: string[] = [];
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\models\\her.pmx', url: 'mmd-asset://t/her.pmx', name: 'her.pmx' } };
  let entry: UnboundEntry | null = null;
  const host = new UnboundHost({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } },
    // no-pet-ok: UnboundHostPorts names (her small window)
    pet: () => small, petWanted: () => true, developerMode: () => false, source: () => unboundSource(settings, null), reviewed: async () => false,
    display: () => ({ bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true }),
    measure: async () => null, openWindow: () => { const win = new FakeWindow(); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    restored: () => {}, publish: () => {}, modeChanged: state => entry?.modeChanged(state),
  });
  const bundle = new PermissionBundle({
    read: () => ({ ...facts }), face: () => ({ supported: true, installed: true, enrolled: 3 }),
    set: async (item: BundleItem, on: boolean) => { calls.push(`${item}:${on ? 'on' : 'off'}`); facts[item] = on; },
    save: async () => {}, replyRunning: () => false, every: () => () => {}, wait: async () => {},
  });
  entry = new UnboundEntry({
    state: () => host.state as UnboundState, enter: () => host.enter(), exit: () => host.exit(), ask: async () => ({ confirmed: true, remember: false }),
    skipAsk: () => null, setSkipAsk: async () => {}, bundle, read: () => ({ ...facts }), face: () => ({ supported: true, installed: true, enrolled: 3 }),
    failed: () => notices.push(host.view().error ?? ''),
  });
  const call = async (channel: string, win: FakeWindow, value?: unknown, frame?: unknown) => handlers.get(channel)!(win.event(frame), value);
  return { host, entry, windows, facts, calls, notices, small, call };
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('host: a slow load that keeps moving is waited for past 20 s, and she comes out; then the bundle turns on what was off', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const w = world();
    await w.entry.toggle();
    await flush();
    const win = w.windows[0];
    assert.ok(win, 'the window was made');
    await w.call(UNBOUND_REQUESTS.loading, win, { step: 'page' });
    for (let i = 1; i <= 6; i++) { mock.timers.tick(8_000); await w.call(UNBOUND_REQUESTS.loading, win, { step: 'model', loaded: i * 100_000, total: 2_500_000 }); }
    mock.timers.tick(8_000); await flush();
    assert.equal(w.host.state, 'entering', '56 s in, still moving: still waiting (the flat 20 s ended this at 20 s)');
    await w.call(UNBOUND_REQUESTS.ready, win, { ok: true, modelHeightM: 1.6 });
    await flush();
    assert.equal(w.host.state, 'unbound');
    assert.deepEqual(w.calls, ['camera:on', 'images:on', 'microphone:on', 'screen:on', 'listen:on', 'face:on']);
    w.host.quit();
  } finally { mock.timers.reset(); }
});

test('host + privacy: an entry that stalls ends after 20 s quiet, says where, turns nothing on, and the user\'s own switches stay on', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const w = world({ camera: true, images: true, microphone: true, screen: true, listen: true }); // the user turned these on herself
    await w.entry.toggle();
    await flush();
    const win = w.windows[0];
    await w.call(UNBOUND_REQUESTS.loading, win, { step: 'page' });
    await w.call(UNBOUND_REQUESTS.loading, win, { step: 'model', loaded: 10, total: 100 });
    mock.timers.tick(10_000);
    await w.call(UNBOUND_REQUESTS.loading, win, { step: 'model', loaded: 10, total: 100 }); // the same report: not a step forward
    await assert.rejects(async () => w.call(UNBOUND_REQUESTS.loading, win, { step: 'draw' }, {}), /未授权/, 'another frame of her window is not her page');
    mock.timers.tick(9_999); await flush();
    assert.equal(w.host.state, 'entering', '19.999 s after the last forward step');
    mock.timers.tick(1); await flush();
    assert.equal(w.host.state, 'normal');
    assert.equal(win.destroyed, true);
    assert.equal(w.small.visible, true, 'her small window never went away');
    assert.equal(w.host.view().error, '她卡在「读模型文件」（10%），20 秒没有进展（模型没有加载完）。');
    assert.deepEqual(w.notices, [w.host.view().error], 'the user is told');
    await flush();
    assert.deepEqual(w.calls, [], 'no switch touched: nothing turned on, nothing turned off');
    assert.deepEqual(w.facts, { camera: true, images: true, microphone: true, screen: true, listen: true, face: false }, 'what the user had on is still on');
    w.host.quit();
  } finally { mock.timers.reset(); }
});

test('host: a page that never starts is ended at 45 s; one that crawls is ended at 90 s', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const silent = world();
    await silent.entry.toggle();
    await flush();
    mock.timers.tick(44_999); await flush();
    assert.equal(silent.host.state, 'entering', 'a busy machine may take this long to start her page');
    mock.timers.tick(1); await flush();
    assert.equal(silent.host.state, 'normal');
    assert.equal(silent.host.view().error, '她的窗口 45 秒里没有开始加载（电脑可能太忙了）。');
    assert.deepEqual(silent.calls, []);
    const crawl = world();
    await crawl.entry.toggle();
    await flush();
    const win = crawl.windows[0];
    for (let t = 0, bytes = 1; t < 90_000; t += 5_000, bytes++) { await crawl.call(UNBOUND_REQUESTS.loading, win, { step: 'model', loaded: bytes }); mock.timers.tick(5_000); }
    await flush();
    assert.equal(crawl.host.state, 'normal');
    assert.equal(crawl.host.view().error, '等了 90 秒她还没出现，停在「读模型文件」。');
    assert.deepEqual(crawl.calls, []);
    silent.host.quit(); crawl.host.quit();
  } finally { mock.timers.reset(); }
});
