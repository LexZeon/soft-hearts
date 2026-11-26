// I-196:
// the joystick pull. Holding her body or head (hair included), the press point is the centre and the pointer's offset from it, in screen pixels, says where
// she goes (down = toward you, up = away, left and right = across); a small dead zone does nothing; the wheel over her is the same in steps.
// Pure rules (shared/unbound/pull-stick/), the page's controller with a fake body (src/unbound/pull-input.ts, pull-stick.ts), and Gene's real frame loop
// at the near end (the I-192 no-clipping guard is in the station). The click/touch side is tests/i194-click-not-touch.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { STICK_KNOBS, STICK_KNOB_RANGES, stickGoal, stickKnobs, stickReading, wheelDepth, wheelNotches } from '../shared/unbound/pull-stick';
import { CLICK_RULES } from '../shared/unbound/click';
import { UnboundPull, type StagePullHit, type UnboundPullFigure } from '../src/unbound/pull-input';
import { nearBodyOf, nearStations, type NearStations } from '../src/unbound/pull-near';
import { applyWorldCamera } from '../src/unbound/camera';
import { UNITS_PER_M } from '../src/unbound/figure';
import { clampFollowDepth, parsePullAnswer, parseUnboundPull, pullReportMessage, type UnboundPullMessage } from '../shared/unbound/pull';
import { usableFace } from '../shared/unbound/arrival';
import { geneFigure } from './helpers/unbound-gene';
import { LAPTOP, laptopLens, laptopView } from './helpers/unbound-peek';

const K = STICK_KNOBS;
const VIEWER = 0.55;
const answer = parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// ---- the rules ----------------------------------------------------------------------------------------------------------------------

test('inside the dead zone nothing moves, not even at its edge; just outside it moves smoothly from zero', () => {
  for (const [dx, dy] of [[0, 0], [3, 4], [K.deadZonePx, 0], [0, -K.deadZonePx], [-5, 5]] as const) assert.deepEqual(stickReading(dx, dy), { side: 0, depth: 0 }, `${dx},${dy}`);
  const just = stickReading(0, K.deadZonePx + 1);
  assert.ok(just.depth > 0 && just.depth < 0.01, `no jump at the edge: ${just.depth}`);
  assert.deepEqual(stickReading(NaN, 5), { side: 0, depth: 0 });
  assert.equal(K.deadZonePx, CLICK_RULES.maxMovePx, 'the stick\'s dead zone is the click\'s own hand shake: held still and pulling cannot both be true');
});

test('direction: down is toward you, up is away, right and left are across', () => {
  const down = stickReading(0, 100), up = stickReading(0, -100), right = stickReading(100, 0), left = stickReading(-100, 0);
  assert.ok(down.depth > 0 && down.side === 0 && up.depth < 0 && up.side === 0);
  assert.ok(right.side > 0 && right.depth === 0 && left.side < 0 && left.depth === 0);
  assert.equal(down.depth, -up.depth); assert.equal(right.side, -left.side);
  const slant = stickReading(80, 80);
  assert.ok(slant.side > 0 && slant.depth > 0, 'a slanted pointer does both');
  // the goal follows: down asks for a nearer depth, up a farther one, right a larger x
  assert.ok(stickGoal({ xM: 0, depthM: 6 }, down, VIEWER).depthM < 6 && stickGoal({ xM: 0, depthM: 6 }, up, VIEWER).depthM > 6);
  assert.ok(stickGoal({ xM: 0, depthM: 6 }, right, VIEWER).xM > 0 && stickGoal({ xM: 0, depthM: 6 }, left, VIEWER).xM < 0);
});

test('speed grows with the offset (never falls) and is capped at the full offset', () => {
  let last = 0;
  for (let px = 0; px <= 600; px += 2) {
    const v = stickReading(0, px).depth;
    assert.ok(v >= last - 1e-12, `${px}: ${v} after ${last}`); last = v;
  }
  assert.equal(stickReading(0, K.fullOffsetPx).depth, 1);
  assert.equal(stickReading(0, K.fullOffsetPx * 10).depth, 1, 'capped');
  assert.ok(stickReading(0, K.fullOffsetPx / 2).depth < 0.5, 'a gentle curve: half the offset is less than half the speed');
  assert.ok(Math.abs(stickReading(300, 300).side) <= 1 && Math.abs(stickReading(300, 300).depth) <= 1);
});

