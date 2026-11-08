/**
 * P1 第二阶段：她对本地姿态信号的反应 (contagion "偏低，按性格浮动").
 *
 * Three layers, all from the abstract signals of shared/pose-signals.ts (never a frame, never a coordinate):
 *  1. at once, local, no model: her eyes are drawn to the user while the user faces the screen (the R18 "look at you" moments,
 *     more often); she sometimes catches a yawn, a stretch or a wave from the user after a short delay; every one of them
 *     gives way to chat, a touch, feeding, music (R29) on the stage (src/stage/pose-reaction-stage.ts);
 *  2. slower: the user arriving is a light "presence" for her mood (a little less bored, not an interaction); the user sitting
 *     a long time makes her want a small stretch of her own (她自己的生活: her own need, never a reminder);
 *  3. slowest: one abstract line for the inner loop's existing call ("用户在、坐了约 50 分钟、刚才伸了懒腰"), only while sensing runs.
 * I-006 第 2 步 (docs/claude/2026-11-06-i006-step2.md) adds a fourth source with no camera at all: the user stops for a breather after
 * being absorbed (shared/behaviors/user-activity, state "歇一下"), and she sometimes stretches too, or, sleepy, yawns behind her hand.
 *
 * I-013 (少一点程序感): every chance, cooldown, delay and threshold comes from her card and mood through `PoseReactionPolicy`,
 * one object that can be replaced as a whole (I-010 互动余额 may replace it). What stays fixed is only privacy and fallback:
 * a stale signal is "not sensing", a chance never exceeds POSE_FOLLOW_CHANCE_MAX, the same event is not re-rolled at once.
 * Pure: no timer, no I/O, no clock; randomness is passed in.
 */
import { POSE_EVENTS, type PoseEvent, type PoseFacing, type PosePosture, type PoseSignal } from './pose-signals';
import type { FatiguePhase } from './fatigue';
import type { MoodLabel, MoodTendency } from './mood';

/** What she can catch from the user (the signal's one-shot events). */
export const POSE_FOLLOW_KINDS = POSE_EVENTS;
export type PoseFollowKind = PoseEvent;
/** What the stage plays: the three she can catch, and a glance when the user arrives. */
export const POSE_REACTION_KINDS = ['yawn', 'stretch', 'wave', 'glance'] as const;
export type PoseReactionKind = typeof POSE_REACTION_KINDS[number];
/** Why she does it: caught from the user, her own need (sat a long time with the user), the user arriving, the user's breather (I-006). */
export const POSE_REACTION_SOURCES = ['follow', 'own', 'arrive', 'pause'] as const;
/** What she does when the user stops for a breather: the small stretch, or (sleepy) a yawn behind her hand. */
export const POSE_PAUSE_KINDS = ['stretch', 'yawn'] as const;
export type PosePauseKind = typeof POSE_PAUSE_KINDS[number];
export type PoseReactionSource = typeof POSE_REACTION_SOURCES[number];

const MINUTE = 60_000;
const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const clamp01 = (value: number) => clamp(value, 0, 1);
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const member = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

// ---------------------------------------------------------------- her side of one decision

/** What her card, mood and body bring to a decision (CompanionService builds it from the mood view each second). */
export interface PoseCharacter {
  /** MoodParameters.weights: 1 = an average card, 0..4. */
  weights: Partial<Record<MoodTendency, number>> | null | undefined;
  mood: MoodLabel | string | null | undefined;
  fatigue: { phase?: FatiguePhase | null; F?: number } | null | undefined;
  /** MoodParameters.frequency.motionIntervalMs: her own rhythm of small motions. */
  motionIntervalMs: number;
  /** Card posture intensity 0..100: 0 means no body motion at all. */
  posture: number;
  /** MoodParameters.interaction.chatBoredomRelief: what one message takes off her boredom. */
  chatBoredomRelief: number;
}

