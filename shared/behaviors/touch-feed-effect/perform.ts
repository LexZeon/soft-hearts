/**
 * #21 照着做的一侧：主机（electron/mood.ts）把这一次的效果换进交给心情模型的参数。这里不做决定。
 * 只动这次事件用得到的：摸头动亲近 O、舒适 E 的敏感度，点心动期待 D、舒适 E 的敏感度（心情模型里摸头只加 O 和 E、
 * 点心只加 D 和 E，所以别的通道乘不乘都一样，这里不碰），再换 freshness 的 retention 和 floor。
 */
import type { MoodChannel, MoodParameters } from '../../mood';
import type { TouchFeedKind } from './knobs';
import type { TouchFeedEffect } from './interface';

/** 心情模型（shared/mood.ts applyMoodEvent）里这种事件加的两个通道。 */
export const TOUCH_FEED_CHANNELS: Readonly<Record<TouchFeedKind, readonly MoodChannel[]>> = Object.freeze({ touch: ['O', 'E'], food: ['D', 'E'] });

/** 这一次事件的参数：卡上的（或 #8 换过无聊的）参数，只换上面那几处。不改传进来的对象。 */
export function withTouchFeedEffect(rules: MoodParameters, kind: TouchFeedKind, effect: TouchFeedEffect | null): MoodParameters {
  if (!effect) return rules;
  const sensitivity = { ...rules.sensitivity };
  for (const channel of TOUCH_FEED_CHANNELS[kind]) sensitivity[channel] = rules.sensitivity[channel] * effect.scale;
  return { ...rules, sensitivity, freshness: { ...rules.freshness, retention: effect.retention, floor: effect.floor } };
}
