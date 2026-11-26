/**
 * 松绑第 3 段"表现"的纯规则：话头（topic）和活人感的小毛病（slip），以及把它们写进内心循环提示词的那几行字。
 * 话头只从此刻真有的东西里挑（没有就不给，不硬找）；不报数字、不像系统通知；
 * 小毛病低频、有冷却、同一种不连着来；说法不给模板句，让她用自己的话。
 * 这几行都不碰原则 6：不让用户内疚、不说教、不劝用户去找别人（tests/loosen.test.ts 用一组词检查）。
 */
import { moodLevel, type MoodTendency, type MoodValues } from '../../foundation/mood';
import { IMPULSE_KNOBS, type ImpulseKnobs } from './knobs';
import { cardSlipsFactor, type CardSlips } from '../../cards';

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp01 = (value: number) => Math.min(1, Math.max(0, finite(value, 0)));

/**
 * The topics she may be given, each only when its real source is there: what she was just doing (her-life), a small thing that just
 * happened to her (her mood's recent positive reason), something the user mentioned (profile points), her diary, the time of day,
 * her own mood now.
 */
export const TOPIC_KINDS = ['doing', 'event', 'you', 'diary', 'time', 'mood', 'plan'] as const;
export type TopicKind = (typeof TOPIC_KINDS)[number];

export interface TopicMemory {
  /** The topics given most recently, newest first. */
  readonly recent: readonly TopicKind[];
  /** A topic she brought up that the user did not take, or an invite turned down: not again until then. */
  readonly quietUntil: Readonly<Partial<Record<TopicKind, number>>>;
}

/** Pick one topic among the available ones (or none: she is not forced to find one). Exactly one random number is drawn. */
export function pickTopic(available: readonly TopicKind[], memory: TopicMemory, now: number, random: () => number,
  knobs: ImpulseKnobs = IMPULSE_KNOBS): TopicKind | null {
  const weights: [TopicKind | null, number][] = [];
  for (const kind of TOPIC_KINDS) {
    if (!available.includes(kind)) continue;
    const until = memory.quietUntil[kind];
    if (until !== undefined && now < until) continue;
    const index = memory.recent.indexOf(kind);
    const recent = index >= 0 && index < knobs.topic.recent.length ? knobs.topic.recent[index] : 1;
    weights.push([kind, knobs.topic.weights[kind] * recent]);
  }
  const draw = clamp01(finite(random(), 0));
  if (!weights.length) return null;
  weights.push([null, knobs.topic.weights.none]);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let roll = draw * total;
  for (const [kind, w] of weights) { roll -= w; if (roll < 0) return kind; }
  return null;
}

/** The real data a topic line may name (already plain words from the host); a kind without its data is never offered. */
export interface TopicData {
  /** Her own activity's words (HER_LIFE_TABLE[...].chat), when she is doing something other than keeping you company. */
  readonly doing?: string;
  /** Her mood's recent reason, only when it was a good or warm moment (never a let-down: that would be a guilt lever). */
  readonly event?: string;
  /** The time-of-day label (innerLoopTimeOfDay's first word: 上午、傍晚…). */
  readonly time?: string;
  /** P-001 step 3: a plan the user told her whose time has passed (shared/behaviors/upcoming/ask.ts topicText); never a tender one. */
  readonly plan?: string;
}

/** The one 【话头】 line for her prompt ('' for null). Says where to look, never what to say; numbers and system talk are ruled out. */
export function topicLine(kind: TopicKind | null, data: TopicData): string {
  const lead = '话头（可以用，也可以换成你更想说的；只说真有的，不编）：';
  switch (kind) {
    case 'doing': return data.doing ? `${lead}你刚才自己在做的事——${data.doing}。` : '';
    case 'event': return data.event ? `${lead}你刚经历的一件小事——${data.event}。` : '';
    case 'you': return `${lead}上面画像里用户提过的一件事或打算（只挑资料里真有的一件）。`;
    case 'diary': return `${lead}你最近日记里的一件小事（只挑资料里真有的一件）。`;
    case 'time': return data.time ? `${lead}此刻是${data.time}，这个时候你自己的感觉。` : '';
    case 'mood': return `${lead}你此刻自己的心情。`;
    case 'plan': return data.plan ? `${lead}用户之前说过的一个打算——${data.plan}。` : '';
    default: return '';
  }
}

/** Her small human slips. Never about guilt; principle 6 is untouched. */
export const SLIP_KINDS = ['change-mind', 'distracted', 'deny'] as const;
export type SlipKind = (typeof SLIP_KINDS)[number];

export interface SlipMemory {
  readonly last: SlipKind | null;
  /** No slip before this time (a cooldown drawn after each one). */
  readonly until: number;
}

