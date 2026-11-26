import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_VIEWER_DISTANCE_M, apparentHeightM, eyeHeightFor, placementAcross, projectToDip, type DisplayFacts, type Rect, type WorldView } from '../shared/unbound/world';
import { SyntheticWindowSource, sanitizeWindows, type SurfaceWindow } from '../shared/unbound/surfaces/windows';
import { coveredArea, findEdges, freeIntervals, maskRects, mergeIntervals, subtractIntervals } from '../shared/unbound/surfaces/geometry';
import { occlusion, unprojectAtDepth, type Her } from '../shared/unbound/surfaces/body';
import { depthToFitWindow, planBetween, planLeanOn, planPeek } from '../shared/unbound/surfaces/plan';

const bounds: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const facts: DisplayFacts = { bounds, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, internal: true };
const screen = { widthM: 0.34, heightM: 0.34 * 1080 / 1920, source: 'measured' as const, detail: 'test' };
const view: WorldView = { screen, display: bounds, viewerDistanceM: DEFAULT_VIEWER_DISTANCE_M, eyeHeightM: eyeHeightFor(screen, facts, DEFAULT_VIEWER_DISTANCE_M) };
const win = (id: number, x: number, y: number, width: number, height: number, z = id): SurfaceWindow => ({ id, rect: { x, y, width, height }, z });
const herAt = (across: number, depthM = 8, heightM = 1.6): Her => ({ placement: placementAcross(view, across, depthM), heightM });
const near = (a: number, b: number, tolerance: number, what = '') => assert.ok(Math.abs(a - b) <= tolerance, `${what} ${a} vs ${b} (±${tolerance})`);

test('unprojecting a display point onto her depth plane inverts the projection', () => {
  for (const depth of [0.6, 2.5, 8, 15]) {
    const point = unprojectAtDepth(view, { x: 1300, y: 700 }, depth);
    const back = projectToDip(view, point)!;
    near(back.x, 1300, 1e-6); near(back.y, 700, 1e-6);
  }
});

test('interval and area helpers: merged unions are not double counted', () => {
  assert.deepEqual(mergeIntervals([[5, 9], [0, 3], [2, 4]]), [[0, 4], [5, 9]]);
  assert.deepEqual(subtractIntervals([0, 10], [[2, 3], [8, 12]]), [[0, 2], [3, 8]]);
  const cell: Rect = { x: 0, y: 0, width: 10, height: 10 };
  // two 6x10 windows overlapping by 2: the union is 10x10
  assert.equal(coveredArea(cell, [{ x: 0, y: 0, width: 6, height: 10 }, { x: 4, y: 0, width: 6, height: 10 }]), 100);
  assert.equal(coveredArea(cell, [{ x: -5, y: -5, width: 10, height: 10 }]), 25);
  assert.equal(coveredArea(cell, []), 0);
});

test('the mask is the union as disjoint rectangles (overlaps cannot punch holes in an even-odd mask)', () => {
  const rects: Rect[] = [{ x: 0, y: 0, width: 600, height: 400 }, { x: 400, y: 200, width: 600, height: 400 }, { x: 1500, y: 100, width: 50, height: 50 }];
  const pieces = maskRects(rects);
  const cell: Rect = { x: -10, y: -10, width: 2000, height: 1000 };
  const sum = pieces.reduce((s, p) => s + p.width * p.height, 0);
  near(sum, coveredArea(cell, rects), 1e-6, 'same area as the union');
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) assert.equal(coveredArea(pieces[i], [pieces[j]]), 0, 'disjoint');
  assert.deepEqual(maskRects([]), []);
});

