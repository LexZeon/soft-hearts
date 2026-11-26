/**
 * I-158: a user message that reached her through speech recognition (voice input and calls) carries
 * one private line saying so, so she reads a homophone slip by its likely meaning instead of taking the odd word at face value.
 * It rides with that turn's own private context (like the call's spoken-style line), never her stable prompt, never the chat or the
 * archive, and nothing is added to typed turns. Pure; the text is fixed per card language (no numbers, no words of the user).
 */
import type { CardLanguage } from '../foundation/character-card';

/** The exact sentence the user approved (Chinese cards). Text for the model, not interface text. */
export const SPEECH_RECOGNITION_NOTE_ZH = '\n（这条是用户说的话，经语音识别转成文字，可能有同音错字、断句不对或漏字。按最可能的意思理解，不要纠正，也不要提"识别错了"；实在听不懂，就像打电话时那样自然地问一句。）'; // ui-zh-ok: 给模型的话

/** The same meaning for an English card, which only ever speaks English. */
export const SPEECH_RECOGNITION_NOTE_EN = '\n(This is what the user said, turned into text by speech recognition, so it may have homophone mistakes, wrong breaks or missing words. Read it by the most likely meaning; do not correct it or mention recognition errors. If you really cannot tell what was meant, ask naturally, the way you would on a phone call.)';

/** The line for one voice turn in the card's language. */
export function speechRecognitionNote(language: CardLanguage | null | undefined): string {
  return language === 'en' ? SPEECH_RECOGNITION_NOTE_EN : SPEECH_RECOGNITION_NOTE_ZH;
}
