import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { PetReplyUpdate } from '../shared/contracts';
import type { ReplyLayout } from '../electron/reply-layout';

interface ReplyHost { update(value: PetReplyUpdate): void; waitForPresentation(text: string, signal?: AbortSignal): Promise<boolean>; isPresentationCurrent(text: string): boolean; clear(): void; dispose(): void; }
interface Render { presentationToken: string | null; text?: string; waiting: boolean; layout: ReplyLayout; interactionOpacity: number; }
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/** Actual host class, fake native boundaries only. No Electron process, renderer execution or profile. */
function hostFixture(t: TestContext, deferLoad = false) {
  const windows: WindowFixture[] = [], ipcMain = new EventEmitter(), loaded = deferred<void>();
  class WindowFixture extends EventEmitter {
    visible = false; minimized = false; destroyed = false; opacity = 1; top = false; url = '';
    bounds = { x: 100, y: 150, width: 400, height: 560 };
    readonly parent: WindowFixture | null;
    readonly sent: Render[] = [];
    readonly webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, getURL: () => this.url, isDestroyed: () => this.destroyed,
      send: (_channel: string, value: Render) => { this.sent.push(value); }, setWindowOpenHandler: () => {},
    });
    constructor(options?: { parent?: WindowFixture }) { super(); this.parent = options?.parent ?? null; windows.push(this); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    getOpacity() { return this.opacity; } getParentWindow() { return this.parent; }
    isAlwaysOnTop() { return this.top; } setAlwaysOnTop(value: boolean) { this.top = value; }
    getBounds() { return { ...this.bounds }; } setBounds(value: typeof this.bounds) { this.bounds = { ...value }; }
    setIgnoreMouseEvents() {}
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return deferLoad ? loaded.promise : Promise.resolve(); }
    showInactive() { this.visible = true; this.emit('show'); }
    hide() { const changed = this.visible; this.visible = false; if (changed) this.emit('hide'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const filename = new URL('../electron/reply-window.ts', import.meta.url), localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requireFixture = (name: string) => name === 'electron' ? { BrowserWindow: WindowFixture, ipcMain,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) } } : localRequire(name);
  new Function('require', 'module', 'exports', '__dirname', code)(requireFixture, module, module.exports, path.dirname(fileURLToPath(filename)));
  const owner = new WindowFixture(); owner.visible = true;
  const { PetReplyWindow } = module.exports as { PetReplyWindow: new (owner: WindowFixture) => ReplyHost }, reply = new PetReplyWindow(owner);
  t.after(() => reply.dispose());
  const child = () => windows[1]!;
  return { reply, owner, child, ipcMain, load: () => loaded.resolve(),
    show(text = '前缀：完整文本') { reply.update({ text, state: 'streaming', anchor: { x: 200, y: 210, radius: 110, visible: true } }); },
    token: () => child().sent.at(-1)!.presentationToken,
    ack(token: unknown, sender = child().webContents, frame: unknown = child().webContents.mainFrame) {
      ipcMain.emit('desk:reply-presented', { sender, senderFrame: frame }, token);
    },
  };
}

test('host awaits the actual async surface and accepts only its current exact webContents/main-frame/url/nonce', async t => {
  const f = hostFixture(t, true); f.show();
  let done = false; const pending = f.reply.waitForPresentation('前缀：完整文本').then(value => { done = true; return value; });
  await tick(); assert.equal(done, false); assert.equal(f.child().visible, false);
  f.load(); await tick(); assert.equal(f.child().visible, true);
  const token = f.token(); assert.ok(token);
  f.ack(token, f.owner.webContents); f.ack(token, f.child().webContents, { url: f.child().url });
  f.ack('stale-token-000000000000'); await tick(); assert.equal(done, false);
  const url = f.child().webContents.mainFrame.url; f.child().webContents.mainFrame.url = 'https://untrusted.invalid/'; f.ack(token);
  await tick(); assert.equal(done, false); f.child().webContents.mainFrame.url = url;
  f.ack(token); assert.equal(await pending, true);
  assert.equal(await f.reply.waitForPresentation('前缀：完整文本'), false, 'a completed receipt cannot authorize another lease');
  f.show(); await tick(); const next = f.token(); assert.notEqual(next, token, 'explicit same-text update needs a fresh paint');
  const current = f.reply.waitForPresentation('前缀：完整文本');
  f.reply.update({ anchor: { x: 202, y: 212, radius: 110, visible: true } }); assert.equal(f.token(), next);
  f.ack(token); f.ack(next); assert.equal(await current, true);
});

