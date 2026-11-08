/**
 * I-010 互动余额的纯规则（接口见 interface.ts，旋钮见 knobs.ts）。没有时钟、没有文件：时间都由调用方给。
 *
 * 状态 = 攒下的（earned，按半衰期少）+ 保底（floor，慢慢长回到上限）。保底只付"看你一眼、说一句"那几件（knobs.floor.pays），
 * 小情绪、猜拳里的话、停停说说只能用你最近的互动攒下的。
 *  - 记分：同一个编号只记一次（seen）；晚到的按"它真正发生到现在"衰减后再记，所以永远不比准时到多；时钟往回走时什么都不涨。
 *  - 余地：余额够这一件就是 1；不够时按 smoothstep(余额 / 花费) 平滑往下压；强烈的心情按 strong 越过压低。
 *  - 花：先花攒下的，再花保底，不会花成负数；同一个编号只花一次。退回：每一笔只退一次，原样退回它从哪里花的。
 */
import type { MoodTendency } from '../../mood';
import { INTERACTION_BUDGET_KNOBS, type BudgetCreditKind, type BudgetSpendKind, type InteractionBudgetKnobs } from './knobs';
import type { BudgetAsk, BudgetLogEntry, BudgetRoom } from './interface';

const HOUR = 3_600_000;
const SEEN_KEEP = 512;
const SPENDS_KEEP = 64;
/** Interaction times are kept this long (the longest "since" anyone asks about is an invitation a few hours back). */
const INTERACTIONS_KEEP_MS = 48 * HOUR;
const INTERACTIONS_KEEP = 2_000;

export interface BudgetSpendRecord { readonly id: string; readonly kind: BudgetSpendKind; readonly at: number; readonly earned: number; readonly floor: number; refunded: boolean }
export interface BudgetState {
  /** When the pools were last brought up to date. */
  at: number;
  earned: number;
  floor: number;
  /** When this state began (this run of the app): "interactions since" never counts before it. */
  readonly startedAt: number;
  /** Ids already credited or spent (credit:… and spend:…), oldest first. */
  seen: string[];
  spends: BudgetSpendRecord[];
  /** When each counted interaction happened, oldest first. */
  interactions: number[];
  /** The developer panel's last few changes, newest first. */
  log: BudgetLogEntry[];
}

const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const smooth01 = (value: number) => { const t = clamp(finite(value, 0), 0, 1); return t * t * (3 - 2 * t); };
const round2 = (value: number) => Math.round(value * 100) / 100;

/** A new state: nothing earned, the floor full (a fresh start is as quiet as a long absence, never quieter than before I-010). */
export function createBudget(now: number, knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): BudgetState {
  const at = finite(now, 0);
  return { at, earned: 0, floor: Math.max(0, knobs.floor.max), startedAt: at, seen: [], spends: [], interactions: [], log: [] };
}

/** The pools as they are at `now` (a copy; a clock that went back changes nothing). */
export function settleBudget(state: Readonly<BudgetState>, now: number, knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): BudgetState {
  const next: BudgetState = { ...state, seen: state.seen, spends: state.spends, interactions: state.interactions, log: state.log };
  const t = finite(now, state.at);
  if (!(t > state.at)) return next;
  const dt = t - state.at;
  next.earned = state.earned * Math.pow(0.5, dt / (Math.max(0.01, knobs.halfLifeHours) * HOUR));
  if (next.earned < 1e-6) next.earned = 0;
  next.floor = Math.min(Math.max(0, knobs.floor.max), state.floor + Math.max(0, knobs.floor.perHour) * dt / HOUR);
  next.at = t;
  return next;
}

/** The floor pays only for "look at you once, say one thing" (the plan); the rest is paid from recent interaction only. */
export function floorPays(kind: BudgetSpendKind, knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): boolean {
  return Array.isArray(knobs.floor.pays) && knobs.floor.pays.includes(kind);
}

/** The character's cost multiplier from the card's tendencies (1 = an ordinary card). */
export function budgetScale(weights: Readonly<Partial<Record<MoodTendency, number>>> | null | undefined, knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): number {
  const w = (name: MoodTendency) => clamp(finite(weights?.[name], 1), 0, 3) - 1;
  const c = knobs.character;
  return clamp(1 + c.close * w('close') + c.playful * w('playful') + c.cautious * w('cautious'), c.min, c.max);
}

/** What one `kind` costs now. */
export function budgetCost(kind: BudgetSpendKind, scale: number, night: boolean, knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): number {
  return Math.max(0, finite(knobs.costs[kind], 1)) * clamp(finite(scale, 1), 0.1, 10) * (night ? Math.max(1, knobs.nightCost) : 1);
}

/** How strong her want is now (0..1): the asked number, or the mood's from the knobs, whichever is larger. */
export function budgetWant(ask: BudgetAsk | undefined, knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): number {
  const fromMood = typeof ask?.mood === 'string' ? finite((knobs.strong.moods as Record<string, number | undefined>)[ask.mood], 0) : 0;
  return clamp(Math.max(fromMood, finite(ask?.want, 0)), 0, 1);
}

