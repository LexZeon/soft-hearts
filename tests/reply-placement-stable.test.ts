// 2026-11-21 13:32 (dev build, the companion on the Unbound engine): the bubble swung from side to side, was cut off at the left, and the last sentences did not show.
// Record: docs/claude/2026-11-21-bubble-placement.md. The placement (electron/brain/reply-keeper.ts, reply-layout.ts lockSide, reply-avoid.ts) keeps
// one side per reply and always inside the display; the page (electron/brain/reply-scroll.ts) keeps the newest sentence in view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutReply, REPLY_GEOMETRY, type ReplyBounds, type ReplyLayout } from '../electron/brain/reply-layout';
import { REPLY_SETTLE_DIP, ReplyPlacementKeeper } from '../electron/brain/reply-keeper';
import { chooseReplyPlacement } from '../electron/brain/reply-avoid';
import { atBottom, settleScroll, wasFollowing, type ScrollBox } from '../electron/brain/reply-scroll';
import { BubbleFollow } from '../shared/voice/bubble-follow/follow';
import { BUBBLE_FOLLOW_KNOBS } from '../shared/voice/bubble-follow/knobs';

const { SHADOW } = REPLY_GEOMETRY;
// Two display shapes in DIP: 1920x1080 at 100% and the same panel at 150% (1280x720 DIP), the second with the taskbar off the bottom and a
// second display to its left (negative x).
const displays: Array<{ name: string; area: ReplyBounds }> = [
  { name: '100%', area: { x: 0, y: 0, width: 1920, height: 1040 } },
  { name: '150% (second display on the left)', area: { x: -1280, y: 0, width: 1280, height: 680 } },
];
const globalBody = (layout: ReplyLayout): ReplyBounds => ({ ...layout.body, x: layout.bounds.x + layout.body.x, y: layout.bounds.y + layout.body.y });
const insideDisplay = (rect: ReplyBounds, area: ReplyBounds) => rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height;
/** Her window 360 DIP wide whose head is at `mouthX` (screen), so the anchor moves across the display like she is walking. */
const she = (area: ReplyBounds, mouthX: number, mouthY = area.y + 300) => ({
  owner: { x: mouthX - 180, y: mouthY - 210, width: 360, height: 520 },
  anchor: { x: 180, y: 210, radius: 90, visible: true },
});

test('before the fix: the unlocked placement flips sides as her head crosses the display', () => {
  const { area } = displays[0];
  const sides = new Set<string>();
  for (let x = 40; x <= 1880; x += 20) { const p = she(area, x); sides.add(layoutReply(p.owner, p.anchor, area, 'right')!.side); }
  assert.ok(sides.size > 1, 'the old behaviour: the bubble sat on both sides');
});

for (const { name, area } of displays) {
  test(`${name}: one reply, her head sweeping edge to edge and back, "……" then text: one side, never cut off, never narrower than the minimum`, () => {
    const keeper = new ReplyPlacementKeeper();
    const xs: number[] = [];
    for (let x = area.x + 30; x <= area.x + area.width - 30; x += 25) xs.push(x);
    const path = [...xs, ...[...xs].reverse()];
    let side: string | undefined;
    path.forEach((x, i) => {
      const p = she(area, x);
      const choice = keeper.place(p.owner, p.anchor, area, 'right', i === 0, null); // the first is the small "……", the rest are text
      assert.ok(choice.layout, `placed at ${x}`);
      side ??= choice.layout.side;
      assert.equal(choice.layout.side, side, `no flip at ${x}`);
      const body = globalBody(choice.layout);
      assert.ok(insideDisplay(body, { x: area.x + SHADOW, y: area.y + SHADOW, width: area.width - SHADOW * 2, height: area.height - SHADOW * 2 }), `body inside the display at ${x}`);
      assert.ok(insideDisplay(choice.layout.bounds, area), `window inside the display at ${x}`);
      if (i > 0) assert.ok(body.width >= REPLY_GEOMETRY.MIN_WIDTH, `readable width at ${x}: ${body.width}`);
    });
  });

  test(`${name}: at either edge from the start, every placement is inside and the side holds`, () => {
    for (const x of [area.x + 20, area.x + 120, area.x + area.width - 120, area.x + area.width - 20]) {
      const keeper = new ReplyPlacementKeeper();
      const p = she(area, x);
      const first = keeper.place(p.owner, p.anchor, area, undefined, true, null)!;
      const again = keeper.place({ ...p.owner, x: p.owner.x + (x < area.x + area.width / 2 ? 60 : -60) }, p.anchor, area, undefined, false, null)!;
      const back = keeper.place({ ...p.owner }, p.anchor, area, undefined, false, null)!;
      for (const c of [first, again, back]) {
        assert.ok(c.layout && insideDisplay(c.layout.bounds, area), `inside at ${x}`);
        assert.equal(c.layout!.side, first.layout!.side, `side at ${x}`);
      }
    }
  });
}

