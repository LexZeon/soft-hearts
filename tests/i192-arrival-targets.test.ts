// I-192 arrival targets (docs/claude/2026-11-22-i192-arrival-targets.md), the pure layer (shared/unbound/arrival/): where her face stops (fit or
// the clip guard), the stand-and-lean solve for any body size and any lens, the closed loop that closes the last centimetres, her own hold,
// and what ends it early.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRIVAL_KNOBS, ARRIVAL_LIMITS, ARRIVAL_LOOP, ArrivalLoop, HoldClock, alongAxis, arrivalHoldS, axisPlace,
  eyeClearDistance, faceAim, faceDistance, faceSpanM, fallbackFace, holdGoesOn, leanHeadPoint, reachAhead, solveHeadArrival, turnHead,
  type ArrivalLens, type FaceGeometry,
} from '../shared/unbound/arrival';
import { endsAction } from '../shared/unbound/action-ends';

const lensAt = (camera: { x: number; y: number; z: number }, tiltY = -0.05, perM = 0.44): ArrivalLens => {
  const l = Math.hypot(0, tiltY, 1);
  return { camera, axis: { x: 0, y: tiltY / l, z: -1 / l }, heightPerM: perM };
};
/** A face of a figure `k` times Gene's size (eyes 2.6 cm, the mouth 6.4 cm below them, the nose 3.5 cm ahead, bangs 4 cm ahead and up). */
function face(k = 1, extraReach = 0): FaceGeometry {
  const eyes = { x: 0, y: 0.05 * k, z: 0.076 * k };
  const points = [
    { x: 0, y: eyes.y - 0.035 * k, z: eyes.z + 0.035 * k + extraReach }, { x: 0, y: eyes.y + 0.03 * k, z: eyes.z + 0.04 * k },
    { x: 0.07 * k, y: eyes.y, z: eyes.z - 0.03 * k }, { x: -0.07 * k, y: eyes.y, z: eyes.z - 0.03 * k }, { x: 0, y: eyes.y + 0.12 * k, z: 0 },
  ];
  return { eyes, eyeSizeM: 0.026 * k, mouthDropM: 0.064 * k, points };
}

test('the face stops where its eyes-to-mouth span fills the screen, never so near that her nose, bangs or hair come into the camera', () => {
  const f = face();
  const d = faceDistance(f, 0.44, { yaw: 0 });
  assert.ok(Math.abs(d.fitM - faceSpanM(f) / (ARRIVAL_KNOBS.faceFill * 0.44)) < 1e-12);
  assert.equal(d.clipped, false);
  assert.ok(d.distanceM - d.reachM >= ARRIVAL_KNOBS.minClearM + ARRIVAL_KNOBS.hairSwingM - 1e-12, 'what comes nearest still has the margin and the hair room');
  assert.ok(d.distanceM >= ARRIVAL_KNOBS.minFaceM, 'never nearer than the least face distance');
  // A long nose or bangs far in front: the guard stops her earlier than the fit.
  const long = faceDistance(face(1, 0.2), 0.44, { yaw: 0 });
  assert.equal(long.clipped, true);
  assert.ok(Math.abs(long.distanceM - (ARRIVAL_KNOBS.minClearM + long.reachM + ARRIVAL_KNOBS.hairSwingM)) < 1e-12);
  // A bigger screen per metre (a tall window) lets the same face fill it nearer; a smaller face: nearer, down to minFace.
  assert.ok(faceDistance(f, 0.6, { yaw: 0 }).distanceM < d.distanceM);
  assert.equal(faceDistance(face(0.4), 0.44, { yaw: 0 }).distanceM, ARRIVAL_KNOBS.minFaceM);
  // The aim point is between her eyes and her mouth; turned, the reach is measured as her head turns (a cheek can come forward).
  const aim = faceAim(f);
  assert.ok(aim.y < f.eyes.y && aim.y > f.eyes.y - f.mouthDropM);
  const turned = turnHead({ x: 0, y: 0, z: 1 }, 0.3);
  assert.ok(turned.x > 0 && Math.abs(Math.hypot(turned.x, turned.y, turned.z) - 1) < 1e-12, '+ yaw turns her face toward her left');
  assert.ok(reachAhead(f, aim, 0.4) >= 0 && reachAhead(f, aim) > 0.02);
  // The peek's own eye: the same guard (her nose and bangs ahead of the eye).
  assert.ok(eyeClearDistance(f, f.eyes) >= ARRIVAL_KNOBS.minClearM + ARRIVAL_KNOBS.hairSwingM + 0.03);
  // A model whose mesh says nothing: a face from her height (conservative).
  const fb = fallbackFace(1.6, { x: 0, y: 0.06, z: 0.08 }, null);
  assert.ok(fb.mouthDropM > 0.03 && fb.points.length >= 3);
});

