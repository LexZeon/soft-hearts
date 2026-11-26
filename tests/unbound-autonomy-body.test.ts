// Unbound U2 experiment E2, her own movement in her real body (docs/claude/2026-11-14-unbound-night-e2-autonomy.md): the bundled
// Gene through the real frame loop (MMDLoader, CCD IK, gait and contact owner, intent layer, act player, procedural generator) at
// 60 and 30 fps. Sway, stretch and hop: planted feet do not drift or slide, nothing jumps (root, head, eyes, rotations), the COM
// keeps a margin over her support, blinks stay crisp (full), the hop lands on the spot it left with the knees taking it, and a
// cancel winds an act down (a hop in the air lands first).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pointSurprises } from './helpers/unbound-peek';
import { max, min, surpriseAngles, TRACKED } from './helpers/unbound-gene';
import { runAct, toeNumbers, type ActFrame } from './helpers/unbound-acts';
import { STRETCH_BEATS, stretchPeakAt } from '../src/unbound/motion/own-moves';
import { ACT_PLAYER } from '../src/unbound/director/acts';

const index = (re: RegExp, keep: boolean) => TRACKED.map((name, i) => [name, i] as const).filter(([name]) => re.test(name) === keep).map(([, i]) => i);
const LEGS = index(/足|ひざ/, true), ARMS = index(/腕|ひじ|肩/, true);
const TORSO = TRACKED.map((_, i) => i).filter(i => !LEGS.includes(i) && !ARMS.includes(i));
const runs = new Map<string, Awaited<ReturnType<typeof runAct>>>();
async function act(name: 'sway' | 'stretch' | 'hop', fps: number, extra: Parameters<typeof runAct>[3] = {}, seconds = 12) {
  const key = `${name}-${fps}-${JSON.stringify(extra)}`;
  if (!runs.has(key)) runs.set(key, await runAct(name, fps, seconds, extra));
  return runs.get(key)!;
}
const during = (frames: readonly ActFrame[]) => frames.filter(f => f.active);
const surprises = (frames: readonly ActFrame[]) => ({
  rootCm: max(pointSurprises(frames.map(f => f.root))),
  headCm: max(pointSurprises(frames.map(f => f.head))),
  eyeCm: max(pointSurprises(frames.map(f => f.eyes.left))),
  torsoDeg: max(surpriseAngles(frames as never, 0, TORSO)),
  armDeg: max(surpriseAngles(frames as never, 0, ARMS)),
  legDeg: max(surpriseAngles(frames as never, 0, LEGS)),
});
const fmt = (o: Record<string, number | null | boolean>) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Number(v.toFixed(4)) : v])));

