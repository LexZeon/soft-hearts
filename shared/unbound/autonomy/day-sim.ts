/**
 * Unbound U2 experiment E2: a day with her, simulated (docs/claude/2026-11-14-unbound-night-e2-autonomy.md「一天的模拟」).
 *
 * Five synthetic 24-hour days (a happy day, a bored afternoon, up late and sleepy, a tense day, an ordinary day): her mood curve,
 * when she sleeps, when you work at the keyboard (busy), relax nearby or are away, and when either of you talks. The planner
 * (choose.ts) is asked every 5 s; an act runs for its length; the writer (writeback.ts) writes into a fake mood port
 * (fake-mood.ts), which the planner reads back — the closed loop. Deterministic for a seed. Pure: the script
 * scripts/unbound/e2-autonomy-day.ts prints the tables, the tests read the numbers.
 */
import type { MoodReading } from '../director';
import { ACTS, AUTONOMY_ACTS, AutonomyPlanner, AUTONOMY_KNOBS, drives, type AutonomyAct, type AutonomySituation } from './choose';
import { AutonomyWriter } from './writeback';
import { FakeMoodPort } from './fake-mood';

export type UserMode = 'work' | 'relax' | 'away';
export interface SyntheticDay {
  id: string;
  /** Plain words for the table. */
  label: string;
  /** Her mood (levels; A her sleep pressure) at minute-of-day m (0..1440), before anything her movement writes. */
  mood(m: number): MoodReading;
  herAsleep(m: number): boolean;
  user(m: number): UserMode;
  talk(m: number): { speaking: boolean; userTalking: boolean };
}

/** How long each act lasts in the simulation (s; the body's own lengths where it exists: hop ≈ 2.5, sway ≈ 7, stretch ≈ 4.5). */
export const ACT_SECONDS: Readonly<Record<AutonomyAct, number>> = Object.freeze({ hop: 2.5, spin: 3, dance: 20, sway: 7, stretch: 4.5, fidget: 4, wander: 15, 'show-off': 25, 'curl-up': 8 });

const hm = (h: number, m = 0) => h * 60 + m;
const bump = (m: number, center: number, width: number) => Math.exp(-0.5 * ((m - center) / width) ** 2);
/** Smooth deterministic wobble (a few slow sines), ±1. */
const wobble = (m: number, phase: number) => (Math.sin(m / 37 + phase) * 0.5 + Math.sin(m / 13.3 + 2.1 * phase) * 0.3 + Math.sin(m / 5.1 + 3.7 * phase) * 0.2);
const within = (m: number, ranges: readonly (readonly [number, number])[]) => ranges.some(([a, b]) => a <= b ? m >= a && m < b : m >= a || m < b);
/** Sleep pressure over a day: low after waking, rising through the day (faster late), falling while asleep. */
function sleepPressure(m: number, wake: number, bed: number, atBed: number): number {
  const awake = ((m - wake) % 1440 + 1440) % 1440, day = ((bed - wake) % 1440 + 1440) % 1440;
  if (awake <= day) { const u = awake / day; return 0.08 + (atBed - 0.08) * (0.55 * u + 0.45 * u * u); }
  const asleep = awake - day, night = 1440 - day;
  return 0.08 + (atBed - 0.08) * (1 - asleep / night);
}
const talkIn = (m: number, chats: readonly (readonly [number, number])[]) => {
  const chat = chats.find(([a, b]) => m >= a && m < b);
  if (!chat) return { speaking: false, userTalking: false };
  // Half a chat you are talking (waiting for her), half she is (her reply streaming and read out), turn by turn every ~40 s.
  const turn = Math.floor((m - chat[0]) * 60 / 40) % 2 === 0;
  return { speaking: !turn, userTalking: turn };
};

