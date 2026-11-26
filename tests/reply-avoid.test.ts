// T-253 option 1 (docs/claude/2026-11-19-control-window-avoid.md): the reply bubble keeps clear of the control window, without jumping,
// without hiding her reply, and without remembering the temporary side. Pure placement first, then the real reply window host with fake
// native windows (the read-aloud proof must stay current while the bubble moves aside).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { AVOID_HYSTERESIS, chooseReplyPlacement, overlapsRect, replyCandidates, type AvoidMemory } from '../electron/brain/reply-avoid';
import { layoutReply, type ReplyBounds, type ReplyLayout } from '../electron/brain/reply-layout';
import type { PetReplyUpdate as ReplyUpdate } from '../shared/foundation/pet-reply'; // no-pet-ok: the existing type and module names

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const owner = { x: 100, y: 200, width: 400, height: 560 };
const anchor = { x: 200, y: 210, radius: 110, visible: true };
const overlapArea = (a: ReplyBounds, b: ReplyBounds) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const globalBody = (layout: ReplyLayout): ReplyBounds => ({ ...layout.body, x: layout.bounds.x + layout.body.x, y: layout.bounds.y + layout.body.y });

// Today's bubble sits right of her head: body x 426..711, y 227..392. A control window to her right covers it.
const controlRight = { x: 520, y: 120, width: 1260, height: 850 };

test('a control window over today\'s bubble: the bubble moves to a clear place near her mouth and remembers today\'s side', () => {
  const base = layoutReply(owner, anchor, area)!;
  assert.ok(overlapArea(base.bounds, controlRight) > 0, 'before: today\'s bubble overlaps the control window');
  const choice = chooseReplyPlacement(owner, anchor, area, undefined, false, controlRight, null);
  assert.ok(choice.layout && choice.avoided);
  assert.equal(overlapArea(choice.layout.bounds, controlRight), 0, 'after: no overlap');
  assert.equal(choice.layout.side, 'left', 'the open side');
  assert.equal(choice.baseSide, 'right', 'the side it remembers is today\'s, not the temporary one');
  assert.ok(choice.memory);
  const body = globalBody(choice.layout);
  assert.ok(body.x >= area.x && body.x + body.width <= area.x + area.width && body.y >= area.y && body.y + body.height <= area.y + area.height);
  assert.ok(body.width >= 140 && body.height >= 44);
});

test('no control window, or one the bubble does not touch: exactly today\'s placement, nothing remembered', () => {
  const base = layoutReply(owner, anchor, area);
  for (const avoid of [null, undefined, { x: 1500, y: 800, width: 300, height: 200 }, { x: NaN, y: 0, width: 10, height: 10 }]) {
    const choice = chooseReplyPlacement(owner, anchor, area, undefined, false, avoid, null);
    assert.deepEqual(choice.layout, base);
    assert.equal(choice.avoided, false); assert.equal(choice.memory, null);
  }
});

test('no jumping: the same inputs give the same place; a small move keeps it; today\'s place returns only past the hysteresis margin', () => {
  const first = chooseReplyPlacement(owner, anchor, area, undefined, false, controlRight, null);
  const again = chooseReplyPlacement(owner, anchor, area, undefined, false, controlRight, first.memory);
  assert.deepEqual(again.layout, first.layout); assert.deepEqual(again.memory, first.memory);
  // She is dragged a little: the chosen place follows her mouth and keeps its key.
  const moved = { ...owner, x: owner.x + 6, y: owner.y - 4 };
  const follow = chooseReplyPlacement(moved, anchor, area, 'right', false, controlRight, first.memory);
  assert.equal(follow.memory?.key, first.memory?.key);
  // A control window just past today's bubble (inside the margin): still avoided, the remembered place is kept.
  const base = layoutReply(owner, anchor, area)!;
  const justClear = { ...controlRight, x: base.bounds.x + base.bounds.width + AVOID_HYSTERESIS - 4 };
  const memoryForJustClear: AvoidMemory = { key: first.memory!.key, avoid: justClear };
  const held = chooseReplyPlacement(owner, anchor, area, 'right', false, justClear, memoryForJustClear);
  assert.equal(held.avoided, true, 'inside the hysteresis margin the avoided place stays');
  assert.equal(overlapsRect(held.layout!.bounds, justClear), false);
  // Without that memory (first time this rectangle is seen) the same rectangle does not touch today's bubble: today's place.
  assert.equal(chooseReplyPlacement(owner, anchor, area, 'right', false, justClear, null).avoided, false);
  const farClear = { ...controlRight, x: base.bounds.x + base.bounds.width + AVOID_HYSTERESIS + 4 };
  const back = chooseReplyPlacement(owner, anchor, area, 'right', false, farClear, { key: first.memory!.key, avoid: farClear });
  assert.equal(back.avoided, false); assert.deepEqual(back.layout, base);
});

