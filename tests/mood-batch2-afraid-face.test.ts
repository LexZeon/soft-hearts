/**
 * Mood batch 2, item 10 (docs/claude/2026-11-11-mood-batch2.md): her own afraid face (I-076): wide eyes (the profile's surprise slot),
 * the inner brows up (the troubled-brow slot), the head a little back, no smile. It comes in by the label (like upset and relieved: the
 * numbers alone are concerned's), so without a frightening cause nothing changes. Before, 害怕 had no row and showed the calm face.
 *
 * Gene, real frame loop (gene-stage-harness), her life on, the pointer moving, nobody talking, 60 and 30 fps on a 60 Hz screen:
 * calm → a fright (afraid, the numbers of one scare) → a stronger fright (the test preset) → comforted (calm). Per displayed channel
 * the largest frame-to-frame change of the per-frame step stays within the round-3 limits; the head's unexpected step stays small;
 * the display guard has nothing to catch. MOOD_FACE_REPORT=1 prints the numbers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyExpression, expressionTargets } from '../src/stage/continuous-expression';
import { ANCHOR_LABELS, anchorWeights } from '../src/mood/mood-face/anchors';
import { rawPoint } from '../src/mood/mood-face/reading';
import { EMPTY_CONTACT, MoodFeedback, type StageMoodState } from '../src/mood/mood-feedback';
import { MOOD_PRESETS } from '../shared/foundation/mood-presets';

const REPORT = process.env.MOOD_FACE_REPORT === '1';
const DEG = 180 / Math.PI;
const still = { smile: 0, brow: 0, lid: 0, blush: 0 };
const NONE = [{ label: '', weight: 1 }];
const numbers = (levels: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>) => ({ D: 50, O: 50, E: 50, N: 50, C: 50, ...levels });
/** One scare as haiku and Opus gave it in batch 1 (N +5, C +5, E −4 from the baseline). */
const SCARE = numbers({ N: 55, C: 55, E: 46 });
const sliders = (values: ReturnType<typeof numbers>, label: string) => {
  const mood = { primary: label, values, longing: 0 };
  return expressionTargets(mood, 1, 0, 1, still, emptyExpression(), { primary: anchorWeights(rawPoint(mood), [{ label, weight: 1 }]), companion: NONE });
};

test('the afraid look: wide eyes, inner brows up, head a little back, no smile; only with the label (the numbers alone stay concerned or calm)', () => {
  assert.equal((ANCHOR_LABELS as readonly string[]).includes('afraid'), false, 'not a numeric anchor (it would sit within anchorWidth of concerned)');
  for (const values of [SCARE, numbers(MOOD_PRESETS.afraid.levels)]) {
    const afraid = sliders(values, 'afraid');
    assert.ok(afraid.eyeWide > 0.03 && afraid.sad > 0.03, JSON.stringify(afraid));
    assert.ok(afraid.headX < 0, 'chin a little up: the head back');
    // No smile: no smiling eyes or blush, and less of the resting mouth curve than calm has at the same numbers.
    assert.ok(afraid.smileEyes < 1e-3 && afraid.blush < 1e-3, JSON.stringify(afraid));
    assert.ok(afraid.mouthSmile < sliders(values, 'calm').mouthSmile * 0.75, 'less of the resting mouth curve');
    // The same numbers without the cause read as before (concerned / calm): no wide eyes.
    for (const label of ['calm', 'concerned']) assert.equal(sliders(values, label).eyeWide, 0, `${label} at the same numbers`);
  }
  // At the strong preset the label's look is all there; at one scare it is part-way (the mood is milder).
  assert.ok(sliders(numbers(MOOD_PRESETS.afraid.levels), 'afraid').eyeWide > sliders(SCARE, 'afraid').eyeWide);
  // No other label ever widens the eyes.
  for (const label of ['calm', 'close', 'content', 'happy', 'excited', 'concerned', 'disappointed', 'upset', 'longing', 'sad', 'relieved', 'tense-expectation'])
    assert.equal(sliders(numbers({ N: 70, C: 70, E: 35 }), label).eyeWide, 0, label);
});

test('mood feedback: 害怕 is serious: an inherited smile is cleared at once, like 担心', () => {
  const state = (mood: string): StageMoodState => ({ mood, phase: 'idle', expressive: true, face: 50, posture: 50, playful: 0, responding: false, companion: null });
  for (const dt of [1 / 60, 1 / 30]) {
    const fb = new MoodFeedback();
    for (let i = 0; i < 300; i++) fb.frame(dt, EMPTY_CONTACT, state('happy'));
    assert.ok(fb.frame(dt, EMPTY_CONTACT, state('happy')).smile > 0.1);
    assert.equal(fb.frame(dt, EMPTY_CONTACT, state('afraid')).smile, 0);
  }
});

interface Sample { t: number; smileEyes: number; mouthSmile: number; blush: number; eyeWide: number; brow: number; moodPitch: number; blink: number }
type Key = Exclude<keyof Sample, 't' | 'blink'>;
const KEYS: readonly Key[] = ['smileEyes', 'mouthSmile', 'blush', 'eyeWide', 'brow', 'moodPitch'];
/**
 * Per 60 fps frame (×2 at 30 fps): the round-3 limits (smileEyes 0.004, mouthSmile 0.0015, blush 0.0013, the mood pitch 0.01°); the wide
 * eyes and the brow take the eyes' 0.004. The wide eyes give way to a blink (times the open lids, as the E1 shows do): a blink is quick
 * by nature, so frames inside a blink are left out of the wide eyes' step (the blink's own motion is the R29c blink, measured elsewhere).
 */
const LIMITS: Record<Key, number> = { smileEyes: 0.004, mouthSmile: 0.0015, blush: 0.0013, eyeWide: 0.004, brow: 0.004, moodPitch: 0.01 };
const SWITCHES: readonly [number, string, ReturnType<typeof numbers>][] = [[3, 'afraid', SCARE], [8, 'afraid', numbers(MOOD_PRESETS.afraid.levels)], [13, 'calm', numbers({ E: 54, C: 47 })]];

function motion(samples: readonly Sample[], key: Key, from: number, to: number) {
  let peak = 0, step = 0;
  for (let k = 2; k < samples.length; k++) {
    if (samples[k].t < from || samples[k].t > to) continue;
    if (key === 'eyeWide' && Math.max(samples[k].blink, samples[k - 1].blink, samples[k - 2].blink) > 0.01) continue;
    const d1 = samples[k][key] - samples[k - 1][key], d0 = samples[k - 1][key] - samples[k - 2][key];
    peak = Math.max(peak, Math.abs(samples[k][key]));
    step = Math.max(step, Math.abs(d1 - d0));
  }
  return { peak, step };
}