const weight = (c: PoseCharacter, key: MoodTendency) => clamp(finite(c.weights?.[key], 1), 0, 4);
/** Close and playful draw her toward the user, cautious holds her back; 1 = an average card. */
export function poseSociability(c: PoseCharacter): number {
  return clamp(1 + 0.45 * (weight(c, 'close') - 1) + 0.35 * (weight(c, 'playful') - 1) - 0.45 * (weight(c, 'cautious') - 1), 0.25, 2.2);
}
const ASLEEP: readonly (FatiguePhase | null | undefined)[] = ['falling-asleep', 'asleep', 'micro-awake'];
export const poseAsleep = (c: PoseCharacter) => ASLEEP.includes(c.fatigue?.phase);
/** Her own sleepiness 0..1 (fatigue F, more in the drowsy phases). */
export function poseSleepiness(c: PoseCharacter): number {
  const F = clamp01(finite(c.fatigue?.F, 0)), phase = c.fatigue?.phase ?? 'awake';
  if (ASLEEP.includes(phase)) return 1;
  if (phase === 'drowsy') return clamp01(0.6 + 0.4 * F);
  if (phase === 'light-drowsy') return clamp01(0.35 + 0.4 * F);
  return clamp01(0.6 * F);
}
/** How her mood leans toward joining in (1 = calm). */
const MOOD_JOIN: Readonly<Partial<Record<MoodLabel, number>>> = {
  happy: 1.25, excited: 1.35, close: 1.3, content: 1.1, relieved: 1.1, longing: 1.15, calm: 1,
  concerned: 0.75, 'tense-expectation': 0.85, disappointed: 0.7, sad: 0.6, upset: 0.45,
};
const moodJoin = (c: PoseCharacter) => finite(MOOD_JOIN[c.mood as MoodLabel], 1);

// ---------------------------------------------------------------- the policy (I-013: replaceable as a whole)

export interface PoseReactionPolicy {
  /** Chance she catches this from the user now (0..1, before the fixed ceiling). */
  followChance(kind: PoseFollowKind, c: PoseCharacter): number;
  /** How long that kind rests after she followed it (ms). */
  followCooldownMs(kind: PoseFollowKind, c: PoseCharacter, random: () => number): number;
  /** After she did anything, the other kinds wait this long (ms): never a yawn, a stretch and a wave in a row. */
  gapMs(c: PoseCharacter): number;
  /** Delay before she starts (ms): "像真被传染". */
  delayMs(kind: PoseReactionKind, source: PoseReactionSource, c: PoseCharacter, random: () => number): number;
  /** How long the user sits before she wants a stretch of her own (ms), drawn once per cycle. */
  ownStretchAfterMs(c: PoseCharacter, random: () => number): number;
  /** Away at least this long and back is an arrival (ms); a longer absence also ends the "sitting" time. */
  arriveAfterMs(c: PoseCharacter): number;
  /** What an arrival takes off her boredom (0..100). */
  presenceRelief(c: PoseCharacter): number;
  /** The "look at you" moments' multiplier at full attention (user here and facing the screen). */
  gazeBoost(c: PoseCharacter): number;
  /** Size of one reaction's body motion (0..1.2; posture 0 → 0). */
  strength(kind: PoseReactionKind, c: PoseCharacter, random: () => number): number;
  /** I-006: chance she does something when the user stops for a breather (0..1, before the fixed ceiling). */
  pauseChance(c: PoseCharacter): number;
  /** I-006: of those, the share that is a yawn behind her hand instead of a stretch (0..1; her sleepiness). */
  pauseYawnShare(c: PoseCharacter): number;
  /** I-006: after she did one, how long she rests before the next (ms), drawn once per cycle. */
  pauseRestMs(c: PoseCharacter, random: () => number): number;
  /** I-006: what one interaction with her since then counts for toward that rest (ms): a lively day, a livelier her. */
  pauseInteractionMs(c: PoseCharacter): number;
}

