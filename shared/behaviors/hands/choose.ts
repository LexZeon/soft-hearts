/**
 * I-087 牵手、拉钩、击掌：纯规则（没有时钟、没有存储、没有模型调用）。旋钮在 knobs.ts。
 *
 * 从心情开始（按激素和心情数值来想，handbook/how-we-work.md）：
 *  - O（亲近）高 → 更常自己伸手找你牵，等得更久，会回握；
 *  - N、C 高（害怕、紧张，比如看恐怖片）→ 主动找你的手，握得更紧；
 *  - D（开心）高 → 击掌更来劲，牵着会轻轻晃手；
 *  - A（困）高 → 握得松，跟得慢，可能牵着就睡着了。
 * 全部只读数和标签，不读任何对话、画面或声音内容。
 */
import { moodLevel, type MoodValues } from '../../foundation/mood';
import { HANDS_KNOBS, type HandStyle, type HandUse, type HandWhy } from './knobs';

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const round = (n: number) => Math.round(n * 100) / 100;

/** 她此刻的心情（主机从心情主机读，相对角色卡基线）。 */
export interface HandsMood {
  readonly values: MoodValues;
  readonly baseline: MoodValues;
  readonly evidence?: number;
  /** A：她的睡眠压力 0–1；不知道 = null。 */
  readonly A: number | null;
}

export interface HandsLean {
  /** "想牵你"的机会倍数（乘到 own.chance / rest.chance 上）。 */
  readonly factor: number;
  /** 进体验记录的理由（封闭的词）。 */
  readonly why: readonly HandWhy[];
  readonly style: HandStyle;
  /** 等你多久的倍数（O 高：等得更久）。 */
  readonly wait: number;
}

const level = (mood: HandsMood, channel: keyof MoodValues) =>
  moodLevel(finite(mood.values?.[channel], 50), finite(mood.baseline?.[channel], 50), finite(mood.evidence, 1));

/** 从心情读"想不想伸手、伸手的样子"。 */
export function handsLean(mood: HandsMood, knobs = HANDS_KNOBS.lean): HandsLean {
  const o = level(mood, 'O'), d = level(mood, 'D'), n = level(mood, 'N'), c = level(mood, 'C');
  const why: HandWhy[] = [];
  const oFactor = clamp(1 + knobs.oStep * (o - 50) / 10, knobs.floor, knobs.ceil);
  if (o >= knobs.closeO) why.push('close');
  const tense = Math.max(n, c);
  let tenseFactor = 1;
  if (tense > knobs.tenseHigh) { tenseFactor = 1 + (knobs.tenseBoost - 1) * clamp((tense - knobs.tenseHigh) / (100 - knobs.tenseHigh), 0, 1); why.push('scared'); }
  const A = mood.A === null ? null : clamp(finite(mood.A, 0), 0, 1);
  const sleepy = A !== null && A >= knobs.sleepyA;
  // Grip: tense → tighter (up to 1); sleepy → loose; otherwise a gentle 0.6.
  const tight = tense > knobs.tenseHigh ? clamp((tense - knobs.tenseHigh) / (100 - knobs.tenseHigh), 0, 1) : 0;
  const grip = clamp((sleepy ? 0.35 : 0.6) + 0.4 * tight, 0.3, 1);
  const playful = clamp((d - knobs.playfulD) / (100 - knobs.playfulD) * 2, 0, 1);
  const style: HandStyle = { hesitant: false, grip: round(grip), swing: round(playful), lively: round(playful), squeezeBack: o >= knobs.closeO, sleepy };
  const factor = clamp(oFactor * tenseFactor, knobs.floor, knobs.ceil);
  return { factor: round(factor), why, style, wait: o >= knobs.closeO ? knobs.waitLonger : 1 };
}

/** 按角色记在存档里的账：今天自己伸了几次、问了几次、上一次什么时候、上一次没点是什么时候；第一次牵手；拉过钩的计划。 */
export interface HandsLedger {
  readonly day: string;
  readonly own: number;
  readonly rest: number;
  readonly pinky: number;
  readonly highFive: number;
  readonly lastOfferAt: number;
  readonly lastOwnAt: number;
  readonly lastHighFiveAt: number;
  readonly lastNotTakenAt: number;
  /** 第一次牵手：kept 记成了我们的小东西（"允许记录"开着）；held 牵过了但没记（关着）；null 还没牵过。 */
  readonly firstHold: 'kept' | 'held' | null;
  /** 拉过钩的计划（P-001 清单里那件事的编号）和拉钩的时间；只在"允许记录"开着时有。 */
  readonly promises: readonly { readonly planId: string; readonly at: number }[];
}

export const PROMISES_MAX = 40;
export const emptyHandsLedger = (): HandsLedger => ({ day: '', own: 0, rest: 0, pinky: 0, highFive: 0, lastOfferAt: 0, lastOwnAt: 0, lastHighFiveAt: 0,
  lastNotTakenAt: 0, firstHold: null, promises: [] });

export const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** A new local day resets the day's counts (the other fields stay). */
export function handsToday(ledger: HandsLedger, now: number): HandsLedger {
  const day = localDay(now);
  return ledger.day === day ? ledger : { ...ledger, day, own: 0, rest: 0, pinky: 0, highFive: 0 };
}

/** Where an offer came from (decides which count and gap apply). */
export type HandsSource = 'own' | 'rest' | 'plan' | 'game' | 'finished';
export const useOf = (source: HandsSource): HandUse => source === 'plan' ? 'pinky' : source === 'game' || source === 'finished' ? 'high-five' : 'hold';

