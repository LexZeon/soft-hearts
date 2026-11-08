// What the voice reads of a sentence she shows (docs/claude/2026-11-03-draft-leak-fix.md): a stage direction in brackets or
// between single asterisks ("（把脸埋低）", "(smiles)", "*揉了揉眼睛*") and a kaomoji in brackets stay in the bubble but are
// not read aloud. Applied at the last step before a voice engine (system voice in the renderer, the cloud voice in the host
// after the segment was authorized against what the bubble shows), so the display, the archive and that check are unchanged.
//
// A direction can be long, run over a line break, hold another bracket, or be cut in two by the sentence segmenter (the
// cloud voice gets one sentence at a time, so "（她愣了一下。然后笑了）好呀。" arrives as "（她愣了一下。" and "然后笑了）好呀。";
// docs/claude/2026-11-03-draft-first-char.md). A full-width bracket left open runs to the end of its line, and a closing one
// with no opening bracket before it ends a direction that began earlier, unless it closes a list number ("1）先吃饭").

/** A pair of brackets around up to a paragraph of text (single line breaks inside), innermost first. */
const FULL_WIDTH = /（(?:[^（）\n]|\n(?![ \t　]*\n)){0,300}）/gu;
const HALF_WIDTH = /\((?:[^()\n]|\n(?![ \t　]*\n)){0,300}\)/gu;
// One pair of single asterisks around a short action, not "**bold**" and not "2 * 3 * 4" (blanks just inside the stars).
const STARS = /(?<!\*)\*(?![\s*])([^*\n]{1,60}?)(?<![\s*])\*(?!\*)/gu;
/** What may stand in front of "）" when it numbers a list item, not ends a direction: "1）", "b）", "三）", after a blank or a mark. */
const LIST_NUMBER = /(?:^|[\s，。：:；;、！？!?])(?:\d{1,2}|[A-Za-z]|[一二三四五六七八九十]{1,3})[ \t　]*$/u;

/** A full-width bracket whose partner is in another sentence (or never came): the direction part of this line goes. */
function strayBrackets(line: string): string {
  const close = line.indexOf('）');
  if (close >= 0 && !LIST_NUMBER.test(line.slice(0, close))) line = ' ' + line.slice(close + 1);
  const open = line.indexOf('（');
  return open >= 0 ? line.slice(0, open) + ' ' : line;
}

/** The text to speak; '' when nothing but stage directions and punctuation is left. */
export function speakableText(text: string): string {
  let spoken = text;
  // Nested brackets go from the inside out ("（她笑了（小声））"); a few rounds are plenty for anything she writes.
  for (let round = 0; round < 4; round++) {
    const next = spoken.replace(FULL_WIDTH, ' ').replace(HALF_WIDTH, ' ');
    if (next === spoken) break;
    spoken = next;
  }
  spoken = spoken.split('\n').map(strayBrackets).join('\n').replace(STARS, ' ')
    .replace(/[ \t　]{2,}/gu, ' ').replace(/^[ \t　]+|[ \t　]+$/gmu, '').trim();
  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : '';
}
