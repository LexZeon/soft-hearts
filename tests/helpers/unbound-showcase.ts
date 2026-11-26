// Unbound showcase (docs/claude/2026-11-14-lapwing-showcase.md): the bundled public Gene performing a choreography through the
// real figure (MMDLoader / CCD IK / gait and contact owner / intent layer / arm reach), the showcase performer (layer 1) and the
// procedural generator (layer 2), frame by frame at a fixed rate with this laptop's screen-camera. Each frame records her bones'
// world rotations, root, head and eye points, the eyes against the head, the fingers' clearance from her face, and the beats on.
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { UNITS_PER_M } from '../../src/unbound/figure';
import { ProceduralGenerator } from '../../src/unbound/motion/procedural';
import { setShowcaseIdle, setShowcaseSlotGain } from '../../src/unbound/motion/showcase-motion';
import { fitModel } from '../../src/unbound/showcase/model-fit';
import type { EyeHeadParams } from '../../src/stage/eye-head';
import { createLearnedIdle, type LearnedIdleOptions } from '../../src/unbound/motion/learned-idle';
import { ShowcasePerformer } from '../../src/unbound/showcase/performer';
import type { V3 } from '../../src/unbound/motion/lens-align';
import { parseShowcaseSegment, type ShowcaseBeat } from '../../shared/unbound/showcase';
import { geneFigure, TRACKED } from './unbound-gene';
import { laptopLens } from './unbound-peek';

export const SHOWCASE_TRACKED = [...TRACKED, '左手首', '右手首', '頭'] as const;
export const SHOWCASE_HOME = { x: 0, z: -0.85 };

export function fakeBeats(name: 'a' | 'b'): ShowcaseBeat[] {
  const text = readFileSync(new URL(`../../scripts/unbound/showcase-fakes/${name}.json`, import.meta.url), 'utf8');
  return parseShowcaseSegment(text, { from: 0, to: 62 })!.beats;
}

export interface ShowcaseFrame {
  t: number; rotations: Quaternion[]; root: V3; head: V3 | null; eyes: { left: V3 | null; right: V3 | null };
  eyeInHead: { yaw: number; pitch: number }[]; clearance: number | null; handsUp: number; beats: string[]; blink: number; stillness: number; gazeLens: boolean;
}

export async function runShowcase(fps: number, seconds: number, beats: readonly ShowcaseBeat[], options: { liveliness?: number; seed?: number; appendAt?: number; split?: number; idle?: Pick<LearnedIdleOptions, 'weights' | 'events'>; gaze?: Partial<EyeHeadParams> | null; onFrame?: (mesh: import('three').SkinnedMesh, t: number) => void; modelPath?: string; fit?: boolean } = {}) {
  const { fixture, figure } = await geneFigure({ xM: SHOWCASE_HOME.x, depthM: -SHOWCASE_HOME.z, modelPath: options.modelPath });
  figure.setGaitLook(false);
  if (options.gaze) figure.setGazeParams(options.gaze); // development comparisons only; the page uses the coordinator's defaults
  const lens = laptopLens();
  figure.faceToward({ x: 0, z: 0.55 });
  // Round 16: the model fits itself (head size to the stand-off, weak shapes strengthened); on Gene both are exactly 1. fit: false plays without.
  const fit = options.fit === false ? null : fitModel(fixture.mesh, {});
  setShowcaseSlotGain(fit?.slotGain ?? null);
  const performer = new ShowcasePerformer(SHOWCASE_HOME, options.liveliness ?? 0.5, options.seed ?? 0.42, 'away', { distanceScale: fit?.distanceScale ?? 1 });
  // Round 7: the learned idle under quiet holds (weights from .local/ml when the caller loaded them; none: the procedural idle).
  const idleOptions = options.idle;
  setShowcaseIdle(idleOptions ? () => createLearnedIdle({ heightM: figure.heightM, seed: 7, ...idleOptions }) : null);
  const generator = new ProceduralGenerator();
  const split = options.split ?? Infinity;
  const first = beats.filter(b => b.at < split), second = beats.filter(b => b.at >= split);
  try {
    const bones = SHOWCASE_TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    const frames: ShowcaseFrame[] = [];
    let appended = false, appended2 = false;
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      if (!appended && t >= (options.appendAt ?? 0)) { performer.append(first); appended = true; }
      if (!appended2 && second.length && t >= split - 4) { performer.append(second); appended2 = true; }
      const out = performer.frame(dt, lens);
      const sense = figure.sense;
      if (sense) figure.setPoseTargets(generator.generate({ intent: out.intent, t, dt, sense }));
      figure.frame(dt);
      options.onFrame?.(fixture.mesh, t); // round 11: a look at the posed bones (finger shapes) while they are posed
      const s = figure.sense!;
      frames.push({
        t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())),
        root: (() => { const p = fixture.mesh.position.clone().multiplyScalar(1 / UNITS_PER_M); return { x: p.x, y: p.y, z: p.z }; })(),
        head: s.head, eyes: { ...s.eyes }, eyeInHead: figure.eyeInHead(), clearance: figure.handClearance, handsUp: figure.handsUp,
        beats: out.beats, blink: out.intent.blink, stillness: out.intent.stillness, gazeLens: out.intent.gaze.mode === 'lens' && out.intent.gaze.yaw === 0 && out.intent.gaze.pitch === 0,
      });
    }
    return { frames, lens, performer, mesh: fixture.mesh };
  } finally { setShowcaseIdle(null); setShowcaseSlotGain(null); figure.dispose(); fixture.close(); }
}

