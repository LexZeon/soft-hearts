/**
 * I-100: the tone of the user's own voice, heard by the local recognizer (SenseVoice's own event
 * and emotion tags, electron/senses/asr/decode.ts), so that in voice chat and calls she knows a line was said laughing, crying,
 * angry, sad or happy. One closed value per voice turn at most; neutral and everything else give nothing. It is a hint in
 * her turn's private context only (never in the archive, the chat or the mood): she may use it or ignore it, and her reply
 * and the usual bookkeeping decide whether anything about her changes. No audio is kept.
 */
/** The recognizer's whitelisted event and emotion codes for one clip (electron/senses/asr/decode.ts AsrTags). */
interface HeardTags { event: string | null; emotion: string | null }

export const USER_TONES = ['laughing', 'crying', 'angry', 'sad', 'happy'] as const;
export type UserTone = (typeof USER_TONES)[number];

/**
 * The closed tone of one clip, or null. A sound the model heard (laughter, crying) says more than the emotion it guessed,
 * so it comes first; among emotions only angry / sad / happy count (neutral, fearful, disgusted, surprised, other and
 * unknown give nothing: the user asked for laughing, crying, angry, sad and happy).
 */
export function userToneOf(tags: HeardTags | null | undefined): UserTone | null {
  if (!tags) return null;
  if (tags.event === 'laughter') return 'laughing';
  if (tags.event === 'cry') return 'crying';
  if (tags.emotion === 'angry') return 'angry';
  if (tags.emotion === 'sad') return 'sad';
  if (tags.emotion === 'happy') return 'happy';
  return null;
}

const TONE_WORDS: Readonly<Record<UserTone, string>> = Object.freeze({
  laughing: '是笑着说的',
  crying: '带着哭腔',
  angry: '语气像是在生气',
  sad: '语气听起来低落、难过',
  happy: '语气听起来很开心',
});

/** The one private line for her turn ('' for none). Fixed text per closed value; no words of the user, no numbers. */
export function userToneLine(tone: UserTone | null | undefined): string {
  if (!tone || !Object.hasOwn(TONE_WORDS, tone)) return '';
  return `\n（听声音，用户刚才这句话${TONE_WORDS[tone]}。这只是从声音听出来的，可能不准；自然地参考就好，也可以不理会，不要说你"识别""检测"到了什么。）`;
}

/**
 * The tones of the clips that make up one voice turn → the one to tell her: the latest clear one (an earlier laugh still
 * counts when the last clip was neutral). Null when none was clear.
 */
export function turnTone(tones: readonly (UserTone | null)[]): UserTone | null {
  for (let index = tones.length - 1; index >= 0; index--) if (tones[index]) return tones[index];
  return null;
}
