import test from "node:test";
import assert from "node:assert/strict";
import { layoutReply, type ReplyAnchor, type ReplyBounds, type ReplyLayout } from "../electron/reply-layout";

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const owner = { x: 100, y: 200, width: 400, height: 560 };
const anchor = { x: 200, y: 210, radius: 110, visible: true };
const globalBody = (layout: ReplyLayout): ReplyBounds => ({ ...layout.body, x: layout.bounds.x + layout.body.x, y: layout.bounds.y + layout.body.y });
function checked(layout: ReplyLayout | null, parent: ReplyBounds, mouth: ReplyAnchor, display: ReplyBounds): ReplyLayout {
  assert.ok(layout);
  const body = globalBody(layout), px = parent.x + mouth.x, py = parent.y + mouth.y;
  const radius = Math.max(20, mouth.radius ?? Math.min(parent.width * 0.2, 80));
  assert.ok(body.x >= display.x && body.y >= display.y);
  assert.ok(body.x + body.width <= display.x + display.width + 1e-6);
  assert.ok(body.y + body.height <= display.y + display.height + 1e-6);
  assert.ok(body.width >= 140 && body.height >= 44);
  assert.ok(body.x >= px + radius || body.x + body.width <= px - radius || body.y >= py + radius || body.y + body.height <= py - radius, "body stays outside the head keepout");
  const tip = { x: layout.bounds.x + layout.tip.x, y: layout.bounds.y + layout.tip.y };
  assert.equal(tip.x, layout.side === 'right' ? body.x + 6 : body.x + body.width - 6);
  assert.equal(tip.y, layout.above ? body.y + body.height + 10 : body.y - 10);
  assert.ok(layout.bounds.width <= body.width + 18, 'native width excludes the remote mouth gap');
  assert.ok(layout.bounds.height <= body.height + 28, 'native height contains only body, short tail and shadow');
  assert.ok(layout.bounds.x >= display.x && layout.bounds.y >= display.y);
  assert.ok(layout.bounds.x + layout.bounds.width <= display.x + display.width);
  assert.ok(layout.bounds.y + layout.bounds.height <= display.y + display.height);
  return layout;
}

test("reply extends beside the head beyond the pet viewport without changing its bounds", () => {
  const before = structuredClone(owner);
  const layout = checked(layoutReply(owner, anchor, area), owner, anchor, area);
  assert.equal(layout.side, "right");
  assert.ok(globalBody(layout).x + layout.body.width > owner.x + owner.width);
  assert.equal(layout.above, true);
  assert.deepEqual(owner, before);
});

test("monitor edges choose the open side and retain a preferred side while readable", () => {
  const atRight = { ...owner, x: 1500 };
  const layout = checked(layoutReply(atRight, anchor, area), atRight, anchor, area);
  assert.equal(layout.side, "left");
  const center = { ...owner, x: 760 };
  assert.equal(checked(layoutReply(center, anchor, area, "left"), center, anchor, area).side, "left");
  const atLeft = { ...owner, x: 0 };
  assert.equal(checked(layoutReply(atLeft, anchor, area, "left"), atLeft, anchor, area).side, "right");
});

test("negative-coordinate displays and fractional logical anchors keep a short directional tail", () => {
  const display = { x: -1920, y: -140, width: 1920, height: 1080 };
  const parent = { ...owner, x: -1620, y: -50 };
  const point = { ...anchor, x: 201.25, y: 105.75, radius: 87.5 };
  checked(layoutReply(parent, point, display), parent, point, display);
});

test("a near-top mouth uses the upper corner of a body below it; bottom mouths stay above", () => {
  const parent = { ...owner, y: 0 };
  const top = { ...anchor, y: 16 };
  const layout = checked(layoutReply(parent, top, area), parent, top, area);
  assert.equal(layout.above, false);
  const lowParent = { ...owner, y: 480 };
  const lowPoint = { ...anchor, y: 550 };
  assert.equal(checked(layoutReply(lowParent, lowPoint, area), lowParent, lowPoint, area).above, true);
});

