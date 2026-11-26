/**
 * I-078 第 2、3 步 on the stage (docs/claude/2026-11-11-i078-sleep-step2-3.md).
 *
 * The real Stage frame loop on the bundled Gene (gene-stage-harness) at 60 and 30 fps, lying (full-body camera) and at the desk
 * (the harness camera): touched in her sleep (a short overlay on the same pose, the lids flutter, back to the same pose), talked to
 * (half awake: the head lifts and the eyes open a little more with each message), woken by "醒醒", woken by touches adding up.
 * The R29 measures as step 1: the display guard catches nothing; the unexpected step stays under 0.15° at 60 fps and 0.6° at 30 fps.
 * The 睡相 trait (step 3): the middle is step 1 exactly (same seed, same history), calm and restless change how often and how
 * big, restless adds turning over, hugging the pillow and an arm out, all smoothly; the less-mechanical numbers (spread, no
 * back-to-back repeats, no gap piling on one second). I078_REPORT=1 prints the numbers recorded in the docs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Quaternion } from 'three';
import { createFatigue, fatigueSnapshot, type FatiguePhase } from '../shared/mood/fatigue';
import { asleepWeights, habitGap, NEUTRAL_HORMONES, sleepHabitScale } from '../shared/behaviors/sleep-body/schedule';
import { FatiguePresentation } from '../src/stage/fatigue-presentation';

const REPORT = process.env.I078_REPORT === '1';
const DEG = 180 / Math.PI;
const LEGS = ['左足', '左ひざ', '右足', '右ひざ', '左手首', '右手首'] as const;
const HEAD = ['頭', '上半身2'] as const;
const max = (values: readonly number[]) => values.reduce((m, v) => Math.max(m, v), 0);
const view = (phase: FatiguePhase, W = 0, A = 0.9, F = 0.8) =>
  ({ ...fatigueSnapshot(createFatigue({ monotonicMs: 0, localMinute: 900 }, { A, F, W, phase })), sleepEntryReady: true });
const floorFor = (fps: number) => fps === 60 ? 0.15 : 0.6;

test('I-078 step 2: the lids flutter on a new touch in her sleep and settle back; the same touch held is one flutter', () => {
  const lids = new FatiguePresentation(), gates = (contact: boolean) => ({ verifiedGene: true, expressions: true, faceBlocked: false, contact });
  let shown: number[] = [];
  for (let i = 0; i < 120; i++) shown.push(lids.frame(view('asleep'), 1 / 60, gates(false)).eyelids);
  const rest = shown.at(-1)!; shown = [];
  for (let i = 0; i < 150; i++) shown.push(lids.frame(view('asleep'), 1 / 60, gates(true)).eyelids);
  const dips = shown.slice(1).filter((v, i) => v < shown[i] - 1e-4 && shown[i] >= shown[i + 1 > shown.length - 1 ? i : i + 1]).length;
  assert.ok(Math.min(...shown) < rest - 0.05, `the lids open a little (${rest.toFixed(3)} → ${Math.min(...shown).toFixed(3)})`);
  assert.ok(dips > 0);
  const end = shown.at(-1)!;
  assert.ok(Math.abs(end - (rest - 0.035)) < 0.01, `held: only the old small touch opening remains (${end.toFixed(3)})`);
  // Steps stay small (no snap): the largest frame-to-frame change.
  const step = Math.max(...shown.slice(1).map((v, i) => Math.abs(v - shown[i])));
  assert.ok(step < 0.03, `largest lid step ${step.toFixed(3)}`);
});

// ------------------------------------------------------------------ step 3: 睡相

test('I-078 睡相 scale: the card value reads as −1…1, the middle (or nothing) is 0, the gap factor is exactly 1 there', () => {
  assert.equal(sleepHabitScale(undefined), 0); assert.equal(sleepHabitScale(50), 0); assert.equal(sleepHabitScale('80'), 0);
  assert.equal(sleepHabitScale(0), -1); assert.equal(sleepHabitScale(100), 1); assert.equal(sleepHabitScale(75), 0.5); assert.equal(sleepHabitScale(500), 1);
  assert.equal(habitGap(0), 1);
  assert.ok(habitGap(1) < 1 && habitGap(-1) > 1);
  const middle = asleepWeights(NEUTRAL_HORMONES, 0);
  assert.equal(middle.turn, 0); assert.equal(middle.hug, 0); assert.equal(middle['arm-out'], 0);
  const close = asleepWeights({ ...NEUTRAL_HORMONES, O: 0.8 }, 1), plain = asleepWeights(NEUTRAL_HORMONES, 1);
  assert.ok(close.hug > plain.hug, 'O high hugs the pillow more');
  assert.ok(asleepWeights({ ...NEUTRAL_HORMONES, C: 0.8 }, 1).turn > plain.turn, 'C high turns over more');
});

function cameraAt(height: number) {
  const camera = new PerspectiveCamera(32, 400 / 560, 0.1, 3000);
  camera.position.set(0, 0.45 * height, 46); camera.lookAt(0, 0.45 * height, 0); camera.updateMatrixWorld(true);
  return { camera, width: 400, height: 560 };
}
function restoringPort() {
  const saved = new Map<{ quaternion: Quaternion; position: any }, { q: Quaternion; p: any }>();
  return {
    remember(bone: { quaternion: Quaternion; position: any }) { if (!saved.has(bone)) saved.set(bone, { q: bone.quaternion.clone(), p: bone.position.clone() }); },
    restore() { for (const [bone, v] of saved) { bone.quaternion.copy(v.q); bone.position.copy(v.p); } saved.clear(); },
  };
}