/** Fixed fallback: she never follows more than this often, whatever a policy says ("宁可少，不要像复读机"). */
export const POSE_FOLLOW_CHANCE_MAX = 0.6;
/** Fixed fallback: one kind of event is considered at most once in this window (a wave seen twice is one greeting). */
export const POSE_CONSIDER_EVERY_MS = 15_000;
/** Fixed fallback: no signal for this long means sensing is not running (the supervisor treats 10 s as a crash). */
export const POSE_STALE_MS = 10_000;
/** The stage starts a cue only this long after its time (a late window or a reload never replays an old one). */
export const POSE_CUE_FRESH_MS = 4_000;

/**
 * First version (trial values; about 2–3 in 10 on an average card):
 *  - yawn: 0.24 × sociability^0.5 × mood^0.4 × (0.35 + 1.3 × her sleepiness): awake ≈ 1.5 in 10, sleepy ≈ 3 in 10;
 *  - stretch: 0.22 × sociability^0.8 × mood × (0.8 + 0.4 × sleepiness);
 *  - wave (the user waved at her): 0.22 × sociability^0.8 × mood (main session 2026-11-03: 0.3 put the clingiest card near
 *    1 in 2, above the user's "偏低"; now an average card ≈ 2 in 10, the clingiest ≈ 3.5 in 10, a cautious one ≈ 1 in 10).
 * Cooldowns, delays and the own-stretch time scale with the card's small-motion interval (default 5 min).
 */
export const POSE_REACTION_POLICY: PoseReactionPolicy = Object.freeze({
  followChance(kind: PoseFollowKind, c: PoseCharacter): number {
    if (poseAsleep(c)) return 0;
    const social = poseSociability(c), sleepy = poseSleepiness(c), mood = moodJoin(c);
    if (kind === 'yawn') return 0.24 * social ** 0.5 * mood ** 0.4 * (0.35 + 1.3 * sleepy);
    if (!(c.posture > 0)) return 0;
    if (kind === 'stretch') return 0.22 * social ** 0.8 * mood * (0.8 + 0.4 * sleepy);
    return 0.22 * social ** 0.8 * mood;
  },
  followCooldownMs(kind: PoseFollowKind, c: PoseCharacter, random: () => number): number {
    const base = kind === 'yawn' ? 0.8 : kind === 'stretch' ? 1 : 0.4;
    const restraint = clamp(1.3 - 0.3 * poseSociability(c), 0.6, 1.25);
    return Math.round(clamp(c.motionIntervalMs, 10_000, 60 * MINUTE) * base * restraint * (0.8 + 0.4 * clamp01(random())));
  },
  gapMs(c: PoseCharacter): number { return Math.round(clamp(c.motionIntervalMs * 0.1, 15_000, 3 * MINUTE)); },
  delayMs(kind: PoseReactionKind, source: PoseReactionSource, c: PoseCharacter, random: () => number): number {
    if (source === 'own') return 0;
    // The user's breather: she notices it a moment later (a second or three), slower when sleepy or cautious.
    if (source === 'pause') return Math.round(clamp((800 + 2000 * clamp01(random())) * clamp(1 + 0.15 * (weight(c, 'cautious') - 1) + 0.25 * poseSleepiness(c), 0.8, 1.4), 600, 3_500));
    const sleepy = kind === 'wave' || kind === 'glance' ? 0 : poseSleepiness(c);
    const pace = clamp(1 - 0.15 * (poseSociability(c) - 1) + 0.15 * (weight(c, 'cautious') - 1) + 0.35 * sleepy, 0.7, 1.5);
    const [low, high] = kind === 'glance' ? [200, 800] : [350, 1300];
    return Math.round(clamp((low + (high - low) * clamp01(random())) * pace, 150, 1900));
  },
  ownStretchAfterMs(c: PoseCharacter, random: () => number): number {
    const restless = clamp(1 - 0.15 * (weight(c, 'playful') - 1) + 0.15 * (weight(c, 'comfortable') - 1), 0.6, 1.5);
    return Math.round(clamp(clamp(c.motionIntervalMs, 10_000, 60 * MINUTE) * (6 + 4 * clamp01(random())) * restless, 10 * MINUTE, 3 * 60 * MINUTE));
  },
  arriveAfterMs(c: PoseCharacter): number { return Math.round(clamp(c.motionIntervalMs * 0.3, 30_000, 10 * MINUTE)); },
  presenceRelief(c: PoseCharacter): number { return clamp(finite(c.chatBoredomRelief, 20) * 0.4 * clamp(poseSociability(c), 0.5, 1.5), 0, 30); },
  gazeBoost(c: PoseCharacter): number { return clamp(1 + 1.2 * poseSociability(c), 1.3, 3.5); },
  strength(kind: PoseReactionKind, c: PoseCharacter, random: () => number): number {
    if (!(c.posture > 0)) return kind === 'yawn' || kind === 'glance' ? 0.6 : 0;
    return Math.round(clamp(Math.min(1.2, c.posture / 50) * (0.85 + 0.25 * clamp01(random())), 0, 1.2) * 1000) / 1000;
  },
  /**
   * I-006 (trial values): about 1 in 4 breathers on an average awake card, 2 in 5 when drowsy, 1 in 3 close and playful, 1 in 8
   * cautious; sad or upset less. Then she rests 8–14 small-motion intervals (default 40–70 min), each interaction with her since
   * then counting for 1.5 intervals (7.5 min). So it is "有时", never every time the user stops.
   */
  pauseChance(c: PoseCharacter): number {
    if (poseAsleep(c) || !(c.posture > 0)) return 0;
    return 0.3 * poseSociability(c) ** 0.6 * moodJoin(c) * (0.7 + 0.8 * poseSleepiness(c));
  },
  pauseYawnShare(c: PoseCharacter): number { return clamp01((poseSleepiness(c) - 0.3) / 0.6) * 0.7; },
  pauseRestMs(c: PoseCharacter, random: () => number): number {
    const restraint = clamp(1.3 - 0.3 * poseSociability(c), 0.6, 1.25);
    return Math.round(clamp(clamp(c.motionIntervalMs, 10_000, 60 * MINUTE) * (8 + 6 * clamp01(random())) * restraint, 15 * MINUTE, 4 * 60 * MINUTE));
  },
  pauseInteractionMs(c: PoseCharacter): number {
    return Math.round(clamp(c.motionIntervalMs, 10_000, 60 * MINUTE) * 1.5 * clamp(poseSociability(c), 0.5, 1.5));
  },
});

