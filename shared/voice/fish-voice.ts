// I-070: Fish Audio's Drama 3 as a third reading voice, beside the free system voice
// and Bailian. Pure pieces shared by the host (electron/voice/tts.ts, electron/fish-budget.ts) and the windows: the mood → acting
// direction map, the price per byte and the monthly spending view. No key, address or reply text lives here.

// FISH_MOODS / FishMood (the reply's frozen mood reduced to what Drama 3 can act) live in shared/foundation/tts-config.ts (2026-11-16).
import { FISH_MOODS, type FishMood } from '../foundation/tts-config';
export { FISH_MOODS, type FishMood };
export const isFishMood = (value: unknown): value is FishMood => typeof value === 'string' && (FISH_MOODS as readonly string[]).includes(value);

/**
 * One bracketed direction per sentence, in front of the words. Lessons from the 2026-11-10 listening rounds
 * (docs/voice-design-guide.md): every direction carries "natural"; no whispering, breathy or coy words (they made her sound
 * affected and far too quiet). The direction is added by the host only, in the request: never shown, never kept in history.
 */
export const FISH_NEUTRAL_DIRECTION = '[natural, like everyday chatting]';
const DIRECTIONS: Readonly<Record<FishMood, string>> = Object.freeze({
  calm: FISH_NEUTRAL_DIRECTION,
  happy: '[happy, a small smile, natural, like everyday chatting]',
  comfort: '[soft tone, caring, natural, like everyday chatting]',
  sad: '[a little sad, natural, like everyday chatting]',
  firm: '[a little annoyed, serious, natural, like everyday chatting]',
  focused: '[clear and attentive, natural, like everyday chatting]',
  sleepy: '[sleepy, unhurried, natural, like everyday chatting]',
});
/**
 * The mood part alone, for a character that has its own acting style (I-070 step 2): the same words as DIRECTIONS without
 * "natural, like everyday chatting", which would fight an acting style such as "voice-actor cute". Calm has no mood word.
 */
const MOOD_WORDS: Readonly<Partial<Record<FishMood, string>>> = Object.freeze({
  happy: 'happy, a small smile',
  comfort: 'soft tone, caring',
  sad: 'a little sad',
  firm: 'a little annoyed, serious',
  focused: 'clear and attentive',
  sleepy: 'sleepy, unhurried',
});

/** The longest acting style kept, in characters (any language). */
export const FISH_ACTING_STYLE_MAX = 300;
/**
 * A character's acting style as typed (or as set through the channel): brackets and angle brackets removed so it cannot open a
 * tag of its own, line breaks and control characters turned into spaces, trimmed, at most 300 characters. Not a string = empty.
 */
export function cleanFishActingStyle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\[\]<>]/gu, '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, FISH_ACTING_STYLE_MAX).join('').trim();
}

/**
 * The direction for a mood; an unknown or missing mood speaks naturally. With an acting style the bracket reads
 * `[<acting style>; <mood word>]`, or just `[<acting style>]` for calm or an unknown mood; without one it is unchanged.
 */
export function fishDirection(mood: unknown, actingStyle?: unknown): string {
  const style = cleanFishActingStyle(actingStyle);
  if (!style) return isFishMood(mood) ? DIRECTIONS[mood] : FISH_NEUTRAL_DIRECTION;
  const word = isFishMood(mood) ? MOOD_WORDS[mood] : undefined;
  return word ? `[${style}; ${word}]` : `[${style}]`;
}

/**
 * The words she says, made safe to follow a direction: square brackets are Drama 3's control syntax, so brackets inside the
 * reply itself become round ones and can never start a direction of their own. `<` `>` likewise (its local tags).
 */
export function fishSpokenText(text: string): string {
  return text.replace(/\[/gu, '(').replace(/\]/gu, ')').replace(/</gu, '‹').replace(/>/gu, '›').trim();
}
/** Exactly what is sent as `text`: direction, a space, the words. */
export function fishRequestText(mood: unknown, words: string, actingStyle?: unknown): string {
  return `${fishDirection(mood, actingStyle)} ${fishSpokenText(words)}`;
}

