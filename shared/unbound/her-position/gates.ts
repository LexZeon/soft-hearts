/**
 * I-193: when a "go where" word of hers may start a walk, and what takes the walk away once it is on.
 *
 * A word that cannot start now is simply not performed (she said it; the body stays). Pure.
 */
import { endsAction } from '../action-ends';
export type GoBlock = 'not-shown' | 'asleep' | 'pulled' | 'playing' | 'typing' | 'busy';

export interface GoGates {
  /** She is out and on screen (not stepped back for a full-screen program). */
  shown: boolean;
  asleep: boolean;
  /** You are pulling her. */
  pulled: boolean;
  /** A game, an offer or her reach for your hand. */
  playing: boolean;
  /** Her small "对她说" box is open (you are typing to her). */
  typing: boolean;
  /** A peek or a close moment (kiss, hug, shy back) is on. */
  busy: boolean;
}

/** The first reason she cannot start walking now, or null. A call is not a reason. */
export function goBlock(g: GoGates): GoBlock | null {
  if (!g.shown) return 'not-shown';
  if (g.asleep) return 'asleep';
  if (g.pulled) return 'pulled';
  if (g.playing) return 'playing';
  if (g.typing) return 'typing';
  if (g.busy) return 'busy';
  return null;
}

/**
 * What ends a walk she chose: the one interruption arbiter's 'walk' row (shared/unbound/action-ends/rules.ts): a large pull, a game, a click on her.
 * Her reply, her reading aloud, you waiting, a call, you typing and the mouse moving do not: she walks while she talks.
 */
export const interruptsGoWalk = (interaction: string | null | undefined): boolean => endsAction('walk', interaction);

/** How long a walk that waits for a small move to ease out may wait before it is dropped (ms). */
export const GO_WAIT_MS = 8_000;
