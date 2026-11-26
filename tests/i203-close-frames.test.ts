// I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md): the kiss and the hug as the user drew them, the pure rules. The user:
//  - "亲最近要看到嘴和眼睛和一些头发" and the kiss storyboard ("这个分镜差不多了") → at the closest her eyes sit in the upper part of the screen, her
//    mouth in the lower part, both centred (kissFrame);
//  - "抱抱头大概占比2/5右侧，脸测过去" and the hug's last frame ("这个差不多是抱抱最终的样子") → her ear (the one the camera sees) at the screen's right,
//    her head about two fifths of the width, her face turned OUTWARD (toward the screen's right), never toward the centre (hugFrame, the plan);
//  - "撩头发，撅嘴，害羞是抱抱亲亲的角色选择。" → the pucker, the hair tuck and the blush are her choices (extras.ts), never fixed in the timeline;
//  - "亲亲抱抱按推荐" with the hold hers, at least about 1.5 s, at most 12 s (arrivalHoldS).
// The real frame loop's numbers (Gene, the synthetic VRM, 60 / 30 fps) are in tests/i192-arrival-models.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRIVAL_KNOBS, FACE_PER_EYE_SPAN, arrivalHoldS, earOffset, faceTurnSeen, headPointNow, headWidthM, hugFrame, inWindow, kissFrame, windowPoint, type FaceGeometry, type V3,
} from '../shared/unbound/arrival';
import {
  CLOSE_EXTRAS, NEUTRAL_TEMPERAMENT, backChannels, backLength, chooseCloseExtras, closeExtraChances, closeReading, leanChannels, parseCloseExtras, parseCloseMomentPlan,
  planCloseMoment, tuckTiming, type CloseExtra,
} from '../shared/unbound/close-moments';
import { NEUTRAL_MOOD, type MoodReading } from '../shared/unbound/director';
import { FaceArrival } from '../src/unbound/motion/arrive';

const face = (): FaceGeometry => ({ eyes: { x: 0, y: 0.08, z: 0.09 }, eyeSizeM: 0.025, mouthDropM: 0.064, points: [] });
// A camera at the viewer's eye looking down −z, its window 0.70 wide and 0.44 tall per metre ahead (the user's 1536 × 960 screen from 55 cm).
const LENS = { camera: { x: 0, y: 1.45, z: 0.55 }, axis: { x: 0, y: 0, z: -1 }, heightPerM: 0.44, window: { left: -0.35, right: 0.35, top: 0.22, bottom: -0.22 } };
const WARM: MoodReading = { ...NEUTRAL_MOOD, O: 78, E: 65, D: 60, M: 20 };
const seq = (values: number[]) => { let i = 0; return () => values[i++ % values.length]; };

test('the kiss: with her aim on the axis at its distance, her eyes sit at kissEyesV (upper part) and her mouth at kissMouthV (lower part), centred', () => {
  const f = face(), k = kissFrame(f, LENS)!;
  assert.ok(ARRIVAL_KNOBS.kissEyesV > 0.2 && ARRIVAL_KNOBS.kissMouthV < -0.2, 'the storyboard: eyes in the upper part, mouth in the lower part');
  const aim = windowPoint(LENS, k.fitM, { u: 0, v: 0 }), eyes = { ...aim, y: aim.y + k.dropM }, mouth = { ...aim, y: aim.y + k.dropM - f.mouthDropM };
  const e = inWindow(LENS, eyes)!, m = inWindow(LENS, mouth)!;
  assert.ok(Math.abs(e.v - ARRIVAL_KNOBS.kissEyesV) < 1e-9 && Math.abs(m.v - ARRIVAL_KNOBS.kissMouthV) < 1e-9, `eyes ${e.v}, mouth ${m.v}`);
  assert.ok(Math.abs(e.u) < 1e-9 && Math.abs(m.u) < 1e-9, 'centred');
  // Her face about as wide as the screen there (the storyboard's 03: the face fills the width), never wider than the screen and a half.
  const share = headWidthM(f, 0.06) / (k.fitM * 0.7);
  assert.ok(share > 0.6 && share < 1.5, `head ${share} of the width`);
});

