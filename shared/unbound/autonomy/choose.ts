/**
 * Unbound U2, layer 1: her own movement — whether she feels like moving, and what (experiment E2, 2026-11-14;
 * docs/claude/2026-11-14-unbound-night-e2-autonomy.md; design: docs/claude/2026-11-12-unbound-system-design.md
 * 「自主动作系统（连着激素和心情数值）」).
 *
 * Pure (no Electron, no Three.js, no clock of its own). Off by default: nothing in the app calls it yet; the day simulation
 * (day-sim.ts), the tests and the preview drive it.
 *
 * READ (what makes her want to move; the table in the design doc):
 *   D and N both up (excited)   → hop, spin, a little dance
 *   E up (soothed, content)     → sway, stretch
 *   B up (bored)                → fidget, wander about
 *   O up / M up (close, missing)→ show-off at the lens (the existing peek-lens: scored here, played by its own director)
 *   A up (sleepy)               → no jumping; curl up (and nothing big from A ≥ 0.7)
 *   C up (stressed)             → movements smaller, no showing off
 *   N and C both up (afraid)    → she holds still: nothing new starts, a running act winds down
 * and the situation: you busy at the keyboard, either of you talking, a call → small acts only; away → rarely; asleep, a
 * full-screen program, not shown → nothing. WRITE (what moving does to her mood) is writeback.ts.
 *
 * "Wants" are 0..1 per act; an act may start once its want is over its threshold, its own cooldown and hourly cap allow it, and
 * the shared gap since her last act has passed. Then it starts by chance (a rate that grows with how far over the line the want
 * is), so there is no fixed beat. Every number is a first pick tuned on the day simulation (see the record for the tables).
 */
import { tension, type ChatCue, type MoodReading } from '../director';

export const AUTONOMY_ACTS = ['hop', 'spin', 'dance', 'sway', 'stretch', 'fidget', 'wander', 'show-off', 'curl-up'] as const;
export type AutonomyAct = (typeof AUTONOMY_ACTS)[number];
export type ActFamily = 'excited' | 'soothing' | 'bored' | 'close' | 'sleepy';
/** small: in place, a few cm (fine while you work or talk); medium: whole body, no travel or flight; big: flight, turning, travel, or coming to the lens. */
export type ActSize = 'small' | 'medium' | 'big';
/** What layer 2 can play today (src/unbound/motion/procedural.ts); null: scored only (the body is not built yet). */
export type ActBody = 'sway' | 'stretch' | 'hop' | null;

export interface ActSpec {
  readonly family: ActFamily;
  readonly size: ActSize;
  /** How strenuous, 0..1 (writeback.ts: N while moving, E afterwards, A a little). */
  readonly exertion: number;
  /** Over this want she may start it. */
  readonly threshold: number;
  readonly cooldownMinutes: number;
  readonly perHour: number;
  readonly body: ActBody;
  /** Played by another director (show-off is the existing peek-lens with its own idle rule, cooldown and cap). */
  readonly delegated?: 'peek-lens';
  /** Its own success (a hop she landed, a dance she finished) gives a little D. */
  readonly achievement: boolean;
}

/**
 * The acts. Thresholds, cooldowns and caps after the day simulation (record「一天的模拟」): an excited day gives a handful of
 * hops and spins, a bored afternoon a few fidgets an hour, a sleepy night none of the big ones, nothing ever floods.
 */
export const ACTS: Readonly<Record<AutonomyAct, ActSpec>> = Object.freeze({
  hop: { family: 'excited', size: 'big', exertion: 0.6, threshold: 0.4, cooldownMinutes: 15, perHour: 2, body: 'hop', achievement: true },
  spin: { family: 'excited', size: 'big', exertion: 0.4, threshold: 0.45, cooldownMinutes: 20, perHour: 2, body: null, achievement: true },
  dance: { family: 'excited', size: 'big', exertion: 0.9, threshold: 0.55, cooldownMinutes: 40, perHour: 1, body: null, achievement: true },
  sway: { family: 'soothing', size: 'small', exertion: 0.1, threshold: 0.35, cooldownMinutes: 10, perHour: 3, body: 'sway', achievement: false },
  stretch: { family: 'soothing', size: 'medium', exertion: 0.25, threshold: 0.4, cooldownMinutes: 45, perHour: 1, body: 'stretch', achievement: false },
  fidget: { family: 'bored', size: 'small', exertion: 0.05, threshold: 0.35, cooldownMinutes: 8, perHour: 3, body: null, achievement: false },
  wander: { family: 'bored', size: 'big', exertion: 0.3, threshold: 0.45, cooldownMinutes: 20, perHour: 2, body: null, achievement: false },
  'show-off': { family: 'close', size: 'big', exertion: 0.2, threshold: 0.5, cooldownMinutes: 20, perHour: 2, body: null, delegated: 'peek-lens', achievement: false },
  'curl-up': { family: 'sleepy', size: 'small', exertion: 0, threshold: 0.4, cooldownMinutes: 45, perHour: 1, body: null, achievement: false },
});