/** May an offer from this source start now (counts, gaps; before the mood's chance)? */
export function handsAllowed(ledger: HandsLedger, source: HandsSource, now: number, knobs = HANDS_KNOBS): boolean {
  const today = handsToday(ledger, now), since = (at: number) => now - at;
  if (source === 'own') return today.own < knobs.own.perDay && since(today.lastOwnAt) >= knobs.own.gapMs && since(today.lastOfferAt) >= knobs.rest.gapMs
    && since(today.lastNotTakenAt) >= knobs.rest.afterNotTakenMs;
  if (source === 'rest') return today.rest < knobs.rest.perDay && since(today.lastOfferAt) >= knobs.rest.gapMs && since(today.lastNotTakenAt) >= knobs.rest.afterNotTakenMs;
  if (source === 'plan') return today.pinky < knobs.pinkyPerDay;
  return today.highFive < knobs.highFive.perDay && since(today.lastHighFiveAt) >= knobs.highFive.gapMs;
}

/** The ledger after an offer started. */
export function noteHandsOffer(ledger: HandsLedger, source: HandsSource, now: number): HandsLedger {
  const today = handsToday(ledger, now);
  const base = { ...today, lastOfferAt: now };
  if (source === 'own') return { ...base, own: today.own + 1, lastOwnAt: now };
  if (source === 'rest') return { ...base, rest: today.rest + 1 };
  if (source === 'plan') return { ...base, pinky: today.pinky + 1 };
  return { ...base, highFive: today.highFive + 1, lastHighFiveAt: now };
}

/** The ledger after an offer ended: a not-taken one keeps the next offers a little further apart (no guilt: nothing else changes). */
export function noteHandsEnd(ledger: HandsLedger, outcome: 'taken' | 'not-taken' | 'let-go' | 'interrupted', now: number): HandsLedger {
  return outcome === 'not-taken' ? { ...ledger, lastNotTakenAt: now } : ledger;
}

/**
 * The first hold ever: kept as a keepsake only while 「允许记录」 is on ('kept'); off, she only notes that it happened ('held') so a
 * later hold is not called the first. Returns the new ledger and whether this hold is the first one to keep.
 */
export function noteFirstHold(ledger: HandsLedger, recording: boolean): { ledger: HandsLedger; keep: boolean } {
  if (ledger.firstHold !== null) return { ledger, keep: false };
  return { ledger: { ...ledger, firstHold: recording ? 'kept' : 'held' }, keep: recording };
}

/** A pinky promise for these plans (only while recording is on; the caller checks). Newest kept, at most PROMISES_MAX. */
export function notePromise(ledger: HandsLedger, planIds: readonly string[], now: number): HandsLedger {
  const fresh = planIds.filter(id => typeof id === 'string' && id && !ledger.promises.some(p => p.planId === id)).map(planId => ({ planId, at: now }));
  if (!fresh.length) return ledger;
  return { ...ledger, promises: [...ledger.promises, ...fresh].slice(-PROMISES_MAX) };
}

/** Recording went off: the promises go with the plans (the plan lists are deleted at the same moment). */
export const forgetPromises = (ledger: HandsLedger): HandsLedger => ledger.promises.length ? { ...ledger, promises: [] } : ledger;

const ID = /^[A-Za-z0-9_:-]{1,128}$/u;
/** Strict read of a stored ledger; anything off → null (the store then starts empty for that character). */
export function readHandsLedger(value: unknown): HandsLedger | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const whole = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  if (typeof v.day !== 'string' || v.day.length > 10 || !['own', 'rest', 'pinky', 'highFive', 'lastOfferAt', 'lastOwnAt', 'lastHighFiveAt', 'lastNotTakenAt'].every(k => whole(v[k]))) return null;
  if (v.firstHold !== null && v.firstHold !== 'kept' && v.firstHold !== 'held') return null;
  if (!Array.isArray(v.promises) || v.promises.length > PROMISES_MAX) return null;
  const promises: { planId: string; at: number }[] = [];
  for (const p of v.promises as unknown[]) {
    const r = p as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || typeof r.planId !== 'string' || !ID.test(r.planId) || !whole(r.at)) return null;
    promises.push({ planId: r.planId, at: r.at as number });
  }
  return { day: v.day, own: v.own as number, rest: v.rest as number, pinky: v.pinky as number, highFive: v.highFive as number, lastOfferAt: v.lastOfferAt as number,
    lastOwnAt: v.lastOwnAt as number, lastHighFiveAt: v.lastHighFiveAt as number, lastNotTakenAt: v.lastNotTakenAt as number, firstHold: v.firstHold as HandsLedger['firstHold'], promises };
}

/**
 * "你说做完了一件事"：本机的一次字面检查（用户刚发的这句；不存、不记原文，只得到 true / false）。
 * 有"做完了 / 搞定了 / 完成了 / 写完了 / 交了 …"一类的词，并且附近没有"没 / 还没 / 不 / 快"这类否定或未完成。
 */
const FINISHED = /(?:做完|干完|弄完|写完|改完|考完|画完|学完|看完|跑完|练完|收拾完|忙完|搞定|完成|完工|交了|交上去|提交了|通过了|上线了|发布了|弄好了|做好了|写好了|finished|done|completed|nailed it|shipped|submitted)/iu;
const NOT_YET = /(?:没|还没|沒|不|别|快|要|准备|打算|能不能|会不会|吗|么|？|\?|not|n't|almost|yet|going to|gonna)/iu;
export function saysFinished(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const clean = text.trim();
  if (!clean || clean.length > 120) return false;
  const match = FINISHED.exec(clean);
  if (!match) return false;
  // The few characters right before the word (and a question anywhere) decide: "还没做完", "快写完了", "做完了吗" are not done.
  const before = clean.slice(Math.max(0, match.index - 4), match.index);
  if (NOT_YET.test(before)) return false;
  if (/[？?]|吗|么$|没有?$|沒有?$/u.test(clean)) return false;
  return true;
}