// ---------------------------------------------------------------- the user, as the signals describe them

/** Postures that count as sitting at the computer ('unknown' too: a presence-only computer does not know). */
const SEATED: readonly PosePosture[] = ['sitting', 'slumped', 'leaning-back', 'unknown'];

export interface PoseSession {
  /** Wall ms of the last signal (real or simulated). */
  lastSignalAt: number;
  /** A developer test command made this session: it lasts until then, whatever signals say. */
  simulatedUntil: number | null;
  present: boolean;
  presentSince: number | null;
  awaySince: number | null;
  facing: PoseFacing;
  posture: PosePosture;
  /** In front of the computer and not standing, short absences included; null otherwise. */
  sittingSince: number | null;
  standingSince: number | null;
  /** The latest time the user did each one. */
  events: Partial<Record<PoseFollowKind, number>>;
}
export interface PoseSessionStep { session: PoseSession; arrived: boolean; left: boolean; events: PoseFollowKind[] }

/** One signal into the session. `arriveAfterMs` from the policy: also how long an absence ends the sitting time. */
export function stepPoseSession(previous: PoseSession | null, signal: PoseSignal, now: number, arriveAfterMs: number): PoseSessionStep {
  const present = signal.present === true;
  const session: PoseSession = previous ? { ...previous, events: { ...previous.events } } : {
    lastSignalAt: now, simulatedUntil: null, present, presentSince: present ? now : null, awaySince: present ? null : now,
    facing: 'unknown', posture: 'unknown', sittingSince: null, standingSince: null, events: {},
  };
  const wasPresent = previous ? previous.present : present;
  // Only an absence that was seen counts: the first signal after the camera turns on is not an arrival.
  const arrived = !!previous && !wasPresent && present && previous.awaySince !== null && now - previous.awaySince >= arriveAfterMs;
  const left = !!previous && wasPresent && !present;
  session.lastSignalAt = now;
  session.present = present;
  if (present) { if (!wasPresent || session.presentSince === null) session.presentSince = now; session.awaySince = null; }
  else { if (wasPresent || session.awaySince === null) session.awaySince = now; session.presentSince = null; }
  session.facing = present ? signal.facing : 'unknown';
  session.posture = present ? signal.posture : 'unknown';
  // Codex T-112 round 032: back after the away threshold with no absent sample past it, the old sitting time went on. What was not
  // seen is not known: a return that is an arrival, or a gap that long with no signal at all, starts the sitting time again.
  if (present && previous && (arrived || now - previous.lastSignalAt >= arriveAfterMs)) { session.sittingSince = null; session.standingSince = null; }
  if (present) {
    if (SEATED.includes(signal.posture)) { session.standingSince = null; session.sittingSince ??= now; }
    else {
      session.standingSince ??= now;
      // Standing up for a moment is part of sitting at a desk; standing a while is a break.
      if (now - session.standingSince >= Math.min(arriveAfterMs, MINUTE)) session.sittingSince = null;
    }
  } else if (session.awaySince !== null && now - session.awaySince >= arriveAfterMs) { session.sittingSince = null; session.standingSince = null; }
  const events: PoseFollowKind[] = [];
  for (const event of signal.events) if (member(POSE_FOLLOW_KINDS, event) && !events.includes(event)) { events.push(event); session.events[event] = now; }
  return { session, arrived, left, events };
}