test('the hug: her ear at the screen\'s right (hugEarU), her head hugHeadShare of the width, her face turned OUTWARD — the camera sees her right ear', () => {
  const f = face(), span = 0.06, h = hugFrame(f, span, LENS)!;
  assert.ok(h.spot.u >= 0.3 && h.spot.u <= 0.6 && Math.abs(h.spot.v) <= 0.2, `her ear right of the middle, about three quarters across, mid-height (${JSON.stringify(h.spot)})`);
  assert.equal(h.turn, 1, 'her head turns toward her left: her face points to the screen\'s right (outward), never toward the centre');
  assert.ok(h.offset.across < 0, 'the ear the camera sees is her right ear');
  const share = headWidthM(f, span) / (h.fitM * 0.7);
  assert.ok(Math.abs(share - ARRIVAL_KNOBS.hugHeadShare) < 1e-9 && Math.abs(ARRIVAL_KNOBS.hugHeadShare - 0.4) < 0.1, `head ${share} of the width (the user: about 2/5)`);
  assert.ok(Math.abs(headWidthM(f, span) - FACE_PER_EYE_SPAN * span) < 1e-12, 'the head is her face\'s width (her hair is not counted)');
  // Its spot is a real place in the window at that depth.
  const p = windowPoint(LENS, h.fitM, h.spot), w = inWindow(LENS, p)!;
  assert.ok(Math.abs(w.u - h.spot.u) < 1e-9 && Math.abs(w.v - h.spot.v) < 1e-9);
});

test('which way her face points as the camera sees it: turned toward her left is + (the screen\'s right); the ear offset follows her head', () => {
  // Facing the camera her left eye is at +x (the screen's right). Turned 60° toward her left: her face points to +x.
  const turned = (deg: number) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const at = (x: number, z: number): V3 => ({ x: x * c + z * s, y: 1.4, z: -x * s + z * c - 0.3 }); return { left: at(0.03, 0), right: at(-0.03, 0) }; };
  assert.ok(Math.abs(faceTurnSeen(turned(0))!) < 1e-9);
  assert.ok(Math.abs(faceTurnSeen(turned(60))! - Math.PI / 3) < 1e-9, 'toward her left: +');
  assert.ok(faceTurnSeen(turned(-40))! < 0);
  const ear = headPointNow(turned(70), earOffset(face(), 0.06, -1))!, eyes = turned(70);
  assert.ok(ear.z > (eyes.left.z + eyes.right.z) / 2, 'turned outward, her right ear comes round toward the camera');
});

test('the plan: a hug always turns her face outward (toward her left) and lays her head that way, whatever her own side; a kiss keeps its own side', () => {
  for (const r of [0.1, 0.3, 0.6, 0.9]) {
    const hug = planCloseMoment({ kind: 'hug', after: 'grin', via: 'own', mood: WARM, label: 'close' }, () => r);
    assert.ok(hug.yawRad > 60 * Math.PI / 180 && hug.tiltRad > 0, `hug (${r}): outward ${hug.yawRad} rad, head toward her left`);
    assert.equal(parseCloseMomentPlan(hug)?.yawRad, hug.yawRad, 'crosses IPC');
  }
  const kisses = [0.1, 0.9].map(r => planCloseMoment({ kind: 'kiss', after: 'grin', via: 'own', mood: WARM, label: 'close' }, () => r));
  assert.ok(Math.sign(kisses[0].tiltRad) !== Math.sign(kisses[1].tiltRad), 'a kiss tilts to her own side');
  // The storyboard's rhythm: about 1.7 s from the normal distance to arrived, about 1.2 s back.
  for (const p of kisses) assert.ok(p.approachS >= 1.4 && p.approachS <= 2.2 && p.backS >= 1 && p.backS <= 1.45, `${p.approachS} / ${p.backS}`);
});

