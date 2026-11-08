/**
 * #5 主机这一侧的真实现：回复显示完以后，气泡留多久由她定（接口见 interface.ts，旋钮见 knobs.ts）。
 * 纯本地、零额度、不碰聊天提示词；只在内存里记最近几次"为什么"，不进体验记录和存档。
 */
import { validReplyPieces } from '../../reply-bubbles';
import { MOOD_LABELS } from '../../mood-runtime';
import type { MoodLabel, MoodSnapshot, MoodTendency } from '../../mood';
import type { FatiguePhase } from '../../fatigue';
import { REPLY_LINGER_KNOBS, type ReplyLingerKnobs } from './knobs';
import type { ReplyLingerBubble, ReplyLingerChoice, ReplyLingerHost, ReplyLingerMood, ReplyLingerNow, ReplyLingerWaiting, ReplyLingerWhy } from './interface';
import { safeLingerMs } from './perform';
import { tendencyNow } from '../../mood-tendency';

const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];
const NOW_WORDS: Readonly<Record<MoodTendency | 'wistful', string>> = {
  playful: '这会儿有点调皮', close: '这会儿想黏着你', comfortable: '这会儿很放松', cautious: '这会儿有点拘谨', wistful: '还在想念的余韵里',
};
/** 角色卡性格：高于一般 / 低于一般。 */
const PERSONALITY_WORDS: Readonly<Record<MoodTendency, readonly [string, string]>> = {
  playful: ['性格：爱玩', '性格：不太爱玩'], close: ['性格：黏人', '性格：不太黏人'],
  comfortable: ['性格：随和', '性格：不太随和'], cautious: ['性格：谨慎', '性格：大胆'],
};
const WAITING_WORDS: Readonly<Record<ReplyLingerWaiting, string>> = { question: '最后一句在问你', handover: '最后一句把话递给你' };
/** 倍数离 1 至少这么远才算一条理由（和"她来挑"一样）。 */
const REASON_MIN = 0.05;
/** 最近几次"为什么"留多少条（只在内存）。 */
const KEEP_WHY = 8;

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const unit = (value: unknown): number => Math.min(1 - 1e-12, Math.max(0, finite(value, 0)));
const clamp = (value: number, [low, high]: readonly [number, number]): number => Math.min(high, Math.max(low, value));
const seconds = (ms: number): string => (Math.round(ms / 100) / 10).toFixed(1);

// ---------------------------------------------------------------- the last bubble and how much there is to read

/** An emoji, whatever it is made of: a pictograph, a flag (two regional indicators), a keycap (a digit, U+FE0F, U+20E3). */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
/** One whole character each: Han, kana, Hangul. */
const WHOLE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER = /[\p{L}\p{N}]/u;

