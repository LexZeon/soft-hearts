// E1 eye-head (docs/claude/2026-11-14-eye-head-fix.md): the bundled Gene's eyes against her head, frame by frame, in the scenes
// where the user saw the pupils at the edge: standing near the screen's edge looking at the lens, turning round and walking back
// (U1's own walk, and the peek's way home), and the peek's close-up. Plus the companion's pointer gaze. Real frame loops throughout
// (the Unbound figure / director / generator, and MmdStage's frameTick through the gene-stage harness), at a fixed rate.
import { Euler, Quaternion, type Bone, type SkinnedMesh } from 'three';
import { ProceduralGenerator } from '../../src/unbound/motion/procedural';
import type { MotionIntent } from '../../src/unbound/motion/generator';
import { UNITS_PER_M } from '../../src/unbound/figure';
import { geneFigure, TRACKED, surpriseAngles } from './unbound-gene';
import { laptopLens, pointSurprises, runPeek } from './unbound-peek';
import { eyePoint, type V3 } from '../../src/unbound/motion/lens-align';
import { ARRIVAL_KNOBS } from '../../shared/unbound/arrival';

const DEG = 180 / Math.PI;
const wrapDeg = (a: number) => a - 360 * Math.floor((a + 180) / 360);
export const UPPER = TRACKED.map((name, i) => [name, i] as const).filter(([name]) => !/足|ひざ/.test(name)).map(([, i]) => i);

export interface EyeFrame {
  t: number; phase: string | null;
  /** Eye-in-head, degrees, per eye (yaw + = toward her left; pitch + = down). */
  eyes: { yaw: number; pitch: number }[];
  rotations: Quaternion[]; head: V3 | null; heading: number; walking: boolean;
  lens?: { off: number; along: number } | null;
  /** Peek only: her head against her upper body (yaw, degrees), and where the lens is from her body's forward (degrees). */
  twist?: number; lensBearing?: number;
}

const euler = new Euler();
/** An eye bone's rotation against its head (Gene's eye bones sit under 頭 with an identity rest), as yaw / pitch in degrees. */
export function eyeInHead(eye: Bone, head: Bone): { yaw: number; pitch: number } {
  const q = eye.parent === head ? eye.quaternion : head.getWorldQuaternion(new Quaternion()).invert().multiply(eye.getWorldQuaternion(new Quaternion()));
  euler.setFromQuaternion(q, 'YXZ');
  return { yaw: euler.y * DEG, pitch: euler.x * DEG };
}
const eyesOf = (mesh: SkinnedMesh) => {
  const find = (name: string) => mesh.skeleton.bones.find(b => b.name === name)!;
  const head = find('頭'), eyes = [find('左目'), find('右目')];
  return () => eyes.map(e => eyeInHead(e, head));
};

/** Stats the brief asks for: max and p95 of |yaw| and |pitch|, and frames in stretches at the edge lasting more than 100 ms. */
export function eyeStats(frames: readonly EyeFrame[], fps: number, edge = { yaw: 16, pitch: 14 }) {
  const yaw = frames.map(f => Math.max(...f.eyes.map(e => Math.abs(e.yaw)))), pitch = frames.map(f => Math.max(...f.eyes.map(e => Math.abs(e.pitch))));
  const sorted = (v: number[]) => [...v].sort((a, b) => a - b), p95 = (v: number[]) => { const s = sorted(v); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] ?? 0; };
  let pinned = 0, run = 0;
  const minRun = Math.ceil(0.1 * fps) + 1; // more than 100 ms
  for (let i = 0; i <= frames.length; i++) {
    const at = i < frames.length && (yaw[i] >= edge.yaw || pitch[i] >= edge.pitch);
    if (at) run++; else { if (run >= minRun) pinned += run; run = 0; }
  }
  const upper = frames[0]?.rotations.length === TRACKED.length ? surpriseAngles(frames as never, 0, UPPER) : [], head = pointSurprises(frames.map(f => f.head));
  return { frames: frames.length, yawMax: Math.max(0, ...yaw), yawP95: p95(yaw), pitchMax: Math.max(0, ...pitch), pitchP95: p95(pitch), pinnedFrames: pinned,
    upperSurpriseDeg: Math.max(0, ...upper), headSurpriseCm: Math.max(0, ...head) };
}

/**
 * Standing near the screen's edge, square to the screen, looking at the lens: she steps sideways from the edge of a laptop's view
 * (x 0.25 m, 0.2 m behind the glass) to well past it (x 0.6 m, the edge of a big monitor), and stays.
 */
