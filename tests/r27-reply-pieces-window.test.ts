import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import type { PetReplyPieces, PetReplyUpdate } from '../shared/contracts';
import type { ReplyLayout } from '../electron/reply-layout';
import { validateReplyUpdate } from '../electron/reply-input';
import { replyPieces } from '../shared/reply-bubbles';

const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

// ---- Minimal DOM: enough for the static reply preload and its piece renderer.
class FakeText { parent: FakeElement | null = null; constructor(public data: string) {} get textContent() { return this.data; } }
class FakeElement {
  className = ''; dataset: Record<string, string> = {}; style: Record<string, string> = {}; scrollTop = 0; scrollHeight = 2400;
  childNodes: Array<FakeElement | FakeText> = []; parent: FakeElement | null = null; attributes = new Map<string, string>();
  constructor(readonly ownerDocument: FakeDocument, readonly tagName: string) {}
  get children() { return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean), write = (list: string[]) => { this.className = list.join(' '); };
    return { contains: (name: string) => names().includes(name), add: (name: string) => { if (!names().includes(name)) write([...names(), name]); },
      remove: (name: string) => write(names().filter(value => value !== name)),
      toggle: (name: string, force?: boolean) => { const on = force ?? !names().includes(name); write(on ? [...new Set([...names(), name])] : names().filter(value => value !== name)); return on; } };
  }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(...(value ? [new FakeText(value)] : [])); }
  append(...nodes: Array<FakeElement | FakeText>) { for (const node of nodes) { if (node.parent) node.parent.childNodes.splice(node.parent.childNodes.indexOf(node), 1); node.parent = this; this.childNodes.push(node); } }
  replaceChildren(...nodes: Array<FakeElement | FakeText>) { for (const node of this.childNodes) node.parent = null; this.childNodes = []; this.append(...nodes); }
  replaceWith(node: FakeElement) { const parent = this.parent!; parent.childNodes[parent.childNodes.indexOf(this)] = node; node.parent = parent; this.parent = null; }
  remove() { if (this.parent) this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getBoundingClientRect() { return { left: 20, right: 300, top: 20, bottom: 120, width: 280, height: 100 }; }
}
class FakeDocument {
  visibilityState = 'visible'; readonly body = new FakeElement(this, 'body'); readonly replyBody = new FakeElement(this, 'div');
  readonly svg = new FakeElement(this, 'svg'); readonly path = new FakeElement(this, 'path'); readonly events = new Map<string, () => void>();
  createElement(tag: string) { return new FakeElement(this, tag); }
  createTextNode(value: string) { return new FakeText(value); }
  getElementById(id: string) { return id === 'reply-body' ? this.replyBody : id === 'reply-tail' ? this.svg : null; }
  querySelector() { return this.path; }
  addEventListener(name: string, callback: () => void) { this.events.set(name, callback); }
}