export const SYNTHETIC_DAYS: readonly SyntheticDay[] = [
  {
    id: 'happy', label: '开心的一天',
    mood: m => ({ D: 70 + 6 * bump(m, hm(11), 90) + 8 * bump(m, hm(20, 30), 90) + 3 * wobble(m, 0.3), O: 62 + 2 * wobble(m, 1.1), E: 58 + 6 * bump(m, hm(15), 120) + 8 * bump(m, hm(22), 90) + 2 * wobble(m, 2),
      N: 58 + 10 * bump(m, hm(11), 80) + 10 * bump(m, hm(20, 30), 70) + 3 * wobble(m, 0.9), C: 42 + 2 * wobble(m, 3), A: sleepPressure(m, hm(8), hm(24, 30), 0.72), B: 15, M: 5 }),
    herAsleep: m => within(m, [[hm(0, 30), hm(8)]]),
    user: m => within(m, [[hm(9), hm(12)], [hm(13), hm(17, 30)]]) ? 'work' : within(m, [[hm(19), hm(23, 30)]]) ? 'relax' : 'away',
    talk: m => talkIn(m, [[hm(9, 30), hm(9, 40)], [hm(12, 50), hm(13, 5)], [hm(16), hm(16, 10)], [hm(20), hm(20, 25)], [hm(22, 30), hm(22, 40)]]),
  },
  {
    id: 'bored', label: '无聊的下午',
    mood: m => ({ D: 50 + 2 * wobble(m, 0.5), O: 52 + 2 * wobble(m, 1.5), E: 50 + 2 * wobble(m, 2.5), N: 48 + 2 * wobble(m, 0.7), C: 48 + 2 * wobble(m, 1.9),
      A: sleepPressure(m, hm(8, 30), hm(24), 0.66), B: 20 + 55 * Math.min(1, Math.max(0, Math.min((m - hm(13)) / 60, (hm(18) - m) / 60))) + 15 * Math.max(0, Math.min(1, (m - hm(18)) / 60)) * (m < hm(23) ? 1 : 0) + 4 * wobble(m, 3.3), M: 10 }),
    herAsleep: m => within(m, [[hm(0), hm(8, 30)]]),
    user: m => within(m, [[hm(9), hm(12)]]) ? 'work' : within(m, [[hm(13), hm(18)], [hm(19), hm(23, 30)]]) ? 'relax' : 'away',
    talk: m => talkIn(m, [[hm(10), hm(10, 10)], [hm(14, 30), hm(14, 40)], [hm(21), hm(21, 15)]]),
  },
  {
    id: 'sleepy', label: '熬夜很困',
    mood: m => {
      const night = within(m, [[hm(22), hm(3, 30)]]);
      return { D: (night ? 52 : 56) + 2 * wobble(m, 0.2), O: 55 + 2 * wobble(m, 1.2), E: (night ? 44 : 52) + 2 * wobble(m, 2.2), N: (night ? 60 : 54) + 2 * wobble(m, 0.4), C: 52 + 2 * wobble(m, 1.4),
        A: sleepPressure(m, hm(10), hm(3, 30), 0.92), B: 25, M: 5 };
    },
    herAsleep: m => within(m, [[hm(3, 30), hm(10)]]),
    user: m => within(m, [[hm(14), hm(18)], [hm(22), hm(2)]]) ? 'work' : within(m, [[hm(11), hm(13)], [hm(20), hm(22)], [hm(2), hm(3, 20)]]) ? 'relax' : 'away',
    talk: m => talkIn(m, [[hm(12), hm(12, 10)], [hm(21), hm(21, 20)], [hm(1), hm(1, 15)]]),
  },
  {
    id: 'tense', label: '紧张的一天',
    mood: m => {
      const spike = bump(m, hm(10, 20), 18) + bump(m, hm(15, 15), 15);
      return { D: 45 + 2 * wobble(m, 0.6), O: 55 + 2 * wobble(m, 1.6), E: 42 + 2 * wobble(m, 2.6), N: 66 + 14 * spike + 2 * wobble(m, 0.8), C: 70 + 12 * spike + 2 * wobble(m, 1.8),
        A: sleepPressure(m, hm(7, 30), hm(24), 0.7), B: 10, M: 5 };
    },
    herAsleep: m => within(m, [[hm(0), hm(7, 30)]]),
    user: m => within(m, [[hm(8, 30), hm(19)]]) ? 'work' : within(m, [[hm(20), hm(23)]]) ? 'relax' : 'away',
    talk: m => talkIn(m, [[hm(10, 30), hm(10, 45)], [hm(21), hm(21, 20)]]),
  },
  {
    id: 'ordinary', label: '平常的一天',
    mood: m => ({ D: 54 + 3 * wobble(m, 0.1), O: 55 + 2 * wobble(m, 1), E: 54 + 6 * bump(m, hm(21), 100) + 2 * wobble(m, 2), N: 52 + 3 * wobble(m, 0.5), C: 50 + 2 * wobble(m, 1.5),
      A: sleepPressure(m, hm(8), hm(23, 45), 0.7), B: 30 + 15 * bump(m, hm(15), 90), M: 10 }),
    herAsleep: m => within(m, [[hm(23, 45), hm(8)]]),
    user: m => within(m, [[hm(9), hm(12)], [hm(13), hm(18)]]) ? 'work' : within(m, [[hm(19), hm(23)]]) ? 'relax' : 'away',
    talk: m => talkIn(m, [[hm(9, 15), hm(9, 25)], [hm(12, 30), hm(12, 40)], [hm(20), hm(20, 20)]]),
  },
];

