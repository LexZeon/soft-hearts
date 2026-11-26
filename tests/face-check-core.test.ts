/**
 * I-135 认出"不是你": the pure parts (docs/claude/2026-11-14-i135-face-build.md). Synthetic numbers and images only: no camera,
 * no model, no real face.
 *
 * What it pins: alignment puts YuNet's five landmarks on SFace's reference points; YuNet decoding and letterboxing; cosine and
 * the clarity measures; "拿不准就当是你" (uncertain → you; only two clear lows in a row → not-you; back to you); the auto-augment
 * cap, interval and diversity; enrolment taking only clear samples of one face; the scheduler (nothing while inactive, the
 * low-rate continuous check, the burst after a leave).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { alignFace, applySimilarity, fitSimilarity, invertSimilarity, SFACE_REFERENCE, type Landmarks5 } from '../electron/senses/face/align';
import { classifyCheck, FaceDecision, isClearFace, type CheckClass, type FaceObservation } from '../electron/senses/face/decision';
import { judgeEnrolSample, shouldAugment, type EnrolledFace } from '../electron/senses/face/enrolment';
import { FACE_KNOBS } from '../electron/senses/face/knobs';
import { FaceCheckScheduler } from '../electron/senses/face/scheduler';
import { bestSimilarity, brightness, cosine, frontalness, l2normalize, sharpness } from '../electron/senses/face/score';
import { decodeYunet, detectorInput, largestFace, YUNET_STRIDES } from '../electron/senses/face/yunet';

const near = (actual: number, expected: number, tolerance: number, message?: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} expected ${expected} ± ${tolerance}, got ${actual}`);

// ------------------------------------------------------------------ alignment

test('similarity fit recovers a known rotation + scale + shift and inverts cleanly', () => {
  const truth = { a: 1.3 * Math.cos(0.4), b: 1.3 * Math.sin(0.4), tx: 12, ty: -7 };
  const src = [{ x: 10, y: 20 }, { x: 60, y: 18 }, { x: 35, y: 45 }, { x: 15, y: 70 }, { x: 55, y: 72 }];
  const dst = src.map(p => applySimilarity(truth, p));
  const fit = fitSimilarity(src, dst);
  near(fit.a, truth.a, 1e-9); near(fit.b, truth.b, 1e-9); near(fit.tx, truth.tx, 1e-9); near(fit.ty, truth.ty, 1e-9);
  const back = invertSimilarity(fit);
  for (const p of src) { const q = applySimilarity(back, applySimilarity(fit, p)); near(q.x, p.x, 1e-9); near(q.y, p.y, 1e-9); }
  assert.throws(() => fitSimilarity([{ x: 1, y: 1 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]));
});

test('aligning a tilted, scaled face puts each landmark on SFace\'s reference point', () => {
  // A 320×240 frame with five coloured dots where a tilted face's landmarks are.
  const width = 320, height = 240;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const placement = { a: 0.9 * Math.cos(-0.3), b: 0.9 * Math.sin(-0.3), tx: 100, ty: 60 }; // reference → frame
  const landmarks = SFACE_REFERENCE.map(p => applySimilarity(placement, p)) as unknown as Landmarks5;
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]];
  landmarks.forEach((p, k) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy, at = (y * width + x) * 4;
      rgba[at] = colours[k][0]; rgba[at + 1] = colours[k][1]; rgba[at + 2] = colours[k][2];
    }
  });
  const aligned = alignFace(rgba, width, height, landmarks);
  assert.equal(aligned.rgb.length, 3 * 112 * 112);
  const plane = 112 * 112;
  SFACE_REFERENCE.forEach((p, k) => {
    const at = Math.round(p.y) * 112 + Math.round(p.x);
    const pixel = [aligned.rgb[at], aligned.rgb[plane + at], aligned.rgb[2 * plane + at]];
    for (let c = 0; c < 3; c++) near(pixel[c], colours[k][c], 60, `landmark ${k} channel ${c}`);
  });
  // Outside the frame is black, like warpAffine's default border.
  const far = alignFace(rgba, width, height, landmarks.map(p => ({ x: p.x + 400, y: p.y })) as unknown as Landmarks5);
  assert.ok(far.rgb.every(value => value === 0));
});

// ------------------------------------------------------------------ YuNet

function yunetOutputs(cells: { stride: number; r: number; c: number; score: number; box: [number, number, number, number]; kps?: number[] }[]) {
  const outputs: Record<string, { data: Float32Array }> = {};
  for (const stride of YUNET_STRIDES) {
    const n = (640 / stride) ** 2;
    outputs[`cls_${stride}`] = { data: new Float32Array(n) }; outputs[`obj_${stride}`] = { data: new Float32Array(n) };
    outputs[`bbox_${stride}`] = { data: new Float32Array(n * 4) }; outputs[`kps_${stride}`] = { data: new Float32Array(n * 10) };
  }
  for (const cell of cells) {
    const index = cell.r * (640 / cell.stride) + cell.c;
    outputs[`cls_${cell.stride}`].data[index] = cell.score; outputs[`obj_${cell.stride}`].data[index] = cell.score;
    outputs[`bbox_${cell.stride}`].data.set(cell.box, index * 4);
    outputs[`kps_${cell.stride}`].data.set(cell.kps ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], index * 10);
  }
  return outputs;
}

test('YuNet decoding follows OpenCV: centre from the cell, size from exp, landmarks per cell, back to source pixels', () => {
  const outputs = yunetOutputs([{ stride: 16, r: 10, c: 20, score: 0.95, box: [0.5, 0.25, Math.log(5), Math.log(6)], kps: [0, 0, 1, 0, 0.5, 1, 0, 2, 1, 2] }]);
  const faces = decodeYunet(outputs, { size: 640, scale: 2 }, FACE_KNOBS.detector);
  assert.equal(faces.length, 1);
  const face = faces[0];
  near(face.score, 0.95, 1e-6);
  // cx = (20 + 0.5)·16 = 328, w = 80 → x1 = 288; in source pixels (scale 2): 144, width 40
  near(face.x, 144, 1e-4); near(face.width, 40, 1e-4);
  near(face.y, ((10 + 0.25) * 16 - 48) / 2, 1e-4); near(face.height, 48, 1e-4);
  near(face.landmarks[0].x, 20 * 16 / 2, 1e-4); near(face.landmarks[1].x, 21 * 16 / 2, 1e-4); near(face.landmarks[3].y, 12 * 16 / 2, 1e-4);
  // Below the threshold: nothing; two overlapping: NMS keeps the better; largest face wins.
  assert.equal(decodeYunet(yunetOutputs([{ stride: 8, r: 1, c: 1, score: 0.3, box: [0, 0, 0, 0] }]), { size: 640, scale: 1 }, FACE_KNOBS.detector).length, 0);
  const overlap = decodeYunet(yunetOutputs([
    { stride: 16, r: 10, c: 20, score: 0.95, box: [0, 0, Math.log(5), Math.log(5)] },
    { stride: 16, r: 10, c: 21, score: 0.9, box: [0, 0, Math.log(5), Math.log(5)] },
    { stride: 32, r: 2, c: 2, score: 0.8, box: [0, 0, Math.log(4), Math.log(4)] },
  ]), { size: 640, scale: 1 }, FACE_KNOBS.detector);
  assert.equal(overlap.length, 2);
  near(largestFace(overlap)!.width, 128, 1e-4);
  assert.throws(() => decodeYunet({}, { size: 640, scale: 1 }, FACE_KNOBS.detector));
});

test('detector input is planar BGR, letterboxed top-left, 0..255', () => {
  const rgba = new Uint8Array(32 * 16 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 200; rgba[i + 1] = 100; rgba[i + 2] = 10; rgba[i + 3] = 255; }
  const input = detectorInput(rgba, 32, 16, 64);
  assert.equal(input.scale, 2);
  const plane = 64 * 64;
  near(input.data[0], 10, 1e-3); near(input.data[plane], 100, 1e-3); near(input.data[2 * plane], 200, 1e-3);
  assert.equal(input.data[40 * 64 + 5], 0, 'below the picture is black');
});

// ------------------------------------------------------------------ scores

test('cosine, normalisation and the clarity measures', () => {
  near(cosine([1, 0], [0, 1]), 0, 1e-12); near(cosine([1, 2], [2, 4]), 1, 1e-12); assert.equal(cosine([0, 0], [1, 1]), 0); assert.equal(cosine([1], [1, 2]), 0);
  near(Math.hypot(...l2normalize([3, 4])), 1, 1e-6);
  assert.equal(bestSimilarity([1, 0], []), null);
  near(bestSimilarity([1, 0], [[0, 1], [1, 0.1]])!, cosine([1, 0], [1, 0.1]), 1e-6);
  near(frontalness(SFACE_REFERENCE), 1, 0.05, 'the reference face is frontal');
  const turned = SFACE_REFERENCE.map((p, k) => k === 2 ? { x: p.x + 14, y: p.y } : p) as unknown as Landmarks5;
  assert.ok(frontalness(turned) < 0.2, 'nose far off the middle: a side face');
  const tilted = SFACE_REFERENCE.map(p => applySimilarity({ a: Math.cos(0.5), b: Math.sin(0.5), tx: 0, ty: 0 }, p)) as unknown as Landmarks5;
  near(frontalness(tilted), frontalness(SFACE_REFERENCE), 1e-6, 'head roll does not count');
  const flat = new Float32Array(112 * 112).fill(120), checker = new Float32Array(112 * 112).map((_, i) => ((i % 112) + Math.floor(i / 112)) % 2 ? 200 : 40);
  assert.equal(sharpness(flat, 112), 0);
  assert.ok(sharpness(checker, 112) > 1000);
  near(brightness(flat, 112), 120, 1e-3);
});

// ------------------------------------------------------------------ the decision: 拿不准就当是你

const clear = (similarity: number | null, extra: Partial<FaceObservation> = {}): FaceObservation =>
  ({ found: true, detScore: 0.97, faceWidth: 90, frontal: 0.95, sharpness: 120, brightness: 130, similarity, ...extra });

test('classification: only a clear frontal face with a low score is "clearly not"; everything doubtful is unsure', () => {
  assert.equal(classifyCheck(null), 'skipped');
  assert.equal(classifyCheck({ ...clear(null), found: false }), 'no-face');
  assert.equal(classifyCheck(clear(null)), 'skipped', 'nothing enrolled');
  assert.equal(classifyCheck(clear(0.7)), 'match');
  assert.equal(classifyCheck(clear(0.5, { frontal: 0.2, sharpness: 2 })), 'match', 'a confident match need not be a perfect picture');
  assert.equal(classifyCheck(clear(0.05)), 'clear-not');
  assert.equal(classifyCheck(clear(0.28)), 'clear-not', '2026-11-25: 0.28 is well under the official 0.363 line');
  assert.equal(classifyCheck(clear(FACE_KNOBS.match.clearlyNotCosine + 0.01)), 'weak-not', 'the grey band just under the official line');
  assert.equal(classifyCheck(clear(FACE_KNOBS.match.sameCosine)), 'match');
  assert.equal(classifyCheck(clear(0.33, { frontal: 0.4 })), 'unsure', 'a doubtful picture in the grey band stays unsure');
  for (const doubt of [{ frontal: 0.4 }, { sharpness: 5 }, { brightness: 20 }, { brightness: 250 }, { faceWidth: 30 }, { detScore: 0.7 }])
    assert.equal(classifyCheck(clear(0.05, doubt)), 'unsure', JSON.stringify(doubt));
  assert.ok(isClearFace(clear(0.1)));
});

test('state: uncertain keeps "you"; two clear lows in a row make "not-you"; a match or two doubts bring "you" back', () => {
  const decision = new FaceDecision();
  let t = 0;
  const feed = (cls: CheckClass) => decision.step(cls, t += 2500);
  for (const cls of ['no-face', 'unsure', 'unsure', 'skipped'] as CheckClass[]) assert.equal(feed(cls).state, 'you');
  assert.equal(feed('clear-not').state, 'you', 'one low is not enough');
  assert.equal(feed('unsure').state, 'you');
  assert.equal(feed('clear-not').state, 'you', 'the doubt in between broke the streak');
  const change = feed('clear-not');
  assert.deepEqual(change, { state: 'not-you', changed: true });
  assert.equal(feed('clear-not').changed, false);
  assert.equal(feed('unsure').state, 'not-you', 'one blurry frame does not flip her back mid-conversation');
  assert.equal(feed('no-face').state, 'you', 'two doubts in a row: back to you');
  feed('clear-not'); feed('clear-not');
  assert.equal(decision.state, 'not-you');
  assert.deepEqual(feed('match'), { state: 'you', changed: true }, 'a clear match returns at once');
  feed('clear-not'); feed('clear-not');
  assert.equal(decision.expire(t + FACE_KNOBS.match.notYouExpireMs - 1).state, 'not-you');
  assert.deepEqual(decision.expire(t + FACE_KNOBS.match.notYouExpireMs), { state: 'you', changed: true }, 'no checks for a minute: you');
  feed('clear-not'); feed('clear-not'); decision.reset();
  assert.equal(decision.state, 'you');
});

test('2026-11-25 the grey band under 0.363: a single weak low never decides, a few in a row do, a doubt or a match breaks them', () => {
  assert.equal(FACE_KNOBS.match.sameCosine, 0.363, 'the official line (opencv_zoo sface.py)');
  assert.ok(FACE_KNOBS.match.clearlyNotCosine < FACE_KNOBS.match.sameCosine && FACE_KNOBS.match.clearlyNotCosine >= 0.25, 'a small buffer under it, not the old 0.20');
  const run = (...classes: CheckClass[]) => { const d = new FaceDecision(); let t = 0; for (const cls of classes) d.step(cls, t += 2500); return d.state; };
  assert.equal(run('weak-not'), 'you');
  assert.equal(run('weak-not', 'weak-not', 'weak-not'), 'you', 'three weak lows are 1.5, not yet 2');
  assert.equal(run('weak-not', 'weak-not', 'weak-not', 'weak-not'), 'not-you', 'four in a row: someone who stays under the line does not pass as you for long');
  assert.equal(run('weak-not', 'weak-not', 'clear-not'), 'not-you', 'a clear low counts for two weak ones');
  assert.equal(run('weak-not', 'weak-not', 'weak-not', 'unsure', 'weak-not'), 'you', 'a doubt in between breaks the run');
  assert.equal(run('weak-not', 'weak-not', 'weak-not', 'match', 'weak-not'), 'you');
  // Once "not you", a grey-band face does not bring "you" back (only a match or doubts do).
  assert.equal(run('clear-not', 'clear-not', 'weak-not', 'weak-not', 'weak-not'), 'not-you');
});

// ------------------------------------------------------------------ enrolment and auto-augment

/** A seeded random unit vector (mulberry32 + Box-Muller): different seeds are nearly orthogonal, like two different people. */
const unit = (seed: number) => { let a = seed * 2654435761 >>> 0; const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return l2normalize(Array.from({ length: 128 }, () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()))); };
const mix = (a: Float32Array, b: Float32Array, t: number) => l2normalize(a.map((v, i) => v * (1 - t) + b[i] * t));