/** Executes the actual static preload (and its real piece renderer) against the fake DOM. */
function preloadFixture() {
  const received = new EventEmitter(), sent: unknown[] = [], frames = new Map<number, () => void>(); let frameId = 0, now = 0;
  const document = new FakeDocument(), window = { addEventListener() {} };
  const filename = new URL('../electron/reply-preload.ts', import.meta.url), localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requireFixture = (name: string) => name === 'electron'
    ? { ipcRenderer: { on: (channel: string, callback: (...args: unknown[]) => void) => { received.on(channel, callback); }, send: (_channel: string, token: unknown) => { sent.push(token); } } }
    : name === '../shared/reply-waiting-presentation' ? { renderReplyWaiting: (node: FakeElement, waiting: boolean) => { if (waiting) node.textContent = '…'; } }
      : name === './reply-pieces-dom' ? localRequire(name) : (() => { throw new Error(`Unexpected static-preload import: ${name}`); })();
  new Function('require', 'module', 'exports', 'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'performance', code)(
    requireFixture, module, module.exports, document, window,
    (callback: () => void) => { const id = ++frameId; frames.set(id, callback); return id; }, (id: number) => frames.delete(id),
    () => ({ display: 'block', visibility: 'visible', opacity: '1' }), { now: () => now });
  const layout: ReplyLayout = { bounds: { x: 0, y: 0, width: 320, height: 140 }, body: { x: 20, y: 20, width: 280, height: 100 }, tip: { x: 35, y: 132 }, side: 'right', above: true };
  const body = document.replyBody;
  return { body, sent,
    render(text: string | undefined, pieces: PetReplyPieces | null, token: string | null = null, waiting = false) {
      received.emit('desk:reply-render', {}, { ...(text === undefined ? {} : { text }), waiting, segmented: false, pieces, layout, interactionOpacity: 1, presentationToken: token });
    },
    frame() { now += 16; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    chunks: () => body.children.map(node => ({ node, text: node.textContent, classes: node.className })) };
}

test('R27 native same-bubble policy: one bubble grows by natural paragraphs without re-rendering earlier text', () => {
  const f = preloadFixture();
  const steps = ['嗯，我在呢。', '嗯，我在呢。今天累不累？', '嗯，我在呢。今天累不累？\n\n要不要', '嗯，我在呢。今天累不累？\n\n要不要跟我说说？'];
  f.render(steps[0], replyPieces(steps[0], [6], 'same-bubble'));
  const first = f.chunks()[0].node;
  for (const text of steps.slice(1)) {
    f.render(text, replyPieces(text, [6, 12], 'same-bubble'));
    assert.equal(f.body.textContent, text, 'the painted body is exactly the host text revision');
  }
  assert.equal(f.body.dataset.pieces, 'paragraphs');
  const chunks = f.chunks();
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].node, first, 'the first paragraph node is reused, never rebuilt');
  assert.equal(chunks[0].text, '嗯，我在呢。今天累不累？', 'two sentences in one paragraph: no inserted line break');
  assert.match(chunks[1].classes, /reply-chunk-gap/); assert.doesNotMatch(chunks[0].classes, /reply-chunk-past/);
  // Receipt semantics are unchanged: two visible frames, then this exact token.
  f.render(undefined, replyPieces(steps[3], [6, 12], 'same-bubble'), 'receipt-nonce-000000000101'); f.frame(); f.frame();
  assert.deepEqual(f.sent, ['receipt-nonce-000000000101']);
});

test('R27 native alternative: each sentence is its own bubble; the newest is current and a blank tail never dims it', () => {
  const f = preloadFixture();
  f.render('第一句。', replyPieces('第一句。', [4], 'bubble-per-sentence'));
  f.render('第一句。\n\n', replyPieces('第一句。\n\n', [4], 'bubble-per-sentence'));
  let chunks = f.chunks();
  assert.equal(f.body.dataset.pieces, 'bubbles');
  assert.deepEqual(chunks.map(chunk => chunk.text), ['第一句。', '\n\n']);
  assert.doesNotMatch(chunks[0].classes, /reply-chunk-past/); assert.match(chunks[1].classes, /reply-chunk-blank/);
  f.render('第一句。\n\n第二句。', replyPieces('第一句。\n\n第二句。', [4], 'bubble-per-sentence'));
  chunks = f.chunks();
  assert.equal(chunks.length, 2); assert.equal(f.body.textContent, '第一句。\n\n第二句。');
  assert.match(chunks[0].classes, /reply-chunk-past/); assert.doesNotMatch(chunks[1].classes, /reply-chunk-past|reply-chunk-blank/);
  assert.match(chunks[1].classes, /reply-chunk-new/);
});

test('R27 native fallback: waiting, mismatched or absent pieces keep the original plain rendering', () => {
  const f = preloadFixture();
  f.render('第一句。第二句。', { mode: 'bubbles', ends: [4, 99] });
  assert.equal(f.body.dataset.pieces, undefined); assert.equal(f.body.children.length, 0); assert.equal(f.body.textContent, '第一句。第二句。');
  f.render('第一句。第二句。', replyPieces('第一句。第二句。', [4], 'bubble-per-sentence'));
  assert.equal(f.body.children.length, 2);
  f.render('第一句。第二句。', null);
  assert.equal(f.body.children.length, 0, 'same text without pieces returns to the plain body'); assert.equal(f.body.textContent, '第一句。第二句。');
  f.render('', replyPieces('第一句。', [4]), null, true);
  assert.equal(f.body.dataset.pieces, undefined, 'the waiting dots never inherit a piece layout');
});