test('the same offset is the same speed whether she is near or far (screen pixels, apparent size), and across looks equally fast', () => {
  const reading = stickReading(60, 90);
  const ratio = (depth: number) => (stickGoal({ xM: 0, depthM: depth }, { side: 0, depth: reading.depth }, VIEWER).depthM + VIEWER) / (depth + VIEWER);
  assert.ok(Math.abs(ratio(0.5) - ratio(8)) < 1e-12 && Math.abs(ratio(2) - ratio(12)) < 1e-12, 'depth: the same share of her apparent distance per second');
  const across = (depth: number) => stickGoal({ xM: 0, depthM: depth }, { side: reading.side, depth: 0 }, VIEWER).xM / (depth + VIEWER);
  assert.ok(Math.abs(across(0.5) - across(2)) < 1e-12, 'across: the same share of her apparent distance (equally fast on the screen) while below the walk cap');
  assert.ok(stickGoal({ xM: 0, depthM: 12 }, { side: 1, depth: 0 }, VIEWER).xM <= K.sideMaxMps * K.lookAheadS + 1e-12, 'and capped by the walk far away');
});

test('wheel: a notch changes her apparent distance by the same share near and far; forward is closer; the delta modes are notches', () => {
  const share = (depth: number) => (wheelDepth(depth, 1, VIEWER) + VIEWER) / (depth + VIEWER);
  assert.ok(Math.abs(share(0.5) - share(9)) < 1e-12 && share(3) < 1, 'closer by the same share each notch');
  assert.ok(Math.abs(Math.exp(-K.wheelStep) - share(3)) < 1e-12);
  assert.ok(wheelDepth(3, -1, VIEWER) > 3, 'back is farther');
  assert.ok(Math.abs(wheelDepth(wheelDepth(3, 1, VIEWER), 1, VIEWER) - wheelDepth(3, 2, VIEWER)) < 1e-12, 'even steps: two notches are one notch twice');
  assert.equal(wheelNotches(-100), 1); assert.equal(wheelNotches(100), -1); assert.equal(wheelNotches(-3, 1), 1); assert.equal(wheelNotches(NaN), 0);
  assert.equal(wheelDepth(3, 1e6, VIEWER), wheelDepth(3, 6, VIEWER), 'a huge delta is capped');
});

test('the knobs keep their ranges (a bad value falls back or is clamped)', () => {
  const bad = stickKnobs({ deadZonePx: 1e9, holdTouchMs: 1, curve: NaN, fullOffsetPx: 'x' });
  assert.equal(bad.deadZonePx, STICK_KNOB_RANGES.deadZonePx[1]); assert.equal(bad.holdTouchMs, STICK_KNOB_RANGES.holdTouchMs[0]);
  assert.equal(bad.curve, K.curve); assert.equal(bad.fullOffsetPx, K.fullOffsetPx);
  assert.ok(K.holdTouchMs > CLICK_RULES.maxHoldMs, 'a touch is held longer than a click may be');
});

// ---- the page's controller with a fake body -------------------------------------------------------------------------------------------

function rig(opts: { group?: StagePullHit['group']; part?: StagePullHit['part']; start?: { x: number; z: number }; heightPx?: number; stations?: NearStations | null } = {}) {
  const group = opts.group ?? 'torso', goals: { x: number; z: number }[] = [], messages: UnboundPullMessage[] = [], dots: string[] = [];
  let clock = 0, steps = 0, holdTouches = 0;
  const root = { ...(opts.start ?? { x: 0, z: -8 }) };
  const figure: UnboundPullFigure = {
    pullHit: () => ({ part: opts.part ?? 'torso', side: null, group, heightPx: opts.heightPx ?? 400 } as StagePullHit), pullStart: () => true, pullTo: () => {}, pullEnd: () => {},
    setPullStance: () => {}, pullShownM: () => ({ x: 0, z: 0 }), rootM: root, followTo: p => { goals.push({ ...p }); }, setStance: () => {}, heightM: 1.5,
    get report() { return { steps }; },
  };
  const cam = new PerspectiveCamera(30, 1.6, 0.05 * UNITS_PER_M, 100 * UNITS_PER_M); cam.position.set(0, 1.25 * UNITS_PER_M, 0.55 * UNITS_PER_M); cam.updateMatrixWorld(true);
  const stations = opts.stations === undefined ? null : opts.stations;
  const pulls = new UnboundPull({
    figure: () => figure, view: () => ({ camera: cam, width: 1600, height: 1000 }), eligible: () => true,
    send: async m => { messages.push(m); return m.phase === 'start' ? answer : undefined; },
    clampX: x => Math.min(1.5, Math.max(-1.5, x)), clampDepth: d => clampFollowDepth(d, stations?.eyeDepthM), clock: () => clock,
    near: () => stations, viewerDistanceM: () => VIEWER, nearEnd: () => {},
    dot: { show: (x, y) => dots.push(`show ${x},${y}`), hide: () => dots.push('hide') }, holdTouch: () => { holdTouches++; },
  });
  return {
    pulls, goals, messages, dots, root, holdTouches: () => holdTouches, tick: (ms: number) => { clock += ms; pulls.frame(); }, now: () => clock,
    walked: () => { steps += 3; },
    /** Press at (800, 300), move to (800 + dx, 300 + dy), run a few frames so the host answers and the stick is read. */
    async pull(dx: number, dy: number) {
      assert.ok(pulls.down(800, 300));
      pulls.move(800 + dx, 300 + dy); clock += 100; pulls.frame(); await flush(); clock += 100; pulls.frame();
    },
  };
}
const reports = (m: UnboundPullMessage[]) => m.filter(x => x.phase === 'report') as Extract<UnboundPullMessage, { phase: 'report' }>[];