test('a source gives only id, rectangle and order: titles and other fields are dropped, numbers made safe', () => {
  const dirty = [
    { id: 1, rect: { x: -100, y: 10, width: 300, height: 200 }, z: 2, title: 'secret.docx', processName: 'winword.exe' },
    { id: 2, rect: { x: 10, y: 10, width: 3, height: 500 }, z: 3 },
    { id: 3, rect: { x: Number.NaN, y: 0, width: 100, height: 100 }, z: 1 },
    { id: 4, rect: { x: 1800, y: 900, width: 500, height: 500 }, z: 0 },
  ] as unknown as SurfaceWindow[];
  const clean = sanitizeWindows(dirty, bounds);
  assert.deepEqual(clean.map(w => w.id), [4, 1], 'sliver and NaN dropped, back-to-front');
  assert.deepEqual(clean[1].rect, { x: 0, y: 10, width: 200, height: 200 }, 'clipped to the display');
  assert.deepEqual(clean[0].rect, { x: 1800, y: 900, width: 120, height: 180 });
  for (const w of clean) assert.deepEqual(Object.keys(w).sort(), ['id', 'rect', 'z']);
  assert.deepEqual(new SyntheticWindowSource(clean).read(), clean);
});

test('edges: display borders, edges inside another window and covered stretches are not offered', () => {
  const a = win(1, 100, 100, 600, 500), b = win(2, 400, 300, 600, 500, 2); // overlapping
  const edges = findEdges([a, b], bounds);
  const has = (side: string, id: number, at: number) => edges.filter(e => e.side === side && e.windowId === id && Math.abs(e.at - at) < 1e-9);
  assert.equal(has('right', 1, 700).length, 1, "a's right edge is free above b");
  assert.deepEqual(has('right', 1, 700)[0].span, [100, 300], 'only the stretch above b');
  assert.equal(has('left', 2, 400).length, 1);
  assert.deepEqual(has('left', 2, 400)[0].span, [600, 800], 'b is covered by nothing there; below a it is free');
  assert.equal(has('top', 2, 300).length, 1);
  assert.deepEqual(has('top', 2, 300)[0].span, [700, 1000], "b's top is inside a for x < 700");
  // window on the left display border: its left edge has nothing outside it
  const edge = findEdges([win(3, 0, 200, 500, 500)], bounds);
  assert.ok(!edge.some(e => e.side === 'left'));
  assert.ok(edge.some(e => e.side === 'right'));
  // a window touching the top: no top edge
  assert.ok(!findEdges([win(4, 300, 0, 500, 500)], bounds).some(e => e.side === 'top'));
  // a window as wide as the display: nothing to peek around sideways
  assert.deepEqual(findEdges([win(5, 0, 100, 1920, 800)], bounds).map(e => e.side), ['top']);
});

test('gaps: free stretches on a band ignore windows above and below it', () => {
  const free = freeIntervals([win(1, 0, 0, 500, 300), win(2, 900, 400, 400, 400), win(3, 1500, 600, 300, 300)], bounds, [450, 700]);
  assert.deepEqual(free, [[0, 900], [1300, 1500], [1800, 1920]]);
});

test('occlusion: nothing, everything, the lower half, and the same window hides different slices at different depths', () => {
  const her = herAt(0.5);
  assert.equal(occlusion(view, [], her)!.hidden, 0);
  const all = occlusion(view, [win(1, 0, 0, 1920, 1080)], her)!;
  near(all.hidden, 1, 1e-9); near(all.headShown, 0, 1e-9);
  const box = occlusion(view, [], her)!.box;
  const lower = occlusion(view, [win(1, 0, box.y + box.height * 0.5, 1920, 1080)], her)!;
  const byName = Object.fromEntries(lower.parts.map(p => [p.name, p.hidden]));
  near(byName.legs, 1, 1e-9); assert.ok(byName.head < 0.01, 'head above the window'); assert.ok(lower.hidden > 0.4 && lower.hidden < 0.9);
  // Her figure's size on the display follows the lens: tall at 8 m (about half the screen), small at 12 m.
  near(box.height, apparentHeightM(1.6, 8, view.viewerDistanceM) / screen.heightM * 1080, 2);
  const window = win(1, 700, 0, 520, 1080);
  const near2 = occlusion(view, [window], herAt(0.5, 2))!, far = occlusion(view, [window], herAt(0.5, 12))!;
  assert.ok(near2.hidden < far.hidden, 'close up she is big and spills out of a window that fully hides her far away');
  near(far.hidden, 1, 1e-6);
});

