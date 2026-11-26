/**
 * Who may cut her off: pure judgement of one recognized clip.
 *
 * I-204 (2026-11-23, changing the 11-19 rule that only a clear, complete sentence interrupts): a meaningful short phrase is enough, no filter
 * program; the bar is recognition accuracy.
 *
 * While she is speaking, sound alone (loudness, the call's VAD) never stops her: the microphone only starts listening over her
 * (src/senses/MediaInput.ts). Once the clip's words come back, this decides:
 *   - her own voice leaking back through the speakers (echo): the clip matches the part she is reading (or just read) at least
 *     `echoMatchRatio` (character-level similarity against the best-matching stretch of that text, `echoMatch`) → held;
 *   - otherwise `minChars` (3) or more recognized characters → she stops and it is the user's turn ('chars');
 *   - fewer → held ('fragment', or 'filler' when every character is a filler sound): she keeps talking and the clip is not a turn at all.
 * No phrase list, no filler filter, no loudness or duration gate over her: a recognized character counts as it is ("嗯嗯嗯" is three).
 * While she is not speaking everything passes as before, except a short or quiet filler-only clip in continuous listening (a call,
 * or listening for her name): that is almost always noise recognized as "嗯", so it is held (this is not a barge-in rule).
 * No I/O, no clock: the host (electron/voice/utterance-gate.ts) gives it the clip's levels, whether she was speaking and her text.
 */
import { INTERRUPT_KNOBS, type InterruptKnobs } from './knobs';

export type UtteranceKind = 'empty' | 'filler' | 'words';
export type HeldKind = 'filler' | 'fragment' | 'echo';
/** What interrupted her: always recognized characters now ('sentence' / 'command' remain readable in old journal lines only). */
export type InterruptBy = 'chars';
/** The numbers behind a verdict (journal only): recognized characters, and the echo match (null: not compared). */
export interface GateNumbers { chars: number; match: number | null }
export type GateVerdict =
  | ({ pass: true; kind: UtteranceKind; interrupt: InterruptBy | null } & GateNumbers)
  | ({ pass: false; kind: UtteranceKind; held: HeldKind } & GateNumbers);

/** Filler / backchannel sounds (Chinese characters): only for the not-speaking noise rule. */
const FILLER_CHARS = new Set([...'嗯呃啊哦噢唔额呣嗷哎诶欸']);
/** English fillers, letters possibly drawn out ("hmmm", "ummm"). */
const LATIN_FILLER = /^(?:h+m+|m+h*m*|u+h+m*|u+m+|a+h+|o+h+|e+h+|e+r+m*|h+u+h+|m+h+m+)$/;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORDISH = /[\p{L}\p{N}]/u;

interface Token { text: string; cjk: boolean }
function tokens(text: string): Token[] {
  const out: Token[] = [];
  let word = '';
  const flush = () => { if (word) { out.push({ text: word.toLowerCase(), cjk: false }); word = ''; } };
  for (const char of text.normalize('NFKC')) {
    if (CJK.test(char)) { flush(); out.push({ text: char, cjk: true }); }
    else if (WORDISH.test(char)) word += char;
    else flush();
  }
  flush();
  return out;
}
const isFiller = (token: Token) => token.cjk ? FILLER_CHARS.has(token.text) : LATIN_FILLER.test(token.text);

/** How many recognized characters a clip has (a CJK character counts 1, an English word 2; punctuation and spaces 0; fillers count). */
export function countChars(text: string): number {
  return tokens(typeof text === 'string' ? text : '').reduce((sum, token) => sum + (token.cjk ? 1 : 2), 0);
}

/** What the words of a clip are: nothing, filler sounds only, or words; and how many recognized characters (countChars). */
export function classifyWords(text: string): { kind: UtteranceKind; units: number } {
  const list = tokens(typeof text === 'string' ? text : '');
  if (!list.length) return { kind: 'empty', units: 0 };
  const units = list.reduce((sum, token) => sum + (token.cjk ? 1 : 2), 0);
  return { kind: list.every(isFiller) ? 'filler' : 'words', units };
}

export interface ClipLevels { peakDb: number; voicedSeconds: number }