test('the solve puts the leaned head point exactly on the arrival point across and in depth, for any body size and lens (model-size independent)', () => {
  let worst = 0, cases = 0;
  for (const k of [0.6, 0.8, 1, 1.2, 1.4]) for (const cam of [{ x: 0, y: 1.2, z: 0.55 }, { x: 0.3, y: 1.5, z: 0.55 }, { x: -0.2, y: 1.0, z: 0.8 }]) for (const yaw of [0, 0.35, -0.35]) {
    const f = face(k), head = { x: 0.01, y: 1.36 * k, z: 0.02 * k }, pivot = { x: 0, y: 0.95 * k, z: 0 };
    const lens = lensAt(cam), d = faceDistance(f, lens.heightPerM, { yaw }).distanceM, offset = turnHead(faceAim(f), yaw, 0.1);
    const s = solveHeadArrival({ head, offset, pivot, lens, distanceM: d, wantedLean: 0.26, rise: 0.04 });
    assert.ok(s.lean >= 0 && s.lean <= ARRIVAL_LIMITS.maxLean);
    // Her frame → world at the solved stand (heading faces the axis).
    const p = leanHeadPoint(head, offset, pivot, s.lean), c = Math.cos(s.heading), si = Math.sin(s.heading);
    const world = { x: s.stand.x + p.x * c + p.z * si, y: p.y, z: s.stand.z - p.x * si + p.z * c };
    const err = Math.hypot(world.x - s.target.x, world.z - s.target.z);
    worst = Math.max(worst, err); cases++;
    assert.ok(Math.abs(world.y + s.rise - s.target.y) < 1e-9, 'what is left in height is the rise (her toes or a small bend)');
    assert.ok(Math.abs(axisPlace(lens, s.target).along - d) < 1e-12 && axisPlace(lens, s.target).off < 1e-12, 'the arrival point is on the axis at its distance');
  }
  assert.ok(worst < 1e-9, `on target across and in depth (worst ${worst} m over ${cases} cases)`);
  // A lens above what she can reach leaning: she leans less (never below the least lean), so her face can come up to it.
  const f = face(), lens = lensAt({ x: 0, y: 1.7, z: 0.55 }, 0), s = solveHeadArrival({ head: { x: 0, y: 1.36, z: 0.02 }, offset: faceAim(f), pivot: { x: 0, y: 0.95, z: 0 }, lens, distanceM: 0.2, wantedLean: 0.3, rise: 0.03 });
  assert.ok(s.lean < 0.3 && s.lean >= ARRIVAL_LIMITS.minLean - 1e-12);
});

test('the closed loop brings the part the last centimetres, within the hips\' reach, never faster than its rate; weight 0 holds', () => {
  for (const offset of [{ x: 0.05, y: -0.06, z: 0.09 }, { x: -0.08, y: 0.02, z: -0.05 }]) {
    const loop = new ArrivalLoop(), realized = { lateral: 0, forward: 0, up: 0 }, dt = 1 / 60, rise = 0.05;
    let maxStep = 0;
    for (let i = 0; i < 60 * 4; i++) {
      // The part sits at base + realized; the target is `offset` from base: error = offset − realized. The body follows the goals with a lag.
      const before = { ...loop };
      loop.step({ x: offset.x - realized.lateral, y: offset.y - realized.up, z: offset.z - realized.forward }, realized, rise, 1, dt);
      maxStep = Math.max(maxStep, Math.abs(loop.lateral - before.lateral), Math.abs(loop.forward - before.forward), Math.abs(loop.up - before.up));
      const g = loop.goals(rise), up = g.pelvis.vertical + g.tiptoe * rise;
      realized.lateral += (g.pelvis.lateral - realized.lateral) * 0.2; realized.forward += (g.pelvis.forward - realized.forward) * 0.2; realized.up += (up - realized.up) * 0.2;
    }
    const e = loop.lastError;
    assert.ok(Math.hypot(e.x, e.y, e.z) < 0.002, `arrives (${JSON.stringify(e)})`);
    assert.ok(maxStep <= ARRIVAL_LOOP.maxRate * dt + 1e-12, 'never faster than its rate');
    assert.ok(Math.abs(loop.lateral) <= ARRIVAL_LOOP.lateral && loop.forward <= ARRIVAL_LOOP.forward && loop.forward >= ARRIVAL_LOOP.forwardBack && loop.up >= ARRIVAL_LOOP.down);
    const held = { ...loop };
    loop.step({ x: 1, y: 1, z: 1 }, realized, rise, 0, dt);
    assert.deepEqual({ l: loop.lateral, f: loop.forward, u: loop.up }, { l: held.lateral, f: held.forward, u: held.up }, 'weight 0: it holds where it is');
  }
  // Out of reach: it stops at its limits (no wind-up).
  const far = new ArrivalLoop();
  for (let i = 0; i < 600; i++) far.step({ x: 1, y: -1, z: 1 }, { lateral: 0, forward: 0, up: 0 }, 0.05, 1, 1 / 60);
  for (const [v, limit] of [[far.lateral, ARRIVAL_LOOP.lateral], [far.forward, ARRIVAL_LOOP.forward], [far.up, ARRIVAL_LOOP.down]]) assert.ok(Math.abs(v - limit) < 1e-9, `at its limit (${v} vs ${limit})`);
});

