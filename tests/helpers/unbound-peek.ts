// Unbound U2: the bundled public Gene doing peek-lens in her Unbound body, through the real figure (MMDLoader / CCD IK / the
// gait and contact owner), the real director (src/unbound/director/), the procedural generator and the intent layer, frame by
// frame at a fixed rate, with the screen-camera of this laptop (34.0×21.25 cm, viewed from 55 cm). Each frame records what was
// shown: tracked bones' world rotations, the root, head and both eyes (world m), the director's beat, and the near plane.
import { Quaternion, Vector3 } from 'three';
import { UNITS_PER_M, type UnboundFigure } from '../../src/unbound/figure';
import { Director } from '../../src/unbound/director/director';
import { PEEK_LENS } from '../../src/unbound/director/peek-lens';
import { ProceduralGenerator } from '../../src/unbound/motion/procedural';
import { lensView, type LensView, type V3 } from '../../src/unbound/motion/lens-align';
import { nearPlaneFor } from '../../src/unbound/camera';
import { capsuleEnds, measureBoneCapsules } from '../../src/foundation/body-capsules';
import { eyeHeightFor, eyePosition, windowFrustum, type DisplayFacts, type WorldView } from '../../shared/unbound/world';
import { planPeek, type MoodReading, type PeekCancelReason, type PeekPhase, type PeekReport } from '../../shared/unbound/director';
import { geneFigure, TRACKED } from './unbound-gene';

export const LAPTOP: DisplayFacts = { bounds: { x: 0, y: 0, width: 2560, height: 1600 }, workArea: { x: 0, y: 0, width: 2560, height: 1520 }, scaleFactor: 1.5, internal: true };
export function laptopView(viewerDistanceM = 0.55): WorldView {
  const screen = { widthM: 0.34, heightM: 0.2125, source: 'measured' as const, detail: 'test' };
  return { screen, display: LAPTOP.bounds, viewerDistanceM, eyeHeightM: eyeHeightFor(screen, LAPTOP, viewerDistanceM) };
}
/** The lens of the work-area window ('physical'), as the page computes it. */
export function laptopLens(view = laptopView()): LensView {
  const f = windowFrustum(view, LAPTOP.workArea, 0.05, 400);
  return lensView(eyePosition(view), f);
}

export const CURIOUS: MoodReading = { D: 75, O: 62, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 };
export const TENSE: MoodReading = { D: 50, O: 50, E: 45, N: 78, C: 75, A: 0.2, B: 0, M: 0 };

export interface PeekFrame {
  t: number; phase: PeekPhase | null;
  rotations: Quaternion[]; root: Vector3; head: V3 | null; eyes: { left: V3 | null; right: V3 | null };
  nearM: number; tiptoe: number;
  /** Planted toes (world m), per foot (null when lifted). */
  toes: (V3 | null)[];
}

/** Runs a peek. `cancelAt`: seconds (or a beat) at which a mouse move cancels it. Meters throughout. */
export async function runPeek(fps: number, seconds: number, options: {
  mood?: MoodReading; depthM?: number; xM?: number; cancelAt?: number | PeekPhase; cancelReason?: PeekCancelReason; random?: () => number;
  /** Overrides on the mood's plan (e.g. the closest the director allows). */
  planPatch?: Partial<import('../../shared/unbound/director').PeekPlan>;
  /** Called after each frame (a test can look at the skinned mesh while it is posed). */
  inspect?: (frame: PeekFrame, mesh: import('three').SkinnedMesh) => void;
  /** A cancel delay after the beat begins (s), when cancelAt is a beat. */
  cancelAfter?: number;
} = {}) {
  const { fixture, figure } = await geneFigure({ xM: options.xM ?? 0.25, depthM: options.depthM ?? 1.2 });
  const lens = laptopLens();
  const reports: PeekReport[] = [];
  const director = new Director([PEEK_LENS], new ProceduralGenerator(), report => reports.push(report));
  const capsules = measureBoneCapsules(fixture.mesh), ends: Vector3[] = [];
  let r = 0.37;
  const random = options.random ?? (() => { r = (r * 9301 + 49297) % 233280 / 233280; return r; });
  const plan = { ...planPeek(options.mood ?? CURIOUS, random), ...options.planPatch };
  const home = { x: options.xM ?? 0.25, z: -(options.depthM ?? 1.2) };
  try {
    const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    const frames: PeekFrame[] = [];
    let cancelled = false, phaseSince: { phase: PeekPhase | null; at: number } = { phase: null, at: 0 };
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      if (frame === 30) director.command({ type: 'start', id: 'peek-test', plan, trial: false, armAfterMs: 0 }, { lens, home });
      if (director.phase !== phaseSince.phase) phaseSince = { phase: director.phase, at: t };
      const at = options.cancelAt;
      if (!cancelled && at !== undefined && (typeof at === 'number' ? t >= at : director.phase === at && t - phaseSince.at >= (options.cancelAfter ?? 0.3))) {
        director.cancel(options.cancelReason ?? 'input'); // the host's cancel (2026-11-23: the page's own mouse never cancels)
        cancelled = true;
      }
      director.frame(dt, { lens, home }, figure);
      figure.frame(dt);
      const sense = figure.sense!;
      capsuleEnds(fixture.mesh, capsules, ends);
      frames.push({
        t, phase: director.phase, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())),
        root: fixture.mesh.position.clone().multiplyScalar(1 / UNITS_PER_M), head: sense.head, eyes: { ...sense.eyes },
        nearM: nearPlaneFor(ends, capsules.map(c => c.r), eyePosition(laptopView()).z * UNITS_PER_M), tiptoe: (figure as unknown as { gait: { tiptoeValue: number } }).gait.tiptoeValue,
        toes: figure.report!.feet.map(f => f.planted && f.toe ? { x: f.toe.x / UNITS_PER_M, y: f.toe.y / UNITS_PER_M, z: f.toe.z / UNITS_PER_M } : null),
      });
      options.inspect?.(frames[frames.length - 1], fixture.mesh);
    }
    return { frames, reports, plan, lens, figure: figure as UnboundFigure, mesh: fixture.mesh, capsules };
  } finally { figure.dispose(); fixture.close(); }
}

export const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Per-frame step (cm) of a tracked point. */
export function pointSteps(points: readonly (V3 | null)[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) if (points[i] && points[i - 1]) out.push(dist(points[i]!, points[i - 1]!) * 100);
  return out;
}
/** Per-frame unexpected step (cm): how far a frame's step departs from the previous one. */
export function pointSurprises(points: readonly (V3 | null)[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < points.length; i++) {
    const a = points[i - 2], b = points[i - 1], c = points[i];
    if (!a || !b || !c) continue;
    out.push(Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y, c.z - 2 * b.z + a.z) * 100);
  }
  return out;
}