test("a narrow display falls back outside the head vertically and refuses genuinely blocked space", () => {
  const display = { x: 0, y: 0, width: 320, height: 900 };
  const parent = { x: 0, y: 0, width: 320, height: 800 };
  const point = { x: 160, y: 500, radius: 130, visible: true };
  const layout = checked(layoutReply(parent, point, display), parent, point, display);
  assert.ok(globalBody(layout).y + layout.body.height <= point.y - point.radius);
  assert.equal(layoutReply({ ...parent, height: 300 }, { ...point, y: 150, radius: 150 }, { ...display, height: 300 }), null);
});

test("hidden, non-finite, huge and unreadably small inputs never produce native bounds", () => {
  assert.equal(layoutReply(owner, { ...anchor, visible: false }, area), null);
  assert.equal(layoutReply(owner, { ...anchor, x: NaN }, area), null);
  assert.equal(layoutReply(owner, { ...anchor, radius: Infinity }, area), null);
  assert.equal(layoutReply({ ...owner, width: 1e12 }, anchor, area), null);
  assert.equal(layoutReply(owner, anchor, { ...area, width: 100 }), null);
  assert.equal(layoutReply({ ...owner, x: -10000 }, anchor, area), null);
});

test('waiting uses a small body outside the face while ordinary replies retain their original layout', () => {
  const before = structuredClone(owner), ordinary = layoutReply(owner, anchor, area)!;
  const waiting = layoutReply(owner, anchor, area, undefined, true)!;
  assert.equal(waiting.body.width, 72); assert.equal(waiting.body.height, 44);
  assert.equal(ordinary.body.width, 285); assert.equal(ordinary.body.height, 165);
  const body = globalBody(waiting), px = owner.x + anchor.x, py = owner.y + anchor.y;
  assert.ok(body.x >= px + anchor.radius || body.x + body.width <= px - anchor.radius || body.y >= py + anchor.radius || body.y + body.height <= py - anchor.radius);
  assert.equal(waiting.tip.y - waiting.body.y - waiting.body.height, 10);
  assert.ok(waiting.bounds.width <= 90); assert.ok(waiting.bounds.height <= 72);
  assert.deepEqual(owner, before);
  assert.deepEqual(layoutReply(owner, anchor, area, undefined, false), ordinary);
});

test('large head gaps never stretch either waiting or text tails to the mouth', () => {
  const display = { x: 0, y: 0, width: 6000, height: 4000 };
  const parent = { x: 1000, y: 1000, width: 500, height: 600 };
  const mouth = { x: 250, y: 300, radius: 1000, visible: true };
  for (const compact of [false, true]) {
    const layout = layoutReply(parent, mouth, display, undefined, compact)!;
    const body = globalBody(layout);
    const globalTip = { x: layout.bounds.x + layout.tip.x, y: layout.bounds.y + layout.tip.y };
    assert.ok(body.x >= parent.x + mouth.x + mouth.radius, 'body remains outside the head');
    assert.ok(Math.hypot(globalTip.x - parent.x - mouth.x, globalTip.y - parent.y - mouth.y) > 1000, 'tip does not chase the mouth');
    assert.equal(globalTip.y - body.y - body.height, 10);
    assert.ok(layout.bounds.width <= body.width + 18);
    assert.ok(layout.bounds.height <= body.height + 28);
  }
});

test('compact waiting fits narrow spaces and preserves edge, hidden-anchor and blocked-face rules', () => {
  for (const x of [0, 1500]) {
    const parent = { ...owner, x }, layout = layoutReply(parent, anchor, area, undefined, true)!;
    const body = globalBody(layout);
    assert.equal(layout.body.width, 72); assert.equal(layout.body.height, 44);
    assert.ok(body.x >= area.x && body.x + body.width <= area.width);
    assert.ok(body.y >= area.y && body.y + body.height <= area.height);
  }
  const display = { x: -100, y: 0, width: 120, height: 400 };
  const parent = { x: -100, y: 0, width: 120, height: 300 };
  const point = { x: 60, y: 200, radius: 55, visible: true };
  const layout = layoutReply(parent, point, display, undefined, true)!;
  assert.ok(layout); assert.equal(layout.body.width, 72);
  assert.ok(globalBody(layout).y + layout.body.height < point.y - point.radius);
  assert.equal(layoutReply(parent, { ...point, visible: false }, display, undefined, true), null);
  assert.equal(layoutReply(parent, point, { ...display, width: 70 }, undefined, true), null);
});
