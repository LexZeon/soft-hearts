/**
 * Unbound U2, layer 1 (choreography): what she decides to do, when, and how (docs/claude/2026-11-12-unbound-peek.md;
 * design: docs/claude/2026-11-12-unbound-system-design.md「动作系统的结构」「心情怎么读、怎么写」; idea I-104).
 *
 * Pure: no Electron, no Three.js. The host (electron/unbound/peek.ts) asks `peekReadiness` once a second and plans a peek with
 * `planPeek` from her mood; the Unbound page (src/unbound/director/) plays the plan live, beat by beat, from her actual body.
 *
 * The only action so far is `peek-lens` (her eye comes right up to the lens). The director is written as a list of actions so the
 * next ones (a hop, a small dance, look-at-you-smile-look-away) plug in as more choices with their own readiness and plan.
 *
 * Tuning: every number below is a first pick, read from the user's words and judged in the preview. Codex T-246a (生动规则手册)
 * will hand timing rules; they replace the values in PEEK_TIMING / planPeek's curves, nothing else has to change.
 */

import { arrivalHoldS } from './arrival'; // I-192: the peek's hold, her own length
import type { CloseMomentPlan } from './close-moments/plan';

export const DIRECTOR_ACTIONS = ['peek-lens', 'close-moment'] as const; // I-184: a kiss, a hug or shying back (close-moments/plan.ts)
export type DirectorActionId = (typeof DIRECTOR_ACTIONS)[number];

/**
 * Her mood, read for movement. D/O/E/N/C are levels 0..100 relative to the card's baseline (shared/foundation/mood.ts moodLevel: 50 = at her
 * baseline); A is her sleep pressure 0..1 (shared/mood/fatigue.ts); B boredom and M longing 0..100 (the mood snapshot's own scales).
 */
export interface MoodReading { D: number; O: number; E: number; N: number; C: number; A: number; B: number; M: number }
export const NEUTRAL_MOOD: Readonly<MoodReading> = Object.freeze({ D: 50, O: 50, E: 50, N: 50, C: 50, A: 0.2, B: 0, M: 0 });

/**
 * Live cues from the chat side (in Unbound, choreography and chat run at the same time). For now they only keep a
 * peek from starting while she speaks or you are talking to her, and make her back off when a reply starts mid-peek. Later
 * chat-driven choreography reads `replyMood` and `beats` (emphasis times within her reply, seconds) from the same input.
 */
export interface ChatCue {
  /** Her reply is streaming or still being read out. */
  speaking: boolean;
  /** You sent something and are waiting for her, or a voice call is on. */
  userTalking: boolean;
  /** Her reply's mood label, when known (closed words from the mood model; unused yet). */
  replyMood?: string | null;
  /** Emphasis / beat times within her current reply (seconds from its start; unused yet). */
  beats?: readonly number[];
  /** The reply these cues belong to (its bubble id), when known (E3: the opening beat holds that reply's bubble). */
  replyId?: string | null;
}
export const QUIET_CUE: Readonly<ChatCue> = Object.freeze({ speaking: false, userTalking: false });

/** The situation the host sees once a second. */
export interface PeekSituation {
  /** She is in Unbound and on screen (a full-screen program never takes her off it, I-199). */
  shown: boolean;
  /** A full-screen program is in front: her own peek waits (autonomous only; a trial or a pull near is never held by it). */
  fullscreen: boolean;
  /** Seconds since your last keyboard or mouse input; null when not known (「知道你是不是在忙」 off, locked, asleep). */
  idleSeconds: number | null;
  /** She is asleep (her sleep phase or her inner loop). */
  asleep: boolean;
  /** A voice call is on. */
  inCall: boolean;
  cue: ChatCue;
  mood: MoodReading | null;
  /** A peek is playing now. */
  active: boolean;
}

/** The user's knobs (developer panel); ranges below. Defaults follow the task: idle about a minute, at most two an hour, 20 min apart. */
export interface PeekKnobs {
  /** You have not touched the computer for this long (s). */
  idleSeconds: number;
  /** Not after this long either: you are probably away, and nobody would see her. */
  maxIdleSeconds: number;
  cooldownMinutes: number;
  perHour: number;
  /** The lens softness during the extreme close-up (0 = none, 1 = the most). */
  softness: number;
}
export const PEEK_KNOB_DEFAULTS: Readonly<PeekKnobs> = Object.freeze({ idleSeconds: 60, maxIdleSeconds: 900, cooldownMinutes: 20, perHour: 2, softness: 0.35 });
export const PEEK_KNOB_RANGES = Object.freeze({
  idleSeconds: Object.freeze([20, 600] as const), cooldownMinutes: Object.freeze([1, 240] as const),
  perHour: Object.freeze([1, 6] as const), softness: Object.freeze([0, 1] as const),
});