test('host never waits for an absent anchor and owner hide cancels even during surface loading', async t => {
  const absent = hostFixture(t); absent.reply.update({ text: 'no anchor yet', state: 'streaming' });
  assert.equal(await absent.reply.waitForPresentation('no anchor yet'), false);
  await tick(); absent.reply.update({ anchor: { x: 200, y: 210, visible: true } });
  assert.equal(await absent.reply.waitForPresentation('no anchor yet'), false, 'a later anchor cannot replay the invalidated revision');
  const loading = hostFixture(t, true); loading.show('loading'); const pending = loading.reply.waitForPresentation('loading');
  loading.owner.hide(); assert.equal(await pending, false); loading.load(); await tick(); assert.equal(loading.child().visible, false);
});

test('host cancels on actual surface/owner/lifecycle or opacity changes and never accepts a late native ack', async t => {
  for (const cause of ['owner-hide', 'surface-hide', 'owner-minimize', 'surface-minimize', 'interaction-opacity', 'surface-opacity', 'anchor', 'load-failure', 'renderer-gone', 'closed', 'clear', 'dispose'] as const) {
    const f = hostFixture(t); f.show(cause); await tick();
    const token = f.token(), task = f.reply.waitForPresentation(cause);
    if (cause === 'owner-hide') f.owner.hide();
    if (cause === 'surface-hide') f.child().hide();
    if (cause === 'owner-minimize') { f.owner.minimized = true; f.owner.emit('minimize'); }
    if (cause === 'surface-minimize') { f.child().minimized = true; f.child().emit('minimize'); }
    if (cause === 'interaction-opacity') { f.reply.update({ interactionOpacity: 0 }); assert.equal(f.child().visible, true, 'the ordinary CSS fade remains intact'); }
    if (cause === 'surface-opacity') { f.child().opacity = 0; f.ack(token); }
    if (cause === 'anchor') f.reply.update({ anchor: { x: 200, y: 210, visible: false } });
    if (cause === 'load-failure') f.child().webContents.emit('did-fail-load');
    if (cause === 'renderer-gone') f.child().webContents.emit('render-process-gone');
    if (cause === 'closed') f.child().destroy();
    if (cause === 'clear') f.reply.clear();
    if (cause === 'dispose') f.reply.dispose();
    assert.equal(await task, false, cause); f.ack(token);
    assert.equal(await f.reply.waitForPresentation(cause), false, cause);
  }
});

test('host rejects a successful paint invalidated in the same turn before its wait continuation', async t => {
  for (const change of ['hide', 'clear', 'same-text', 'other-text', 'opacity', 'replace-window', 'abort'] as const) {
    const f = hostFixture(t), controller = new AbortController(); f.show('full exact text'); await tick();
    const pending = f.reply.waitForPresentation('full exact text', controller.signal); f.ack(f.token());
    if (change === 'hide') f.child().hide();
    if (change === 'clear') f.reply.clear();
    if (change === 'same-text') f.show('full exact text');
    if (change === 'other-text') f.show('other text');
    if (change === 'opacity') f.reply.update({ interactionOpacity: 0 });
    if (change === 'replace-window') { f.child().destroy(); f.show('full exact text'); }
    if (change === 'abort') controller.abort();
    assert.equal(await pending, false, change);
    assert.equal(f.reply.isPresentationCurrent('full exact text'), false, change);
  }
});

test('wrapper checks fresh native trust and opacity after the helper continuation, even without a hide event', async t => {
  for (const change of ['surface-opacity', 'owner-opacity', 'native-visible', 'url'] as const) {
    const f = hostFixture(t); f.show('current'); await tick();
    const pending = f.reply.waitForPresentation('current'); f.ack(f.token());
    queueMicrotask(() => {
      // This runs after the helper resumes but before the wrapper's own await resumes.
      if (change === 'surface-opacity') f.child().opacity = 0;
      if (change === 'owner-opacity') f.owner.opacity = 0;
      if (change === 'native-visible') f.child().visible = false;
      if (change === 'url') f.child().webContents.mainFrame.url = 'https://untrusted.invalid/';
    });
    assert.equal(await pending, false, change);
    assert.equal(f.reply.isPresentationCurrent('current'), false, change);
  }
});

