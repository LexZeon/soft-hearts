/**
 * 2026-11-24: for now the small window has no kiss and no hug. Full-screen
 * Unbound keeps them as they are. One knob brings them back (knobs.ts SPEECH_BEAT_WINDOW.windowCloseMoments). Pure rules shared by the three
 * places that must agree (docs/claude/2026-11-24-window-no-close.md):
 *  - what she is told (the turn's sentence and its availability line list only the words offered here),
 *  - what the reply keeps (a ⟦kiss⟧ / ⟦hug⟧ or a frame of one never becomes a beat in the window: no event, no grey line, no history marker),
 *  - what the window's engine plays (window-beats.ts refuses them, not even the lighter shy smile / lean-in).
 * "She is told only what her body can do" (handbook 提示不是锁): the three read this one knob, so none of them can go on offering what another refuses.
 */
import { isCloseBeatWord, isFrameBeatWord } from './choose';
import { SPEECH_BEAT_WORDS, type SpeechBeat, type SpeechBeatChunk, type SpeechBeatWord } from './interface';
import { SPEECH_BEAT_WINDOW, type SpeechBeatWindowKnobs } from './knobs';

/** Whether the small window has kiss and hug now (the knob; default off since 2026-11-24). */
export const windowCloseMomentsOn = (knobs: SpeechBeatWindowKnobs = SPEECH_BEAT_WINDOW): boolean => knobs.windowCloseMoments === true;

/** A kiss, a hug, or a frame of one (hug-held, pause, let-go): what the window leaves out while the knob is off. */
export const isCloseOrFrameWord = (word: unknown): boolean => isCloseBeatWord(word) || isFrameBeatWord(word);

/** The marker words this turn's sentence may name on a surface (the full-screen sentence adds its go and frame words itself). */
export function offeredBeatWords(surface: 'window' | 'full' | undefined, windowClose: boolean = windowCloseMomentsOn()): readonly SpeechBeatWord[] {
  return surface === 'window' && !windowClose ? SPEECH_BEAT_WORDS.filter(word => !isCloseBeatWord(word)) : SPEECH_BEAT_WORDS;
}

/** 2026-11-24 (user: 小窗先没有亲亲抱抱; he did not answer whether the 「抱抱」 gesture goes too, so the recommendation was taken): the body actions that are a hug. */
export const WINDOW_CLOSE_GESTURES: readonly string[] = ['air-hug'];

/**
 * Why the small window does not play this her-action now (a plain sentence for the channel / the test note), or null when it may.
 * Only the hug gesture is held back, and only while the knob is off; `fullScreen` (she is out in full-screen Unbound) plays everything.
 */
export function windowGestureRefusal(action: unknown, windowClose: boolean = windowCloseMomentsOn(), fullScreen = false): string | null {
  return !windowClose && !fullScreen && typeof action === 'string' && WINDOW_CLOSE_GESTURES.includes(action) ? '小窗里暂时没有「抱抱」（亲亲抱抱先关着，全屏的她照常有）' : null;
}

/** The chunk without the window's left-out beats, and how many were taken out (their markers were already out of the text). */
export function withoutCloseBeats(chunk: SpeechBeatChunk): { chunk: SpeechBeatChunk; dropped: number } {
  const beats: SpeechBeat[] = chunk.beats.filter(beat => !isCloseOrFrameWord(beat.word));
  return beats.length === chunk.beats.length ? { chunk, dropped: 0 } : { chunk: { ...chunk, beats }, dropped: chunk.beats.length - beats.length };
}