test('peek around the right edge: the head shows as asked, the body stays behind the window, and she leans toward the edge', () => {
  const her = herAt(0.5);
  const window = win(1, 100, 150, 900, 700); // right edge at 1000: right of centre of her (0.5 -> x=960)
  for (const reveal of [0.3, 0.55, 0.8]) {
    const plan = planPeek(view, [window], her, { reveal })!;
    assert.equal(plan.edge.side, 'right');
    assert.ok(plan.pose.leanRad > (reveal > 0.5 ? 0.1 : 0), 'leans toward +x, the right of the screen');
    near(plan.predicted.headShown, reveal, 0.03, `reveal ${reveal}`);
    assert.ok(plan.predicted.parts.find(p => p.name === 'torso')!.hidden >= 0.6 - 1e-9 || plan.pose.leanRad >= 0.59, 'body hidden unless she ran out of lean');
    assert.ok(plan.feasible, plan.notes.join('; '));
    // the head is where it should be relative to the edge: centre = edge + head half width * (2 reveal - 1), at her depth
    const edgeX = unprojectAtDepth(view, { x: 1000, y: 0 }, 8).x, headHalf = 0.09;
    near(plan.head.x, edgeX + headHalf * (2 * reveal - 1), 1e-9);
    near(plan.gazeYaw, Math.atan2(-plan.head.x, view.viewerDistanceM + 8), 1e-9, 'she looks at you');
  }
  // a bigger reveal needs a bigger lean (or the same: never smaller)
  const small = planPeek(view, [window], her, { reveal: 0.3 })!, big = planPeek(view, [window], her, { reveal: 0.8 })!;
  assert.ok(big.pose.leanRad >= small.pose.leanRad);
});

test('peek: the nearest usable edge wins, and a left edge mirrors the right one', () => {
  const left = win(1, 200, 150, 500, 700), rightWin = win(2, 1250, 150, 500, 700);
  const her = herAt(0.62); // x about 1190 on the display: nearer the right window's left edge (1250) than the left window's right edge (700)
  const plan = planPeek(view, [left, rightWin], her)!;
  assert.equal(plan.edge.windowId, 2); assert.equal(plan.edge.side, 'left');
  assert.ok(plan.pose.leanRad < -0.1, 'leans toward −x, the left of the screen');
  assert.ok(plan.stand.xM > unprojectAtDepth(view, { x: 1250, y: 0 }, 8).x, 'she stands behind the window, right of its left edge');
  const mirrored = planPeek(view, [win(1, 1920 - 700, 150, 500, 700)].map(w => w), herAt(0.5), { sides: ['left'] })!;
  const straight = planPeek(view, [win(1, 200, 150, 500, 700)], herAt(0.5), { sides: ['right'] })!;
  near(mirrored.pose.leanRad, -straight.pose.leanRad, 1e-9);
  near(mirrored.predicted.headShown, straight.predicted.headShown, 1e-9);
});

test('peek: nothing to peek around, window on the display border, windows too small to hide behind', () => {
  assert.equal(planPeek(view, [], herAt(0.5)), null);
  assert.equal(planPeek(view, [win(1, 0, 0, 1920, 1080)], herAt(0.5)), null, 'a window over everything has no free edge');
  assert.equal(planPeek(view, [win(1, 0, 150, 900, 700)], herAt(0.5), { sides: ['left'] }), null, 'its left edge is the display border');
  // a small window: she cannot hide behind it, and the plan says so instead of pretending
  const small = planPeek(view, [win(1, 900, 400, 120, 120)], herAt(0.5), { sides: ['right'] });
  assert.ok(small === null || !small.feasible, 'a 120 px window is not a hiding place for a 580 px tall girl');
  // her head is not level with a short window at this depth: flagged
  const low = planPeek(view, [win(1, 100, 800, 900, 250)], herAt(0.5), { sides: ['right'] });
  assert.ok(low === null || !low.feasible);
});

test('peek over the top: she rises on her toes only as far as she needs, never past her limit', () => {
  const her = herAt(0.5);
  const box = occlusion(view, [], her)!.box;
  const topY = box.y + box.height * 0.28; // the window top crosses her chest line... head just above it
  const window = win(1, 500, topY, 900, 1080 - topY);
  const plan = planPeek(view, [window], her, { sides: ['top'], reveal: 0.8 })!;
  assert.equal(plan.edge.side, 'top');
  assert.ok(plan.pose.riseM >= 0 && plan.pose.riseM <= 0.08 + 1e-12);
  const higher = win(1, 500, box.y + box.height * 0.6, 900, 500); // top edge at her hips: she is already taller than it
  const already = planPeek(view, [higher], her, { sides: ['top'], reveal: 0.8 })!;
  assert.equal(already.pose.riseM, 0);
});