/** Fixed rules (not user knobs). T-246a hook: timing rules from Codex's 生动规则手册 land here and in planPeek. */
export const PEEK_TIMING = Object.freeze({
  /** A reply's tail counts as "still speaking" for this long after it is done (the bubble and the reading). */
  speakingTailMs: 6_000,
  /** Sleepy: from this sleep pressure on she does not peek at all. */
  sleepyA: 0.7,
  /** You answered her: within this long after the peek ended (talk to her, click her). */
  responseWindowMs: 25_000,
  /** Once she may peek, she waits a little before she does (s): (1 − want) × spread + random × jitter. */
  waitSpread: 40, waitJitter: 20,
  /** Below this want she lets it go this time (asked again on the next tick). */
  minWant: 0.15,
  /** The host's own safety: a peek that never reports its end is over after this long (ms). */
  maxPeekMs: 60_000,
  /** A trial from the developer panel: mouse moves in the first moment (taking the hand off the mouse) do not cancel it. */
  trialArmMs: 1_500,
});

export type PeekBlock = 'not-shown' | 'fullscreen' | 'idle-unknown' | 'not-idle' | 'away' | 'asleep' | 'sleepy' | 'call' | 'speaking'
  | 'user-talking' | 'active' | 'cooldown' | 'hour-cap' | 'no-mood';
/** Plain words for the developer panel. */
export const PEEK_BLOCK_WORDS: Readonly<Record<PeekBlock, string>> = Object.freeze({
  'not-shown': '她不在 Unbound 里', fullscreen: '有全屏程序', 'idle-unknown': '不知道你在不在用电脑（“知道你是不是在忙”关着）', 'not-idle': '你在用电脑',
  away: '你好像离开了', asleep: '她在睡', sleepy: '她困了', call: '在通话', speaking: '她在说话', 'user-talking': '你在和她说话',
  active: '正在凑过来', cooldown: '冷却中', 'hour-cap': '这一小时次数到了', 'no-mood': '读不到她的心情',
});

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const clamp01 = (v: number) => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

/** Peeks she did (automatic ones only: trials from the developer panel do not count). Memory only. */
export class PeekHistory {
  private readonly times: number[] = [];
  record(now: number): void { this.times.push(now); while (this.times.length > 32) this.times.shift(); }
  last(): number | null { return this.times.length ? this.times[this.times.length - 1] : null; }
  inLastHour(now: number): number { return this.times.filter(t => t <= now && now - t < 3_600_000).length; }
}

/** Whether a peek may start now (automatic); the first reason it may not otherwise. */
export function peekReadiness(s: PeekSituation, history: PeekHistory, now: number, knobs: PeekKnobs = PEEK_KNOB_DEFAULTS): { ok: true } | { ok: false; why: PeekBlock } {
  const no = (why: PeekBlock) => ({ ok: false as const, why });
  if (!s.shown) return no('not-shown');
  if (s.fullscreen) return no('fullscreen');
  if (s.active) return no('active');
  if (s.asleep) return no('asleep');
  if (s.inCall) return no('call');
  if (s.cue.speaking) return no('speaking');
  if (s.cue.userTalking) return no('user-talking');
  if (s.idleSeconds === null || !Number.isFinite(s.idleSeconds)) return no('idle-unknown');
  if (s.idleSeconds < knobs.idleSeconds) return no('not-idle');
  if (s.idleSeconds > knobs.maxIdleSeconds) return no('away');
  if (!s.mood) return no('no-mood');
  if (s.mood.A >= PEEK_TIMING.sleepyA) return no('sleepy');
  const last = history.last();
  if (last !== null && now >= last && now - last < knobs.cooldownMinutes * 60_000) return no('cooldown');
  if (history.inLastHour(now) >= knobs.perHour) return no('hour-cap');
  return { ok: true };
}