test('enrolment takes clear samples of one face, skips repeats and someone else', () => {
  const me = unit(1), other = unit(50);
  assert.ok(cosine(me, other) < FACE_KNOBS.match.sameCosine, 'fixture: two different people');
  assert.equal(judgeEnrolSample([], clear(null), me), 'taken');
  assert.equal(judgeEnrolSample([], { ...clear(null), found: false }, null), 'no-face');
  assert.equal(judgeEnrolSample([], clear(null, { frontal: 0.3 }), me), 'not-clear');
  assert.equal(judgeEnrolSample([me], clear(null), me), 'duplicate');
  assert.equal(judgeEnrolSample([me], clear(null), other), 'different-person');
  assert.equal(judgeEnrolSample([me], clear(null), mix(me, other, 0.25)), 'taken');
  assert.equal(judgeEnrolSample([me, me, me, me, me], clear(null), me), 'full');
});

test('auto-augment: only very confident, clear, different-looking matches, at most every 10 minutes, never past the cap', () => {
  const me = unit(1), other = unit(50);
  const now = 100 * 60_000;
  const stored: EnrolledFace[] = [{ vector: me, source: 'enrol', at: 0 }];
  const newLook = mix(me, other, 0.45);
  const sim = cosine(newLook, me);
  assert.ok(sim >= FACE_KNOBS.augment.minCosine && sim < FACE_KNOBS.augment.maxSimilarToStored, `fixture similarity ${sim}`);
  assert.equal(shouldAugment(stored, clear(sim), newLook, now), true);
  assert.equal(shouldAugment(stored, clear(cosine(me, me)), me, now), false, 'the same look again adds nothing');
  assert.equal(shouldAugment(stored, clear(0.45), newLook, now), false, 'not confident enough');
  assert.equal(shouldAugment(stored, clear(sim, { frontal: 0.75 }), newLook, now), false, 'not frontal enough');
  assert.equal(shouldAugment([{ vector: me, source: 'enrol', at: now - 60_000 }], clear(sim), newLook, now), false, 'too soon');
  const full = Array.from({ length: FACE_KNOBS.augment.cap }, (_, i) => ({ vector: unit(100 + i), source: 'auto' as const, at: 0 }));
  assert.equal(shouldAugment(full, clear(sim), newLook, now), false, 'cap reached');
  assert.equal(shouldAugment([], clear(sim), newLook, now), false, 'never from nothing (enrolment comes first)');
});

