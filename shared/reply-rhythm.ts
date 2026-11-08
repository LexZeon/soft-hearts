// 说话节奏 (F7, docs/claude/2026-11-03-speech-rhythm-plan.md and docs/claude/2026-11-03-speech-rhythm.md): how fast the bubbles
// after the first one follow each other, from her mood and character, and a little from the user's own pace.
//
// Pure helpers only. The host freezes one cue per reply from the same mood snapshot as the reply's voice
// (electron/reply-rhythm-host.ts); the renderer paces the bubbles with it (src/ui/reply-presentation.ts). Nothing here
// touches a prompt: the first bubble is never delayed (R27), and the first character of a reply is as fast as before.
//
// 兜底，待定: where she pauses, which
// kind of pause and whether she waits for the user are to be hers, marked in her reply, not computed from character counts.
// Everything below that turns her mood or the text's shape into waits (the multiplier table, the visible-character hold,
// the 4 s budget, the "……" stop, the afterthought pause, the user's pace) is a fallback kept for that design and is OFF:
// with REPLY_RHYTHM_FALLBACK_ENABLED false the bubbles keep exactly R27's pacing. Nothing here is final behaviour.
import type { FatiguePhase } from './fatigue';
import type { MoodContext, MoodLabel, MoodTendency } from './mood';

/** 兜底，待定: off until the user decides the direction (the developer panel still shows what it would have been). */
export const REPLY_RHYTHM_FALLBACK_ENABLED = false;

/** T-108's candidate range: a trial value, not fitted to any corpus. */
export const REPLY_RHYTHM_MIN = 0.85;
export const REPLY_RHYTHM_MAX = 1.15;
/** The mood template's "文字语气强度" at which the table below applies as written (the template default). */
export const RHYTHM_REFERENCE_TEXT_INTENSITY = 50;
/** Every wait this reply adds on purpose, summed (holds, "……" pauses, the afterthought), is capped at this. */
export const REPLY_RHYTHM_BUDGET_MS = 4_000;
/** A later sentence's short stop at "……"; longer while she is blushing. Scaled by the multiplier. */
export const ELLIPSIS_PAUSE_MS = 350;
export const SHY_ELLIPSIS_PAUSE_MS = 600;
/** The extra wait before an afterthought sentence ("啊对了……"), at most once per reply. Scaled by the multiplier. */
export const AFTERTHOUGHT_EXTRA_MS = 600;
export const AFTERTHOUGHT_MARKERS: readonly string[] = Object.freeze(['啊对了', '对了', '话说', '还有啊']);
/** Developer listening trial only: extra silence between system-voice sentences at the slowest rhythm (0 by default). */
export const VOICE_GAP_TRIAL_MAX_MS = 200;

/** Which part of her mood set the pace (the developer panel and the experience journal show it). */
export type RhythmMood = 'neutral' | 'happy' | 'excited' | 'comfort' | 'longing' | 'disappointed' | 'sad';
export const RHYTHM_MOODS: readonly RhythmMood[] = ['neutral', 'happy', 'excited', 'comfort', 'longing', 'disappointed', 'sad'];
export type RhythmTendency = Extract<MoodTendency, 'playful' | 'comfortable'>;
/** The user's own pace: several very short messages in quick succession, or pouring out a long one. */
export type UserPace = 'quick' | 'venting';
export const USER_PACES: readonly UserPace[] = ['quick', 'venting'];

/** Trial values (the plan's table). Above 1 is slower, below 1 faster. */
export const RHYTHM_MOOD_FACTORS: Readonly<Record<RhythmMood, number>> = Object.freeze({
  neutral: 1, happy: 0.92, excited: 0.88, comfort: 1.05, longing: 1.06, disappointed: 1.08, sad: 1.12,
});
export const RHYTHM_FATIGUE_FACTORS: Readonly<Record<FatiguePhase, number>> = Object.freeze({
  awake: 1, 'light-drowsy': 1.05, drowsy: 1.1, 'falling-asleep': 1.15, asleep: 1.15, 'micro-awake': 1.05,
});
/** T-106: playful is a little brisker and comfortable a little more leisurely; cautious is NOT slow, so it has no factor. */
export const RHYTHM_TENDENCY_FACTORS: Readonly<Record<RhythmTendency, number>> = Object.freeze({ playful: 0.97, comfortable: 1.03 });
export const RHYTHM_SHY_FACTOR = 1.05;
export const RHYTHM_USER_FACTORS: Readonly<Record<UserPace, number>> = Object.freeze({ quick: 0.95, venting: 1.05 });

