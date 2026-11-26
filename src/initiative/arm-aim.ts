/**
 * I-154 batch 4 (docs/claude/2026-11-20-unbound-window-batch4.md): what the game's raised hand (rps-performance.ts), the offer
 * (give-performance.ts) and the hand reaching for your mouse (hand-reach.ts) want of her arm, as a design instead of bone writes, so
 * the window's Unbound engine can hand it to its own arm reach (src/unbound/arm-reach.ts 'aim'). The old stage keeps writing bones
 * itself (applyPose); both read the same design, so the two engines show the same arm.
 *
 * Directions are unit vectors in her chest's rest frame (the model's own axes at rest): shoulder → elbow, elbow → wrist, the hand
 * (wrist → middle knuckle) and where the pads face. `weight` is the performer's own eased presence (0..1). `fingers`: the hand shape
 * this frame, per joint [curl toward the pads, spread toward the index side] in degrees (thumb 0–2, then index, middle, ring, little
 * 1–3); null: the fingers as the motion has them.
 */
import type { Vector3 } from 'three';

export type FingerRows = readonly (readonly [number, number])[];
export interface PerformerHandShape { thumb: FingerRows; fingers: readonly [FingerRows, FingerRows, FingerRows, FingerRows] }
export interface PerformerArmAim {
  side: 'left' | 'right';
  weight: number;
  upper: Vector3; fore: Vector3; hand: Vector3; palm: Vector3;
  fingers: PerformerHandShape | null;
}

/** Rows keyed by finger name (the performers' own tables) as one hand. */
export function handShapeOf(rows: Readonly<Record<'thumb' | 'index' | 'middle' | 'ring' | 'little', FingerRows>>): PerformerHandShape {
  return { thumb: rows.thumb, fingers: [rows.index, rows.middle, rows.ring, rows.little] };
}
