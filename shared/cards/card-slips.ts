// 小毛病 (docs/claude/2026-11-12-loosen.md): a card setting for how often she has small human slips when she reaches out first
// (shared/behaviors/impulse/expression.ts). Absent = how every card behaved before (factor 1). A card trait, so it travels with
// the card file (export, import, in-place update); it never carries paths, keys or live state.
import { CARD_SLIPS, type CardSlips } from '../foundation/character-card';
export { CARD_SLIPS, type CardSlips };

/**
 * What the card's switch multiplies each slip's chance by. 关 = never; 少 = about half; 多 = 1.6x, which with the base chance 0.07 still
 * stays low (a few in a hundred lines; the per-kind soft cap and the 90-240 minute cooldown still apply on top).
 */
export const CARD_SLIPS_FACTOR: Readonly<Record<CardSlips, number>> = { off: 0, less: 0.5, more: 1.6 };

/** Anything not one of the three (a card with none, a newer value) is the default: factor 1. */
export function cardSlipsFactor(value: unknown): number {
  return typeof value === 'string' && Object.hasOwn(CARD_SLIPS_FACTOR, value) ? CARD_SLIPS_FACTOR[value as CardSlips] : 1;
}

/**
 * The card's value as a draft says it: undefined = not named, or 'default' (named, and means none: the field is then left out);
 * one of the three = that. Anything else is refused.
 */
export function validateCardSlips(value: unknown): CardSlips | undefined {
  if (value === undefined || value === 'default') return undefined;
  if (typeof value === 'string' && (CARD_SLIPS as readonly string[]).includes(value)) return value as CardSlips;
  throw new Error('“小毛病”只能是 off / less / more（关 / 少 / 多），或不写（默认）。');
}
