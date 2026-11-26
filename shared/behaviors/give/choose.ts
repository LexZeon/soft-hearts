/**
 * I-086 她也照顾你：纯规则（没有时钟、没有存储、没有模型调用）。旋钮在 knobs.ts。
 *
 *  - giveLean：从心情读"想不想递"——O（亲近）、M（想念）高 → 更想递；N、C（紧张、压力）高 → 少递，先顾自己；D 高 → 俏皮。
 *    结果是"她想找你说话"里"递给你点东西"这一项分量的一个倍数和几句理由（shared/behaviors/opening-choice/）。
 *  - pickGiveItem：从她自己困不困（A）和你的状态（深夜、刚说累、很久没动）选递什么；有你喂过她的点心图时，点心可以就是那张图。
 *  - giveAllowed / noteGiveOffer：一天最多几次、两次之间隔多久（按角色记在存档里，见 electron/initiative/give/store.ts）。
 *  - pictureMoment / pictureAllowed：特别的时候才留一张图，一天最多一次。
 * 全部只读数和标签，不读任何对话、画面或声音内容。
 */
import { moodLevel, type MoodValues } from '../../foundation/mood';
import { GIVE_ITEMS, GIVE_ITEM_IDS, GIVE_KNOBS, type GiveItemId, type GiveLeanMoment } from './knobs';

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** 她此刻的心情，挑选时只看这些数（都来自心情主机，相对角色卡基线读）。 */
export interface GiveMood {
  readonly values: MoodValues;
  readonly baseline: MoodValues;
  /** 角色卡的 evidence.level（moodLevel 的第三个参数）。 */
  readonly evidence?: number;
  /** M：想念，0–100（MoodSnapshot.longing）。 */
  readonly longing: number;
  /** A：她的睡眠压力，0–1（FatigueView.A）；不知道就是 null。 */
  readonly A: number | null;
}

export interface GiveReason { readonly text: string; readonly factor: number }
export interface GiveLean {
  /** 分量倍数（乘到"递给你点东西"这一项上）。 */
  readonly factor: number;
  readonly reasons: readonly GiveReason[];
  /** D 高：递得俏皮些。 */
  readonly playful: boolean;
}

const level = (mood: GiveMood, channel: keyof MoodValues) =>
  moodLevel(finite(mood.values[channel], 50), finite(mood.baseline[channel], 50), finite(mood.evidence, 1));

/** "想不想递"：每一项心情各自给一个倍数，乘起来夹在 floor～ceil。 */
export function giveLean(mood: GiveMood, knobs = GIVE_KNOBS.lean): GiveLean {
  const reasons: GiveReason[] = [];
  const o = level(mood, 'O'), d = level(mood, 'D'), n = level(mood, 'N'), c = level(mood, 'C');
  const oFactor = clamp(1 + knobs.oStep * (o - 50) / 10, knobs.floor, knobs.ceil);
  if (Math.abs(oFactor - 1) >= 0.05) reasons.push({ text: oFactor > 1 ? '亲近感高（O）' : '亲近感低（O）', factor: round(oFactor) });
  const m = clamp(finite(mood.longing, 0), 0, 100), mFactor = 1 + knobs.mStep * m / 10;
  if (mFactor - 1 >= 0.05) reasons.push({ text: '想你（M）', factor: round(mFactor) });
  // N or C high: she keeps to herself first. The higher of the two decides (they often rise together).
  const tense = Math.max(n, c);
  if (tense > knobs.high) {
    const t = clamp((tense - knobs.high) / (100 - knobs.high), 0, 1), factor = 1 - (1 - knobs.calm) * t;
    reasons.push({ text: n >= c ? '有点紧张（N）' : '心里有压力（C）', factor: round(factor) });
  }
  const playful = d >= knobs.playfulD;
  if (playful) reasons.push({ text: '这会儿有点调皮（D）', factor: 1 });
  const factor = clamp(reasons.reduce((product, reason) => product * reason.factor, 1), knobs.floor, knobs.ceil);
  return { factor: round(factor), reasons, playful };
}

/** 你此刻的状态（主机从已有的地方读：本地时间、你刚说累没、多久没动）。 */
export interface GiveUserMoment {
  readonly localMinute: number;
  /** 你刚说过累（electron/senses/user-state.ts 的 tired 一类）。 */
  readonly tired: boolean;
  /** 离你上次有动静（和她互动或电脑上）多少分钟；不知道 = null。 */
  readonly stillMinutes: number | null;
}

/** 你喂过她、存着小图的点心（我们的小东西里 dir 'fed' 且带图的那几条）。 */
export interface FedSnackPicture { readonly id: string; readonly name: string; readonly at: number; readonly loved?: boolean }

export interface GivePick {
  readonly item: GiveItemId;
  /** 递回给你的那张点心图（我们的小东西里的 id）；没有就是 null（递一块程序画的点心）。 */
  readonly picture: FedSnackPicture | null;
  readonly playful: boolean;
  /** 只有理由的字，进体验记录（不含任何名字或话）。 */
  readonly why: readonly GiveLeanMoment[];
}

