/**
 * The experience journal's line for one voice or call segment that considered a look (morning: "8：10没按语义读取屏幕
 * （前面屏幕共享关了，开了后的第一句"你再看看没看到屏幕"）"). Before it, no line said whether a
 * look was considered for a segment, by which path, which senses were on, what the judgment answered, or why nothing was looked at, so a
 * missed look could not be told from a look that never happened.
 *
 * Closed words and booleans only: never the user's words, a frame, the facts she saw, or a score. Pure; the router's turn end
 * (electron/senses/sense-router/host.ts SenseTurnEnd) and the voice adapter (electron/senses/sense-router/voice.ts) feed it.
 * There is no cooldown or count limit on looks in a call, so no such result exists here.
 */

/** Which senses a rule or a judgment named. */
export const CALL_LOOK_SENSES = ['none', 'camera', 'screen', 'both'] as const;
export type CallLookSenses = (typeof CALL_LOOK_SENSES)[number];
/** The path of the semantic judgment: it rode on the reaction call, its own small call, or none was made. */
export const CALL_LOOK_JUDGES = ['reaction', 'own', 'none'] as const;
export type CallLookJudge = (typeof CALL_LOOK_JUDGES)[number];
/** What the judgment answered: senses named (`none` too), something else (the 一起听 words), no usable answer, or not asked. */
export const CALL_LOOK_ANSWERS = [...CALL_LOOK_SENSES, 'other', 'unsure', 'not-asked'] as const;
export type CallLookAnswer = (typeof CALL_LOOK_ANSWERS)[number];
/**
 * Why a look did or did not happen. looked: a clear frame was asked for by the phrase rules, or the judged sense gave facts;
 * not-asked: nothing was judged and the rules asked nothing (no sense on and no free ride, or her own call is not allowed);
 * judge-no: the judgment named nothing to look at; sense-off: it named a sense that is off (she only learns it is off); refused: "别看";
 * no-answer: the judgment timed out or was unreadable; failed: the capture or the facts failed; cut: a newer segment, hang-up, a change
 * of character or conversation ended it first.
 */
export const CALL_LOOK_RESULTS = ['looked', 'not-asked', 'judge-no', 'sense-off', 'refused', 'no-answer', 'failed', 'cut'] as const;
export type CallLookResult = (typeof CALL_LOOK_RESULTS)[number];

export interface CallLookFields {
  /** A call (a capture the call's rules cover), else plain voice input. */
  call: boolean;
  /** 2026-11-21: a chat message (typed, or voice input sent as a message), not a voice segment (electron/senses/sense-router/chat-look.ts). */
  chat?: boolean;
  /** What the phrase rules asked a clear frame of (the segment's own look). */
  rules: CallLookSenses;
  judge: CallLookJudge;
  answer: CallLookAnswer;
  /** The camera and the screen the user had on when the words came (a "别看" in them counts as off). */
  camera: boolean;
  screen: boolean;
  result: CallLookResult;
}

/** Plain words for the journal line (English in shared/foundation/ui-copy.call-look.en.ts). */
export const CALL_LOOK_SENSE_WORDS: Readonly<Record<CallLookSenses, string>> = Object.freeze({ none: '没有要看的', camera: '摄像头画面', screen: '屏幕画面', both: '摄像头和屏幕画面' });
export const CALL_LOOK_ON_WORDS: Readonly<Record<CallLookSenses, string>> = Object.freeze({ none: '都没开', camera: '只开了摄像头', screen: '只开了屏幕', both: '摄像头和屏幕都开着' });
export const CALL_LOOK_JUDGE_WORDS: Readonly<Record<CallLookJudge, string>> = Object.freeze({ reaction: '骑在反应判定上', own: '单独问了一次', none: '没问' });
export const CALL_LOOK_ANSWER_WORDS: Readonly<Record<CallLookAnswer, string>> = Object.freeze({ none: '不用看', camera: '摄像头画面', screen: '屏幕画面', both: '摄像头和屏幕画面',
  other: '别的（陪看的话）', unsure: '没答出来', 'not-asked': '没问' });