test('the control window moves but the chosen place stays clear: it is kept (bonus), not re-placed to a slightly better spot', () => {
  const first = chooseReplyPlacement(owner, anchor, area, undefined, false, controlRight, null);
  const nudged = { ...controlRight, x: controlRight.x + 30, y: controlRight.y + 10 };
  const next = chooseReplyPlacement(owner, anchor, area, 'right', false, nudged, first.memory);
  assert.equal(next.memory?.key, first.memory?.key);
  assert.deepEqual(next.memory?.avoid, nudged);
});

test('a remembered place still clear of the same rectangle is kept even when another now scores better', () => {
  const all = replyCandidates(owner, anchor, area, 'right', false, controlRight);
  assert.ok(all.length > 2);
  const worst = all.reduce((a, b) => (b.score > a.score ? b : a));
  const best = all.reduce((a, b) => (b.score < a.score ? b : a));
  assert.ok(worst.score - 120 > best.score, 'the worst place loses even with the kept bonus');
  const choice = chooseReplyPlacement(owner, anchor, area, 'right', false, controlRight, { key: worst.key, avoid: { ...controlRight } });
  assert.equal(choice.memory?.key, worst.key, 'kept: no re-placement while nothing about the window changed');
  assert.deepEqual(choice.layout, worst.layout);
});

test('no room anywhere: today\'s placement, overlapping — her reply is never hidden to keep the window clear', () => {
  const everything = { x: -10, y: -10, width: 1940, height: 1060 };
  const choice = chooseReplyPlacement(owner, anchor, area, undefined, false, everything, null);
  assert.deepEqual(choice.layout, layoutReply(owner, anchor, area));
  assert.equal(choice.avoided, false); assert.equal(choice.memory, null);
  // The waiting dots too.
  const waiting = chooseReplyPlacement(owner, anchor, area, undefined, true, everything, null);
  assert.deepEqual(waiting.layout, layoutReply(owner, anchor, area, undefined, true));
});

test('tiers: her head in front of the control window, nothing near her mouth clears it: at least its input / send / stop band stays clear', () => {
  const control = { x: 330, y: 95, width: 1260, height: 850 }, band = { x: 338, y: 737, width: 1244, height: 200 };
  const front = { x: 700, y: 470, width: 400, height: 560 }, low = { x: 200, y: 400, radius: 110, visible: true }; // mouth (900, 870), in the band
  const base = layoutReply(front, low, area)!;
  assert.ok(overlapArea(base.bounds, band) > 0, 'before: today\'s bubble covers the band');
  assert.equal(chooseReplyPlacement(front, low, area, undefined, false, control, null).avoided, false, 'the whole window alone: no room, today\'s place');
  const choice = chooseReplyPlacement(front, low, area, undefined, false, [control, band], null);
  assert.ok(choice.avoided && choice.layout);
  assert.equal(overlapArea(choice.layout.bounds, band), 0, 'after: the band is clear');
  const again = chooseReplyPlacement(front, low, area, undefined, false, [control, band], choice.memory);
  assert.deepEqual(again.layout, choice.layout, 'and it stays put');
});

