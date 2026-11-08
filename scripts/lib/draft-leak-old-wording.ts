// Wordings for the first-token A/B runs of scripts/lib/draft-leak-probe.ts.
//
// RPS (docs/claude/2026-11-03-rps-five-fixes.md): the game's accept line as shipped until 2026-11-03 was a list of dos and
// don'ts ("简短地答应 / 不用讲规则 / 不要替你们出拳 / 不要宣布结果") that came back as her visible notes when she answered
// without thinking first, and "由你来喊" made her call the count herself mid-session (draft-leak record). The app now
// says what is going on instead (shared/rps-personality.ts rpsChatContext). Arm A of the A/B puts the old line back into
// the stdin prompt; arm B is the app as it is; nothing else in the prompt changes.
//
// F2 (docs/claude/2026-11-03-draft-leak-fix.md): a candidate for F2's chat line, not shipped (its first A/B with the
// earlier RPS candidate was +117.5 ms). Kept so it can be measured on its own.
import { rpsChatContext } from '../../shared/rps-personality';

/** The RPS accept line as the app sent it until 2026-11-03 (b61091e). */
export const RPS_ACCEPT_OLD = '【猜拳】用户想和你玩猜拳（三局两胜）。你答应了：这一轮用你的口吻简短地答应，一两句就好，不用讲规则；你说完后应用会在你身边浮出"石头、剪刀、布"三个按钮，由你来喊"石头剪刀布"。这一轮不要替你们出拳，也不要宣布结果。';

/**
 * A second rewrite tried the same evening and not shipped: 12 interleaved pairs against RPS_ACCEPT_OLD gave first token
 * +311 ms (paired median +381.5 ms), replies no shorter and 2/12 still calling the count (rps-five-fixes record).
 */
export const RPS_ACCEPT_TRIED = '【猜拳】用户想和你玩猜拳，你正好也想玩。你答应一声，身边就会出现三个出拳按钮，比赛在那之后才开始，三局两胜。';

/** Arm A: the stdin prompt with the app's RPS accept line put back to the old one. Throws when the app's line is missing (the A/B would be void). */
export function toOldRpsWording(prompt: string): string {
  const accept = rpsChatContext('accept');
  if (!prompt.includes(accept)) throw new Error('A/B 无效：本轮提示词里没有应用的猜拳私有上下文。');
  return prompt.split(accept).join(RPS_ACCEPT_OLD);
}

export const DRAFT_LEAK_CANDIDATE_WORDING = {
  /** F2's chat line as her own impression, without the confidence number: `{label}`, `{detail}` (how long ago, the reason). */
  userStateLine: '你先前觉得用户{label}（{detail}）。这份感觉只让你说话更体贴，不用提起，不说教，也不劝用户去找别人；用户现在怎样，以这轮的话为准。',
} as const;

/** The app's F2 chat line (shared/user-state.ts userStateChatLine), capturing the label, how long ago and the reason. */
const APP_USER_STATE = /你对用户此刻状态的判断：(累|烦|低落|开心|兴奋)（(刚刚|约\d+(?:分钟|小时)前)，把握[\d.]+(?:，([^）]*))?）。[^\n]*/u;

/** F2 candidate: the stdin prompt with the app's F2 line swapped for the candidate. Throws when the app's line is missing. */
export function toCandidateUserStateLine(prompt: string): string {
  const line = APP_USER_STATE.exec(prompt);
  if (!line) throw new Error('A/B 无效：本轮提示词里没有应用的 F2 判断行。');
  const detail = [line[2], ...(line[3] ? [line[3]] : [])].join('，');
  return prompt.replace(line[0], DRAFT_LEAK_CANDIDATE_WORDING.userStateLine.replace('{label}', line[1]).replace('{detail}', detail));
}