export const CALL_LOOK_RESULT_WORDS: Readonly<Record<CallLookResult, string>> = Object.freeze({ looked: '看了', 'not-asked': '没有判断', 'judge-no': '判断说不用看',
  'sense-off': '要看的那个没开', refused: '你说了别看', 'no-answer': '判断没有结果（超时或读不懂）', failed: '没看成（截图或读取失败）', cut: '被新的一句话或挂断打断' });
export function callLookLabels(entry: CallLookFields): { on: string; rules: string; judge: string; answer: string; result: string } {
  return { on: CALL_LOOK_ON_WORDS[senses(entry.camera, entry.screen)], rules: CALL_LOOK_SENSE_WORDS[entry.rules], judge: CALL_LOOK_JUDGE_WORDS[entry.judge],
    answer: CALL_LOOK_ANSWER_WORDS[entry.answer], result: CALL_LOOK_RESULT_WORDS[entry.result] };
}

const senses = (camera: boolean, screen: boolean): CallLookSenses => (camera && screen ? 'both' : camera ? 'camera' : screen ? 'screen' : 'none');

/** What the router's turn knew when it ended (a plain copy of SenseTurnEnd's closed fields). */
export interface CallLookTurnEnd {
  outcome: string;
  judge: 'merged' | 'own' | 'none';
  /** The question was put to haiku (on the reaction call or its own call). */
  asked: boolean;
  judged: boolean;
  answer: readonly string[] | null;
  on: { camera: boolean; screen: boolean };
  held: boolean;
  seen: number;
  off: number;
  camera: string;
}

/** One line from a finished router turn. `rules`: the senses the phrase rules asked a frame of. */
export function callLookFromTurn(input: { call: boolean; rules: readonly ('camera' | 'screen')[]; end: CallLookTurnEnd }): CallLookFields {
  const { end } = input;
  const ruleSenses = senses(input.rules.includes('camera'), input.rules.includes('screen'));
  const answered = end.judged && end.answer !== null;
  const named = answered ? senses(end.answer!.includes('camera'), end.answer!.includes('screen')) : 'none';
  const answer: CallLookAnswer = !end.asked ? 'not-asked' : !answered ? 'unsure' : named === 'none' && end.answer!.length > 0 ? 'other' : named;
  const judge: CallLookJudge = !end.asked ? 'none' : end.judge === 'merged' ? 'reaction' : 'own';
  const cut = end.outcome === 'superseded' || end.outcome === 'stale' || end.outcome === 'late' || end.outcome === 'reply-ended';
  let result: CallLookResult;
  if (end.held) result = 'refused';
  else if (ruleSenses !== 'none' || end.seen > 0 || end.camera === 'seen') result = 'looked';
  else if (end.camera === 'failed' || (answered && end.outcome === 'failed')) result = 'failed';
  else if (end.off > 0) result = 'sense-off';
  else if (answered && named !== 'none' && cut) result = 'cut';
  else if (answered) result = 'judge-no';
  else if (end.asked && !end.judged && cut) result = 'cut';
  else if (end.asked) result = 'no-answer';
  else result = cut ? 'cut' : 'not-asked';
  return { call: input.call, rules: ruleSenses, judge, answer, camera: end.on.camera, screen: end.on.screen, result };
}

/** The line for a segment the router did not take (nothing to judge: no sense on and no free ride, or the switch is off). */
export function callLookNotTaken(input: { call: boolean; rules: readonly ('camera' | 'screen')[]; camera: boolean; screen: boolean; held: boolean }): CallLookFields {
  const ruleSenses = senses(input.rules.includes('camera'), input.rules.includes('screen'));
  return { call: input.call, rules: ruleSenses, judge: 'none', answer: 'not-asked', camera: input.camera, screen: input.screen,
    result: input.held ? 'refused' : ruleSenses !== 'none' ? 'looked' : 'not-asked' };
}
