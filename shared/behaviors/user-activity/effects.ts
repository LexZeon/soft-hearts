/**
 * I-006 第 1 步：状态怎么变成她的表现。每一条只调整"可能性"和"快慢"，没有新的定时器、次数上限或固定顺序（I-013）；
 * 数字都在 knobs.ts。纯函数：读 UserActivityView，不碰别的。
 *
 * 绝不做（用测试守住，tests/user-activity.test.ts）：她的话里不出现"你工作了两小时""休息一下""你还在吗"这类词，
 * 也不写屏幕上的内容；这里的句子只有状态和分钟数。
 */
import type { MoodTendency } from '../../mood';
import { USER_ACTIVITY_KNOBS, type UserActivityKnobs } from './knobs';
import type { UserActivityView } from './interface';

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const TENDENCIES: readonly MoodTendency[] = ['playful', 'close', 'comfortable', 'cautious'];

/**
 * 无聊涨速要乘多少（0～1，1 = 照常）。专注度越高、性格越慢热越随和，越小。永远不大于 1：只许放慢、不许加快，
 * 所以她开口、动一下、看你的时刻只会推后（shared/behaviors/boredom-timing 的安全线在它之后仍然成立）。
 */
export function quietPace(view: Pick<UserActivityView, 'focus'> | null | undefined, personality: Partial<Record<MoodTendency, number>> | null | undefined,
  knobs: UserActivityKnobs = USER_ACTIVITY_KNOBS): number {
  const focus = clamp(finite(view?.focus, 0), 0, 1);
  if (focus <= 0) return 1;
  let full = knobs.quiet.base;
  for (const tendency of TENDENCIES) full += (knobs.quiet.personality[tendency] ?? 0) * (clamp(finite(personality?.[tendency], 1), 0, 4) - 1);
  full = clamp(full, knobs.quiet.min, Math.min(1, knobs.quiet.max));
  return 1 - focus * (1 - full);
}

/** 你正在专心做事（开口选择更偏向"这次不说"）。 */
export const userIsBusy = (view: Pick<UserActivityView, 'state'> | null | undefined): boolean => view?.state === 'busy';

/** 她自己的生活：你在忙的程度（0～1），和每件事要多做多久；不在忙时是 0。 */
export function herLifeBusy(view: Pick<UserActivityView, 'state' | 'focus'> | null | undefined,
  knobs: UserActivityKnobs = USER_ACTIVITY_KNOBS): { focus: number; longer: number } | undefined {
  if (view?.state !== 'busy') return undefined;
  const focus = clamp(finite(view.focus, 0), 0, 1);
  return focus > 0 ? { focus, longer: knobs.herLife.longer } : undefined;
}

const minutesWord = (view: Pick<UserActivityView, 'busyMinutes'>): number => clamp(Math.round(finite(view.busyMinutes, 0)), 1, 999);

/**
 * 那一句【此刻】：只写状态和分钟数，不写别的。说不准、不在时是空（她按没这回事来）。
 *  - 在忙：`用户这会儿在专心做事，约 40 分钟了。`
 *  - 歇一下：`用户刚停下来歇口气，之前专心做了约 40 分钟。` / `用户刚忙完一阵（约 40 分钟），转过来找你。`
 */
export function userActivitySentence(view: UserActivityView | null | undefined): string {
  if (!view) return '';
  if (view.state === 'busy') return `用户这会儿在专心做事，约 ${minutesWord(view)} 分钟了。`;
  if (view.state === 'pause') return view.cause === 'came' ? `用户刚忙完一阵（约 ${minutesWord(view)} 分钟），转过来找你。`
    : `用户刚停下来歇口气，之前专心做了约 ${minutesWord(view)} 分钟。`;
  return '';
}

/** 聊天里"状态变了才带一句"用的键：同一种状态（和歇一下的来由）不重复带。空 = 没有可说的。 */
export function userActivityKey(view: UserActivityView | null | undefined): string {
  if (!view || (view.state !== 'busy' && view.state !== 'pause')) return '';
  return view.state === 'pause' ? `pause:${view.cause ?? 'idle'}:${Math.floor(finite(view.since, 0))}` : `busy:${Math.floor(finite(view.since, 0))}`;
}
