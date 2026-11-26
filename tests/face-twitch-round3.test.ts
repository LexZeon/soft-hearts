/**
 * 2026-11-10 嘴、脸和头抽搐，第三轮 (docs/claude/2026-11-10-face-head-twitch.md "第三轮"). In the user's session the mood's
 * primary label went close → happy on a chat lift and back to close / calm ~30–35 s later, again and again, often while
 * nobody talked ("有时候不说话也抽"). The mood face picked a whole row of targets by the label (continuous-expression.ts TABLE;
 * mood-feedback.ts's pleasant / serious / companion terms), so every target stepped on one frame and the first-order
 * followers started at full speed: on Gene the smiling eyes (笑い) dropped at 0.91/s from one frame to the next (mood
 * feedback, τ 0.17 s), the mouth smile (にっこり) at 0.35–0.55/s, the blush and the head's tiny pitch with them; idle, those
 * channels move at most 0.008/s.
 *
 * Now the labels drift (mood-face/label-blend.ts, MOOD_FACE_KNOBS.driftSeconds): every label-decided target goes from the old
 * label's value to the new one's along a smootherstep, so it starts and ends at zero speed and the followers' output starts
 * moving gently. What these tests hold:
 *  - LabelBlend alone: the first label at once; weights sum to 1; zero speed at both ends; a change mid-drift starts again from
 *    what is shown (no jump); 0 s = at once (the old behaviour);
 *  - one label at weight 1 gives exactly the old targets (frames bit-identical while the mood stays);
 *  - mood feedback: the smile drifts on a label change; a reaction (acknowledgement) is as quick as before; a serious label
 *    still clears an inherited smile at once (kept on purpose);
 *  - Gene, real frame loop (gene-stage-harness), her life on, pointer moving, nobody talking, 60 and 30 fps on a 60 Hz screen:
 *    happy → calm → happy → close → happy. Per displayed channel the largest frame-to-frame change of speed stays far below
 *    the old one, the face still arrives at the new mood within ~2.5 s, the head's mood pitch never steps, the guard has 0.
 * FACE_TWITCH_REPORT=1 prints the numbers in the doc.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LabelBlend } from '../src/mood/mood-face/label-blend';
import { MOOD_FACE_KNOBS } from '../src/mood/mood-face/knobs';
import { emptyExpression, expressionTargets, EXPRESSION_CHANNELS } from '../src/stage/continuous-expression';
import { EMPTY_CONTACT, MoodFeedback, type StageMoodState } from '../src/mood/mood-feedback';
import { ANCHOR_LEVELS } from '../src/mood/mood-face/anchors';

/** I-073: a label comes with its numbers (the face follows the numbers; a switch is the numbers moving, as a mood event does). */
const numbers = (label: string) => ({ D: 50, O: 50, E: 50, N: 50, C: 50, ...ANCHOR_LEVELS[label as keyof typeof ANCHOR_LEVELS].levels });

const REPORT = process.env.FACE_TWITCH_REPORT === '1';
const DEG = 180 / Math.PI;
const T = MOOD_FACE_KNOBS.driftSeconds;