// ---- Actual host class with fake native boundaries (same approach as reply-presentation-window.test.ts).
function hostFixture(t: TestContext) {
  const windows: WindowFixture[] = [], ipcMain = new EventEmitter();
  class WindowFixture extends EventEmitter {
    visible = false; minimized = false; destroyed = false; opacity = 1; top = false; url = ''; bounds = { x: 100, y: 150, width: 400, height: 560 };
    readonly parent: WindowFixture | null; readonly sent: Array<Record<string, unknown>> = [];
    readonly webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, getURL: () => this.url, isDestroyed: () => this.destroyed,
      send: (_channel: string, value: Record<string, unknown>) => { this.sent.push(value); }, setWindowOpenHandler: () => {} });
    constructor(options?: { parent?: WindowFixture }) { super(); this.parent = options?.parent ?? null; windows.push(this); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    getOpacity() { return this.opacity; } getParentWindow() { return this.parent; } isAlwaysOnTop() { return this.top; } setAlwaysOnTop(value: boolean) { this.top = value; }
    getBounds() { return { ...this.bounds }; } setBounds(value: typeof this.bounds) { this.bounds = { ...value }; } setIgnoreMouseEvents() {}
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    showInactive() { this.visible = true; this.emit('show'); } hide() { const changed = this.visible; this.visible = false; if (changed) this.emit('hide'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const filename = new URL('../electron/reply-window.ts', import.meta.url), localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requireFixture = (name: string) => name === 'electron' ? { BrowserWindow: WindowFixture, ipcMain,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) } } : localRequire(name);
  new Function('require', 'module', 'exports', '__dirname', code)(requireFixture, module, module.exports, path.dirname(fileURLToPath(filename)));
  const owner = new WindowFixture(); owner.visible = true;
  type Host = { update(value: PetReplyUpdate): void; waitForCompletedPrefix(full: string, end: number, signal: AbortSignal, ms: number, commit: (text: string) => boolean): Promise<boolean>;
    setObserver(observer: { rendered(text: string): void; painted(text: string): void } | null): void; dispose(): void };
  const { PetReplyWindow } = module.exports as { PetReplyWindow: new (owner: WindowFixture) => Host }, reply = new PetReplyWindow(owner);
  t.after(() => reply.dispose());
  const anchor = { x: 200, y: 210, radius: 110, visible: true };
  return { reply, child: () => windows[1]!,
    show(update: PetReplyUpdate) { reply.update(validateReplyUpdate({ state: 'streaming', anchor, ...update })); },
    ack() { const child = windows[1]!; ipcMain.emit('desk:reply-presented', { sender: child.webContents, senderFrame: child.webContents.mainFrame }, child.sent.at(-1)!.presentationToken); } };
}

test('R27 host forwards pieces with their exact text revision and the completed-prefix speech proof still holds', async t => {
  const f = hostFixture(t), events: string[] = [];
  f.reply.setObserver({ rendered: text => events.push(`rendered:${text.length}`), painted: text => events.push(`painted:${text.length}`) });
  f.show({ state: 'waiting', text: '' }); await tick();
  const text = '第一句。第二句。', pieces = replyPieces(text, [4], 'bubble-per-sentence')!;
  f.show({ text, pieces, segmented: false }); await tick();
  assert.deepEqual(f.child().sent.at(-1)!.pieces, pieces); assert.equal(f.child().sent.at(-1)!.text, text);
  const proof = f.reply.waitForCompletedPrefix(text, 4, new AbortController().signal, 10000, candidate => candidate === text);
  f.ack(); assert.equal(await proof, true, 'pieces never block the prefix proof that authorizes segment speech');
  f.reply.update({ anchor: { x: 205, y: 210, radius: 110, visible: true } });
  assert.deepEqual(f.child().sent.at(-1)!.pieces, pieces, 'anchor-only renders keep the current layout');
  f.show({ text: text + '尾' });
  assert.equal(f.child().sent.at(-1)!.pieces, null, 'a new text revision without pieces never reuses stale offsets');
  assert.deepEqual(events, ['rendered:8', 'painted:8', 'rendered:9'], 'the developer timing observer sees only real reply text');
  assert.throws(() => validateReplyUpdate({ state: 'streaming', pieces }), 'pieces without their text are rejected');
  assert.throws(() => validateReplyUpdate({ state: 'streaming', text, segmented: true, pieces }));
  assert.throws(() => validateReplyUpdate({ state: 'streaming', text: '第一句。', pieces }));
});