test('lean on a side edge: the shoulder touches the edge line, she is fully visible beside the window', () => {
  const her = herAt(0.5);
  const window = win(1, 100, 100, 900, 880);
  const plan = planLeanOn(view, [window], her, { sides: ['right'] })!;
  assert.equal(plan.edge.side, 'right');
  near(plan.contact.x, unprojectAtDepth(view, { x: 1000, y: 0 }, 8).x, 1e-9);
  assert.ok(plan.pose.leanRad < 0, 'leans toward the window, which is at her −x side');
  near(plan.predicted.hidden, 0, 0.001); assert.ok(plan.feasible, plan.notes.join('; '));
  // the outer shoulder after the lean really is at the edge: shoulder box = torso top: its left side
  const torso = plan.predicted.parts.find(p => p.name === 'torso')!.rect;
  assert.ok(torso.x >= 1000 - 1 && torso.x < 1030, `torso box starts at the edge (the shoulder, higher up, touches it): ${torso.x}`);
  const mirrored = planLeanOn(view, [win(1, 920, 100, 900, 880)], herAt(0.5), { sides: ['left'] })!;
  assert.ok(mirrored.pose.leanRad > 0);
  // no room beside it: a window that ends at the display's right edge has no free edge on that side
  assert.equal(planLeanOn(view, [win(1, 1000, 100, 920, 880)], her, { sides: ['right'] }), null);
  // a window shorter than her torso: leaning on a corner, flagged
  const stub = planLeanOn(view, [win(1, 100, 700, 900, 300)], her, { sides: ['right'] });
  assert.ok(stub === null || !stub.feasible, 'a window whose side edge is nowhere near her torso is flagged');
});

test('between two windows: wide gap fits frontally and she stands in its middle; narrow gap is sideways or none', () => {
  const left = win(1, 0, 100, 500, 800), rightWin = win(2, 1420, 100, 500, 800);
  const wide = planBetween(view, [left, rightWin], herAt(0.5))!;
  assert.equal(wide.mode, 'frontal'); assert.deepEqual(wide.bounds, { left: 'window', right: 'window' });
  near(wide.stand.xM, 0, 1e-9); assert.ok(wide.predicted.hidden < 0.01);
  assert.deepEqual(wide.gap, [500, 1420]);
  // 380 px gap = 0.067 m*... at 8 m that is 0.35 m*(8.55/0.55)... compute the facts, do not trust the story
  const narrow = planBetween(view, [win(1, 0, 100, 800, 800), win(2, 1150, 100, 770, 800)], herAt(0.5))!;
  const narrowM = 350 * view.screen.widthM / 1920 * (view.viewerDistanceM + 8) / view.viewerDistanceM;
  near(narrow.gapM, narrowM, 1e-9);
  assert.equal(narrow.mode, narrowM >= 2 * 0.24 ? 'frontal' : narrowM >= 2 * (0.2 * 0.55 + 0.04) ? 'sideways' : 'none');
  // she is behind a window: the nearest free stretch is offered and she is told she is cut off
  const cut = planBetween(view, [win(1, 600, 0, 700, 1080)], herAt(0.5))!;
  assert.ok(cut.gap[1] <= 600 + 1e-9 || cut.gap[0] >= 1300 - 1e-9);
  assert.equal(planBetween(view, [win(1, 0, 0, 1920, 1080)], herAt(0.5)), null);
});

test('a window decides how far back she stands', () => {
  const depth = depthToFitWindow(view, 1.6, 600, 0.8);
  near(apparentHeightM(1.6, depth, view.viewerDistanceM), 0.8 * 600 * screen.heightM / 1080, 1e-6);
  assert.ok(depthToFitWindow(view, 1.6, 10, 0.8) <= 25, 'clamped to her range (DEPTH_RANGE_M, 25 m since I-212)');
  assert.ok(depthToFitWindow(view, 1.6, 100000, 0.8) >= 0.6);
});
