/**
 * T-215 嘴和眼睑的短暂独占 (src/stage/face-exclusive.ts): the module alone, on a small synthetic face, with a base that keeps
 * moving underneath (as the stage's writers do every frame). What a viewer would see is the final written vector Y:
 *  - continuity in value AND speed at every junction (in, out, the clip's own keys, a cancel at any phase, the release end),
 *    measured like Codex's T-215 check: one-sided differences with h = 1e-5 s on both sides, ≤ 0.005 per second apart;
 *  - the check can fail: a cancel that freezes the clip and fades linearly is caught;
 *  - the hand-back lands on the live base (not a snapshot from the start), and once over, Y is exactly B;
 *  - the lease: one per scope, busy then a short cooldown, never queued, an id once; a scope change releases, a cut ends;
 *  - idle, it writes nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { HER_ACTION_SPECS } from '../shared/her-actions';
import {
  FACE_EXCLUSIVE_COOLDOWN_S, FACE_EXCLUSIVE_TIMING, FaceExclusive, faceTracksByName, resolveFaceMorphs, writeExactMorph,
  type FaceRequest, type FaceScope,
} from '../src/stage/face-exclusive';

/**
 * Ten vertices, five morphs: 0 "cheek" (vertices 0–3), 1 "vowel" (3–5, shares vertex 3 with the cheek), 2 "lid" (6–7),
 * 3 "other lid" (8–9), 4 a shape that moves nothing (a material morph). `relative`: Three's relative morph targets.
 */
function face(relative = false) {
  const base = Array.from({ length: 30 }, (_, i) => i * 0.1);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(base, 3));
  const moves = [[0, 1, 2, 3], [3, 4, 5], [6, 7], [8, 9], []];
  geometry.morphAttributes.position = moves.map(vertices => {
    const values = relative ? new Array(30).fill(0) : [...base];
    for (const vertex of vertices) values[vertex * 3 + 2] += 0.05;
    return new Float32BufferAttribute(values, 3);
  });
  geometry.morphTargetsRelative = relative;
  return { geometry, morphTargetInfluences: [0, 0, 0, 0, 0] };
}

/** The clip keys of the cheek puff (T-211 batch 006), in seconds. */
const CHEEK = { times: [0, 9, 18, 35, 47, 55].map(f => f / 30), values: [0, 0.25, 0.9, 0.9, 0.15, 0] };
const WINK = { times: [0, 3, 6, 9, 16].map(f => f / 30), values: [0, 0.35, 0.9, 0.9, 0] };
/** The live base the writers leave each frame: moving all the time (lip-sync-like on the vowel, a slow lid). */
const base = (t: number) => [0.1 + 0.05 * Math.sin(3 * t), 0.3 + 0.25 * Math.sin(7 * t + 1), 0.2 + 0.1 * Math.sin(2 * t), 0.15, 0];

/** One stage-like run: before each frame the writers' base is in the influences; frame() writes; the next frame restores. */
function rig(mesh = face()) {
  const exclusive = new FaceExclusive(mesh), layers: { index: number; value: number }[] = [];
  let now = 0;
  const step = (dt: number, cancel?: Partial<Record<FaceScope, string | null>>, key = 'k') => {
    for (const layer of layers) mesh.morphTargetInfluences[layer.index] = layer.value; // restoreLayers
    layers.length = 0;
    now += dt;
    base(now).forEach((value, index) => { mesh.morphTargetInfluences[index] = value; });
    exclusive.frame(dt, { key, cancel }, mesh.morphTargetInfluences, layers);
    return [...mesh.morphTargetInfluences];
  };
  return { exclusive, mesh, layers, step, time: () => now };
}
const request = (overrides: Partial<FaceRequest> = {}): FaceRequest =>
  ({ id: `r${Math.random()}`, scope: 'mouth', key: 'k', duration: 55 / 30, tracks: [{ index: 0, ...CHEEK }], ...overrides });

