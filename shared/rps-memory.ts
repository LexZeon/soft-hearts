/**
 * G1 猜拳: what stays after playing. The user's throwing habits (counts only), the habit that may grow into one of
 * "只属于你们的梗" (handed to the diary's meme field, F3 熟悉度), and the diary material line. Pure.
 * Records exist only while the user profile's "允许记录" is on (electron/rps/store.ts decides that).
 */
import { RPS_HANDS, RPS_HAND_WORDS, isRpsHand, rpsJudge, type RpsHand, type RpsOutcome } from './rps';

export interface RpsRoundRecord { her: RpsHand; user: RpsHand; outcome: RpsOutcome }
export interface RpsGameRecord {
  /** End time (ms). */
  at: number;
  /** Who started it: her invitation or the user's request in chat. */
  origin: 'her' | 'user';
  rounds: RpsRoundRecord[];
  /** Who took the match; 'none' when it was left before the end. */
  result: 'her' | 'user' | 'none';
}
export const RPS_RECORD_LIMITS = Object.freeze({ games: 60, keepMs: 30 * 24 * 3_600_000, rounds: 12 });

export function readRpsGameRecord(value: unknown): RpsGameRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.at) || (v.at as number) < 0 || (v.origin !== 'her' && v.origin !== 'user')
    || !['her', 'user', 'none'].includes(v.result as string) || !Array.isArray(v.rounds) || v.rounds.length > RPS_RECORD_LIMITS.rounds) return null;
  const rounds: RpsRoundRecord[] = [];
  for (const row of v.rounds) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const r = row as Record<string, unknown>;
    if (!isRpsHand(r.her) || !isRpsHand(r.user) || r.outcome !== rpsJudge(r.her, r.user)) return null;
    rounds.push({ her: r.her, user: r.user, outcome: r.outcome as RpsOutcome });
  }
  return { at: v.at as number, origin: v.origin, rounds, result: v.result as RpsGameRecord['result'] };
}

export type RpsHandCounts = Record<RpsHand, number>;
const zero = (): RpsHandCounts => ({ rock: 0, scissors: 0, paper: 0 });

/** A habit strong enough to say out loud ("你老是先出石头"). */
export interface RpsHabit { kind: 'first' | 'favorite'; hand: RpsHand; times: number; of: number }
export interface RpsHabits {
  games: number;
  throws: number;
  first: RpsHandCounts;
  all: RpsHandCounts;
  habit: RpsHabit | null;
}
/** Thresholds for a habit: the opening hand in ≥ 60 % of at least 4 games, or one hand in ≥ 50 % of at least 15 throws. */
export const RPS_HABIT_RULES = Object.freeze({ firstGames: 4, firstShare: 0.6, favoriteThrows: 15, favoriteShare: 0.5 });

export function rpsHabits(records: readonly RpsGameRecord[]): RpsHabits {
  const first = zero(), all = zero();
  let games = 0, throws = 0;
  for (const record of records) {
    if (!record.rounds.length) continue;
    games++; first[record.rounds[0].user]++;
    for (const round of record.rounds) { all[round.user]++; throws++; }
  }
  const top = (counts: RpsHandCounts) => RPS_HANDS.reduce((best, hand) => counts[hand] > counts[best] ? hand : best, RPS_HANDS[0]);
  let habit: RpsHabit | null = null;
  const firstTop = top(first);
  if (games >= RPS_HABIT_RULES.firstGames && first[firstTop] / games >= RPS_HABIT_RULES.firstShare)
    habit = { kind: 'first', hand: firstTop, times: first[firstTop], of: games };
  else {
    const allTop = top(all);
    if (throws >= RPS_HABIT_RULES.favoriteThrows && all[allTop] / throws >= RPS_HABIT_RULES.favoriteShare)
      habit = { kind: 'favorite', hand: allTop, times: all[allTop], of: throws };
  }
  return { games, throws, first, all, habit };
}

/**
 * What she expects the user to throw, from earlier games only (never this round's input):
 * the habit when there is one, the user's favourite after a few throws, otherwise rock (the usual opening).
 */
export function rpsExpectedHand(habits: RpsHabits | null, round: number): RpsHand {
  if (habits?.habit && (habits.habit.kind === 'favorite' || round === 1)) return habits.habit.hand;
  if (habits && habits.throws >= 6) return RPS_HANDS.reduce((best, hand) => habits.all[hand] > habits.all[best] ? hand : best, RPS_HANDS[0]);
  return 'rock';
}

/** One spoken phrase of the habit, for {手} lines and the diary. */
export function rpsHabitWords(habit: RpsHabit): string {
  return habit.kind === 'first' ? `老是先出${RPS_HAND_WORDS[habit.hand]}` : `最爱出${RPS_HAND_WORDS[habit.hand]}`;
}

/**
 * The diary material for one day (no extra call): what they played, and a habit she may keep as their own little joke
 * (the diary call's optional `meme` field). '' when they did not play that day.
 */
export function rpsDiaryLine(dayRecords: readonly RpsGameRecord[], habits: RpsHabits | null): string {
  const played = dayRecords.filter(record => record.rounds.length > 0);
  if (!played.length) return '';
  const her = played.filter(record => record.result === 'her').length, user = played.filter(record => record.result === 'user').length;
  const left = played.length - her - user;
  const parts = [`这天你和用户玩了猜拳（应用记下的）：一共 ${played.length} 场，三局两胜，你赢了 ${her} 场、用户赢了 ${user} 场${left ? `、${left} 场没玩完` : ''}。写日记时用你自己的口吻记一句你们玩了什么，不必写比分。`];
  if (habits?.habit) parts.push(`另外，用户的出拳习惯：${rpsHabitWords(habits.habit)}（${habits.habit.kind === 'first' ? `最近 ${habits.habit.of} 场里先出它 ${habits.habit.times} 次` : `${habits.habit.of} 次出拳里 ${habits.habit.times} 次`}）。如果你觉得它已经是只属于你们的小梗，可以写进 meme；不想写就不写。`);
  return parts.join('');
}
