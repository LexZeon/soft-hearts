// Unbound v1 step 2, typing to her: a single click on her reports ONE touch and opens the small box beside her head (no scripted
// reaction), the shortcut exists only while she is out, Enter sends through the chat path, the senses light follows what is on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLICK_RULES, ClickClassifier } from '../shared/unbound/click';
import { INPUT_BOX_SIZE, enterSends, parseUnboundAnchor, parseUnboundTouch, placeBubble, placeInputBox, rectHitsHead, type HeadSpot, type UnboundTouchReport } from '../shared/unbound/typing';
import { ClickReporter, CLICK_MARGIN_PX, type ClickReporterPorts } from '../src/unbound/click-reporter';
import { SUBMIT_HINTS, TYPING_SHORTCUT, UnboundTyping, type InputBoxPort, type SayResult, type TypingPorts } from '../electron/unbound/typing';
import { UnboundHost, type UnboundHostPorts, type UnboundIpcEvent, type UnboundWindowLike } from '../electron/unbound/host';
import { type PetPort } from '../electron/unbound/mode';
import { unboundSource } from '../electron/unbound/source';
import { createUnboundApi, UNBOUND_API_KEYS, type UnboundIpc } from '../electron/unbound/preload-api';
import { createUnboundInputApi, UNBOUND_INPUT_API_KEYS, UNBOUND_INPUT_CHANNELS } from '../electron/unbound/input-preload-api';
import { UNBOUND_INPUT_PRELOAD, inputWindowOptions, unboundWindowOptions } from '../electron/unbound/window-options';
import { UNBOUND_EVENTS, UNBOUND_REQUESTS, type UnboundScene, type UnboundState } from '../shared/unbound/scene';
import { reportTouch, setTouchSink } from '../electron/mood/touch/sink';
import { TOUCH_PARTS, type TouchEvent } from '../shared/mood/touch';
import type { DisplayFacts, Rect } from '../shared/unbound/world';
import type { PeekPorts } from '../electron/unbound/peek';
import { CURIOUS } from './helpers/unbound-peek';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import { readFileSync } from 'node:fs';

const AREA: Rect = { x: 0, y: 0, width: 1536, height: 912 };

// ---- pure: what a click is -----------------------------------------------------------------------------------------------------

test('a click is a quick press and release that stay in place on her; a hold, a drag, or a press off her is not', () => {
  const c = new ClickClassifier();
  c.down(100, 100, 0, true); assert.equal(c.up(102, 101, 120), true, 'quick, in place');
  c.down(100, 100, 1000, true); assert.equal(c.up(100, 100, 1000 + CLICK_RULES.maxHoldMs + 1), false, 'held: that is for pulling (step 5)');
  c.down(100, 100, 2000, true); assert.equal(c.up(100 + CLICK_RULES.maxMovePx + 1, 100, 2100), false, 'dragged');
  c.down(100, 100, 3000, false); assert.equal(c.up(100, 100, 3050), false, 'pressed somewhere else');
  assert.equal(c.up(100, 100, 3100), false, 'a release with no press');
  c.down(100, 100, 4000, true); c.cancel(); assert.equal(c.up(100, 100, 4050), false, 'cancelled (window hidden)');
  for (const [x, y, at] of [[NaN, 1, 1], [1, Infinity, 1], [1, 1, NaN]] as const) { c.down(x, y, at, true); assert.equal(c.up(1, 1, 2), false, 'non-numbers never click'); }
});

test('a double click reports once (double click stays free); a third click a moment later is a new one', () => {
  const c = new ClickClassifier();
  c.down(50, 50, 0, true); assert.equal(c.up(50, 50, 60), true);
  c.down(51, 50, 200, true); assert.equal(c.up(51, 50, 260), false, 'the second click of a double click');
  c.down(51, 50, 330, true); assert.equal(c.up(51, 50, 380), true, 'a third quick click is not part of that pair');
  c.down(50, 50, 5_000, true); assert.equal(c.up(50, 50, 5_050), true, 'later: a new click');
  c.down(200, 50, 5_200, true); assert.equal(c.up(200, 50, 5_250), true, 'near in time but far apart: not a double click');
});

test('the page report and the host question are parsed strictly', () => {
  const head = { x: 400, y: 300, r: 60 };
  assert.deepEqual(parseUnboundTouch({ part: 'hand', side: 'left', head }), { part: 'hand', side: 'left', head });
  assert.deepEqual(parseUnboundTouch({ part: 'torso', side: null, head: null }), { part: 'torso', side: null, head: null });
  assert.deepEqual(parseUnboundTouch({ part: 'torso', head: { x: 'a', y: 1, r: 1 } }), { part: 'torso', side: null, head: null }, 'a bad head is dropped, the touch stays');
  for (const bad of [null, 'x', [], {}, { part: 'tail', side: null }, { part: 'hand', side: 'middle' }, { part: 'hand', side: 3 }]) assert.equal(parseUnboundTouch(bad), null, JSON.stringify(bad));
  for (const part of TOUCH_PARTS) assert.ok(parseUnboundTouch({ part, side: null }), part);
  assert.deepEqual(parseUnboundAnchor({ id: 'h3', head }), { id: 'h3', head });
  assert.equal(parseUnboundAnchor({ id: '../x', head }), null);
  assert.equal(parseUnboundAnchor({ head }), null);
  assert.equal(parseUnboundAnchor({ id: 'h1', head: { x: 1, y: 1, r: -4 } })?.head, null);
});

// ---- pure: where things go -----------------------------------------------------------------------------------------------------