test('down, up and across: the pointer below the press asks for nearer, above for farther, to the side across; at her ranges, no further', async () => {
  const down = rig(); await down.pull(0, 120);
  assert.ok(-down.goals.at(-1)!.z < 8 - 0.5 && down.goals.at(-1)!.x === 0, `nearer (${down.goals.at(-1)!.z})`);
  const up = rig(); await up.pull(0, -120);
  assert.ok(-up.goals.at(-1)!.z > 8 + 0.5, `farther (${up.goals.at(-1)!.z})`);
  const right = rig(); await right.pull(120, 0);
  assert.ok(right.goals.at(-1)!.x > 0.3 && Math.abs(right.goals.at(-1)!.z + 8) < 1e-9, `across (${right.goals.at(-1)!.x})`);
  const far = rig({ start: { x: 0, z: -12.45 } }); await far.pull(0, -400);
  assert.ok(-far.goals.at(-1)!.z <= 12.5 + 1e-9, 'the far end is today\'s 12.5 m');
  const near = rig({ start: { x: 0, z: -5.05 } }); await near.pull(0, 400);
  assert.ok(-near.goals.at(-1)!.z >= 5 - 1e-9, 'with no near station known, her saved range\'s own 5 m');
  const edge = rig({ start: { x: 1.3, z: -8 } }); await edge.pull(300, 0);
  assert.ok(edge.goals.at(-1)!.x <= 1.5 + 1e-9, 'her stand range holds across');
});

test('inside the dead zone nothing moves (no goal, no pull asked of the host); holding the pointer there for good', async () => {
  const r = rig();
  assert.ok(r.pulls.down(800, 300));
  r.pulls.move(803, 305); r.tick(100); r.pulls.move(797, 296); r.tick(100); r.tick(100);
  assert.equal(r.goals.length, 0);
  assert.equal(r.messages.length, 0, 'the host is not asked: it is not a pull yet');
  assert.equal(r.pulls.pulling, false, 'a press in hand, not a pull');
});

test('the same offset gives the same goal whatever her size on the window (screen pixels, not her scaled body)', async () => {
  const small = rig({ heightPx: 150 }); await small.pull(0, 100);
  const huge = rig({ heightPx: 5000 }); await huge.pull(0, 100);
  assert.equal(small.goals.at(-1)!.z, huge.goals.at(-1)!.z);
  const wide = rig({ heightPx: 150 }); await wide.pull(100, 0);
  const wideHuge = rig({ heightPx: 5000 }); await wideHuge.pull(100, 0);
  assert.equal(wide.goals.at(-1)!.x, wideHuge.goals.at(-1)!.x);
});

test('letting go stops her: the gait is sent back to where she stands, she brakes there, and that is her place; the pointer back to the dot stops her too', async () => {
  const r = rig(); await r.pull(0, 150);
  r.walked(); r.root.z = -6.1; r.tick(50);
  r.pulls.up(); await flush();
  const last = r.goals.at(-1)!;
  assert.deepEqual(last, { x: 0, z: -6.1 }, 'the goal is where she is: she eases to a stop');
  const end = reports(r.messages).at(-1)!;
  assert.deepEqual(end.place, { xM: 0, depthM: 6.1 });
  const back = rig(); await back.pull(0, 150); back.pulls.move(802, 301); back.tick(50);
  assert.deepEqual(back.goals.at(-1), { x: 0, z: -8 }, 'the pointer back in the dead zone: she is told to stay');
});

