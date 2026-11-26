/**
 * 2026-11-10 嘴、脸和头抽搐 (docs/claude/2026-11-10-face-head-twitch.md). The user, stable build, Bailian read-aloud with
 * lip-sync, a small action after almost every reply (pout, wink, tilt, heart), mood close / happy with blush: "嘴和脸，也有头"
 * twitch, "有时候不说话也抽", not dropped frames.
 *
 * What these tests hold, on the real stage frame loop (gene-stage-harness: bundled Gene, Stand, procedural life, her own
 * activity, mood feedback, the display guard, the stage's own playHerAction) on a 60 Hz screen:
 *  - streamed speech stalls for 50–150 ms several times a second (src/voice/EmotionalVoice.ts silence(): the queue ran dry, then
 *    ~30 ms after the next chunk the mouth opens again). The stage's speaking flag followed every stall, so the mouth shut half
 *    way and reopened, and every owner that gives way to speech (life's mouth smile and gaze, her own activity, reply thinking,
 *    a mouth face shape, the music nod, new body motions) started back and was sent away again. Measured: the mouth's
 *    direction reversals ("zigzags": both half-swings within 0.15 s) against the same seconds of speech without stalls;
 *  - a mouth face shape (pout: Gene's own mouthPucker, or the approximation on a model without it, "う" plus the mouth corners)
 *    asked for inside a stall used to start and be handed back a moment later; now it is refused ("她正在说话");
 *  - right after she finished (the host sends a waiting mouth shape after 500 ms of quiet) the pout plays and stays smooth;
 *  - a real pause (longer than the hold) still closes the mouth;
 *  - head and neck never zigzag; pointer moving and still, approximation and Gene's own pucker; 60 fps and 30 fps settings.
 * FACE_TWITCH_REPORT=1 prints the numbers in the doc.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Quaternion } from 'three';
import { SPEECH_HOLD_S, SpeechHold } from '../src/voice/speech-hold';
import { type ShownFrame } from './helpers/frame-stats';

const REPORT = process.env.FACE_TWITCH_REPORT === '1';
const DEG = 180 / Math.PI;

test('SpeechHold: speech is seen at once; a stall shorter than the hold is one utterance; a longer pause is not', () => {
  const hold = new SpeechHold(), dt = 1 / 60;
  assert.deepEqual({ ...hold.frame(dt, false) }, { mouth: false, flap: 0, owner: false }, 'no speech yet: nothing held');
  hold.note(true);
  assert.deepEqual({ ...hold.frame(dt, true) }, { mouth: true, flap: 1, owner: true }, 'speech is seen on the same frame');
  hold.note(false);
  let frames = 0, last = 1, full = 0;
  while (hold.frame(dt, false).mouth) {
    frames++;
    if (hold.out.flap === 1) full++;
    assert.ok(hold.out.flap <= last + 1e-12, 'the last syllable only eases shut');
    assert.ok(last - hold.out.flap <= 1.875 * dt / SPEECH_HOLD_S.fade + 1e-9, 'smootherstep: no step larger than its peak speed allows');
    last = hold.out.flap;
  }
  assert.ok(Math.abs(full * dt - SPEECH_HOLD_S.mouth) <= dt + 1e-9, `the lip-sync keeps its full size for ${SPEECH_HOLD_S.mouth} s (${full} frames)`);
  assert.ok(Math.abs(frames * dt - SPEECH_HOLD_S.mouth - SPEECH_HOLD_S.fade) <= dt + 1e-9, `then eases shut over ${SPEECH_HOLD_S.fade} s (${frames} frames)`);
  assert.equal(hold.out.owner, true, 'owners still hold');
  while (hold.frame(dt, false).owner) frames++;
  assert.ok(Math.abs(frames * dt - SPEECH_HOLD_S.owner) <= dt + 1e-9, `owners hold for ${SPEECH_HOLD_S.owner} s`);
  assert.ok(SPEECH_HOLD_S.owner < 0.5, 'below the host quiet window for a waiting mouth shape (CHAT_ACTION_AFTER_SPEECH_MS)');
  // A stall shorter than one frame (true then false between two frames) still counts as speech.
  hold.note(true); hold.note(false);
  assert.equal(hold.frame(dt, false).owner, true);
  hold.reset();
  assert.deepEqual({ ...hold.out }, { mouth: false, flap: 0, owner: false });
});

/** Half-swings between successive extrema: a zigzag is two of them within `short` s each, both at least `amp`. */
function zigzags(values: readonly number[], times: readonly number[], eps: number, amp: number, short = 0.15): number[] {
  const extrema = [0];
  let last = 0;
  for (let k = 1; k < values.length; k++) {
    const d = values[k] - values[k - 1];
    if (Math.abs(d) < eps) continue;
    const sign = Math.sign(d);
    if (last && sign !== last) extrema.push(k - 1);
    last = sign;
  }
  const out: number[] = [];
  for (let e = 2; e < extrema.length; e++) {
    const a = extrema[e - 2], b = extrema[e - 1], c = extrema[e];
    if (times[b] - times[a] <= short && times[c] - times[b] <= short && Math.min(Math.abs(values[b] - values[a]), Math.abs(values[c] - values[b])) >= amp) out.push(times[b]);
  }
  return out;
}
/** Small-angle components (degrees) of a bone's displayed world rotation against its first frame, per axis. */
function axes(frames: readonly ShownFrame[], bone: number): number[][] {
  const out: number[][] = [[], [], []], q = new Quaternion();
  for (const frame of frames) {
    q.copy(frames[0].extra[bone]).invert().multiply(frame.extra[bone]);
    const sign = q.w < 0 ? -1 : 1;
    out[0].push(2 * q.x * sign * DEG); out[1].push(2 * q.y * sign * DEG); out[2].push(2 * q.z * sign * DEG);
  }
  return out;
}

const SPEECH = { from: 3.3, to: 6.0 };
/** Stream stalls (s): 80 ms every 0.5 s, one 0.45 s real pause, and the stall a pout is asked for in. */
const STALLS: readonly [number, number][] = [[3.72, 3.80], [4.22, 4.30], [4.72, 4.80], [5.05, 5.50], [5.72, 5.80]];
const POUT_IN_STALL = 4.24, POUT_AFTER = 6.6;
const speakingAt = (t: number, stalls: boolean) => t >= SPEECH.from && t < SPEECH.to && !(stalls && STALLS.some(([a, b]) => t >= a && t < b));

interface Run { frames: ShownFrame[]; morph(name: string): number[]; times: number[]; inStall: string | undefined; after: string | undefined }

const window = (r: Run, values: number[], from: number, to: number) => {
  const keep = r.times.map((t, i) => t >= from && t <= to ? i : -1).filter(i => i >= 0);
  return { values: keep.map(i => values[i]), times: keep.map(i => r.times[i]) };
};
const count = (r: Run, values: number[], from: number, to: number, eps: number, amp: number) => {
  const w = window(r, values, from, to);
  return zigzags(w.values, w.times, eps, amp).length;
};
/** Stalls (shorter than the mouth hold) during which the lip-sync mouth closed below 0.15. */
const closures = (r: Run) => STALLS.filter(([a, b]) => b - a < SPEECH_HOLD_S.mouth)
  .filter(([a, b]) => window(r, r.morph('あ'), a, b + 0.08).values.some(value => value < 0.15)).length;

let reference: Run | null = null;