test('the input box goes beside her head, never over her face, always inside the work area', () => {
  const heads: HeadSpot[] = [];
  for (const x of [20, 150, 500, 768, 1100, 1400, 1520]) for (const y of [30, 200, 450, 700, 890]) for (const r of [18, 60, 140]) heads.push({ x, y, r });
  const sides = new Set<string>();
  for (const head of heads) {
    const box = placeInputBox(head, AREA);
    sides.add(box.side);
    assert.ok(box.x >= AREA.x && box.y >= AREA.y && box.x + box.width <= AREA.x + AREA.width && box.y + box.height <= AREA.y + AREA.height, `inside ${JSON.stringify(head)} ${JSON.stringify(box)}`);
    if (box.side !== 'below') assert.equal(rectHitsHead(box, head), false, `off her face ${JSON.stringify(head)} -> ${box.side}`);
    else assert.ok(box.y >= head.y + head.r - 1, 'below: under her chin');
  }
  assert.ok(sides.has('right') && sides.has('left'), `both sides get used: ${[...sides]}`);
  const middle = placeInputBox({ x: 768, y: 450, r: 60 }, AREA);
  assert.equal(middle.side, 'right');
  assert.equal(middle.x, 768 + 60 + 14, 'a small gap from her head');
  assert.equal(middle.y, 450 - INPUT_BOX_SIZE.height / 2, 'level with her face');
  assert.equal(placeInputBox({ x: 1500, y: 450, r: 60 }, AREA).side, 'left', 'no room on the right: the left');
  const corner = placeInputBox(null, AREA);
  assert.equal(corner.side, 'corner');
  assert.ok(corner.x > AREA.width / 2 && corner.y > AREA.height / 2, 'no head to go by: the lower right, where she is not');
  const shifted = placeInputBox({ x: 2000 + 700, y: 450, r: 60 }, { x: 2000, y: 0, width: 1536, height: 912 });
  assert.ok(shifted.x >= 2000 && shifted.x + shifted.width <= 2000 + 1536, 'a work area that does not start at 0');
});

test('her bubble goes above her head when it fits, beside it when not, and stays inside the window', () => {
  const win = { width: 1536, height: 912 };
  const high = placeBubble({ x: 700, y: 500, r: 60 }, { width: 340, height: 120 }, win);
  assert.equal(high.side, 'above'); assert.ok(high.y + 120 <= 500 - 60, 'above the head');
  const tall = placeBubble({ x: 700, y: 200, r: 60 }, { width: 340, height: 420 }, win);
  assert.notEqual(tall.side, 'above', 'a tall reply that cannot fit above goes beside her');
  assert.ok(tall.x >= 700 + 60 || tall.x + 340 <= 700 - 60, 'not over her face');
  for (const head of [{ x: 10, y: 20, r: 50 }, { x: 1530, y: 900, r: 50 }, { x: 768, y: 456, r: 80 }, { x: 768, y: 456, r: 500 }] as HeadSpot[]) {
    for (const size of [{ width: 340, height: 60 }, { width: 340, height: 420 }, { width: 500, height: 800 }]) {
      const spot = placeBubble(head, size, win);
      assert.ok(spot.x >= 7.5 && spot.y >= 7.5 && spot.x + size.width <= win.width - 7.5 + 0.5 && spot.y + size.height <= win.height - 7.5 + 0.5, `inside ${JSON.stringify(head)} ${JSON.stringify(size)} ${JSON.stringify(spot)}`);
    }
  }
});

