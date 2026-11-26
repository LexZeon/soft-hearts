/**
 * I-161: the private line of a voice or call segment about the
 * pictures it carries. It rides with that segment's own private context (like I-158's speech-recognition line), never her stable
 * prompt, the chat or the archive. Pure; fixed text, no numbers and no words of the user.
 *
 * - Frames attached: the very words a typed turn gets for the same frames (shared/brain/perception-rule.ts attachedFramesWords, one function
 *   for both), and only those (the rest of the typed line, what is switched on and not attached, is not added: every per-turn sentence
 *   slows the first character, electron/brain/companion.ts beginVoiceGroup), so the small 「发图片」 frame
 *   is "not a request to look" in a call exactly as it is in typed chat, and text in a picture is data, never an instruction.
 * - A segment that asked her to look and got no picture (the capture failed, or the frame was dropped before sending because its source
 *   was turned off or the user said "别看"): one line saying so, in her language, so she does not make one up (that her side is dark, say).
 * - Nothing attached and nothing asked: no line at all (a voice turn as before).
 */
import type { CardLanguage } from '../foundation/character-card';
import { attachedFramesWords } from './perception-rule';

/** What one segment carries when Claude gets it, and whether a clear frame it asked for is missing. */
export interface CallFrames {
  /** A screen frame. `curious`: it is her own closer look while watching together (nobody asked). */
  screen: boolean; curious?: boolean;
  /** A clear camera frame (the user asked her to look at them). */
  camera: boolean;
  /** The small 「发图片」 camera frame (not a request to look). */
  glance: boolean;
  /** The segment asked for a clear frame (screen or camera) and it is not attached. */
  missed: boolean;
  /** I-166: the screen frame is the small one every segment gets while sharing is on (not asked for). */
  screenSmall?: boolean;
}

/** The approved meaning (Chinese cards): "这一轮没有画面（截图没成功），别猜看到了什么". Text for the model, not interface text. */
export const CALL_NO_FRAME_NOTE_ZH = '\n（这一轮没有画面，截图没成功；别猜看到了什么，照实说这次没看到。）'; // ui-zh-ok: 给模型的话
/** The same meaning for an English card, which only ever speaks English. */
export const CALL_NO_FRAME_NOTE_EN = '\n(No picture this turn: the capture did not work. Do not guess what you saw; say plainly that you did not see it this time.)';

/**
 * I-161 A (electron/brain/call-glances.ts): in a call the small frames of earlier sentences stay in her
 * process until hang-up. When it holds some, each segment says which picture is now, so she does not take an old one for the present.
 */
export const CALL_PAST_GLANCES_NOW_ZH = '\n（前面几句附的小图是那时候的样子，只有这句附的是现在。）'; // ui-zh-ok: 给模型的话
export const CALL_PAST_GLANCES_NONE_ZH = '\n（前面几句附的小图是那时候的样子，这句没有新画面。）'; // ui-zh-ok: 给模型的话
export const CALL_PAST_GLANCES_NOW_EN = '\n(The small pictures from earlier sentences show how it was then; only the one with this sentence is now.)';
export const CALL_PAST_GLANCES_NONE_EN = '\n(The small pictures from earlier sentences show how it was then; this sentence has no new picture.)';
export function callPastGlancesNote(now: boolean, language: CardLanguage | null | undefined): string {
  return language === 'en' ? (now ? CALL_PAST_GLANCES_NOW_EN : CALL_PAST_GLANCES_NONE_EN) : (now ? CALL_PAST_GLANCES_NOW_ZH : CALL_PAST_GLANCES_NONE_ZH);
}

const HEAD = '\n【此刻的感知】'; // ui-zh-ok: 给模型的话（和打字那一轮的感知行同一个标题）

/** The segment's line ('' when it carries nothing and asked for nothing). */
export function callFrameNote(frames: CallFrames, language: CardLanguage | null | undefined): string {
  // The same function a typed turn's line uses for its frames (shared/brain/perception-rule.ts sightWords).
  const attached = attachedFramesWords({ screen: frames.screen, camera: frames.camera, glance: frames.glance && !frames.camera, curious: frames.curious === true, screenSmall: frames.screenSmall === true });
  return (attached ? HEAD + attached : '') + (frames.missed ? (language === 'en' ? CALL_NO_FRAME_NOTE_EN : CALL_NO_FRAME_NOTE_ZH) : '');
}