for (const fps of [60, 30]) {
  const k = 60 / fps, k2 = k * k;

  test(`${fps} fps sway: hips from foot to foot, feet planted, no jolt, a COM margin, the blink stays full`, async () => {
    const run = await act('sway', fps);
    const live = during(run.frames), toes = toeNumbers(run.frames), s = surprises(run.frames);
    const margin = min(live.map(f => f.comMargin ?? Infinity)), headX = live.map(f => f.head!.x);
    const numbers = { ...s, toeDriftCm: toes.drift, toeSlideCm: toes.slide, minMarginCm: margin * 100, headSwayCm: (Math.max(...headX) - Math.min(...headX)) * 100, blinkPeak: max(live.map(f => f.blink)), seconds: run.ends[0]?.seconds ?? -1 };
    console.log(`[E2 sway ${fps} fps]`, fmt(numbers));
    assert.equal(run.ends.length, 1); assert.equal(run.ends[0].completed, true); assert.equal(run.ends[0].wobble, false);
    assert.ok(toes.drift < 0.01 && toes.slide < 0.05, 'planted feet stay put');
    assert.ok(s.rootCm < 1e-9, 'her root does not move at all');
    assert.ok(s.headCm < 0.05 * k2 && s.eyeCm < 0.05 * k2 && s.torsoDeg < 0.1 * k2 && s.legDeg < 0.1 * k2, 'no jolt anywhere');
    assert.ok(margin > 0.02, 'COM well inside her support');
    assert.ok(numbers.headSwayCm > 1, 'the sway shows');
    assert.ok(numbers.blinkPeak > 0.99, 'the blink closes fully (crisp, not blended away)');
  });

  test(`${fps} fps stretch: arms overhead, on her toes, toes planted, no jolt, a COM margin, eyes squeezed`, async () => {
    const run = await act('stretch', fps);
    const live = during(run.frames), toes = toeNumbers(run.frames), s = surprises(run.frames);
    const peak = live.reduce((best, f) => f.armsRaised > best.armsRaised ? f : best, live[0]);
    const wristOverHeadCm = Math.min(...peak.wrists.map(w => (w!.y - peak.head!.y) * 100));
    const margin = min(live.map(f => f.comMargin ?? Infinity));
    const numbers = { ...s, toeDriftCm: toes.drift, toeSlideCm: toes.slide, minMarginCm: margin * 100, armsPeak: peak.armsRaised, peakAt: peak.t - 1, plannedPeakAt: stretchPeakAt(), wristOverHeadCm, eyesPeak: max(live.map(f => f.blink)), seconds: run.ends[0]?.seconds ?? -1 };
    console.log(`[E2 stretch ${fps} fps]`, fmt(numbers));
    assert.equal(run.ends[0]?.completed, true); assert.equal(run.ends[0].wobble, false);
    assert.ok(toes.drift < 0.01 && toes.slide < 0.05, 'toes stay put (heels roll about them)');
    assert.ok(numbers.armsPeak > 0.95, 'arms all the way up');
    assert.ok(wristOverHeadCm > 5, 'both hands above her head at the highest');
    assert.ok(s.rootCm < 1e-9 && s.headCm < 0.08 * k2 && s.eyeCm < 0.08 * k2 && s.torsoDeg < 0.15 * k2 && s.armDeg < 0.6 * k2 && s.legDeg < 0.3 * k2, 'no jolt');
    assert.ok(margin > 0.015);
    assert.ok(numbers.eyesPeak > 0.8 && numbers.eyesPeak < 0.9, 'eyes squeezed shut (0.85)');
    const after = run.frames.at(-1)!;
    assert.ok(after.armsRaised < 1e-3, 'arms back down');
  });

  test(`${fps} fps hop: crouch, flight under soft gravity, lands on the spot it left, knees take it; a jolt only at touch-down`, async () => {
    const run = await act('hop', fps);
    const f = run.frames, toes = toeNumbers(f);
    const before = f.find(x => x.active)!, standY = before.head!.y;
    const air = f.filter(x => x.hopPhase === 'flight'), takeoff = f.findIndex(x => x.hopPhase === 'flight'), touch = f.findIndex((x, i) => i > takeoff && x.hopPhase === 'land');
    assert.ok(takeoff > 0 && touch > takeoff, 'she left the floor and came back');
    const toeAt = (x: ActFrame) => x.toes.map(t => t!);
    const lastBefore = toeAt(f[takeoff - 1]), settled = toeAt(f.at(-1)!), startToes = toeAt(before);
    const landedOffCm = Math.max(...settled.map((t, i) => Math.hypot(t.x - startToes[i].x, t.z - startToes[i].z) * 100));
    const apexCm = (Math.max(...air.map(x => x.head!.y)) - standY) * 100;
    const dipCm = (standY - Math.min(...f.slice(touch).map(x => x.head!.y))) * 100;
    const crouchCm = (standY - Math.min(...f.slice(0, takeoff).map(x => x.head!.y))) * 100;
    const heads = f.map(x => x.head), headSurprise = pointSurprises(heads); // index i ↔ frame i + 2
    const near = (i: number, at: number) => Math.abs(i + 2 - at) <= 1;
    const awayFromTouch = max(headSurprise.filter((_, i) => !near(i, touch)));
    const atTouch = max(headSurprise.filter((_, i) => near(i, touch)));
    const atTakeoff = max(headSurprise.filter((_, i) => near(i, takeoff)));
    const margin = { before: min(f.slice(0, takeoff).filter(x => x.active).map(x => x.comMargin ?? Infinity)), after: min(f.slice(touch).map(x => x.comMargin ?? Infinity)) };
    const numbers = { apexCm, crouchCm, landingDipCm: dipCm, flightS: air.length / fps, landedOffCm, toeDriftCm: toes.drift, toeSlideCm: toes.slide,
      headSurpriseCm: awayFromTouch, atTakeoffCm: atTakeoff, atTouchdownCm: atTouch, legDeg: max(surpriseAngles(f as never, 0, LEGS)),
      marginBeforeCm: margin.before * 100, marginAfterCm: margin.after * 100, toeLiftAtTakeoffCm: Math.max(...lastBefore.map((t, i) => (t.y - startToes[i].y) * 100)), seconds: run.ends[0]?.seconds ?? -1 };
    console.log(`[E2 hop ${fps} fps]`, fmt(numbers));
    assert.equal(run.ends[0]?.completed, true); assert.equal(run.ends[0].wobble, false);
    assert.ok(landedOffCm < 0.05, 'lands exactly where she took off');
    assert.ok(toes.drift < 0.01 && toes.slide < 0.1, 'no foot slides along the floor');
    assert.ok(apexCm > 5 && apexCm < 16, 'a small hop');
    assert.ok(numbers.flightS > 0.22 && numbers.flightS < 0.42, 'about 2·v0/g under the soft gravity');
    assert.ok(dipCm > 2, 'the knees take the landing');
    assert.ok(crouchCm > 3, 'she crouches first');
    assert.ok(awayFromTouch < 0.5 * k2 && atTakeoff < 0.5 * k2, 'smooth everywhere but the touch-down (take-off is C²)');
    assert.ok(atTouch < 1.5 * k2, 'the touch-down is a crisp change of acceleration, bounded');
    assert.ok(margin.before > 0.02 && margin.after > 0.02);
  });
}

