/**
 * I-203 frames (2026-11-23: a hug or a kiss may keep walking while she speaks, pause, then let go, all of it her choreography, with
 * the hug and the let-go set as frames; agreed 2026-11-24): a kiss or a hug she writes is choreographed by her, frame by frame, with hidden
 * markers between her words (shared/behaviors/speech-beats/: ⟦hug⟧ / ⟦kiss⟧ start, ⟦hug-held⟧, ⟦pause⟧ / ⟦pause long⟧, ⟦let-go⟧). The parts here
 * are pure:
 *   - HoldFrames: how a held close moment reads her frames: a let-go ends the hold at its place (or, written before she arrived, after the floor),
 *     a pause keeps the hold through it; otherwise the plain rule (shared/unbound/arrival/hold.ts holdGoesOn: on while she speaks, her own length,
 *     a moment after) — so with only ⟦hug⟧ she lets go once her words are done and her own hold has passed. The cap stays.
 *   - the page's report that it reached a pause or a let-go (parseFrameBeatAsk: only these keys and words);
 *   - pause lengths (CLOSE_FRAME_KNOBS);
 *   - the facts her one immediate turn gets when a kiss or a hug she wrote was interrupted (closeCutLine), in her chat's language. Facts only
 *     (2026-11-24: no preset wording, only information, such as that the user pulled her away): which moment, which frame, why, where in her
 *     words, what she had said and what she still meant to say; never a wording, never how to react, no "不要/别".
 */
import { ARRIVAL_KNOBS } from '../arrival';
import { CLOSE_FRAME_KNOBS } from './knobs';

/** Seconds a pause holds her words (long: the longer one; knobs.ts CLOSE_FRAME_KNOBS). */
export const pauseSeconds = (long: boolean): number => long ? CLOSE_FRAME_KNOBS.pauseLongS : CLOSE_FRAME_KNOBS.pauseS;

/** The hold's frames: absolute times are the caller's own clock (s). */
export class HoldFrames {
  /** Her let-go: the hold ends at this many seconds into it (null: none written yet). */
  private endAt: number | null = null;
  /** Until this time (the caller's clock) a pause keeps her holding. */
  private keepUntil = -Infinity;
  /** A let-go was written (tests, the record). */
  get letGoAsked(): boolean { return this.endAt !== null; }
  /**
   * ⟦let-go⟧ reached: `holdBeat` is how long she has held (null: she is not holding yet, so she lets go once she has held the floor, the
   * storyboard's ~1.5 s). An earlier let-go stands.
   */
  letGo(holdBeat: number | null, floorS: number = ARRIVAL_KNOBS.closeHoldMinS): void {
    if (this.endAt !== null) return;
    this.endAt = holdBeat === null ? Math.max(0, floorS) : Math.max(0, holdBeat);
  }
  /** ⟦pause⟧ reached at `now` (the caller's clock) for `seconds`: she keeps holding through it. */
  keep(now: number, seconds: number): void {
    if (Number.isFinite(now) && Number.isFinite(seconds) && seconds > 0) this.keepUntil = Math.max(this.keepUntil, now + seconds);
  }
  /**
   * Does the hold go on this frame? `plain`: holdGoesOn's answer; `holdBeat`: seconds held; `now`: the caller's clock. A let-go wins over
   * everything but the cap; a pause keeps it on; the cap always ends it.
   */
  goesOn(plain: boolean, holdBeat: number, now: number, capS: number = ARRIVAL_KNOBS.holdCapS): boolean {
    if (!(holdBeat < capS)) return false;
    if (this.endAt !== null) return holdBeat < this.endAt;
    return plain || now < this.keepUntil;
  }
}

/** The page's report that her words reached a pause or a let-go (api.peekReport({ frameBeat })): only these keys, only these words. */
export interface FrameBeatAsk { frameBeat: 'pause' | 'let-go'; long?: true }
export function parseFrameBeatAsk(value: unknown): FrameBeatAsk | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>, keys = Object.keys(v);
  if (keys.some(key => key !== 'frameBeat' && key !== 'long') || (v.frameBeat !== 'pause' && v.frameBeat !== 'let-go')) return null;
  if (v.long !== undefined && v.long !== true) return null;
  return v.frameBeat === 'pause' && v.long === true ? { frameBeat: 'pause', long: true } : { frameBeat: v.frameBeat };
}

