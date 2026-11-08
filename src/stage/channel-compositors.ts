/**
 * Dedicated channel compositors (docs/mood/action-composition.md, "专用通道合成"):
 * one writer per semantic channel, combining requests by meaning instead of
 * summing whatever happened to write the morph last.
 *
 * Eyelid: natural blink vs closure requests (touch enjoyment, cheek squint,
 *   fatigue; later R36 expression requests). Requests combine by max, are held
 *   through brief gaps so an input that flickers cannot flutter the lids, and
 *   the blink rides on the remaining openness. `sharedClosure` is the hook for
 *   a morph that closes the same lid vertices (Gene 笑い/じと目 share vertices
 *   with まばたき): it caps the blink so the sum cannot over-close.
 *   R36 (continuous-expression.ts) adds two kinds of requests: lid shapes on
 *   their own morphs (eye smile, half lid), which yield to the blink pulse and
 *   cap the blink like `sharedClosure`; and a soft closure (half-lowered lids in
 *   an expression preview), shown on the blink morph but, unlike contact or
 *   fatigue, never suppressing the natural blink: natural blink priority.
 * Mouth: feeding near the mouth vs speech lip-sync. Feeding owns the mouth by
 *   an eased weight; lip-sync cross-fades into it and back out afterwards. A
 *   mouth expression (closed smile, small "o") only shows where neither owns it.
 *   A selected expression with mouth tracks owns it above both (R29d/X-089):
 *   they step aside by an eased ramp instead of being written over it by max.
 * Brows: one shape per brow; competing brow requests share one amount.
 */

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const smoothstep = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };

export interface EyelidRequests {
  /** Enjoyed closure while touched (mood feedback). */
  contact: number;
  /** Squint while the cheek is pinched. */
  cheek: number;
  /** Drowsy lids. */
  fatigue: number;
  /** The idle blink pulse (0 open .. 1 closed). */
  naturalBlink: number;
  /** Closure already shown by another morph on the same lid vertices (eye-smile). */
  sharedClosure?: number;
  /** A gentle closure shown on the blink morph that never suppresses the natural blink (expression previews). */
  soft?: number;
  /** R36 lid shapes on their own morphs; the shown values yield to the blink pulse. */
  smileEyes?: number;
  jitome?: number;
}
export interface EyelidFrame {
  /** Value for the blink morph. */
  blink: number;
  /** Total requested closure incl. the blink, for gates that attenuate eye-wide morphs. */
  closure: number;
  /** Held request level (without the blink), e.g. to postpone the next blink. */
  held: number;
  /** Lid shapes to show on their own morphs (0 when not requested). */
  smileEyes: number;
  jitome: number;
}

/** How long a dropped request is held before the lids start to reopen (s). */
export const EYELID_RELEASE_HOLD = 0.18;
/** Reopening rate after the hold (1/s); the rise follows requests directly. */
export const EYELID_RELEASE_RATE = 7;
/** Above this held closure the natural blink is fully suppressed (eyes are already gently shut). */
export const EYELID_BLINK_SUPPRESS = 0.15;

export class EyelidCompositor {
  private held = 0;
  private since = 0;
  private owner: object | null = null;
  private scope = '';

  reset(): void { this.held = 0; this.since = 0; }