export const AUTONOMY_KNOBS = Object.freeze({
  /** Any two acts at least this far apart (s), whatever they are. */
  minGapSeconds: 150,
  /** All acts together, per rolling hour. */
  perHour: 6,
  /** At a want of 1 an eligible act starts at this rate (per minute); at its threshold, at 0. */
  ratePerMinute: 0.25,
  /** You touched the keyboard or mouse within this long (s): busy, small acts only. */
  busyIdleSeconds: 20,
  /** A big act also waits until you have not touched the computer for this long (s; the peek's own idle default). */
  bigIdleSeconds: 60,
  /** No input for this long (s): you are probably away; nothing big (nobody to see it, and her mood is not stirred for no one), the rest rarer. */
  awayIdleSeconds: 900,
  awayRateFactor: 0.25,
  /** From this sleep pressure no big or excited act at all (the peek's own line, PEEK_TIMING.sleepyA). */
  sleepyA: 0.7,
  /** Afraid (tension ≥ this, i.e. N and C both about 22 levels over her baseline): she holds still. Stressed (C) from this level shows off no more. */
  freezeTension: 0.75,
  noShowOffStress: 0.5,
  /** The act she just did is wanted this much less (she does not repeat herself); never three times running. */
  repeatFactor: 0.75,
});

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/** Her mood read for movement, 0..1 each. `minutesStill`: since her last act (for the stretch after a long stillness). */
export interface Drives { excited: number; soothed: number; bored: number; close: number; sleepy: number; drowsy: number; stressed: number; afraid: number; still: number }
export function drives(mood: MoodReading, minutesStill: number): Drives {
  const afraid = tension(mood);
  return {
    // Both D and N above her baseline (the smaller one counts); fear (N with C) is not excitement.
    excited: clamp01((Math.min(mood.D, mood.N) - 52) / 22) * (1 - afraid),
    soothed: clamp01((mood.E - 52) / 22),
    bored: clamp01((mood.B - 25) / 50),
    close: clamp01(0.8 * (mood.O - 52) / 22 + 0.4 * mood.M / 100),
    sleepy: clamp01((mood.A - 0.4) / 0.3),
    // A little drowsy (around A 0.5): the yawn-and-stretch moment.
    drowsy: clamp01(1 - Math.abs(mood.A - 0.5) / 0.15),
    stressed: clamp01((mood.C - 55) / 25),
    afraid,
    still: clamp01(minutesStill / 90),
  };
}

/** Raw want per act (before the situation and the suppressions). */
export function rawWants(d: Drives): Record<AutonomyAct, number> {
  return {
    hop: 0.95 * d.excited,
    spin: 0.85 * d.excited,
    dance: 0.8 * d.excited,
    // After a long stillness a small movement comes by itself (not when sleepy): an ordinary day is not a statue.
    sway: clamp01(0.85 * d.soothed + 0.1 * d.excited + 0.45 * d.still * (1 - d.sleepy)),
    stretch: clamp01(0.5 * d.soothed + 0.35 * d.still + 0.35 * d.drowsy),
    fidget: clamp01(0.9 * d.bored + 0.45 * d.still * (1 - d.sleepy)),
    wander: clamp01(0.7 * d.bored + 0.15 * d.excited),
    'show-off': clamp01(0.7 * d.close + 0.3 * d.excited),
    'curl-up': d.sleepy,
  };
}

export type AutonomyBlock = 'not-shown' | 'fullscreen' | 'asleep' | 'afraid' | 'sleepy' | 'stressed' | 'busy' | 'talking' | 'away'
  | 'below-threshold' | 'cooldown' | 'act-hour-cap' | 'gap' | 'hour-cap' | 'repeat' | 'active' | 'no-mood' | 'delegated';
