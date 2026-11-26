/**
 * I-167 (docs/claude/2026-11-21-gaze-at-user.md): the whole "she looks at you" path, end to end, on a synthetic person.
 *
 *   a head in front of the camera (metres, a yaw and pitch) → COCO-17 keypoints in the 320×240 sensor frame with pixel noise
 *   → the real PoseFeatureTracker (electron/senses/pose/features.ts) at the pose frame rate, each result an inference delay later
 *   → the engine's send rule → the real UserGazeHost (electron/senses/user-gaze.ts) → the companion window's 100 ms poll
 *   → the real StageGazeAttention (src/senses/gaze-attention-stage.ts) → gazeTargets and the stage's own head / eye followers
 *   (src/stage/mmd/idle.ts: head critically damped at 10, eyes first-order at 12) at the display rate.
 *
 * Synthetic only: no camera, no model, no window. Numbers it measures: how soon her look moves after your head moves, and how
 * much her look trembles while you sit still.
 */
import { PerspectiveCamera } from 'three';
import { PoseFeatureTracker, type PoseSample } from '../../electron/senses/pose/features';
import { poseEmitDue, POSE_EMIT } from '../../electron/senses/pose/emit-gate';
import { UserGazeHost } from '../../electron/senses/user-gaze';
import { StageGazeAttention } from '../../src/senses/gaze-attention-stage';
import { HerOutGaze } from '../../src/unbound/her/out-gaze';
import { UNITS_PER_M } from '../../src/unbound/figure';
import { damp, dampCritical, gazeTargets } from '../../src/stage';
import type { PoseSignal } from '../../shared/senses/pose-signals';
import type { UserGazeReading } from '../../shared/behaviors/gaze-attention/interface';

export const FRAME_W = 320, FRAME_H = 240;
/** Square pixels, 60° across (the knobs' hfov). */
export const FOCAL_PX = FRAME_W / 2 / Math.tan(Math.PI / 6);

/** A head: position relative to the camera (metres; x = screen right as you see it, y = down, z = toward you), turn (rad; yaw + = toward screen right, pitch + = down). */
export interface Head { x: number; y: number; z: number; yaw: number; pitch: number }

/** Face points in the head's own frame (metres; x = the person's right, y = down, z = toward the back of the head). */
const LOCAL: readonly (readonly [number, number, number])[] = [
  [0, 0.04, -0.028], // 0 nose tip: 4 cm below the eyes, 2.8 cm in front of them
  [-0.0315, 0, 0], [0.0315, 0, 0], // 1 left eye, 2 right eye (6.3 cm apart)
  [-0.0725, 0.01, 0.08], [0.0725, 0.01, 0.08], // 3 left ear, 4 right ear (14.5 cm apart, 8 cm behind the eyes)
];
/** Body points relative to the head's centre, not turning with it (shoulders 34 cm apart, about 22 cm below the eyes). */
const BODY: readonly (readonly [number, number, number])[] = [
  [-0.17, 0.22, 0.09], [0.17, 0.22, 0.09], [-0.2, 0.45, 0.05], [0.2, 0.45, 0.05], [-0.18, 0.6, -0.1], [0.18, 0.6, -0.1],
];

