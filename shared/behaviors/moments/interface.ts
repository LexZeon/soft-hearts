// I-188: the moments the local rules recognise before she may speak first. Closed word lists only: the journal keeps
// these words and numbers, never anything said or seen. Pure: no clock, no I/O.

import type { AlarmWhy } from '../alarms/interface';

/** What kind of moment. Each one asks the existing proactive path for one speech opportunity; what she does with it is hers. */
export const MOMENT_KINDS = ['late-night', 'screen', 'reminder', 'fullscreen-back', 'first-today', 'back', 'goodnight',
  // I-189 (local pose only, camera pose sensing on): slumped or very close for long, staring still at the screen, looking away after that, sitting long.
  'posture', 'staring', 'staring-away', 'sitting',
  // I-195: one of her own alarms woke.
  'her-alarm',
  // I-203: a kiss or a hug from her reply was interrupted (a large pull, her face could not reach): her one immediate turn, with the facts.
  'close-cut'] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

/**
 * #9: what happened on the screen while watching together, as the frame describer's closed `event` word says (shared/behaviors/
 * watch-timeline/prompts.ts). 'loading' alone is not a moment; a loading frame that stays the last one for long becomes 'stuck'.
 */
export const SCREEN_EVENTS = ['error', 'loading', 'game-over', 'win', 'download-done', 'video-end'] as const;
export type ScreenEvent = (typeof SCREEN_EVENTS)[number];
export type ScreenMomentEvent = Exclude<ScreenEvent, 'loading'> | 'stuck';
export const SCREEN_MOMENT_EVENTS: readonly ScreenMomentEvent[] = ['error', 'stuck', 'game-over', 'win', 'download-done', 'video-end'];
export function isScreenEvent(value: unknown): value is ScreenEvent { return typeof value === 'string' && (SCREEN_EVENTS as readonly string[]).includes(value); }

/** How one moment ended, for the journal. */
export const MOMENT_OUTCOMES = ['recognised', 'asked', 'spoke', 'quiet', 'skipped', 'expired', 'set', 'cancelled'] as const;
export type MomentOutcome = (typeof MOMENT_OUTCOMES)[number];

/** Why a moment was skipped or ended unspoken (closed). */
export const MOMENT_WHYS = ['typing', 'call', 'away', 'asleep', 'switch', 'hidden', 'cooldown', 'cap', 'refused', 'budget', 'not-said', 'late', 'used', 'chance', 'user', 'quiet-hours'] as const;
export type MomentWhy = (typeof MOMENT_WHYS)[number];

/** The facts a moment carries into her prompt (numbers and closed words; a reminder's own words only into her own prompt). */
export interface MomentFacts {
  /** late-night: the user's usual bedtime and now, minutes from midnight (negative = the evening before); learned from how many nights. */
  readonly bedMinute?: number;
  readonly nowMinute?: number;
  readonly nights?: number;
  /** screen / fullscreen-back: what happened on the screen (watching together only). */
  readonly screen?: ScreenMomentEvent;
  /** fullscreen-back: minutes the full-screen program was in front. */
  readonly fullscreenMinutes?: number;
  /** reminder: the user's own short words of what to remind, when it was due, how late now, and whether the time was a guess. */
  readonly what?: string;
  readonly dueAt?: number;
  readonly lateMinutes?: number;
  readonly guessed?: boolean;
  /** first-today / back: minutes away, a weekend, the user stayed up late last night (past the usual bedtime). */
  readonly awayMinutes?: number;
  readonly weekend?: boolean;
  readonly lateLastNight?: boolean;
  /** I-189 posture: slumped, or very close to the screen; staring / staring-away / sitting / posture: for about how many minutes. */
  readonly posture?: 'slumped' | 'close';
  readonly minutes?: number;
  /** I-189 staring-away: seconds since the look moved off the screen. */
  readonly awaySeconds?: number;
  /** I-189 sitting: today's seated minutes and stand-ups (background only). */
  readonly todayMinutes?: number;
  readonly standUps?: number;
  /** her-alarm (I-195): her own note (her own words, only into her own prompt) and what woke it. */
  readonly alarmNote?: string;
  readonly alarmWhy?: AlarmWhy;
  /** close-cut (I-203): the facts of her interrupted kiss or hug, already in words (her own words inside: only into her own prompt, never journaled). */
  readonly closeCut?: string;
}

/** I-189: what the local pose watchers hand the moments host (electron/senses/pose-uses/host.ts): a kind and its facts, nothing else. */
export interface PoseMomentCandidate { readonly kind: 'posture' | 'staring' | 'staring-away' | 'sitting'; readonly facts: MomentFacts }

/** One recognised moment, waiting for an opportunity to be said. */
export interface Moment {
  readonly id: string;
  readonly kind: MomentKind;
  readonly characterId: string;
  readonly at: number;
  /** After this the moment is dropped (journalled 'expired'). */
  readonly until: number;
  readonly facts: MomentFacts;
  /** She may speak although it is her quiet hours (night, drowsy; never asleep): the late-night care, a promised reminder, her goodnight. */
  readonly quietOk: boolean;
  /** Rolls the interaction budget (I-010) like her own opening; a promised reminder does not (she promised the user). */
  readonly budget: boolean;
  /** late-night: the night key (innerLoopNightKey) whose one rest reminder this spends; shared with the old rest reminder (never twice a night). */
  readonly night?: string;
  /** reminder: the stored reminder's id. */
  readonly reminderId?: string;
  /** close-cut (I-203): which interrupted moment this is (electron/unbound/close-cut.ts), to say how its one turn went. */
  readonly cutId?: number;
}

/** The one moment gate, read before asking and checked again by the inner loop: never while typing, in a call, away, asleep or hidden. */
export interface MomentGateInput {
  readonly enabled: boolean;
  readonly typing: boolean;
  readonly call: boolean;
  readonly away: boolean;
  readonly asleep: boolean;
  readonly visible: boolean;
}
export function momentGate(input: MomentGateInput): MomentWhy | null {
  if (!input.enabled) return 'switch';
  if (input.typing) return 'typing';
  if (input.call) return 'call';
  if (input.asleep) return 'asleep';
  if (!input.visible) return 'hidden';
  if (input.away) return 'away';
  return null;
}