test('Enter sends, except while an input method is composing, and Shift+Enter does not', () => {
  assert.equal(enterSends({ key: 'Enter' }), true);
  assert.equal(enterSends({ key: 'Enter', isComposing: true }), false, 'Chinese input: Enter confirms the candidate');
  assert.equal(enterSends({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(enterSends({ key: 'Enter', shiftKey: true }), false);
  assert.equal(enterSends({ key: 'a' }), false);
});

// ---- the page: from the mouse to one report -----------------------------------------------------------------------------------------

function reporterSetup(overrides: Partial<ClickReporterPorts> = {}) {
  const sent: UnboundTouchReport[] = [];
  let clock = 1000;
  const names: Record<number, string[]> = { 0: ['左手首', '左ひじ', '左腕', '上半身'], 1: ['頭', '首'], 2: ['髪_前', '頭'], 3: ['右足首', '右足'], 4: ['Bone7', '上半身', 'センター'] };
  const spots: { x: number; y: number; bone: number }[] = [{ x: 100, y: 100, bone: 0 }, { x: 300, y: 100, bone: 1 }, { x: 400, y: 100, bone: 2 }, { x: 500, y: 100, bone: 3 }, { x: 600, y: 100, bone: 4 }];
  const ports: ClickReporterPorts = {
    nearest: (x, y) => { let best: { bone: number; distance: number } | null = null; for (const s of spots) { const distance = Math.hypot(x - s.x, y - s.y) - 30; if (!best || distance < best.distance) best = { bone: s.bone, distance }; } return best; },
    names: bone => names[bone] ?? [], head: () => ({ x: 300, y: 80, r: 50 }), eligible: () => true, send: report => sent.push(report), clock: () => clock, ...overrides,
  };
  return { reporter: new ClickReporter(ports), sent, tick: (ms: number) => { clock += ms; } };
}

test('the page: one click on her sends exactly one report with the part and her side, and where her head is', () => {
  const t = reporterSetup();
  t.reporter.down(105, 100); t.tick(80); assert.equal(t.reporter.up(105, 100), true);
  assert.deepEqual(t.sent, [{ part: 'hand', side: 'left', head: { x: 300, y: 80, r: 50 } }]);
  t.tick(2000); t.reporter.down(500, 105); t.tick(60); t.reporter.up(500, 105);
  assert.deepEqual(t.sent.at(-1), { part: 'foot', side: 'right', head: { x: 300, y: 80, r: 50 } });
  t.tick(2000); t.reporter.down(400, 100); t.tick(60); t.reporter.up(400, 100);
  assert.equal(t.sent.at(-1)?.part, 'hair', 'hair counts as hair');
  t.tick(2000); t.reporter.down(600, 100); t.tick(60); t.reporter.up(600, 100);
  assert.deepEqual({ part: t.sent.at(-1)?.part, side: t.sent.at(-1)?.side }, { part: 'torso', side: null }, 'an unnamed helper under the body is the torso');
  assert.equal(t.sent.length, 4);
});

test('the page: nothing is reported for a press off her, a hold, a drag, a double click\'s second click, or while she cannot be clicked', () => {
  const t = reporterSetup();
  t.reporter.down(900, 700); t.tick(50); assert.equal(t.reporter.up(900, 700), false, 'off her');
  t.reporter.down(105, 100); t.tick(700); assert.equal(t.reporter.up(105, 100), false, 'held');
  t.tick(2000); t.reporter.down(105, 100); t.tick(50); assert.equal(t.reporter.up(160, 100), false, 'dragged');
  t.tick(2000); t.reporter.down(105, 100); t.tick(50); assert.equal(t.reporter.up(105, 100), true);
  t.tick(150); t.reporter.down(105, 100); t.tick(50); assert.equal(t.reporter.up(105, 100), false, 'double click: once');
  assert.equal(t.sent.length, 1);
  // The edge of her counts within the margin only.
  const edge = reporterSetup();
  edge.reporter.down(100 + 30 + CLICK_MARGIN_PX, 100); edge.tick(50); assert.equal(edge.reporter.up(100 + 30 + CLICK_MARGIN_PX, 100), true, 'at the edge');
  edge.tick(2000); edge.reporter.down(100 + 30 + CLICK_MARGIN_PX + 3, 100); edge.tick(50); assert.equal(edge.reporter.up(100 + 30 + CLICK_MARGIN_PX + 3, 100), false, 'just outside');
  let eligible = false;
  const blocked = reporterSetup({ eligible: () => eligible });
  blocked.reporter.down(105, 100); blocked.tick(50); assert.equal(blocked.reporter.up(105, 100), false, 'a peek is playing / click-through / hidden');
  eligible = true; blocked.tick(2000);
  blocked.reporter.down(105, 100); eligible = false; blocked.tick(50); assert.equal(blocked.reporter.up(105, 100), false, 'she became unclickable between press and release');
  assert.equal(blocked.sent.length, 0);
});

// ---- the host side: UnboundTyping with fake ports ----------------------------------------------------------------------------------

function typingSetup(opts: { say?: SayResult } = {}) {
  const touches: unknown[] = [], opened: Rect[] = [], said: string[] = [], said2: string[] = [], shortcuts = new Map<string, () => void>();
  let state: UnboundState = 'unbound', closed = 0, destroyed = 0, head: HeadSpot | null = { x: 600, y: 300, r: 60 }, answer: Promise<HeadSpot | null> | null = null;
  let say: SayResult = opts.say ?? 'sent', win: Rect | null = { x: 100, y: 50, width: 1536, height: 912 }, boxOpen = false;
  const input: InputBoxPort = { open: rect => { opened.push(rect); boxOpen = true; }, close: () => { closed++; boxOpen = false; }, destroy: () => { destroyed++; }, isOpen: () => boxOpen };
  const ports: TypingPorts = {
    touch: value => { touches.push(value); return true; }, say: text => { said.push(text); return say; },
    shortcut: { register: (accelerator, run) => { shortcuts.set(accelerator, run); return true; }, unregister: accelerator => { shortcuts.delete(accelerator); } },
    input, state: () => state, window: () => win, askHead: () => answer ?? Promise.resolve(head), said: text => { said2.push(text); }, clock: () => 424242,
  };
  const typing = new UnboundTyping(ports);
  return {
    typing, touches, opened, said, said2, shortcuts, input,
    set state(value: UnboundState) { state = value; }, set say(value: SayResult) { say = value; }, set head(value: HeadSpot | null) { head = value; }, set win(value: Rect | null) { win = value; },
    set answer(value: Promise<HeadSpot | null> | null) { answer = value; }, closed: () => closed, destroyed: () => destroyed,
  };
}
const click = (part: UnboundTouchReport['part'] = 'hand', side: UnboundTouchReport['side'] = 'left'): UnboundTouchReport => ({ part, side, head: { x: 600, y: 300, r: 60 } });

test('a click on her opens the box beside her head, in screen coordinates, and is not a touch (I-194); a click while the box is open is one touch (kind click, where unbound)', () => {
  const t = typingSetup();
  t.typing.click(click('hand', 'left'));
  assert.deepEqual(t.touches, [], 'a click that opens the box is wanting to talk, not a touch');
  assert.equal(t.opened.length, 1);
  const box = t.opened[0];
  assert.equal(box.x, 100 + 600 + 60 + 14, 'the window starts at x 100: head 600 is at 700 on the screen');
  assert.equal(box.y, 50 + 300 - INPUT_BOX_SIZE.height / 2);
  assert.deepEqual([box.width, box.height], [INPUT_BOX_SIZE.width, INPUT_BOX_SIZE.height]);
  t.typing.click(click('head', null));
  assert.deepEqual(t.touches, [{ kind: 'click', part: 'head', side: null, where: 'unbound', at: 424242 }], 'a click while the box is open is a touch');
  assert.equal(t.opened.length, 2, 'and the same box moves (one window; the port reopens it)');
  assert.equal(t.said.length + t.said2.length, 0, 'nothing is said or done on her behalf: the click only reports');
});

test('a click with no sink still opens the box (a touch is never a reason for an error); reportTouch validates what the host builds', () => {
  const seen: TouchEvent[] = [];
  setTouchSink(event => seen.push(event));
  try {
    assert.equal(reportTouch({ kind: 'click', part: 'foot', side: 'right', where: 'unbound', at: 1 }), true);
    assert.equal(reportTouch({ kind: 'click', part: 'foot', side: 'both', where: 'unbound', at: 1 }), false);
    assert.deepEqual(seen, [{ kind: 'click', part: 'foot', side: 'right', where: 'unbound', at: 1 }]);
  } finally { setTouchSink(null); }
  assert.equal(reportTouch({ kind: 'click', part: 'foot', side: null, where: 'unbound', at: 1 }), false, 'no sink: dropped, not thrown');
  const t = typingSetup();
  t.typing.click(click());
  assert.equal(t.opened.length, 1);
});

test('a click is ignored unless she is out', () => {
  const t = typingSetup();
  for (const state of ['normal', 'entering'] as const) { t.state = state; t.typing.click(click()); }
  assert.deepEqual([t.touches.length, t.opened.length], [0, 0]);
  t.state = 'unbound'; t.win = null; t.typing.click(click());
  assert.equal(t.touches.length, 0, 'a click that opens the box is no touch');
  assert.equal(t.opened.length, 0, 'no window to place the box against');
});

test('the shortcut exists exactly while she is out and opens the box at her head', async () => {
  const t = typingSetup();
  assert.equal(t.typing.shortcutActive, false);
  assert.ok(!TYPING_SHORTCUT.includes('Alt+P') && !TYPING_SHORTCUT.includes('Alt+U'), 'not the show/hide or out/back shortcuts');
  t.typing.modeChanged('entering');
  assert.equal(t.shortcuts.size, 0, 'entering: not yet');
  t.typing.modeChanged('unbound');
  assert.deepEqual([...t.shortcuts.keys()], [TYPING_SHORTCUT]);
  t.typing.modeChanged('unbound');
  assert.equal(t.shortcuts.size, 1, 'one registration, however often she is told');
  t.shortcuts.get(TYPING_SHORTCUT)!();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(t.opened.length, 1);
  assert.equal(t.touches.length, 0, 'the shortcut is not a touch');
  assert.equal(t.opened[0].x, 100 + 600 + 60 + 14);
  t.typing.modeChanged('normal');
  assert.equal(t.shortcuts.size, 0, 'back in the small window: the shortcut is gone');
  assert.ok(t.closed() >= 1 && t.destroyed() === 1, 'and so is the box');
  t.state = 'normal';
  await t.typing.openFromShortcut();
  assert.equal(t.opened.length, 1, 'the shortcut does nothing outside Unbound even if it fired');
});

test('the shortcut without an answer about her head puts the box in the corner; a late answer after she left opens nothing', async () => {
  const t = typingSetup();
  t.head = null; await t.typing.openFromShortcut();
  assert.equal(t.opened.length, 1);
  assert.ok(t.opened[0].x + t.opened[0].width > 1000, 'lower right');
  let resolve!: (value: HeadSpot | null) => void;
  t.answer = new Promise(r => { resolve = r; });
  const pending = t.typing.openFromShortcut();
  t.state = 'normal'; resolve({ x: 600, y: 300, r: 60 }); await pending;
  assert.equal(t.opened.length, 1, 'she went back while the page was answering');
  t.state = 'unbound'; t.answer = new Promise(r => { resolve = r; });
  const stale = t.typing.openFromShortcut();
  t.typing.cancel(); resolve({ x: 600, y: 300, r: 60 }); await stale;
  assert.equal(t.opened.length, 1, 'Esc while the page was answering: stays closed');
});

test('Enter: the line goes through the chat path once, shows near her, and the box closes; unavailable keeps it open with a reason', async () => {
  const t = typingSetup();
  assert.deepEqual(await t.typing.submit('  你好呀  '), { ok: true });
  assert.deepEqual(t.said, ['你好呀']);
  assert.deepEqual(t.said2, ['你好呀'], 'the page shows what was sent');
  assert.equal(t.closed(), 1);
  // I-177: there is no "she is still answering" refusal any more (a send while she answers stops her reply: electron/unbound/say-line.ts).
  assert.equal('busy' in SUBMIT_HINTS, false);
  t.say = 'unavailable';
  assert.deepEqual(await t.typing.submit('再说一句'), { ok: false, hint: SUBMIT_HINTS.unavailable });
  assert.equal(t.said2.length, 1, 'a line that was not sent is not shown as sent');
  assert.equal(t.closed(), 1, 'the box stayed open for both');
  const before = t.said.length;
  assert.deepEqual(await t.typing.submit('   '), { ok: false, hint: '' });
  assert.deepEqual(await t.typing.submit(42), { ok: false, hint: '' });
  assert.equal(t.said.length, before, 'blank lines are not sent');
  t.say = 'sent'; await t.typing.submit('x'.repeat(5000));
  assert.equal(t.said.at(-1)!.length, 2000, 'cut to what the chat takes');
  t.state = 'normal';
  assert.deepEqual(await t.typing.submit('她回小窗了'), { ok: false, hint: SUBMIT_HINTS.away });
  assert.ok(!t.said.includes('她回小窗了'));
});

test('the box never outlives her: going back or leaving Unbound closes it; quitting removes the shortcut and the window', () => {
  const t = typingSetup();
  t.typing.modeChanged('unbound'); t.typing.click(click());
  const closedBefore = t.closed();
  t.typing.modeChanged('entering');
  assert.equal(t.closed(), closedBefore + 1);
  t.typing.modeChanged('unbound');
  t.typing.quit();
  assert.equal(t.shortcuts.size, 0);
  assert.equal(t.destroyed(), 1);
  t.typing.cancel();
});

// ---- the host: touch from the page, her head, the line, the light, her voice ------------------------------------------------------

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
class FakePet implements PetPort {
  visible = true; minimized = false; destroyed = false; bounds: Rect = { x: 1100, y: 330, width: 400, height: 560 };
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
  getBounds() { return { ...this.bounds }; } setBounds(bounds: Rect) { this.bounds = { ...bounds }; }
  hide() { this.visible = false; } showInactive() { this.visible = true; }
}
class FakeWindow implements UnboundWindowLike {
  readonly frame = {}; readonly sent: [string, unknown][] = [];
  visible = false; destroyed = false; bounds: Rect | null = null; private gone: (() => void)[] = [];
  readonly webContents = { id: 77, mainFrame: this.frame, send: (channel: string, value: unknown) => { this.sent.push([channel, value]); }, isDestroyed: () => this.destroyed };
  constructor(bounds?: Rect) { this.bounds = bounds ?? null; }
  isDestroyed() { return this.destroyed; } isVisible() { return this.visible && !this.destroyed; }
  showInactive() { this.visible = true; } hide() { this.visible = false; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; for (const callback of this.gone.splice(0)) callback(); }
  setIgnoreMouseEvents() {} setBounds(bounds: Rect) { this.bounds = bounds; } onGone(callback: () => void) { this.gone.push(callback); }
  event(frame: unknown = this.frame): UnboundIpcEvent { return { sender: { id: this.webContents.id, mainFrame: this.frame }, senderFrame: frame }; }
}
class FakeIpc {
  readonly handlers = new Map<string, (event: UnboundIpcEvent, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: UnboundIpcEvent, ...args: unknown[]) => unknown) { this.handlers.set(channel, listener); }
  removeHandler(channel: string) { this.handlers.delete(channel); }
  async call(channel: string, event: UnboundIpcEvent, ...args: unknown[]) { return this.handlers.get(channel)!(event, ...args); }
}
const DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };

function hostSetup(withPeek = false) {
  const ipc = new FakeIpc(), pet = new FakePet(), windows: FakeWindow[] = [], touches: UnboundTouchReport[] = [];
  let timers: { ms: number; run: () => void }[] = [], now = 5_000_000;
  const peek: PeekPorts | undefined = withPeek ? { clock: () => now, random: () => 0.5, idleSeconds: () => 0, asleep: () => false, inCall: () => false, userTalking: () => false,
    mood: () => CURIOUS, lastInteractionAt: () => null, answered: () => true, every: (ms, run) => { const timer = { ms, run }; timers.push(timer); return () => { timers = timers.filter(x => x !== timer); }; } } : undefined;
  const settings = { ...DEFAULT_SETTINGS, model: { path: 'C:\\m\\her.pmx', url: 'mmd-asset://token/her.pmx', name: 'her.pmx' } };
  const fullscreen: { send?: (value: 'fullscreen' | 'clear') => void } = {};
  const ports: UnboundHostPorts = {
    ipcMain: ipc, pet: () => pet, petWanted: () => true, developerMode: () => true, source: () => unboundSource(settings, null), reviewed: async () => true,
    display: () => DISPLAY, measure: async () => null, openWindow: bounds => { const win = new FakeWindow(bounds); windows.push(win); return { window: win, loaded: Promise.resolve() }; },
    fullscreen: { start: send => { fullscreen.send = send; }, stop: () => {} }, restored: () => {}, publish: () => {}, readyTimeoutMs: 600_000, headTimeoutMs: 600_000, touch: report => { touches.push(report); }, peek,
  };
  const host = new UnboundHost(ports);
  return { host, ports, ipc, windows, touches, pet, fullscreen, peekNow: () => host.apply({ peekNow: true }) };
}
async function enter(t: ReturnType<typeof hostSetup>) {
  t.host.apply({ active: true }); await settle();
  const win = t.windows.at(-1)!;
  await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event());
  await t.ipc.call(UNBOUND_REQUESTS.ready, win.event(), { ok: true, modelHeightM: 1.6 });
  await settle();
  return win;
}
const sentOn = (win: FakeWindow, channel: string) => win.sent.filter(([name]) => name === channel).map(([, value]) => value);

