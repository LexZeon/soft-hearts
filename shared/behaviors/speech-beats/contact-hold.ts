/**
 * Her words after a kiss or a hug wait for its contact. In full-screen Unbound, when her reply has ⟦kiss⟧ or ⟦hug⟧, the sentence it is in goes on while
 * she walks (I-203; a marker written in front of a sentence belongs to that sentence, as all her
 * beats do), and the sentences after it wait until the act has landed: her lips on (a kiss; then they stay quiet until she pulls back,
 * "嘴贴上时话自己停") or her arms round (a hug; then she talks on while holding, "说到哪一句才松开").
 *
 * The wait itself (and its caps: a walk that fails never freezes her voice) is electron/unbound/close-sequence.ts ('contact'); the stream
 * that holds the words is electron/brain/speech-beats/turn.ts. This file only finds WHERE her words stop: the first spoken character after
 * the end of the beat's sentence. Pure; streaming-safe (the scan carries its stage from one chunk to the next).
 */
import { SPEECH_BEAT_CONTACT } from './knobs';

/** Where a sentence of hers ends (the turn's own list) — plus an English full stop followed by a space (`dot` waits for the next character). */
const END = /[。！？!?…~～\n]/u;
const SPOKEN = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
const SPACE = /\s/u;

/**
 * 2026-11-25 (K14, docs/claude/2026-11-25-k14-hug-regression.md): the reply protocol's private part starts with this (her state tail
 * `<sh-state-…>`, a memorial or setting field): what follows is never a sentence of hers, so it never waits for the contact. Held, it kept the
 * opening gate (a reply without its opening marker shows nothing until the tail begins) from ever showing the words the hug needs: a freeze.
 */
const PRIVATE = '<sh-';

/**
 * The scan's stage: still in the beat's own sentence ('end'), just after a '.' (is it an end?), past the end looking for the next spoken
 * character ('next'), or done without a stop ('off': the protocol's private part began; nothing after it is hers).
 */
export type ContactSeek = 'end' | 'dot' | 'next' | 'off';

/** Do her words wait for the contact at all (the knob; read once per turn). */
export const contactHoldOn = (): boolean => SPEECH_BEAT_CONTACT.wordsWaitForContact === true;

/**
 * Scan `text` from `from` in stage `seek` (a kiss / hug beat starts at 'end'): the index where her words stop (the first spoken character of the
 * next sentence), or the stage to carry into the next chunk. Code points are read whole (an emoji counts as spoken).
 */
export function contactCut(text: string, from: number, seek: ContactSeek = 'end'): { cut: number } | { seek: ContactSeek } {
  let stage = seek;
  if (stage === 'off') return { seek: 'off' };
  let i = Math.max(0, Math.min(text.length, Math.floor(from) || 0));
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    // K14: the private part (or what may still become it at this chunk's end) ends the scan in any stage; a lone '<' ("<3") is her words.
    if (ch === '<' && PRIVATE.startsWith(text.slice(i, i + PRIVATE.length))) return { seek: 'off' };
    if (stage === 'dot') stage = SPACE.test(ch) ? 'next' : 'end';
    if (stage === 'end') { if (END.test(ch)) stage = 'next'; else if (ch === '.') stage = 'dot'; }
    else if (stage === 'next' && SPOKEN.test(ch)) return { cut: i };
    i += ch.length;
  }
  return { seek: stage };
}