test('LabelBlend: first label at once, weights sum to 1, zero speed at both ends, no jump when the label changes mid-drift', () => {
  assert.ok(T >= 0.8 && T <= 2, `drift ${T} s`);
  const blend = new LabelBlend(), dt = 1 / 60;
  const weight = (label: string) => blend.out.find(entry => entry.label === label)?.weight ?? 0;
  blend.frame(dt, 'happy', T);
  assert.deepEqual(blend.out.map(e => ({ ...e })), [{ label: 'happy', weight: 1 }], 'nothing to drift from: at once');
  let last = 0, peak = 0, frames = 0;
  const shown: number[] = [];
  while (weight('calm') < 1) {
    blend.frame(dt, 'calm', T); frames++;
    const sum = blend.out.reduce((total, e) => total + e.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, 'weights sum to 1');
    peak = Math.max(peak, weight('calm') - last); last = weight('calm'); shown.push(last);
    assert.ok(frames < 1000);
  }
  assert.ok(Math.abs(frames * dt - T) <= dt + 1e-9, `arrives after ${T} s (${frames} frames)`);
  assert.ok(peak <= 1.875 * dt / T + 1e-9, 'smootherstep: never faster than its peak speed');
  assert.ok(shown[0] < 1e-4 && 1 - shown.at(-2)! < 1e-4, 'starts and ends at (almost) zero speed');
  assert.deepEqual(blend.out.map(e => e.label), ['calm'], 'only the new label once it arrived');
  // A change in the middle starts again from what is shown: every label's weight is continuous.
  for (let i = 0; i < 30; i++) blend.frame(dt, 'close', T);
  const before = new Map(blend.out.map(e => [e.label, e.weight]));
  blend.frame(dt, 'happy', T);
  for (const label of ['calm', 'close', 'happy']) assert.ok(Math.abs(weight(label) - (before.get(label) ?? 0)) < 1e-3, `${label} does not jump`);
  for (let i = 0; i < 200; i++) blend.frame(dt, 'happy', T);
  assert.equal(weight('happy'), 1);
  // Labels changing faster than the drift: still weights that sum to 1, the current one among them.
  for (const label of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) { blend.frame(dt, label, T); blend.frame(dt, label, T); }
  assert.ok(Math.abs(blend.out.reduce((total, e) => total + e.weight, 0) - 1) < 1e-12 && blend.out.length <= 5 && weight('g') > 0);
  assert.equal(blend.sum(label => label === 'g' ? 1 : 0), weight('g'));
  // 0 s: at once (the old behaviour); reset: the next label is taken at once.
  blend.frame(dt, 'calm', 0);
  assert.deepEqual(blend.out.map(e => ({ ...e })), [{ label: 'calm', weight: 1 }]);
  blend.reset(); blend.frame(dt, 'sad', T);
  assert.deepEqual(blend.out.map(e => ({ ...e })), [{ label: 'sad', weight: 1 }]);
});

test('continuous expression: one label at weight 1 gives exactly the old targets; halfway is between the two rows', () => {
  const wobble = { smile: 0.3, brow: -0.2, lid: 0.1, blush: 0.5 };
  for (const primary of ['calm', 'close', 'content', 'happy', 'excited', 'relieved', 'concerned', 'tense-expectation', 'disappointed', 'upset', 'longing', 'sad', '满足'])
    for (const companion of [null, 'playful', 'comfortable', 'wistful']) {
      const mood = { primary, companion, values: { D: 61, E: 57, C: 40 } };
      const old = expressionTargets(mood, 1.3, 0.2, 1.1, wobble);
      const blended = expressionTargets(mood, 1.3, 0.2, 1.1, wobble, emptyExpression(),
        { primary: [{ label: primary, weight: 1 }], companion: [{ label: companion ?? '', weight: 1 }] });
      for (const key of EXPRESSION_CHANNELS) assert.ok(Object.is(blended[key], old[key]), `${primary}/${companion} ${key}: ${blended[key]} vs ${old[key]}`);
    }
  const happy = expressionTargets({ primary: 'happy' }, 1, 0, 1, wobble), calm = expressionTargets({ primary: 'calm' }, 1, 0, 1, wobble);
  const half = expressionTargets({ primary: 'calm' }, 1, 0, 1, wobble, emptyExpression(),
    { primary: [{ label: 'happy', weight: 0.5 }, { label: 'calm', weight: 0.5 }], companion: [{ label: '', weight: 1 }] });
  for (const key of EXPRESSION_CHANNELS) assert.ok(Math.abs(half[key] - (happy[key] + calm[key]) / 2) < 1e-12, key);
});

const moodState = (mood: string, extra: Partial<StageMoodState> = {}): StageMoodState =>
  ({ mood, phase: 'idle', expressive: true, face: 50, posture: 50, playful: 0, responding: false, companion: null, ...extra });