test('host: a touch report is taken only from the shown window\'s top frame, only while she can be clicked, and reaches the typing port once', async () => {
  const t = hostSetup(), win = await enter(t);
  const report = { part: 'hand', side: 'left', head: { x: 500, y: 300, r: 50 } };
  await t.ipc.call(UNBOUND_REQUESTS.touch, win.event(), report);
  assert.deepEqual(t.touches, [report]);
  await t.ipc.call(UNBOUND_REQUESTS.touch, win.event(), { part: 'wing', side: null });
  await t.ipc.call(UNBOUND_REQUESTS.touch, win.event(), 'hand');
  assert.equal(t.touches.length, 1, 'junk is ignored');
  await assert.rejects(t.ipc.call(UNBOUND_REQUESTS.touch, win.event({}), report), /未授权/, 'another frame');
  await assert.rejects(t.ipc.call(UNBOUND_REQUESTS.touch, { sender: { id: 5, mainFrame: win.frame }, senderFrame: win.frame }, report), /未授权/, 'another window');
  t.fullscreen.send!('fullscreen');
  await t.ipc.call(UNBOUND_REQUESTS.touch, win.event(), report);
  assert.equal(t.touches.length, 2, 'I-199: in front of a full-screen program she is still there, and a click on her is hers');
  t.fullscreen.send!('clear');
  await t.ipc.call(UNBOUND_REQUESTS.touch, win.event(), report);
  assert.equal(t.touches.length, 3);
});

