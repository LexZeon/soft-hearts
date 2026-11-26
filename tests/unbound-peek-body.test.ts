// Unbound U2, peek-lens in her real body (docs/claude/2026-11-12-unbound-peek.md): the bundled Gene through the real frame loop
// (MMDLoader, CCD IK, gait and contact owner, intent layer, director, procedural generator), at 60 and 30 fps, with this laptop's
// screen-camera. Her chosen eye ends on the lens axis a few cm away; nothing jumps (root, head, eye, rotations); her feet stay
// planted while she leans and stands on her toes; the near plane never cuts her face; a cancel at any beat backs her off smoothly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3, type SkinnedMesh } from 'three';
import { UNITS_PER_M } from '../src/unbound/figure';
import { axisOffset, eyePoint } from '../src/unbound/motion/lens-align';
import { NEAR_DEFAULT_M, NEAR_MIN_M } from '../src/unbound/camera';
import { peekBothDistance, peekDistance } from '../src/unbound/director/peek-lens';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import { eyePosition, windowFrustum } from '../shared/unbound/world';
import { CURIOUS, LAPTOP, laptopView, pointSteps, pointSurprises, runPeek, type PeekFrame } from './helpers/unbound-peek';
import { max, surpriseAngles, TRACKED } from './helpers/unbound-gene';

const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);
const LEGS = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => /足|ひざ/.test(name)).map(([, i]) => i);
const percentile = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0; };
/** What the peek brings onto the axis: I-192 follow-up, the point between both eyes (ARRIVAL_KNOBS.peekEyes = 2); else her nearer eye. */
const nearest = (lens: Parameters<typeof axisOffset>[0], f: PeekFrame) => ARRIVAL_KNOBS.peekEyes >= 2 && f.eyes.left && f.eyes.right ? axisOffset(lens, eyePoint(f.eyes, 'both')!)
  : [f.eyes.left, f.eyes.right].filter(Boolean).map(e => axisOffset(lens, e!)).sort((a, b) => a.off - b.off)[0];

/**
 * Her skinned, posed mesh against the window's frustum (m): `bound` is a lower bound of how near any part of her that the camera
 * shows comes (the nearest vertex of every triangle that overlaps the window as seen from the eye); `surface` is the nearest
 * surface actually hit by a grid of rays through the window (what the picture shows).
 */
function visibleDepth(mesh: SkinnedMesh): { bound: number; surface: number; triangles: number } {
  const view = laptopView(), eye = eyePosition(view), f = windowFrustum(view, LAPTOP.workArea, 1, 400);
  const position = mesh.geometry.getAttribute('position'), index = mesh.geometry.index, v = new Vector3();
  mesh.updateMatrixWorld(true);
  const p = new Float64Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld).divideScalar(UNITS_PER_M);
    p[3 * i] = v.x - eye.x; p[3 * i + 1] = v.y - eye.y; p[3 * i + 2] = eye.z - v.z; // eye-relative; z = ahead
  }
  const count = index ? index.count : position.count;
  const tri = (k: number) => index ? index.getX(k) : k;
  let bound = Infinity, triangles = 0;
  const near: number[] = [];
  for (let k = 0; k < count; k += 3) {
    const a = tri(k), b = tri(k + 1), c = tri(k + 2), za = p[3 * a + 2], zb = p[3 * b + 2], zc = p[3 * c + 2];
    if (Math.min(za, zb, zc) > 0.5 || Math.max(za, zb, zc) <= 0) continue;
    const xs = [a, b, c].map(i => p[3 * i] / Math.max(1e-6, p[3 * i + 2])), ys = [a, b, c].map(i => p[3 * i + 1] / Math.max(1e-6, p[3 * i + 2]));
    if (Math.max(...xs) < f.left || Math.min(...xs) > f.right || Math.max(...ys) < f.bottom || Math.min(...ys) > f.top) continue;
    triangles++; bound = Math.min(bound, za, zb, zc); near.push(a, b, c);
  }
  // Rays through a 24×16 grid of the window (Möller–Trumbore against the triangles that overlap it).
  let surface = Infinity;
  for (let gx = 0; gx <= 24; gx++) for (let gy = 0; gy <= 16; gy++) {
    const dx = f.left + (f.right - f.left) * gx / 24, dy = f.bottom + (f.top - f.bottom) * gy / 16; // direction (dx, dy, 1) in (x, y, ahead)
    for (let n = 0; n < near.length; n += 3) {
      const [i, j, k] = [near[n], near[n + 1], near[n + 2]];
      const e1 = [p[3 * j] - p[3 * i], p[3 * j + 1] - p[3 * i + 1], p[3 * j + 2] - p[3 * i + 2]], e2 = [p[3 * k] - p[3 * i], p[3 * k + 1] - p[3 * i + 1], p[3 * k + 2] - p[3 * i + 2]];
      const h = [dy * e2[2] - e2[1], e2[0] - dx * e2[2], dx * e2[1] - dy * e2[0]], det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-12) continue;
      const s = [-p[3 * i], -p[3 * i + 1], -p[3 * i + 2]], u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], w = (dx * q[0] + dy * q[1] + q[2]) / det;
      if (w < 0 || u + w > 1) continue;
      const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det; // the ray's z is 1 per unit t: t is the depth ahead
      if (t > 0 && t < surface) surface = t;
    }
  }
  return { bound, surface, triangles };
}