test('a pull on her hair is a pull: no touch during or after (no hold touch, every report is a joystick pull the host does not tell the touch brain about)', async () => {
  const r = rig({ group: 'head', part: 'hair' });
  await r.pull(0, 120);
  for (let i = 0; i < 40; i++) r.tick(100); // held 4 s with the pointer out of the dead zone
  r.pulls.up(); await flush();
  assert.equal(r.holdTouches(), 0);
  const sent = reports(r.messages);
  assert.ok(sent.length >= 1 && sent.every(m => m.stick === true), JSON.stringify(sent.map(m => m.stick)));
  assert.equal(r.messages[0].phase, 'start');
  assert.ok(r.dots.some(d => d.startsWith('show')) && r.dots.at(-1) === 'hide', `the dot shows while held and goes after: ${r.dots}`);
});

test('an arm or a leg is pulled as before: the arm\'s own report is a plain pull (the touch brain hears it), no joystick', async () => {
  const r = rig({ group: 'arm', part: 'arm' });
  assert.ok(r.pulls.down(800, 300)); r.pulls.move(800, 400); r.tick(100); await flush(); r.tick(100); r.pulls.up(); await flush();
  const sent = reports(r.messages);
  assert.ok(sent.length >= 1 && sent.every(m => m.stick === undefined), 'not flagged');
  assert.equal(r.goals.length, 0, 'up and down only move the arm');
  assert.equal(r.holdTouches(), 0);
});

test('the stick flag is parsed as a plain true only and carried through the page\'s message', () => {
  const message = pullReportMessage({ part: 'torso', side: null, strength: 0.4, heldMs: 900, ended: 'released' } as never, { xM: 0, depthM: 5 }, false, 0, true);
  assert.equal((message as { stick?: boolean }).stick, true);
  assert.equal((parseUnboundPull(JSON.parse(JSON.stringify(message))) as { stick?: boolean }).stick, true);
  assert.equal((parseUnboundPull({ phase: 'report', report: {}, stick: 'yes' }) as { stick?: boolean }).stick, undefined);
  assert.equal((pullReportMessage({} as never) as { stick?: boolean }).stick, undefined);
});

test('wheel over her: forward is closer in even steps, backward is farther; a short pull of its own that ends when the wheel stops, and she keeps where she stands', async () => {
  const r = rig();
  r.pulls.wheel(800, 300, -100); r.tick(50); await flush(); r.tick(50);
  const one = -r.goals.at(-1)!.z;
  assert.ok(Math.abs(one + VIEWER - (8 + VIEWER) * Math.exp(-K.wheelStep)) < 1e-9, `one notch: ${one}`);
  r.pulls.wheel(800, 300, -100); r.tick(50); r.pulls.wheel(800, 300, -100); r.tick(50);
  const three = -r.goals.at(-1)!.z;
  assert.ok(Math.abs(three + VIEWER - (8 + VIEWER) * Math.exp(-3 * K.wheelStep)) < 1e-9, `notches add up while she is still walking: ${three}`);
  r.walked(); r.root.z = -6.5;
  for (let i = 0; i < 20; i++) r.tick(100);
  assert.equal(r.pulls.active, false, 'the wheel stopped: the pull is over');
  await flush();
  const end = reports(r.messages).at(-1)!;
  assert.equal(end.stick, true); assert.deepEqual(end.place, { xM: 0, depthM: 6.5 });
  const back = rig(); back.pulls.wheel(800, 300, 100); back.tick(50); await flush(); back.tick(50);
  assert.ok(-back.goals.at(-1)!.z > 8, 'backward: farther');
});

test('wheel limits are the pull\'s: never nearer than the eyes station, never farther than 12.5 m', async () => {
  const s: NearStations = { faceDepthM: 1.2, eyeDepthM: -0.3, gateDepthM: 0.45 };
  const r = rig({ stations: s });
  for (let i = 0; i < 40; i++) { r.pulls.wheel(800, 300, -100); r.tick(30); if (i === 0) await flush(); }
  assert.ok(-r.goals.at(-1)!.z >= s.eyeDepthM - 1e-9 && -r.goals.at(-1)!.z <= s.eyeDepthM + 1e-6, `at the eyes station and no nearer: ${-r.goals.at(-1)!.z}`);
  const far = rig();
  for (let i = 0; i < 40; i++) { far.pulls.wheel(800, 300, 100); far.tick(30); if (i === 0) await flush(); }
  assert.ok(Math.abs(-far.goals.at(-1)!.z - 12.5) < 1e-9);
});

