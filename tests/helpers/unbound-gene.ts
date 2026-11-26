// Unbound U1 part 2: the bundled public Gene in her Unbound body (src/unbound/figure.ts), through the real MMDLoader /
// MMDAnimationHelper / CCD IK path, frame by frame at a fixed rate. Each frame records what was shown: tracked bones' world
// rotations, the root, the feet (IK target, ankle, toe), the COM and the support margin. Metrics follow R29b/R29c: per-frame
// step and "unexpected step" (how far a frame's step departs from the previous one).
import { readFile } from 'node:fs/promises';
import { Quaternion, Vector3, type AnimationClip, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { UNITS_PER_M, UnboundFigure } from '../../src/unbound/figure';
import { parseVmdWith } from '../../src/foundation/vmd';
import { withKeyframeInterpolation } from '../../src/stage/keyframe-interpolation';
import { loadPmxForTargets, loadPublicGeneForTargets } from '../public-gene-fixture';

export const STAND_VMD = new URL('../../assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/motions/pose/stand.vmd', import.meta.url);
export const TRACKED = ['センター', '上半身', '上半身2', '首', '頭', '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ',
  '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首'] as const;
const DEG = 180 / Math.PI;

export async function standClip(mesh: SkinnedMesh): Promise<AnimationClip> {
  const bytes = await readFile(STAND_VMD);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const builder = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(vmd: unknown, mesh: SkinnedMesh): AnimationClip } }).animationBuilder;
  const clip = builder.build(vmd, mesh);
  clip.duration = Math.max(clip.duration, 120 / 30);
  return clip;
}

export async function geneFigure(options: { breath?: number; xM?: number; depthM?: number; modelPath?: string } = {}) {
  // Development: another model (a PMX path) for checks on other models; the tests use the public Gene.
  const fixture = options.modelPath ? await loadPmxForTargets(options.modelPath) : await loadPublicGeneForTargets();
  const figure = new UnboundFigure(fixture.mesh, { xM: options.xM ?? 0.9, depthM: options.depthM ?? 8 });
  figure.setClips({ pose: await standClip(fixture.mesh), gesture: null, expression: null }, false);
  figure.setBreath(options.breath ?? 0.5);
  return { fixture, figure };
}

export interface FootShown { planted: boolean; pitch: number; ankle: Vector3; toe: Vector3 | null; target: Vector3; ik: Vector3 }
export interface Shown {
  t: number;
  rotations: Quaternion[];
  root: Vector3;
  heading: number;
  feet: FootShown[];
  com: { x: number; y: number; z: number } | null;
  comMargin: number | null;
  reachDrop: number;
  stance: string;
  walking: boolean;
  steps: number;
}

/** Runs her for `seconds` at `fps`; `script(t, figure)` may hand targets in before each frame. Meters throughout. */
export async function runGene(fps: number, seconds: number, script: (t: number, figure: UnboundFigure) => void = () => {},
  options: { breath?: number; xM?: number; depthM?: number; setup?: (figure: UnboundFigure) => void } = {}) {
  const { fixture, figure } = await geneFigure(options);
  options.setup?.(figure);
  try {
    const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    const frames: Shown[] = [];
    const m = 1 / UNITS_PER_M;
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps;
      script(t, figure);
      figure.frame(frame ? 1 / fps : 0);
      const report = figure.report!;
      frames.push({
        t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())),
        root: fixture.mesh.position.clone().multiplyScalar(m), heading: figure.heading,
        feet: report.feet.map(f => ({ planted: f.planted, pitch: f.pitch, ankle: f.ankle.clone().multiplyScalar(m), toe: f.toe?.clone().multiplyScalar(m) ?? null, target: f.target.clone().multiplyScalar(m), ik: f.ikWorld.clone().multiplyScalar(m) })),
        com: report.com, comMargin: report.comMargin, reachDrop: report.reachDrop, stance: report.stance, walking: figure.walking, steps: report.steps,
      });
    }
    return { frames, heightM: figure.heightM, placement: figure.placement };
  } finally { figure.dispose(); fixture.close(); }
}