/** A small seeded random source and a normal draw (no Math.random: the same run every time). */
export function seeded(seed = 11): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function normal(random: () => number): number { const u = Math.max(1e-9, random()), v = random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/** The 17 keypoints (pixels) and scores of `head`, with `noisePx` of pixel noise. An ear turned away is barely seen. */
export function keypointsOf(head: Head, noisePx: number, random: () => number): { kpts: Float32Array; scores: Float32Array } {
  const kpts = new Float32Array(34), scores = new Float32Array(17);
  const cy = Math.cos(head.yaw), sy = Math.sin(head.yaw), cp = Math.cos(head.pitch), sp = Math.sin(head.pitch);
  const project = (x: number, y: number, z: number, i: number, score: number) => {
    kpts[i * 2] = FRAME_W / 2 - FOCAL_PX * x / z + noisePx * normal(random);
    kpts[i * 2 + 1] = FRAME_H / 2 + FOCAL_PX * y / z + noisePx * normal(random);
    scores[i] = score;
  };
  LOCAL.forEach(([lx, ly, lz], i) => {
    // Pitch about the person's right axis (down +: the front goes down), then yaw about the vertical (toward screen right +).
    const y1 = ly * cp - lz * sp, z1 = ly * sp + lz * cp;
    const x2 = lx * cy - z1 * sy, z2 = lx * sy + z1 * cy;
    // The person faces -z (the screen) at zero turn: their right is +x, the back of the head +z.
    const far = (i === 3 && head.yaw < -0.5) || (i === 4 && head.yaw > 0.5);
    project(head.x + x2, head.y + y1, head.z + z2, i, far ? 0.15 : 0.9);
  });
  BODY.forEach(([bx, by, bz], j) => project(head.x + bx, head.y + by, head.z + bz, 5 + j, 0.9));
  for (let i = 11; i < 17; i++) { kpts[i * 2] = FRAME_W / 2; kpts[i * 2 + 1] = FRAME_H + 80; scores[i] = 0.05; }
  return { kpts, scores };
}

export interface SimOptions {
  /** Display frames per second. */
  fps: number;
  /** Pose frames per second (the engine's choice). */
  poseFps: number;
  /** ms from a camera frame to its result. */
  inferMs?: number;
  noisePx?: number;
  seconds: number;
  /** Where your head is at time t (s). */
  head(t: number): Head;
  seed?: number;
}
export interface SimRow { t: number; yawDeg: number; pitchDeg: number; fullYawDeg: number; fullPitchDeg: number; reading: UserGazeReading | null }

const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
/** Her companion window at the bottom right of the screen; her eyes in its upper middle. */
const HER_WINDOW = { x: 1480, y: 480, width: 400, height: 560 };
const EYES = { x: 0, y: 0.45 };

/** The full-screen world camera: the viewer's eye 0.6 m from a 0.53 m wide screen, at its centre height (shared/unbound/world.ts). */
function fullScreenCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(48, 16 / 9, 0.05 * UNITS_PER_M, 400 * UNITS_PER_M);
  camera.position.set(0, 1.2 * UNITS_PER_M, 0.6 * UNITS_PER_M); camera.updateMatrixWorld(true);
  return camera;
}

/**
 * Runs the whole path. Returns per display frame her look toward you (degrees): on the companion window the visible yaw / pitch
 * (head + eyes, as the stage writes them), in full-screen the look direction before the figure's eye-head split.
 */