const runs = new Map<string, Awaited<ReturnType<typeof runPeek>>>();
const clipChecks: { case: string; fps: number; nearM: number; boundM: number; surfaceM: number; triangles: number }[] = [];
/** A few frames in the close-up: how near the parts of her that show are, against the near plane. */
const closeUpChecks = (name: string, fps: number) => {
  let checked = 0;
  return (frame: PeekFrame, mesh: SkinnedMesh) => {
    if (frame.phase !== 'hold' || checked >= 3 || Math.round(frame.t * fps) % Math.round(fps / 2) !== 0) return;
    checked++;
    const depth = visibleDepth(mesh);
    clipChecks.push({ case: name, fps, nearM: frame.nearM, boundM: depth.bound, surfaceM: depth.surface, triangles: depth.triangles });
  };
};
async function peekAt(fps: number, closest = false) {
  const key = `${fps}${closest ? '-closest' : ''}`;
  // closest: the nearest the director ever brings her (her eye asked to fill twice the screen: the 3.5 cm floor).
  if (!runs.has(key)) runs.set(key, await runPeek(fps, 24, { inspect: closeUpChecks(key, fps), ...(closest ? { planPatch: { eyeFill: 2 } } : {}) }));
  return runs.get(key)!;
}

for (const fps of [60, 30]) {
  test(`${fps} fps: her chosen eye (with ARRIVAL_KNOBS.peekEyes = 2: the point between both eyes) comes onto the lens axis a few cm away and stays there while she holds`, async () => {
    const run = await peekAt(fps);
    const phases = [...new Set(run.frames.map(f => f.phase))];
    assert.deepEqual(phases.filter(Boolean), ['notice', 'walk', 'lean', 'hold', 'back', 'settle'], 'every beat');
    const hold = run.frames.filter(f => f.phase === 'hold');
    const settled = hold.slice(Math.round(0.6 * fps));
    const offs = settled.map(f => nearest(run.lens, f).off * 1000), alongs = settled.map(f => nearest(run.lens, f).along * 1000);
    const report = { offP50: percentile(offs, 0.5), offMax: max(offs), alongMin: Math.min(...alongs), alongMax: max(alongs), targetMm: Math.max(peekDistance(run.plan, run.figure.eyeSizeM, run.lens), ARRIVAL_KNOBS.peekEyes >= 2 && run.figure.sense?.frame ? peekBothDistance(run.figure.sense.frame, run.figure.eyeSizeM, run.lens) : 0) * 1000, eyeSizeMm: (run.figure.eyeSizeM ?? 0) * 1000, holdS: hold.length / fps };
    console.log(`[peek ${fps} fps] eye on the axis`, JSON.stringify(report));
    assert.ok(report.offP50 < 4 && report.offMax < 8, 'within a few mm of the axis');
    assert.ok(report.alongMin > report.targetMm - 10 && report.alongMax < report.targetMm + 10, 'at the asked distance (it comes in ~8 mm past it, then eases back)');
    assert.ok(report.holdS >= run.plan.holdS - 0.05);
  });

  test(`${fps} fps: no teleport — root, head and eye move frame to frame within the dynamics; feet stay planted while she leans`, async () => {
    const run = await peekAt(fps);
    const roots = run.frames.map(f => ({ x: f.root.x, y: f.root.y, z: f.root.z }));
    const heads = run.frames.map(f => f.head), eyes = run.frames.map(f => f.eyes.left);
    const numbers = {
      rootStepCm: max(pointSteps(roots)), rootSurpriseCm: max(pointSurprises(roots)),
      headStepCm: max(pointSteps(heads)), headSurpriseCm: max(pointSurprises(heads)), eyeSurpriseCm: max(pointSurprises(eyes)),
      upperSurpriseDeg: max(surpriseAngles(run.frames as never, 0, UPPER)), legSurpriseDeg: max(surpriseAngles(run.frames as never, 0, LEGS)),
    };
    // Before (what the rule forbids): writing her straight to where she stands for the close-up, in one frame.
    const walkEnd = run.frames.find(f => f.phase === 'lean')!;
    const directWriteCm = Math.hypot(walkEnd.root.x - run.frames[0].root.x, walkEnd.root.z - run.frames[0].root.z) * 100;
    console.log(`[peek ${fps} fps] steps`, JSON.stringify({ ...numbers, directWriteCm }));
    const k = 60 / fps;
    assert.ok(numbers.rootStepCm <= run.plan.walkSpeedMps * 100 / fps * 1.25 + 0.05, 'root at most her walking speed');
    assert.ok(numbers.rootSurpriseCm < 0.1 * k * k);
    assert.ok(numbers.headSurpriseCm < 0.3 * k * k && numbers.eyeSurpriseCm < 0.3 * k * k);
    assert.ok(numbers.upperSurpriseDeg < 0.3 * k * k, 'upper body: no jolt');
    assert.ok(numbers.legSurpriseDeg < 4 * k * k, 'legs: within the gait\'s own walking envelope (U1 part 2)');
    assert.ok(directWriteCm > 100, 'the "before" a direct write would have been');
    // Toes planted through lean and hold (on her toes, the heel rolls about the toe: the toe stays put).
    let drift = 0;
    for (const foot of [0, 1]) {
      let anchor: { x: number; y: number; z: number } | null = null;
      for (const f of run.frames.filter(f => f.phase === 'lean' || f.phase === 'hold')) {
        const toe = f.toes[foot]; if (!toe) { anchor = null; continue; }
        anchor ??= toe; drift = Math.max(drift, Math.hypot(toe.x - anchor.x, toe.y - anchor.y, toe.z - anchor.z) * 100);
      }
    }
    console.log(`[peek ${fps} fps] planted toe drift while leaning ${drift.toFixed(4)} cm; on her toes up to ${max(run.frames.map(f => f.tiptoe)).toFixed(2)}`);
    assert.ok(drift < 0.05);
  });
}

