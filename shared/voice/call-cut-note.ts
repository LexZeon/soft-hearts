/**
 * I-204: the private line her
 * next call turn gets after the user cut her reading. Information only, closed wording, in her chat's language:
 *   - that the user interrupted her;
 *   - where: the sentence her voice stopped in (or "between two sentences"), as reported by the reading window's sentence starts and ends;
 *   - what she had already said aloud, and the unspoken rest of what she wrote (marked: not heard, not to be read on, not said);
 *   - the user's line that cut her.
 * The rest is never continued automatically and never archived as said: this line rides with the turn's private context only (like the
 * call's spoken-style line), never the chat, the archive or her stable prompt. Pure.
 */
import type { CardLanguage } from '../foundation/character-card';
import type { CutCause, CutRecord } from '../foundation/reply-cut';

/** Where her voice stopped in the reply's written text (offsets into it). */
export interface CallCutPoint {
  /** The reading window reported at least one of this reply's sentences; false: where she stopped is unknown. */
  known: boolean;
  /** text[0, saidEnd) was said aloud in full. */
  saidEnd: number;
  /** text[saidEnd, sentenceEnd) is the sentence being read when her voice stopped ('' when she stopped between two sentences). */
  sentenceEnd: number;
}

export interface CallCut extends CallCutPoint {
  /** Her reply as she wrote it (the whole of it, read or not). */
  text: string;
  /** The user's line that cut her ('' when unknown, and always '' for a cut that was not the user speaking). */
  userLine: string;
  /** Why her words stopped (shared/foundation/reply-cut.ts); absent: the user spoke (a call barge-in, as before). */
  cause?: CutCause;
}

const SAID_MAX = 240, SENTENCE_MAX = 240, REST_MAX = 400, LINE_MAX = 200;
const tail = (text: string, max: number) => text.length > max ? `…${text.slice(-max)}` : text;
const head = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The parts of a cut: said, the sentence being read, the unspoken rest (clamped to the text). */
export function cutParts(cut: CallCut): { said: string; sentence: string; rest: string } {
  const text = typeof cut.text === 'string' ? cut.text : '';
  const saidEnd = Math.max(0, Math.min(text.length, Math.floor(cut.saidEnd) || 0));
  const sentenceEnd = Math.max(saidEnd, Math.min(text.length, Math.floor(cut.sentenceEnd) || 0));
  return { said: clean(text.slice(0, saidEnd)), sentence: clean(text.slice(saidEnd, sentenceEnd)), rest: clean(text.slice(sentenceEnd)) };
}

/** Nothing of the reply was left unsaid: the reading window reported its last sentence finished (no cut to tell). */
export function nothingCut(cut: CallCut): boolean {
  if (!cut.known) return false;
  const parts = cutParts(cut);
  return !parts.sentence && !parts.rest;
}

const OPENING: Record<CutCause, { en: string; zh: string }> = {
  'user-spoke': { en: 'The user interrupted you on the call: you were partway through reading your last reply aloud, the user started talking, and you stopped to listen.', zh: '通话中你被用户打断了：你上一条回复念到一半，用户开口说话，你就停下来听了。' }, // ui-zh-ok: 给模型的话
  'pulled-away': { en: 'You were interrupted: partway through your last reply the user pulled you away, and your words stopped there.', zh: '你被打断了：上一条回复说到一半，用户把你拉开了，你的话就停在那里。' }, // ui-zh-ok: 给模型的话
  'could-not-reach': { en: 'You were interrupted: partway through your last reply you could not reach the user, and your words stopped there.', zh: '你被打断了：上一条回复说到一半，你够不到用户，你的话就停在那里。' }, // ui-zh-ok: 给模型的话
  other: { en: 'You were interrupted partway through your last reply, and your words stopped there.', zh: '你上一条回复说到一半被打断了，你的话就停在那里。' }, // ui-zh-ok: 给模型的话
};

/**
 * The facts for her next turn ('' when nothing was cut): that she was interrupted and why, where, what she had said, what she still meant
 * to say, and the user's line when it was the user speaking. Facts only: no instruction on how to react.
 */
export function callCutNote(cut: CallCut, language: CardLanguage | null | undefined): string {
  if (nothingCut(cut)) return '';
  const cause: CutCause = cut.cause ?? 'user-spoke', spoken = cause === 'user-spoke';
  const { said, sentence, rest } = cutParts(cut), line = spoken ? head(clean(typeof cut.userLine === 'string' ? cut.userLine : ''), LINE_MAX) : '';
  if (language === 'en') {
    const where = !cut.known ? ['- Where your words stopped was not reported; what you had not said yet was not heard.']
      : [`- Already ${spoken ? 'said aloud' : 'said'}: "${said ? tail(said, SAID_MAX) : '(nothing yet)'}"`,
        sentence ? `- The sentence you were saying when your words stopped (maybe only part of it was heard): "${head(sentence, SENTENCE_MAX)}"` : '- Your words stopped between two sentences.',
        `- Not said yet (the user did not hear it; this only tells you what you had meant to say: it was not said, and the reply was not continued): "${rest ? head(rest, REST_MAX) : '(nothing)'}"`];
    return [`\n(${OPENING[cause].en}`, ...where, ...(line ? [`- What the user said to interrupt you: "${line}"`] : []), ')'].join('\n');
  }
  // ui-zh-ok: 给模型的话（下面几行都是）
  const say = spoken ? '念' : '说'; // ui-zh-ok: 给模型的话
  const where = !cut.known ? [`- ${say}到哪里没有收到记录；没${say}的部分用户没有听到。`] // ui-zh-ok: 给模型的话
    : [`- 已经${spoken ? '念出声' : '说出口'}的：「${said ? tail(said, SAID_MAX) : '（还没有）'}」`, // ui-zh-ok: 给模型的话
      sentence ? `- ${spoken ? '你的声音' : '你的话'}停下时正在${say}的这一句（可能只${say}出了一部分）：「${head(sentence, SENTENCE_MAX)}」` : `- ${spoken ? '你的声音' : '你的话'}停在两句之间：上一句${say}完了，下一句还没开口。`, // ui-zh-ok: 给模型的话
      `- 还没${say}出来的（用户没听到；这只是让你知道自己原本还想说什么，没有${say}出口，也没有接着${say}）：「${rest ? head(rest, REST_MAX) : '（没有）'}」`]; // ui-zh-ok: 给模型的话
  return [`\n（${OPENING[cause].zh}`, ...where, ...(line ? [`- 用户打断你时说的：「${line}」`] : []), '）'].join('\n'); // ui-zh-ok: 给模型的话
}

/**
 * The same facts from a stored cut record and the reply it belongs to. The Unbound close moment calls this for a kiss or hug cut short
 * by a pull or a face that cannot reach. `text` is the reply as archived; the offsets are clamped to it.
 */
export function cutRecordNote(cut: CutRecord, text: string, language: CardLanguage | null | undefined, userLine = ''): string {
  return callCutNote({ ...cut, text, userLine }, language);
}

