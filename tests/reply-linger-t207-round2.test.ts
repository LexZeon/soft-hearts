/**
 * Codex T-207 round 2 (2026-11-04, bridge X-257, pinned 9f58785) counterexample for #5 "how long her bubble stays"
 * (docs/claude/2026-11-04-reply-linger.md, section "Codex 第二轮反例和修复"). "嗯。" completed at t=0 while her face was not
 * on screen, and no face anchor came until t=2800 ms. The host was still owed its whole lifetime (it counts only while the
 * bubble can be seen), but the pet window had counted its own deadline from the completion and sent 'hidden' first: the
 * bubble was on screen for 0 ms. The rule held here: while the host still owes time, the pet window never hides first, and
 * from the first moment a reply can be seen it stays at least its readable floor (in fact its whole lifetime).
 * The real pet window (src/ui/PetUI.ts, fake DOM and IPC) drives the real host window (electron/reply-window.ts, fake
 * Electron boundaries) as electron/main.ts wires updatePetReply; no app window, model or chat record is used.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { PetReplyUpdate } from '../shared/contracts';
import type { ReplyLingerBubble } from '../shared/behaviors/reply-linger/interface';
import { chooseReplyLinger, replyLingerNow } from '../shared/behaviors/reply-linger/choose';
import { REPLY_LINGER_KNOBS } from '../shared/behaviors/reply-linger/knobs';
import { replyPieces } from '../shared/reply-bubbles';
import { PetUI } from '../src/ui/PetUI';
import { ReplySpeechState } from '../src/ui/reply-speech';

const lingerOf = (bubble: ReplyLingerBubble) => chooseReplyLinger(replyLingerNow(bubble, null), () => 0);
const FACE = { x: 200, y: 210, radius: 110, visible: true };
const OFF = { ...FACE, visible: false };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

interface Reply { update(patch: PetReplyUpdate): { lingerMs: number } | undefined; dispose(): void }

/** The real PetReplyWindow behind fake Electron boundaries; records when its bubble window is shown and hidden. */
function hostWindow(t: TestContext) {
  const windows: WindowFixture[] = [];
  class WindowFixture extends EventEmitter {
    visible = false; destroyed = false;
    shown: number[] = []; hidden: number[] = [];
    bounds = { x: 100, y: 200, width: 400, height: 560 };
    url = '';
    parent: WindowFixture | null = null;
    readonly webContents = Object.assign(new EventEmitter(), {
      send: () => {}, setWindowOpenHandler: () => {}, mainFrame: { url: '' }, getURL: () => this.url, isDestroyed: () => this.destroyed,
    });
    constructor(init?: { parent?: WindowFixture }) { super(); this.parent = init?.parent ?? null; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    getOpacity() { return 1; }
    getParentWindow() { return this.parent; }
    isAlwaysOnTop() { return false; }
    setAlwaysOnTop() {}
    getBounds() { return { ...this.bounds }; }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value }; }
    setIgnoreMouseEvents() {}
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    hide() { if (this.visible) { this.visible = false; this.hidden.push(Date.now()); this.emit('hide'); } }
    showInactive() { if (!this.visible) { this.visible = true; this.shown.push(Date.now()); this.emit('show'); } }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const filename = new URL('../electron/reply-window.ts', import.meta.url);
  const localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const injected = (name: string) => name === 'electron'
    ? { BrowserWindow: WindowFixture, ipcMain: new EventEmitter(), screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) } }
    : localRequire(name);
  new Function('require', 'module', 'exports', '__dirname', code)(injected, module, module.exports, path.dirname(fileURLToPath(filename)));
  const owner = new WindowFixture(); owner.visible = true;
  const { PetReplyWindow } = module.exports as { PetReplyWindow: new (owner: WindowFixture, linger: (bubble: ReplyLingerBubble) => number) => Reply };
  const decided: number[] = [];
  const reply = new PetReplyWindow(owner, bubble => { const ms = lingerOf(bubble).ms; decided.push(ms); return ms; });
  t.after(() => reply.dispose());
  return { reply, decided, child: () => windows[1]! };
}