// ---- the facts of an interrupted kiss or hug ----------------------------------------------------------------------------------------------

/** Which frame the moment was at when it was cut: walking over (or leaning in), or holding. */
export type CloseCutFrame = 'walking' | 'holding';
export type CloseCutCause = 'pulled-away' | 'could-not-reach';
export interface CloseCutFacts {
  kind: 'kiss' | 'hug';
  frame: CloseCutFrame;
  cause: CloseCutCause;
  /** Her reply's words: said in full, the sentence she was in when they stopped, and the rest she had not said (offsets from the cut record). */
  said: string; sentence: string; rest: string;
}
const MAX = { said: 240, sentence: 240, rest: 400 } as const;
const flat = (text: unknown) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
const tail = (text: string, max: number) => { const chars = Array.from(text); return chars.length > max ? `…${chars.slice(-max).join('')}` : text; };
const head = (text: string, max: number) => { const chars = Array.from(text); return chars.length > max ? `${chars.slice(0, max).join('')}…` : text; };

/** The parts of a reply at a cut point (offsets clamped to the text). */
export function closeCutParts(text: string, saidEnd: number, sentenceEnd: number): { said: string; sentence: string; rest: string } {
  const all = typeof text === 'string' ? text : '';
  const a = Math.max(0, Math.min(all.length, Math.floor(saidEnd) || 0)), b = Math.max(a, Math.min(all.length, Math.floor(sentenceEnd) || 0));
  return { said: flat(all.slice(0, a)), sentence: flat(all.slice(a, b)), rest: flat(all.slice(b)) };
}

/**
 * Her one immediate turn's facts ('' when the facts are not usable). Facts only: what happened, where, why, her own words; nothing about how to
 * react or what to say (the mutation "the immediate turn note suggests what to say" checks this stays so).
 */
export function closeCutLine(facts: CloseCutFacts, language?: string | null): string {
  if (!facts || (facts.kind !== 'kiss' && facts.kind !== 'hug') || (facts.frame !== 'walking' && facts.frame !== 'holding')
    || (facts.cause !== 'pulled-away' && facts.cause !== 'could-not-reach')) return '';
  const said = tail(flat(facts.said), MAX.said), sentence = head(flat(facts.sentence), MAX.sentence), rest = head(flat(facts.rest), MAX.rest);
  if (language === 'en') {
    const act = facts.kind === 'kiss' ? 'kiss' : 'hug';
    const where = facts.frame === 'walking' ? `you were on your way over to ${act} the user` : `you were ${facts.kind === 'kiss' ? 'kissing' : 'hugging'} the user`;
    const why = facts.cause === 'pulled-away' ? 'the user pulled you away with the mouse' : 'your face could not reach the user';
    return [`Just now, partway through your last reply, ${where}, and ${why}; the ${act} stopped there, and so did your words.`,
      `- Already said: "${said || '(nothing yet)'}"`,
      sentence ? `- The sentence you were saying when they stopped (maybe only part of it was heard): "${sentence}"` : '- Your words stopped between two sentences.',
      `- Not said yet (the user did not hear it): "${rest || '(nothing)'}"`].join('\n');
  }
  const act = facts.kind === 'kiss' ? '亲' : '抱';
  const where = facts.frame === 'walking' ? `你正走过去${act}用户` : `你正${act}着用户`;
  const why = facts.cause === 'pulled-away' ? '用户用鼠标把你拉开了' : '你的脸够不到用户跟前';
  return [`刚才你上一条回复说到一半，${where}，${why}；这一下${act}就停在那里，你的话也停在那里。`,
    `- 已经说出口的：「${said || '（还没有）'}」`,
    sentence ? `- 话停下时正在说的这一句（可能只说出了一部分）：「${sentence}」` : '- 话停在两句之间：上一句说完了，下一句还没开口。',
    `- 还没说出来的（用户没听到）：「${rest || '（没有）'}」`].join('\n');
}