test('a wheel over nothing of hers does nothing; a press in hand owns her (the wheel waits)', async () => {
  const held = rig();
  assert.ok(held.pulls.down(800, 300));
  held.pulls.wheel(800, 300, -100); held.tick(100);
  assert.equal(held.goals.length, 0);
  assert.equal(held.messages.length, 0);
});

// ---- Gene's real body at the near end -----------------------------------------------------------------------------------------------------

const DIP = { w: LAPTOP.workArea.width / LAPTOP.scaleFactor, h: LAPTOP.workArea.height / LAPTOP.scaleFactor };
function laptopCamera(): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M, camera = new PerspectiveCamera(30, DIP.w / DIP.h, 0.05 * U, 400 * U);
  const world = { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical' as const,
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: { xM: 0, depthM: 8 } };
  applyWorldCamera(camera, world as never, 0.05);
  return camera;
}

test('Gene (real frame loop): the pointer held far below the press walks her in, never past the eyes station, whose distance keeps her nose, bangs and hair out of the camera (I-192); the wheel too', async () => {
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 3 });
  try {
    for (let i = 0; i < 60; i++) figure.frame(1 / 60);
    const lens = laptopLens(), body = nearBodyOf(figure)!, stations = nearStations(lens, body)!, camera = laptopCamera(), view = { camera, width: DIP.w, height: DIP.h };
    const without = nearStations(lens, { ...body, clearM: 0 })!;
    const face = usableFace(figure.sense?.face);
    assert.ok(face && body.clearM! > 0, 'the guard is measured for Gene');
    assert.ok(stations.eyeDepthM >= without.eyeDepthM - 1e-12, `the guard only keeps her farther: ${stations.eyeDepthM} vs ${without.eyeDepthM}`);
    assert.ok(stations.eyeDepthM + lens.camera.z - body.eyeForwardM >= body.clearM! - 1e-9, 'at the station her eye is at least the guard\'s distance from the lens');
    const farGuard = nearStations(lens, { ...body, clearM: 0.6 })!;
    assert.ok(farGuard.eyeDepthM > stations.eyeDepthM + 0.3 && farGuard.eyeDepthM > without.eyeDepthM, 'a face that reaches far ahead keeps her farther: the guard is in the station');
    let clock = 0;
    const pulls = new UnboundPull({
      figure: () => figure, view: () => view, eligible: () => true,
      send: async m => (m.phase === 'start' ? answer : undefined), clampX: x => Math.min(1.5, Math.max(-1.5, x)),
      clampDepth: d => clampFollowDepth(d, nearStations(lens, nearBodyOf(figure)!)?.eyeDepthM), clock: () => clock,
      near: () => nearStations(lens, nearBodyOf(figure)!), viewerDistanceM: () => 0.55, nearEnd: () => {},
    });
    const chest = () => { fixture.mesh.updateMatrixWorld(true); const p = fixture.mesh.skeleton.bones.find(b => b.name === '上半身2')!.getWorldPosition(new Vector3()).project(camera); return { x: (p.x + 1) / 2 * DIP.w, y: (1 - p.y) / 2 * DIP.h }; };
    const from = chest();
    assert.ok(pulls.down(from.x, from.y));
    let minDepth = 3;
    for (let frame = 0; frame < 60 * 30; frame++) {
      clock = frame * 1000 / 60;
      pulls.move(from.x, from.y + 300); pulls.frame(); await Promise.resolve(); await Promise.resolve();
      figure.frame(1 / 60); minDepth = Math.min(minDepth, -figure.rootM.z);
    }
    const live = nearStations(lens, nearBodyOf(figure)!)!;
    assert.ok(minDepth < live.gateDepthM, `she came in to the near end (${minDepth} m; gate ${live.gateDepthM})`);
    assert.ok(minDepth >= live.eyeDepthM - 0.02, `and not past the eyes station (${minDepth} vs ${live.eyeDepthM})`);
    // her eye's distance from the lens at that station is at least the guard's
    const eyeAlong = minDepth + camera.position.z / UNITS_PER_M - body.eyeForwardM;
    assert.ok(eyeAlong >= body.clearM! - 0.03, `her eye is ${eyeAlong.toFixed(3)} m from the lens, the guard asks ${body.clearM!.toFixed(3)} m`);
    pulls.up();
  } finally { figure.dispose(); fixture.close(); }
});