export const AUTONOMY_BLOCK_WORDS: Readonly<Record<AutonomyBlock, string>> = Object.freeze({
  'not-shown': '她不在 Unbound 里', fullscreen: '有全屏程序', asleep: '她在睡', afraid: '她害怕，定住了', sleepy: '她困了，不跳', stressed: '有压力，不显摆',
  busy: '你在忙，不做大动作', talking: '在说话，不做大动作', away: '你好像离开了', 'below-threshold': '不太想', cooldown: '冷却中', 'act-hour-cap': '这一小时这个做够了',
  gap: '刚动过', 'hour-cap': '这一小时动得够多了', repeat: '刚连着做了两次', active: '正在动', 'no-mood': '读不到她的心情', delegated: '由“凑到镜头前”自己决定',
});

/** What the host sees (the same signals the peek reads; null idle = 「知道你是不是在忙」 off). */
export interface AutonomySituation {
  shown: boolean;
  fullscreen: boolean;
  asleep: boolean;
  inCall: boolean;
  cue: ChatCue;
  idleSeconds: number | null;
  mood: MoodReading | null;
  /** An act or a peek is playing now. */
  active: boolean;
}

export interface ActDecision {
  act: AutonomyAct;
  want: number;
  /** 0.5..1: how big she makes it (stress makes it smaller). */
  amplitude: number;
  /** 0..1: how lively (excited → brisk; sleepy → slow). */
  liveliness: number;
}
export interface AutonomyTick {
  /** Starts now (the planner has recorded it). */
  decision: ActDecision | null;
  /** Afraid: no new act, and a running one should wind down (not stop dead: it goes back to rest through its springs). */
  freeze: boolean;
  wants: Record<AutonomyAct, number>;
  blocked: Partial<Record<AutonomyAct, AutonomyBlock>>;
}

/**
 * The effective wants and why each act may not start now (the situation, the suppressions, the act's own threshold and caps).
 * No clock and no randomness: the planner adds those.
 */
export function judge(s: AutonomySituation, minutesStill: number, knobs = AUTONOMY_KNOBS): { wants: Record<AutonomyAct, number>; blocked: Partial<Record<AutonomyAct, AutonomyBlock>>; freeze: boolean; amplitude: number; liveliness: number; away: boolean } {
  const zero = Object.fromEntries(AUTONOMY_ACTS.map(a => [a, 0])) as Record<AutonomyAct, number>;
  const all = (why: AutonomyBlock) => Object.fromEntries(AUTONOMY_ACTS.map(a => [a, why])) as Record<AutonomyAct, AutonomyBlock>;
  const none = { wants: zero, freeze: false, amplitude: 1, liveliness: 0.5, away: false };
  if (!s.shown) return { ...none, blocked: all('not-shown') };
  if (s.fullscreen) return { ...none, blocked: all('fullscreen') };
  if (s.asleep) return { ...none, blocked: all('asleep') };
  if (!s.mood) return { ...none, blocked: all('no-mood') };
  const d = drives(s.mood, minutesStill), raw = rawWants(d);
  if (d.afraid >= knobs.freezeTension) return { ...none, wants: raw, blocked: all('afraid'), freeze: true };
  const wants = { ...raw }, blocked: Partial<Record<AutonomyAct, AutonomyBlock>> = {};
  const busy = s.idleSeconds === null || !Number.isFinite(s.idleSeconds) || s.idleSeconds < knobs.busyIdleSeconds; // unknown counts as busy: small acts only
  const talking = s.cue.speaking || s.cue.userTalking || s.inCall;
  const away = !busy && s.idleSeconds! > knobs.awayIdleSeconds;
  for (const act of AUTONOMY_ACTS) {
    const spec = ACTS[act];
    // Sleepy: anything beyond a small act fades with sleep pressure; nothing excited or big at all from sleepyA on.
    if (spec.family === 'excited' || spec.size !== 'small') wants[act] *= 1 - d.sleepy;
    if (s.mood.A >= knobs.sleepyA && (spec.family === 'excited' || spec.size === 'big')) { blocked[act] = 'sleepy'; continue; }
    // Stressed: big acts less wanted, no showing off.
    if (spec.size === 'big') wants[act] *= 1 - 0.6 * d.stressed;
    if (act === 'show-off' && d.stressed >= knobs.noShowOffStress) { blocked[act] = 'stressed'; continue; }
    if (spec.size !== 'small' && talking) { blocked[act] = 'talking'; continue; }
    if (spec.size !== 'small' && busy) { blocked[act] = 'busy'; continue; }
    if (spec.size === 'big' && s.idleSeconds! < knobs.bigIdleSeconds) { blocked[act] = 'busy'; continue; }
    if (spec.size === 'big' && away) { blocked[act] = 'away'; continue; }
    if (wants[act] <= spec.threshold) blocked[act] = 'below-threshold';
  }
  return {
    wants, blocked, freeze: false, away,
    amplitude: Math.max(0.5, 1 - 0.5 * d.stressed),
    liveliness: clamp01(0.5 + 0.5 * d.excited - 0.5 * d.sleepy - 0.2 * d.stressed),
  };
}