export function inWindow(minute: number, from: number, to: number): boolean {
  const m = ((Math.floor(finite(minute, -1)) % 1440) + 1440) % 1440;
  if (!Number.isFinite(minute)) return false;
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

/** 此刻成立的几件事（选递什么时看）。 */
export function giveMoments(mood: Pick<GiveMood, 'A'>, user: GiveUserMoment, playful: boolean, knobs = GIVE_KNOBS.moments): GiveLeanMoment[] {
  const out: GiveLeanMoment[] = [];
  if (mood.A !== null && Number.isFinite(mood.A) && mood.A >= knobs.sleepyA) out.push('sleepy');
  if (inWindow(user.localMinute, knobs.nightFrom, knobs.nightTo)) out.push('night');
  if (user.tired === true) out.push('tired');
  if (user.stillMinutes !== null && Number.isFinite(user.stillMinutes) && user.stillMinutes >= knobs.stillMinutes) out.push('still');
  if (playful) out.push('playful');
  return out;
}

/**
 * 选递什么。每件东西的分量 = 此刻成立的几件事的倍数相乘；取一个随机数。点心可以是你喂过她的一张点心图：
 * 她更想递回她爱吃的那几张，越近喂的越容易想起（没有图就是程序画的一块点心）。正好取两个随机数（有图时第二个用来挑图）。
 */
export function pickGiveItem(input: { mood: Pick<GiveMood, 'A'>; user: GiveUserMoment; playful: boolean; pictures: readonly FedSnackPicture[]; now: number; random: () => number },
  items = GIVE_ITEMS, ids: readonly GiveItemId[] = GIVE_ITEM_IDS): GivePick {
  const why = giveMoments(input.mood, input.user, input.playful);
  const weights = ids.map(id => ({ id, weight: why.reduce((product, moment) => product * (items[id].leans[moment] ?? 1), 1) }));
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  let roll = clamp(finite(input.random(), 0), 0, 0.999999) * total, item: GiveItemId = ids[0];
  for (const w of weights) { if (roll < w.weight) { item = w.id; break; } roll -= w.weight; }
  const second = clamp(finite(input.random(), 0), 0, 0.999999);
  const picture = items[item].pictures ? pickSnackPicture(input.pictures, input.now, second) : null;
  return { item, picture, playful: input.playful, why };
}

/** 挑一张点心图：爱吃的 × 2，三天内喂的 × 1.5；没有就是 null。 */
export function pickSnackPicture(pictures: readonly FedSnackPicture[], now: number, roll: number): FedSnackPicture | null {
  const usable = pictures.filter(p => p && typeof p.id === 'string' && p.id && Number.isFinite(p.at));
  if (!usable.length) return null;
  const weight = (p: FedSnackPicture) => (p.loved ? 2 : 1) * (now - p.at <= 3 * 86_400_000 ? 1.5 : 1);
  const total = usable.reduce((sum, p) => sum + weight(p), 0);
  let left = clamp(roll, 0, 0.999999) * total;
  for (const p of usable) { if (left < weight(p)) return p; left -= weight(p); }
  return usable[usable.length - 1];
}

// ------------------------------------------------------------------ how often (per character, kept in the store)

export interface GiveLedger { readonly day: string; readonly offers: number; readonly lastAt: number | null; readonly pictureDay: string | null }
export const EMPTY_GIVE_LEDGER: GiveLedger = Object.freeze({ day: '', offers: 0, lastAt: null, pictureDay: null });

export function giveDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function readGiveLedger(value: unknown): GiveLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_GIVE_LEDGER;
  const v = value as Record<string, unknown>;
  const text = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/u.test(x) ? x : null;
  return { day: text(v.day) ?? '', offers: Number.isSafeInteger(v.offers) && (v.offers as number) >= 0 ? Math.min(99, v.offers as number) : 0,
    lastAt: Number.isSafeInteger(v.lastAt) && (v.lastAt as number) >= 0 ? v.lastAt as number : null, pictureDay: text(v.pictureDay) };
}

/** 现在还能递吗：今天还没到上限，离上次够久（时钟往回跳也不算"够久"之外的漏洞：上次在将来就当刚递过）。 */
export function giveAllowed(ledger: GiveLedger, now: number, knobs: { perDay: number; minGapMs: number } = GIVE_KNOBS): boolean {
  if (!Number.isFinite(now)) return false;
  const today = giveDay(now), count = ledger.day === today ? ledger.offers : 0;
  if (count >= knobs.perDay) return false;
  if (ledger.lastAt !== null && now - ledger.lastAt < knobs.minGapMs && ledger.lastAt - now < 86_400_000) return false;
  return true;
}

/** 真递出去了一次（她那句话说出来了，舞台开始递）：记一次。 */
export function noteGiveOffer(ledger: GiveLedger, now: number): GiveLedger {
  const today = giveDay(now);
  return { ...ledger, day: today, offers: (ledger.day === today ? ledger.offers : 0) + 1, lastAt: Math.floor(now) };
}

// ------------------------------------------------------------------ a picture, only on special moments

export const PICTURE_REASONS = ['late', 'miss', 'special-day'] as const;
export type PictureReason = (typeof PICTURE_REASONS)[number];

/** 此刻算不算特别的时候：你熬到很晚、她很想你、你告诉过她的特别的日子。都不算 = null。 */
export function pictureMoment(input: { localMinute: number; longing: number; specialDay: boolean }, knobs = GIVE_KNOBS.picture): PictureReason | null {
  if (input.specialDay === true) return 'special-day';
  if (finite(input.longing, 0) >= knobs.missM) return 'miss';
  if (inWindow(input.localMinute, knobs.lateFrom, knobs.lateTo)) return 'late';
  return null;
}

export function pictureAllowed(ledger: GiveLedger, now: number): boolean {
  return Number.isFinite(now) && ledger.pictureDay !== giveDay(now);
}

export function notePicture(ledger: GiveLedger, now: number): GiveLedger { return { ...ledger, pictureDay: giveDay(now) }; }

const round = (value: number) => Math.round(value * 100) / 100;
