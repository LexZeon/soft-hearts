// 心情参数的常规范围（软上限）。docs/mood/character-card-guide.md「实际字段、单位与技术范围」「范围与用户确认」:
// the typical range is a suggested experience range; a value outside it needs the user's yes, item by item, and a value
// already on the card is not asked again. The technical range is what validateMoodParameters accepts (shared/mood.ts).
// One table for the mood panel's confirmation and sliders (src/ui/MoodPanel.ts) and I-018's discussion
// (shared/character-understanding.ts). Pure: no DOM, no translation (the panel translates the labels it shows).
import { MOOD_CHANNELS, type MoodParameters } from './mood';

export interface MoodTypicalRange {
  /** "baseline.D", "freshness.ruaMs", "fastThreshold". */
  path: string;
  /** '' for a top-level field. */
  group: string;
  key: string;
  /** Fixed Chinese copy; `{0}` is `labelValue`. */
  label: string;
  labelValue?: string;
  /** `labelValue` is fixed copy too (translated by the panel), not a literal such as a channel letter. */
  translateValue?: boolean;
  /** Typical range, in the parameter's own units (milliseconds, ratios, points). */
  min: number;
  max: number;
  /** Technical range (validateMoodParameters). */
  techMin: number;
  techMax: number;
  /** Display unit: a value shows as value / divisor followed by `unit`. */
  divisor: number;
  unit: string;
  /** Whole numbers only (the proactive speech limits). */
  integer?: boolean;
}

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const CHANNEL_HALF_LIVES = { D: [2, 30, 10_000, 3 * HOUR], O: [10, 120, 30_000, DAY], E: [5, 90, 30_000, 12 * HOUR], N: [0.5, 15, 5_000, HOUR], C: [5, 90, 30_000, DAY] } as const;
const entry = (group: string, key: string, label: string, min: number, max: number, techMin: number, techMax: number,
  divisor = 1, unit = '', extra: Partial<MoodTypicalRange> = {}): MoodTypicalRange =>
  ({ path: group ? `${group}.${key}` : key, group, key, label, min, max, techMin, techMax, divisor, unit, ...extra });

/** In the order the panel's confirmation has always listed them. */
export const MOOD_TYPICAL_RANGES: readonly MoodTypicalRange[] = Object.freeze([
  ...MOOD_CHANNELS.flatMap(channel => [
    entry('baseline', channel, '{0} 静息基线', 40, 60, 5, 95, 1, '', { labelValue: channel }),
    entry('sensitivity', channel, '{0} 事件敏感度', 0.5, 1.5, 0, 4, 1, '倍', { labelValue: channel }),
  ]),
  ...MOOD_CHANNELS.map(channel => {
    const [min, max, techMin, techMax] = CHANNEL_HALF_LIVES[channel];
    return entry('halfLifeMs', channel, '{0} 恢复半衰期', min * MINUTE, max * MINUTE, techMin, techMax, MINUTE, '分钟', { labelValue: channel });
  }),
  ...([['playful', '玩闹'], ['close', '亲近'], ['comfortable', '舒适'], ['cautious', '谨慎']] as const)
    .map(([key, name]) => entry('weights', key, '{0}倾向', 0.5, 1.5, 0, 4, 1, '倍', { labelValue: name, translateValue: true })),
  ...([['expression', '表情'], ['gaze', '眼神'], ['posture', '亲近姿态'], ['playful', '玩闹幅度'], ['text', '文字语气']] as const)
    .map(([key, name]) => entry('intensity', key, '{0}强度', 25, 75, 0, 100, 1, '', { labelValue: name, translateValue: true })),
  entry('freshness', 'retention', '重复保留比例', 0.4, 0.8, 0, 1, 0.01, '%'),
  entry('freshness', 'floor', '重复最低保留比例', 0.05, 0.4, 0, 1, 0.01, '%'),
  entry('freshness', 'ruaMs', '摸头新鲜度恢复', 2 * MINUTE, 15 * MINUTE, 10_000, 2 * HOUR, MINUTE, '分钟'),
  entry('freshness', 'foodMs', '喂食新鲜度恢复', 10 * MINUTE, 120 * MINUTE, MINUTE, DAY, MINUTE, '分钟'),
  entry('freshness', 'chatMs', '重复话题新鲜度恢复', 5 * MINUTE, 60 * MINUTE, 30_000, 12 * HOUR, MINUTE, '分钟'),
  entry('', 'fastThreshold', '快变判定门槛', 3, 12, 1, 30, 1, '点'),
  entry('evidence', 'level', '当前水平响应', 0.5, 1.5, 0, 4, 1, '倍'),
  entry('evidence', 'trend', '快变响应', 0.5, 1.5, 0, 4, 1, '倍'),
  entry('boredom', 'graceMs', '无聊积累宽限', 2 * MINUTE, 15 * MINUTE, 0, 120 * MINUTE, MINUTE, '分钟'),
  entry('boredom', 'perMinute', '无聊增速', 0.5, 4, 0, 20, 1, '点/分钟'),
  entry('boredom', 'lookAt', '无聊注视门槛', 20, 45, 0, 100, 1, '点'),
  entry('boredom', 'motionAt', '无聊小动作门槛', 40, 70, 0, 100, 1, '点'),
  entry('boredom', 'speechAt', '无聊主动说话门槛', 65, 90, 0, 100, 1, '点'),
  entry('longing', 'graceMs', '想念积累宽限', 4 * HOUR, 48 * HOUR, 0, 168 * HOUR, HOUR, '小时'),
  entry('longing', 'perHour', '想念增速', 0.5, 4, 0, 60, 1, '点/小时'),
  entry('longing', 'longingAt', '想念候选门槛', 20, 45, 0, 100, 1, '点'),
  entry('longing', 'sadAt', '想念伤感门槛', 45, 75, 0, 100, 1, '点'),
  entry('longing', 'cryAt', '想念哭泣门槛', 75, 95, 0, 100, 1, '点'),
  entry('longing', 'cryCooldownMs', '哭泣冷却', 12 * HOUR, 72 * HOUR, MINUTE, 30 * DAY, HOUR, '小时'),
  entry('longing', 'cryDurationMs', '明显哭泣时长', 3_000, 15_000, 1_000, 120_000, 1000, '秒'),
  entry('frequency', 'motionIntervalMs', '主动小动作间隔', 3 * MINUTE, 15 * MINUTE, 10_000, HOUR, MINUTE, '分钟'),
  entry('frequency', 'speechIntervalMs', '主动发言间隔', 20 * MINUTE, 120 * MINUTE, 30_000, DAY, MINUTE, '分钟'),
  entry('frequency', 'speechPerHour', '滚动一小时主动发言上限', 0, 3, 0, 30, 1, '次', { integer: true }),
  entry('frequency', 'speechWithoutReply', '无人回应期间主动发言上限', 0, 2, 0, 10, 1, '次', { integer: true }),
].map(value => Object.freeze(value)));