/** A seeded random in [0, 1). */
export function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export interface SimAct { at: number; minute: number; act: AutonomyAct; want: number; amplitude: number; A: number; mode: UserMode; talking: boolean; idleSeconds: number; afraid: number; completed: boolean; wobble: boolean }
export interface DayResult {
  day: SyntheticDay;
  acts: SimAct[];
  counts: Record<AutonomyAct, number>;
  /** Shortest time between any two acts (min) and between two of the same act (min). */
  minGapMin: number | null;
  minSameGapMin: Partial<Record<AutonomyAct, number>>;
  /** Most acts in any 10 minutes, in any 60 minutes; most times the same act in a row. */
  max10: number; max60: number; maxRun: number;
  /** Big or excited acts while her sleep pressure was ≥ the sleepy line; any act while afraid; big acts while you were busy or someone talked. */
  bigWhileSleepy: number; whileAfraid: number; bigWhileBusyOrTalking: number;
  /** Minutes she held still because she was afraid. */
  freezeMinutes: number;
  /** What her movement wrote, summed per channel, and the most it added on top of the curve at once. */
  written: Record<'D' | 'O' | 'E' | 'N' | 'C' | 'A', number>;
  peakOffset: Record<'D' | 'O' | 'E' | 'N' | 'C' | 'A', number>;
  writes: number;
  /** Acts per waking hour of hers. */
  perWakingHour: number;
}

export const SIM_STEP_S = 5;
/** The simulated date (local midnight); the date only matters for the mood moments' day count. */
export const SIM_DAY_START = new Date(2026, 10, 14).getTime();

