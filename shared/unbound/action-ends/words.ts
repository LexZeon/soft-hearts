/**
 * The one information sentence her next chat turn gets when you ended something she was doing:
 * which action, by what, in closed words. Facts only: no instruction word (shared/unbound/life/history.ts INSTRUCTION_WORDS, checked by the
 * tests), no number. How she takes it is hers. It rides on the per-turn perception line beside her close moments (electron/unbound/history-host.ts).
 */
import type { ActionKind, UserEndCause } from './rules';

/** One you interrupted (at: ms). */
export interface ActionInterrupted { action: ActionKind; by: UserEndCause; at: number }

export const ACTION_WORDS: Readonly<Record<ActionKind, string>> = Object.freeze({
  kiss: '凑过去亲用户', hug: '凑过去抱用户', look: '凑到镜头前看用户', walk: '走到别处去', life: '做自己的小动作',
  beat: '边说边做动作', opening: '开口前的小动作', act: '做一个动作',
});
const BY_WORDS: Readonly<Record<UserEndCause, string>> = Object.freeze({ pull: '用户用力把你拉开了', click: '用户点了你一下' });

/** "你刚才正凑过去抱用户，用户用力把你拉开了，没做完。" ('' for none). The newest one only. */
export function interruptedLine(items: readonly ActionInterrupted[]): string {
  const last = items[items.length - 1];
  if (!last || !ACTION_WORDS[last.action] || !BY_WORDS[last.by]) return '';
  return `你刚才正${ACTION_WORDS[last.action]}，${BY_WORDS[last.by]}，没做完。`;
}
