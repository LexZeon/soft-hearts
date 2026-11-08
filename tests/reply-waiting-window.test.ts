import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { ReplyLayout } from '../electron/reply-layout';
import type { PetReplyUpdate } from '../shared/contracts';

interface Render { text?: string; waiting: boolean; layout: ReplyLayout; interactionOpacity: number; }
interface Reply { update(patch: PetReplyUpdate): { lingerMs: number } | undefined; clear(): void; dispose(): void; }

/** Execute the actual host class with fake Electron boundaries, without an app or native window. */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const windows: WindowFixture[] = [];
  const ipcMain = new EventEmitter();
  class WindowFixture extends EventEmitter {
    visible = false; minimized = false; destroyed = false; top = false;
    bounds = { x: 100, y: 200, width: 400, height: 560 };
    url = '';
    parent: WindowFixture | null = null;
    readonly sent: Render[] = [];
    readonly webContents = Object.assign(new EventEmitter(), {
      send: (_channel: string, value: Render) => this.sent.push(value),
      setWindowOpenHandler: () => {},
      mainFrame: { url: '' },
      getURL: () => this.url,
      isDestroyed: () => this.destroyed,
    });
    constructor(options?: { parent?: WindowFixture }) { super(); this.parent = options?.parent ?? null; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    getOpacity() { return 1; }
    getParentWindow() { return this.parent; }
    isAlwaysOnTop() { return this.top; }
    setAlwaysOnTop(value: boolean) { this.top = value; }
    getBounds() { return { ...this.bounds }; }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value }; }
    setIgnoreMouseEvents() {}
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    hide() { const wasVisible = this.visible; this.visible = false; if (wasVisible) this.emit('hide'); }
    showInactive() { this.visible = true; this.emit('show'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const filename = new URL('../electron/reply-window.ts', import.meta.url);
  const localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const injectedRequire = (name: string) => name === 'electron'
    ? { BrowserWindow: WindowFixture, ipcMain, screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) } }
    : localRequire(name);
  new Function('require', 'module', 'exports', '__dirname', code)(injectedRequire, module, module.exports, path.dirname(fileURLToPath(filename)));
  const owner = new WindowFixture(); owner.visible = true;
  const { PetReplyWindow } = module.exports as { PetReplyWindow: new (owner: WindowFixture) => Reply };
  const reply = new PetReplyWindow(owner);
  t.after(() => reply.dispose());
  return {
    reply, owner, windows, advance: (ms: number) => t.mock.timers.tick(ms),
    child: () => windows[1]!,
    ready: async () => { await Promise.resolve(); },
    waiting: () => reply.update({ state: 'waiting', text: '', anchor: { x: 200, y: 210, radius: 110, visible: true } }),
  };
}

test('native reply waiting survives the old deadline and becomes normal text on its first body', async t => {
  const f = fixture(t); f.waiting(); await f.ready();
  const child = f.child(); assert.equal(child.visible, true);
  assert.equal(child.sent.at(-1)?.waiting, true); assert.equal(child.sent.at(-1)?.text, '');
  assert.equal(child.sent.at(-1)?.layout.body.width, 72); assert.equal(child.sent.at(-1)?.layout.body.height, 44);
  f.advance(120_000); assert.equal(child.visible, true);
  f.reply.update({ state: 'streaming', text: '第一段正文' });
  assert.equal(child.sent.at(-1)?.waiting, false); assert.equal(child.sent.at(-1)?.text, '第一段正文');
  assert.equal(child.sent.at(-1)?.layout.body.width, 285);
  f.advance(30_000); assert.equal(child.visible, true);
  // #5: how long it stays is decided on completion (shared/behaviors/reply-linger/) and returned to the pet window.
  const linger = f.reply.update({ state: 'complete' })!.lingerMs; f.advance(linger - 1); assert.equal(child.visible, true);
  f.advance(1); assert.equal(child.visible, false);
});

test('new waiting cancels a preceding complete timer and anchor paints never renew or restore cleared waiting', async t => {
  const f = fixture(t); f.waiting(); await f.ready();
  const child = f.child();
  f.reply.update({ state: 'complete', text: '旧回答' }); f.advance(4000); f.waiting();
  f.advance(10_000); assert.equal(child.visible, true); assert.equal(child.sent.at(-1)?.waiting, true);
  const count = child.sent.length;
  f.reply.update({ interactionOpacity: 0.45 });
  assert.equal(child.sent.at(-1)?.waiting, true); assert.equal(child.sent.at(-1)?.text, undefined);
  assert.equal(child.sent.length, count + 1);
  f.reply.clear(); f.reply.update({ anchor: { x: 200, y: 210, visible: true } }); f.reply.update({ interactionOpacity: 1 });
  assert.equal(child.visible, false); assert.equal(child.sent.length, count + 1);
  f.waiting(); assert.equal(child.visible, true, 'an explicit new waiting state can begin again');
});

for (const event of ['hide', 'minimize', 'restore'])
  test(`${event} clears native waiting even before the asynchronous window load completes`, async t => {
    const f = fixture(t); f.waiting(); const child = f.child(); f.owner.emit(event); await f.ready();
    assert.equal(child.visible, false);
    f.reply.update({ anchor: { x: 210, y: 220, visible: true } }); f.reply.update({ interactionOpacity: 1 });
    assert.equal(child.visible, false); assert.equal(child.sent.length, 0, event);
  });

test('completion without body clears waiting and has no fabricated reply text', async t => {
  const f = fixture(t); f.waiting(); await f.ready(); const child = f.child();
  f.reply.update({ state: 'complete' }); assert.equal(child.visible, false);
  f.advance(10_000); f.reply.update({ interactionOpacity: 1 }); assert.equal(child.visible, false);
  assert.equal(child.sent.at(-1)?.text, '');
});