/** Sensing runs (or a developer simulation holds): otherwise there is no session at all. */
export function poseSessionLive(session: PoseSession | null, now: number): session is PoseSession {
  if (!session) return false;
  if (session.simulatedUntil !== null) return now <= session.simulatedUntil;
  return now - session.lastSignalAt <= POSE_STALE_MS && now >= session.lastSignalAt - POSE_STALE_MS;
}

/** 0..1 how much her eyes are drawn to the user (the stage eases toward it). */
export function poseAttention(session: PoseSession | null): number {
  if (!session?.present) return 0;
  return session.facing === 'toward' ? 1 : session.facing === 'side' ? 0.35 : session.facing === 'unknown' ? 0.5 : 0;
}

// ---------------------------------------------------------------- contagion: one decision

export interface PoseFollowMemory {
  /** When each kind may be followed again. */
  until: Partial<Record<PoseFollowKind, number>>;
  /** When each kind was last considered (followed or not). */
  considered: Partial<Record<PoseFollowKind, number>>;
  /** When she last did anything (any kind, any source). */
  lastReactionAt: number | null;
}
export const emptyPoseFollowMemory = (): PoseFollowMemory => ({ until: {}, considered: {}, lastReactionAt: null });

export type PoseFollowOutcome =
  | { decision: 'follow'; delayMs: number; strength: number; memory: PoseFollowMemory }
  | { decision: 'pass'; chance: number; memory: PoseFollowMemory }
  | { decision: 'skip'; reason: 'asleep' | 'resting' | 'considered' | 'busy'; memory: PoseFollowMemory };

/**
 * The user just did `kind`. She considers it (unless she is asleep, it is still resting, or she just did something else) and
 * follows it with her own chance; `force` (a developer test command) skips the chance, the cooldowns and the gap, nothing else.
 */