export const boneOf = (name: (typeof SHOWCASE_TRACKED)[number]) => SHOWCASE_TRACKED.indexOf(name);
const DEG = 180 / Math.PI;
/** Unexpected step (deg) per frame for the given bones (how far a frame's rotation step departs from the previous one). */
export function surprises(frames: readonly ShowcaseFrame[], bones: readonly number[]): number[] {
  const out: number[] = [], step = new Quaternion(), last = new Quaternion(), inv = new Quaternion();
  for (let i = 2; i < frames.length; i++) for (const b of bones) {
    step.copy(frames[i].rotations[b]).multiply(inv.copy(frames[i - 1].rotations[b]).invert());
    last.copy(frames[i - 1].rotations[b]).multiply(inv.copy(frames[i - 2].rotations[b]).invert());
    out.push(step.angleTo(last) * DEG);
  }
  return out;
}
/** Per-frame step (deg) for the given bones. */
export function steps(frames: readonly ShowcaseFrame[], bones: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < frames.length; i++) for (const b of bones) out.push(frames[i].rotations[b].angleTo(frames[i - 1].rotations[b]) * DEG);
  return out;
}
export function pointSurprisesOf(points: readonly (V3 | null)[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < points.length; i++) { const a = points[i - 2], b = points[i - 1], c = points[i]; if (a && b && c) out.push(Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y, c.z - 2 * b.z + a.z) * 100); }
  return out;
}
export const quantile = (values: readonly number[], q: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : 0; };
export const maxOf = (values: readonly number[]) => values.reduce((a, b) => Math.max(a, b), 0);
/** Eye-in-head angle per frame (deg, the larger eye, yaw and pitch combined). */
export const eyeAngles = (frames: readonly ShowcaseFrame[]) => frames.map(f => Math.max(0, ...f.eyeInHead.map(e => Math.hypot(e.yaw, e.pitch))));
/** Longest quiet steady look (s): she looks at you, no hand up, the head turning slower than `degPerS`. */
export function longestQuiet(frames: readonly ShowcaseFrame[], fps: number, degPerS = 6): number {
  const head = boneOf('頭');
  let best = 0, run = 0;
  for (let i = 1; i < frames.length; i++) {
    const speed = frames[i].rotations[head].angleTo(frames[i - 1].rotations[head]) * DEG * fps;
    const quiet = frames[i].gazeLens && frames[i].handsUp < 0.05 && speed < degPerS;
    run = quiet ? run + 1 / fps : 0; best = Math.max(best, run);
  }
  return best;
}
export { Vector3 };
