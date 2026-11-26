// T-253 option 1 (docs/claude/2026-11-19-control-window-avoid.md): she steps aside from the control window's input / send / stop band only
// when her body really covers it, never while the user drags her, by a bounded eased move, and walks back when the window goes away.
// Fake window, fake clock, fake timers; the move is measured per tick at a 60 Hz and a 30 Hz main-process timer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyFootprint, coversRegion, decideStepAside, CompanionStepAside, protectedRegion, shownWindowRect, STEP_ASIDE, stepAsideTarget,
  type StepRect } from '../electron/stage/companion-step-aside';

const area = { x: 0, y: 0, width: 1920, height: 1040 };

function avoidable(state: { visible?: boolean; minimized?: boolean; destroyed?: boolean; bounds?: StepRect; content?: StepRect } = {}) {
  const bounds = state.bounds ?? { x: 300, y: 100, width: 1260, height: 850 };
  return { isDestroyed: () => !!state.destroyed, isVisible: () => state.visible !== false, isMinimized: () => !!state.minimized,
    getBounds: () => ({ ...bounds }), getContentBounds: () => ({ ...(state.content ?? { x: bounds.x + 8, y: bounds.y + 31, width: bounds.width - 16, height: bounds.height - 39 }) }) };
}

test('the control window counts only while shown and not minimized; its protected area is the bottom band of its content', () => {
  assert.equal(shownWindowRect(null), null);
  assert.equal(shownWindowRect(avoidable({ visible: false })), null);
  assert.equal(shownWindowRect(avoidable({ minimized: true })), null);
  assert.equal(shownWindowRect(avoidable({ destroyed: true })), null);
  assert.deepEqual(shownWindowRect(avoidable()), { x: 300, y: 100, width: 1260, height: 850 });
  assert.equal(protectedRegion(avoidable({ minimized: true })), null);
  assert.equal(protectedRegion(avoidable({ visible: false })), null);
  assert.deepEqual(protectedRegion(avoidable({ content: { x: 308, y: 131, width: 1244, height: 811 } })), { x: 308, y: 742, width: 1244, height: 200 });
  // A short window: at most 40 % of its height.
  assert.deepEqual(protectedRegion(avoidable({ content: { x: 0, y: 0, width: 960, height: 300 } })), { x: 0, y: 180, width: 960, height: 120 });
});

test('really covers: with click-through on, the transparent edge of her window does not count; her body does', () => {
  const region = { x: 300, y: 742, width: 1244, height: 200 };
  const edgeOnly = { x: 1450, y: 500, width: 400, height: 560 }; // body x 1550..1750: right of the band
  assert.equal(coversRegion(edgeOnly, region, true), false);
  assert.equal(coversRegion(edgeOnly, region, false), true, 'click-through off: the whole window takes the mouse');
  const body = { x: 1000, y: 500, width: 400, height: 560 };
  assert.equal(coversRegion(body, region, true), true);
  const brush = { x: 1000, y: 742 - 560 + 10, width: 400, height: 560 }; // 10 DIP over the band's top edge
  assert.equal(coversRegion(brush, region, true), false, 'a brush under minOverlap is not covering');
  assert.deepEqual(bodyFootprint(body, true), { x: 1100, y: 556, width: 200, height: 504 });
});

test('the step is the nearest clear place inside the work area, at most maxStep; none farther', () => {
  const region = { x: 300, y: 742, width: 1244, height: 200 };
  const home = { x: 1000, y: 470, width: 400, height: 560 }; // body 1100..1300 x 526..1030
  const target = stepAsideTarget(home, region, area, true)!;
  assert.ok(target);
  assert.equal(coversRegion(target, region, true), false);
  assert.ok(Math.hypot(target.x - home.x, target.y - home.y) <= STEP_ASIDE.maxStep);
  assert.ok(target.x >= area.x && target.y >= area.y && target.x + target.width <= area.width && target.y + target.height <= area.height);
  assert.equal(target.width, home.width); assert.equal(target.height, home.height);
  // A tall protected area under her whole body, wide on both sides: nowhere within reach.
  const huge = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(stepAsideTarget(home, huge, area, true), null);
  assert.deepEqual(decideStepAside({ current: home, home: null, region: huge, area, clickThrough: true, suppressed: false }).target, home, 'no place within reach: she stays');
});