/** Mood feedback's smile per frame over `seconds` (from a settled `from` label), switching to `to` at the start. */
function feedbackSmile(from: StageMoodState, to: StageMoodState, seconds: number, dt = 1 / 60) {
  const feedback = new MoodFeedback();
  for (let i = 0; i < 180; i++) feedback.frame(dt, EMPTY_CONTACT, from);
  const out: number[] = [feedback.frame(0, EMPTY_CONTACT, from).smile];
  for (let i = 0; i < Math.round(seconds / dt); i++) out.push(feedback.frame(dt, EMPTY_CONTACT, to).smile);
  return out;
}
const peakSpeedStep = (values: readonly number[]) => Math.max(...values.slice(2).map((v, i) => Math.abs((v - values[i + 1]) - (values[i + 1] - values[i]))));

test('mood feedback: the smile drifts when the label changes; a reaction is as quick as before; serious still clears it', () => {
  for (const dt of [1 / 60, 1 / 30]) {
    const fall = feedbackSmile(moodState('happy'), moodState('calm'), 3, dt);
    assert.ok(fall[0] > 0.15 && fall.at(-1)! < 0.002, `happy → calm: ${fall[0].toFixed(3)} → ${fall.at(-1)!.toFixed(4)}`);
    // Old: a step of the target followed at speed 6, i.e. the first frame already at 0.96/s (0.016 / 0.030 per frame).
    assert.ok(peakSpeedStep(fall) < 0.0025 * dt * 60, `no sudden start (largest change of the per-frame step ${peakSpeedStep(fall).toFixed(5)})`);
    const rise = feedbackSmile(moodState('calm'), moodState('happy'), 3, dt);
    assert.ok(rise.at(-1)! > 0.155 && peakSpeedStep(rise) < 0.0025 * dt * 60, 'calm → happy the same way');
    // A reaction (the host's brief acknowledgement) on the same label: as quick as before (speed 6: 90% in ln 10 / 6 ≈ 0.38 s).
    const ack = feedbackSmile(moodState('happy'), moodState('happy', { responding: true }), 1.5, dt);
    const at90 = ack.findIndex(v => v - ack[0] >= 0.9 * (ack.at(-1)! - ack[0])) * dt;
    assert.ok(ack.at(-1)! - ack[0] > 0.1 && at90 <= 0.42, `the acknowledgement smile still arrives in ${at90.toFixed(2)} s`);
    // Kept on purpose: a serious new label does not inherit the smile (cleared at once, as before).
    const serious = feedbackSmile(moodState('happy'), moodState('concerned'), 0.2, dt);
    assert.equal(serious[1], 0);
  }
});

interface Sample { t: number; smileEyes: number; mouthSmile: number; blush: number; moodPitch: number; headPitch: number }
type Key = Exclude<keyof Sample, 't'>;
const KEYS: readonly Key[] = ['smileEyes', 'mouthSmile', 'blush', 'moodPitch', 'headPitch'];
/** Largest speed (per s) and largest frame-to-frame change of the per-frame step (the R29b "unexpected step") in [from, to]. */
function motion(samples: readonly Sample[], key: Key, from: number, to: number) {
  let speed = 0, step = 0;
  for (let k = 2; k < samples.length; k++) {
    if (samples[k].t < from || samples[k].t > to) continue;
    const d1 = samples[k][key] - samples[k - 1][key], d0 = samples[k - 1][key] - samples[k - 2][key];
    speed = Math.max(speed, Math.abs(d1) / (samples[k].t - samples[k - 1].t));
    step = Math.max(step, Math.abs(d1 - d0));
  }
  return { speed, step };
}
const at = (samples: readonly Sample[], t: number) => samples.reduce((best, s) => Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best);

const SWITCHES: readonly [number, string][] = [[4, 'calm'], [8, 'happy'], [12, 'close'], [16, 'happy']];
/**
 * Per frame step changes allowed at a label switch (per 60 fps frame; ×2 at 30 fps). Before: 笑い 0.0152 / 0.0290, にっこり
 * 0.0059–0.0091 / 0.0116–0.0178, blush 0.0017–0.0032 (60 fps), the mood pitch 0.057° / 0.057°. The blush
 * keeps the morphs' 1e-3 settle to exactly 0 (continuous-expression.ts), a 0.001 step nobody sees.
 */
const LIMITS: Record<Key, number> = { smileEyes: 0.004, mouthSmile: 0.0015, blush: 0.0013, moodPitch: 0.01, headPitch: Infinity };