test('host (2026-11-23): while she plays a peek a click on her is still hers (no forced click-through): it opens the box as at any time and the peek goes on', async () => {
  const t = hostSetup(true), win = await enter(t);
  t.peekNow();
  await t.ipc.call(UNBOUND_REQUESTS.touch, win.event(), { part: 'head', side: null, head: null });
  assert.equal(t.touches.length, 1, 'the click reaches her as at any time (the typing port opens the box)');
  assert.equal(t.host.peek?.active, true, 'the peek goes on');
});

test('host (I-196): a joystick or wheel pull (stick) is a pull, never a touch: the touch port hears nothing of it, but where she was pulled to is still her place', async () => {
  const t = hostSetup(true), win = await enter(t), pulls: Record<string, unknown>[] = [];
  t.ports.pull = report => { pulls.push(report); };
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'start' });
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'report', report: { part: 'hair', side: null, strength: 0.7, heldMs: 2000, ended: 'holding' }, stick: true });
  const before = (await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event()) as UnboundScene).world.placement;
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'report', report: { part: 'hair', side: null, strength: 0.7, heldMs: 4000, ended: 'released', steps: 6 }, place: { xM: before.xM - 0.5, depthM: before.depthM }, stick: true });
  assert.equal(pulls.length, 0, 'nothing reaches the touch brain: no touch reaction, no touch line');
  const after = (sentOn(win, UNBOUND_EVENTS.scene).at(-1) as UnboundScene).world.placement;
  assert.ok(Math.abs(after.xM - (before.xM - 0.5)) < 1e-9, 'her place is kept');
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'report', report: { part: 'arm', side: 'left', strength: 0.7, heldMs: 2000, ended: 'holding' } });
  assert.equal(pulls.length, 1, 'an arm\'s pull (not flagged) is told as before');
});

