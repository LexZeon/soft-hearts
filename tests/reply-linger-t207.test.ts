/**
 * Codex T-207 (2026-11-04) counterexamples for #5 "how long her bubble stays" (docs/claude/2026-11-04-reply-linger.md,
 * section "Codex T-207 反例和修复"). Each minimal case is Codex's, rewritten here; all failed on dae249b:
 *  2A  an emoji bubble after a long sentence was read alone, so the long sentence lost its readable time;
 *  2B  a flag counted 0 characters and a keycap 0.3;
 *  2C  a completion that came while the bubble could not show yet kept counting: once it showed, 167 ms were left;
 *  2D  past the 32000-character preview bound the newest sentences lost their own R27 bubbles.
 * The real host window (electron/reply-window.ts, fake Electron boundaries), the real pet window (src/ui/PetUI.ts, fake DOM
 * and IPC) and the real readout run here; no app window, model or chat record is used.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { PetReplyAnchor, PetReplyUpdate } from '../shared/contracts';
import type { ReplyLingerBubble } from '../shared/behaviors/reply-linger/interface';
import { chooseReplyLinger, lastBubble, readableChars, replyLingerNow } from '../shared/behaviors/reply-linger/choose';
import { REPLY_LINGER_KNOBS } from '../shared/behaviors/reply-linger/knobs';
import { replyPieces } from '../shared/reply-bubbles';
import { PetUI } from '../src/ui/PetUI';
import { ReplyReader } from '../src/ui/ReplyReader';
import { ReplySpeechState } from '../src/ui/reply-speech';
import { ReplyPresentationState } from '../src/ui/reply-presentation';

const { noticeMs, charsPerSecond } = REPLY_LINGER_KNOBS.readable;
const floorFor = (chars: number) => Math.round(noticeMs + chars / charsPerSecond * 1000);
const lingerOf = (bubble: ReplyLingerBubble, roll = 0) => chooseReplyLinger(replyLingerNow(bubble, null), () => roll);

// ------------------------------------------------------------------ 2A, 2B: what there is to read

test('T-207 2A: an emoji bubble after a long sentence rides with it; the long sentence keeps its readable time', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const sentence = '今天多云我陪你慢慢看窗外的花和来来往往的人'.repeat(3) + '。';
  const text = sentence + '😊';
  // The real R27 readout: the sentence shows at once, the emoji becomes its own bubble a moment later (layout untouched).
  const readout = new ReplyPresentationState({ now: Date.now, set: setTimeout, clear: clearTimeout });
  const frames: { at: number; prefix: string; ends: readonly number[] }[] = [];
  readout.startReadout('reply', (prefix, _raw, ends) => frames.push({ at: Date.now(), prefix, ends }));
  readout.readoutContent('reply', text);
  readout.finishReadout('reply', () => {});
  t.mock.timers.tick(4000);
  const last = frames.at(-1)!;
  const pieces = replyPieces(last.prefix, last.ends);
  assert.deepEqual(pieces?.ends, [sentence.length, text.length], 'the emoji is still its own bubble');
  const bubble = { text, pieces, segmented: false };
  assert.equal(lastBubble(bubble), text);
  for (const roll of [0, 0.5, 0.999]) {
    const choice = lingerOf(bubble, roll);
    assert.ok(choice.readMs >= floorFor(64) && choice.ms >= floorFor(64), JSON.stringify(choice));
  }
  // Pieces of emoji or "～" alone ride with the sentence before them; a sentence with words is still read alone.
  assert.equal(lastBubble({ text: '第一句。第二句。🇨🇳1️⃣', pieces: { mode: 'bubbles', ends: [4, 8, 15] }, segmented: false }), '第二句。🇨🇳1️⃣');
  assert.equal(lastBubble({ text: '第一句。好的。', pieces: { mode: 'bubbles', ends: [4, 7] }, segmented: false }), '好的。');
  assert.equal(lastBubble({ text: '😊。🎉', pieces: { mode: 'bubbles', ends: [3, 5] }, segmented: false }), '😊。🎉', 'nothing but emoji: the whole');
});

test('T-207 2B: a flag and a keycap are one emoji each, like any other emoji', () => {
  assert.deepEqual([readableChars('🇨🇳'), readableChars('1️⃣'), readableChars('#️⃣'), readableChars('😊'), readableChars('👍🏻')], [1, 1, 1, 1, 1]);
  const flags = '🇨🇳🇯🇵🇫🇷🇮🇹🇰🇷🇸🇬🇹🇭🇩🇪🇪🇸🇵🇹🇨🇦🇦🇺🇳🇿🇬🇧🇺🇸🇧🇷🇦🇷🇲🇽🇵🇪🇨🇱';
  assert.equal(readableChars(flags), 20);
  const choice = lingerOf({ text: flags, pieces: null, segmented: false });
  assert.ok(choice.ms >= floorFor(20), JSON.stringify(choice));
  // Letters and digits are still letters: "1" alone is a digit, not an emoji.
  assert.equal(readableChars('123'), 1);
});

// ------------------------------------------------------------------ 2C: the countdown starts when it can be seen

interface Reply { update(patch: PetReplyUpdate): { lingerMs: number } | undefined; dispose(): void }

/** The real PetReplyWindow behind fake Electron boundaries, on the mocked clock (timers and Date move together). */
function hostWindow(t: TestContext, options: { lateLoad?: boolean } = {}) {
  const windows: WindowFixture[] = [];
  let loaded: (() => void) | undefined;
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
    loadURL(url: string) {
      this.url = url; this.webContents.mainFrame.url = url;
      return options.lateLoad ? new Promise<void>(resolve => { loaded = resolve; }) : Promise.resolve();
    }
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
  const reply = new PetReplyWindow(owner, bubble => lingerOf(bubble).ms);
  t.after(() => reply.dispose());
  return { reply, child: () => windows[1]!, load: async () => { loaded?.(); await settle(); } };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const FACE = { x: 200, y: 210, radius: 110, visible: true };
const OFF = { ...FACE, visible: false };

test('T-207 2C: a completion that comes before her face is on screen starts counting when the bubble first shows', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = hostWindow(t);
  const text = '嗯。', ms = lingerOf({ text, pieces: null, segmented: false }).ms;
  assert.deepEqual(f.reply.update({ state: 'complete', text, anchor: OFF }), { lingerMs: ms });
  await settle();
  assert.equal(f.child().visible, false, 'no face, no bubble');
  t.mock.timers.tick(ms - 167);
  assert.deepEqual(f.reply.update({ anchor: OFF }), { lingerMs: ms }, 'nothing was counted while it could not be seen');
  f.reply.update({ anchor: FACE });
  assert.deepEqual(f.child().shown, [ms - 167]);
  t.mock.timers.tick(167);
  assert.equal(f.child().visible, true, 'not 167 ms: the whole lifetime from when it showed');
  t.mock.timers.tick(ms - 168);
  assert.equal(f.child().visible, true);
  t.mock.timers.tick(1);
  assert.deepEqual(f.child().hidden, [2 * ms - 167]);
});

