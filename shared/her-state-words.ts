/**
 * 「她现在怎么样」的白话版（内部通道的只读工具 get_her_state）：心情的标签和轻/中/强、困不困、正在做的事、
 * 上次互动是多久以前。只读已有的状态（MoodView）；不含聊天、日记、画像的任何文字，也不给原始数字。
 * 纯函数：时间由调用方交进来，好单独测。
 */
import { MOOD_CHANNELS, type MoodLabel, type MoodValues } from './mood';
import { MOOD_LABELS } from './mood-runtime';
import { FATIGUE_WORDS } from './turn-awareness';
import { HER_LIFE_TABLE, isHerLifeActivity } from './her-life';
import type { FatiguePhase } from './fatigue';

/** What this reads from the app's mood view (structural, so a test can hand in a small object). */
export interface HerStateSource {
  snapshot?: { primary?: unknown; values?: Partial<MoodValues>; phase?: unknown; lastInteractionAt?: unknown };
  parameters?: { baseline?: Partial<MoodValues> };
  fatigue?: { phase?: unknown };
  herLife?: { activity?: unknown };
}

export interface HerStateWords {
  mood: { label: string; strength: '轻' | '中' | '强' | null };
  sleepiness: string;
  doing: string;
  sinceLastInteraction: string;
  note: string;
}

/** How far the furthest of her five mood channels is from her own baseline: under LIGHT is 轻, under MIDDLE is 中, otherwise 强. Trial values. */
export const HER_STATE_STRENGTH = Object.freeze({ light: 8, middle: 20 });

const PHASE_DOING: Readonly<Record<string, string>> = Object.freeze({
  rua: '正被你摸头', cheek: '正被你捏脸', 'food-wait': '在等你喂点心', 'food-ready': '正要吃你喂的点心', 'food-eating': '在吃你喂的点心',
});

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

export function moodStrength(source: HerStateSource): '轻' | '中' | '强' | null {
  const values = source.snapshot?.values, baseline = source.parameters?.baseline;
  if (!values || !baseline) return null;
  let far = 0, seen = false;
  for (const channel of MOOD_CHANNELS) {
    const now = values[channel], base = baseline[channel];
    if (finite(now) && finite(base)) { far = Math.max(far, Math.abs(now - base)); seen = true; }
  }
  if (!seen) return null;
  return far < HER_STATE_STRENGTH.light ? '轻' : far < HER_STATE_STRENGTH.middle ? '中' : '强';
}

/** "刚刚" … "很久没有", from the minutes since the last chat, pat or feeding. */
export function sinceWords(at: unknown, now: number): string {
  if (!finite(at) || !finite(now) || at > now + 60_000) return '还没有互动过';
  const minutes = Math.max(0, (now - at) / 60_000);
  if (minutes < 2) return '刚刚';
  if (minutes < 10) return '几分钟前';
  if (minutes < 25) return '十几分钟前';
  if (minutes < 50) return '半个小时左右';
  if (minutes < 100) return '一个小时左右';
  if (minutes < 240) return '一两个小时前';
  if (minutes < 600) return '好几个小时前';
  if (minutes < 1440) return '大半天了';
  if (minutes < 2880) return '昨天';
  return '好几天了';
}

export function herStateWords(source: HerStateSource | null | undefined, now: number): HerStateWords {
  const primary = source?.snapshot?.primary;
  const known = typeof primary === 'string' && Object.prototype.hasOwnProperty.call(MOOD_LABELS, primary);
  const label = known ? MOOD_LABELS[primary as MoodLabel] : '看不出来';
  // A calm mood has no strength to speak of.
  const strength = known && primary !== 'calm' ? moodStrength(source!) : null;
  const phase = source?.fatigue?.phase;
  const sleepiness = typeof phase === 'string' && Object.prototype.hasOwnProperty.call(FATIGUE_WORDS, phase) ? FATIGUE_WORDS[phase as FatiguePhase] : '看不出来';
  const phaseDoing = typeof source?.snapshot?.phase === 'string' ? PHASE_DOING[source.snapshot.phase] : undefined;
  const activity = source?.herLife?.activity;
  const doing = phaseDoing ?? (isHerLifeActivity(activity) && activity !== 'company' ? HER_LIFE_TABLE[activity].chat : '在你旁边待着');
  return { mood: { label, strength }, sleepiness, doing, sinceLastInteraction: sinceWords(source?.snapshot?.lastInteractionAt, now),
    note: '只是她此刻状态的白话说法，不含聊天和日记；心情会随时间和互动变化，说话前可以再读一次。' };
}
