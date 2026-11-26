// I-195 her own alarms ("留心"): the closed vocabulary and shapes. A trigger is a time (in N minutes, a clock time, a date) and/or an event
// (a closed list of what the moments host recognises) or a word the user may say. Pure: no clock, no I/O. Her note is her own words: it goes
// only into her own prompt, never into the journal, a log or the repository.

/** The marker's brackets: never the beat marker's ⟦⟧. Whatever sits between them never reaches text, speech, history or memory. */
export const ALARM_MARK_OPEN = '⟪';
export const ALARM_MARK_CLOSE = '⟫';
/** The marker's first word. */
export const ALARM_MARK_WORD = 'alarm';

/** Events she can wait for (closed). 'user-sleep' and the talk word are read from the user's own message in the chat turn; the others are recognised by the moments host. */
export const ALARM_EVENTS = ['back', 'first-today', 'fullscreen-back', 'user-sleep', 'video-end', 'sitting', 'screen-error', 'game-over', 'win', 'download-done', 'kiss', 'hug', 'late-night'] as const;
export type AlarmEvent = (typeof ALARM_EVENTS)[number];
export function isAlarmEvent(value: unknown): value is AlarmEvent { return typeof value === 'string' && (ALARM_EVENTS as readonly string[]).includes(value); }

/** What she asked for, as parsed from one marker. */
export interface AlarmSpec {
  /** A time: the alarm fires then (time only), or the event / word may only count from then on (with an event or a word). */
  readonly at: number | null;
  readonly on: AlarmEvent | null;
  readonly talk: string | null;
  readonly note: string;
}

/** One marker body, parsed: a new alarm, or taking one of the listed ones away (index 1.., or 'all'). */
export type AlarmMarker = { readonly kind: 'set'; readonly spec: AlarmSpec } | { readonly kind: 'drop'; readonly which: number | 'all' };

/** Why a trigger woke (closed words for her prompt line and the journal). */
export type AlarmWhy = 'time' | AlarmEvent | 'talk';

/** What the page and her prompt see of one alarm (the note is her own words: shown to the user only on their own profile page). */
export interface AlarmView {
  readonly id: string;
  readonly at: number | null;
  readonly on: AlarmEvent | null;
  readonly talk: string | null;
  readonly note: string;
  readonly createdAt: number;
}

/**
 * The user profile page's one window↔host call: show the switch and her waiting alarms, flip the switch (the user's own click), take one or all away.
 * The reply is always the view after the action. Each item has when / what she waits for in words and her own note (the user's own page).
 */
export type HerAlarmsRequest = { readonly action: 'view' } | { readonly action: 'switch'; readonly on: boolean } | { readonly action: 'cancel'; readonly id: string };
export interface HerAlarmsView { readonly on: boolean; readonly items: readonly { readonly id: string; readonly when: string; readonly note: string }[] }

/** The grey line in the chat when she sets one: never the content. */
export const ALARM_GREY_LINE = '（她记了件事）';
