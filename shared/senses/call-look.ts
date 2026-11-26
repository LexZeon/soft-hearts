/**
 * I-161 (chose "A 像视频通话"): voice input and calls follow
 * the typed chat's look rules. Each voice segment's recognized words go through the same decision (shared/senses/look-request.ts via
 * electron/senses/look-turns.ts), and a frame is taken only after it said yes (electron/senses/look-attachments.ts). Pure; no user data kept.
 */

/**
 * The knobs of a call's frames (code only; no switch in the app).
 */
export const CALL_LOOK = Object.freeze({
  // 用户可能怎么说：通话的时候她每句都慢半拍／通话不用每句都带我的小画面
  // 怎么调：false 就和打字一样（文字为主时普通的一句不带小画面，只有叫她看的那句带图）。true（方案里的 A）：开着「发图片」时
  // 每段都带那张已存着的小摄像头画面，像视频通话；代价是带图的一轮会让热着的 Claude 进程换新（electron/brain/claude-session.ts retire 'image'），
  // 下一句的第一个字会晚一些（I-085 第 3 步实测约 0.9 秒）。
  // 2026-11-19 晚知道这个代价后定为先只在请她看时。之后做了 I-161 A（下面的 glanceStaysInCall）：小画面不再让进程换新，
  // 真 Claude 实测每句首字中位 906 毫秒（不带画面 793，以前 2036；docs/claude/2026-11-19-call-glance-a.md）。用户看了数字后说"打开"（11-19 晚）：true。
  glanceEveryTurn: true,
  // 用户可能怎么说：通话里说过"别看"之后她还记得我刚才的样子／挂了电话她还提我刚才的表情
  // 怎么调：I-161 A。true：通话里只带「发图片」小画面的一句不让热着的
  // Claude 进程换新，这些小画面留在进程里直到挂电话；说"别看"、关摄像头/「发图片」/屏幕、清视觉上下文就立刻换进程全扔掉
  // （electron/brain/call-glances.ts）。请她看时拍的清楚画面照旧用完就换。false：回到"每张图只给她看一句"（带图的一轮之后就换进程）。
  // 只在 glanceEveryTurn 为 true 时才有小画面可留。
  glanceStaysInCall: true,
  // 一个进程里最多留几张小画面（通话本来 40 句就换进程，shared/behaviors/voice-call/knobs.ts session.maxTurns）。到了就像以前一样换。
  glancesPerProcess: 40,
  // 用户可能怎么说：语音／通话里我换个说法问她看不看得见，她没去看（"你现在能看见我吗""看看这个"）
  // 怎么调： 语音和通话的每段也走打字的 I-040 语义判断（haiku 判断要不要看，
  // 骑在每段本来就有的反应判定那一次 haiku 调用上，不多一次判断调用）；要看且开着就看一眼、写成事实：语音输入照打字那样她再补一句，
  // 通话里放进她下一段话（这段还没写出去就放进这段），通话里绝不另起一条回复（electron/senses/sense-router/voice.ts）。
  // false：回到只靠句式规则（shared/senses/look-request.ts、look-can-see.ts）。
  semanticLook: true,
  // 用户可能怎么说：通话里反应判定没问（自动表现关了、她睡着、今天的额度用完）时也按语义判断看不看
  // 怎么调：true：那几段另外各问一次 haiku（只在开着某个感知时；10 分钟通话约 30～40 次，docs/claude/2026-11-20-call-semantic-look.md）。
  // 同意了这份用量（"打电话也需要根据语义看"，问的是 Unbound 里打电话、语音也按语义判断，每段另问一次 haiku）：true。
  // false 时这些段只走句式规则。
  semanticOwnJudge: true,
});

/**
 * I-161 A (electron/brain/call-glances.ts): what a call segment says about its pictures, so the call's Claude process may keep its small
 * 「发图片」 frames until hang-up. Set only by the voice host for a call segment (electron/senses/voice-look.ts callGlanceOf); typed chat
 * never sets it. Holds no picture.
 */
export interface CallGlanceMark {
  /** Read where the message is written, right after its frames: every frame this turn sends now is a small 「发图片」 frame. */
  glanceOnly(): boolean;
  /** Whether those frames may still be seen (their source on, same opening, same vision context, no "别看"). Holds no picture. */
  still(): () => boolean;
  /** The private line for a process that already holds earlier small frames; `now`: this turn carries a new one ('' for none). */
  past(now: boolean): string;
}

/**
 * Words a recognizer writes for 别 ("bié") when it mishears it: "憋看我屏幕" is "别看我屏幕". Only in front of a look verb, and only
 * ever turned into a no (a frame less, never one more): when unsure, she does not look.
 */
const MISHEARD_NO = /[憋鳖瘪蹩](?=(?:再|先|老|总|偷偷?|乱|一直)?(?:看|瞧|瞅|瞄|盯|偷看|查看))/gu;

/**
 * A voice segment's recognized words, ready for the typed chat's look rules. Recognized text often has no punctuation and homophone
 * slips; the rules already read unpunctuated text (tests/i161-spoken-look.test.ts), so the only change is the one that can only take a
 * frame away: a misheard 别 before a look verb. Typed text never passes through here.
 */
export function spokenLookText(text: string): string {
  return typeof text === 'string' ? text.replace(MISHEARD_NO, '别') : '';
}