export const max = (values: readonly number[]) => values.reduce((a, b) => Math.max(a, b), 0);
export const min = (values: readonly number[]) => values.reduce((a, b) => Math.min(a, b), Infinity);

/** Largest per-frame rotation of any tracked bone (degrees), per frame pair. */
export const stepAngles = (frames: readonly Shown[], from = 0) => frames.slice(from + 1).flatMap((f, i) => f.rotations.map((q, b) => q.angleTo(frames[from + i].rotations[b]) * DEG));
/** How far each frame's rotation step departs from the previous frame's step (degrees). */
export function surpriseAngles(frames: readonly Shown[], from = 0, bonesOnly?: readonly number[]): number[] {
  const out: number[] = [], step = new Quaternion(), last = new Quaternion(), inverse = new Quaternion();
  for (let i = from + 2; i < frames.length; i++) for (let b = 0; b < TRACKED.length; b++) {
    if (bonesOnly && !bonesOnly.includes(b)) continue;
    step.copy(frames[i].rotations[b]).multiply(inverse.copy(frames[i - 1].rotations[b]).invert());
    last.copy(frames[i - 1].rotations[b]).multiply(inverse.copy(frames[i - 2].rotations[b]).invert());
    out.push(step.angleTo(last) * DEG);
  }
  return out;
}
/** Root per-frame step and unexpected step (cm). */
export const rootSteps = (frames: readonly Shown[]) => frames.slice(1).map((f, i) => f.root.distanceTo(frames[i].root) * 100);
export const rootSurprises = (frames: readonly Shown[]) => frames.slice(2).map((f, i) => f.root.clone().sub(frames[i + 1].root).sub(frames[i + 1].root.clone().sub(frames[i].root)).length() * 100);
/** Per-frame unexpected step of the ankles (cm, world): the feet's own jolts. */
export const ankleSurprises = (frames: readonly Shown[]) => frames.slice(2).flatMap((f, i) => f.feet.map((foot, k) =>
  foot.ankle.clone().sub(frames[i + 1].feet[k].ankle).sub(frames[i + 1].feet[k].ankle.clone().sub(frames[i].feet[k].ankle)).length() * 100));

/**
 * Planted-foot drift (cm): over every interval a foot stays planted, the farthest its toe (the contact point that is always
 * down) gets from where it was when the interval began; and the farthest its ankle gets while the heel is down (pitch 0; with
 * the heel up the ankle legitimately rolls about the toe). Sink: the ankle below a flat foot's height while flat, the toe
 * below the floor at any time. targetMiss: the ankle's distance from its IK target (how well the IK reached it).
 */
export function plantedDrift(frames: readonly Shown[], restAnkleY: number) {
  let drift = 0, toeDrift = 0, sink = 0, toeBelow = 0, targetMiss = 0;
  for (let k = 0; k < 2; k++) {
    let ankleAnchor: Vector3 | null = null, toeAnchor: Vector3 | null = null;
    for (const f of frames) {
      const foot = f.feet[k];
      if (foot?.toe) toeBelow = Math.max(toeBelow, -foot.toe.y * 100);
      if (!foot?.planted) { ankleAnchor = toeAnchor = null; continue; }
      if (foot.toe) { toeAnchor ??= foot.toe.clone(); toeDrift = Math.max(toeDrift, foot.toe.distanceTo(toeAnchor) * 100); }
      targetMiss = Math.max(targetMiss, foot.ankle.distanceTo(foot.target) * 100);
      if (foot.pitch > 0) { ankleAnchor = null; continue; }
      ankleAnchor ??= foot.ankle.clone();
      drift = Math.max(drift, foot.ankle.distanceTo(ankleAnchor) * 100);
      sink = Math.max(sink, (restAnkleY - foot.ankle.y) * 100);
    }
  }
  return { drift, toeDrift, sink, toeBelow, targetMiss };
}
