/**
 * Model-agnostic additions to the two manual expression previews, 惊喜 and 害羞
 * (docs/mood/exaggerated-expression-and-pose-study.md).
 *
 * The frozen preview curves (surprise-curves.json, shy-curves.json, played by
 * surprise-preview-overlay.ts) only raise the brows, open the eyes and tilt the
 * head and torso sideways, so the shy one does not read as shy. These curves add,
 * on the same 1.8 s clock, through semantic channels the stage already owns:
 *
 * 害羞 (shy): eyes drop and look away, half-lowered lids (a soft request to the
 *   eyelid compositor, so a natural blink still wins), the head pitches down and
 *   turns away, the procedural blush rises, and a small closed smile (a mouth
 *   expression that yields to lip-sync and feeding).
 * 惊喜 (surprise): the chin lifts a little and the mouth opens a small "o"
 *   (also a mouth expression).
 *
 * The original curve bytes, preview buttons, host grant and lifecycle are
 * unchanged. Everything here is in the head bone's local frame or a semantic
 * morph amount, so it carries to any model; hands are not touched (a future IK
 * item). Every track starts and ends at 0, finishing by 1.76 s.
 */
import { SHY_CLIP_ID, SURPRISE_CLIP_ID } from '../../shared/surprise-preview';

export const PREVIEW_PERFORMANCE_MS = 1800;
export interface PreviewPerformance {
  /** Head pitch (rad, + = chin down). */
  headX: number;
  /** Head turn (rad, + = toward her left). */
  headY: number;
  /** Eye pitch (rad, + = looking down), the stage's eye-bone convention. */
  eyePitch: number;
  eyeYaw: number;
  /** Soft lid closure for the eyelid compositor (never suppresses the natural blink). */
  lidSoft: number;
  /** Procedural blush amount before the card's blush intensity. */
  blush: number;
  mouthSmile: number;
  mouthOpen: number;
}
export const emptyPerformance = (): PreviewPerformance => ({ headX: 0, headY: 0, eyePitch: 0, eyeYaw: 0, lidSoft: 0, blush: 0, mouthSmile: 0, mouthOpen: 0 });
/** Bounds of every added track. */
export const PERFORMANCE_LIMITS: Readonly<PreviewPerformance> = Object.freeze({ headX: 0.09, headY: 0.1, eyePitch: 0.12, eyeYaw: 0.08, lidSoft: 0.4, blush: 0.7, mouthSmile: 0.4, mouthOpen: 0.3 });

type Track = readonly (readonly [ms: number, value: number])[];
const SHY = Object.freeze({
  headX: [[0, 0], [300, 0], [650, 0.07], [1250, 0.075], [1600, 0.02], [1760, 0], [1800, 0]],
  // Turned toward the same side as the frozen curve's main tilt (head Z -2.2 deg: toward her left).
  headY: [[0, 0], [350, 0], [700, 0.08], [1300, 0.085], [1620, 0.02], [1760, 0], [1800, 0]],
  gazeDown: [[0, 0], [380, 0], [620, 1], [1250, 1], [1600, 0.25], [1760, 0], [1800, 0]],
  lidSoft: [[0, 0], [420, 0], [700, 0.3], [1250, 0.3], [1550, 0.1], [1740, 0], [1800, 0]],
  blush: [[0, 0], [250, 0.05], [700, 0.6], [1150, 0.62], [1760, 0], [1800, 0]],
  mouthSmile: [[0, 0], [500, 0], [800, 0.35], [1350, 0.35], [1700, 0], [1800, 0]],
} satisfies Record<string, Track>);
const SURPRISE = Object.freeze({
  headX: [[0, 0], [120, 0], [300, -0.04], [560, -0.035], [900, -0.01], [1200, 0], [1800, 0]],
  mouthOpen: [[0, 0], [140, 0], [280, 0.22], [560, 0.2], [850, 0.06], [1100, 0], [1800, 0]],
} satisfies Record<string, Track>);

/** The overlay's interpolation: smoothstep between keys. */
function sample(track: Track, ms: number): number {
  for (let i = 1; i < track.length; i++) {
    const [a, x] = track[i - 1], [b, y] = track[i];
    if (ms <= b) { const t = (ms - a) / (b - a), u = t * t * (3 - 2 * t); return x + (y - x) * u; }
  }
  return 0;
}

/**
 * Samples the additions for one preview clip at `elapsedMs` into `out`.
 * Unknown clips, non-finite or out-of-range times give all zeros. Without eye
 * bones, the lowered gaze becomes a deeper lid request instead.
 */
export function previewPerformance(clipId: string | null, elapsedMs: number, hasEyes: boolean, out: PreviewPerformance = emptyPerformance()): PreviewPerformance {
  out.headX = out.headY = out.eyePitch = out.eyeYaw = out.lidSoft = out.blush = out.mouthSmile = out.mouthOpen = 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= PREVIEW_PERFORMANCE_MS) return out;
  if (clipId === SHY_CLIP_ID) {
    const down = sample(SHY.gazeDown, elapsedMs);
    out.headX = sample(SHY.headX, elapsedMs); out.headY = sample(SHY.headY, elapsedMs);
    out.eyePitch = hasEyes ? 0.1 * down : 0; out.eyeYaw = hasEyes ? 0.05 * down : 0;
    out.lidSoft = Math.max(sample(SHY.lidSoft, elapsedMs), hasEyes ? 0 : 0.35 * down);
    out.blush = sample(SHY.blush, elapsedMs); out.mouthSmile = sample(SHY.mouthSmile, elapsedMs);
  } else if (clipId === SURPRISE_CLIP_ID) {
    out.headX = sample(SURPRISE.headX, elapsedMs); out.mouthOpen = sample(SURPRISE.mouthOpen, elapsedMs);
  }
  return out;
}