/** The loudest point (dBFS) and the voiced time of a clip (16 kHz samples; 20 ms frames over the floor and near its peak). */
export function clipLevels(samples: Float32Array, sampleRate = 16_000, knobs: InterruptKnobs = INTERRUPT_KNOBS): ClipLevels {
  let peak = 0;
  for (const sample of samples) { const value = Math.abs(sample); if (value > peak) peak = value; }
  const frame = Math.max(1, Math.round(sampleRate * 0.02)), gate = Math.max(knobs.voicedFloor, peak * knobs.voicedPeakShare);
  let voiced = 0;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let energy = 0;
    for (let i = start; i < start + frame; i++) energy += samples[i] * samples[i];
    if (Math.sqrt(energy / frame) >= gate) voiced++;
  }
  return { peakDb: peak > 0 ? Math.max(-120, 20 * Math.log10(peak)) : -120, voicedSeconds: voiced * frame / sampleRate };
}

/** Characters compared, in order (CJK characters and lower-cased letters/digits; no punctuation or spaces). */
const plain = (text: string) => [...tokens(text).map(token => token.text).join('')];
const MAX_CLIP = 160, MAX_HERS = 1_200;

/**
 * I-204 echo match: how well the clip matches the best stretch of her text, 0–1. It is 1 − (the fewest
 * character edits — substitutions, insertions, deletions — that turn the clip into some contiguous stretch of her text) ÷ the clip's
 * length: a sliding window of any width over what she is saying, so a recognizer that got a few of her characters wrong (homophones)
 * still matches. 0 when either side is empty.
 */
export function echoMatch(text: string, herText: string): number {
  const clip = plain(typeof text === 'string' ? text : '').slice(0, MAX_CLIP), hers = plain(typeof herText === 'string' ? herText : '').slice(-MAX_HERS);
  if (!clip.length || !hers.length) return 0;
  // Approximate substring matching (Sellers): row 0 is all zeros, so the match may start anywhere in her text; the best end is the row minimum.
  let previous = new Array<number>(hers.length + 1).fill(0);
  for (let i = 1; i <= clip.length; i++) {
    const row = new Array<number>(hers.length + 1);
    row[0] = i;
    for (let j = 1; j <= hers.length; j++) row[j] = Math.min(previous[j - 1] + (clip[i - 1] === hers[j - 1] ? 0 : 1), previous[j] + 1, row[j - 1] + 1);
    previous = row;
  }
  const edits = Math.min(...previous);
  return Math.max(0, 1 - edits / clip.length);
}

export interface GateInput {
  /** The recognized words. */
  text: string;
  /** The clip's levels; null when they could not be read (only the not-speaking noise rule uses them). */
  levels: ClipLevels | null;
  /** She is speaking now (only then is there anything to interrupt). */
  overHer: boolean;
  /** Continuous listening (a call, or listening for her name), where noise can be recognized as "嗯". */
  continuous: boolean;
  /** What she is reading now or just read (for the echo check); '' or absent: unknown, no echo check. */
  herText?: string;
}

/** The decision for one recognized clip (see the file comment). */
export function judgeUtterance(input: GateInput, knobs: InterruptKnobs = INTERRUPT_KNOBS): GateVerdict {
  const { kind, units: chars } = classifyWords(input.text), levels = input.levels;
  if (kind === 'empty') return { pass: true, kind, interrupt: null, chars, match: null };
  if (input.overHer) {
    const exact = input.herText ? echoMatch(input.text, input.herText) : null, match = exact === null ? null : Math.round(exact * 100) / 100;
    if (exact !== null && exact >= knobs.echoMatchRatio) return { pass: false, kind, held: 'echo', chars, match };
    if (chars >= knobs.minChars) return { pass: true, kind, interrupt: 'chars', chars, match };
    return { pass: false, kind, held: kind === 'filler' ? 'filler' : 'fragment', chars, match };
  }
  if (kind === 'filler' && input.continuous && levels && (levels.voicedSeconds < knobs.fillerMinVoicedSeconds || levels.peakDb < knobs.fillerMinPeakDb))
    return { pass: false, kind, held: 'filler', chars, match: null };
  return { pass: true, kind, interrupt: null, chars, match: null };
}