/**
 * Speed continuity at `at` (s after the grant): Y at at − h, at and at + h, frames landing exactly there; a cancel lands exactly
 * at `cancelAt` (right after that frame) when given. Returns the largest |left − right| one-sided slope over the morphs (per
 * second) and the largest value step over h.
 */
function junction(input: FaceRequest, at: number, cancelAt: number | null = null, h = 1e-5) {
  const r = rig();
  r.step(0.5); // a running base before the request
  assert.equal(r.exclusive.request(input), true);
  let t = 0, y0 = r.step(0);
  const goTo = (target: number) => { while (target - t > 1e-12) { const dt = Math.min(1 / 60, target - t); y0 = r.step(dt); t += dt; } };
  if (cancelAt !== null && cancelAt < at - h) { goTo(cancelAt); r.exclusive.cancel(input.scope, 'speech'); }
  goTo(at - h);
  const y1 = r.step(h);
  if (cancelAt !== null && Math.abs(cancelAt - at) < 1e-12) r.exclusive.cancel(input.scope, 'speech');
  const y2 = r.step(h);
  let slope = 0, value = 0;
  for (let i = 0; i < y1.length; i++) {
    slope = Math.max(slope, Math.abs((y1[i] - y0[i]) / h - (y2[i] - y1[i]) / h));
    value = Math.max(value, Math.abs(y2[i] - y1[i]));
  }
  return { slope, value };
}

test('the conflict group comes from the geometry: every morph that moves a vertex the clip moves (absolute and relative targets)', () => {
  for (const relative of [false, true]) {
    const exclusive = new FaceExclusive(face(relative));
    assert.deepEqual([...exclusive.displaced(0)], [0, 1, 2, 3]);
    assert.deepEqual([...exclusive.displaced(4)], [], 'a shape that moves nothing displaces nothing');
    assert.deepEqual(exclusive.conflictGroup([0]), [0, 1], 'the vowel shares vertex 3 with the cheek');
    assert.deepEqual(exclusive.conflictGroup([2]), [2], 'the other lid does not overlap: not in the group');
    assert.deepEqual(exclusive.conflictGroup([1, 2]), [0, 1, 2]);
  }
});

test('natural run: Y = B outside, the clip inside, and speed continuous at every junction (in, out, every key); within [0, 1]', context => {
  const t = FACE_EXCLUSIVE_TIMING.mouth, duration = 55 / 30;
  const r = rig();
  r.step(0.3);
  const id = 'natural';
  assert.equal(r.exclusive.request(request({ id })), true);
  let peak = 0, low = Infinity, high = -Infinity, frames = 0;
  while (r.exclusive.active('mouth')) {
    const y = r.step(1 / 60); frames++;
    const now = r.time(), b = base(now);
    peak = Math.max(peak, y[0]);
    for (const value of y.slice(0, 2)) { low = Math.min(low, value); high = Math.max(high, value); }
    // The hold: owned completely, the vowel that shares the cheek's vertices shows nothing.
    const state = r.exclusive.getState().mouth;
    if (state?.phase === 'playing' && state.elapsedMs > 700 && state.elapsedMs < 1100) { assert.ok(Math.abs(y[0] - 0.9) < 1e-6); assert.ok(Math.abs(y[1]) < 1e-6); }
    assert.ok(Math.abs(y[2] - b[2]) < 1e-12, 'a morph outside the group is never written');
  }
  assert.ok(Math.abs(frames / 60 - duration) < 2 / 60, `ran its own length (${frames} frames)`);
  assert.ok(peak > 0.89, `${peak}`); assert.ok(low >= 0 && high <= 1, `${low}..${high}`);
  // Over: exactly the base, and nothing written this frame.
  const after = r.step(1 / 60);
  assert.deepEqual(after, base(r.time()), 'ended: Y is B');
  assert.equal(r.layers.length, 0);
  // Speed: every junction, Codex's measure (h = 1e-5 s, ≤ 0.005/s apart): the start, in, out, the end and every key.
  const junctions = [2e-5, t.enter, duration - t.exit, duration, ...CHEEK.times.slice(1, -1)];
  let worst = 0;
  for (const at of junctions) {
    const { slope } = junction(request(), at);
    worst = Math.max(worst, slope);
    assert.ok(slope < 0.005, `t = ${at.toFixed(4)} s: one-sided speeds differ by ${slope.toFixed(6)}/s`);
  }
  // The wink on the eyelid timing (in 0.08 s, out 0.12 s), same measure.
  const wink = (): FaceRequest => ({ id: `w${Math.random()}`, scope: 'eyelids', key: 'k', duration: 16 / 30, tracks: [{ index: 2, ...WINK }] });
  for (const at of [2e-5, FACE_EXCLUSIVE_TIMING.eyelids.enter, 16 / 30 - FACE_EXCLUSIVE_TIMING.eyelids.exit, 16 / 30, ...WINK.times.slice(1, -1)]) {
    const { slope } = junction(wink(), at);
    worst = Math.max(worst, slope);
    assert.ok(slope < 0.005, `wink t = ${at.toFixed(4)} s: ${slope.toFixed(6)}/s`);
  }
  context.diagnostic(`natural junctions (cheek puff and wink, every key, in, out, start, end): largest one-sided speed difference ${worst.toFixed(6)}/s`);
});