// ------------------------------------------------------------------ scheduler

test('scheduler: nothing while inactive; the continuous check every 2.5 s, slower with nobody in view', () => {
  const s = new FaceCheckScheduler();
  assert.equal(s.due(0), null);
  s.noteLeave(); s.noteReturn();
  assert.equal(s.due(10_000), null, 'still inactive');
  s.setActive(true);
  assert.equal(s.due(0), 'continuous');
  s.started(0);
  assert.equal(s.due(100), null, 'one at a time');
  s.finished('match', 'continuous');
  assert.equal(s.due(2_000), null);
  assert.equal(s.due(2_500), 'continuous');
  let t = 2_500;
  for (let i = 0; i < FACE_KNOBS.schedule.idleAfterNoFace; i++) { s.started(t); s.finished('no-face', 'continuous'); t += 2_500; }
  assert.equal(s.due(t - 2_500 + 2_500), null, 'nobody for a while: less often');
  assert.equal(s.due(t - 2_500 + FACE_KNOBS.schedule.idleMs), 'continuous');
  s.setActive(false);
  assert.equal(s.due(1e9), null);
});

test('scheduler: after a leave, someone appearing starts a short burst that ends early on a match', () => {
  const s = new FaceCheckScheduler();
  s.setActive(true);
  s.started(0); s.finished('match', 'continuous');
  s.noteReturn();
  assert.equal(s.due(800), null, 'a return without a leave changes nothing');
  s.noteLeave();
  assert.equal(s.isAway, true);
  s.noteReturn();
  assert.equal(s.due(800), 'return');
  s.started(800); s.finished('unsure', 'return');
  assert.equal(s.due(800 + FACE_KNOBS.schedule.burstGapMs), 'return');
  s.started(1500); s.finished('match', 'return');
  assert.equal(s.due(2200), null, 'the burst ended on a match');
  assert.equal(s.due(1500 + 2500), 'continuous');
});
