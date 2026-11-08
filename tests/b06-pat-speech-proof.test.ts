import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { PetReplyUpdate } from '../shared/contracts';

/**
 * B06. A head pat fades the
 * reply bubble (interactionOpacity 0). The fade used to burn the bubble's paint
 * receipt for good, so once the pat ended the next sentence's proof could never
 * be renewed and the host cancelled the rest of the readout, while the bubble
 * itself came back normally. These tests drive the real PetReplyWindow with
 * fake native windows (no Electron process, no profile).
 */
interface ReplyHost {
  update(value: PetReplyUpdate): void;
  waitForPresentation(text: string, signal?: AbortSignal): Promise<boolean>;
  isPresentationCurrent(text: string): boolean;
  waitForCompletedPrefix(full: string | (() => string | null), minimumEnd: number, signal: AbortSignal, remainingMs: number, commit: (text: string) => boolean): Promise<boolean>;
  isCompletedPrefixCurrent(text: string): boolean;
  clear(): void;
  dispose(): void;
}
interface Render { presentationToken: string | null; text?: string; interactionOpacity: number }
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function hostFixture(t: TestContext) {
  const windows: WindowFixture[] = [], ipcMain = new EventEmitter();
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
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
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
  return { reply, owner, child,
    show(text: string) { reply.update({ text, state: 'streaming', anchor: { x: 200, y: 210, radius: 110, visible: true } }); },
    /** What the bubble renderer was last told it may acknowledge. */
    token: () => child().sent.at(-1)!.presentationToken,
    /** The bubble renderer painting `token` while it is actually visible. */
    ack(token: unknown) { ipcMain.emit('desk:reply-presented', { sender: child().webContents, senderFrame: child().webContents.mainFrame }, token); },
  };
}

test('B06: after a head pat fades the bubble, the next sentence can still be proven and read aloud', async t => {
  const f = hostFixture(t);
  const body = '第一句。第二句。';
  f.show('第一句。'); await tick();
  let commits = 0;
  const first = f.reply.waitForCompletedPrefix(body, 4, new AbortController().signal, 60_000, () => { commits++; return true; });
  f.ack(f.token()); assert.equal(await first, true, 'baseline: the first sentence is proven');
  // Head pat begins: the bubble fades out (paint only, its window stays up).
  f.reply.update({ interactionOpacity: 0 });
  // The paced bubble reveals the second sentence while it is still faded.
  f.show(body); await tick();
  let settled: boolean | null = null;
  const second = f.reply.waitForCompletedPrefix(body, 8, new AbortController().signal, 60_000, () => { commits++; return true; })
    .then(value => { settled = value; return value; });
  await tick();
  assert.equal(settled, null, 'a faded bubble only delays the proof, it never fails it');
  // Head pat ends: the bubble fades back in and must get a fresh paint receipt for the same text.
  f.reply.update({ interactionOpacity: 1 }); await tick();
  const renewed = f.token();
  assert.ok(renewed, 'the faded-in bubble is given a fresh presentation token');
  f.ack(renewed); assert.equal(await second, true, 'the second sentence is proven after the pat');
  assert.equal(commits, 2);
  assert.equal(f.reply.isCompletedPrefixCurrent(body), true);
});

test('B06: a pat that starts while a sentence is being proven only delays that proof', async t => {
  const f = hostFixture(t);
  const body = '第一句。第二句。';
  f.show('第一句。'); await tick();
  let settled: boolean | null = null;
  const pending = f.reply.waitForCompletedPrefix(body, 4, new AbortController().signal, 60_000, () => true)
    .then(value => { settled = value; return value; });
  await tick();
  const stale = f.token();
  f.reply.update({ interactionOpacity: 0 }); await tick();
  assert.equal(settled, null, 'the fade must not cancel the waiting sentence');
  f.ack(stale); await tick();
  assert.equal(settled, null, 'a receipt minted before the fade cannot prove the faded bubble');
  f.reply.update({ interactionOpacity: 1 }); await tick();
  const renewed = f.token();
  assert.ok(renewed); assert.notEqual(renewed, stale);
  f.ack(renewed); assert.equal(await pending, true);
});

test('B06: the fade-in renewal never proves text the bubble is not showing', async t => {
  const f = hostFixture(t);
  f.show('第一句。'); await tick();
  f.reply.update({ interactionOpacity: 0 }); await tick();
  assert.equal(f.token(), null, 'a faded bubble is never asked to acknowledge');
  // Fading back in after the reply was cleared mints nothing.
  f.reply.clear(); f.reply.update({ interactionOpacity: 1 });
  assert.equal(await f.reply.waitForPresentation('第一句。'), false);
  // A still-faded bubble cannot be proven even with a fresh text update.
  f.show('第二句。'); f.reply.update({ interactionOpacity: 0 }); await tick();
  assert.equal(await f.reply.waitForPresentation('第二句。'), false);
  // Partial fade (pointer hovering near her head) keeps the receipt rules unchanged.
  f.reply.update({ interactionOpacity: 0.5 }); await tick();
  const token = f.token(); assert.ok(token);
  const shown = f.reply.waitForPresentation('第二句。'); f.ack(token);
  assert.equal(await shown, true);
  assert.equal(f.reply.isPresentationCurrent('第一句。'), false, 'only the exact current text is ever current');
});