test('synchronous current-presentation guard rejects changes after await success without creating or renewing receipts', async t => {
  const f = hostFixture(t), controller = new AbortController(); f.show('prefix: final'); await tick();
  assert.equal(f.reply.isPresentationCurrent('prefix: final'), false, 'paint alone is not a committed host wait proof');
  const pending = f.reply.waitForPresentation('prefix: final', controller.signal); f.ack(f.token());
  assert.equal(await pending, true);
  assert.equal(f.reply.isPresentationCurrent('prefix: final'), true); assert.equal(f.reply.isPresentationCurrent('final'), false);
  const sent = f.child().sent.length;
  f.reply.update({ anchor: { x: 202, y: 212, radius: 110, visible: true } });
  assert.equal(f.reply.isPresentationCurrent('prefix: final'), true, 'anchor-only rendering preserves the exact successful proof');
  assert.equal(f.child().sent.length, sent + 1);
  controller.abort(); assert.equal(f.reply.isPresentationCurrent('prefix: final'), false, 'late TTS must see the cancelled lease signal');
  f.show('same rendered text'); await tick();
  const again = f.reply.waitForPresentation('same rendered text'); f.ack(f.token());
  assert.equal(await again, true);
  f.child().opacity = 0; assert.equal(f.reply.isPresentationCurrent('same rendered text'), false);
  f.child().opacity = 1; assert.equal(f.reply.isPresentationCurrent('same rendered text'), false, 'a failed current proof cannot be revived by restoring native opacity');
  f.show('same rendered text'); await tick();
  const fresh = f.reply.waitForPresentation('same rendered text'); f.ack(f.token()); assert.equal(await fresh, true);
  f.show('same rendered text');
  assert.equal(f.reply.isPresentationCurrent('same rendered text'), false, 'same text does not substitute for its previous revision proof');
});

test('final synchronous guard closes the remaining caller-continuation gap after the wrapper has resolved', async t => {
  const f = hostFixture(t); f.show('caller boundary'); await tick();
  const pending = f.reply.waitForPresentation('caller boundary'); f.ack(f.token());
  void Promise.resolve().then(() => queueMicrotask(() => { f.child().opacity = 0; }));
  assert.equal(await pending, true, 'the wrapper was still current at its own continuation');
  assert.equal(f.reply.isPresentationCurrent('caller boundary'), false, 'a host commit must synchronously recheck immediately before mutation');
});

