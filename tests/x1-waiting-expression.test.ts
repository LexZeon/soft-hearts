/**
 * X1 "等回复时也有表现" on the real Stage frame loop with the bundled Gene
 * (gene-stage-harness), at 60 and 30 fps. Every scenario runs twice on the
 * same timeline, without and with the waiting channel, and compares:
 *
 * - "Unexpected step" (R29b): a frame's world-space step vs repeating the
 *   previous one, per tracked bone, over the whole wait, the switch to the
 *   second pose and the release. It may not exceed 1.25x the run without the
 *   channel over the same window, floor 0.15 deg at 60 fps (an angular
 *   acceleration: 0.6 deg at 30 fps), as in r29d-continuity.
 * - Reaction: how far the head is from the undisturbed run (she visibly thinks),
 *   that the second pose is not the first one held in place, and that after the
 *   release she is back on the undisturbed run (no residue, no freeze).
 *
 * X1_REPORT=1 prints the numbers recorded in docs/claude/2026-11-02-waiting-expression.md.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion } from 'three';
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/foundation/mood';
import { ReplyThinking, THINKING_POSES, thinkingPlan } from '../src/brain/reply-thinking-stage';
import { between, DERIVED_BONES, surprises, TRACKED_BONES, type BoneSet, type ShownFrame } from './helpers/frame-stats';

const REPORT = !!process.env.X1_REPORT;
const FLOOR = 0.15;
const floorAt = (fps: number) => FLOOR * (60 / fps) ** 2;
const DEG = 180 / Math.PI;
const HEAD = TRACKED_BONES.indexOf('頭');
const f3 = (value: number) => value.toFixed(3);
interface Run { shown: ShownFrame[]; states: { t: number; state: ReturnType<ReplyThinking['getState']> | null }[] }

/** Largest unexpected step per tracked bone in [from, to]. */
function worst(frames: readonly ShownFrame[], from: number, to: number, set: BoneSet = 'world'): number[] {
  return surprises(between(frames, from, to), set).map(values => Math.max(0, ...values));
}
interface Verdict { bone: string; event: number; control: number; limit: number }
function smoothness(pairRun: { control: Run; event: Run }, from: number, to: number, fps: number, set: BoneSet = 'world'): Verdict[] {
  const event = worst(pairRun.event.shown, from, to, set), control = worst(pairRun.control.shown, from, to, set);
  return (set === 'world' ? TRACKED_BONES : DERIVED_BONES).map((bone, i) => ({ bone, event: event[i], control: control[i], limit: Math.max(control[i] * 1.25, floorAt(fps)) }));
}
function assertSmooth(verdicts: Verdict[], label: string): void {
  for (const v of verdicts) assert.ok(v.event <= v.limit, `${label}: ${v.bone} unexpected step ${f3(v.event)} > ${f3(v.limit)} deg (without the channel ${f3(v.control)})`);
}
const top = (verdicts: Verdict[], n = 3) => [...verdicts].sort((a, b) => b.event - a.event).slice(0, n).map(v => `${v.bone} ${f3(v.event)} (w/o ${f3(v.control)})`).join(', ');

/** Head rotation of the event run relative to the control run at time t (the channel's visible contribution). */
function deviation(pairRun: { control: Run; event: Run }, t: number): Quaternion {
  const at = (frames: ShownFrame[]) => frames.reduce((best, frame) => Math.abs(frame.t - t) < Math.abs(best.t - t) ? frame : best);
  const e = at(pairRun.event.shown).world[HEAD], c = at(pairRun.control.shown).world[HEAD];
  return e.clone().multiply(c.clone().invert());
}
const angle = (q: Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w))) * DEG;
/** Largest distance from the undisturbed run over [from, to] (head, degrees). */
function maxDeviation(pairRun: { control: Run; event: Run }, from: number, to: number): number {
  return Math.max(0, ...between(pairRun.event.shown, from, to).map(frame => angle(deviation(pairRun, frame.t))));
}
const stateAt = (run: Run, t: number) => run.states.reduce((best, item) => Math.abs(item.t - t) < Math.abs(best.t - t) ? item : best).state;
/** One-frame cuts the display guard had to absorb in [from, to]. */
const caught = (run: Run, from: number, to: number) => { const frames = between(run.shown, from, to); return frames.length ? frames.at(-1)!.guardJumps - frames[0].guardJumps : 0; };

const T0 = 3;

// ------------------------------------------------------------------ 3. the character decides what, how much and how fast

const card = (weights: Partial<Record<'playful' | 'close' | 'comfortable' | 'cautious', number>>, intensity: Partial<Record<'gaze' | 'posture' | 'expression', number>> = {}) =>
  ({ seedKey: 'gene', weights: { ...DEFAULT_MOOD_PARAMETERS.weights, ...weights }, intensity: { ...DEFAULT_MOOD_PARAMETERS.intensity, ...intensity }, companion: null });