/** How much she wants to come and look (0..1): curious, close, bored or missing you → more; sleepy or tense → less. */
export function peekWant(mood: MoodReading): number {
  const curious = (mood.D - 50) / 50, close = (mood.O - 50) / 50, bored = mood.B / 100, missing = mood.M / 100;
  const sleepy = clamp01((mood.A - 0.35) / 0.35), tense = tension(mood);
  return clamp01(0.5 + 0.3 * curious + 0.2 * close + 0.2 * bored + 0.2 * missing - 0.45 * sleepy - 0.3 * tense);
}
/** N and C both above her baseline (afraid / tense), 0..1. */
export function tension(mood: MoodReading): number { return clamp01((Math.min(mood.N, mood.C) - 50) / 30); }
export function curiosity(mood: MoodReading): number { return clamp01(0.5 + (mood.D - 50) / 70 + (mood.B - 30) / 200 + (mood.O - 50) / 200); }

/** Seconds she waits once she may peek (so it does not land on the exact second the idle knob is reached). */
export function peekWait(mood: MoodReading, random: number): number {
  return (1 - peekWant(mood)) * PEEK_TIMING.waitSpread + clamp01(random) * PEEK_TIMING.waitJitter;
}

/** One peek, planned live from her mood (every field a knob the page reads; the page decides the rest from her body). */
export interface PeekPlan {
  action: 'peek-lens';
  /** 0..1, for the developer view. */
  curiosity: number;
  tension: number;
  /** Lens to the surface of the chosen eye at the closest (m): a few cm, closer when more curious (the page adds the model's own bone-to-surface depth). */
  eyeDistanceM: number;
  /** How much of the screen's height her iris takes at the closest (about 0.5: the whole eye, lids and lashes, fills the screen; judged from the preview's screenshots): the page turns it into a distance from the model's own eye size; eyeDistanceM is the fallback when that is unknown. */
  eyeFill: number;
  holdS: number;
  /** The lean-in (s, from where she stands to the closest). */
  approachS: number;
  /** Tense: she stops part-way for this long before coming the rest of the way (s; 0 = no pause). */
  hesitateS: number;
  /** Forward lean of her upper body at the closest (rad). */
  leanRad: number;
  /** A curious head tilt (rad, + = toward her left shoulder). */
  tiltRad: number;
  walkSpeedMps: number;
  /** The noticing moment before she sets off (s). */
  noticeS: number;
  /** Blink every this many seconds while holding (a curious stare blinks less). */
  blinkEveryS: number;
  /** Eye saccade size while holding (rad). */
  saccadeRad: number;
  /** The after-smile (0..1). */
  smile: number;
  /** Bring the other eye this time (the page otherwise brings the eye nearer the lens centre). */
  otherEye: boolean;
  /** Codex T-246a (P, proposals): before her eyes start toward the lens (s, 0.12–0.32). */
  orientDelayS: number;
  /** T-246a P04: after she has arrived and stands steady, a moment before leaning in (s, 0.2–0.5), and the small preparation (s, 0.15–0.3). */
  arrivePauseS: number;
  prepareS: number;
  /** T-246a: the after-smile's onset once she backs off (s, 0.18–0.42) and its after-glow (s, 1.2–3.0). */
  smileDelayS: number;
  afterglowS: number;
  /** 0..1 random, for the page's own small choices (blink times, saccades). */
  seed: number;
}

/**
 * Codex T-246a: variation only at segment boundaries, drawn once per peek, without replacement and never the same template three
 * times running. A bag per choice (memory only, on the host).
 */
export class VariationBag<T> {
  private bag: T[] = [];
  private readonly recent: T[] = [];
  constructor(private readonly items: readonly T[]) {}
  draw(random: () => number): T {
    if (!this.bag.length) this.bag = [...this.items];
    // Never the same as the last two when they agree (no third time running), if the bag has anything else.
    const avoid = this.recent.length === 2 && this.recent[0] === this.recent[1] ? this.recent[0] : undefined;
    const candidates = this.bag.map((item, i) => [item, i] as const).filter(([item]) => item !== avoid);
    const pool = candidates.length ? candidates : this.bag.map((item, i) => [item, i] as const);
    const [item, index] = pool[Math.min(pool.length - 1, Math.floor(clamp01(random()) * pool.length))];
    this.bag.splice(index, 1);
    this.recent.push(item); if (this.recent.length > 2) this.recent.shift();
    return item;
  }
}
/** The per-peek templates: which side she tilts her head, whether it is the other eye this time, how long she holds (short / mid / long). */
export class PeekVariation {
  readonly tilt = new VariationBag<1 | -1>([1, -1]);
  readonly otherEye = new VariationBag<boolean>([false, false, false, false, true]);
  readonly hold = new VariationBag<0 | 1 | 2>([0, 1, 2]);
}

