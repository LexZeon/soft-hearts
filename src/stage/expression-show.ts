/**
 * E1 惊喜 / 害羞 on any model (docs/claude/2026-11-03-e1-r18-fixes.md). The user (2026-11-03, U-008) could not find the
 * old Gene-only preview, saw no shy motion and no readable surprise. This is the model-agnostic performance:
 *
 * 惊喜 (surprise): "一下子" — brows shoot up, eyes open wide, a small "o", the chin lifts and the body leans back a little,
 *   within about 0.2 s; then it all settles back over about a second and a half.
 * 害羞 (shy): a tiny startle, then the eyes drop and slide to one side, the lids half lower, the head goes down, turns
 *   away and tilts toward the same side, the body draws in a little, a blush rises, a closed smile and a slightly
 *   troubled brow; held, then it comes back.
 *
 * Every channel is semantic (a head / upper-body / eye bone of the model's profile, or a morph slot the profile
 * validated by where it moves), so a model without a part simply skips it; `showSupport` says what shows and what
 * does not. Tracks are keyframes sampled like R29f's K-frame interpolation ("clamped auto" cubic Hermite through the
 * keys, Fritsch–Carlson limited): the speed carries through a key the motion passes on and eases to rest at a turn,
 * a hold and both ends, so the entry and the exit are continuous in position and in speed. Everything starts and
 * ends at exactly 0. Played through procedural life's preview channel (procedural-life.ts `perform`, `applyPreview`,
 * `applyFace`), which also fades the whole performance out over 0.3 s if a pat, a window move or a hidden window
 * interrupts it, and back in when it is free again.
 */
import { clampedTangent } from './keyframe-interpolation';
import { EXPRESSION_RECIPE_NAMES, type ExpressionRecipe, type ExpressionSupport } from '../../shared/expression-preview';

/** The clip ids procedural life sees (distinct from the old host-issued Gene clip ids). */
export const SHOW_CLIP: Readonly<Record<ExpressionRecipe, string>> = Object.freeze({ surprise: 'show:surprise', shy: 'show:shy' });
export const SHOW_MS: Readonly<Record<ExpressionRecipe, number>> = Object.freeze({ surprise: 1900, shy: 3000 });
export const showRecipeOfClip = (clip: string | null | undefined): ExpressionRecipe | null =>
  clip === SHOW_CLIP.surprise ? 'surprise' : clip === SHOW_CLIP.shy ? 'shy' : null;

/** One sample of the performance. Radians for bones (head x > 0 = chin down, y > 0 = turned toward her left, z < 0 = tilted toward her left; eye pitch > 0 = looking down); 0..1 amounts for the face. */
export interface ShowFrame {
  headX: number; headY: number; headZ: number;
  bodyX: number; bodyZ: number;
  eyePitch: number; eyeYaw: number;
  /** Soft lid request to the eyelid compositor (a natural blink still wins). */
  lidSoft: number;
  browUp: number; browSad: number; eyeWide: number;
  smileEyes: number; mouthSmile: number; mouthOpen: number;
  /** Procedural blush (or the model's blush morph) before the card's blush intensity. */
  blush: number;
}
export const SHOW_KEYS = ['headX', 'headY', 'headZ', 'bodyX', 'bodyZ', 'eyePitch', 'eyeYaw', 'lidSoft', 'browUp', 'browSad', 'eyeWide', 'smileEyes', 'mouthSmile', 'mouthOpen', 'blush'] as const;
export const emptyShow = (): ShowFrame => ({ headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyZ: 0, eyePitch: 0, eyeYaw: 0, lidSoft: 0, browUp: 0, browSad: 0, eyeWide: 0,
  smileEyes: 0, mouthSmile: 0, mouthOpen: 0, blush: 0 });
/** Bounds of every channel (also procedural life's clamps). */
export const SHOW_LIMITS: Readonly<ShowFrame> = Object.freeze({ headX: 0.17, headY: 0.15, headZ: 0.08, bodyX: 0.045, bodyZ: 0.03, eyePitch: 0.18, eyeYaw: 0.12, lidSoft: 0.45,
  browUp: 1, browSad: 0.4, eyeWide: 1, smileEyes: 0.25, mouthSmile: 0.55, mouthOpen: 0.4, blush: 1 });

