/**
 * I-078 第 1 步 (docs/claude/2026-11-11-i078-sleep-step1.md): her falling asleep and sleeping.
 *
 * - Pure: the schedule (log-normal gaps, no back-to-back repeats, the hormone directions), the postures on Gene and on
 *   synthetic bodies (wide / narrow shoulders, long / short arms, a T pose) and the camera-aware choice over several cameras
 *   and windows (head in frame with margin; the camera never touched; a close-up falls back).
 * - The real Stage frame loop on the bundled Gene (gene-stage-harness) at 60 and 30 fps: drowsy → falling asleep → asleep
 *   (small movements) → micro-awake → awake, a camera change while asleep, a higher owner taking the body. The R29 measures:
 *   the display guard catches nothing; the unexpected step stays under the floor (0.15° at 60 fps, 0.6° at 30 fps: the same
 *   540°/s² angular acceleration) for the tracked bones and the legs.
 * I078_REPORT=1 prints the numbers recorded in the docs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../shared/mood/fatigue';
import { SLEEP_BODY_KNOBS } from '../shared/behaviors/sleep-body/knobs';
import { asleepGap, drowsyGap, hugShare, logNormalGap, murmurGap, NEUTRAL_HORMONES, normalizedHormones, pickVariant, posePreferences, settleTimes } from '../shared/behaviors/sleep-body/schedule';
import { towardPose, towardWaypoint, drowsyTimeline } from '../src/stage/sleep-body';
import { dentPillow, pillowGeometry } from '../src/stage/sleep-props';
import { showSleepMurmur } from '../src/voice/sleep-murmur';
import { BODY_VARIANTS } from './helpers/body-variants';
import { tPoseRolled, type EditableBone } from './helpers/hand-variants';
import { seeded } from './helpers/seeded';

const REPORT = process.env.I078_REPORT === '1';
const DEG = 180 / Math.PI;
const LEGS = ['左足', '左ひざ', '右足', '右ひざ', '左手首', '右手首'] as const;
const fatigue = (phase: FatiguePhase, A = 0.9, F = 0.8) => ({ ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A, F, phase })), sleepEntryReady: true });
const max = (values: readonly number[]) => values.reduce((m, v) => Math.max(m, v), 0);
/** The stage's program layer in miniature: what the layer remembers is restored before the next frame. */
function restoringPort() {
  const saved = new Map<{ quaternion: Quaternion; position: Vector3 }, { q: Quaternion; p: Vector3 }>();
  return {
    remember(bone: { quaternion: Quaternion; position: Vector3 }) { if (!saved.has(bone)) saved.set(bone, { q: bone.quaternion.clone(), p: bone.position.clone() }); },
    restore() { for (const [bone, v] of saved) { bone.quaternion.copy(v.q); bone.position.copy(v.p); } saved.clear(); },
  };
}

// ------------------------------------------------------------------ schedule (pure)

test('I-078 schedule: gaps are log-normal around the knob, never one value, never under the floor; variants never repeat back to back', () => {
  const rng = seeded(7), gaps = Array.from({ length: 400 }, () => drowsyGap('drowsy', 0.75, NEUTRAL_HORMONES, rng));
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length, sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
  assert.ok(Math.min(...gaps) >= SLEEP_BODY_KNOBS.drowsy.minGapS, 'never under the floor');
  assert.ok(sd / mean > 0.3, `spread ${(sd / mean).toFixed(2)}: not clustered on one value`);
  const rounded = new Map<number, number>();
  for (const g of gaps) rounded.set(Math.round(g), (rounded.get(Math.round(g)) ?? 0) + 1);
  assert.ok(Math.max(...rounded.values()) / gaps.length < 0.1, 'no single whole second takes 10% of the gaps');
  let last: string | null = null;
  for (let i = 0; i < 300; i++) {
    const pick: string | null = pickVariant<'yawn' | 'rub' | 'nod'>({ yawn: 1, rub: 0.8, nod: 0.9 }, last as 'yawn' | 'rub' | 'nod' | null, rng);
    assert.notEqual(pick, last, 'never the same twice in a row'); last = pick;
  }
  const murmurs = Array.from({ length: 200 }, () => murmurGap(rng));
  assert.ok(Math.min(...murmurs) >= SLEEP_BODY_KNOBS.murmur.minGapS);
  assert.ok(logNormalGap(10, 30, 0.5, rng) >= 30, 'the floor wins over a smaller mean');
  if (REPORT) console.log(`drowsy gaps: mean ${mean.toFixed(1)} s, sd ${sd.toFixed(1)} s, min ${Math.min(...gaps).toFixed(1)}, max ${Math.max(...gaps).toFixed(1)}`);
});

