/**
 * I-161 bug (2026-11-19, a voice call): asking whether she can see the user's screen, with screen sharing on, IS asking her to look; she answered that
 * her side was dark, because speech did not go through the same meaning check typing had. Before, the look rules
 * (look-request.ts) read only "你看看…" shapes and pinned "你能看到我屏幕吗" as no request (2026-11-03: "whether she can see" was not a look),
 * so no frame was taken and she reported an empty view. The text rules are the same ones typing uses; a call hands over the recognized words.
 *
 * Narrow on purpose (a false hit sends a frame nobody asked for): the clause must start with her ("你", "现在", a filler) or the can-marker,
 * must be a can-question (能 / 可以 / 看得到 / 看得见 + 看到 / 看见), must name the screen itself (屏幕 / 桌面 / 电脑 / 显示器), and must end as a question.
 * "你看到我屏幕了吗" (did she already see it), "我能看到屏幕" (the user), "希望你能看到我的屏幕" (a wish) and the user's own camera
 * ("你能看见我吗", which asks nothing about the screen) are not matched here.
 */
const LEAD = '(?:呃|嗯|额|啊|欸|诶|喂|那|那么|所以|好|你|现在|这会儿|这下|这时候|终于|再)*';
const SEEN = '(?:看到|看见|看得到|看得见|看清|看清楚)';
const CAN = `(?:(?:能|可以|能否)(?:够)?${SEEN}|看得到|看得见|看得清)`;
/** An A-not-A question is a question without a closing 吗. */
const CAN_ASKED = `(?:(?:能不能|可不可以|会不会)(?:够)?${SEEN}|看不看得到|看不看得见|看不看得清)`;
const OBJECT = '(?:我的?|我这边的?|我这个?|我电脑的?|这个?|整个)?(?:电脑)?(?:屏幕|桌面|显示器)';
const TAIL = '(?:吗|么|嘛|不|没|没有|呢|吧)';
const CAN_SEE_SCREEN = new RegExp(`^${LEAD}(?:${CAN}了?${OBJECT}.{0,10}?${TAIL}|${CAN_ASKED}${OBJECT}.{0,10}?${TAIL}?)$`, 'u');

/** Whether this clause (no spaces, no punctuation) asks whether she can see the user's screen. */
export function asksCanSeeScreen(clause: string): boolean {
  return clause.length <= 40 && CAN_SEE_SCREEN.test(clause);
}

/*
 * 2026-11-21 (a report that the camera was not read in Unbound; docs/claude/2026-11-21-unbound-camera-look.md): asking whether she can see the user with 「发图片」 on
 * took no picture. It is the same can-question about the user themself (the camera), which the rule above leaves out on purpose. Same shape:
 * her or the can-marker first, a can-question, 我 as the whole object (at most "我这边", "我的样子", "我的脸" after it), a question end.
 * "我能看到你吗" (the user looking), "你看到我了吗" (did she already) and "希望你能看到我" (a wish) are not matched.
 */
const YOU = '我(?:这边|这里|现在|的样子|的脸|本人)?';
const CAN_SEE_YOU = new RegExp(`^${LEAD}(?:${CAN}了?${YOU}${TAIL}|${CAN_ASKED}${YOU}${TAIL}?)$`, 'u');

/** Whether this clause (no spaces, no punctuation) asks whether she can see the user (the camera). */
export function asksCanSeeYou(clause: string): boolean {
  return clause.length <= 20 && CAN_SEE_YOU.test(clause);
}
