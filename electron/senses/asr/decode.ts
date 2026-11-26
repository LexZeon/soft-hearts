/**
 * SenseVoice output → text: greedy CTC (best token per frame, repeats merged, blank dropped), then the special tokens the
 * model writes in front of the text (`<|zh|><|NEUTRAL|><|Speech|><|withitn|>`, events, emotions) are removed and the
 * SentencePiece word marks become spaces. Only the user's words are left. tests/local-asr-decode.test.ts.
 */

/** tokens.txt: one "<piece> <id>" per line, ids 0..N-1 in order. */
export function parseTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const at = line.lastIndexOf(' ');
    if (at <= 0) throw new Error('bad tokens line');
    const id = Number(line.slice(at + 1));
    if (!Number.isInteger(id) || id !== tokens.length) throw new Error('tokens out of order');
    tokens.push(line.slice(0, at));
  }
  if (!tokens.length) throw new Error('no tokens');
  return tokens;
}

/** Greedy CTC over `frames` rows of `vocab` scores: best id per frame, consecutive repeats merged, `blank` dropped. */
export function ctcGreedy(logits: ArrayLike<number>, frames: number, vocab: number, blank = 0): number[] {
  if (logits.length < frames * vocab) throw new Error('logits shorter than frames × vocab');
  const ids: number[] = [];
  let previous = -1;
  for (let f = 0; f < frames; f++) {
    let best = 0, bestScore = -Infinity;
    const row = f * vocab;
    for (let v = 0; v < vocab; v++) { const score = logits[row + v]; if (score > bestScore) { bestScore = score; best = v; } }
    if (best !== previous && best !== blank) ids.push(best);
    previous = best;
  }
  return ids;
}

const SPECIAL = /^<\|([^|]*)\|>$/;

/**
 * The tags SenseVoice writes in front of the words, as closed lists (2026-11-03, listening/watching transcription): only
 * these leave the decoder, as our own short codes; any other tag (another language, `nospeech`, `withitn` …) is dropped.
 * Language: the model's own detection (meaningful when it was asked to detect, i.e. language `auto`).
 * Event: what kind of sound it heard (speech, background music, singing, laughter …). Emotion: the speaker's tone.
 * Not used by any behaviour yet; a later design may tell music from dialogue with them.
 */
export const ASR_LANGUAGE_TAGS = ['zh', 'en', 'yue', 'ja', 'ko'] as const;
export type AsrLanguageTag = (typeof ASR_LANGUAGE_TAGS)[number];
const EVENT_TAGS = { Speech: 'speech', BGM: 'bgm', Sing: 'sing', Laughter: 'laughter', Applause: 'applause', Cry: 'cry', Sneeze: 'sneeze',
  Breath: 'breath', Cough: 'cough', Speech_Noise: 'speech-noise', Event_UNK: 'unknown' } as const;
export type AsrEventTag = (typeof EVENT_TAGS)[keyof typeof EVENT_TAGS];
export const ASR_EVENT_TAGS = Object.freeze([...new Set(Object.values(EVENT_TAGS))]) as readonly AsrEventTag[];
const EMOTION_TAGS = { HAPPY: 'happy', SAD: 'sad', ANGRY: 'angry', NEUTRAL: 'neutral', FEARFUL: 'fearful', DISGUSTED: 'disgusted',
  SURPRISED: 'surprised', OTHER: 'other', EMO_UNKNOWN: 'unknown' } as const;
export type AsrEmotionTag = (typeof EMOTION_TAGS)[keyof typeof EMOTION_TAGS];
export const ASR_EMOTION_TAGS = Object.freeze([...new Set(Object.values(EMOTION_TAGS))]) as readonly AsrEmotionTag[];

export interface AsrTags { language: AsrLanguageTag | null; event: AsrEventTag | null; emotion: AsrEmotionTag | null }
export interface AsrUtterance extends AsrTags { text: string }

const own = <T extends object>(table: T, key: string): key is Extract<keyof T, string> => Object.hasOwn(table, key);

/** Ids → the words (no tag left in them) and the first whitelisted language, event and emotion tag the model wrote. */
export function tokensToUtterance(ids: readonly number[], tokens: readonly string[]): AsrUtterance {
  let text = '', language: AsrLanguageTag | null = null, event: AsrEventTag | null = null, emotion: AsrEmotionTag | null = null;
  for (const id of ids) {
    const piece = tokens[id];
    if (piece === undefined || piece === '<unk>' || piece === '<s>' || piece === '</s>') continue;
    const special = SPECIAL.exec(piece);
    if (special) {
      const tag = special[1]!;
      if (!language && (ASR_LANGUAGE_TAGS as readonly string[]).includes(tag)) language = tag as AsrLanguageTag;
      else if (!event && own(EVENT_TAGS, tag)) event = EVENT_TAGS[tag];
      else if (!emotion && own(EMOTION_TAGS, tag)) emotion = EMOTION_TAGS[tag];
      continue;
    }
    text += piece;
  }
  // "▁" marks the start of a word in SentencePiece; Chinese pieces have none.
  text = text.replace(/▁/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, language, event, emotion };
}

/** Ids → the user's words; `language` is the model's own language tag when it wrote one (whitelisted). */
export function tokensToText(ids: readonly number[], tokens: readonly string[]): { text: string; language: AsrLanguageTag | null } {
  const { text, language } = tokensToUtterance(ids, tokens);
  return { text, language };
}