/** One reply's pace, frozen when the reply is accepted. Numbers and closed names only; never text. */
export interface ReplyRhythmCue {
  readonly multiplier: number;
  readonly mood: RhythmMood;
  /** null while awake (or unknown). */
  readonly fatigue: FatiguePhase | null;
  readonly tendency: RhythmTendency | null;
  /** Her blush was showing when the reply began. */
  readonly shy: boolean;
  readonly user: UserPace | null;
  /** The card's mood template "文字语气强度" (0–100) that scaled all of the above. */
  readonly textIntensity: number;
  /** Developer listening trial: silence before each later system-voice sentence. 0 unless the trial is on. */
  readonly voiceGapMs: number;
}

export interface ReplyRhythmInput {
  mood: { primary: MoodLabel; context: MoodContext; gesture?: string; companion?: MoodTendency | 'wistful' | null };
  fatigue?: FatiguePhase | null;
  shy?: boolean;
  textIntensity?: number;
  user?: UserPace | null;
  voiceTrial?: boolean;
}

const has = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const FATIGUE: readonly FatiguePhase[] = ['awake', 'light-drowsy', 'drowsy', 'falling-asleep', 'asleep', 'micro-awake'];
const round3 = (value: number) => Math.round(value * 1000) / 1000;
export const clampRhythm = (value: number): number => Number.isFinite(value) ? Math.min(REPLY_RHYTHM_MAX, Math.max(REPLY_RHYTHM_MIN, value)) : 1;

/** The same precedence as the voice tone (shared/speech-mood-tone.ts): the moment's context before a lingering label. */
export function rhythmMoodOf(mood: ReplyRhythmInput['mood']): RhythmMood {
  if (mood.context === 'concern' || mood.context === 'support') return 'comfort';
  if (mood.context === 'disappointment') return 'disappointed';
  if (mood.context === 'offense') return 'neutral';
  if (mood.context === 'positive' || mood.gesture === 'upbeat') return mood.primary === 'excited' ? 'excited' : 'happy';
  switch (mood.primary) {
    case 'excited': return 'excited';
    case 'happy': return 'happy';
    case 'longing': return 'longing';
    case 'disappointed': return 'disappointed';
    case 'sad': return 'sad';
    default: return 'neutral';
  }
}

/**
 * The reply's pace. Every factor multiplies; the product's distance from 1 is scaled by the card's "文字语气强度" (the table is
 * written for the template default 50, so 0 always gives exactly 1 and 100 doubles the effect), then held to 0.85–1.15.
 */
export function replyRhythmFor(input: ReplyRhythmInput): ReplyRhythmCue {
  const mood = rhythmMoodOf(input.mood);
  const fatigue = has(FATIGUE, input.fatigue) && input.fatigue !== 'awake' ? input.fatigue : null;
  const tendency = input.mood.companion === 'playful' || input.mood.companion === 'comfortable' ? input.mood.companion : null;
  const shy = input.shy === true;
  const user = has(USER_PACES, input.user) ? input.user : null;
  const text = typeof input.textIntensity === 'number' && Number.isFinite(input.textIntensity) ? Math.min(100, Math.max(0, input.textIntensity)) : RHYTHM_REFERENCE_TEXT_INTENSITY;
  const raw = RHYTHM_MOOD_FACTORS[mood] * (fatigue ? RHYTHM_FATIGUE_FACTORS[fatigue] : 1) * (tendency ? RHYTHM_TENDENCY_FACTORS[tendency] : 1)
    * (shy ? RHYTHM_SHY_FACTOR : 1) * (user ? RHYTHM_USER_FACTORS[user] : 1);
  const multiplier = text === 0 ? 1 : round3(clampRhythm(1 + (raw - 1) * (text / RHYTHM_REFERENCE_TEXT_INTENSITY)));
  const voiceGapMs = input.voiceTrial === true && multiplier > 1
    ? Math.round(VOICE_GAP_TRIAL_MAX_MS * Math.min(1, (multiplier - 1) / (REPLY_RHYTHM_MAX - 1))) : 0;
  return Object.freeze({ multiplier, mood, fatigue, tendency, shy, user, textIntensity: Math.round(text), voiceGapMs });
}

