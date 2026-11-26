/**
 * I-066：一次"她想主动开口"的时机最后怎样了，体验记录里的一行（只有封闭的类别，从不记她想说什么）。
 * 内心循环自己那一行（'inner-loop'）照旧记它接手以后的结果；这里记的是没走到内心循环的那些，以及留着的话后来怎样了。
 *
 *  - held：这次不说，话留着（为什么：你不在、在开会、拿不准、读不到你在不在）；
 *  - unspoken：这次不说（为什么：你在忙她收着了、深夜或困了、她选了这次不说、互动余额不够、哪件都做不成）；
 *  - delivered：留着的话在你回来（或又方便了）时拿出来说（交给内心循环；说没说出口看内心循环那一行）；
 *  - expired：留着的话过了时间，作废；dropped：被一件更重要或更新的换掉了，或换了角色；
 *  - greet：你离开很久回来、她没有留着的话，照性格要了一次开口的机会。
 * 屏幕"看了一眼"另记一行（'presence-look'），只有类别。
 */
export const SPEECH_CUE_OUTCOMES = ['held', 'unspoken', 'delivered', 'expired', 'dropped', 'greet'] as const;
export type SpeechCueOutcome = typeof SPEECH_CUE_OUTCOMES[number];

export const SPEECH_CUE_REASONS = [
  // held
  'away', 'meeting', 'unsure', 'not-present',
  // unspoken
  'busy-declined', 'night', 'chose-not', 'budget', 'unable',
  // delivered / greet
  'back', 'present',
  // expired / dropped
  'too-long', 'replaced', 'character',
] as const;
export type SpeechCueReason = typeof SPEECH_CUE_REASONS[number];

/** Which outcome each reason belongs to (a line with any other pair is refused when read back). */
export const SPEECH_CUE_PAIRS: Readonly<Record<SpeechCueOutcome, readonly SpeechCueReason[]>> = {
  held: ['away', 'meeting', 'unsure', 'not-present'],
  unspoken: ['busy-declined', 'night', 'chose-not', 'budget', 'unable', 'meeting'],
  delivered: ['back', 'present'],
  expired: ['too-long'],
  dropped: ['replaced', 'character'],
  greet: ['back'],
};

export const SPEECH_CUE_REASON_WORDS: Readonly<Record<SpeechCueReason, string>> = {
  away: '你不在', meeting: '你在开会', unsure: '拿不准你在不在', 'not-present': '不知道你在不在',
  'busy-declined': '你在忙，她收着了', night: '深夜或她困了', 'chose-not': '她选了这次不说', budget: '互动余额不够', unable: '哪件都做不成',
  back: '你回来了', present: '你又方便了', 'too-long': '留得太久', replaced: '换成了更想说的', character: '换了角色',
};

export const SPEECH_CUE_OUTCOME_WORDS: Readonly<Record<SpeechCueOutcome, string>> = {
  held: '她想开口，先留着没说', unspoken: '她想开口，这次没说', delivered: '她把留着的话拿出来说',
  expired: '留着的话作废了', dropped: '留着的话换掉了', greet: '你回来了，她想招呼你',
};

export interface SpeechCueEntry { readonly characterId: string; readonly outcome: SpeechCueOutcome; readonly why: SpeechCueReason }