/** Plans one peek from her mood; `random` gives numbers in [0, 1); `variation` keeps the templates from repeating (host memory). */
export function planPeek(mood: MoodReading, random: () => number, variation: PeekVariation = new PeekVariation()): PeekPlan {
  const c = curiosity(mood), t = tension(mood), s = clamp01((mood.A - 0.3) / 0.4), r = () => clamp01(random());
  const tilt = variation.tilt.draw(r) * lerp(3, 9, c) * Math.PI / 180;
  const holdTier = variation.hold.draw(r);
  return {
    action: 'peek-lens', curiosity: c, tension: t,
    eyeDistanceM: clamp(lerp(0.14, 0.09, c) + 0.03 * t, 0.06, 0.2),
    eyeFill: clamp(lerp(0.42, 0.6, c) - 0.12 * t, 0.3, 0.75),
    // I-192: her own hold, as long as she decides (curious and warm: longer; tense: shorter), within the cap
    holdS: arrivalHoldS('look', { warmth: clamp01(0.5 + (mood.O - 50) / 100), boldness: c, tension: t }, clamp01((holdTier + r()) / 3)),
    approachS: clamp(lerp(2.4, 1.5, c) + 0.8 * t + 0.6 * s, 1.2, 3.5),
    hesitateS: t > 0.15 ? clamp(0.35 + 0.7 * t, 0, 1.1) : 0,
    leanRad: clamp(lerp(8, 18, c) - 6 * t, 4, 20) * Math.PI / 180,
    tiltRad: tilt * (1 - 0.5 * t),
    walkSpeedMps: clamp(lerp(0.6, 0.8, c) - 0.1 * s, 0.5, 0.8),
    noticeS: clamp(lerp(0.9, 0.45, c) + 0.4 * t, 0.35, 1.4),
    blinkEveryS: clamp(lerp(1.8, 3.0, c) - 0.6 * t, 1.2, 3.2),
    saccadeRad: lerp(1.2, 2.4, c) * Math.PI / 180,
    smile: clamp(0.35 + 0.3 * (mood.O - 50) / 50 + 0.2 * (mood.E - 50) / 50, 0.15, 0.7),
    otherEye: variation.otherEye.draw(r),
    orientDelayS: clamp(lerp(0.26, 0.14, c) + 0.06 * s + 0.04 * r(), 0.12, 0.32),
    arrivePauseS: clamp(lerp(0.45, 0.22, c) + 0.05 * r(), 0.2, 0.5),
    prepareS: clamp(0.15 + 0.1 * t + 0.05 * r(), 0.15, 0.3),
    smileDelayS: clamp(0.18 + 0.16 * (1 - (mood.O - 30) / 40) + 0.08 * r(), 0.18, 0.42),
    afterglowS: clamp(1.2 + 1.8 * clamp01((mood.O - 40) / 40), 1.2, 3.0),
    seed: r(),
  };
}

/** Plain bounds on a plan that crossed IPC (the page trusts nothing it did not compute itself). */
export function parsePeekPlan(value: unknown): PeekPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const n = (key: string, lo: number, hi: number) => typeof v[key] === 'number' && Number.isFinite(v[key]) && (v[key] as number) >= lo && (v[key] as number) <= hi;
  if (v.action !== 'peek-lens') return null;
  const ok = n('curiosity', 0, 1) && n('tension', 0, 1) && n('eyeDistanceM', 0.03, 0.25) && n('eyeFill', 0.1, 2) && n('holdS', 0.5, 30) && n('approachS', 0.5, 5)
    && n('hesitateS', 0, 2) && n('leanRad', 0, 0.5) && n('tiltRad', -0.3, 0.3) && n('walkSpeedMps', 0.3, 1.4) && n('noticeS', 0.1, 2)
    && n('blinkEveryS', 0.5, 5) && n('saccadeRad', 0, 0.1) && n('smile', 0, 1) && typeof v.otherEye === 'boolean' && n('orientDelayS', 0, 1)
    && n('arrivePauseS', 0, 1) && n('prepareS', 0, 1) && n('smileDelayS', 0, 1) && n('afterglowS', 0, 5) && n('seed', 0, 1);
  if (!ok) return null;
  const keys = ['action', 'curiosity', 'tension', 'eyeDistanceM', 'eyeFill', 'holdS', 'approachS', 'hesitateS', 'leanRad', 'tiltRad', 'walkSpeedMps', 'noticeS', 'blinkEveryS', 'saccadeRad', 'smile',
    'otherEye', 'orientDelayS', 'arrivePauseS', 'prepareS', 'smileDelayS', 'afterglowS', 'seed'];
  return Object.fromEntries(keys.map(key => [key, v[key]])) as unknown as PeekPlan;
}