let segmenter: Intl.Segmenter | null | undefined;
function graphemes(text: string): string[] {
  if (segmenter === undefined) { try { segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' }); } catch { segmenter = null; } }
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text);
}
/**
 * What one grapheme is to a reader (one classification for counting and for finding her last bubble, Codex T-207 2A/2B):
 * an emoji (checked first, so a keycap's digit does not make it letters), a whole character, a letter or digit, or nothing
 * to read (punctuation, "～", symbols, spaces).
 */
function readAs(piece: string): 'emoji' | 'whole' | 'letter' | null {
  if (EMOJI.test(piece)) return 'emoji';
  if (WHOLE.test(piece)) return 'whole';
  return LETTER.test(piece) ? 'letter' : null;
}
/** A piece with words in it; a bare "～", "……" or emoji is not one (it rides with the sentence before it). */
const hasWords = (text: string): boolean => graphemes(text).some(piece => { const kind = readAs(piece); return kind === 'whole' || kind === 'letter'; });

/**
 * How many characters there are to read: Han, kana, Hangul and every emoji (a flag or a keycap too) count 1 each,
 * `lettersPerChar` Latin letters or digits count 1 (a word reads like one or two Chinese characters), punctuation, symbols
 * and spaces count 0.
 */
export function readableChars(text: string, knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS): number {
  if (typeof text !== 'string' || !text) return 0;
  const per = Math.max(1, finite(knobs.readable.lettersPerChar, 3));
  let whole = 0, letters = 0;
  for (const piece of graphemes(text.length > 40_000 ? text.slice(-40_000) : text)) {
    const kind = readAs(piece);
    if (kind === 'emoji' || kind === 'whole') whole++;
    else if (kind === 'letter') letters++;
  }
  return Math.round((whole + letters / per) * 10) / 10;
}

/**
 * Her last bubble as the window shows it: from the last piece with words in it to the end (a trailing "😊" or "～" piece rides
 * with the sentence before it, so a long sentence followed by an emoji bubble is read as a whole, Codex T-207 2A; the
 * window still shows the emoji as its own bubble). R27 pieces (sentences or paragraphs), a proactive message's blank-line
 * paragraphs, or the whole text when it is one bubble.
 */
export function lastBubble(bubble: ReplyLingerBubble): string {
  const text = typeof bubble?.text === 'string' ? bubble.text : '';
  if (!text.trim()) return '';
  let starts: number[];
  if (bubble.pieces && validReplyPieces(bubble.pieces, text)) starts = [0, ...bubble.pieces.ends.slice(0, -1)];
  else if (bubble.segmented) {
    starts = [0];
    for (const match of text.matchAll(/\n[ \t]*\n\s*/gu)) starts.push(match.index! + match[0].length);
  } else return text;
  for (let i = starts.length - 1; i >= 0; i--) {
    const slice = text.slice(starts[i]);
    if (hasWords(text.slice(starts[i], starts[i + 1] ?? text.length))) return slice;
  }
  return text;
}

/** Up to a few trailing characters that are not words (punctuation, "～", an emoji, a kaomoji's symbols) after the end. */
const TAIL = String.raw`[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9]{0,16}$`;
const QUESTION = new RegExp(String.raw`(?:[?？]|吗)` + TAIL, 'u');
// "你呢" hands over only at the start of its clause ("那你呢""……，你呢"), not inside one ("我在想你呢").
const HANDOVER = new RegExp(String.raw`(?:(?:^|(?<=[\s\p{P}\p{S}那换]))你(?:呢|说呢|觉得呢|怎么看|先说)|跟我说说|和我说说|跟我讲讲|说给我听听?|讲给我听听?|告诉我|说来听听|讲讲看|说说看|轮到你了?|换你了?|等你(?:回我|说|的回答|的消息)?|tell me(?: more| about it)?|what about you|how about you|your turn)`
  + String.raw`[吧呀嘛啊哦呗喔哟嗷呦]*` + TAIL, 'iu');

/**
 * Is her last sentence waiting for you? The smallest testable reading of her own words (nothing is asked of the model):
 *  - 'question': it ends with "？"/"?" or with "吗" (only punctuation, "～", emoji or a kaomoji's symbols after it);
 *  - 'handover': it ends by handing the word to you ("你呢""你觉得呢""跟我说说""告诉我""说来听听""轮到你了""等你"…).
 * Known limits: a rhetorical question ("你怎么这么笨啊？") counts as asking (she only waits a little longer); a question or
 * hand-over that is not her last sentence does not count; "呢""吧" alone are not read as asking (too often not).
 */
export function waitingForYou(sentence: string): ReplyLingerWaiting | null {
  if (typeof sentence !== 'string' || !sentence.trim()) return null;
  const tail = sentence.trimEnd().slice(-80);
  if (QUESTION.test(tail)) return 'question';
  if (HANDOVER.test(tail)) return 'handover';
  return null;
}

// ---------------------------------------------------------------- her mood and card, as MoodHost hands them over

export interface ReplyLingerMoodInput {
  /** `tendencies` (the snapshot's own strengths) lets a leftover hair above baseline stop counting (shared/mood-tendency.ts). */
  readonly snapshot: Pick<MoodSnapshot, 'primary' | 'companion'> & { readonly tendencies?: MoodSnapshot['tendencies'] | null };
  readonly personality: Partial<Record<MoodTendency, number>> | null | undefined;
  readonly fatiguePhase?: FatiguePhase | null;
}

export function replyLingerMood(input: ReplyLingerMoodInput): ReplyLingerMood {
  const s = input.snapshot;
  const mood = (Object.hasOwn(MOOD_LABELS, s.primary) ? s.primary : 'calm') as MoodLabel;
  const tendency = tendencyNow(s);
  const personality = Object.fromEntries(TENDENCIES.map(t => [t, Math.min(4, Math.max(0, finite(input.personality?.[t], 1)))])) as Record<MoodTendency, number>;
  return { mood, tendency, personality, drowsy: input.fatiguePhase === 'drowsy' || input.fatiguePhase === 'light-drowsy' };
}

/** The window's bubble plus her mood → "此刻" (only counts are kept; her words stop here). */
export function replyLingerNow(bubble: ReplyLingerBubble, mood: ReplyLingerMood | null, knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS): ReplyLingerNow {
  const last = lastBubble(bubble);
  return { chars: readableChars(last, knobs), waiting: waitingForYou(last), mood };
}

// ---------------------------------------------------------------- the choice

const direction = (factor: number): string => factor > 1 ? '多留一会儿' : '收得早一点';

/**
 * How long this reply stays: the readable floor (never shortened by mood) plus an afterglow picked once in `after`, times her
 * mood, tendency, card and drowsiness (together within `lean`), times `waiting` when her last sentence waits for you; then held
 * to `range`. Exactly one random() per call, so a knob never shifts a later draw.
 */
export function chooseReplyLinger(now: ReplyLingerNow, random: () => number, knobs: ReplyLingerKnobs = REPLY_LINGER_KNOBS): ReplyLingerChoice {
  const roll = unit(random());
  const chars = Math.max(0, finite(now.chars, 0));
  const perSecond = Math.max(0.5, finite(knobs.readable.charsPerSecond, 6));
  const readMs = Math.max(0, finite(knobs.readable.noticeMs, 0)) + chars / perSecond * 1000;
  const lean: { text: string; factor: number }[] = [];
  const m = now.mood;
  if (m) {
    const mood = knobs.mood[m.mood];
    if (mood !== undefined) lean.push({ text: `心情：${MOOD_LABELS[m.mood]}`, factor: mood });
    if (m.tendency) { const value = knobs.now[m.tendency]; if (value !== undefined) lean.push({ text: NOW_WORDS[m.tendency], factor: value }); }
    for (const trait of TENDENCIES) {
      const strength = knobs.personality[trait];
      if (!strength) continue;
      const value = finite(m.personality[trait], 1), factor = Math.min(1.35, Math.max(0.75, 1 + strength * 2 * (value - 1)));
      if (Math.abs(factor - 1) >= REASON_MIN) lean.push({ text: PERSONALITY_WORDS[trait][value > 1 ? 0 : 1], factor });
    }
    if (m.drowsy) lean.push({ text: '有点困', factor: knobs.drowsy });
  }
  const leaning = clamp(lean.reduce((product, reason) => product * Math.max(0, finite(reason.factor, 1)), 1), knobs.lean);
  const wait = now.waiting ? Math.max(0, finite(knobs.waiting[now.waiting], 1)) : 1;
  const [low, high] = knobs.after;
  const afterMs = (low + (high - low) * roll) * leaning * wait;
  const ms = safeLingerMs(readMs + afterMs, knobs);
  const why: string[] = [];
  if (now.waiting && Math.abs(wait - 1) >= REASON_MIN) why.push(`${WAITING_WORDS[now.waiting]}（${direction(wait)}）`);
  why.push(`${Math.round(chars)} 个字（读完约 ${seconds(readMs)} 秒）`);
  for (const reason of lean) if (Math.abs(reason.factor - 1) >= REASON_MIN) why.push(`${reason.text}（${direction(reason.factor)}）`);
  if (ms >= knobs.range[1] && readMs + afterMs > knobs.range[1]) why.push(`太长了，最多留 ${seconds(knobs.range[1])} 秒（全文可以点"查看完整回复"）`);
  else if (ms <= knobs.range[0] && readMs + afterMs < knobs.range[0]) why.push(`很短，至少留 ${seconds(knobs.range[0])} 秒`);
  return { ms, readMs: Math.round(readMs), afterMs: Math.round(afterMs), why };
}

// ---------------------------------------------------------------- the real host side

/** 真实现（接口见 interface.ts ReplyLingerHost）。 */
export class ReplyLingerDirector implements ReplyLingerHost {
  private readonly log: (ReplyLingerWhy & { characterId: string })[] = [];
  private readonly knobs: ReplyLingerKnobs;
  private readonly random: () => number;
  private readonly clock: () => number;

  constructor(options: { knobs?: ReplyLingerKnobs; random?: () => number; clock?: () => number } = {}) {
    this.knobs = options.knobs ?? REPLY_LINGER_KNOBS;
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? Date.now;
  }

  decide(characterId: string, bubble: ReplyLingerBubble, mood: ReplyLingerMood | null): number {
    let choice: ReplyLingerChoice;
    // Reading her words or her mood can never throw into the reply: the bubble then simply stays the longest.
    try { choice = chooseReplyLinger(replyLingerNow(bubble, mood, this.knobs), this.random, this.knobs); } catch { return safeLingerMs(NaN, this.knobs); }
    if (typeof characterId === 'string' && characterId) {
      this.log.unshift({ characterId, at: this.clock(), ms: choice.ms, why: [...choice.why] });
      this.log.splice(KEEP_WHY * 4);
    }
    return choice.ms;
  }

  recent(characterId: string): readonly ReplyLingerWhy[] {
    return this.log.filter(entry => entry.characterId === characterId).slice(0, KEEP_WHY)
      .map(({ characterId: _, ...entry }) => ({ ...entry, why: [...entry.why] }));
  }
}

const standalone = new ReplyLingerDirector();
/** The reply window's default when nothing hands it her mood (tests, or no character yet): the same choice, without mood. */
export const replyLingerWithoutMood = (bubble: ReplyLingerBubble): number => standalone.decide('', bubble, null);