/** Her acts (memory only, like PeekHistory): when each one started. */
export class ActHistory {
  private readonly times: { act: AutonomyAct; at: number }[] = [];
  record(act: AutonomyAct, at: number): void { this.times.push({ act, at }); while (this.times.length > 256) this.times.shift(); }
  last(act?: AutonomyAct): number | null {
    for (let i = this.times.length - 1; i >= 0; i--) if (!act || this.times[i].act === act) return this.times[i].at;
    return null;
  }
  /** The last `n` acts, oldest first (fewer when she has done fewer). */
  lastActs(n: number): (AutonomyAct | undefined)[] {
    const tail = this.times.slice(-n).map(t => t.act);
    return [...Array<undefined>(Math.max(0, n - tail.length)).fill(undefined), ...tail];
  }
  inLastHour(now: number, act?: AutonomyAct): number { return this.times.filter(t => (!act || t.act === act) && t.at <= now && now - t.at < 3_600_000).length; }
}

/**
 * Asked every few seconds by whoever runs her (the preview, the simulation; later the Unbound host). Returns at most one act to
 * start now and records it. `random` gives numbers in [0, 1).
 */
export class AutonomyPlanner {
  readonly history = new ActHistory();
  private readonly bornAt: number;
  constructor(now: number, private readonly knobs = AUTONOMY_KNOBS) { this.bornAt = now; }

  tick(now: number, dtSeconds: number, s: AutonomySituation, random: () => number): AutonomyTick {
    const last = this.history.last();
    const minutesStill = (now - (last ?? this.bornAt)) / 60_000;
    const j = judge(s, minutesStill, this.knobs);
    const blocked = { ...j.blocked };
    const quiet = { decision: null, freeze: j.freeze, wants: j.wants, blocked };
    if (j.freeze) return quiet;
    const gap = last !== null && now - last < this.knobs.minGapSeconds * 1000;
    const hourFull = this.history.inLastHour(now) >= this.knobs.perHour;
    const eager: { act: AutonomyAct; rate: number }[] = [];
    for (const act of AUTONOMY_ACTS) {
      if (blocked[act]) continue;
      const spec = ACTS[act];
      if (spec.delegated) { blocked[act] = 'delegated'; continue; }
      if (s.active) { blocked[act] = 'active'; continue; }
      const mine = this.history.last(act);
      if (mine !== null && now - mine < spec.cooldownMinutes * 60_000) { blocked[act] = 'cooldown'; continue; }
      if (this.history.inLastHour(now, act) >= spec.perHour) { blocked[act] = 'act-hour-cap'; continue; }
      if (gap) { blocked[act] = 'gap'; continue; }
      if (hourFull) { blocked[act] = 'hour-cap'; continue; }
      const [before, previous] = this.history.lastActs(2);
      if (before === act && previous === act) { blocked[act] = 'repeat'; continue; }
      const want = previous === act ? j.wants[act] * this.knobs.repeatFactor : j.wants[act];
      if (want <= spec.threshold) { blocked[act] = 'below-threshold'; continue; }
      const over = (want - spec.threshold) / (1 - spec.threshold);
      eager.push({ act, rate: this.knobs.ratePerMinute / 60 * over * (j.away ? this.knobs.awayRateFactor : 1) });
    }
    const total = eager.reduce((sum, e) => sum + e.rate, 0);
    if (!(total > 0) || !(dtSeconds > 0)) return quiet;
    if (clamp01(random()) >= 1 - Math.exp(-total * dtSeconds)) return quiet;
    let pick = clamp01(random()) * total, chosen = eager[eager.length - 1];
    for (const e of eager) { if (pick < e.rate) { chosen = e; break; } pick -= e.rate; }
    this.history.record(chosen.act, now);
    return { ...quiet, decision: { act: chosen.act, want: j.wants[chosen.act], amplitude: j.amplitude, liveliness: j.liveliness } };
  }
}