// --- Price and the monthly limit -------------------------------------------------------------------------------------

/** Launch discount: $10 per million UTF-8 bytes until 2026-12-01 00:00 Pacific (08:00 UTC); $50 after (Fish price page, 2026-11-10). */
export const FISH_PROMO_END_MS = Date.UTC(2026, 11, 1, 8, 0, 0);
export const FISH_PROMO_USD_PER_MILLION_BYTES = 10;
export const FISH_LIST_USD_PER_MILLION_BYTES = 50;
export function fishUsdPerMillionBytes(at: Date): number {
  return at.getTime() < FISH_PROMO_END_MS ? FISH_PROMO_USD_PER_MILLION_BYTES : FISH_LIST_USD_PER_MILLION_BYTES;
}
/** Cost of one request in micro-dollars (whole numbers, so a month of small sums never drifts). */
export function fishCostMicroUsd(bytes: number, at: Date): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  // $X per 1e6 bytes = X micro-dollars per byte.
  return Math.ceil(bytes) * fishUsdPerMillionBytes(at);
}
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * 0 = no monthly limit. The default since 2026-11-24: what she spends is bounded by the user's
 * prepaid Fish Audio balance; a limit is something the user sets in the control window. A limit already saved stays as it was.
 */
export const FISH_NO_MONTHLY_CAP = 0;
export const DEFAULT_FISH_MONTHLY_CAP_USD = FISH_NO_MONTHLY_CAP;
export const FISH_MONTHLY_CAP_MIN_USD = 1;
export const FISH_MONTHLY_CAP_MAX_USD = 500;
export function validFishMonthlyCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FISH_MONTHLY_CAP_USD;
  if (value <= 0) return FISH_NO_MONTHLY_CAP;
  return Math.round(Math.min(FISH_MONTHLY_CAP_MAX_USD, Math.max(FISH_MONTHLY_CAP_MIN_USD, value)) * 100) / 100;
}
/** The monthly limit in micro-dollars; Infinity when there is none. */
export function fishCapMicroUsd(capUsd: unknown): number {
  const cap = validFishMonthlyCap(capUsd);
  return cap === FISH_NO_MONTHLY_CAP ? Number.POSITIVE_INFINITY : cap * 1_000_000;
}

/** The natural (local calendar) month a moment belongs to, as "2026-11". */
export function fishMonthKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
}

/** What the windows see of this month's spending: numbers only. */
export interface FishBudgetView {
  month: string;
  /** UTF-8 bytes sent this month (directions included). */
  bytes: number;
  /** Spent this month at the price of the moment of each request, in micro-dollars. */
  spentMicroUsd: number;
  /** Present once, on the push that crossed this month's limit: show "本月 Drama 3 额度用完了，先用系统声音" one time. */
  notice?: boolean;
}
export const EMPTY_FISH_BUDGET = (at: Date): FishBudgetView => ({ month: fishMonthKey(at), bytes: 0, spentMicroUsd: 0 });
export function validFishBudgetView(value: unknown): FishBudgetView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.month !== 'string' || !/^\d{4}-\d{2}$/u.test(v.month)) return null;
  if (!Number.isSafeInteger(v.bytes) || (v.bytes as number) < 0 || !Number.isSafeInteger(v.spentMicroUsd) || (v.spentMicroUsd as number) < 0) return null;
  return { month: v.month, bytes: v.bytes as number, spentMicroUsd: v.spentMicroUsd as number, ...(v.notice === true ? { notice: true } : {}) };
}

/** This month's limit is used up: spending in the current month reached the cap. A view from an earlier month is a new month. */
export function fishBudgetExhausted(view: FishBudgetView | null | undefined, capUsd: unknown, at: Date): boolean {
  if (!view || view.month !== fishMonthKey(at)) return false;
  return view.spentMicroUsd >= fishCapMicroUsd(capUsd);
}

/** "$0.42" style, for the settings line. */
export function formatUsd(microUsd: number): string {
  const usd = Math.max(0, microUsd) / 1_000_000;
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export const FISH_BUDGET_NOTICE = '本月 Drama 3 额度用完了，先用系统声音';