test('host (step 5c 拉她): a pull start is answered (asleep: no; during a peek: yes, 2026-11-23); its reports reach the touch port with only the pull\'s fields; walked along, that spot is her place', async () => {
  const t = hostSetup(true), win = await enter(t), pulls: Record<string, unknown>[] = [];
  t.ports.pull = report => { pulls.push(report); };
  const answer = await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'start' }) as { accepted: boolean; stance: { compliance: number } | null };
  assert.equal(answer.accepted, true);
  assert.ok(answer.stance && answer.stance.compliance > 0 && answer.stance.compliance <= 1, 'her stance from her mood');
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'report', report: { part: 'torso', side: null, strength: 0.7, heldMs: 2000, ended: 'holding', text: 'x', kind: 'click' } });
  assert.deepEqual(pulls[0], { part: 'torso', side: null, strength: 0.7, heldMs: 2000, ended: 'holding' }, 'only the pull\'s own fields');
  const before = (await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event()) as UnboundScene).world.placement;
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'report', report: { part: 'torso', side: null, strength: 0.7, heldMs: 4000, ended: 'released', steps: 6 }, place: { xM: before.xM - 0.5, depthM: before.depthM } });
  const after = (sentOn(win, UNBOUND_EVENTS.scene).at(-1) as UnboundScene).world.placement; // pushed to the page at once
  assert.ok(Math.abs(after.xM - (before.xM - 0.5)) < 1e-9, 'where she was pulled to is her place now');
  assert.equal(pulls.length, 2);
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'nonsense' });
  await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), 'start');
  assert.equal(pulls.length, 2, 'junk is ignored');
  await assert.rejects(t.ipc.call(UNBOUND_REQUESTS.pull, win.event({}), { phase: 'start' }), /未授权/, 'another frame');
  t.ports.peek!.asleep = () => true;
  assert.deepEqual(await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'start' }), { accepted: false }, 'asleep: not a pull');
  t.ports.peek!.asleep = () => false;
  t.peekNow();
  assert.equal((await t.ipc.call(UNBOUND_REQUESTS.pull, win.event(), { phase: 'start' }) as { accepted: boolean }).accepted, true, 'during a peek: a pull (the page sends it only once it is large and has ended the peek)');
});

test('host: where her head is is a question to the page; no answer in time, or she left, gives null', async () => {
  const t = hostSetup(), win = await enter(t);
  const asked = t.host.askHead();
  const question = sentOn(win, UNBOUND_EVENTS.typing).at(-1) as { type: string; id: string };
  assert.equal(question.type, 'where');
  await t.ipc.call(UNBOUND_REQUESTS.anchor, win.event(), { id: question.id, head: { x: 400, y: 250, r: 55 } });
  assert.deepEqual(await asked, { x: 400, y: 250, r: 55 });
  t.ports.headTimeoutMs = 40; // this is the test of the timeout: only now is the real timer short
  assert.equal(await t.host.askHead(), null, 'no answer within the time');
  const late = t.host.askHead();
  t.host.exit();
  assert.equal(await late, null, 'she went back');
  assert.deepEqual(t.host.windowRect(), null, 'no window now');
});

