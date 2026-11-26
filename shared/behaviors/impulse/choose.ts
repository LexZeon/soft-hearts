/**
 * 松绑的纯规则（接口见 interface.ts，旋钮见 knobs.ts）。没有时钟、没有文件、没有模型调用：时间和随机数都由调用方给。
 *
 *  - impulseNow：冲动。
 *  - initiativeFloor：硬底线（不是旋钮）。
 *  - regulateInitiative：一次"想起你"之后挑一件（或不做、为什么）。
 *  - reachChance：这一秒想起你的机会（像抛硬币：没有固定节拍，两次之间的间隔每次都不一样）。
 *  - impulseLeans：开口时"这次说什么"（shared/behaviors/opening-choice/）每个候选从冲动来的那一项倍数。
 */
import { moodLevel, type MoodTendency, type MoodValues } from '../../foundation/mood';
import { IMPULSE_KNOBS, URGE_KINDS, type ImpulseKnobs, type UrgeHold, type UrgeKind, type UrgePush } from './knobs';
import type { FloorInput, Impulse, ImpulseInput, InitiativeDecision, InitiativeFloor, InitiativeKind, UrgeBucket } from './interface';

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const clamp01 = (value: number) => clamp(finite(value, 0), 0, 1);
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** −1..1: how far this channel is from the card's baseline (moodLevel 50 = at the baseline). */
function deviation(input: ImpulseInput, channel: keyof MoodValues): number {
  const level = moodLevel(finite(input.values?.[channel], 50), finite(input.baseline?.[channel], 50), finite(input.evidence, 1));
  return clamp((level - 50) / 50, -1, 1);
}

/** The card's personality on the push: 1 + k × (value − 1) per trait, clamped. */
export function impulsePersonality(personality: ImpulseInput['personality'], knobs: ImpulseKnobs = IMPULSE_KNOBS): number {
  let factor = 1;
  for (const [trait, k] of Object.entries(knobs.personality) as [MoodTendency, number][]) factor += k * (clamp(finite(personality?.[trait], 1), 0, 4) - 1);
  return clamp(factor, 0.4, 1.8);
}

export function urgeBucket(urge: number, knobs: ImpulseKnobs = IMPULSE_KNOBS): UrgeBucket {
  return urge >= knobs.buckets.high ? 'high' : urge >= knobs.buckets.low ? 'mid' : 'low';
}

/** Her urge to reach out now, and each kind's, all from the same numbers. Reads only; changes nothing. */
export function impulseNow(input: ImpulseInput, knobs: ImpulseKnobs = IMPULSE_KNOBS): Impulse {
  const x: Record<UrgePush, number> = {
    O: deviation(input, 'O'), D: deviation(input, 'D'), N: deviation(input, 'N'),
    B: clamp01(finite(input.boredom, 0) / 100), M: clamp01(finite(input.longing, 0) / 100),
  };
  const A = input.A === null || input.A === undefined ? 0 : clamp01(input.A);
  const h: Record<UrgeHold, number> = {
    // Only stress above her baseline holds her back (a calm card is not pushed by low C).
    C: Math.max(0, deviation(input, 'C')),
    A: clamp01((A - knobs.sleepyFrom) / Math.max(0.01, knobs.sleepyFull - knobs.sleepyFrom)),
    ignored: clamp01(finite(input.ignored, 0) / 2),
  };
  const personality = impulsePersonality(input.personality, knobs);
  // `scale`: a kind's own weights (an input the kind does not name counts 0 for it); without one, every input counts as is.
  const sum = (weights: Readonly<Partial<Record<string, number>>>, values: Record<string, number>, scale?: Readonly<Partial<Record<string, number>>>) =>
    Object.entries(weights).reduce((total, [key, w]) => total + finite(w, 0) * (scale ? finite(scale[key], 0) : 1) * finite(values[key], 0), 0);
  const push = sum(knobs.push, x) * personality;
  const hold = sum(knobs.hold, h);
  const urge = clamp01(knobs.base + push - hold);
  const kinds = Object.fromEntries(URGE_KINDS.map(kind => {
    const k = knobs.kinds[kind];
    return [kind, round3(clamp01(knobs.base + sum(knobs.push, x, k.push) * personality - sum(knobs.hold, h, k.hold)))];
  })) as Record<UrgeKind, number>;
  return { urge: round3(urge), bucket: urgeBucket(urge, knobs), kinds, push: round3(push), hold: round3(hold) };
}

/**
 * The hard floor (not a knob). Returns the first reason that holds for this kind, or null. Asleep is not a reason here: while she
 * sleeps she has no reach at all (the host does not even roll).
 *  - every kind: the quiet hours (night, drowsy) and the expression gate (hidden, typing, a chat or her speech running);
 *  - talk also: a meeting or call, the user away / locked / not known (I-066), and her last line still unanswered (no chasing).
 */
export function initiativeFloor(kind: InitiativeKind, floor: FloorInput): InitiativeFloor | null {
  if (floor.quiet) return 'night';
  if (!floor.canExpress) return 'not-now';
  if (kind !== 'talk') return null;
  if (floor.presence === 'meeting') return 'meeting';
  if (floor.presence === 'no') return 'away';
  if (finite(floor.unanswered, 0) >= 1) return 'unanswered';
  return null;
}

