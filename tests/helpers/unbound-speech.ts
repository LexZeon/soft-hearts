// Unbound night experiment E3 (docs/claude/2026-11-14-unbound-night-e3-speech.md): the bundled public Gene, standing in her Unbound
// body, gets a reply. Through the real figure (MMDLoader / CCD IK / gait and contact owner / intent layer), the real director with
// the opening beat (src/unbound/director/speech-beat.ts) and its bubble gate, and the procedural generator, frame by frame at a
// fixed rate with this laptop's screen-camera (tests/helpers/unbound-peek.ts). Each frame records her bones' world rotations, head
// and eye points, the eye's gaze, the beat's phase, and when the bubble came out.
import { Quaternion, Vector3 } from 'three';
import { UNITS_PER_M } from '../../src/unbound/figure';
import { Director } from '../../src/unbound/director/director';
import { PEEK_LENS } from '../../src/unbound/director/peek-lens';
import { SpeechBeat, SpeechBubbleGate, type SpeechBeatPhase } from '../../src/unbound/director/speech-beat';
import { ProceduralGenerator } from '../../src/unbound/motion/procedural';
import type { V3 } from '../../src/unbound/motion/lens-align';
import { planPeek, type ChatCue } from '../../shared/unbound/director';
import type { UnboundBubble } from '../../shared/unbound/scene';
import { geneFigure, TRACKED } from './unbound-gene';
import { CURIOUS, laptopLens } from './unbound-peek';

export const SPEECH_TRACKED = [...TRACKED, '左目', '右目'] as const;
export const HOME = { x: 0.25, z: -1.2 };
const BLINK = ['まばたき', 'eyeBlink', '瞬き', 'blink', 'Blink'];

export interface SpeechFrame {
  t: number; phase: SpeechBeatPhase | null;
  rotations: Quaternion[]; head: V3 | null; eyes: { left: V3 | null; right: V3 | null };
  /** The left eye bone's world rotation, and the blink morph as drawn. */
  eyeQ: Quaternion | null; blink: number | null;
  /** Bubble events shown so far (count). */
  shown: number;
}

export type SpeechInterruptAt = { t: number; kind: 'pull' | 'hidden' | 'reply' | 'peek' };

/**
 * One reply. `beat`: 'on' (the opening beat with its switch on), 'off' (the beat exists, switch off), 'none' (no beat at all: the
 * director as before E3). `asideDeg`: she was looking this far to her side before (she faces a point that far off you).
 * Cue at `cueAt` (s): first words; `speakS` later: done.
 */