/** Room for `kind` at `now`. Changes nothing. */
export function budgetRoom(state: Readonly<BudgetState>, kind: BudgetSpendKind, now: number, input: { scale: number; night: boolean; ask?: BudgetAsk },
  knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): BudgetRoom {
  const settled = settleBudget(state, now, knobs), balance = settled.earned + (floorPays(kind, knobs) ? settled.floor : 0);
  const cost = budgetCost(kind, input.scale, input.night, knobs);
  const soft = cost <= 0 ? 1 : smooth01(balance / cost);
  const k = knobs.strong, over = smooth01((budgetWant(input.ask, knobs) - k.from) / Math.max(1e-6, k.full - k.from));
  const strong = soft < 1 && over > 0;
  const share = knobs.share[kind];
  const shared = share === undefined ? 1 : clamp(1 / Math.max(1, finite(input.scale, 1)), clamp(share, 0, 1), 1);
  const factor = clamp((soft + (1 - soft) * over) * shared, 0, 1);
  const words = `余额 ${round2(balance)}${floorPays(kind, knobs) ? '' : '（不算保底）'}，${knobs.labels[kind]}要 ${round2(cost)}${input.night ? '（深夜加倍）' : ''}`
    + (soft >= 1 ? '：够' : strong ? `：不太够，但心情强烈（机会 ${round2(factor)}）` : `：不太够（机会 ${round2(factor)}）`)
    + (shared < 1 ? `；性格安静，这件只有 ${round2(shared)} 的机会` : '');
  return { factor, balance: round2(balance), cost: round2(cost), strong, words };
}

const noteSeen = (state: BudgetState, id: string) => { state.seen = [...state.seen, id].slice(-SEEN_KEEP); };
const noteLog = (state: BudgetState, entry: BudgetLogEntry, knobs: InteractionBudgetKnobs) => { state.log = [entry, ...state.log].slice(0, Math.max(1, knobs.keepLog)); };

/**
 * One real interaction. Counted once per id; `at` later than `now` counts as now, earlier is decayed for the time since (a late
 * event never adds more than it would have on time).
 */
export function creditBudget(state: Readonly<BudgetState>, input: { kind: BudgetCreditKind; id: string; at?: number }, now: number,
  knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): { state: BudgetState; counted: boolean } {
  const key = `credit:${input.id}`;
  if (typeof input.id !== 'string' || !input.id || state.seen.includes(key)) return { state: state as BudgetState, counted: false };
  const next = settleBudget(state, now, knobs), at = Math.min(next.at, finite(input.at, next.at));
  const gain = Math.max(0, finite(knobs.gains[input.kind], 0)) * Math.pow(0.5, Math.max(0, next.at - at) / (Math.max(0.01, knobs.halfLifeHours) * HOUR));
  next.earned = Math.min(Math.max(0, knobs.earnedMax), next.earned + gain);
  noteSeen(next, key);
  // Interactions before this run began are not "since" anything this state can see.
  if (at >= next.startedAt) {
    const cutoff = next.at - INTERACTIONS_KEEP_MS;
    next.interactions = [...next.interactions.filter(t => t >= cutoff), at].sort((a, b) => a - b).slice(-INTERACTIONS_KEEP);
  }
  noteLog(next, { at, kind: input.kind, delta: round2(gain) }, knobs);
  return { state: next, counted: true };
}

/** She did `kind` (once per id): from the earned pool first, then the floor; never below zero. */
export function spendBudget(state: Readonly<BudgetState>, input: { kind: BudgetSpendKind; id: string; scale: number; night: boolean }, now: number,
  knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): { state: BudgetState; spent: boolean } {
  const key = `spend:${input.id}`;
  if (typeof input.id !== 'string' || !input.id || state.seen.includes(key)) return { state: state as BudgetState, spent: false };
  const next = settleBudget(state, now, knobs), cost = budgetCost(input.kind, input.scale, input.night, knobs);
  const fromEarned = Math.min(next.earned, cost), fromFloor = floorPays(input.kind, knobs) ? Math.min(next.floor, cost - fromEarned) : 0;
  next.earned -= fromEarned; next.floor -= fromFloor;
  noteSeen(next, key);
  next.spends = [...next.spends, { id: input.id, kind: input.kind, at: next.at, earned: fromEarned, floor: fromFloor, refunded: false }].slice(-SPENDS_KEEP);
  noteLog(next, { at: next.at, kind: input.kind, delta: -round2(fromEarned + fromFloor) }, knobs);
  return { state: next, spent: true };
}

/** That spend came to nothing (she did not say it): what it took goes back where it came from, once. */
export function refundBudget(state: Readonly<BudgetState>, id: string, now: number, knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): { state: BudgetState; refunded: boolean } {
  const index = state.spends.findIndex(spend => spend.id === id && !spend.refunded);
  if (index < 0) return { state: state as BudgetState, refunded: false };
  const next = settleBudget(state, now, knobs), spend = next.spends[index];
  next.spends = next.spends.map((item, i) => i === index ? { ...item, refunded: true } : item);
  next.earned = Math.min(Math.max(0, knobs.earnedMax), next.earned + spend.earned);
  next.floor = Math.min(Math.max(0, knobs.floor.max), next.floor + spend.floor);
  // The panel shows the original line as given back (the time it was spent stays).
  next.log = next.log.map(entry => entry.at === spend.at && entry.kind === spend.kind && entry.delta < 0 && !entry.refunded ? { ...entry, refunded: true } : entry);
  return { state: next, refunded: true };
}

/** Counted interactions strictly after `at` (only those of this state's run: before it, nothing is known, so nothing counts). */
export function interactionsSince(state: Readonly<BudgetState>, at: number): number {
  const from = finite(at, -Infinity);
  return state.interactions.filter(t => t > from).length;
}

/** How many interactions after an invitation (or a game) before she may invite again, by the card. */
export function budgetAgainAfter(after: 'invite' | 'game', weights: Readonly<Partial<Record<MoodTendency, number>>> | null | undefined,
  knobs: InteractionBudgetKnobs = INTERACTION_BUDGET_KNOBS): number {
  const a = knobs.again, w = (name: MoodTendency) => clamp(finite(weights?.[name], 1), 0, 3) - 1;
  return Math.round(clamp(a[after] + a.playful * w('playful') + a.cautious * w('cautious'), a.min, a.max));
}