test('her own choices: the pucker, the hair tuck and the blush are drawn from her mood (both ways), never fixed in the timeline', () => {
  const r = closeReading(WARM, 'close', NEUTRAL_TEMPERAMENT), seen = new Map<CloseExtra, Set<boolean>>(CLOSE_EXTRAS.map(e => [e, new Set()]));
  for (let i = 0; i < 40; i++) {
    const chosen = chooseCloseExtras('kiss', r, seq([(i * 0.137) % 1, (i * 0.311) % 1, (i * 0.577) % 1]));
    for (const e of CLOSE_EXTRAS) seen.get(e)!.add(chosen.includes(e));
  }
  for (const e of CLOSE_EXTRAS) assert.deepEqual([...seen.get(e)!].sort(), [false, true], `${e}: sometimes, not always`);
  assert.equal(closeExtraChances('hug', r).pucker, 0, 'a hug has no pucker');
  assert.deepEqual(closeExtraChances('shy', r), { pucker: 0, tuck: 0, blush: 0 });
  // The timeline shows a choice only when she made it.
  const base = planCloseMoment({ kind: 'kiss', after: 'shy', via: 'own', mood: WARM, label: 'close', extras: [] }, () => 0.5);
  const chose = planCloseMoment({ kind: 'kiss', after: 'shy', via: 'own', mood: WARM, label: 'close', extras: ['pucker', 'blush', 'tuck'] }, () => 0.5);
  assert.deepEqual(base.extras, []); assert.deepEqual(chose.extras, ['pucker', 'tuck', 'blush']);
  const at = (p: typeof base) => leanChannels(p, p.approachS);
  assert.equal(at(base).pucker, 0, 'no pucker unless she chose it'); assert.equal(at(base).blush, 0, 'no blush unless she chose it');
  assert.ok(at(chose).pucker > 0.99 && at(chose).blush > 0.1, 'her choice shows at the closest');
  assert.ok(at(base).closed > 0.99, 'her eyes close either way (the storyboard\'s main line)');
  const tuckIn = (p: typeof base) => Math.max(...Array.from({ length: 80 }, (_, i) => backChannels(p, at(p), i * backLength(p) / 80).tuck));
  assert.equal(tuckIn(base), 0, 'no hand to her hair unless she chose it'); assert.equal(tuckIn(chose), 1, 'the tuck on the way back');
  assert.equal(tuckTiming(chose, true), null, 'never after a cancel (you pulled her away)');
  // Closed words only, across IPC and from her words; a hug drops a pucker.
  assert.deepEqual(parseCloseExtras(['tuck', 'kiss me', 'pucker', 'tuck']), ['pucker', 'tuck']);
  assert.deepEqual(parseCloseExtras(['pucker', 'blush'], 'hug'), ['blush']);
  assert.equal(parseCloseMomentPlan({ ...chose, extras: ['wave'] })?.extras.length, 0);
  assert.equal(parseCloseMomentPlan({ ...chose, extras: 'pucker' }), null, 'not a list: refused');
  assert.deepEqual(parseCloseMomentPlan({ ...chose, extras: undefined })?.extras, [], 'an older host: none');
});

test('the hold is hers, at least about 1.5 s and at most 12 s (her own length, plan option as recommended); the look keeps its own floor', () => {
  const tense = { warmth: 0, boldness: 0, tension: 1 }, warm = { warmth: 1, boldness: 1, tension: 0 };
  for (const kind of ['kiss', 'hug'] as const) {
    const short = arrivalHoldS(kind, tense, 0), long = arrivalHoldS(kind, warm, 1);
    assert.ok(short >= ARRIVAL_KNOBS.closeHoldMinS && short < ARRIVAL_KNOBS.holdMinS, `${kind}: a tense one can be as short as the storyboard's (${short} s)`);
    assert.ok(long > short && long <= ARRIVAL_KNOBS.holdCapS, `${kind}: ${long} s`);
  }
  assert.ok(Math.abs(ARRIVAL_KNOBS.closeHoldMinS - 1.5) < 0.26 && ARRIVAL_KNOBS.holdCapS === 12);
  assert.ok(arrivalHoldS('look', tense, 0) >= ARRIVAL_KNOBS.holdMinS, 'the look keeps holdMinS');
});

test('smooth: the arrival loop never raises her onto her toes while the intent says her feet are busy (toes 0); with them free it does', () => {
  // Her aim 5 cm under its point: the loop wants her up. A step taken on her toes made her hips drop and jump (0.6–4 cm in a frame, measured).
  const lens = { camera: { x: 0, y: 1.45, z: 0.55 }, axis: { x: 0, y: 0, z: -1 }, heightPerM: 0.44, window: LENS.window };
  const run = (toes: number) => {
    const loop = new FaceArrival();
    let tiptoe = 0;
    for (let i = 0; i < 120; i++) {
      const sense = { eyes: { left: { x: 0.03, y: 1.40, z: 0.25 }, right: { x: -0.03, y: 1.40, z: 0.25 } }, root: { heading: 0 }, offsets: { lateral: 0, forward: 0, up: tiptoe * 0.045 }, tiptoeRise: 0.045 };
      tiptoe = loop.goals({ dropM: 0, distanceM: 0.3, weight: 1, toes }, lens, sense, 1 / 60, { lateral: 0, forward: 0, vertical: 0 })!.tiptoe;
    }
    return tiptoe;
  };
  assert.ok(run(0) < 0.05, `feet busy: down off her toes (${run(0)})`);
  assert.ok(run(1) > 0.5, `feet set: up on her toes (${run(1)})`);
});