test('the side comes from the full-size bubble: a crowded right edge puts a small "……" and its text on the left together', () => {
  const area = displays[0].area;
  const p = she(area, 1920 - 230); // 230 to the right edge: 116 left of her head: room for the "……" (72) but not for the 140 minimum text bubble
  const keeper = new ReplyPlacementKeeper();
  const dots = keeper.place(p.owner, p.anchor, area, 'right', true, null);
  const text = keeper.place(p.owner, p.anchor, area, 'right', false, null);
  assert.equal(dots.layout!.side, 'left');
  assert.equal(text.layout!.side, 'left');
});

test('she sways a little: the bubble does not move; a drag or a real step does; it is inside after either', () => {
  const area = displays[0].area;
  const keeper = new ReplyPlacementKeeper();
  const p = she(area, 600);
  const first = keeper.place(p.owner, p.anchor, area, 'right', false, null);
  for (const dx of [-REPLY_SETTLE_DIP, -10, 7, REPLY_SETTLE_DIP]) {
    const swayed = keeper.place({ ...p.owner, x: p.owner.x + dx }, p.anchor, area, 'right', false, null);
    assert.equal(swayed.layout, first.layout, `still the same place after ${dx}`);
  }
  const dragged = keeper.place({ ...p.owner, x: p.owner.x + 200 }, p.anchor, area, 'right', false, null);
  assert.notDeepEqual(dragged.layout!.bounds, first.layout!.bounds);
  assert.equal(dragged.layout!.side, first.layout!.side);
  // A change of display or window size is never swallowed by the settle.
  const resized = keeper.place({ ...p.owner, x: p.owner.x + 200, width: 420 }, p.anchor, area, 'right', false, null);
  assert.ok(resized.layout && insideDisplay(resized.layout.bounds, area));
});

test('a reply that is gone releases the side: the next one chooses its own', () => {
  const area = displays[0].area;
  const keeper = new ReplyPlacementKeeper();
  const left = she(area, 300), right = she(area, 1700);
  assert.equal(keeper.place(left.owner, left.anchor, area, undefined, false, null).layout!.side, 'right');
  assert.equal(keeper.place(right.owner, right.anchor, area, undefined, false, null).layout!.side, 'right', 'locked while the reply shows (slid back inside, not flipped)');
  keeper.release();
  assert.equal(keeper.place(right.owner, right.anchor, area, undefined, false, null).layout!.side, 'left', 'a new reply at the right edge goes left');
});

test('a control window to keep clear does not flip a locked reply when a place on its own side is clear', () => {
  const area = displays[0].area;
  const p = she(area, 900);
  const keeper = new ReplyPlacementKeeper();
  const first = keeper.place(p.owner, p.anchor, area, 'right', false, null);
  assert.equal(first.layout!.side, 'right');
  const avoid = { x: 1100, y: 100, width: 700, height: 500 }; // over the bubble on her right
  const moved = keeper.place(p.owner, p.anchor, area, 'right', false, avoid);
  assert.equal(moved.layout!.side, 'right');
  assert.ok(!(moved.layout!.bounds.x < avoid.x + avoid.width && moved.layout!.bounds.x + moved.layout!.bounds.width > avoid.x
    && moved.layout!.bounds.y < avoid.y + avoid.height && moved.layout!.bounds.y + moved.layout!.bounds.height > avoid.y), 'clear of the control window');
  // Unlocked, the same inputs may take the other side (the old behaviour, the lock is what holds it).
  const open = chooseReplyPlacement(p.owner, p.anchor, area, 'right', false, avoid, null, false);
  assert.ok(open.layout);
});