test('her own hold: longer when warm and bold, shorter when tense; never under the least nor over the cap; on while she speaks, then a moment more', () => {
  const calm = { warmth: 0.45, boldness: 0.5, tension: 0.2 };
  const warm = arrivalHoldS('kiss', { ...calm, warmth: 0.9, boldness: 0.8 }, 0.5), base = arrivalHoldS('kiss', calm, 0.5), tense = arrivalHoldS('kiss', { ...calm, tension: 0.9 }, 0.5);
  assert.ok(warm > base && base > tense, `${warm} > ${base} > ${tense}`);
  for (const kind of ['look', 'kiss', 'hug', 'lean-in'] as const) for (const r of [0, 0.5, 0.999]) for (const reading of [calm, { warmth: 1, boldness: 1, tension: 0 }, { warmth: 0, boldness: 0, tension: 1 }]) {
    const s = arrivalHoldS(kind, reading, r);
    // I-203: a kiss or a hug may be as short as the storyboard's 1.5 s (closeHoldMinS); the look and the lean-in keep holdMinS.
    assert.ok(s >= (kind === 'kiss' || kind === 'hug' ? ARRIVAL_KNOBS.closeHoldMinS : ARRIVAL_KNOBS.holdMinS) && s <= ARRIVAL_KNOBS.holdCapS, `${kind}: ${s}`);
  }
  assert.ok(arrivalHoldS('hug', calm, 0.5) > arrivalHoldS('kiss', calm, 0.5), 'a hug holds longer than a kiss');
  assert.ok(base > 1.5 * 1.5, `more than twice the 1.5 s the user saw (${base})`);
  // Each frame: quiet → her own length; speaking → on (to the cap); after speaking → afterSpeechS more (the pucker shows).
  const quiet = new HoldClock(), dt = 1 / 60;
  let t = 0;
  while (holdGoesOn(quiet.state(3, false))) { quiet.frame(dt, false); t += dt; }
  assert.ok(Math.abs(t - 3) < 0.02, `quiet: her own 3 s (${t})`);
  const talk = new HoldClock();
  t = 0;
  while (holdGoesOn(talk.state(3, t < 5))) { talk.frame(dt, t < 5); t += dt; }
  assert.ok(Math.abs(t - (5 + ARRIVAL_KNOBS.afterSpeechS)) < 0.05, `speaking to 5 s: on until a moment after (${t})`);
  const long = new HoldClock();
  t = 0;
  while (holdGoesOn(long.state(3, true))) { long.frame(dt, true); t += dt; }
  assert.ok(Math.abs(t - ARRIVAL_KNOBS.holdCapS) < 0.05, `speaking all along: the cap (${t})`);
});

test('what ends a close pose early (2026-11-23, the one interruption arbiter): only a large pull or a game; never the mouse, the keys, typing, a click, a call, her reply or reading', () => {
  for (const kind of ['kiss', 'hug', 'look'] as const) {
    for (const i of ['pointer', 'wheel', 'tug', 'keys', 'typing', 'waiting', 'reply', 'reading', 'click', 'call', null]) assert.equal(endsAction(kind, i), false, `${kind} ${i}`);
    for (const i of ['pull', 'play']) assert.equal(endsAction(kind, i), true, `${kind} ${i}`);
  }
  assert.ok(alongAxis(lensAt({ x: 0, y: 1, z: 0.5 }), 0.2).z < 0.5);
});