/** What the director plays: the peek, or one of I-184's close moments. */
export type DirectorPlan = PeekPlan | CloseMomentPlan;

// ---- host ↔ page --------------------------------------------------------------------------------------------------------------

/**
 * 'fullscreen' is no longer sent (I-199: a full-screen program never ends a peek); kept so the page and old reports still parse. 'pull': you pulled
 * her away with a large pull (2026-11-23, shared/unbound/action-ends); 'play': a game took her (a new action of hers). 'unreached' (T-264): the
 * kiss or hug's arrival wait ran out with her face not in the window (eyes and mouth), so she backed off and it did not happen.
 */
export const PEEK_CANCEL_REASONS = ['input', 'reply', 'fullscreen', 'timeout', 'pull', 'play', 'unreached'] as const;
export type PeekCancelReason = (typeof PEEK_CANCEL_REASONS)[number];
/** Host → page. */
export type PeekCommand =
  | { type: 'start'; id: string; plan: DirectorPlan; trial: boolean; armAfterMs: number }
  | { type: 'cancel'; id: string; reason: PeekCancelReason }
  /** I-203: her reply reached a frame of the kiss / hug playing now: ⟦let-go⟧, or ⟦pause⟧ (`seconds`: she holds through it). */
  | { type: 'frame'; id: string; frame: 'let-go' | 'pause'; seconds: number };

/** Host → page, the commands other than 'start' (the page parses 'start' with its plan itself): only these shapes, bounded. */
export function parsePeekSideCommand(value: unknown): Exclude<PeekCommand, { type: 'start' }> | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(v.id)) return null;
  if (v.type === 'cancel') return typeof v.reason === 'string' && (PEEK_CANCEL_REASONS as readonly string[]).includes(v.reason) ? { type: 'cancel', id: v.id, reason: v.reason as PeekCancelReason } : null;
  if (v.type !== 'frame' || (v.frame !== 'let-go' && v.frame !== 'pause')) return null;
  const seconds = typeof v.seconds === 'number' && Number.isFinite(v.seconds) ? Math.min(12, Math.max(0, v.seconds)) : 0;
  return { type: 'frame', id: v.id, frame: v.frame, seconds };
}
/** The beats of peek-lens, in order. */
export const PEEK_PHASES = ['notice', 'walk', 'lean', 'hold', 'back', 'settle', 'done'] as const;
export type PeekPhase = (typeof PEEK_PHASES)[number];
/** Page → host: where the peek is now; `clicked`: you clicked her (only while it is not click-through); `cancelled`: why it backed off. */
/**
 * I-192 follow-up (Codex T-261): `arms` — whether the engine can move her arms on this model at all; false: a hug she did is recorded with
 * its arms still (the face came, the arms did not move).
 */
export interface PeekReport { id: string; phase: PeekPhase; cancelled?: PeekCancelReason | null; clicked?: boolean; arms?: boolean }

export function parsePeekReport(value: unknown): PeekReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['id', 'phase', 'cancelled', 'clicked', 'arms'].includes(key))) return null;
  if (v.arms !== undefined && typeof v.arms !== 'boolean') return null;
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(v.id)) return null;
  if (typeof v.phase !== 'string' || !(PEEK_PHASES as readonly string[]).includes(v.phase)) return null;
  if (v.cancelled !== undefined && v.cancelled !== null && !(typeof v.cancelled === 'string' && (PEEK_CANCEL_REASONS as readonly string[]).includes(v.cancelled))) return null;
  if (v.clicked !== undefined && typeof v.clicked !== 'boolean') return null;
  return { id: v.id, phase: v.phase as PeekPhase, ...(v.cancelled ? { cancelled: v.cancelled as PeekCancelReason } : {}), ...(v.clicked ? { clicked: true } : {}),
    ...(typeof v.arms === 'boolean' ? { arms: v.arms } : {}) };
}

/** Developer view of the director. */
export interface PeekView {
  knobs: PeekKnobs;
  phase: PeekPhase | null;
  trial: boolean;
  /** Why she would not peek right now (plain words), or null when she may. */
  blocked: string | null;
  lastAt: number | null;
  inLastHour: number;
  /** The last peek's outcome, for the panel. */
  last: { cancelled: PeekCancelReason | null; answered: boolean } | null;
}
