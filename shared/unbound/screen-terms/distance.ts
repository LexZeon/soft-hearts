/**
 * I-211: the distance told to her, from the screen.
 *
 * The usable screen is treated as a camera frame with a fixed vertical view angle (SCREEN_TERMS_KNOBS.toldViewAngleDeg, 45°): someone H tall
 * who fills `size` of that frame stands H / (size · 2·tan(angle/2)) away. So the same look means the same number on every computer (not the
 * world's metres behind a 13" or a 32" glass). Rounded: one decimal under 2 m, else to 0.5 m. With 45° and 1.6 m: half the height ≈ 3.9 m,
 * the whole body just fits ≈ 1.9 m, chest-up ≈ 0.8 m, the face fills ≈ 0.3 m.
 */
import { SCREEN_TERMS_KNOBS, type ScreenTermsKnobs } from './knobs';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The distance (m) by the screen formula, unrounded; null when it cannot be told. */
export function screenDistanceM(heightM: number | null | undefined, size: number | null | undefined, knobs: ScreenTermsKnobs = SCREEN_TERMS_KNOBS): number | null {
  if (!finite(heightM) || heightM <= 0 || !finite(size) || size <= 0) return null;
  const angle = Math.min(170, Math.max(5, knobs.toldViewAngleDeg)) * Math.PI / 180;
  return heightM / (size * 2 * Math.tan(angle / 2));
}

/** As told: one decimal under 2 m, else to the nearest 0.5 m (at least 0.1). */
export function roundToldM(metres: number): number {
  if (!finite(metres) || metres <= 0) return 0.1;
  return metres < 2 ? Math.max(0.1, Math.round(metres * 10) / 10) : Math.round(metres * 2) / 2;
}

/** The told distance (rounded), or null. */
export function toldDistanceM(heightM: number | null | undefined, size: number | null | undefined, knobs: ScreenTermsKnobs = SCREEN_TERMS_KNOBS): number | null {
  const raw = screenDistanceM(heightM, size, knobs);
  return raw === null ? null : roundToldM(raw);
}

/**
 * I-193: the same screen formula backwards, for her ⟦go 1.2m⟧:
 * the size at which she is told `metres` away (screenDistanceM inverted: H / (m · 2·tan(angle/2))). The one place metres become a size;
 * null when it cannot be worked out.
 */
export function sizeForToldM(heightM: number | null | undefined, metres: number | null | undefined, knobs: ScreenTermsKnobs = SCREEN_TERMS_KNOBS): number | null {
  if (!finite(heightM) || heightM <= 0 || !finite(metres) || metres <= 0) return null;
  const angle = Math.min(170, Math.max(5, knobs.toldViewAngleDeg)) * Math.PI / 180;
  return heightM / (metres * 2 * Math.tan(angle / 2));
}