test('host: the window rectangle is the work area; the sent line and her voice go to the shown window only', async () => {
  const t = hostSetup(), win = await enter(t);
  assert.deepEqual(t.host.windowRect(), DISPLAY.workArea);
  t.host.said('你好'); t.host.said('   ');
  assert.deepEqual(sentOn(win, UNBOUND_EVENTS.said), ['你好']);
  t.host.speaking(true); t.host.speaking(false);
  assert.deepEqual(sentOn(win, UNBOUND_EVENTS.speaking), [true, false]);
  const lonely = hostSetup();
  lonely.host.said('x'); lonely.host.speaking(true);
  assert.equal(lonely.windows.length, 0, 'nothing to send to, nothing thrown');
});

test('host: the opening beat is on by default in Unbound and the developer switch can still turn it off', async () => {
  const t = hostSetup(), win = await enter(t);
  const scenes = () => sentOn(win, UNBOUND_EVENTS.scene) as UnboundScene[];
  const first = await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event()) as UnboundScene;
  assert.equal(first.speechBeat, true, 'on from the first scene');
  assert.equal(t.host.view().speechBeat, true);
  t.host.apply({ speechBeat: false });
  assert.ok(!('speechBeat' in scenes().at(-1)!), 'off: gone from the scene');
  t.host.apply({ speechBeat: true });
  assert.equal(scenes().at(-1)?.speechBeat, true);
});

test('host: the senses light is in the first scene, changes go by their own event without re-placing her, and junk changes nothing', async () => {
  const t = hostSetup();
  t.host.senses({ camera: true, microphone: false, screen: false, audio: false }); // before she is out
  const win = await enter(t);
  const first = await t.ipc.call(UNBOUND_REQUESTS.getScene, win.event()) as UnboundScene;
  assert.deepEqual(first.senses, { camera: true, microphone: false, screen: false, audio: false });
  const scenesBefore = sentOn(win, UNBOUND_EVENTS.scene).length;
  t.host.senses({ camera: true, microphone: true, screen: false, audio: false });
  assert.deepEqual(sentOn(win, UNBOUND_EVENTS.senses).at(-1), { camera: true, microphone: true, screen: false, audio: false });
  assert.equal(sentOn(win, UNBOUND_EVENTS.scene).length, scenesBefore, 'no scene push: she is not placed again for a light');
  const events = sentOn(win, UNBOUND_EVENTS.senses).length;
  t.host.senses({ camera: true, microphone: true, screen: false, audio: false });
  t.host.senses({ camera: 'yes' }); t.host.senses(null);
  assert.equal(sentOn(win, UNBOUND_EVENTS.senses).length, events, 'the same state and junk send nothing');
  t.host.apply({ debug: true });
  const scene = sentOn(win, UNBOUND_EVENTS.scene).at(-1) as UnboundScene;
  assert.equal(scene.senses?.microphone, true, 'a later scene carries the light as it is now');
});

// ---- the contracts: preload whitelists, the input window, the build ----------------------------------------------------------------

function fakeIpc() {
  const invoked: [string, unknown[]][] = [];
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
  const ipc: UnboundIpc = {
    invoke: async (channel, ...args) => { invoked.push([channel, args]); return { ok: true }; },
    on: (channel, listener) => { (listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)!).add(listener); },
    removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
  };
  return { ipc, invoked, listeners, emit: (channel: string, value: unknown) => { for (const listener of listeners.get(channel) ?? []) listener({ sender: 'the IPC event' }, value); } };
}