/**
 * The developer panel's view (developer mode only): the latest reply's cue, whether the bubbles used it (`applied`: the fallback is
 * on; otherwise it is what the fallback would have done), and whether the voice listening trial is on.
 */
export interface ReplyRhythmView { readonly cue: ReplyRhythmCue | null; readonly at: number | null; readonly applied: boolean; readonly voiceTrial: boolean }

/** Plain names of what set the pace, for the developer panel and the experience journal (callers translate them). */
export const RHYTHM_MOOD_LABELS: Readonly<Record<RhythmMood, string>> = Object.freeze({
  neutral: '平常', happy: '开心', excited: '兴奋', comfort: '在安慰你', longing: '想念', disappointed: '失落', sad: '难过',
});
export const RHYTHM_FATIGUE_LABELS: Readonly<Record<FatiguePhase, string>> = Object.freeze({
  awake: '清醒', 'light-drowsy': '有点困', drowsy: '困了', 'falling-asleep': '快睡着', asleep: '睡着了', 'micro-awake': '刚醒',
});
export const RHYTHM_TENDENCY_LABELS: Readonly<Record<RhythmTendency, string>> = Object.freeze({ playful: '爱玩', comfortable: '舒适' });
export const RHYTHM_USER_LABELS: Readonly<Record<UserPace, string>> = Object.freeze({ quick: '你回得快', venting: '你在倾诉' });
export const RHYTHM_SHY_LABEL = '害羞';
/** The sources in a fixed order: mood, fatigue, tendency, shy, the user's pace. */
export function rhythmSourceLabels(cue: Pick<ReplyRhythmCue, 'mood' | 'fatigue' | 'tendency' | 'shy' | 'user'>): string[] {
  return [RHYTHM_MOOD_LABELS[cue.mood], ...(cue.fatigue ? [RHYTHM_FATIGUE_LABELS[cue.fatigue]] : []),
    ...(cue.tendency ? [RHYTHM_TENDENCY_LABELS[cue.tendency]] : []), ...(cue.shy ? [RHYTHM_SHY_LABEL] : []), ...(cue.user ? [RHYTHM_USER_LABELS[cue.user]] : [])];
}
/** "×1.10" (two decimals). */
export const formatRhythmMultiplier = (multiplier: number): string => `×${(Number.isFinite(multiplier) ? multiplier : 1).toFixed(2)}`;

/** What the renderer gets with a reply: the multiplier and whether she is shy. Anything else (or a bad value) is no cue. */
export interface ReplyRhythmPacing { readonly id: string; readonly multiplier: number; readonly shy: boolean }
export function validReplyRhythmPacing(value: unknown): ReplyRhythmPacing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, multiplier, shy } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || typeof multiplier !== 'number' || !Number.isFinite(multiplier)) return null;
  return Object.freeze({ id, multiplier: clampRhythm(multiplier), shy: shy === true });
}

// ---------------------------------------------------------------- the user's pace (shape only; no model, no stored text)

/** Rough boundaries, to be tuned after trial (T-108 found no distribution of Chinese chat lengths to fit). */
export const SHORT_MESSAGE_MAX_CHARS = 8;
export const VENTING_MIN_CHARS = 120;
export const QUICK_GAP_MS = 60_000;
export const QUICK_RUN = 3;
export type UserTurnShape = 'short' | 'venting' | 'other';
const EMOTION = /[唉哎呜]|难受|难过|好烦|烦死|烦躁|郁闷|憋屈|心累|好累|累死|崩溃|委屈|想哭|哭了|气死|生气|焦虑|压力|失眠|撑不住|受不了|不开心|伤心|心酸|酸酸|害怕|孤独|无助|失望|绝望|空落落|讨厌/u;
const LOW_STATES: readonly string[] = ['low', 'annoyed', 'tired'];