test('layoutReply lock: the minimum width and a slide back inside, never the other side', () => {
  const area = displays[0].area;
  const p = she(area, 1920 - 60);
  const loose = layoutReply(p.owner, p.anchor, area, 'right')!;
  const locked = layoutReply(p.owner, p.anchor, area, 'right', false, true)!;
  assert.equal(loose.side, 'left');
  assert.equal(locked.side, 'right');
  const body = globalBody(locked);
  assert.ok(body.width >= REPLY_GEOMETRY.MIN_WIDTH && body.x + body.width <= 1920 - SHADOW);
});

// The body of the reply page: height 165, text wraps by width. A stand-in for the real element with the same three numbers.
function page(sentences: string[]): { box: ScrollBox & { width: number }; relayout(width: number): void; setText(count: number): void } {
  let width = 285, count = 0;
  const box = {
    scrollTop: 0, clientHeight: 165, width,
    get scrollHeight() {
      const chars = sentences.slice(0, count).map(s => Math.ceil(s.length * 12 / (width - 30)) * 22 + 20 + 7).reduce((a, b) => a + b, 0);
      return Math.max(165, chars);
    },
  };
  return { box: Object.assign(box, { get width() { return width; } }) as never, relayout: w => { width = w; if (box.scrollTop > box.scrollHeight - box.clientHeight) box.scrollTop = box.scrollHeight - box.clientHeight; }, setText: n => { count = n; } };
}
const sentences = ['你来啦，今天过得怎么样呀？', '我刚刚在想你说的那件事，觉得挺有意思的。', '后来又想了想，还是觉得应该告诉你。', '所以现在就说了。', '最后这一句也要看得见。'];

test('the page: a bubble that got narrower keeps showing its newest sentences (the last ones were cut off below the box)', () => {
  const p = page(sentences);
  p.setText(5);
  p.box.scrollTop = p.box.scrollHeight - p.box.clientHeight; // following, at the end
  assert.ok(atBottom(p.box));
  const following = wasFollowing(p.box, true);
  p.relayout(150); // her head moved toward the left edge: the bubble is narrower, the same text is taller
  settleScroll(p.box, { hadBody: true, changedText: false, following });
  assert.ok(atBottom(p.box), 'the last line is in view again');
  // The old code (only when the text changed) left it where it was.
  const old = page(sentences); old.setText(5); old.box.scrollTop = old.box.scrollHeight - old.box.clientHeight;
  const before = old.box.scrollTop; old.relayout(150);
  assert.equal(old.box.scrollTop, before);
  assert.ok(!atBottom(old.box), 'without the fix the end is below the cut');
});

test('the page: a reader who had scrolled up is not pulled down; the first text starts at the top; new text follows to the end', () => {
  const p = page(sentences); p.setText(5);
  p.box.scrollTop = 0;
  assert.equal(wasFollowing(p.box, true), false);
  settleScroll(p.box, { hadBody: true, changedText: false, following: false });
  assert.equal(p.box.scrollTop, 0);
  assert.equal(wasFollowing(p.box, false), true, 'no body yet: following');
  settleScroll(p.box, { hadBody: false, changedText: true, following: true });
  assert.equal(p.box.scrollTop, 0, 'the first text starts at its top');
  settleScroll(p.box, { hadBody: true, changedText: true, following: false });
  assert.ok(atBottom(p.box), 'arriving text follows to its end');
});

test('every sentence is shown by the end, also when the voice stalls part way (the reveal never drops text)', () => {
  const ENDS = [13, 33, 50, 58, 70];
  const stall = new BubbleFollow({ ...BUBBLE_FOLLOW_KNOBS, mode: 'sentence' });
  stall.begin('r1', 0);
  ENDS.forEach((end, i) => stall.segment('r1', i, end, 10));
  stall.heard('r1', 0, 'start', 400); stall.heard('r1', 0, 'end', 2400); stall.heard('r1', 1, 'start', 2400);
  assert.equal(stall.cap('r1', 2500), 33, 'two sentences so far');
  // Sentence two never ends and the next never starts: the rest shows at once and for good.
  const later = 2400 + BUBBLE_FOLLOW_KNOBS.sentenceMaxMs + 1;
  assert.equal(stall.cap('r1', later), null);
  assert.equal(stall.cap('r1', later + 5000), null, 'and it stays shown');
  // The page then holds all five sentences and ends on the last.
  const p = page(sentences); p.setText(5);
  settleScroll(p.box, { hadBody: true, changedText: true, following: true });
  assert.ok(atBottom(p.box));
});