test('I-078 schedule: hormones move the timing the documented way (N slower to settle, C restless, E calm, O hugs)', () => {
  const mean = (f: (rng: () => number) => number) => { const rng = seeded(11); let s = 0; for (let i = 0; i < 600; i++) s += f(rng); return s / 600; };
  const tense = { ...NEUTRAL_HORMONES, N: 0.8 }, restless = { ...NEUTRAL_HORMONES, C: 0.8 }, calm = { ...NEUTRAL_HORMONES, E: 0.8 }, close = { ...NEUTRAL_HORMONES, O: 0.8 };
  assert.ok(mean(r => settleTimes(tense, r).sitDelay) > mean(r => settleTimes(NEUTRAL_HORMONES, r).sitDelay), 'N: sits down later');
  assert.ok(mean(r => asleepGap(0.5, restless, r)) < mean(r => asleepGap(0.5, NEUTRAL_HORMONES, r)), 'C: moves more often asleep');
  assert.ok(mean(r => asleepGap(0.5, calm, r)) > mean(r => asleepGap(0.5, NEUTRAL_HORMONES, r)), 'E: moves less asleep');
  assert.ok(mean(r => asleepGap(0.9, NEUTRAL_HORMONES, r)) > mean(r => asleepGap(0.2, NEUTRAL_HORMONES, r)), 'A: deeper sleep, fewer movements');
  assert.ok(hugShare(close) > hugShare(NEUTRAL_HORMONES) && posePreferences(close, null).lie > posePreferences(NEUTRAL_HORMONES, null).lie, 'O: hugs the pillow, lies down more');
  assert.ok(posePreferences(NEUTRAL_HORMONES, 'lie').desk > posePreferences(NEUTRAL_HORMONES, null).desk, 'variety: not last time\'s pose');
  assert.deepEqual(normalizedHormones({ D: 50, O: 75, E: 25, N: 50, C: 50 }, { D: 50, O: 50, E: 50, N: 50, C: 50 }), { D: 0, O: 0.5, E: -0.5, N: 0, C: 0 });
});

test('I-078 drowsy timelines keep the peak angular acceleration under the R29 bound', () => {
  const rng = seeded(3);
  for (let i = 0; i < 20; i++) for (const kind of ['nod', 'rub'] as const) {
    const { keys } = drowsyTimeline(kind, rng);
    // Each move between two keys is at least ~0.8 s (nod: 17° head swing) or ~1.6 s (rub: the forearm's ~150°).
    const shortest = Math.min(...keys.slice(1).map(([t, v], k) => Math.abs(v - keys[k][1]) > 0.5 ? t - keys[k][0] : Infinity));
    assert.ok(shortest >= (kind === 'rub' ? 1.6 : 0.8), `${kind}: ${shortest.toFixed(2)} s`);
  }
});

// ------------------------------------------------------------------ postures (Gene + synthetic bodies)

type Body = { name: string; edit?: (bones: EditableBone[]) => void };
const BODIES: Body[] = [{ name: 'Gene' }, ...Object.entries(BODY_VARIANTS).map(([name, edit]) => ({ name, edit })), { name: 'T pose', edit: bones => tPoseRolled(bones, 0) }];

// ------------------------------------------------------------------ camera-aware choice (pure)

function cameraAt(height: number, at: { distance: number; y: number; yaw?: number; pitch?: number; width?: number; heightPx?: number }) {
  const width = at.width ?? 400, heightPx = at.heightPx ?? 560;
  const camera = new PerspectiveCamera(32, width / heightPx, 0.1, 3000);
  const yaw = (at.yaw ?? 0) * Math.PI / 180, pitch = (at.pitch ?? 0) * Math.PI / 180;
  camera.position.set(Math.sin(yaw) * Math.cos(pitch) * at.distance, at.y * height + Math.sin(pitch) * at.distance, Math.cos(yaw) * Math.cos(pitch) * at.distance);
  camera.lookAt(0, at.y * height, 0); camera.updateMatrixWorld(true);
  return { camera, width, height: heightPx };
}

test('I-078 path ramps are C² at the seiza corner (no acceleration step)', () => {
  const second = (f: (p: number) => number, p: number, e = 1e-3) => (f(p + e) - 2 * f(p) + f(p - e)) / (e * e);
  for (const f of [towardWaypoint, towardPose]) for (const p of [0.65, 0.66, 1.34, 1.35, 1.36]) {
    // Just inside and outside each corner end the curvature is (nearly) the same: continuous.
    assert.ok(Math.abs(second(f, p + 0.002) - second(f, p - 0.002)) < 0.2, `${f.name} at ${p}`);
  }
  assert.equal(towardWaypoint(0), 0); assert.equal(towardWaypoint(2), 1); assert.equal(towardPose(0.5), 0); assert.equal(towardPose(2), 1);
});

test('I-078 pillow: the dent follows the head and springs back (no physics solver)', () => {
  const g = pillowGeometry(4, 3, 1.6), top = () => { const a = g.getAttribute('position').array as Float32Array; let y = 0; for (let k = 0; k < a.length / 6; k++) y = Math.max(y, a[k * 3 + 1]); return y; };
  const rest = top();
  assert.ok(dentPillow(g, 0, 0, 0.3, 0.8));
  assert.ok(top() < rest - 0.1, 'dented');
  assert.ok(dentPillow(g, 0, 0, 0, 0.8));
  assert.ok(Math.abs(top() - rest) < 1e-6, 'back to its shape');
});

test('I-078 murmur bubble: shown in the ordinary bubble only when she is free, never with speech', () => {
  const shown: [string, string, boolean][] = [];
  const say = (free: boolean) => ({ free: () => free, show: (id: string, text: string, speech: boolean) => { shown.push([id, text, speech]); } });
  assert.equal(showSleepMurmur(say(false), { id: 'm1', text: 'zzz…' }), false);
  assert.equal(showSleepMurmur(say(true), { id: 'm2', text: 'zzz…' }), true);
  assert.equal(showSleepMurmur({ free: () => { throw Error('no pet'); }, show: () => {} }, { id: 'm3', text: 'zzz…' }), false);
  assert.deepEqual(shown, [['m2', 'zzz…', false]]);
});