export function simulateGazePipeline(options: SimOptions): SimRow[] {
  const random = seeded(options.seed ?? 11), noise = options.noisePx ?? 1;
  const inferMs = options.inferMs ?? 40, poseDt = 1000 / options.poseFps, displayDt = 1 / options.fps;
  const tracker = new PoseFeatureTracker();
  let clockMs = 0;
  const host = new UserGazeHost(() => clockMs);
  host.sensing(true);
  const stage = new StageGazeAttention(() => 0.5);
  const full = new HerOutGaze(() => {}, () => 0.5), camera = fullScreenCamera();
  const velocity = { x: 0, y: 0 }, gaze = { x: 0, y: 0 }, eye = { x: 0, y: 0 };
  let nextCapture = 0, pending: { at: number; sample: PoseSample }[] = [], nextPoll = 0, held: UserGazeReading | null = null;
  let lastEmit = -Infinity, lastFace: { x: number; y: number } | null = null, lastPresent = false, lastHead: PoseSignal['head'] = null;
  const rows: SimRow[] = [];
  const frames = Math.round(options.seconds * options.fps);
  for (let f = 0; f <= frames; f++) {
    const t = f * displayDt, ms = t * 1000;
    // Camera frames at the pose rate; each result lands inferMs later (the engine stamps it then).
    while (nextCapture <= ms) {
      const { kpts, scores } = keypointsOf(options.head(nextCapture / 1000), noise, random);
      pending.push({ at: nextCapture + inferMs, sample: { t: nextCapture + inferMs, detected: true, detScore: 0.9, kpts, scores, width: FRAME_W, height: FRAME_H } });
      nextCapture += poseDt;
    }
    const due = pending.filter(p => p.at <= ms);
    pending = pending.filter(p => p.at > ms);
    for (const { at, sample } of due) {
      tracker.push(sample);
      const signal: PoseSignal = tracker.signal('full');
      if (poseEmitDue({ t: at, lastEmit, lastFace, lastHead, lastPresent, attending: tracker.attending }, signal)) {
        lastEmit = at; lastFace = signal.face; lastHead = signal.head; lastPresent = signal.present;
        clockMs = at; host.note(signal);
      }
    }
    clockMs = ms;
    // The companion window polls every 100 ms; full-screen gets each signal's reading (here: at the same poll, which is later or equal).
    if (ms >= nextPoll) { held = host.read(HER_WINDOW, DISPLAY); nextPoll += 100; full.set(host.read(DISPLAY, DISPLAY)); }
    const out = stage.frame({ delta: displayDt, follow: false, allowed: true, mouseX: 0, mouseY: 0, originX: EYES.x, originY: EYES.y, reading: held, mood: null });
    // Her look toward you alone (as when the chooser gives you the whole share), through the stage's own split and followers.
    const target = gazeTargets(out.userX, out.userY, true);
    gaze.x = dampCritical(gaze.x, target.headX, 10, displayDt, velocity, 'x');
    gaze.y = dampCritical(gaze.y, target.headY, 10, displayDt, velocity, 'y');
    eye.x = damp(eye.x, target.eyeX, 12, displayDt); eye.y = damp(eye.y, target.eyeY, 12, displayDt);
    const look = full.frame({ dt: displayDt, allowed: true, thinking: false, speaking: false, mood: null, head: { x: 0.2, y: 1.45, z: -1 }, heading: 0, camera });
    rows.push({ t, yawDeg: (gaze.x + eye.x) * 180 / Math.PI, pitchDeg: (gaze.y + eye.y) * 180 / Math.PI,
      fullYawDeg: look ? look.toUser.yaw * 180 / Math.PI : 0, fullPitchDeg: look ? look.toUser.pitch * 180 / Math.PI : 0, reading: held });
  }
  return rows;
}

/** Seconds after `from` until `key` has covered `share` of its change between `from` and the end. */
export function reachTime(rows: readonly SimRow[], from: number, key: 'yawDeg' | 'pitchDeg' | 'fullYawDeg' | 'fullPitchDeg', share: number): number {
  const start = rows.find(r => r.t >= from)!, end = rows.at(-1)!;
  const total = end[key] - start[key];
  const hit = rows.find(r => r.t >= from && (r[key] - start[key]) / total >= share);
  return hit ? hit.t - from : Infinity;
}

/** How much `key` trembles between `from` and `to`: standard deviation, peak to peak (degrees) and mean speed (degrees per second). */
export function tremble(rows: readonly SimRow[], from: number, to: number, key: 'yawDeg' | 'pitchDeg' | 'fullYawDeg' | 'fullPitchDeg') {
  const part = rows.filter(r => r.t >= from && r.t <= to), values = part.map(r => r[key]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  let path = 0;
  for (let i = 1; i < values.length; i++) path += Math.abs(values[i] - values[i - 1]);
  return { sd, p2p: Math.max(...values) - Math.min(...values), speed: path / Math.max(1e-9, part.at(-1)!.t - part[0].t) };
}

export { POSE_EMIT };