let segmenter: Intl.Segmenter | null | undefined;
function graphemes(text: string): string[] {
  if (segmenter === undefined) { try { segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' }); } catch { segmenter = null; } }
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text);
}

/** Characters a reader sees: grapheme clusters that are not whitespace (one emoji, even a combined one, is one). */
export function visibleLength(text: string): number {
  let count = 0;
  for (const piece of graphemes(text)) if (piece.trim()) count++;
  return count;
}

/** Grapheme boundary at or before `index` (never inside a combined emoji); `index` itself when nothing can be told. */
export function graphemeBoundaryAtOrBefore(text: string, from: number, index: number): number {
  if (index <= from || index >= text.length) return index;
  let at = from;
  for (const piece of graphemes(text.slice(from, Math.min(text.length, index + 16)))) {
    if (at + piece.length > index) break;
    at += piece.length;
  }
  return at > from ? at : index;
}

/** Only the shape of the user's message, plus her current read of the user (F2): length, question, code or link, emotion. */
export function userTurnShape(text: string, userState?: string | null): UserTurnShape {
  const value = typeof text === 'string' ? text : '';
  const asks = /[?？]/u.test(value), technical = /```|`|https?:\/\/|www\./iu.test(value);
  const length = visibleLength(value);
  if (length > 0 && length <= SHORT_MESSAGE_MAX_CHARS && !asks) return 'short';
  if (length >= VENTING_MIN_CHARS && !asks && !technical && (EMOTION.test(value) || LOW_STATES.includes(userState ?? ''))) return 'venting';
  return 'other';
}

/** In memory only: the shape and time of the user's last few messages, never their text. */
export class UserPaceTracker {
  private recent: Array<{ at: number; shape: UserTurnShape }> = [];
  /** Note the user's new message and return the pace it gives this reply. */
  note(at: number, text: string, userState?: string | null): UserPace | null {
    const shape = userTurnShape(text, userState);
    this.recent.push({ at, shape });
    if (this.recent.length > QUICK_RUN) this.recent.splice(0, this.recent.length - QUICK_RUN);
    if (shape === 'venting') return 'venting';
    if (shape !== 'short' || this.recent.length < QUICK_RUN || this.recent.some(item => item.shape !== 'short')) return null;
    for (let i = 1; i < this.recent.length; i++) if (!(this.recent[i].at - this.recent[i - 1].at <= QUICK_GAP_MS && this.recent[i].at >= this.recent[i - 1].at)) return null;
    return 'quick';
  }
  clear(): void { this.recent = []; }
}

// ---------------------------------------------------------------- bubble pacing (the renderer's readout uses these)

/** R27's hold after a bubble, now counted in visible characters, times the reply's multiplier. */
export function bubbleHoldMs(visibleChars: number, multiplier = 1): number {
  return Math.max(650, Math.min(4000, 250 + Math.max(0, visibleChars) * 70)) * clampRhythm(multiplier);
}

const ELLIPSIS = /…+/gu;
/**
 * Where a later sentence stops for a moment: just after its first "……" that still has visible text after it inside
 * [from, end). Never in the first bubble (R27), never inside code or next to a link. null: no stop.
 */
export function ellipsisStop(raw: string, from: number, end: number, firstBubbleEnd: number): number | null {
  if (from < firstBubbleEnd || end <= from) return null;
  const part = raw.slice(from, end);
  if (/`|:\/\/|www\./u.test(part)) return null;
  ELLIPSIS.lastIndex = 0;
  for (let match = ELLIPSIS.exec(part); match; match = ELLIPSIS.exec(part)) {
    const stop = from + match.index + match[0].length;
    if (stop < end && raw.slice(stop, end).trim()) return stop;
  }
  return null;
}

/** A sentence she adds as an afterthought, by its opening words only (it is her own text; nothing is invented). */
export function isAfterthought(sentence: string): boolean {
  const text = sentence.trimStart();
  return AFTERTHOUGHT_MARKERS.some(marker => text.startsWith(marker));
}
