/**
 * I-077 step 1: how the style of the song and her reactions reshape the existing dance and nod (music-dance.ts), as a continuous
 * modulation of its targets, not new clips. Applied to the targets before the dance's own smoothing and its limits, so every frame
 * still moves smoothly and stays bounded. With no shape (or a neutral one) the dance is not touched at all (R15 stays bit for bit).
 *
 *  - sway / bounce / nod: multipliers of those parts (the head's nod is the dance's head pitch);
 *  - slow: the share of a slow sway, one side-to-side every four beats instead of every two. The dance's phase runs over four
 *    beats (0..4π), so sin(phase / 2) is continuous across its wrap, value and speed;
 *  - headX / headZ: a small head offset (rad) riding on the music's head motion, scaled by the dance's own presence (strength and
 *    activity), so it comes and goes with the dance.
 */
import type { DanceShape } from './director';

export interface DanceTargets { sway: number; bounce: number; chestRoll: number; headRoll: number; headPitch: number }
const clampSigned = (value: number, limit = 1) => Math.max(-limit, Math.min(limit, value));

export function shapeDanceTargets(targets: DanceTargets, shape: Readonly<DanceShape>, k: {
  amount: number; level: number; activity: number; phase: number; swayWeight: number; signedKick: number; swayLimit: number;
}): void {
  const slow = Math.max(0, Math.min(1, shape.slow));
  if (slow > 0) {
    const swing = Math.sin(k.phase) * (1 - slow) + Math.sin(k.phase * 0.5) * slow;
    targets.sway = k.amount * k.swayLimit * k.level * clampSigned(swing * k.swayWeight + k.signedKick * 0.2 * (1 - slow));
    targets.chestRoll *= 1 - 0.5 * slow;
  }
  targets.sway *= shape.sway; targets.chestRoll *= shape.sway; targets.bounce *= shape.bounce;
  const presence = k.amount * k.activity;
  targets.headPitch = targets.headPitch * shape.nod + shape.headX * presence;
  targets.headRoll += shape.headZ * presence;
}