test('cancel at any phase hands back from the shown weight and its speed, on the live base: no jump, no kink; the clip clock never freezes', t => {
  const duration = 55 / 30, timing = FACE_EXCLUSIVE_TIMING.mouth;
  const lines: string[] = [];
  for (const at of [0.05, 0.12, 0.19, 0.45, 0.6, 1.0, 1.3, duration - timing.exit - 0.01]) {
    const { slope, value } = junction(request(), at, at);
    const end = junction(request(), at + timing.cancel, at);
    lines.push(`cancel at ${at.toFixed(2)} s: speed difference ${slope.toFixed(6)}/s (step over h ${value.toExponential(2)}); release end ${end.slope.toFixed(6)}/s`);
    assert.ok(slope < 0.005, `cancel at ${at}: one-sided speeds differ by ${slope}/s`);
    assert.ok(end.slope < 0.005, `release end after a cancel at ${at}: ${end.slope}/s`);
    // The release itself: whole run after the cancel, its end too.
    const r = rig(); r.step(0.5);
    assert.equal(r.exclusive.request(request()), true);
    let t = 0;
    while (t < at - 1e-9) { r.step(1 / 600); t += 1 / 600; }
    r.exclusive.cancel('mouth', 'speech');
    const shown: number[][] = [];
    while (r.exclusive.active('mouth')) shown.push(r.step(1 / 600));
    assert.ok(shown.length / 600 <= timing.cancel + 1.5 / 600, `released within ${timing.cancel} s (${shown.length / 600})`);
    shown.push(r.step(1 / 600), r.step(1 / 600));
    // Between 1/600 s frames a smooth curve changes speed by (acceleration / 600); a kink of 1/s would show as 1/s.
    for (let k = 2; k < shown.length; k++) for (let i = 0; i < 2; i++) {
      const kink = Math.abs((shown[k][i] - shown[k - 1][i]) - (shown[k - 1][i] - shown[k - 2][i])) * 600;
      assert.ok(kink < 0.5, `cancel at ${at}, frame ${k}, morph ${i}: speed jumps ${kink}/s between 1/600 s frames`);
    }
    assert.deepEqual(shown.at(-1), base(r.time()), 'handed back onto the base as it is now');
  }
  // Already in its natural exit: that exit simply goes on (it is no longer than the cancel).
  const r = rig(); r.step(0.5);
  assert.equal(r.exclusive.request(request({ id: 'late' })), true);
  for (let t = 0; t < duration - 0.1; t += 1 / 60) r.step(1 / 60);
  r.exclusive.cancel('mouth', 'speech');
  assert.equal(r.exclusive.getState().mouth?.phase, 'exiting');
  // Codex's negative control: freezing the clip at the cancel and fading linearly is caught by the same measure.
  const frozen = (t: number, at: number) => {
    const s = Math.max(0, Math.min(1, (t - at) / timing.cancel)), w = t < at ? 1 : 1 - s, a = 0.9;
    const b = base(t)[0]; return (1 - w) * b + w * a;
  };
  const at = 1.0, h = 1e-5;
  const kink = Math.abs((frozen(at, at) - frozen(at - h, at)) / h - (frozen(at + h, at) - frozen(at, at)) / h);
  assert.ok(kink > 1, `a frozen linear fade has a speed jump (${kink.toFixed(3)}/s)`);
  lines.push(`negative control (frozen clip, linear fade): ${kink.toFixed(3)}/s`);
  t.diagnostic(lines.join('\n'));
});

