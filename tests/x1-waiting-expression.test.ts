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
import { DEFAULT_MOOD_PARAMETERS, createMoodState, getMoodSnapshot } from '../shared/mood';
import { ReplyThinking, THINKING_POSES, thinkingPlan } from '../src/stage/reply-thinking';
import { between, DERIVED_BONES, geneStage, patContact, pointAtScalp, surprises, TRACKED_BONES, type BoneSet, type GeneStage, type GeneStageOptions, type ShownFrame } from './helpers/gene-stage-harness';
import { EMPTY_CONTACT } from '../src/stage/mood-feedback';

const REPORT = !!process.env.X1_REPORT;
const FLOOR = 0.15;
const floorAt = (fps: number) => FLOOR * (60 / fps) ** 2;
const DEG = 180 / Math.PI;
const HEAD = TRACKED_BONES.indexOf('頭');
const f3 = (value: number) => value.toFixed(3);

interface Step { at: number; run(h: GeneStage): void | Promise<void> }
interface Run { shown: ShownFrame[]; states: { t: number; state: ReturnType<ReplyThinking['getState']> | null }[] }

/** Same timeline twice: without the steps (control: only `both` steps), and with them. */
async function pair(fps: number, seconds: number, steps: Step[], both: Step[] = [], options: GeneStageOptions = {}): Promise<{ control: Run; event: Run }> {
  const runs: Run[] = [];
  for (const withSteps of [false, true]) {
    const h = await geneStage({ fps, ...options });
    try {
      const queue = [...both, ...(withSteps ? steps : [])].sort((a, b) => a.at - b.at);
      const states: Run['states'] = [];
      for (let i = 0, next = 0; i < Math.round(seconds * fps); i++) {
        while (next < queue.length && h.time() >= queue[next].at - 1e-9) await queue[next++].run(h);
        h.tick();
        states.push({ t: h.time(), state: h.stage.replyThinking?.getState() ?? null });
      }
      runs.push({ shown: h.shown, states });
    } finally { h.close(); }
  }
  return { control: runs[0], event: runs[1] };
}

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
const send = (key: string, at = T0): Step => ({ at, run: h => h.stage.setReplyThinking(key) });
const firstWord = (at: number): Step => ({ at, run: h => h.stage.setReplyThinking(null) });

// ------------------------------------------------------------------ 1. the whole wait: reaction, second pose, first word