type Key = readonly [ms: number, value: number];
interface Track { keys: readonly Key[]; tangents: Float64Array }
function track(keys: readonly Key[]): Track {
  const tangents = new Float64Array(keys.length);
  for (let k = 1; k < keys.length - 1; k++) {
    const h0 = keys[k][0] - keys[k - 1][0], h1 = keys[k + 1][0] - keys[k][0];
    tangents[k] = clampedTangent((keys[k][1] - keys[k - 1][1]) / h0, (keys[k + 1][1] - keys[k][1]) / h1, h0, h1);
  }
  return { keys, tangents };
}
/** Clamped-auto cubic Hermite through the keys (0 slope at both ends); 0 outside. No allocation. */
function sample(t: Track, ms: number): number {
  const keys = t.keys, last = keys.length - 1;
  if (!(ms > keys[0][0]) || ms >= keys[last][0]) return 0;
  let i = 1;
  while (ms > keys[i][0]) i++;
  const t0 = keys[i - 1][0], v0 = keys[i - 1][1], t1 = keys[i][0], v1 = keys[i][1], h = t1 - t0;
  const s = (ms - t0) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * t.tangents[i - 1] + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * t.tangents[i];
}

type Recipe = Partial<Record<keyof ShowFrame | 'gaze', Track>>;
const RECIPES: Readonly<Record<ExpressionRecipe, Recipe>> = Object.freeze({
  // "一下子": up within ~0.2 s, then a natural settle by ~1.6 s.
  surprise: {
    browUp: track([[0, 0], [110, 0.5], [210, 1], [650, 0.9], [1100, 0.35], [1600, 0], [1900, 0]]),
    eyeWide: track([[0, 0], [100, 0.45], [200, 0.9], [620, 0.75], [1050, 0.25], [1550, 0], [1900, 0]]),
    headX: track([[0, 0], [120, -0.045], [230, -0.08], [650, -0.068], [1150, -0.02], [1700, 0], [1900, 0]]),
    bodyX: track([[0, 0], [150, -0.018], [280, -0.032], [700, -0.026], [1200, -0.008], [1750, 0], [1900, 0]]),
    mouthOpen: track([[0, 0], [120, 0.18], [240, 0.32], [620, 0.27], [980, 0.08], [1350, 0], [1900, 0]]),
  },
  // A tiny startle, then look down and away, half lids, head down / turned / tilted, blush, a closed smile; held; back.
  shy: {
    browUp: track([[0, 0], [130, 0.2], [260, 0.25], [520, 0.04], [800, 0], [3000, 0]]),
    eyeWide: track([[0, 0], [120, 0.15], [250, 0.18], [480, 0], [3000, 0]]),
    browSad: track([[0, 0], [600, 0], [1000, 0.3], [2200, 0.3], [2800, 0], [3000, 0]]),
    gaze: track([[0, 0], [380, 0], [720, 1], [2200, 1], [2700, 0.2], [3000, 0]]),
    headX: track([[0, 0], [300, 0], [760, 0.14], [1600, 0.15], [2200, 0.13], [2760, 0.02], [3000, 0]]),
    headY: track([[0, 0], [340, 0], [800, 0.13], [1600, 0.14], [2200, 0.12], [2760, 0.02], [3000, 0]]),
    headZ: track([[0, 0], [400, 0], [860, -0.06], [2200, -0.065], [2760, -0.01], [3000, 0]]),
    bodyX: track([[0, 0], [450, 0], [900, 0.03], [2200, 0.03], [2820, 0], [3000, 0]]),
    bodyZ: track([[0, 0], [450, 0], [900, -0.02], [2200, -0.02], [2820, 0], [3000, 0]]),
    lidSoft: track([[0, 0], [450, 0], [760, 0.38], [2200, 0.38], [2660, 0.08], [2950, 0], [3000, 0]]),
    blush: track([[0, 0], [300, 0.1], [900, 0.9], [2300, 0.92], [2950, 0], [3000, 0]]),
    mouthSmile: track([[0, 0], [550, 0], [900, 0.48], [2200, 0.5], [2800, 0], [3000, 0]]),
    smileEyes: track([[0, 0], [600, 0], [1000, 0.15], [2200, 0.15], [2750, 0], [3000, 0]]),
  },
});
const clampTo = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/**
 * Samples one recipe at `elapsedMs` into `out` (all zeros outside the clip, for unknown recipes and bad times).
 * Without eye bones the lowered gaze becomes a deeper lid request instead.
 */