test('the eyelid scope: quicker timing, independent of the mouth; lidHold covers a start delay and the release', () => {
  const r = rig();
  r.step(0.2);
  assert.equal(r.exclusive.request(request({ id: 'm', tracks: [{ index: 0, ...CHEEK }] })), true);
  assert.equal(r.exclusive.request({ id: 'w', scope: 'eyelids', key: 'k', duration: 16 / 30, tracks: [{ index: 2, ...WINK }], delay: 0.1 }), true);
  assert.ok(Math.abs(r.exclusive.lidHold() - (0.1 + 16 / 30)) < 1e-9);
  r.step(0.05);
  assert.equal(r.exclusive.getState().eyelids?.phase, 'waiting');
  assert.ok(Math.abs(r.step(0.001)[2] - base(r.time())[2]) < 1e-12, 'not started yet: the lid shows its base');
  for (let i = 0; i < 12; i++) r.step(1 / 60);
  r.exclusive.cancel('eyelids', 'closure');
  assert.ok(r.exclusive.lidHold() <= FACE_EXCLUSIVE_TIMING.eyelids.cancel + 1e-9);
  assert.equal(r.exclusive.active('mouth'), true, 'the mouth goes on');
  for (let i = 0; i < 12; i++) r.step(1 / 60);
  assert.equal(r.exclusive.active('eyelids'), false);
  assert.equal(r.exclusive.lidHold(), 0);
});

test('the lease: one per scope, busy and then a short cooldown, never queued; an id plays once; a scope change releases, a cut ends', () => {
  const r = rig();
  r.step(0.1);
  assert.equal(r.exclusive.request(request({ id: 'c', tracks: [{ index: 99, ...CHEEK }] })), 'empty', 'a track this mesh does not have binds nothing');
  assert.equal(r.exclusive.request(request({ id: 'd', duration: Number.NaN })), 'invalid');
  assert.equal(r.exclusive.request(request({ id: 'a' })), true);
  assert.equal(r.exclusive.request(request({ id: 'b' })), 'busy');
  assert.equal(r.exclusive.request(request({ id: 'a' })), 'seen');
  for (let i = 0; i < 30; i++) r.step(1 / 60);
  // A different character or conversation: released from what shows (not cut).
  r.step(1 / 60, undefined, 'other');
  assert.equal(r.exclusive.getState().mouth?.phase, 'releasing');
  assert.equal(r.exclusive.getState().mouth?.reason, 'scope');
  while (r.exclusive.active('mouth')) r.step(1 / 60, undefined, 'other');
  assert.equal(r.exclusive.busy('mouth'), true, 'cooldown');
  assert.equal(r.exclusive.request(request({ id: 'e', key: 'other' })), 'busy');
  for (let t = 0; t < FACE_EXCLUSIVE_COOLDOWN_S + 0.02; t += 1 / 60) r.step(1 / 60, undefined, 'other');
  assert.equal(r.exclusive.request(request({ id: 'f', key: 'other' })), true);
  r.step(1 / 60, undefined, 'other');
  r.exclusive.cut('hidden');
  assert.equal(r.exclusive.active('mouth'), false);
  assert.equal(r.exclusive.getState().ended?.how, 'cut');
  // A cancel before anything showed: simply not started.
  for (let t = 0; t < 0.4; t += 1 / 60) r.step(1 / 60, undefined, 'other');
  assert.equal(r.exclusive.request(request({ id: 'g', key: 'other' })), true);
  r.exclusive.cancel('mouth', 'speech');
  assert.equal(r.exclusive.active('mouth'), false);
  assert.equal(r.exclusive.getState().ended?.how, 'released');
});