/** The real pet window wired to the real host window; her face starts off screen, as at the start of Codex's case. */
function petAndHost(t: TestContext) {
  const host = hostWindow(t);
  const published: { at: number; patch: PetReplyUpdate }[] = [];
  const body = { textContent: '', classList: { remove() {}, add() {}, toggle() { return false; } } };
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  globalThis.document = { getElementById: () => body, querySelectorAll: () => [], body: { classList: { toggle() { return false; } } } } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (patch: PetReplyUpdate) => {
    published.push({ at: Date.now(), patch: structuredClone(patch) });
    return host.reply.update(patch);
  } } } as unknown as Window & typeof globalThis;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const ui = Object.create(PetUI.prototype) as PetUI;
  Object.assign(ui, { anchor: OFF, replyState: 'hidden', replyExpiresAt: 0, replyLingerAsk: 0, replyStreaming: false,
    replySpeech: new ReplySpeechState(), interacting: false, interactionProgress: 0, actions: { error: (message: string) => assert.fail(message) } });
  const hiddenAt = () => published.filter(entry => entry.patch.state === 'hidden').map(entry => entry.at);
  return { ui, host, published, hiddenAt };
}

/** Her face reported every 100 ms from `from` until `until`, as the stage does while it renders. */
async function faceEvery100(t: TestContext, ui: PetUI, from: number, until: number, anchor = FACE) {
  for (let at = from; at <= until; at += 100) {
    t.mock.timers.tick(at - Date.now());
    ui.setFaceAnchor(anchor); await settle();
  }
}

test('T-207 round 2: a face anchor that first comes at 2800 ms, with no callback before it, still shows the whole reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { ui, host, hiddenAt } = petAndHost(t);
  const text = '嗯。', choice = lingerOf({ text, pieces: null, segmented: false });
  ui.showAnswer(text, false, 'late-anchor'); await settle();
  assert.equal(host.child().visible, false, 'no face, no bubble');
  t.mock.timers.tick(2800);
  assert.deepEqual(host.reply.update({ anchor: OFF }), { lingerMs: choice.ms }, 'the host still owes its whole lifetime');
  ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(host.child().shown, [2800], 'it shows when her face first does');
  assert.deepEqual(hiddenAt(), [], 'the pet window did not hide it first');
  // From then on: on screen for at least its readable floor, in fact for its whole lifetime, with or without callbacks.
  t.mock.timers.tick(choice.readMs);
  assert.equal(host.child().visible, true, 'the readable floor');
  t.mock.timers.tick(choice.ms - choice.readMs - 1);
  assert.equal(host.child().visible, true);
  t.mock.timers.tick(1);
  assert.deepEqual(host.child().hidden, [2800 + choice.ms]);
  assert.deepEqual(hiddenAt(), [], 'the host ended it; the pet window never sent hidden before that');
  t.mock.timers.tick(100); ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(hiddenAt(), [2800 + choice.ms + 100], 'and the pet window follows right after');
});

test('T-207 round 2: however late her face first comes (past the pet window\'s own longest), the reply shows for its whole lifetime', async t => {
  for (const late of [2500, 2800, 5000, REPLY_LINGER_KNOBS.range[1] + 5000]) await t.test(`${late} ms`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const { ui, host, hiddenAt } = petAndHost(t);
    const text = '今天天气不错，我们出去走走好不好？', pieces = replyPieces(text);
    ui.showAnswer(text, false, 'r', false, pieces?.ends); await settle();
    assert.equal(host.decided.length, 1);
    const ms = host.decided[0];
    assert.ok(ms >= lingerOf({ text, pieces: null, segmented: false }).readMs);
    t.mock.timers.tick(late);
    ui.setFaceAnchor(FACE); await settle();
    assert.deepEqual(host.child().shown, [late]);
    await faceEvery100(t, ui, late + 100, late + ms - 1);
    assert.equal(host.child().visible, true);
    assert.deepEqual(hiddenAt(), [], 'never hidden while the host still owes time');
    t.mock.timers.tick(late + ms - Date.now());
    assert.deepEqual(host.child().hidden, [late + ms]);
  });
});