test('T-207 2C: a bubble window that loads late, and a face that leaves for a while, never shorten the time on screen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = hostWindow(t, { lateLoad: true });
  const text = '今天天气不错，我们出去走走好不好？';
  const ms = lingerOf({ text, pieces: replyPieces(text), segmented: false }).ms;
  f.reply.update({ state: 'complete', text, pieces: replyPieces(text)!, segmented: false, anchor: FACE });
  t.mock.timers.tick(1500);
  assert.equal(f.child().visible, false, 'still loading');
  await f.load();
  assert.deepEqual(f.child().shown, [1500]);
  t.mock.timers.tick(1000);
  f.reply.update({ anchor: OFF });
  assert.equal(f.child().visible, false, 'her face left the screen');
  t.mock.timers.tick(30_000);
  assert.deepEqual(f.reply.update({ anchor: OFF }), { lingerMs: ms - 1000 }, 'the rest waits for her');
  f.reply.update({ anchor: FACE });
  t.mock.timers.tick(ms - 1001);
  assert.equal(f.child().visible, true);
  t.mock.timers.tick(1);
  assert.equal(f.child().visible, false);
  const child = f.child();
  const onScreen = child.hidden.reduce((sum, hidden, i) => sum + hidden - child.shown[i], 0);
  assert.equal(onScreen, ms, 'on screen for exactly its whole lifetime');
});

test('T-207 2C: a pat or feed fade still counts (user-confirmed: fades never renew or pause)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = hostWindow(t);
  const ms = lingerOf({ text: '好呀。', pieces: null, segmented: false }).ms;
  f.reply.update({ state: 'complete', text: '好呀。', anchor: FACE }); await settle();
  t.mock.timers.tick(500); f.reply.update({ interactionOpacity: 0 });
  t.mock.timers.tick(ms - 501); assert.equal(f.child().visible, true);
  t.mock.timers.tick(1); assert.equal(f.child().visible, false);
});

/** The real pet window wired to the real host window, as electron/main.ts wires updatePetReply. */
function petAndHost(t: TestContext) {
  const host = hostWindow(t);
  const published: PetReplyUpdate[] = [];
  const body = { textContent: '', classList: { remove() {}, add() {}, toggle() { return false; } } };
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  globalThis.document = { getElementById: () => body, querySelectorAll: () => [], body: { classList: { toggle() { return false; } } } } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (patch: PetReplyUpdate) => { published.push(structuredClone(patch)); return host.reply.update(patch); } } } as unknown as Window & typeof globalThis;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const ui = Object.create(PetUI.prototype) as PetUI;
  Object.assign(ui, { anchor: OFF, replyState: 'hidden', replyExpiresAt: 0, replyLingerAsk: 0, replyStreaming: false,
    replySpeech: new ReplySpeechState(), interacting: false, interactionProgress: 0, actions: { error: (message: string) => assert.fail(message) } });
  return { ui, host, published };
}