test('the waiting dots avoid the window as well', () => {
  const base = layoutReply(owner, anchor, area, undefined, true)!;
  const over = { x: base.bounds.x - 20, y: base.bounds.y - 20, width: 1200, height: 300 };
  const choice = chooseReplyPlacement(owner, anchor, area, undefined, true, over, null);
  assert.ok(choice.avoided && choice.layout);
  assert.equal(overlapArea(choice.layout.bounds, over), 0);
});

test('a window above-right of her: the bubble may slide just under it instead of jumping to the far side', () => {
  const atRight = { ...owner, x: 1100 };
  const base = layoutReply(atRight, anchor, area)!;
  const above = { x: 1000, y: 0, width: 920, height: base.bounds.y + 60 };
  const choice = chooseReplyPlacement(atRight, anchor, area, undefined, false, above, null);
  assert.ok(choice.avoided && choice.layout);
  assert.equal(overlapArea(choice.layout.bounds, above), 0);
});

// ---------------------------------------------------------------- the real reply window host (fake native windows)

interface ReplyHost {
  update(value: ReplyUpdate): void; waitForPresentation(text: string): Promise<boolean>; isPresentationCurrent(text: string): boolean;
  setAvoidSource(source: (() => ReplyBounds | null) | null): void; sync(): void; dispose(): void;
}
interface Render { presentationToken: string | null; text?: string; layout: ReplyLayout }
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function hostFixture(t: TestContext) {
  const windows: WindowFixture[] = [], ipcMain = new EventEmitter();
  class WindowFixture extends EventEmitter {
    visible = false; minimized = false; destroyed = false; opacity = 1; top = false; url = '';
    bounds = { x: 100, y: 200, width: 400, height: 560 };
    readonly parent: WindowFixture | null;
    readonly sent: Render[] = [];
    readonly calls: string[] = [];
    readonly webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, getURL: () => this.url, isDestroyed: () => this.destroyed,
      send: (_channel: string, value: Render) => { this.sent.push(value); }, setWindowOpenHandler: () => {},
    });
    constructor(options?: { parent?: WindowFixture }) { super(); this.parent = options?.parent ?? null; windows.push(this); }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } isMinimized() { return this.minimized; }
    getOpacity() { return this.opacity; } getParentWindow() { return this.parent; }
    isAlwaysOnTop() { return this.top; } setAlwaysOnTop(value: boolean) { this.calls.push('setAlwaysOnTop'); this.top = value; }
    getBounds() { return { ...this.bounds }; } setBounds(value: typeof this.bounds) { this.bounds = { ...value }; }
    setIgnoreMouseEvents() {}
    loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return Promise.resolve(); }
    showInactive() { this.visible = true; this.emit('show'); }
    hide() { this.calls.push('hide'); const changed = this.visible; this.visible = false; if (changed) this.emit('hide'); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const filename = new URL('../electron/brain/reply-window.ts', import.meta.url), localRequire = createRequire(filename), module = { exports: {} };
  const code = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const requireFixture = (name: string) => name === 'electron' ? { BrowserWindow: WindowFixture, ipcMain,
    screen: { getDisplayNearestPoint: () => ({ workArea: { ...area } }) } } : localRequire(name);
  new Function('require', 'module', 'exports', '__dirname', code)(requireFixture, module, module.exports, path.dirname(fileURLToPath(filename)));
  const ownerWindow = new WindowFixture(); ownerWindow.visible = true;
  // no-pet-ok: the reply window's existing class name (electron/brain/reply-window.ts)
  const { PetReplyWindow: ReplyWindow } = module.exports as { PetReplyWindow: new (owner: WindowFixture) => ReplyHost }, reply = new ReplyWindow(ownerWindow);
  t.after(() => reply.dispose());
  const child = () => windows[1]!;
  return { reply, owner: ownerWindow, child,
    ack(token: unknown) { ipcMain.emit('desk:reply-presented', { sender: child().webContents, senderFrame: child().webContents.mainFrame }, token); } };
}