test('the near plane never cuts her face in the close-up; I-192: at the closest the plan asks, the clip guard stops her before any of her comes into the camera', async () => {
  await peekAt(60); await peekAt(30); await peekAt(60, true);
  assert.ok(clipChecks.length >= 4, 'checked close-up frames');
  for (const c of clipChecks) {
    console.log('[peek near plane]', JSON.stringify(c));
    assert.ok(c.nearM <= NEAR_DEFAULT_M && c.nearM >= NEAR_MIN_M);
    assert.ok(c.boundM > c.nearM, `no part of her that shows is in front of the near plane (${c.boundM} > ${c.nearM})`);
    // I-192 ("注意不能穿模摄像头那一块"): at the closest the plan asks, the clip guard stops her earlier: what the picture shows stays out of the camera.
    if (c.case.endsWith('closest')) assert.ok(c.surfaceM >= ARRIVAL_KNOBS.minClearM - 0.005, `at the closest, what shows stays ${c.surfaceM} m from the lens`);
    // Depth precision at the near plane's ratio (24-bit): a step well under a millimetre at her eye.
    const step = (c.surfaceM ** 2) / (c.nearM * 2 ** 24);
    assert.ok(step < 1e-6);
  }
});

for (const beat of ['notice', 'walk', 'lean', 'hold'] as const) {
  test(`a mouse move during "${beat}" backs her off at once and smoothly, and she settles back home`, async () => {
    const run = await runPeek(60, 22, { cancelAt: beat, cancelAfter: beat === 'hold' ? 0.8 : 0.3 });
    const at = run.reports.findIndex(r => r.cancelled === 'input');
    assert.ok(at >= 0 && run.reports[at].phase === 'back', 'back at once');
    const cancelFrame = run.frames.findIndex(f => f.phase === 'back');
    const after = run.frames.slice(Math.max(0, cancelFrame - 2));
    const numbers = {
      headSurpriseCm: max(pointSurprises(after.map(f => f.head))), eyeSurpriseCm: max(pointSurprises(after.map(f => f.eyes.left))),
      upperSurpriseDeg: max(surpriseAngles(after as never, 0, UPPER)), rootSurpriseCm: max(pointSurprises(after.map(f => ({ x: f.root.x, y: f.root.y, z: f.root.z })))),
    };
    console.log(`[peek cancel in ${beat}]`, JSON.stringify(numbers));
    assert.ok(numbers.headSurpriseCm < 0.5 && numbers.eyeSurpriseCm < 0.5, 'a little startle, no jump');
    assert.ok(numbers.upperSurpriseDeg < 0.6 && numbers.rootSurpriseCm < 0.1);
    assert.equal(run.reports.at(-1)?.phase, 'done', 'settled');
    const last = run.frames.at(-1)!;
    assert.ok(Math.hypot(last.root.x - 0.25, last.root.z + 1.2) < 0.05, 'home again');
  });
}