test('T-207 2C: the pet window and the host count from the same moment the bubble can be seen (her face reported every 100 ms)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { ui, host, published } = petAndHost(t);
  const ms = lingerOf({ text: '嗯。', pieces: null, segmented: false }).ms;
  ui.showAnswer('嗯。', false, 'r1'); await settle();
  for (let at = 100; at <= 2500; at += 100) {
    t.mock.timers.tick(100);
    ui.setFaceAnchor(at < 2500 ? OFF : FACE); await settle();
  }
  assert.deepEqual(host.child().shown, [2500]);
  // Her face keeps being reported every 100 ms until a moment before the host's time is up: the pet window never lets go.
  let at = 2500;
  while (at + 100 < 2500 + ms) { t.mock.timers.tick(100); at += 100; ui.setFaceAnchor(FACE); await settle(); }
  t.mock.timers.tick(2500 + ms - 1 - at); ui.setFaceAnchor(FACE); await settle();
  assert.equal(host.child().visible, true);
  assert.equal(published.some(patch => patch.state === 'hidden'), false, 'the pet window let go before the host');
  t.mock.timers.tick(1);
  assert.deepEqual(host.child().hidden, [2500 + ms], 'the host keeps its whole lifetime from when it showed');
  t.mock.timers.tick(100); ui.setFaceAnchor(FACE); await settle();
  assert.deepEqual(published.at(-1), { state: 'hidden' }, 'and the pet window follows right after');
});

// ------------------------------------------------------------------ 2D: the bounded preview keeps R27 bubbles

test('T-207 2D: past the preview bound the newest sentences keep their own bubbles; the reader keeps every character', async t => {
  const first = '天'.repeat(31_996) + '。', second = '甲。', third = '乙。';
  const full = first + second + third;
  assert.equal(full.length, 32_001);
  const body = { textContent: '', classList: { remove() {} } };
  const readerBody = { textContent: '', scrollTop: 0, focus() {} };
  const dialog = { open: false, showModal() { this.open = true; }, addEventListener() {} };
  const reader = new ReplyReader(dialog as unknown as HTMLDialogElement, readerBody as unknown as HTMLElement,
    { disabled: true } as HTMLButtonElement, {} as HTMLButtonElement, {} as HTMLElement);
  const sent: PetReplyUpdate[] = [];
  const originalDocument = globalThis.document, originalWindow = globalThis.window;
  globalThis.document = { getElementById: () => body } as unknown as Document;
  globalThis.window = { desktop: { updatePetReply: async (patch: PetReplyUpdate) => { sent.push(patch); } } } as unknown as Window & typeof globalThis;
  t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
  const ui = Object.create(PetUI.prototype) as PetUI;
  Object.assign(ui, { replySpeech: new ReplySpeechState(), replyState: 'hidden', replyLingerAsk: 0, interactionProgress: 0,
    actions: { error: (message: string) => assert.fail(message) }, replyReader: reader });
  // Control: exactly at the bound, three sentences are three bubbles.
  ui.showAnswer(full.slice(1), true, 'control', false, [first.length - 1, first.length + second.length - 1, full.length - 1]);
  assert.deepEqual(sent.at(-1)?.pieces?.ends, [31_996, 31_998, 32_000]);
  ui.showAnswer(full, true, 'long-reply', false, [first.length, first.length + second.length, full.length]);
  ui.finishAnswer(full, 'long-reply', false, true);
  await ui.flushReplyPublication();
  reader.open();
  assert.equal(readerBody.textContent, full, 'the full reader keeps every UTF-16 code unit');
  const preview = sent.filter(patch => patch.text?.endsWith(third)).at(-1)!;
  assert.ok(preview.text!.length <= 32_000 && preview.text!.endsWith(second + third));
  assert.equal(preview.pieces?.mode, 'bubbles');
  const ends = preview.pieces!.ends, text = preview.text!;
  const shown = ends.map((end, i) => text.slice(i ? ends[i - 1] : 0, end).trim());
  assert.deepEqual(shown.slice(-2), [second, third], 'each kept sentence is its own bubble');
  assert.ok(shown[0].startsWith('…') && shown.length === 4, JSON.stringify(shown.map(piece => piece.slice(0, 12))));
  // Streaming on past the bound keeps doing so (the window follows the newest sentences).
  const fourth = '丙。';
  ui.showAnswer(full + fourth, true, 'long-reply', false, [first.length, first.length + second.length, full.length, full.length + 2]);
  const next = sent.at(-1)!;
  assert.ok(next.text!.endsWith(third + fourth));
  assert.deepEqual(next.pieces!.ends.slice(-3).map((end, i, all) => next.text!.slice(i ? all[i - 1] : next.pieces!.ends.at(-4)!, end)), [second, third, fourth]);
});