export async function edgeScene(fps: number, seconds = 9): Promise<EyeFrame[]> {
  const { fixture, figure } = await geneFigure({ xM: 0.25, depthM: 0.2 });
  const lens = laptopLens(), generator = new ProceduralGenerator(), read = eyesOf(fixture.mesh);
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: EyeFrame[] = [];
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      const place = { x: t < 3 ? 0.25 : 0.6, z: -0.2 };
      const intent: MotionIntent = { kind: 'walk', lens, place, speedMps: 0.5 };
      if (figure.sense) figure.setPoseTargets(generator.generate({ intent, t, dt, sense: figure.sense }));
      figure.frame(dt);
      frames.push({ t, phase: t < 3 ? 'edge-laptop' : 'edge-wide', eyes: read(), rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), head: figure.sense?.head ?? null, heading: figure.heading, walking: figure.walking });
    }
    return frames;
  } finally { figure.dispose(); fixture.close(); }
}

/** U1's own walk: from 1 m behind the glass she turns round and walks 3 m away, then comes back (no director: her residual look only). */
export async function walkBackScene(fps: number, seconds = 22): Promise<EyeFrame[]> {
  const { fixture, figure } = await geneFigure({ xM: 0.2, depthM: 1 });
  figure.faceToward({ x: 0, z: 0.55 });
  const read = eyesOf(fixture.mesh), bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: EyeFrame[] = [];
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      if (frame === Math.round(fps)) figure.place({ xM: -0.4, depthM: 4 });
      if (frame === Math.round(fps * 12)) figure.place({ xM: 0.2, depthM: 1 });
      figure.frame(dt);
      frames.push({ t, phase: t < 12 ? 'away' : 'return', eyes: read(), rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), head: figure.sense?.head ?? null, heading: figure.heading, walking: figure.walking });
    }
    return frames;
  } finally { figure.dispose(); fixture.close(); }
}

/** A whole peek from 3 m: notice, walk up, lean in, the close-up, back off, turn round and walk home. Phases as the director names them. */
export async function peekScene(fps: number, depthM = 3, seconds = 34) {
  const eyes: { yaw: number; pitch: number }[][] = [];
  const twists: number[] = [], headings: number[] = [];
  const run = await runPeek(fps, seconds, { depthM, inspect: (_frame, mesh) => {
    eyes.push(eyesOf(mesh)());
    // How far her head (neck and head) is turned against her upper body, degrees: looking back over her shoulder or not.
    const find = (name: string) => mesh.skeleton.bones.find(b => b.name === name)!;
    const q = find('上半身2').getWorldQuaternion(new Quaternion()).invert().multiply(find('頭').getWorldQuaternion(new Quaternion()));
    twists.push(euler.setFromQuaternion(q, 'YXZ').y * DEG); headings.push(mesh.rotation.y);
  } });
  // What the peek brings onto the axis: I-192 follow-up, the point between both eyes (ARRIVAL_KNOBS.peekEyes = 2); else the nearer eye.
  const nearest = (f: (typeof run.frames)[number]) => {
    const both = ARRIVAL_KNOBS.peekEyes >= 2 ? eyePoint(f.eyes, 'both') : null;
    const list = (both ? [both] : [f.eyes.left, f.eyes.right]).filter(Boolean).map(e => {
      const dx = e!.x - run.lens.camera.x, dy = e!.y - run.lens.camera.y, dz = e!.z - run.lens.camera.z, a = run.lens.axis;
      const along = dx * a.x + dy * a.y + dz * a.z;
      return { along, off: Math.hypot(dx - a.x * along, dy - a.y * along, dz - a.z * along) };
    });
    return list.sort((p, q) => p.off - q.off)[0] ?? null;
  };
  const frames: EyeFrame[] = run.frames.map((f, i) => ({ t: f.t, phase: f.phase, eyes: eyes[i], rotations: f.rotations, head: f.head,
    heading: headings[i], walking: false, lens: nearest(f), twist: twists[i],
    lensBearing: wrapDeg(Math.atan2(run.lens.camera.x - f.root.x, run.lens.camera.z - f.root.z) * DEG - headings[i] * DEG) }));
  return { frames, run };
}

/** The phase groups the report uses for the peek: the way back (back, settle, home again) and the close-up (hold). */
export const backFrames = (frames: readonly EyeFrame[]) => frames.filter(f => f.phase === 'back' || f.phase === 'settle');
export const holdFrames = (frames: readonly EyeFrame[], fps: number) => frames.filter(f => f.phase === 'hold').slice(Math.round(0.6 * fps));

/** The nearer eye's distance off the lens axis in the settled close-up (mm): p50 and max. */
export function axisMm(frames: readonly EyeFrame[]) {
  const offs = frames.map(f => (f.lens?.off ?? 0) * 1000).sort((a, b) => a - b);
  return { p50: offs[Math.floor(offs.length / 2)] ?? 0, max: offs.at(-1) ?? 0 };
}
export const unitsPerM = UNITS_PER_M;