test('the real reply window: the bubble steps aside from the control window and back; her shown reply and its read-aloud proof stay current', async t => {
  const f = hostFixture(t);
  const text = '控制窗口打开时，这句话也要一直看得见。';
  f.reply.update({ text, state: 'complete', anchor: { ...anchor } });
  await tick();
  const shown = f.reply.waitForPresentation(text);
  f.ack(f.child().sent.at(-1)!.presentationToken);
  assert.equal(await shown, true);
  const today = f.child().getBounds();
  assert.ok(overlapArea(today, controlRight) > 0, 'before: the bubble overlaps the control window');
  let control: ReplyBounds | null = controlRight;
  f.reply.setAvoidSource(() => control);
  f.reply.sync();
  const aside = f.child().getBounds();
  assert.equal(overlapArea(aside, controlRight), 0, 'after: clear of the control window');
  assert.equal(f.child().visible, true, 'still shown');
  assert.ok(!f.child().calls.includes('hide'), 'never hidden to avoid');
  assert.equal(f.reply.isPresentationCurrent(text), true, 'the paint receipt (read-aloud and dwell) is still current');
  assert.ok(!f.child().calls.includes('setAlwaysOnTop'), 'no z-order call (it would lift her, I-062)');
  const render = f.child().sent.at(-1)!;
  assert.deepEqual(render.layout.bounds, aside); assert.equal(render.text, undefined, 'the text is not re-sent or cleared');
  // The control window hides: today's place comes back (today's side was remembered, not the temporary left).
  control = null; f.reply.sync();
  assert.deepEqual(f.child().getBounds(), today);
  assert.equal(f.reply.isPresentationCurrent(text), true);
  // A throwing source counts as no control window.
  f.reply.setAvoidSource(() => { throw new Error('closed'); }); f.reply.sync();
  assert.deepEqual(f.child().getBounds(), today);
});

// 2026-11-21 (the bubble swung from side to side and was cut off at the left; docs/claude/2026-11-21-bubble-placement.md): through the real reply window.
test('the real reply window: she walks across the display mid-reply: one side, always inside the display; a new reply chooses afresh', async t => {
  const f = hostFixture(t);
  const here = { x: 200, y: 210, radius: 110, visible: true };
  f.reply.update({ text: '第一句。', state: 'streaming', anchor: here });
  await tick();
  const sides = new Set<string>();
  let n = 0;
  for (let x = -150; x <= 1700; x += 30) {
    f.owner.bounds = { x, y: 200, width: 400, height: 560 }; f.owner.emit('move');
    f.reply.update({ text: '第一句。'.repeat(1 + (n++ % 5)), state: 'streaming', anchor: here });
    const bounds = f.child().getBounds();
    sides.add(f.child().sent.at(-1)!.layout.side);
    assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, `inside at ${x}`);
  }
  assert.equal(sides.size, 1, 'one side for the whole reply');
  f.reply.update({ state: 'hidden' });
  f.owner.bounds = { x: 1520, y: 200, width: 400, height: 560 };
  f.reply.update({ text: '新的一条。', state: 'streaming', anchor: here });
  assert.equal(f.child().sent.at(-1)!.layout.side, 'left', 'the next reply, at the right edge, takes the left (the old one was hidden)');
  // A new reply that starts while the old one still lingers ("……" first) chooses afresh as well.
  f.reply.update({ text: '新的一条。', state: 'complete', anchor: here });
  f.owner.bounds = { x: 0, y: 200, width: 400, height: 560 }; f.owner.emit('move');
  assert.equal(f.child().sent.at(-1)!.layout.side, 'left', 'still locked to the left while that reply lingers, even at the left edge');
  f.reply.update({ state: 'waiting', anchor: here });
  f.reply.update({ text: '又来一条。', state: 'streaming', anchor: here });
  assert.equal(f.child().sent.at(-1)!.layout.side, 'right', 'the one after, back at the left edge, takes the right');
});