test('the Unbound window gets exactly the new calls and events, on fixed channels, without the IPC event', async () => {
  // Step 4 added two: lifeReport (her own action's beat) and onLife (start / ease out / her gaze is yours). Step 5c added pull (拉她).
  // I-154 follow-up added five: getMood, onMood (her mood view, as the companion window has it), moodInteraction (a touch's mood input),
  // getModelCard, onModelCard (the model's capability record, read only: her face follows your choices).
  // 2026-11-20 also added onFillerMouth (her short sounds in a call move her mouth).
  // Batch B (docs/claude/2026-11-21-unbound-full-BG.md) added nine for her games out here: rpsGet, rpsEvents, rpsThrow, rpsRespond, onGive, giveAnswer, onHands, handsAnswer, handsRequest.
  // Batches D, F (docs/claude/2026-11-21-unbound-full-D.md) added four for her senses out here: onUserGaze, onDance, onExpressionPreview, herFact.
  // I-209 step 1 added the frame-cost guard (companyGuard); step 3 (each one her own full screen) her body on the shared stage and the shared
  // world: stageBody, stageLeft, onStage, and (2026-11-24) stageFrames, her frame times once a minute (their own unbound:stage* channels; step 1's companyGet, companyPlace, onCompany went with its page extras).
  assert.deepEqual([...UNBOUND_API_KEYS].sort(), ['anchor', 'getModelCard', 'getMood', 'getScene', 'lifeReport', 'loading', 'moodInteraction', 'onBubble', 'onFillerMouth', 'onLife', 'onModelCard', 'onMood', 'onPeek', 'onSaid', 'onScene', 'onSenses', 'onSpeaking', 'onTyping', 'peekReport', 'pull', 'ready', 'report', 'setInteractive', 'shown', 'touch',
    'getBlushCalibration',
    'onBlushCalibration',
    'onSpeechFace',
    'resolveChatGesture',
    'resolveHerAction',
    'reportHerAction',
    'bodyPlan',
    'resolveBody',
    'resolveBehaviorMotion',
    'onHerAction',
    'giveAnswer',
    'handsAnswer',
    'handsRequest',
    'onGive',
    'onHands',
    'rpsEvents',
    'rpsGet',
    'rpsRespond',
    'rpsThrow',
    'onUserGaze',
    'onDance',
    'onExpressionPreview',
    'onMusicSettings',
    'herFact',
    // I-209 (electron/unbound/company/preload-api.ts): the guard, tests/i209-company-presence.test.ts; step 3: tests/i209-stage-instances.test.ts.
    'companyGuard',
    'stageBody',
    'stageFrames',
    'stageLeft',
    'stageMouth', // 2026-11-25: her mouth per reply, under her id (tests/i209-stage-mouth.test.ts)
    'onStage',
  ].sort());
  const { ipc, invoked, emit } = fakeIpc();
  const api = createUnboundApi(ipc);
  assert.deepEqual(Object.keys(api).sort(), [...UNBOUND_API_KEYS].sort());
  await api.touch({ part: 'hand', side: 'left', head: null });
  await api.anchor({ id: 'h1', head: null });
  assert.deepEqual(invoked.map(([channel]) => channel), [UNBOUND_REQUESTS.touch, UNBOUND_REQUESTS.anchor]);
  const seen: unknown[][] = [];
  api.onSaid((...args: unknown[]) => seen.push(['said', ...args])); api.onSpeaking((...args: unknown[]) => seen.push(['speaking', ...args]));
  api.onSenses((...args: unknown[]) => seen.push(['senses', ...args])); api.onTyping((...args: unknown[]) => seen.push(['typing', ...args]));
  emit(UNBOUND_EVENTS.said, '你好'); emit(UNBOUND_EVENTS.speaking, true); emit(UNBOUND_EVENTS.senses, { camera: true }); emit(UNBOUND_EVENTS.typing, { type: 'where', id: 'h1' });
  assert.deepEqual(seen, [['said', '你好'], ['speaking', true], ['senses', { camera: true }], ['typing', { type: 'where', id: 'h1' }]]);
  for (const channel of [...Object.values(UNBOUND_REQUESTS), ...Object.values(UNBOUND_EVENTS)]) assert.match(channel, /^unbound:[a-z-]+$/);
});

test('the input box gets five things only: send a line, close, "you are open", call / hang up, and the call state', async () => {
  const { ipc, invoked, emit, listeners } = fakeIpc();
  const api = createUnboundInputApi(ipc);
  assert.deepEqual(Object.keys(api).sort(), [...UNBOUND_INPUT_API_KEYS].sort());
  assert.ok(Object.isFrozen(api));
  for (const forbidden of ['invoke', 'send', 'on', 'ipcRenderer', 'require', 'process']) assert.equal((api as unknown as Record<string, unknown>)[forbidden], undefined, forbidden);
  await api.submit('你好'); await api.cancel();
  assert.deepEqual(invoked, [[UNBOUND_INPUT_CHANNELS.submit, ['你好']], [UNBOUND_INPUT_CHANNELS.cancel, []]]);
  await assert.rejects(api.submit(5 as unknown as string), TypeError);
  await api.submit('x'.repeat(50_000));
  assert.equal((invoked.at(-1)![1][0] as string).length, 20_000, 'what leaves the page is bounded');
  let opens = 0; const off = api.onOpen(() => { opens++; });
  emit(UNBOUND_INPUT_CHANNELS.open, undefined); off(); emit(UNBOUND_INPUT_CHANNELS.open, undefined);
  assert.equal(opens, 1); assert.equal(listeners.get(UNBOUND_INPUT_CHANNELS.open)?.size, 0);
  assert.throws(() => api.onOpen(undefined as unknown as () => void), TypeError);
  for (const channel of Object.values(UNBOUND_INPUT_CHANNELS)) assert.match(channel, /^unbound:[a-z-]+$/);
  const preload = readFileSync(new URL('../electron/unbound/input-preload.ts', import.meta.url), 'utf8').replace(/^\/\/.*$/gm, '');
  assert.equal((preload.match(/exposeInMainWorld\(/g) ?? []).length, 1);
  assert.match(preload, /exposeInMainWorld\('unboundInput', createUnboundInputApi\(ipcRenderer\)\)/);
});

test('why a second window: hers can never take the keyboard, the box can; both sandboxed, isolated and Node-free', () => {
  const bounds = { x: 0, y: 0, width: 320, height: 78 };
  const her = unboundWindowOptions(bounds, 'C:/app/dist-electron/x.cjs'), box = inputWindowOptions(bounds, `C:/app/dist-electron/${UNBOUND_INPUT_PRELOAD}`);
  assert.equal(her.focusable, false, 'clicking her never takes focus from the user\'s window');
  assert.equal(box.focusable, true, 'the box takes the keyboard');
  assert.equal(box.show, false, 'hidden until opened');
  assert.equal(box.skipTaskbar, true); assert.equal(box.alwaysOnTop, true); assert.equal(box.frame, false); assert.equal(box.transparent, true);
  assert.deepEqual({ ...box.webPreferences, preload: undefined }, { preload: undefined, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true, spellcheck: false });
  const build = readFileSync(new URL('../scripts/build-electron.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes(`"${UNBOUND_INPUT_PRELOAD.replace('.cjs', '')}": "electron/unbound/input-preload.ts"`), 'the build writes the preload the box loads');
  const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  assert.ok(vite.includes('src/unbound/input.html'), 'the build carries the box\'s page');
  const page = readFileSync(new URL('../src/unbound/input.html', import.meta.url), 'utf8');
  assert.match(page, /default-src 'none'/);
  assert.match(page, /script-src 'self'/);
});
