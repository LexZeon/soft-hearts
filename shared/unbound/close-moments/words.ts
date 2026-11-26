/**
 * I-184: the one sentence her next chat turn gets about a kiss or a hug that happened (facts only, as data: "你刚才亲了用户一下"). How
 * she brings it up, or whether, is hers: no instruction word (shared/unbound/life/history.ts INSTRUCTION_WORDS is checked by the
 * tests), no number. It rides on the per-turn perception line beside what she noticed of you while out (electron/unbound/history-host.ts).
 */
import { AFTER_BEAT_WORDS, type AfterBeat } from './after-beat';
import type { CloseVia } from './chooser';
import type { ChatCloseBlock } from './chat';

/**
 * One that happened. `arms: 'still'` (I-192 follow-up, Codex T-261): a hug on a model whose arms the engine cannot move: her face came close
 * (the hug the user asked for in full-screen), her arms did not; the line below never says her arms moved anyway.
 */
export interface CloseHappened { kind: 'kiss' | 'hug'; via: CloseVia; after: AfterBeat | null; at: number; arms?: 'still' }

const ACT_WORDS: Readonly<Record<'kiss' | 'hug', string>> = Object.freeze({ kiss: '亲了用户一下', hug: '隔着屏幕抱了抱用户' });

/** 2026-11-23: a kiss or a hug her reply wrote that did not walk up (at: ms), for her next turn (she then said nothing moved). */
export interface CloseMissed { kind: 'kiss' | 'hug'; block: ChatCloseBlock; at: number }
const MISSED_WHY: Readonly<Record<ChatCloseBlock, string>> = Object.freeze({
  'not-shown': '你那时不在全屏里', asleep: '你那时睡着了', call: '那时在通话', typing: '用户那时正在打字', pulled: '用户那时正拉着你',
  busy: '上一个动作还没做完', arms: '你的手那时被游戏占着', cooldown: '那时刚做过', unready: '那时还没准备好', unreached: '', waited: '话等了很久才放出来',
});
/** What played instead where she stood (the page's lighter one), when she was on screen and awake. */
const MISSED_INSTEAD: Readonly<Record<'kiss' | 'hug', string>> = Object.freeze({ kiss: '只害羞地笑了一下', hug: '只在原地凑近了一点' });
/** "你上一条回复里写的抱抱没有走过来做（用户那时正拉着你），只在原地凑近了一点。" ('' for none). Information only; the newest one. */
export function closeMissedLine(items: readonly CloseMissed[]): string {
  const last = items[items.length - 1];
  if (!last || MISSED_WHY[last.block] === undefined) return '';
  const name = last.kind === 'kiss' ? '亲亲' : '抱抱';
  // T-264: she did walk up, but her face never got into the picture: it did not happen (information only: nothing was recorded as done).
  if (last.block === 'unreached') return `你刚才凑过去${last.kind === 'kiss' ? '亲' : '抱'}用户，脸没能到镜头跟前，没做成，退回来了。`;
  const quiet = last.block === 'not-shown' || last.block === 'asleep';
  return `你上一条回复里写的${name}没有走过来做（${MISSED_WHY[last.block]}）${quiet ? '' : `，${MISSED_INSTEAD[last.kind]}`}。`;
}

/** "你刚才自己凑过去亲了用户一下，然后红着脸别开了眼睛。" ('' for nothing). The newest one only: two in a few minutes never happen (cooldowns). */
export function closeMomentLine(items: readonly CloseHappened[]): string {
  const last = items[items.length - 1];
  if (!last) return '';
  const lead = last.via === 'own' ? '你刚才自己凑过去' : last.via === 'chat' ? '你刚才边说边走到用户跟前' : '用户刚才把你拉到跟前，你'; // I-185: from her reply's marker
  const after = last.after ? `，然后${AFTER_BEAT_WORDS[last.after]}` : '';
  return `${lead}${ACT_WORDS[last.kind]}${after}。`;
}