export function decidePoseFollow(kind: PoseFollowKind, memory: PoseFollowMemory, c: PoseCharacter, now: number, random: () => number,
  policy: PoseReactionPolicy = POSE_REACTION_POLICY, force = false): PoseFollowOutcome {
  const next: PoseFollowMemory = { until: { ...memory.until }, considered: { ...memory.considered }, lastReactionAt: memory.lastReactionAt };
  if (poseAsleep(c)) return { decision: 'skip', reason: 'asleep', memory: next };
  if (!force) {
    if ((next.until[kind] ?? -Infinity) > now) return { decision: 'skip', reason: 'resting', memory: next };
    if (now - (next.considered[kind] ?? -Infinity) < POSE_CONSIDER_EVERY_MS) return { decision: 'skip', reason: 'considered', memory: next };
    if (next.lastReactionAt !== null && now - next.lastReactionAt < policy.gapMs(c)) return { decision: 'skip', reason: 'busy', memory: next };
  }
  next.considered[kind] = now;
  const chance = Math.min(POSE_FOLLOW_CHANCE_MAX, Math.max(0, finite(policy.followChance(kind, c), 0)));
  if (!force && !(clamp01(random()) < chance)) return { decision: 'pass', chance, memory: next };
  next.until[kind] = now + Math.max(0, finite(policy.followCooldownMs(kind, c, random), 0));
  next.lastReactionAt = now;
  return { decision: 'follow', delayMs: Math.max(0, finite(policy.delayMs(kind, 'follow', c, random), 0)), strength: policy.strength(kind, c, random), memory: next };
}

// ---------------------------------------------------------------- her own stretch (她自己的生活)

/**
 * The user has sat for `sittingMs`; she last stretched at `lastStretchAt` (any source) and wants one once both the sitting time
 * and the time since her last stretch reach `dueAfterMs` (drawn per cycle by the policy). It is her own need, not a reminder.
 */
export function poseOwnStretchDue(sittingMs: number | null, lastStretchAt: number | null, now: number, dueAfterMs: number): boolean {
  if (sittingMs === null || !(sittingMs >= dueAfterMs)) return false;
  return lastStretchAt === null || now - lastStretchAt >= dueAfterMs;
}

// ---------------------------------------------------------------- the user's breather (I-006 第 2 步)

/** When she last did something for a breather (or stretched for any reason), and this cycle's rest. */
export interface PosePauseMemory { lastAt: number | null; restMs: number | null }
export const emptyPosePauseMemory = (): PosePauseMemory => ({ lastAt: null, restMs: null });

export type PosePauseOutcome =
  | { decision: 'react'; kind: PosePauseKind; delayMs: number; strength: number; memory: PosePauseMemory }
  | { decision: 'pass'; chance: number; memory: PosePauseMemory }
  | { decision: 'skip'; reason: 'asleep' | 'still' | 'resting' | 'busy'; memory: PosePauseMemory };

export interface PosePauseContext {
  /** Interactions with her since memory.lastAt (I-010 互动余额's count; 0 when not known). */
  interactions: number;
  /** When she last did anything at all (PoseFollowMemory.lastReactionAt): never two things in a row. */
  lastReactionAt: number | null;
  /** A developer test command made this breather: chance, rest and gap are skipped, nothing else. */
  force?: boolean;
}

/**
 * Rested since her last one: the time since then, plus what the interactions since then count for, reaches this cycle's rest. The
 * whole rule is this function and the policy's numbers (I-013: replaceable as a whole, e.g. by I-010 互动余额).
 */
export function posePauseRested(memory: PosePauseMemory, now: number, interactions: number, perInteractionMs: number): boolean {
  if (memory.lastAt === null || memory.restMs === null) return true;
  const elapsed = now - memory.lastAt;
  if (!(elapsed >= 0)) return false; // the clock went back: not rested
  return elapsed + Math.max(0, finite(interactions, 0)) * Math.max(0, finite(perInteractionMs, 0)) >= memory.restMs;
}

/**
 * The user just stopped for a breather. She considers it once: asleep or with no body motion she does nothing; resting from the last
 * one, or just did something else, she lets it go; otherwise her own chance, and if she does, a stretch or (sleepy) a yawn.
 */
