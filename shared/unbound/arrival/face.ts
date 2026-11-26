/**
 * I-192 (docs/claude/2026-11-22-i192-arrival-targets.md): her face as an arrival target.
 *
 * A model's face is measured once at rest from its own mesh (src/unbound/model/face-measure.ts), relative to its head bone, in her frame (x her
 * left, y up, z forward; metres). From it, for any screen and any model:
 *   aim       the point that goes onto the lens axis: between her eyes and her mouth, so the end frame is her eyes and her mouth
 *   fit       how far from the lens that point stands so the span from the top of her eyes to just below her mouth fills `faceFill` of the screen
 *   reach     how far any of her head (nose, bangs, hair, ears) comes in front of the aim point, with her head turned and tilted as it will be
 *   distance  max(fit, minClear + reach + hairSwing, minFace): if fitting would bring any of her into the camera, she stops earlier
 * Pure: plain numbers, no Three.js.
 */
import { ARRIVAL_KNOBS, type ArrivalKnobs } from './knobs';

export interface V3 { x: number; y: number; z: number }

export interface FaceGeometry {
  /** The midpoint of her two visible eyes (their surfaces), from her head bone. */
  eyes: V3;
  /** How tall one eye is (m). */
  eyeSizeM: number;
  /** How far below the eyes' midpoint her mouth is (m, > 0: the middle of what her open-mouth shape moves). */
  mouthDropM: number;
  /** A sample of her head's points (face, nose, bangs, hair, ears), from her head bone: the clip guard turns them with her head. */
  points: readonly V3[];
}

/** A face is about this many times as wide as the span between its two eyes' centres (an adult's ≈ 14 cm over ≈ 6.3 cm). */
export const FACE_PER_EYE_SPAN = 2.2;
/** The end frame reaches this far below her eyes, as a share of her eyes-to-mouth drop (just below her lower lip: the pucker shows). */
export const MOUTH_SHARE = 1.15;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/** The span the end frame holds (m): from the top of her eyes to below her mouth. */
export const faceSpanM = (face: FaceGeometry): number => MOUTH_SHARE * face.mouthDropM + face.eyeSizeM / 2;

/** The aim point (from her head bone, at rest): the middle of that span. */
export function faceAim(face: FaceGeometry): V3 {
  const drop = (MOUTH_SHARE * face.mouthDropM - face.eyeSizeM / 2) / 2;
  return { x: face.eyes.x, y: face.eyes.y - drop, z: face.eyes.z };
}

/** A point from her head bone with the head turned by `yaw` (rad, + = toward her left) and tilted by `roll` (+ = toward her left shoulder). */
export function turnHead(p: V3, yaw: number, roll = 0): V3 {
  const cr = Math.cos(roll), sr = Math.sin(roll), x1 = p.x * cr + p.y * sr, y1 = -p.x * sr + p.y * cr;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return { x: x1 * cy + p.z * sy, y: y1, z: -x1 * sy + p.z * cy };
}

/** How far (m) any of her head comes in front of `from` (a point from her head bone at rest) with the head turned: the nose, bangs, hair. */
export function reachAhead(face: FaceGeometry, from: V3, yaw = 0, roll = 0): number {
  const anchor = turnHead(from, yaw, roll);
  let most = 0;
  for (const p of face.points) { const z = turnHead(p, yaw, roll).z - anchor.z; if (z > most) most = z; }
  return most;
}

export interface FaceDistance { distanceM: number; fitM: number; clipM: number; reachM: number; clipped: boolean }
/**
 * How far from the lens her aim point stops (m, along the axis). `heightPerM`: how tall the view is per metre ahead (the window's frustum).
 * Fit unless that would bring any of her nearer than `minClearM` (+ room for her hair to swing): then the clip guard decides.
 */
export function faceDistance(face: FaceGeometry, heightPerM: number | undefined, turn: { yaw: number; roll?: number }, knobs: ArrivalKnobs = ARRIVAL_KNOBS): FaceDistance {
  const perM = heightPerM && heightPerM > 0 ? heightPerM : 0.4;
  const fitM = faceSpanM(face) / (clamp(knobs.faceFill, 0.2, 3) * perM);
  const reachM = reachAhead(face, faceAim(face), turn.yaw, turn.roll ?? 0);
  const clipM = knobs.minClearM + reachM + knobs.hairSwingM;
  return { distanceM: Math.max(fitM, clipM, knobs.minFaceM), fitM, clipM, reachM, clipped: clipM > Math.max(fitM, knobs.minFaceM) };
}

/** The nearest an eye (from her head bone) may come to the lens (m): the peek's own close-up keeps her nose and bangs out of the camera too. */
export function eyeClearDistance(face: FaceGeometry, eye: V3, knobs: ArrivalKnobs = ARRIVAL_KNOBS): number {
  return knobs.minClearM + reachAhead(face, eye) + knobs.hairSwingM;
}

/**
 * A face for a model whose mesh says nothing (no eye vertices): from her height and the eyes' midpoint (a 1.6 m figure: eyes 2.5 cm, the mouth
 * 4.5 cm below them, the nose 2.5 cm in front, bangs 3 cm). Conservative on reach.
 */
export function fallbackFace(heightM: number, eyes: V3, eyeSizeM: number | null): FaceGeometry {
  const k = clamp(heightM / 1.6, 0.4, 1.6);
  const e = eyeSizeM && eyeSizeM > 0.003 && eyeSizeM < 0.1 ? eyeSizeM : 0.025 * k;
  const points: V3[] = [
    { x: eyes.x, y: eyes.y - 0.025 * k, z: eyes.z + 0.025 * k }, // nose
    { x: eyes.x, y: eyes.y + 0.03 * k, z: eyes.z + 0.03 * k }, // bangs
    { x: eyes.x + 0.06 * k, y: eyes.y, z: eyes.z - 0.04 * k }, { x: eyes.x - 0.06 * k, y: eyes.y, z: eyes.z - 0.04 * k }, // cheeks, ears
  ];
  return { eyes: { ...eyes }, eyeSizeM: e, mouthDropM: 0.045 * k, points };
}

/** Plain checks on a measured face (finite, sensible sizes); null when it cannot be used. */
export function usableFace(face: FaceGeometry | null | undefined): FaceGeometry | null {
  if (!face || ![face.eyes.x, face.eyes.y, face.eyes.z, face.eyeSizeM, face.mouthDropM].every(Number.isFinite)) return null;
  if (!(face.eyeSizeM > 0.003 && face.eyeSizeM < 0.1) || !(face.mouthDropM > 0.01 && face.mouthDropM < 0.2) || !Array.isArray(face.points)) return null;
  return face;
}