export interface SlipMood {
  readonly values: MoodValues;
  readonly baseline: MoodValues;
  readonly evidence?: number;
  /** A, 0–1, null when not known. */
  readonly A: number | null;
  readonly personality?: Partial<Record<MoodTendency, number>> | null;
  /** The card's 小毛病 switch (shared/cards/card-slips.ts): off / less / more; absent = the default (no change). */
  readonly cardSlips?: CardSlips | null;
}

/**
 * Each slip's chance this time: the knob's small base × her personality and mood. N high (excited) → she changes her mind mid-line;
 * A high (sleepy) → a moment's distraction; a cautious or playful card denies being caught (tsundere). Rare by design.
 */
export function slipChances(mood: SlipMood, knobs: ImpulseKnobs = IMPULSE_KNOBS): Readonly<Record<SlipKind, number>> {
  const level = (channel: keyof MoodValues) => (moodLevel(finite(mood.values?.[channel], 50), finite(mood.baseline?.[channel], 50), finite(mood.evidence, 1)) - 50) / 50;
  const trait = (name: MoodTendency) => Math.min(4, Math.max(0, finite(mood.personality?.[name], 1)));
  const A = mood.A === null ? 0 : clamp01(mood.A);
  const base = knobs.slip.chance * cardSlipsFactor(mood.cardSlips); // the card's 小毛病 switch: 关 = 0 (never), 少, 多
  return {
    'change-mind': base * (1 + 1.5 * Math.max(0, level('N'))) * (0.6 + 0.4 * trait('playful')),
    distracted: base * (0.5 + 2 * Math.max(0, A - 0.3)),
    deny: base * (0.4 + 0.3 * trait('cautious') + 0.3 * trait('playful')) * (1 + Math.max(0, level('O'))),
  };
}

/** Whether she slips this time and how. Exactly one random number is drawn. The same kind never comes twice in a row. */
export function pickSlip(mood: SlipMood, memory: SlipMemory, now: number, random: () => number, knobs: ImpulseKnobs = IMPULSE_KNOBS): SlipKind | null {
  const draw = clamp01(finite(random(), 0));
  if (now < memory.until) return null;
  const chances = slipChances(mood, knobs);
  let roll = draw;
  for (const kind of SLIP_KINDS) {
    if (kind === memory.last) continue;
    roll -= Math.min(0.5, chances[kind]);
    if (roll < 0) return kind;
  }
  return null;
}

/** The one slip line for her prompt ('' for null). Describes the slip; never a sentence to copy. */
export function slipLine(kind: SlipKind | null): string {
  switch (kind) {
    case 'change-mind': return '这次可以带一点活人的小毛病：话说到一半改了口、换个说法（用你自己的方式，别用套话）。';
    case 'distracted': return '这次可以带一点活人的小毛病：你刚才有点走神，回过神来才开口（自然带过，不用解释）。';
    case 'deny': return '这次可以带一点活人的小毛病：明明是自己想找用户，嘴上却不承认，傲娇一下就好。';
    default: return '';
  }
}

/** The first two visible characters of a line (how it opens), for "do not open the same way twice". */
export function lineOpening(text: string): string {
  return Array.from(String(text ?? '').trim().replace(/^[\s"'“”‘’「」…。，,.!！?？~～]+/u, '')).slice(0, 2).join('');
}

/** The style lines that keep her from sounding like a program (always given when she may speak on her own). */
export function styleLine(openings: readonly string[]): string {
  const avoid = openings.filter(Boolean).slice(0, 3).map(opening => `「${opening}」`).join('');
  return `说成你自己的感受，不要报具体的分钟数、时长或次数，不要像系统通知（比如"我注意到……"）。${avoid ? `你最近几次主动开口是用${avoid}开头的，这次换个开头。` : ''}`;
}

/**
 * A plain count of what makes a line sound like a program, for scenario runs and tests: lines that report a number of minutes or
 * hours or sound like a notice, and how often two of her own lines in a row open the same way. No model involved.
 */
export function programFeel(lines: readonly string[]): { numberReports: number; sameOpenings: number; lines: number } {
  const NUMBER = /\d+\s*(?:分钟|小时|秒|次|分)|[一二两三四五六七八九十几]+\s*(?:分钟|个?小时)|我注意到|检测到|系统/u;
  let numberReports = 0, sameOpenings = 0, previous = '';
  for (const line of lines) {
    if (NUMBER.test(line)) numberReports++;
    const opening = lineOpening(line);
    if (opening && opening === previous) sameOpenings++;
    previous = opening;
  }
  return { numberReports, sameOpenings, lines: lines.length };
}