export function decidePosePause(memory: PosePauseMemory, c: PoseCharacter, now: number, random: () => number, context: PosePauseContext,
  policy: PoseReactionPolicy = POSE_REACTION_POLICY): PosePauseOutcome {
  const next: PosePauseMemory = { ...memory };
  if (poseAsleep(c)) return { decision: 'skip', reason: 'asleep', memory: next };
  if (!(c.posture > 0)) return { decision: 'skip', reason: 'still', memory: next };
  if (!context.force) {
    if (!posePauseRested(next, now, context.interactions, policy.pauseInteractionMs(c))) return { decision: 'skip', reason: 'resting', memory: next };
    if (context.lastReactionAt !== null && now - context.lastReactionAt < policy.gapMs(c)) return { decision: 'skip', reason: 'busy', memory: next };
  }
  const chance = Math.min(POSE_FOLLOW_CHANCE_MAX, Math.max(0, finite(policy.pauseChance(c), 0)));
  if (!context.force && !(clamp01(random()) < chance)) return { decision: 'pass', chance, memory: next };
  const kind: PosePauseKind = clamp01(random()) < clamp01(finite(policy.pauseYawnShare(c), 0)) ? 'yawn' : 'stretch';
  next.lastAt = now;
  next.restMs = Math.max(0, finite(policy.pauseRestMs(c, random), 0));
  return { decision: 'react', kind, delayMs: Math.max(0, finite(policy.delayMs(kind, 'pause', c, random), 0)), strength: policy.strength(kind, c, random), memory: next };
}

// ---------------------------------------------------------------- what the stage gets (MoodView.pose)

export interface PoseReactionCue {
  /** Changes for every reaction; the stage plays each id once. */
  id: string;
  kind: PoseReactionKind;
  source: PoseReactionSource;
  /** Wall ms to start (her delay included). */
  at: number;
  /** Body motion size 0..1.2. */
  strength: number;
  /**
   * I-006: a breather's yawn only. The host's live cue for 哈欠捂嘴 (electron/her-action-host.ts): the stage plays it in a whole-body
   * framing (in a half-body one the hand would cover her nose and eye, so she stretches instead).
   */
  cover?: PoseCoverCue;
}
export interface PoseCoverCue { id: string; at: number; expiresAt: number }
/** The her-action cue's window (shared/her-actions.ts HER_ACTION_CUE_MS). */
const COVER_CUE_MS = 8_000;
const readCover = (value: unknown): PoseCoverCue | null | undefined => {
  if (value === undefined) return undefined;
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(v.id) || typeof v.at !== 'number' || !Number.isFinite(v.at)
    || typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt) || !(v.expiresAt > v.at) || v.expiresAt - v.at > COVER_CUE_MS) return null;
  return { id: v.id, at: v.at, expiresAt: v.expiresAt };
};
export interface PoseReactionView {
  /** 0..1 where her eyes are drawn (the stage eases toward it slowly). */
  attention: number;
  /** "Look at you" multiplier at full attention. */
  boost: number;
  cue: PoseReactionCue | null;
}

/** The stage's reading of the view (it comes through the mood bridge unchanged): anything off is no view. */
export function readPoseReactionView(value: unknown): PoseReactionView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.attention !== 'number' || !(v.attention >= 0 && v.attention <= 1) || typeof v.boost !== 'number' || !(v.boost >= 1 && v.boost <= 4)) return null;
  let cue: PoseReactionCue | null = null;
  if (v.cue !== null) {
    const c = v.cue as Record<string, unknown> | undefined;
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(c.id) || !member(POSE_REACTION_KINDS, c.kind)
      || !member(POSE_REACTION_SOURCES, c.source) || typeof c.at !== 'number' || !Number.isFinite(c.at) || typeof c.strength !== 'number' || !(c.strength >= 0 && c.strength <= 1.2)) return null;
    const cover = readCover(c.cover);
    if (cover === null || (cover && !(c.kind === 'yawn' && c.source === 'pause'))) return null;
    cue = { id: c.id, kind: c.kind, source: c.source, at: c.at, strength: c.strength, ...(cover ? { cover } : {}) };
  }
  return { attention: v.attention, boost: v.boost, cue };
}

// ---------------------------------------------------------------- words (no image, no coordinate: fixed vocabulary only)

export interface PoseSummary {
  present: boolean;
  facing: PoseFacing;
  posture: PosePosture;
  /** Whole minutes sitting at the computer (null when not sitting). */
  sittingMinutes: number | null;
  /** Whole minutes away (null while here). */
  awayMinutes: number | null;
  /** What the user did in the last few minutes, latest first. */
  recent: PoseFollowKind[];
}
export const POSE_RECENT_MS = 3 * MINUTE;

