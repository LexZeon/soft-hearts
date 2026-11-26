/**
 * I-166: the words of "what she sees steers what she says". Text for the
 * model (not interface text) in her card's language, the rule that takes the senses off the haiku look judgment, and the journal's closed
 * words. Pure: no clock, no model, no user data.
 */
import type { CardLanguage } from '../../foundation/character-card';
import { LOOK_MARKER, type LookSense } from './marker';
import { SEE_AND_SAY } from './knobs';

/** Which senses give pictures this turn: on, and no "别看" holding them. */
export interface SeeingSenses { camera: boolean; screen: boolean }

/**
 * Her one short paragraph (only while a sense gives pictures; '' otherwise). Kept short: every sentence added to a turn slows her first
 * character (R28). It names only the markers of the senses that are on. I-168: one clause on "别看" — the
 * app holds nothing on a no, so whether she looks is hers to decide, in character, and she does not hide it.
 */
export function seeAndSayLine(senses: SeeingSenses, language: CardLanguage | null | undefined, knobs: { closerLook: boolean } = SEE_AND_SAY): string {
  const on: LookSense[] = (['camera', 'screen'] as const).filter(sense => senses[sense] === true);
  if (!on.length) return '';
  const en = language === 'en';
  const what = en ? on.map(sense => sense === 'camera' ? 'the camera' : 'the screen').join(' and ') : on.map(sense => sense === 'camera' ? '摄像头' : '屏幕').join('和');
  const marks = on.map(sense => LOOK_MARKER[sense]).join(en ? ' or ' : '或');
  if (en) return `\n(You see small views of ${what} with each turn.${knobs.closerLook ? ` To look closer, write ${marks} once and stop; a clear picture comes and you go on.` : ''} Say only what is worth saying, as much as you like. If the user asks you not to look, whether you look or say so is yours to decide; if you do look, do not hide it.)`;
  return `\n（你每轮能看到${what}的小图。${knobs.closerLook ? `想看清楚就在回复里写一次${marks}，然后停下，会给你清楚的画面再接着说。` : ''}值得说的才说，说多少由你。用户叫你别看时，看不看、提不提由你决定，看了也不用瞒着。）`; // ui-zh-ok: 给模型的话
}

/**
 * The continuation's message to her warm process: the clear picture she asked for is attached (or did not come). Never user words.
 * `opening` (2026-11-21, the reply's fixed opening marker): named like the turn's own sentence names it, so what she writes next is behind
 * it (a reply that began with the look marker had none yet, and the opening gate held everything until the reply was complete).
 */
export function closerLookNote(sense: LookSense, seen: boolean, language: CardLanguage | null | undefined, opening = '', off = false): string {
  if (language === 'en') {
    const what = sense === 'camera' ? 'the camera' : 'the screen', mark = opening ? `, after the opening marker ${opening}` : '';
    if (off) return `(Not the user speaking: ${what} is off right now, so no picture comes. Say that in your own words, do not guess what is there, and answer what you can without it${mark}; same reply format and tail as before.)`;
    return seen
      ? `(Not the user speaking: here is the clear picture of ${what} you wanted. Go on from where you stopped${mark}, without repeating yourself; same reply format and tail as before.)`
      : `(Not the user speaking: the clear picture of ${what} did not come this time. Go on from where you stopped${mark}, say plainly you could not see it, do not guess; same reply format and tail as before.)`;
  }
  const what = sense === 'camera' ? '摄像头' : '屏幕', mark = opening ? `，写在开头标记${opening}之后` : '';
  if (off) return `（不是用户在说话：${what}现在是关着的，没有画面。用你自己的话说一下，别猜上面有什么，没有画面也能答的就答${mark}；回复格式和尾注照旧。）`; // ui-zh-ok: 给模型的话
  return seen
    ? `（不是用户在说话：这是你刚才想看清的${what}画面。从你停下的地方接着说${mark}，别重复说过的；回复格式和尾注照旧。）` // ui-zh-ok: 给模型的话
    : `（不是用户在说话：${what}的清楚画面这次没拿到。从你停下的地方接着说${mark}，照实说没看清，别猜；回复格式和尾注照旧。）`; // ui-zh-ok: 给模型的话
}

