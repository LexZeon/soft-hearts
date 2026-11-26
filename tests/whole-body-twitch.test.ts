/**
 * 2026-11-12 全身抽搐 (docs/claude/2026-11-12-whole-body-twitch.md). And it happened "在思考的时候": after her message was sent and before the first character, while
 * the reaction (blush, shy), the mood appraisal and the label flip close → happy all arrived within a few seconds.
 *
 * Cause: procedural life (procedural-life.ts) read its drift noises at `time × speed`, where `time` is the life's own clock since
 * the model loaded (the app's uptime) and `speed` follows the mood (TEMPER by label, the N/E/C channels; eased over ~1.5 s). When
 * the mood changes, the noise position moves by uptime × (change of speed): after an hour of uptime a close → happy flip pushes the
 * sway / head / gaze noises through dozens of noise cells in a couple of seconds, so her upper body (with the arms and head on it)
 * shakes at 10–40 Hz until the temper settles. Fresh after loading (every test before this one) the same flip is invisible.
 *
 * Now each noise runs on its own clock that advances at the tempered speed (clock += speed · dt): a mood change alters how fast the
 * noise moves, never where it is, whatever the uptime. What these tests hold:
 *  - ProceduralLife alone, after an hour of real frames: a label flip moves sway, head and gaze no more abruptly than a flip right
 *    after loading, and both stay within the steady drift's own frame-to-frame change (old, after an hour: 4 to 5 orders of magnitude above it);
 *  - Gene, real frame loop (gene-stage-harness), 60 and 30 fps on a 60 Hz screen, her life on, the pointer moving, her life aged
 *    an hour through its own frame(): the user's thinking turn (typing, send → waiting + thinking, reaction blush + shy show,
 *    appraisal, close → happy, first character → speaking, end). Per event window the largest unexpected step of the upper body
 *    and head stays small, the guard catches nothing.
 * WHOLE_BODY_REPORT=1 prints the numbers in the doc.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProceduralLife, type LifeInput } from '../src/stage/procedural-life';
import { ANCHOR_LEVELS } from '../src/mood/mood-face/anchors';

const REPORT = process.env.WHOLE_BODY_REPORT === '1';
type Label = keyof typeof ANCHOR_LEVELS;
/** I-073: a label comes with its numbers (a switch is the numbers moving, as a mood event does); `lift` adds to E and N (an appraisal). */
const numbers = (label: Label, lift = 0) => {
  const base = { D: 50, O: 50, E: 50, N: 50, C: 50, ...ANCHOR_LEVELS[label].levels } as Record<'D' | 'O' | 'E' | 'N' | 'C', number>;
  return { ...base, E: base.E + lift, N: base.N + lift };
};

// ------------------------------------------------------------------ ProceduralLife alone

/** The gaze outputs carry saccades (steps the stage's critically damped gaze smooths), so the gaze is measured on the head (Gene, below). */
const OUTPUTS = ['swayY', 'swayZ', 'headX', 'headY', 'headZ'] as const;
function lifeInput(label: Label): LifeInput<object> {
  const owner = {};
  return { enabled: true, owner, seedKey: 'companion', rig: null, fatigue: null, pointerX: 0, pointerY: 0, breathStrength: 0.5, hasEyes: true,
    mood: { primary: label, companion: null, values: numbers(label), intensity: { gaze: 50, posture: 50, expression: 50 } } as LifeInput<object>['mood'],
    gates: { expressive: true, gazeAllowed: true } as LifeInput<object>['gates'] };
}
/** Largest |second difference| per output over `seconds` at 60 fps (the R29b "unexpected step", per frame). */
function lifeSteps(life: ProceduralLife<object>, input: LifeInput<object>, seconds: number) {
  const dt = 1 / 60, history: number[][] = [], peak = Object.fromEntries(OUTPUTS.map(key => [key, 0])) as Record<typeof OUTPUTS[number], number>;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    life.frame(dt, input);
    history.push(OUTPUTS.map(key => life.out[key]));
    if (history.length >= 3) {
      const [a, b, c] = history.slice(-3);
      OUTPUTS.forEach((key, k) => { peak[key] = Math.max(peak[key], Math.abs(c[k] - 2 * b[k] + a[k])); });
    }
  }
  return peak;
}
function lifeFlip(uptimeS: number) {
  const life = new ProceduralLife<object>(), input = lifeInput('close');
  // The uptime as real frames (dt is clamped to 0.1 s per frame, as on a slow screen).
  for (let i = 0; i < Math.round(uptimeS / 0.1); i++) life.frame(0.1, input);
  const steady = lifeSteps(life, input, 3);
  input.mood = { ...input.mood!, primary: 'happy', values: numbers('happy') };
  const flip = lifeSteps(life, input, 4);
  return { steady, flip };
}

test('ProceduralLife: after an hour of uptime a close → happy flip moves sway, head and gaze as gently as right after loading', () => {
  const fresh = lifeFlip(5), aged = lifeFlip(3600), long = REPORT ? [lifeFlip(600), lifeFlip(8 * 3600)] : null, failures: string[] = [];
  for (const key of OUTPUTS) {
    if (REPORT) console.log(`life ${key}: steady ${aged.steady[key].toExponential(2)} | flip fresh ${fresh.flip[key].toExponential(2)} | after 10 min ${long![0].flip[key].toExponential(2)} | 1 h ${aged.flip[key].toExponential(2)} | 8 h ${long![1].flip[key].toExponential(2)}`);
    if (!(aged.flip[key] <= 4 * Math.max(aged.steady[key], fresh.flip[key]) + 1e-6))
      failures.push(`${key}: after 1 h the flip changes the per-frame step by ${aged.flip[key]} (steady ${aged.steady[key]}, fresh flip ${fresh.flip[key]})`);
  }
  assert.deepEqual(failures, []);
});

const T0 = 4;
const EVENTS: readonly [number, string][] = [[T0 - 2, 'typing'], [T0, 'send'], [T0 + 2, 'reaction'], [T0 + 4, 'appraisal'], [T0 + 6, 'label'],
  [T0 + 7, 'first-char'], [T0 + 10, 'speech-end']];

/** Largest unexpected step (degrees per frame at 60 fps; ×2 at 30 fps) in each event's 1.5 s window. Before (1 h uptime): 上半身 0.39° / 0.52°, 頭 1.02° / 1.03° (60 / 30 fps). */
const LIMIT = { 上半身: 0.04, 頭: 0.16 };