for (const fps of [60, 30]) {
  test(`X1: send → immediate reaction → a different "still thinking" pose → the first word hands back smoothly (${fps} fps)`, async () => {
    const release = T0 + 4.5;
    const p = await pair(fps, release + 2.5, [send('reply-1'), firstWord(release)]);
    const plan = stateAt(p.event, T0 + 0.5)!.plan!;
    const whole = smoothness(p, T0 - 0.1, release + 2.5, fps), derived = smoothness(p, T0 - 0.1, release + 2.5, fps, 'derived');
    const early = angle(deviation(p, T0 + 0.25)), reaction = angle(deviation(p, T0 + 1.2));
    const first = deviation(p, plan.thresholdS + T0 - 0.05), second = deviation(p, release - 0.05);
    const moved = angle(second.clone().multiply(first.clone().invert()));
    const residue = maxDeviation(p, release + 2, release + 2.5);
    if (REPORT) console.log(`[${fps} fps] wait ${plan.first}→${plan.second} at ${plan.thresholdS.toFixed(2)} s: head off the undisturbed run ${early.toFixed(2)}° at +0.25 s, ${reaction.toFixed(2)}° at +1.2 s; second pose ${moved.toFixed(2)}° from the first; residue 2 s after the first word ${residue.toFixed(3)}° | worst steps ${top(whole)} | derived ${top(derived, 1)} | guard caught ${caught(p.event, T0 - 0.1, release + 2.5)} (w/o ${caught(p.control, T0 - 0.1, release + 2.5)})`);
    assert.notEqual(plan.first, plan.second, 'the second pose is another motion');
    assert.ok(early > 0.3, `she starts reacting at once (${early.toFixed(2)}°)`);
    assert.ok(reaction > 2, `a visible reaction (${reaction.toFixed(2)}°)`);
    assert.ok(moved > 2, `the second pose moves on (${moved.toFixed(2)}°)`);
    assert.ok(residue < 0.05, `back on the undisturbed run after the release (${residue.toFixed(3)}°)`);
    assertSmooth(whole, `wait ${fps}`);
    assertSmooth(derived, `wait ${fps} derived`);
    assert.equal(caught(p.event, T0 - 0.1, release + 2.5), caught(p.control, T0 - 0.1, release + 2.5), 'nothing new for the display guard to catch');
    assert.equal(stateAt(p.event, release + 2.4)?.waiting, false);
  });

  test(`X1: a follow-up sent while the last reply's chat gesture still plays: the gesture's arms and her thinking head compose (${fps} fps)`, async () => {
    const gesture: Step = { at: T0 - 0.5, run: async h => {
      const cue = { id: 'x1-gesture', at: Date.now(), expiresAt: Date.now() + 60_000, intent: 'explain' as const, strength: 0.55, reason: 'test' };
      h.stage.moodView = { ...h.stage.moodView, gesture: cue };
      await h.stage.playChatGesture(cue, h.stage.moodView.token);
      assert.equal(h.stage.chatGesturePlayer.getState().active, true, `the gesture plays: ${h.stage.chatGestureError}`);
    } };
    const p = await pair(fps, T0 + 4, [send('reply-2'), firstWord(T0 + 2)], [gesture], { chatGesture: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2' } });
    const v = smoothness(p, T0 - 0.1, T0 + 4, fps), d = smoothness(p, T0 - 0.1, T0 + 4, fps, 'derived');
    if (REPORT) console.log(`[${fps} fps] thinking over a playing chat gesture: worst steps ${top(v)} | derived ${top(d, 1)} | guard caught ${caught(p.event, T0 - 0.1, T0 + 4)} (w/o ${caught(p.control, T0 - 0.1, T0 + 4)})`);
    assert.equal(stateAt(p.event, T0 + 1)!.gates.head, true, 'a chat gesture owns the arms, not the head');
    assertSmooth(v, `gesture ${fps}`); assertSmooth(d, `gesture ${fps} derived`);
    assert.equal(caught(p.event, T0 - 0.1, T0 + 4), caught(p.control, T0 - 0.1, T0 + 4));
  });
}

// ------------------------------------------------------------------ 2. every way the wait can end clears it smoothly

for (const fps of [60, 30]) {
  test(`X1: a stop while she is still turning to think releases from the moving pose, no stop dead (${fps} fps)`, async () => {
    const p = await pair(fps, T0 + 3, [send('reply-1'), firstWord(T0 + 0.35)]);
    const v = smoothness(p, T0 - 0.1, T0 + 3, fps), residue = maxDeviation(p, T0 + 2.5, T0 + 3);
    if (REPORT) console.log(`[${fps} fps] stop at +0.35 s: worst steps ${top(v)}; residue ${residue.toFixed(3)}°`);
    assertSmooth(v, `stop mid-rise ${fps}`);
    assert.ok(residue < 0.05);
  });

  test(`X1: switching character while she thinks releases the thinking pose from what is shown (${fps} fps)`, async () => {
    const other: Step = { at: T0 + 1.2, run: h => {
      const view = h.stage.moodView;
      h.stage.setMood({ ...view, characterId: 'other', token: 'other_token', snapshot: { ...view.snapshot } });
    } };
    // Both runs switch character at the same moment; only the event run was thinking.
    const p = await pair(fps, T0 + 3.5, [send('reply-1')], [other]);
    const v = smoothness(p, T0 + 1.1, T0 + 3.5, fps), state = stateAt(p.event, T0 + 1.3)!;
    if (REPORT) console.log(`[${fps} fps] character switch at +1.2 s: worst steps ${top(v)}`);
    assert.equal(state.waiting, false, 'the switch ends the wait');
    assertSmooth(v, `character switch ${fps}`);
  });

  test(`X1 counterfactual: cutting the thinking pose in one frame is caught by the same measure (${fps} fps)`, async () => {
    const cut: Step = { at: T0 + 1.5, run: h => { h.stage.replyThinking.set(null); h.stage.replyThinking.hide(); } };
    const p = await pair(fps, T0 + 2.5, [send('reply-1'), cut]);
    const v = smoothness(p, T0 + 1.4, T0 + 2.5, fps);
    if (REPORT) console.log(`[${fps} fps] one-frame cut at +1.5 s (what a release without a hand-off would show): worst steps ${top(v)}`);
    assert.ok(v.some(item => item.event > item.limit), 'a one-frame cut exceeds the limit');
  });
}

test('X1: a late repeat of a finished reply never restarts it; a new message starts fresh from the releasing pose (60 fps)', async () => {
  const late: Step = { at: T0 + 1.4, run: h => h.stage.setReplyThinking('reply-1') };
  const p = await pair(60, T0 + 5.5, [send('reply-1'), firstWord(T0 + 1), late, send('reply-2', T0 + 1.6), firstWord(T0 + 3)]);
  const v = smoothness(p, T0 - 0.1, T0 + 5.5, 60);
  if (REPORT) console.log(`[60 fps] release, late repeat, a new message while releasing: worst steps ${top(v)}`);
  assert.equal(stateAt(p.event, T0 + 1.5)!.waiting, false, 'the late repeat does not revive the finished reply');
  assert.equal(stateAt(p.event, T0 + 2)!.waiting, true, 'the next reply thinks again');
  assertSmooth(v, 'late/resend');
  assert.ok(maxDeviation(p, T0 + 5, T0 + 5.5) < 0.05);
});

test('X1: a pat and her own speech take the head; thinking yields and comes back without a jump (60 fps)', async () => {
  const pat: Step = { at: T0 + 1, run: h => pointAtScalp(h) };
  const steps: Step[] = [];
  for (let t = T0 + 1; t < T0 + 2.2; t += 1 / 60) { const at = t; steps.push({ at, run: h => h.stage.setMoodContact(patContact(at)) }); }
  const lift: Step = { at: T0 + 2.2, run: h => h.stage.setMoodContact({ ...EMPTY_CONTACT }) };
  const p = await pair(60, T0 + 4.5, [send('reply-1')], [pat, ...steps, lift]);
  const v = smoothness(p, T0 + 0.9, T0 + 4.5, 60);
  if (REPORT) console.log(`[60 fps] pat while thinking: worst steps ${top(v)}`);
  assert.equal(stateAt(p.event, T0 + 2)!.gates.head, false, 'the pat owns the head');
  assert.equal(stateAt(p.event, T0 + 3.5)!.gates.head, true, 'thinking returns after the hand leaves');
  assertSmooth(v, 'pat');
  const speak: Step = { at: T0 + 1.5, run: h => h.stage.setSpeaking(true) };
  const s = await pair(60, T0 + 3.5, [send('reply-2')], [speak]);
  const vs = smoothness(s, T0 + 1.4, T0 + 3.5, 60);
  if (REPORT) console.log(`[60 fps] she starts speaking while thinking: worst steps ${top(vs)}`);
  assert.equal(stateAt(s.event, T0 + 1.6)!.gates.gaze, false);
  assertSmooth(vs, 'speech');
});

test('X1: with the music dance on, the head stays the dance\'s and only the gaze thinks (60 fps)', async () => {
  const p = await pair(60, T0 + 4, [send('reply-1'), firstWord(T0 + 2.5)], [], { music: true });
  const v = smoothness(p, T0 - 0.1, T0 + 4, 60), state = stateAt(p.event, T0 + 1)!;
  if (REPORT) console.log(`[60 fps] music: worst steps ${top(v)}; thinking head ${JSON.stringify([state.output.headX, state.output.headZ])}, gaze ${state.output.gazeBlend}`);
  assert.equal(state.gates.head, false);
  assert.equal(state.output.headZ, 0);
  assert.ok(state.output.gazeBlend > 0.5);
  assertSmooth(v, 'music');
});

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

test('X1: a playful card on the real loop tilts at once and changes pose sooner, still smooth (60 fps)', async () => {
  const playful: Step = { at: 0, run: h => {
    const view = h.stage.moodView;
    h.stage.setMood({ ...view, parameters: { ...view.parameters, weights: { ...view.parameters.weights, playful: 4 } } });
  } };
  const p = await pair(60, T0 + 4.5, [send('reply-1'), firstWord(T0 + 3)], [playful]);
  const plan = stateAt(p.event, T0 + 0.5)!.plan!, v = smoothness(p, T0 - 0.1, T0 + 4.5, 60);
  const roll = stateAt(p.event, T0 + 1.2)!.output.headZ;
  if (REPORT) console.log(`[60 fps] playful: ${plan.first}→${plan.second} at ${plan.thresholdS.toFixed(2)} s, roll ${(roll * DEG).toFixed(2)}° at +1.2 s; worst steps ${top(v)}`);
  assert.equal(plan.first, 'tilt');
  assert.ok(Math.abs(roll) * DEG > 4, 'a clear head tilt');
  assert.equal(stateAt(p.event, T0 + plan.thresholdS + 0.2)!.pose, 'glance');
  assertSmooth(v, 'playful');
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
