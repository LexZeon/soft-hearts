/**
 * I-184: one family of close moments in full-screen Unbound, and the one chooser for it. Pure: no
 * clock, no random of its own (the caller hands both in), no Claude.
 *
 * Two ways in, the same chooser:
 *   own     she was going to come up to the lens anyway (the peek's slot, the arbiter's "comes closer" level, its own idle wait and
 *           pace): this picks whether this time it is a kiss or a hug instead of the look. Rare: CLOSE_MOMENT_KNOBS.ownShare at most,
 *           times her mood and character; a day's cap and a cooldown after a kiss or a hug.
 *   pulled  you pulled her to the nearest and held her there a moment: look at you closely (the peek, as before), kiss, hug, shy back
 *           away a step, or nothing. After a kiss or a hug, pulling her again within pulledCooldownMinutes never gets another one.
 *
 * What makes it likely (all relative to the card: the mood levels are against the card's baseline, the weights are the card's):
 *  - warmth: closeness (O) and ease (E) above her baseline, longing a little, the label (close, happy… up; upset, afraid… down);
 *  - (no familiarity: the relationship stage no longer shapes these choices, rules audit item 15, 2026-11-25; her mood and the card decide)
 *  - boldness from the card's mood template: playful and close weights and the playful / expression intensity up, cautious down;
 *  - tension (N and C above baseline) and sleep pressure (A) down.
 * Never (the gates): not shown, asleep, in a call, she is speaking, you are typing to her, you are pulling her now. A hug also never
 * while her arms are held by a game, an offer or her reach for your hand (they keep their priority).
 */
import { tension, curiosity, type MoodReading } from '../director';
import type { MoodLabel } from '../../foundation/mood';
import { CLOSE_MOMENT_KNOBS, type CloseMomentKnobs } from './knobs';

export const CLOSE_KINDS = ['look', 'kiss', 'hug', 'shy', 'none'] as const;
export type CloseKind = (typeof CLOSE_KINDS)[number];
/** The ones that are a performance of their own (look is the peek, none is nothing). */
export type CloseAct = 'kiss' | 'hug' | 'shy';
/** I-185: 'chat' — she wrote ⟦kiss⟧ or ⟦hug⟧ in a reply (shared/unbound/close-moments/chat.ts: no chooser, the family's gates and cooldown). */
export type CloseVia = 'own' | 'pulled' | 'chat';

/** The card's mood template, as far as this reads it: weights 0..4 (1 = neutral), intensity 0..100 (50 = neutral). */
export interface CloseTemperament {
  weights: { playful: number; close: number; comfortable: number; cautious: number };
  intensity: { expression: number; playful: number };
}
export const NEUTRAL_TEMPERAMENT: Readonly<CloseTemperament> = Object.freeze({
  weights: Object.freeze({ playful: 1, close: 1, comfortable: 1, cautious: 1 }), intensity: Object.freeze({ expression: 50, playful: 50 }),
});

/** What the host sees right now. */
export interface CloseGates {
  /** She is out in full-screen Unbound and her window is on screen (a full-screen program never takes her off it, I-199). */
  shown: boolean;
  asleep: boolean;
  inCall: boolean;
  /** Her reply is coming out or her voice is reading. */
  speaking: boolean;
  /** Her small input box is open. */
  typing: boolean;
  /** You are pulling her now. */
  pulled: boolean;
  /** A game, an offer or her reach for your hand holds her arms. */
  armsHeld: boolean;
}
export type CloseBlock = 'not-shown' | 'asleep' | 'call' | 'speaking' | 'typing' | 'pulled';
export const CLOSE_BLOCK_WORDS: Readonly<Record<CloseBlock, string>> = Object.freeze({
  'not-shown': '她不在全屏里', asleep: '她在睡', call: '在通话', speaking: '她在说话', typing: '你在给她打字', pulled: '你在拉她',
});

/** Why nothing close may happen now, or null. The first reason. */
export function closeBlock(g: CloseGates): CloseBlock | null {
  if (!g.shown) return 'not-shown';
  if (g.asleep) return 'asleep';
  if (g.inCall) return 'call';
  if (g.speaking) return 'speaking';
  if (g.typing) return 'typing';
  if (g.pulled) return 'pulled';
  return null;
}