// ---------------------------------------------------------------- the moving part

function rig(options: { tickMs?: number } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 0;
  const win = { bounds: { x: 1000, y: 470, width: 400, height: 560 }, calls: [] as string[], destroyed: false };
  const state = { region: { x: 300, y: 742, width: 1244, height: 200 } as StepRect | null, dragging: false, enabled: true, clickThrough: true };
  let aside!: CompanionStepAside;
  const window = {
    isDestroyed: () => win.destroyed,
    getBounds: () => ({ ...win.bounds }),
    setBounds: (next: StepRect) => { win.calls.push('setBounds'); win.bounds = { ...next }; aside.windowMoved(); },
  };
  aside = new CompanionStepAside({
    window: () => window, region: () => state.region, area: () => area, dragging: () => state.dragging, enabled: () => state.enabled,
    clickThrough: () => state.clickThrough, now: () => now,
    // A late main-process timer: every 16 ms request fires after tickMs (60 Hz: 16, 30 Hz: 33).
    schedule: (fn, ms) => { const id = nextId++; timers.push({ at: now + (ms === STEP_ASIDE.tickMs ? (options.tickMs ?? ms) : ms), fn, id }); return () => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); }; },
  });
  const positions: { x: number; y: number }[] = [];
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > end) break;
      timers.shift(); now = due.at;
      const before = { ...win.bounds };
      due.fn();
      if (before.x !== win.bounds.x || before.y !== win.bounds.y) positions.push({ x: win.bounds.x, y: win.bounds.y });
    }
    now = end;
  };
  return { aside, win, state, advance, positions, userMoves(next: StepRect) { win.bounds = { ...next }; aside.windowMoved(); } };
}
const steps = (positions: { x: number; y: number }[], from: { x: number; y: number }) => {
  const out: number[] = []; let previous = from;
  for (const p of positions) { out.push(Math.hypot(p.x - previous.x, p.y - previous.y)); previous = p; }
  return out;
};

for (const [label, tickMs] of [['60 Hz', 16], ['30 Hz', 33]] as const) {
  test(`steps aside smoothly and walks back (${label} timer): bounded, eased, every tick a short step`, () => {
    const r = rig({ tickMs });
    const home = { ...r.win.bounds };
    r.aside.check();
    r.advance(1000);
    const target = { ...r.win.bounds };
    assert.equal(coversRegion(target, r.state.region!, true), false, 'her body is off the band');
    const distance = Math.hypot(target.x - home.x, target.y - home.y);
    assert.ok(distance > 0 && distance <= STEP_ASIDE.maxStep, `bounded (${distance})`);
    assert.deepEqual(r.aside.homeBounds, home, 'home remembered in memory only');
    const out = steps(r.positions, home);
    const largest = Math.max(...out);
    const speedChange = Math.max(...out.slice(1).map((s, i) => Math.abs(s - out[i]!)));
    // Smootherstep: peak speed 1.875 x average. Over STEP_ASIDE durations this stays far under a visible jump.
    const limit = tickMs === 16 ? 16 : 32;
    assert.ok(largest <= limit, `${label}: largest step ${largest.toFixed(1)} DIP (limit ${limit})`);
    assert.ok(out[0]! <= 3 && out.at(-1)! <= 3, `${label}: starts and ends slowly (${out[0]}, ${out.at(-1)})`);
    console.log(`[step-aside ${label}] distance ${distance.toFixed(0)} DIP, ticks ${out.length}, largest step ${largest.toFixed(1)} DIP, largest change of step ${speedChange.toFixed(1)} DIP`);
    // The control window hides: she walks back to exactly where she was, the same way.
    r.state.region = null; r.positions.length = 0;
    r.aside.check();
    r.advance(1000);
    assert.deepEqual(r.win.bounds, home);
    assert.equal(r.aside.homeBounds, null);
    assert.ok(Math.max(...steps(r.positions, target)) <= limit);
    assert.deepEqual([...new Set(r.win.calls)], ['setBounds'], 'only setBounds: no z-order call, no show, no focus');
  });
}