test('X1 plan: playful cards tilt their head and move on sooner; cautious/comfortable cards glance, ponder, slower and lighter', () => {
  const playful = thinkingPlan(card({ playful: 4 }), 'r'), cautious = thinkingPlan(card({ cautious: 4, comfortable: 3 }), 'r'), neutral = thinkingPlan(card({}), 'r');
  if (REPORT) console.log(`plans: playful ${JSON.stringify(playful)}\n cautious ${JSON.stringify(cautious)}\n neutral ${JSON.stringify(neutral)}`);
  assert.equal(playful.first, 'tilt'); assert.equal(playful.second, 'glance');
  assert.equal(cautious.first, 'glance'); assert.equal(cautious.second, 'ponder');
  assert.ok(playful.thresholdS < neutral.thresholdS && neutral.thresholdS < cautious.thresholdS, 'the wait before the second pose follows the character');
  assert.ok(playful.omega > neutral.omega && neutral.omega > cautious.omega, 'quicker / slower');
  assert.ok(playful.head > neutral.head && neutral.head > cautious.head, 'bigger / lighter');
  for (const weights of [{}, { playful: 4 }, { close: 4 }, { comfortable: 4 }, { cautious: 4 }, { playful: 0, close: 0, comfortable: 0, cautious: 0 }])
    for (const key of ['a', 'b', 'c']) { const plan = thinkingPlan(card(weights), key); assert.notEqual(plan.first, plan.second); }
  // The card intensities scale each part; zero shows nothing of it.
  const still = thinkingPlan(card({}, { posture: 0, gaze: 0, expression: 0 }), 'r');
  assert.deepEqual([still.head, still.gaze, still.face], [0, 0, 0]);
  assert.ok(thinkingPlan(card({}, { gaze: 100 }), 'r').gaze > neutral.gaze);
  // How she feels right now nudges it, without any new card field.
  assert.ok(thinkingPlan({ ...card({}), companion: 'playful' }, 'r').lively > neutral.lively);
  assert.ok(thinkingPlan({ ...card({}), companion: 'cautious' }, 'r').lively < neutral.lively);
});

// ------------------------------------------------------------------ 4. the channel itself

test('X1 channel: only a new key starts; null, a released key and hiding never revive a finished wait', () => {
  const t = new ReplyThinking(), owner = {}, gates = { head: true, gaze: true, face: true };
  const input = { owner, character: card({}), gates };
  const run = (seconds: number, g = gates) => { for (let i = 0; i < seconds * 60; i++) t.frame(1 / 60, { ...input, gates: g }); };
  t.set('a'); run(1);
  assert.equal(t.getState().waiting, true); assert.ok(Math.abs(t.out.gazeBlend) > 0.5);
  t.set('a'); assert.equal(t.getState().waitedS, 1, 'the same key does not restart the wait');
  t.set(null); run(0.05);
  const shown = t.out.gazeBlend; assert.ok(shown > 0.5, 'a release starts from what is shown');
  run(3); assert.equal(t.out.gazeBlend, 0); assert.equal(t.active, false, 'settled to exact zeros');
  t.set('a'); run(0.5); assert.equal(t.getState().waiting, false, 'a late repeat of a finished reply stays finished');
  t.set('b'); run(0.5); assert.equal(t.getState().waiting, true);
  t.hide(); assert.equal(t.out.gazeBlend, 0, 'hidden: nothing is shown');
  assert.equal(t.getState().waiting, true, 'hiding keeps the waiting key (the reply lifecycle ends it)');
  run(3, { head: false, gaze: false, face: false });
  assert.equal(t.out.gazeBlend, 0, 'closed gates show nothing');
  run(1); assert.ok(t.out.gazeBlend > 0.5, 'open gates bring it back');
  t.frame(1 / 60, { ...input, owner: {} });
  assert.ok(t.out.gazeBlend < 0.01, `a new model starts from zero, not from the old model's pose (${t.out.gazeBlend})`);
  t.set(null);
  const empty = new ReplyThinking(); empty.set('x');
  for (let i = 0; i < 30; i++) empty.frame(1 / 60, { owner, character: null, gates });
  assert.equal(empty.out.gazeBlend, 0, 'no mood view, no plan: nothing is shown');
  assert.deepEqual(Object.keys(THINKING_POSES).sort(), ['glance', 'ponder', 'tilt']);
});

test('X1 channel: the plan reads existing card/mood fields only', () => {
  const snapshot = getMoodSnapshot(createMoodState(0));
  assert.deepEqual(Object.keys(DEFAULT_MOOD_PARAMETERS.weights).sort(), ['cautious', 'close', 'comfortable', 'playful']);
  assert.deepEqual(Object.keys(snapshot.intensity).sort(), ['expression', 'gaze', 'playful', 'posture', 'text']);
});
