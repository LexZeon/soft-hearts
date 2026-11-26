/**
 * I-117: the one closed field the reaction judge adds on the haiku call it already makes for each message (I-037,
 * shared/behaviors/reactions/choose.ts; no extra model call). Like I-040's senses: the rule is in the judge's fixed system prompt, the
 * per-message prompt carries a short 【安全】 block, and the answer's `danger` field is read on its own (a bad or missing one is null and
 * never costs the reaction). The other step on the same warm process (I-098's mood book) carries no block, so it never adds the field.
 */
import { isDangerLevel, type DangerLevel } from './detect';

export const SAFETY_JUDGE_RULE = '如果这条消息里有【安全】一段，JSON 里再加一个字段 danger，只看用户自己有没有伤害自己的危险：'
  + '用户明白地说想死、想自杀、想伤害自己，或觉得自己不在了大家会更好，写 "clear"；只是让人担心（说自己糟透了、没用、对不起所有人、问该不该删掉她、活着好累），写 "early"；'
  + '普通的夸张和玩笑（笑死、累死了、烦死了、对游戏说去死吧、想死你了、"I\'m dying lol"）、说别人或剧情里的事、别的话，都写 "none"。没有【安全】就不要加这个字段。';

export const SAFETY_JUDGE_BLOCK = '【安全】按说明给 danger：none / early / clear。';

/** The field itself: one of the three words, anything else null. */
export function parseDangerField(value: unknown): DangerLevel | null {
  return isDangerLevel(value) ? value : null;
}