/** The label's own pull toward or away from closeness. */
export const LABEL_WARMTH: Readonly<Record<MoodLabel, number>> = Object.freeze({
  close: 0.25, happy: 0.15, excited: 0.12, content: 0.1, relieved: 0.08, longing: 0.12, calm: 0,
  concerned: -0.15, disappointed: -0.25, upset: -0.4, sad: -0.2, 'tense-expectation': -0.1, afraid: -0.4,
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const clamp01 = (v: number) => clamp(v, 0, 1);
const dev = (w: number) => clamp((Number.isFinite(w) ? w : 1) - 1, -1, 1.5);

/** The numbers the chooser reads, each 0..1 (exported for the record and the tests). */
export interface CloseReading { warmth: number; boldness: number; tension: number; sleepy: number; affection: number }
export function closeReading(mood: MoodReading, label: MoodLabel | null, t: CloseTemperament = NEUTRAL_TEMPERAMENT): CloseReading {
  const labelWarmth = label && Object.hasOwn(LABEL_WARMTH, label) ? LABEL_WARMTH[label] : 0;
  const warmth = clamp01(0.45 + 0.35 * (mood.O - 50) / 50 + 0.15 * (mood.E - 50) / 50 + 0.1 * (mood.D - 50) / 50 + 0.1 * Math.min(60, Math.max(0, mood.M)) / 60 + labelWarmth);
  const w = t.weights, i = t.intensity;
  const boldness = clamp01(0.5 + 0.15 * dev(w.playful) + 0.1 * dev(w.close) - 0.15 * dev(w.cautious) + 0.05 * dev(w.comfortable)
    + (clamp(i.playful, 0, 100) - 50) / 250 + (clamp(i.expression, 0, 100) - 50) / 300);
  const tense = tension(mood), sleepy = clamp01((mood.A - 0.35) / 0.35);
  const affection = warmth * (1 - 0.6 * tense) * (1 - 0.7 * sleepy);
  return { warmth, boldness, tension: tense, sleepy, affection };
}

/** Scores before any cap (not probabilities). Mood and the card only. */
export function closeScores(r: CloseReading, mood: MoodReading, t: CloseTemperament = NEUTRAL_TEMPERAMENT): Record<CloseKind, number> {
  const closeLean = clamp01(0.5 + 0.25 * dev(t.weights.close) + 0.15 * dev(t.weights.comfortable));
  const kiss = r.affection * (0.3 + 0.7 * r.boldness);
  const hug = r.affection * (0.45 + 0.35 * closeLean + 0.2 * (1 - r.boldness));
  const shy = 0.15 + 0.4 * r.tension + 0.25 * (1 - r.boldness);
  const look = 0.25 + 0.35 * curiosity(mood);
  const none = 0.08 + 0.45 * r.sleepy + 0.4 * clamp01(0.4 - r.warmth);
  return { look, kiss, hug, shy, none };
}

/** Kisses and hugs she did (the days by the caller's local day key). Memory only: a restart starts the counts and cooldowns again. */
export interface CloseRecord { kind: 'kiss' | 'hug'; via: CloseVia; at: number; day: string }
export class CloseMomentHistory {
  private readonly items: CloseRecord[] = [];
  record(item: CloseRecord): void { this.items.push({ ...item }); while (this.items.length > 64) this.items.shift(); }
  /** The last kiss or hug, any way in. */
  lastAt(): number | null { return this.items.length ? this.items[this.items.length - 1].at : null; }
  /** Today's own ones (kisses, and all). */
  ownToday(day: string): { all: number; kiss: number } {
    const own = this.items.filter(item => item.via === 'own' && item.day === day);
    return { all: own.length, kiss: own.filter(item => item.kind === 'kiss').length };
  }
  get size(): number { return this.items.length; }
}

export interface CloseChoiceInput {
  via: CloseVia;
  now: number;
  /** The local day key of `now` (shared/foundation/mood-moments.ts momentDay). */
  day: string;
  mood: MoodReading;
  label: MoodLabel | null;
  temperament?: CloseTemperament;
  gates: CloseGates;
  history: CloseMomentHistory;
  knobs?: CloseMomentKnobs;
}
export type CloseCapped = 'day' | 'kiss-day' | 'cooldown' | 'arms';
export interface CloseChances {
  /** null: something blocks it (the chances are then all for 'none' when pulled, 'look' when her own). */
  block: CloseBlock | null;
  chances: Record<CloseKind, number>;
  /** Why a kiss or a hug is out this time (caps, cooldown, held arms). */
  capped: CloseCapped[];
  reading: CloseReading;
}

/** The chances of each choice now (sum 1). */
export function closeChances(input: CloseChoiceInput): CloseChances {
  const k = input.knobs ?? CLOSE_MOMENT_KNOBS, t = input.temperament ?? NEUTRAL_TEMPERAMENT;
  const reading = closeReading(input.mood, input.label, t);
  const zero: Record<CloseKind, number> = { look: 0, kiss: 0, hug: 0, shy: 0, none: 0 };
  const block = closeBlock(input.gates);
  if (block) return { block, chances: { ...zero, [input.via === 'own' ? 'look' : 'none']: 1 }, capped: [], reading };
  const scores = closeScores(reading, input.mood, t), capped: CloseCapped[] = [];
  const last = input.history.lastAt();
  if (input.via === 'own') {
    const today = input.history.ownToday(input.day);
    if (today.all >= k.ownPerDay) capped.push('day');
    if (today.kiss >= k.ownKissPerDay) capped.push('kiss-day');
    if (last !== null && input.now >= last && input.now - last < k.cooldownMinutes * 60_000) capped.push('cooldown');
  } else if (last !== null && input.now >= last && input.now - last < k.pulledCooldownMinutes * 60_000) capped.push('cooldown');
  if (input.gates.armsHeld) capped.push('arms');
  const noKiss = capped.some(c => c === 'day' || c === 'kiss-day' || c === 'cooldown'), noHug = capped.some(c => c === 'day' || c === 'cooldown' || c === 'arms');
  const kiss = noKiss ? 0 : scores.kiss, hug = noHug ? 0 : scores.hug;
  if (input.via === 'own') {
    // Her own: the slot is a look unless this time it is a kiss or a hug (at most ownShare of the slots, by how much she wants it).
    const share = clamp01(k.ownShare);
    const pk = share * clamp01(kiss), ph = share * 0.8 * clamp01(hug), sum = pk + ph, scale = sum > share ? share / sum : 1;
    const chances = { ...zero, kiss: pk * scale, hug: ph * scale };
    chances.look = Math.max(0, 1 - chances.kiss - chances.hug);
    return { block: null, chances, capped, reading };
  }
  const raw = { look: scores.look, kiss, hug, shy: scores.shy, none: scores.none };
  const total = Object.values(raw).reduce((a, b) => a + Math.max(0, b), 0);
  const chances = total > 0 ? Object.fromEntries(CLOSE_KINDS.map(kind => [kind, Math.max(0, raw[kind]) / total])) as Record<CloseKind, number> : { ...zero, none: 1 };
  return { block: null, chances, capped, reading };
}

/** One choice from the chances with `random` in [0, 1). */
export function pickFrom<K extends string>(chances: Readonly<Record<K, number>>, order: readonly K[], random: number): K {
  const r = clamp(random, 0, 0.999999);
  let acc = 0;
  for (const kind of order) { acc += chances[kind] ?? 0; if (r < acc) return kind; }
  for (let i = order.length - 1; i >= 0; i--) if ((chances[order[i]] ?? 0) > 0) return order[i];
  return order[order.length - 1];
}

/** The choice now. Blocked: nothing close (own: the look as before; pulled: nothing). */
export function chooseCloseMoment(input: CloseChoiceInput, random: number): { kind: CloseKind } & CloseChances {
  const chances = closeChances(input);
  return { kind: pickFrom(chances.chances, CLOSE_KINDS, random), ...chances };
}