export interface RegulateInput {
  readonly impulse: Impulse;
  readonly floor: FloorInput;
  /** I-010 互动余额 for talk now (0..1; it already lets a strong feeling through); null without a budget (no press). */
  readonly balance: number | null;
  /** The user is absorbed in something (I-006): talk is pressed softly (never a stop). */
  readonly busy: boolean;
  /** Her-life offers humming now (her own gates); otherwise no hum. */
  readonly humOffered: boolean;
}

/**
 * One reach: the floor takes out what it must; the soft balance presses talk; then she picks one of what is left, or "this time not"
 * (its weight from what holds her back). Exactly one random number is drawn. "why" is only for nothing: the floor if talk was blocked
 * by it, the balance if it pressed talk below half, else her own choice. A talk the mood clock then refuses is the host's 'cooldown'.
 */
export function regulateInitiative(input: RegulateInput, random: () => number, knobs: ImpulseKnobs = IMPULSE_KNOBS): InitiativeDecision {
  const { impulse, floor } = input, bucket = impulse.bucket;
  const talkFloor = initiativeFloor('talk', floor), otherFloor = initiativeFloor('glance', floor);
  const balance = input.balance === null ? 1 : clamp01(input.balance);
  const weights: [InitiativeKind | 'none', number][] = [];
  if (!talkFloor) {
    const talk = Math.max(impulse.kinds.speak, impulse.kinds.play, impulse.kinds.leave) * balance * (input.busy ? knobs.reach.busy : 1);
    weights.push(['talk', talk]);
  }
  if (!otherFloor) {
    weights.push(['glance', impulse.kinds.glance * knobs.reach.glance]);
    if (input.humOffered) weights.push(['hum', impulse.kinds.hum * knobs.reach.hum]);
  }
  weights.push(['none', knobs.reach.none + knobs.reach.noneHold * impulse.hold]);
  const total = weights.reduce((sum, [, w]) => sum + Math.max(0, finite(w, 0)), 0);
  let roll = clamp01(finite(random(), 0)) * total, kind: InitiativeKind | 'none' = 'none';
  for (const [k, w] of weights) { roll -= Math.max(0, finite(w, 0)); if (roll < 0) { kind = k; break; } }
  if (kind !== 'none') return { bucket, kind };
  if (talkFloor) return { bucket, kind: 'none', why: 'floor', floor: talkFloor };
  if (balance < 0.5) return { bucket, kind: 'none', why: 'balance' };
  return { bucket, kind: 'none', why: 'chose-not' };
}

/**
 * The chance she thinks of reaching out within `dtMs`: zero below `from`; above it a rate that grows with the urge (mean
 * meanMinutes at urge 1), × the 「她主动找你说话」 setting. A Poisson draw, so there is no beat to time.
 */
export function reachChance(urge: number, dtMs: number, talk: 'less' | 'normal' | 'more' = 'normal', knobs: ImpulseKnobs = IMPULSE_KNOBS): number {
  const from = knobs.reach.from;
  if (!(urge > from) || !(dtMs > 0)) return 0;
  const strength = (clamp01(urge) - from) / Math.max(0.01, 1 - from);
  const scale = talk === 'less' ? knobs.reach.talkLess : talk === 'more' ? knobs.reach.talkMore : 1;
  const ratePerMs = strength * scale / (Math.max(0.5, knobs.reach.meanMinutes) * 60_000);
  return 1 - Math.exp(-ratePerMs * Math.min(dtMs, 10_000));
}

/** A uniform draw inside [low, high] minutes, in ms. */
export function drawMinutes(range: readonly [number, number], random: () => number): number {
  const [low, high] = range;
  return (low + (high - low) * clamp01(finite(random(), 0))) * 60_000;
}

/**
 * Each opening-choice candidate's factor from the impulse (the same numbers): her small feeling ← speak, the invite ← play,
 * leaving or handing something ← leave, "this time not" ← what holds her back. Short closed reasons for the developer "why".
 */
export function impulseLeans(impulse: Impulse): Partial<Record<'mood' | 'play' | 'keepsake' | 'give' | 'quiet', { text: string; factor: number }[]>> {
  const lean = (value: number) => Math.round((0.6 + 1.2 * clamp01(value)) * 100) / 100;
  const words = (value: number) => value >= 0.6 ? '很想' : value >= 0.3 ? '有点想' : '不太想';
  return {
    mood: [{ text: `冲动：${words(impulse.kinds.speak)}说话`, factor: lean(impulse.kinds.speak) }],
    play: [{ text: `冲动：${words(impulse.kinds.play)}玩`, factor: lean(impulse.kinds.play) }],
    keepsake: [{ text: `冲动：${words(impulse.kinds.leave)}留点东西`, factor: lean(impulse.kinds.leave) }],
    give: [{ text: `冲动：${words(impulse.kinds.leave)}递点东西`, factor: lean(impulse.kinds.leave) }],
    quiet: [{ text: impulse.hold >= 0.3 ? '收着（压力、困或刚被晾过）' : '没什么收着的', factor: Math.round((0.7 + 1.3 * clamp01(impulse.hold)) * 100) / 100 }],
  };
}