export function poseSummary(session: PoseSession | null, now: number): PoseSummary | null {
  if (!poseSessionLive(session, now)) return null;
  const minutes = (since: number | null) => since === null ? null : Math.max(0, Math.round((now - since) / MINUTE));
  const recent = (Object.entries(session.events) as [PoseFollowKind, number][])
    .filter(([, at]) => now - at <= POSE_RECENT_MS && at <= now + 1_000).sort((a, b) => b[1] - a[1]).map(([kind]) => kind);
  return { present: session.present, facing: session.facing, posture: session.posture, sittingMinutes: session.present ? minutes(session.sittingSince) : null,
    awayMinutes: session.present ? null : minutes(session.awaySince), recent };
}

const FACING_WORDS: Readonly<Record<PoseFacing, string>> = { toward: '正对着屏幕', side: '侧着身', away: '背对着屏幕', unknown: '' };
const POSTURE_WORDS: Readonly<Record<PosePosture, string>> = { sitting: '', standing: '站着', slumped: '趴在桌上', 'leaning-back': '往后靠着', unknown: '' };
const RECENT_WORDS: Readonly<Record<PoseFollowKind, string>> = { yawn: '打了个哈欠', stretch: '伸了个懒腰', wave: '冲你挥了挥手' };

/**
 * The inner loop's one line while camera sensing runs ('' otherwise). Only the app's own words for the abstract signals: no
 * picture, no position, nothing the user said. It says plainly that she does not see a picture.
 */
export function poseInnerLoopLine(summary: PoseSummary | null): string {
  if (!summary) return '';
  const facts: string[] = [];
  if (!summary.present) facts.push(summary.awayMinutes !== null && summary.awayMinutes >= 1 ? `用户现在不在电脑前（离开约 ${summary.awayMinutes} 分钟）` : '用户刚离开电脑前');
  else {
    facts.push('用户在电脑前');
    for (const word of [FACING_WORDS[summary.facing], POSTURE_WORDS[summary.posture]]) if (word) facts.push(word);
    const sat = summary.sittingMinutes;
    if (sat !== null) facts.push(sat < 2 ? '刚坐下没多久' : `坐了约 ${sat} 分钟`);
  }
  for (const kind of summary.recent) facts.push(`刚才${RECENT_WORDS[kind]}`);
  return `你看不到摄像头画面，只知道应用在本机识别到的这些：${facts.join('，')}。这不是你亲眼看到的，不要说成是你看见的。`;
}

export interface PoseMomentEntry { at: number; kind: PoseReactionKind; source: PoseReactionSource }
export const POSE_MOMENTS_MAX = 200;
export const POSE_MOMENTS_KEEP_MS = 4 * 24 * 60 * MINUTE;
const FOLLOW_WORDS: Readonly<Record<PoseFollowKind, (n: number) => string>> = {
  yawn: n => `跟着用户打了 ${n} 个哈欠`, stretch: n => `跟着用户伸了 ${n} 次懒腰`, wave: n => `冲用户挥了 ${n} 次手`,
};

/** One material line for that day's diary ('' when nothing): her own moments, counts only. */
export function poseDiaryLine(entries: readonly PoseMomentEntry[], start: number, end: number): string {
  const within = entries.filter(entry => entry.at >= start && entry.at < end);
  const words: string[] = [];
  for (const kind of ['yawn', 'stretch', 'wave'] as const) {
    const n = within.filter(entry => entry.source === 'follow' && entry.kind === kind).length;
    if (n) words.push(FOLLOW_WORDS[kind](n));
  }
  const own = within.filter(entry => entry.source === 'own').length;
  if (own) words.push(`陪用户坐久了，自己伸了 ${own} 次懒腰`);
  return words.length ? `这天用户在电脑前时你做过的小事（应用记下的，只是素材，可写可不写）：${words.join('；')}。` : '';
}