test('not while dragging: no move starts, a drag that begins mid-move stops it at once, and her new place is hers', () => {
  const r = rig();
  r.state.dragging = true;
  r.aside.check();
  assert.equal(r.aside.moving, false, 'no move even begins while the user holds her');
  r.advance(1000);
  assert.equal(r.win.calls.length, 0, 'nothing moves while the user holds her');
  r.state.dragging = false;
  r.aside.check(); r.advance(1000);
  assert.equal(r.win.calls.length, 0, 'released on the band: the user put her there, she stays');
  r.state.region = { x: 310, y: 742, width: 1244, height: 200 }; // the control window moves a little
  r.aside.check(); r.advance(100);
  const calls = r.win.calls.length;
  assert.ok(calls > 0 && r.aside.moving, 'the move began');
  r.state.dragging = true;
  r.advance(500);
  assert.equal(r.win.calls.length, calls, 'no setBounds under the user\'s hand');
  assert.equal(r.aside.homeBounds, null, 'the old home is forgotten');
  // The user drops her on the band: that is her choice for this control window position.
  r.userMoves({ x: 1000, y: 470, width: 400, height: 560 });
  r.state.dragging = false;
  r.aside.check(); r.advance(1000);
  assert.equal(r.win.calls.length, calls, 'she stays where the user put her');
  // The control window moves: the rule applies again.
  r.state.region = { x: 320, y: 742, width: 1244, height: 200 };
  r.aside.check(); r.advance(1000);
  assert.ok(r.win.calls.length > calls);
  assert.equal(coversRegion(r.win.bounds, r.state.region, true), false);
});

test('a move by anyone else while she is aside (recovery, resize, taskbar) makes that place her home: no walking back to the old one', () => {
  const r = rig();
  r.aside.check(); r.advance(1000);
  assert.ok(r.aside.homeBounds);
  const recovered = { x: 760, y: 240, width: 400, height: 560 };
  r.state.region = null; // the control window goes away too: she would walk back to the old home if she still had one
  r.userMoves(recovered);
  const calls = r.win.calls.length;
  r.aside.check(); r.advance(1000);
  assert.equal(r.aside.homeBounds, null);
  assert.equal(r.win.calls.length, calls);
  assert.deepEqual(r.win.bounds, recovered);
});

test('a move by anyone else in the middle of her step stops the step at once', () => {
  const r = rig();
  r.aside.check(); r.advance(120);
  assert.ok(r.aside.moving);
  const calls = r.win.calls.length;
  r.win.bounds = { x: 760, y: 240, width: 400, height: 560 }; // recovery's setBounds, with no move event yet
  r.advance(1000);
  assert.equal(r.win.calls.length, calls, 'no further step over the other mover');
  assert.deepEqual(r.win.bounds, { x: 760, y: 240, width: 400, height: 560 });
});

test('farther than maxStep: no step even when a far place would be clear', () => {
  const home = { x: 1000, y: 470, width: 400, height: 560 }; // body 1100..1300 x 526..1030
  const tall = { x: 0, y: 600, width: 1700, height: 440 }; // up needs 442; right clears only at x 1520 (520 away)
  assert.equal(stepAsideTarget(home, tall, area, true), null);
});

test('hidden, minimized or out in Unbound: no move; a band she does not really cover: no move', () => {
  const r = rig();
  r.state.enabled = false;
  r.aside.check(); r.advance(1000);
  assert.equal(r.win.calls.length, 0);
  r.state.enabled = true;
  r.win.bounds = { x: 1450, y: 470, width: 400, height: 560 }; // only her transparent edge over the band
  r.aside.check(); r.advance(1000);
  assert.equal(r.win.calls.length, 0);
});

test('becoming disabled mid-move stops the move where she is (no jump); stop() ends everything', () => {
  const r = rig();
  r.aside.check(); r.advance(120);
  const calls = r.win.calls.length;
  r.state.enabled = false; r.advance(500);
  assert.equal(r.win.calls.length, calls);
  r.aside.stop(); r.state.enabled = true; r.aside.check(); r.advance(1000);
  assert.equal(r.win.calls.length, calls);
});