test('T-207 round 2: her face leaving with no callbacks for a long while does not let the pet window end the reply early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { ui, host, hiddenAt } = petAndHost(t);
  const text = '嗯，我在呢。', ms = lingerOf({ text, pieces: null, segmented: false }).ms;
  ui.setFaceAnchor(FACE);
  ui.showAnswer(text, false, 'leave'); await settle();
  assert.deepEqual(host.child().shown, [0]);
  await faceEvery100(t, ui, 100, 1000);
  ui.setFaceAnchor(OFF); await settle();
  assert.equal(host.child().visible, false, 'her face left the screen');
  // Ten seconds with no callback at all (longer than the whole lifetime), then her face is back.
  t.mock.timers.tick(10_000);
  ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(hiddenAt(), [], 'the pet window kept the reply the host still owed time');
  assert.deepEqual(host.child().shown, [0, 11_000]);
  t.mock.timers.tick(ms - 1000 - 1);
  assert.equal(host.child().visible, true);
  t.mock.timers.tick(1);
  const child = host.child();
  assert.equal(child.hidden.reduce((sum, hidden, i) => sum + hidden - child.shown[i], 0), ms, 'on screen for exactly its whole lifetime');
});

test('T-207 round 2: the pet window\'s own count waits while her face is away, even with no answer to its position updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  // A host that answers only the completion (3000 ms) and nothing else: what is left is this window's own count.
  const published: { at: number; patch: PetReplyUpdate }[] = [];
  const body = { textContent: '', classList: { remove() {}, add() {}, toggle() { return false; } } };
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  globalThis.document = { getElementById: () => body, querySelectorAll: () => [], body: { classList: { toggle() { return false; } } } } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (patch: PetReplyUpdate) => {
    published.push({ at: Date.now(), patch: structuredClone(patch) });
    return patch.state === 'complete' ? { lingerMs: 3000 } : undefined;
  } } } as unknown as Window & typeof globalThis;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const ui = Object.create(PetUI.prototype) as PetUI;
  Object.assign(ui, { anchor: FACE, replyState: 'hidden', replyExpiresAt: 0, replyLingerAsk: 0, replyStreaming: false,
    replySpeech: new ReplySpeechState(), interacting: false, interactionProgress: 0, actions: { error: (message: string) => assert.fail(message) } });
  const hidden = () => published.filter(entry => entry.patch.state === 'hidden').map(entry => entry.at);
  ui.showAnswer('嗯。', false, 'own'); await settle();
  t.mock.timers.tick(1000); ui.setFaceAnchor(OFF); await settle();
  t.mock.timers.tick(9000); ui.setFaceAnchor(FACE); await settle();
  t.mock.timers.tick(1999); ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(hidden(), [], '2000 ms were left when her face went away');
  t.mock.timers.tick(1); ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(hidden(), [12_000]);
});

test('T-207 round 2 control: in sight the whole time, the pet window still ends the reply exactly when the host does', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { ui, host, hiddenAt } = petAndHost(t);
  const text = '好呀。', ms = lingerOf({ text, pieces: null, segmented: false }).ms;
  ui.setFaceAnchor(FACE);
  ui.showAnswer(text, false, 'control'); await settle();
  // No callback until long after: the host ends it on time by itself, and the pet window lets go at its next update.
  t.mock.timers.tick(ms);
  assert.deepEqual(host.child().hidden, [ms]);
  t.mock.timers.tick(5000);
  ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(hiddenAt(), [ms + 5000]);
});

test('T-207 round 2: a pat or feed fade still counts from the moment it can be seen (user-confirmed: fades never renew or pause)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { ui, host, hiddenAt } = petAndHost(t);
  const text = '嗯。', ms = lingerOf({ text, pieces: null, segmented: false }).ms;
  assert.ok(ms < 2800, 'shorter than the wait for her face, as in Codex\'s case');
  ui.showAnswer(text, false, 'fade'); await settle();
  t.mock.timers.tick(2800);
  ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(host.child().shown, [2800]);
  t.mock.timers.tick(500);
  ui.setInteraction(true); await settle();
  t.mock.timers.tick(ms - 501);
  assert.equal(host.child().visible, true);
  t.mock.timers.tick(1);
  assert.deepEqual(host.child().hidden, [2800 + ms], 'the fade neither renewed nor paused it');
  ui.setInteraction(false); await settle();
  assert.deepEqual(hiddenAt().length, 1, 'the pet window let go too');
});