export function showSample(recipe: ExpressionRecipe | null, elapsedMs: number, hasEyes: boolean, out: ShowFrame = emptyShow()): ShowFrame {
  for (const key of SHOW_KEYS) out[key] = 0;
  const tracks = recipe ? RECIPES[recipe] : undefined;
  if (!tracks || !Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs >= SHOW_MS[recipe!]) return out;
  for (const key of SHOW_KEYS) { const t = tracks[key]; if (t) out[key] = clampTo(sample(t, elapsedMs), SHOW_LIMITS[key]); }
  const gaze = tracks.gaze ? sample(tracks.gaze, elapsedMs) : 0;
  if (gaze !== 0) {
    if (hasEyes) { out.eyePitch = clampTo(0.17 * gaze, SHOW_LIMITS.eyePitch); out.eyeYaw = clampTo(0.11 * gaze, SHOW_LIMITS.eyeYaw); }
    else out.lidSoft = clampTo(Math.max(out.lidSoft, 0.45 * gaze), SHOW_LIMITS.lidSoft);
  }
  return out;
}

/** What the loaded model has for the performance (the stage fills it from the model profile and its own writers). */
export interface ShowCapabilities {
  head: boolean; upperBody: boolean; eyes: boolean;
  /** An eyelid morph the compositor writes (blink). */
  lids: boolean;
  browUp: boolean; browSad: boolean; eyeWide: boolean;
  smileEyes: boolean; mouthSmile: boolean; mouthOpen: boolean;
  /** Procedural blush or a blush morph. */
  blush: boolean;
}
type Part = { label: string; has(c: ShowCapabilities): boolean };
const PARTS: Readonly<Record<ExpressionRecipe, readonly Part[]>> = Object.freeze({
  surprise: [
    { label: '眉毛上扬', has: c => c.browUp }, { label: '睁大眼睛', has: c => c.eyeWide }, { label: '小"o"嘴', has: c => c.mouthOpen },
    { label: '头微微后仰', has: c => c.head }, { label: '身体往后一靠', has: c => c.upperBody },
  ],
  shy: [
    { label: '垂眼看向一侧', has: c => c.eyes || c.lids }, { label: '半垂眼皮', has: c => c.lids }, { label: '低头侧转', has: c => c.head },
    { label: '脸红', has: c => c.blush }, { label: '抿嘴笑', has: c => c.mouthSmile }, { label: '有点为难的眉', has: c => c.browSad },
    { label: '身体微微一缩', has: c => c.upperBody },
  ],
});
export const SHOW_NOTHING_REASON = '这个模型上找不到能用的头部骨骼和表情（眉毛、眼睛、嘴、脸红），所以没法预览。';

/** Which parts of a recipe show on this model; unusable only when none does (the button says why). */
export function showSupport(recipe: ExpressionRecipe, capabilities: ShowCapabilities | null): ExpressionSupport {
  const parts: string[] = [], missing: string[] = [];
  for (const part of PARTS[recipe]) (capabilities && part.has(capabilities) ? parts : missing).push(part.label);
  const usable = parts.length > 0;
  return { recipe, usable, parts, missing, reason: usable ? '' : capabilities ? SHOW_NOTHING_REASON : '还没载入模型。' };
}

/** One line for the UI: "惊喜：眉毛上扬、睁大眼睛… · 这个模型没有：小"o"嘴". */
export function showSupportLine(support: ExpressionSupport): string {
  const name = EXPRESSION_RECIPE_NAMES[support.recipe];
  if (!support.usable) return `${name}：${support.reason}`;
  return `${name}：${support.parts.join('、')}${support.missing.length ? ` · 这个模型没有：${support.missing.join('、')}（跳过）` : ''}`;
}