/** Runs one synthetic day through the planner and the writer, with the fake mood port in the loop. */
export function simulateDay(day: SyntheticDay, seed = 1, knobs = AUTONOMY_KNOBS): DayResult {
  const random = seeded(seed * 7919 + day.id.length * 104729);
  const t0 = SIM_DAY_START, minuteOf = (t: number) => (t - t0) / 60_000;
  const port = new FakeMoodPort(t => day.mood(minuteOf(t)), t0);
  const planner = new AutonomyPlanner(t0, knobs), writer = new AutonomyWriter(port);
  const acts: SimAct[] = [];
  let lastInput = t0 - 3_600_000, running: { act: SimAct; until: number } | null = null, freezeSteps = 0, wakingSteps = 0;
  for (let t = t0; t < t0 + 86_400_000; t += SIM_STEP_S * 1000) {
    const m = minuteOf(t), mode = day.user(m), talk = day.talk(m), asleep = day.herAsleep(m);
    port.advance(t); writer.advance(t);
    // Your input: at work every few seconds with the odd reading pause; relaxing, every couple of minutes; away, none. Talking means typing too.
    const chance = talk.userTalking ? 0.6 : mode === 'work' ? (Math.floor(m / 7) % 5 === 0 ? 0.02 : 0.55) : mode === 'relax' ? 0.04 : 0;
    if (random() < chance) lastInput = t;
    if (!asleep) wakingSteps++;
    const mood = port.read();
    const situation: AutonomySituation = { shown: true, fullscreen: false, asleep, inCall: false, cue: talk, idleSeconds: (t - lastInput) / 1000, mood, active: !!running };
    // A running act ends after its length; it winds down early if she gets afraid or falls asleep.
    const tick = planner.tick(t, SIM_STEP_S, situation, random);
    if (tick.freeze) freezeSteps++;
    if (running && (t >= running.until || tick.freeze || asleep)) {
      const a = running.act;
      a.completed = t >= running.until;
      writer.ended({ act: a.act, completed: a.completed, wobble: a.wobble }, t, random);
      running = null;
    }
    if (tick.decision && !running) {
      const d = tick.decision, spec = ACTS[d.act], drive = mood ? drives(mood, 0) : null;
      // Nearly losing her balance (the body measures it for the acts it plays; here a chance): more likely tired or tense, only in medium and big acts.
      const wobbleChance = spec.size === 'small' ? 0 : 0.03 + 0.15 * (drive?.sleepy ?? 0) + 0.1 * (drive?.stressed ?? 0);
      const act: SimAct = { at: t, minute: m, act: d.act, want: d.want, amplitude: d.amplitude, A: mood?.A ?? 0, mode, talking: talk.speaking || talk.userTalking, idleSeconds: (t - lastInput) / 1000, afraid: drive?.afraid ?? 0, completed: false, wobble: random() < wobbleChance };
      acts.push(act);
      writer.started(d.act, t);
      running = { act, until: t + ACT_SECONDS[d.act] * 1000 };
    }
  }
  if (running) writer.ended({ act: running.act.act, completed: false, wobble: running.act.wobble }, t0 + 86_400_000, random);
  return summarize(day, acts, port, writer.log.length, freezeSteps * SIM_STEP_S / 60, wakingSteps * SIM_STEP_S / 3600, knobs);
}

function summarize(day: SyntheticDay, acts: SimAct[], port: FakeMoodPort, writes: number, freezeMinutes: number, wakingHours: number, knobs: typeof AUTONOMY_KNOBS): DayResult {
  const counts = Object.fromEntries(AUTONOMY_ACTS.map(a => [a, 0])) as Record<AutonomyAct, number>;
  for (const a of acts) counts[a.act]++;
  let minGapMin: number | null = null;
  const minSameGapMin: Partial<Record<AutonomyAct, number>> = {}, lastOf: Partial<Record<AutonomyAct, number>> = {};
  let maxRun = acts.length ? 1 : 0, run = 1;
  acts.forEach((a, i) => {
    if (i) { const gap = (a.at - acts[i - 1].at) / 60_000; minGapMin = minGapMin === null ? gap : Math.min(minGapMin, gap); run = a.act === acts[i - 1].act ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
    const prev = lastOf[a.act];
    if (prev !== undefined) minSameGapMin[a.act] = Math.min(minSameGapMin[a.act] ?? Infinity, (a.at - prev) / 60_000);
    lastOf[a.act] = a.at;
  });
  const most = (windowMin: number) => acts.reduce((best, a, i) => Math.max(best, acts.slice(i).filter(b => b.at - a.at < windowMin * 60_000).length), 0);
  const written = { D: 0, O: 0, E: 0, N: 0, C: 0, A: 0 };
  for (const w of port.writes) for (const [k, v] of Object.entries(w.delta) as [keyof typeof written, number][]) written[k] += v;
  return {
    day, acts, counts, minGapMin, minSameGapMin, max10: most(10), max60: most(60), maxRun,
    bigWhileSleepy: acts.filter(a => a.A >= knobs.sleepyA && (ACTS[a.act].family === 'excited' || ACTS[a.act].size === 'big')).length,
    whileAfraid: acts.filter(a => a.afraid >= knobs.freezeTension).length,
    bigWhileBusyOrTalking: acts.filter(a => ACTS[a.act].size !== 'small' && (a.idleSeconds < knobs.busyIdleSeconds || a.talking)).length,
    freezeMinutes, written, peakOffset: { ...port.peak }, writes,
    perWakingHour: acts.length / Math.max(1e-9, wakingHours),
  };
}