test('a cancel while her arms are up winds the stretch down through the springs (no freeze, no jump)', async () => {
  const cancelAt = 1 + STRETCH_BEATS.ready + STRETCH_BEATS.up + 0.5 * STRETCH_BEATS.hold;
  const run = await act('stretch', 60, { cancelAt });
  const after = run.frames.filter(f => f.t >= cancelAt - 2 / 60), s = surprises(after);
  const at = run.frames.find(f => f.t >= cancelAt)!, later = run.frames.find(f => f.t >= cancelAt + 1.5)!;
  console.log('[E2 stretch cancelled]', fmt({ ...s, armsAtCancel: at.armsRaised, armsAfter1_5s: later.armsRaised, seconds: run.ends[0]?.seconds ?? -1 }));
  assert.equal(run.ends[0]?.completed, false);
  assert.ok(at.armsRaised > 0.6 && later.armsRaised < at.armsRaised * 0.3, 'the arms come down, not stop');
  assert.ok(s.headCm < 0.08 && s.armDeg < 0.6 && s.torsoDeg < 0.15);
});

test('a cancel in the air does not stop the hop: she lands, then settles', async () => {
  const probe = await act('hop', 60);
  const flightAt = probe.frames.find(f => f.hopPhase === 'flight')!.t + 0.05;
  const run = await act('hop', 60, { cancelAt: flightAt });
  const touch = run.frames.findIndex(f => f.t > flightAt && f.hopPhase === 'land');
  console.log('[E2 hop cancelled in the air]', fmt({ landedAt: run.frames[touch]?.t ?? -1, ended: run.ends.length, completed: run.ends[0]?.completed ?? null }));
  assert.ok(touch > 0, 'still lands');
  assert.equal(run.ends.length, 1);
  assert.equal(run.ends[0].completed, false);
  assert.ok(run.ends[0].seconds > (run.frames[touch].t - 1), 'ends after the landing');
});

test('the "before": writing her arms straight overhead in one frame would be a jump of tens of degrees', async () => {
  const run = await act('stretch', 60);
  const live = during(run.frames), first = live[0], peak = live.reduce((b, f) => f.armsRaised > b.armsRaised ? f : b, live[0]);
  const arm = TRACKED.indexOf('左腕');
  const directDeg = first.rotations[arm].angleTo(peak.rotations[arm]) * 180 / Math.PI;
  const perFrame = max(during(run.frames).slice(1).map((f, i) => f.rotations[arm].angleTo(live[i].rotations[arm]) * 180 / Math.PI));
  console.log('[E2 before/after]', fmt({ directWriteDeg: directDeg, mostPerFrameDeg: perFrame, hopReadyS: ACT_PLAYER.hopReadyS }));
  assert.ok(directDeg > 60 && perFrame < 6);
});