test('idle: frame() writes nothing and owns nothing; writeExactMorph remembers the value before it once per frame', () => {
  const mesh = face(), exclusive = new FaceExclusive(mesh), layers: { index: number; value: number }[] = [];
  mesh.morphTargetInfluences.splice(0, 5, 0.3, 0.2, 0.1, 0.4, 0);
  for (let i = 0; i < 10; i++) exclusive.frame(1 / 60, { key: 'k' }, mesh.morphTargetInfluences, layers);
  assert.deepEqual(mesh.morphTargetInfluences, [0.3, 0.2, 0.1, 0.4, 0]);
  assert.equal(layers.length, 0); assert.equal(exclusive.owned(), null); assert.equal(exclusive.lidHold(), 0);
  writeExactMorph(mesh.morphTargetInfluences, layers, 1, 0.05); writeExactMorph(mesh.morphTargetInfluences, layers, 1, 0.07);
  assert.deepEqual(layers, [{ index: 1, value: 0.2 }]); assert.equal(mesh.morphTargetInfluences[1], 0.07, 'exact, not max');
});

test('the four face actions resolve their morphs: profile slots first (no name fallback when the profile says missing), then names and aliases', () => {
  const names = { cheekPuff: 0, 'ウィンク': 1, 'あ': 2, tongue_out: 3, 'Mouth Pucker': 4 };
  const lookup = (slots: Record<string, number> | null) => ({ names, count: 5, displaces: (index: number) => index !== 4,
    slot: (slot: string) => slots ? slots[slot] ?? -1 : null });
  assert.deepEqual([...resolveFaceMorphs(HER_ACTION_SPECS['cheek-puff'].face!, lookup({})).indices], [['cheekPuff', 0]]);
  const tongue = resolveFaceMorphs(HER_ACTION_SPECS['tongue-out'].face!, lookup({ a: 2 }));
  assert.deepEqual({ indices: tongue.indices, missing: tongue.missing }, { indices: new Map([['あ', 2], ['tongueOut', 3]]), missing: [] });
  assert.deepEqual(resolveFaceMorphs(HER_ACTION_SPECS.wink.face!, lookup({ blinkLeft: -1 })).missing, ['单眼闭眼的表情（ウィンク）', '右眼单独闭的表情（ウィンク右）'],
    'the profile rejected the name: no fallback to it (and no right wink to stand in: skeleton step 2)');
  assert.deepEqual([...resolveFaceMorphs(HER_ACTION_SPECS.wink.face!, lookup(null)).indices], [['ウィンク', 1]], 'no profile at all: the name');
  assert.deepEqual(resolveFaceMorphs(HER_ACTION_SPECS.pout.face!, lookup({ u: -1 })).missing, ['嘟嘴的表情（mouthPucker）', '口型“う”'],
    'no pucker slot and no う to stand in (skeleton step 2); the optional corners are left out silently');
  assert.deepEqual(resolveFaceMorphs(HER_ACTION_SPECS.pout.face!, lookup(null)).missing, ['嘟嘴的表情（mouthPucker）', '口型“う”'],
    'no profile: the pucker by name ("Mouth Pucker" moves no vertex) and う by name (none here)');
  assert.deepEqual(faceTracksByName([{ morphName: 'x', frameNum: 9, weight: 0.5 }, { morphName: 'x', frameNum: 0, weight: 0 }, { morphName: 'x', frameNum: 9, weight: 0.6 }]).get('x'),
    { times: [0, 0.3], values: [0, 0.6] });
});
