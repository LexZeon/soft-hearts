/**
 * I-212 item 10: two hidden,
 * closed markers in her reply, in the ⟪…⟫ family (the alarm and milestone markers' brackets; the speech-beats filter takes every ⟪…⟫ out of the
 * text in every path, so they are never shown and never read aloud):
 *   ⟪keep-place⟫   keeps the spot where she stands now as the place the user set for her to appear at;
 *   ⟪clear-place⟫  clears it.
 * No program recognises the user's words: SHE understands whether the user wants it. Her word list only says what the two words are, never when
 * to use them. Whether one takes effect is the host's (electron/unbound/place-marks.ts): only in her reply to a message the user just sent, only
 * while she stands in full screen, at most once per reply; no dialog (two numbers, nothing private). Pure.
 */
export const PLACE_MARK_WORDS = ['keep-place', 'clear-place'] as const;
export type PlaceMarkWord = (typeof PLACE_MARK_WORDS)[number];

/** The first place marker among a finished reply's ⟪…⟫ bodies (null: none). One per reply: later ones are not read. */
export function placeMarkOf(bodies: readonly string[] | null | undefined): PlaceMarkWord | null {
  for (const body of bodies ?? []) {
    const word = typeof body === 'string' ? body.trim().toLowerCase() : '';
    if ((PLACE_MARK_WORDS as readonly string[]).includes(word)) return word as PlaceMarkWord;
  }
  return null;
}

/** Her word list's line for the two markers (full screen only): what they are, nothing about when. */
export function placeMarkWordsLine(language?: string | null): string {
  return language === 'en'
    ? 'Hidden markers you can write: ⟪keep-place⟫ keeps the spot where you stand now as the place the user set for you to appear at; ⟪clear-place⟫ clears it. Markers are never shown or read aloud.'
    : '可以写的隐藏记号：⟪keep-place⟫ 把你此刻站的地方记成用户给你定的出场位置；⟪clear-place⟫ 清掉它。记号不显示、不朗读。';
}