/**
 * I-166 "不需要haiku": the senses the haiku look judgment may ask about. With `haikuLook` off, camera and screen are taken out (the
 * judgment no longer decides whether she looks; what she hears stays); on, unchanged.
 */
export function judgedSenses<T extends { camera: boolean; screen: boolean }>(on: T, knobs: { haikuLook: boolean } = SEE_AND_SAY): T {
  return knobs.haikuLook ? on : { ...on, camera: false, screen: false };
}

/**
 * I-085 第 5 节's self-look after a chat message is redundant while this turn already carried a small camera frame (no double looks):
 * it runs only when text first is on and no small camera frame went.
 */
export function chatSelfLookWanted(textFirst: boolean, smallCamera: boolean, knobs: { smallFramesEveryTurn: boolean } = SEE_AND_SAY): boolean {
  return textFirst && !(knobs.smallFramesEveryTurn && smallCamera);
}

// ---------------------------------------------------------------- the experience journal's closed words

/** One line per turn that carried small frames ('frames'), and one per closer look she asked for ('closer'). */
export const SEE_AND_SAY_EVENTS = ['frames', 'closer'] as const;
export type SeeAndSayEvent = (typeof SEE_AND_SAY_EVENTS)[number];
/** What became of a closer look: taken (a clear picture went), failed (she went on without it), cancelled (no continuation), off (the sense was not on). */
export const CLOSER_OUTCOMES = ['taken', 'failed', 'cancelled', 'off'] as const;
export type CloserOutcome = (typeof CLOSER_OUTCOMES)[number];
/** Why: timeout, no-frame, no-process (her warm process could not continue), error, held ("别看" or the switch went off), superseded (a newer message), stopped. */
export const CLOSER_WHYS = ['timeout', 'no-frame', 'no-process', 'error', 'held', 'superseded', 'stopped'] as const;
export type CloserWhy = (typeof CLOSER_WHYS)[number];
/**
 * 2026-11-22: why no clear picture came, like camera-look's `miss`.
 * off: the sense was not on (or "别看" held it) when she asked; held: it went off (or was held) while the picture was taken; unready: the source
 * was not ready (the companion off the screen, no screen chosen yet, no camera window); interrupted: the capture was stopped part way (the
 * context was refreshed, another reader stopped it); capture-failed: the screen or the camera gave no picture; changed: the vision context
 * or the switch's opening changed while it was taken; timeout: none within closerTimeoutMs; dropped: taken, but gone when it was to be sent.
 */
export const CLOSER_MISSES = ['off', 'held', 'unready', 'interrupted', 'capture-failed', 'changed', 'timeout', 'dropped'] as const;
export type CloserMiss = (typeof CLOSER_MISSES)[number];
/** The capture misses worth one more try within the closer's wait: nothing about the switches or the context changed. */
export const CLOSER_RETRY_MISSES: ReadonlySet<CloserMiss> = new Set(['unready', 'interrupted', 'capture-failed']);

export const SEE_AND_SAY_REASON: Readonly<Record<SeeAndSayEvent, string>> = { frames: '这一轮她看到了开着的小图', closer: '她自己想凑近看' };
export const CLOSER_OUTCOME_WORDS: Readonly<Record<CloserOutcome, string>> = {
  taken: '看清了', failed: '没看清，接着说了', cancelled: '没看（取消了）', off: '那个没开，没看',
};
export const CLOSER_WHY_WORDS: Readonly<Record<CloserWhy, string>> = {
  timeout: '等太久了', 'no-frame': '没拿到画面', 'no-process': '聊天进程接不上', error: '出错了', held: '你说了别看或关掉了', superseded: '你又说了一句', stopped: '回复停了',
};
export const CLOSER_MISS_WORDS: Readonly<Record<CloserMiss, string>> = {
  off: '那个没开', held: '拍的时候关掉了或说了别看', unready: '画面来源还没准备好', interrupted: '拍到一半被打断了', 'capture-failed': '屏幕或摄像头没给画面',
  changed: '拍的时候开关或视觉上下文变了', timeout: '等太久了', dropped: '拍到了，送出前已经不能用',
};
export const LOOK_SENSE_WORDS:Readonly<Record<LookSense, string>> = { camera: '摄像头', screen: '屏幕' };
