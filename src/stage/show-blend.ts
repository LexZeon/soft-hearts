/**
 * I-038 part A / I-037: an E1 show (expression-show.ts: 惊喜, 害羞) asked for again, at a strength, by anyone — the preview
 * buttons, a test command, the reaction system (shy-show.ts) — without a pop (docs/claude/2026-11-06-i038-universal-part-a.md).
 *
 * Before: a second request restarted the show at 0 ms, whose tracks start at 0, so a head lowered by 8° went back to 0 in one
 * frame (the display guard caught it); another recipe took over at full weight the same way. Now:
 *
 * - `showRequest`: the same recipe asked again while it is still coming in or holding is not restarted; it keeps going and
 *   takes the higher strength, eased in (`StrengthEase`, no kink at either end); for 害羞 its clock also comes to rest in the
 *   hold so it ends a full show after the latest ask (show-clock.ts, X-343). Asked again on its way out, or the other
 *   recipe: it starts again.
 * - `ShowCarry`: on a restart the show that was playing keeps playing on its own clock and fades out over SHOW_CARRY_SECONDS
 *   (smoothstep, so its speed carries over at the switch), while the new one comes in from 0 — like a cross-fade of two clips.
 */
import { SHOW_KEYS, SHOW_MS, emptyShow, showSample, type ShowFrame } from './expression-show';
import type { ExpressionRecipe } from '../../shared/expression-preview';

/** When each recipe starts to let go (ms): before this a repeat keeps it going, after it a repeat starts it again. */
export const SHOW_RELEASE_MS: Readonly<Record<ExpressionRecipe, number>> = Object.freeze({ surprise: 650, shy: 2200 });
export const SHOW_CARRY_SECONDS = 0.5;
export const SHOW_STRENGTH_SECONDS = 0.4;
/** The show channels that are bone angles (the rest are face amounts). */
export const SHOW_BONE_KEYS: ReadonlySet<keyof ShowFrame> = new Set(['headX', 'headY', 'headZ', 'bodyX', 'bodyZ', 'eyePitch', 'eyeYaw']);
export const clampStrength = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;

/** What to do with a request (`current`: the show playing now, if any). */
export function showRequest(current: { recipe: ExpressionRecipe; elapsedMs: number | null } | null, recipe: ExpressionRecipe): 'start' | 'keep' {
  if (!current || current.recipe !== recipe) return 'start';
  const elapsed = current.elapsedMs ?? 0;
  return elapsed < Math.min(SHOW_RELEASE_MS[recipe], SHOW_MS[recipe]) ? 'keep' : 'start';
}

const smooth = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };
const finiteDt = (dt: number) => Number.isFinite(dt) && dt > 0 ? dt : 0;

/** A show's strength: set at once when it starts, eased (smoothstep over SHOW_STRENGTH_SECONDS) when it changes while playing. */
export class StrengthEase {
  value = 1;
  private from = 1; private to = 1; private t = 1;
  reset(value: number): void { this.value = this.from = this.to = value; this.t = 1; }
  step(target: number, dt: number): number {
    if (target !== this.to) { this.from = this.value; this.to = target; this.t = 0; }
    if (this.t < 1) { this.t = Math.min(1, this.t + finiteDt(dt) / SHOW_STRENGTH_SECONDS); this.value = this.t === 1 ? this.to : this.from + (this.to - this.from) * smooth(this.t); }
    return this.value;
  }
}

interface Carried { recipe: ExpressionRecipe; elapsedMs: number; hasEyes: boolean; bone: number; face: number; weight: number }
/** Replaced shows, still playing and fading out (see the file comment). Allocation only on capture. */
export class ShowCarry {
  private readonly items: Carried[] = [];
  private readonly sample = emptyShow();
  private readonly sum = emptyShow();
  get active(): boolean { return this.items.length > 0; }
  /** Keeps the show that was playing (its clock, its gains as displayed: `bone` for the angles, `face` for the face) and fades it out. */
  capture(recipe: ExpressionRecipe, elapsedMs: number, hasEyes: boolean, bone: number, face: number): void {
    if (!(bone > 0) && !(face > 0)) return;
    this.items.push({ recipe, elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : 0, hasEyes, bone, face, weight: 1 });
  }
  /** Advances every carried show by `dt` seconds and sums what they show now (read with `at`). */
  step(dt: number): void {
    const seconds = finiteDt(dt);
    for (const key of SHOW_KEYS) this.sum[key] = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.elapsedMs += seconds * 1000; item.weight = Math.max(0, item.weight - seconds / SHOW_CARRY_SECONDS);
      if (item.weight === 0) { this.items.splice(i, 1); continue; }
      showSample(item.recipe, item.elapsedMs, item.hasEyes, this.sample);
      const k = smooth(item.weight);
      for (const key of SHOW_KEYS) this.sum[key] += this.sample[key] * (SHOW_BONE_KEYS.has(key) ? item.bone : item.face) * k;
    }
  }
  at(key: keyof ShowFrame): number { return this.items.length ? this.sum[key] : 0; }
  reset(): void { this.items.length = 0; for (const key of SHOW_KEYS) this.sum[key] = 0; }
}