export async function runSpeech(fps: number, seconds: number, options: {
  beat: 'on' | 'off' | 'none'; asideDeg?: number; cueAt?: number; speakS?: number; interrupt?: SpeechInterruptAt;
  /** A blink the motion plays (keyframed into the blink morph before each frame) — the beat must leave it as it is. */
  motionBlinkAt?: number;
}) {
  const { fixture, figure } = await geneFigure({ xM: HOME.x, depthM: -HOME.z });
  const lens = laptopLens();
  const speech = options.beat === 'none' ? null : new SpeechBeat();
  if (speech) speech.enabled = options.beat === 'on';
  const director = new Director([PEEK_LENS], new ProceduralGenerator(), () => {}, speech);
  const shown: { t: number; bubble: UnboundBubble }[] = [];
  let now = 0;
  const sink = (bubble: UnboundBubble) => shown.push({ t: now, bubble });
  const gate = speech ? new SpeechBubbleGate(speech, sink, { set: () => 0, clear: () => {} }) : null;
  const receive = (bubble: UnboundBubble) => gate ? gate.receive(bubble) : sink(bubble);
  const cue = (patch: Partial<ChatCue>) => director.setCue({ ...director.currentCue, ...patch });
  const viewer = { x: 0, z: 0.55 };
  if (options.asideDeg) {
    // A point far along a direction `asideDeg` to her side of the line from her to you.
    const a = Math.atan2(viewer.x - HOME.x, viewer.z - HOME.z) + options.asideDeg * Math.PI / 180;
    figure.faceToward({ x: HOME.x + 20 * Math.sin(a), z: HOME.z + 20 * Math.cos(a) });
  } else figure.faceToward(viewer);
  const cueAt = options.cueAt ?? 3, speakS = options.speakS ?? 1.0;
  const blinkIndex = (() => { const d = fixture.mesh.morphTargetDictionary ?? {}; const name = BLINK.find(n => d[n] !== undefined); return name ? d[name] : null; })();
  try {
    const bones = SPEECH_TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    const eye = fixture.mesh.skeleton.bones.find(b => b.name === '左目') ?? null;
    const frames: SpeechFrame[] = [];
    let interrupted = false, cued = false, done = false;
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      now = t;
      if (!cued && t >= cueAt) { cued = true; cue({ speaking: true, replyId: 'r1' }); receive({ id: 'r1', type: 'delta', text: '嗯，' }); }
      if (cued && !done && t >= cueAt + speakS) { done = true; cue({ speaking: false }); receive({ id: 'r1', type: 'done', text: '' }); }
      const at = options.interrupt;
      if (at && !interrupted && t >= at.t) {
        interrupted = true;
        if (at.kind === 'pull') speech?.interrupt('pull'); // 2026-11-23: a large pull (the mouse moving never winds it down)
        else if (at.kind === 'hidden') { speech?.interrupt('hidden'); gate?.flush(); }
        else if (at.kind === 'reply') { cue({ speaking: false }); receive({ id: 'r1', type: 'done', text: '' }); cue({ speaking: true, replyId: 'r2' }); receive({ id: 'r2', type: 'delta', text: '还有' }); }
        else director.command({ type: 'start', id: 'peek-1', plan: planPeek(CURIOUS, () => 0.4), trial: true, armAfterMs: 0 }, { lens, home: HOME });
      }
      director.frame(dt, { lens, home: HOME }, figure);
      gate?.poll();
      if (blinkIndex !== null && options.motionBlinkAt !== undefined && fixture.mesh.morphTargetInfluences) {
        const u = (t - options.motionBlinkAt) / 0.24;
        fixture.mesh.morphTargetInfluences[blinkIndex] = u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
      }
      figure.frame(dt);
      const sense = figure.sense!;
      frames.push({
        t, phase: speech?.phase ?? null, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), head: sense.head, eyes: { ...sense.eyes },
        eyeQ: eye ? eye.getWorldQuaternion(new Quaternion()) : null,
        blink: blinkIndex !== null ? fixture.mesh.morphTargetInfluences?.[blinkIndex] ?? null : null, shown: shown.length,
      });
    }
    return { frames, shown, lens, phases: speech ? [...speech.phases] : [], bubbleAt: speech?.bubbleTime ?? null, cueAt, interrupted: speech?.interrupted ?? null, skipped: speech?.lastSkip ?? null, unitsPerM: UNITS_PER_M };
  } finally { figure.dispose(); fixture.close(); }
}

/** Index of a tracked bone. */
export const boneIndex = (name: (typeof SPEECH_TRACKED)[number]) => SPEECH_TRACKED.indexOf(name);

/** World angular speed (deg/s) of bone `b` between frames i−1 and i. */
export function angularSpeed(frames: readonly SpeechFrame[], b: number, i: number, fps: number): number {
  return frames[i].rotations[b].angleTo(frames[i - 1].rotations[b]) * 180 / Math.PI * fps;
}

/**
 * The beat's own rotation of bone `b` at frame i: the with-beat run against the run without it (same motion, same frames), as a
 * rotation vector split into her pitch (about her left-right axis: + = forward / down) and yaw (about up), in degrees.
 */
export function residual(withBeat: readonly SpeechFrame[], without: readonly SpeechFrame[], b: number, i: number): { pitch: number; yaw: number; angle: number } {
  const r = withBeat[i].rotations[b].clone().multiply(without[i].rotations[b].clone().invert());
  if (r.w < 0) r.set(-r.x, -r.y, -r.z, -r.w);
  const angle = 2 * Math.acos(Math.min(1, r.w)), s = Math.sin(angle / 2), axis = s > 1e-9 ? new Vector3(r.x / s, r.y / s, r.z / s) : new Vector3();
  const v = axis.multiplyScalar(angle * 180 / Math.PI);
  const l = without[i].eyes.left, rt = without[i].eyes.right;
  // Her left-right axis from her eyes (right → left); positive pitch = chin down, i.e. a rotation about her right-pointing axis.
  const lateral = l && rt ? new Vector3(l.x - rt.x, 0, l.z - rt.z).normalize() : new Vector3(1, 0, 0);
  return { pitch: v.dot(lateral), yaw: v.y, angle: angle * 180 / Math.PI };
}

/** Angle (deg) between the eye's gaze and the direction to the lens; the eye's forward is ±Z in its own frame, picked once. */
export function gazeOff(frame: SpeechFrame, camera: V3, sign: 1 | -1): number | null {
  if (!frame.eyeQ || !frame.eyes.left) return null;
  const f = new Vector3(0, 0, sign).applyQuaternion(frame.eyeQ).normalize();
  const to = new Vector3(camera.x - frame.eyes.left.x, camera.y - frame.eyes.left.y, camera.z - frame.eyes.left.z).normalize();
  return Math.acos(Math.max(-1, Math.min(1, f.dot(to)))) * 180 / Math.PI;
}