  /**
   * One display frame. `owner` (the stage passes its mesh) scopes the held
   * closure: a model swap starts from open lids instead of a stale request.
   * `scope` (character and conversation token) scopes the requests: when it
   * changes on the same model, whatever closure the previous scope still holds
   * is released at once, from what is shown (no hold for the old scope's
   * request, no one-frame cut either). X-089.
   */
  frame(delta: number, input: EyelidRequests, owner: object | null = null, scope = ''): EyelidFrame {
    if (owner !== this.owner) { this.owner = owner; this.scope = scope; this.reset(); }
    else if (scope !== this.scope) { this.scope = scope; this.since = EYELID_RELEASE_HOLD; }
    const dt = Number.isFinite(delta) ? Math.min(0.1, Math.max(0, delta)) : 0;
    const request = Math.max(clamp01(input.contact), clamp01(input.cheek), clamp01(input.fatigue));
    if (request >= this.held) { this.held = request; this.since = 0; }
    else {
      // A brief gap (an input flicker, a hit-test edge) must not reopen the lids.
      this.since += dt;
      if (this.since > EYELID_RELEASE_HOLD) this.held = request + (this.held - request) * Math.exp(-EYELID_RELEASE_RATE * dt);
    }
    const held = this.held;
    const natural = clamp01(input.naturalBlink) * (1 - clamp01(held / EYELID_BLINK_SUPPRESS));
    // A soft closure shows on the blink morph, but only held requests suppress the blink.
    const base = Math.max(held, clamp01(input.soft ?? 0));
    const closure = clamp01(base + (1 - base) * natural);
    // Lid shapes give way as the blink closes, so the blink morph alone carries a full closure.
    const open = 1 - natural;
    const smileEyes = clamp01(input.smileEyes ?? 0) * open, jitome = clamp01(input.jitome ?? 0) * open;
    const shared = Math.max(clamp01(input.sharedClosure ?? 0), smileEyes, jitome);
    return { blink: Math.min(closure, 1 - shared), closure, held, smileEyes, jitome };
  }
}

/**
 * Feeding vs lip-sync. `feedWeight` is feeding's eased ownership (0 far away,
 * 1 at the mouth); both mouth values are already eased by their own owners.
 * The shown value cross-fades from speech to the feeding opening by that
 * weight (a hand-off from the visible state, never a dip below either), and
 * never shows less than the feeding opening itself: a snack at the mouth wins
 * over talking, and talking returns smoothly afterwards.
 */
export function composeMouth(lipSync: number, feeding: number, feedWeight: number): number {
  const lip = clamp01(lipSync), feed = clamp01(feeding), mix = smoothstep(feedWeight);
  return Math.max(feed, lip * (1 - mix) + feed * mix);
}

/**
 * A selected (manual) expression with mouth tracks owns the mouth: 手选嘴 >
 * 嘴边的喂食 > 说话口型 (X-089). The morph is written by max, so the composed
 * lip-sync/feeding value must step aside, not be written over the manual
 * value: it fades out by the eased ownership ramp and back in afterwards.
 * A selected expression without mouth tracks (eyes, brows) never takes it.
 */
export const MANUAL_MOUTH_SECONDS = 0.25;
/** Ownership ramp 0..1 toward `owned`, linear over MANUAL_MOUTH_SECONDS (shown through smoothstep). */
export function manualMouthRamp(current: number, owned: boolean, delta: number): number {
  const step = Number.isFinite(delta) && delta > 0 ? Math.min(0.1, delta) / MANUAL_MOUTH_SECONDS : 0;
  const value = clamp01(current);
  return owned ? Math.min(1, value + step) : Math.max(0, value - step);
}
export function yieldToManualMouth(composed: number, ramp: number): number {
  return clamp01(composed) * (1 - smoothstep(ramp));
}

/**
 * A mouth expression (closed smile, small "o") on its own morph. Lip-sync and
 * feeding own the mouth: the expression fades out by their eased owner weights
 * and returns after them, so it never fights a syllable or a bite.
 */
export function composeMouthExpression(expression: number, speechOwner: number, feedOwner: number): number {
  return clamp01(expression) * (1 - smoothstep(speechOwner)) * (1 - smoothstep(feedOwner));
}

/**
 * Brows: one shape per brow. Competing requests (troubled, angry) share the
 * strongest request's amount by their relative strength, so two brow shapes on
 * the same vertices never stack to a double-strength brow. One request passes
 * unchanged; the result is continuous in both inputs. Writes into `out`.
 */
export function composeBrows(sad: number, angry: number, out: { sad: number; angry: number }): { sad: number; angry: number } {
  const s = clamp01(sad), a = clamp01(angry), total = s + a;
  out.sad = a > 0 ? s * s / total : s;
  out.angry = s > 0 ? a * a / total : a;
  return out;
}