const BY_PATH = new Map(MOOD_TYPICAL_RANGES.map(value => [value.path, value]));
export function moodTypicalRange(path: string): MoodTypicalRange | undefined { return BY_PATH.get(path); }

/** The label in plain Chinese ("O 事件敏感度", "亲近倾向"). */
export function moodRangeLabel(range: MoodTypicalRange): string {
  return range.label.replace('{0}', range.labelValue ?? '');
}
/** 480000 → "8分钟", 0.6 → "60%" (the panel's own rounding: two decimals in the display unit). */
export function moodRangeDisplay(range: MoodTypicalRange, value: number, unit = range.unit): string {
  return `${Math.round(value / range.divisor * 100) / 100}${unit}`;
}
export function moodRangeValue(parameters: unknown, range: MoodTypicalRange): unknown {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined;
  const record = parameters as Record<string, unknown>;
  const fields = range.group ? record[range.group] : record;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  return (fields as Record<string, unknown>)[range.key];
}
export function outsideTypicalRange(range: MoodTypicalRange, value: number): boolean {
  return !(value >= range.min && value <= range.max);
}
/** The nearest value inside the typical range ("不同意就收回到常规范围内"). */
export function clampToTypicalRange(range: MoodTypicalRange, value: number): number {
  return Math.min(range.max, Math.max(range.min, value));
}

export interface MoodRangeDifference { range: MoodTypicalRange; before: number; after: number }
/**
 * The newly chosen values outside the typical range: `candidate` differs from `current` there. A value the card
 * already has is not listed again (an accepted value is not re-confirmed). Non-objects and non-numbers list nothing.
 */
export function moodExtendedValues(candidate: unknown, current: MoodParameters): MoodRangeDifference[] {
  const result: MoodRangeDifference[] = [];
  for (const range of MOOD_TYPICAL_RANGES) {
    const value = moodRangeValue(candidate, range);
    if (typeof value !== 'number' || !Number.isFinite(value) || !outsideTypicalRange(range, value)) continue;
    const before = moodRangeValue(current, range) as number;
    if (before === value) continue;
    result.push({ range, before, after: value });
  }
  return result;
}