/** Execute only the static preload with local text/RAF fixtures; no BrowserWindow or arbitrary page script. */
function preloadFixture() {
  const received = new EventEmitter(), sent: Array<{ channel: string; token: unknown }> = [];
  const windowEvents = new Map<string, () => void>(), documentEvents = new Map<string, () => void>();
  const frames = new Map<number, () => void>(); let frameId = 0, now = 0;
  const body = { dataset: {} as Record<string, string>, style: {} as Record<string, string>, textContent: '', scrollTop: 0, scrollHeight: 2400,
    getBoundingClientRect: () => ({ left: 20, right: 300, top: 20, bottom: 120, width: 280, height: 100 }) };
  const svg = { dataset: {} as Record<string, string> }, paths = new Map<string, string>();
  const document = { body: { style: { opacity: '1' } }, visibilityState: 'visible',
    getElementById: (id: string) => id === 'reply-body' ? body : id === 'reply-tail' ? svg : null,
    querySelector: () => ({ setAttribute: (key: string, value: string) => { paths.set(key, value); } }),
    addEventListener: (name: string, callback: () => void) => { documentEvents.set(name, callback); } };
  const window = { addEventListener: (name: string, callback: () => void) => { windowEvents.set(name, callback); } };
  const filename = new URL('../electron/reply-preload.ts', import.meta.url), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requireFixture = (name: string) => name === 'electron'
    ? { ipcRenderer: { on: (channel: string, callback: (...args: unknown[]) => void) => { received.on(channel, callback); }, send: (channel: string, token: unknown) => { sent.push({ channel, token }); } } }
    : name === '../shared/reply-waiting-presentation' ? { renderReplyWaiting: (node: typeof body, waiting: boolean) => { if (waiting) node.textContent = '…'; } }
      : name === './reply-pieces-dom' ? createRequire(filename)(name)
      : (() => { throw new Error(`Unexpected static-preload import: ${name}`); })();
  new Function('require', 'module', 'exports', 'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'performance', code)(
    requireFixture, module, module.exports, document, window,
    (callback: () => void) => { const id = ++frameId; frames.set(id, callback); return id; }, (id: number) => frames.delete(id),
    (node: unknown) => node === document.body ? { opacity: document.body.style.opacity } : { display: 'block', visibility: 'visible', opacity: '1' }, { now: () => now });
  const layout: ReplyLayout = { bounds: { x: 0, y: 0, width: 320, height: 140 }, body: { x: 20, y: 20, width: 280, height: 100 },
    tip: { x: 35, y: 132 }, side: 'right', above: true };
  return { sent, body, svg, paths, document,
    render(token: string | null, extra: { text?: string; waiting?: boolean; interactionOpacity?: number } = {}) {
      received.emit('desk:reply-render', {}, { text: '完整的实际浮窗文字', waiting: false, layout, interactionOpacity: 1, presentationToken: token, ...extra });
    },
    frame() { now += 16; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    visibility(value: string) { document.visibilityState = value; documentEvents.get('visibilitychange')?.(); },
    dispose() { windowEvents.get('beforeunload')?.(); },
  };
}

test('static preload acknowledges only after two visible frames, keeps short-tail geometry, and cancels superseded same-text tokens', () => {
  const f = preloadFixture();
  try {
    const first = 'receipt-nonce-000000000001', second = 'receipt-nonce-000000000002', third = 'receipt-nonce-000000000003';
    f.render(first); assert.equal(f.sent.length, 0); f.frame(); assert.equal(f.sent.length, 0); f.frame();
    assert.deepEqual(f.sent, [{ channel: 'desk:reply-presented', token: first }]);
    assert.equal(f.svg.dataset.layoutWidth, '320'); assert.ok(f.paths.get('d')!.includes(' L ')); assert.ok(!f.paths.get('d')!.includes(' Q '));
    f.render(first); f.frame(); f.frame(); assert.equal(f.sent.length, 1);
    f.render(second); f.frame(); f.render(third); f.frame(); f.frame();
    assert.deepEqual(f.sent.map(value => value.token), [first, third]);
  } finally { f.dispose(); }
});

test('static preload never credits hidden, waiting, transparent, blank or no-longer-exact body text', () => {
  const f = preloadFixture();
  try {
    f.visibility('hidden'); f.render('receipt-nonce-000000000011'); f.frame(); f.frame(); assert.equal(f.sent.length, 0);
    f.visibility('visible'); f.frame(); f.frame(); assert.equal(f.sent.length, 1);
    for (const [index, extra] of [{ waiting: true }, { interactionOpacity: 0 }, { text: '   ' }].entries()) {
      f.render(`receipt-nonce-${String(index + 20).padStart(12, '0')}`, extra); f.frame(); f.frame(); assert.equal(f.sent.length, 1);
    }
    f.render('receipt-nonce-000000000031'); f.frame(); f.body.textContent = 'different text before paint'; f.frame();
    assert.equal(f.sent.length, 1);
  } finally { f.dispose(); }
});

test('native preview starts at the first sentence, follows new text, and geometry paints never reset reading position', () => {
  const f = preloadFixture();
  try {
    const first = '第一句。\n第二句。'.repeat(300);
    f.render(null, {text:first}); assert.equal(f.body.scrollTop,0);
    const next = first + '\n新到末句。';
    f.render(null, {text:next}); assert.equal(f.body.scrollTop,f.body.scrollHeight);
    f.body.scrollTop=50; f.render(null,{text:next}); assert.equal(f.body.scrollTop,50);
    f.render(null,{waiting:true,text:''}); f.render(null,{text:'下一轮首句。'}); assert.equal(f.body.scrollTop,0);
  } finally { f.dispose(); }
});
