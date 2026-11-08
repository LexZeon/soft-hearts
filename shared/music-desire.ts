/**
 * 音频律动由她决定 (M1; plan docs/claude/2026-11-02-pose-behavior-plan.md "音频律动", record
 * docs/claude/2026-11-03-music-her-choice.md).
 *
 * The music switch only means "she may hear it". Whether she moves, and how much, is her own
 * decision, made locally (no model call) from who she is and how she is right now:
 *   - the card: the playful tendency and playful motion intensity (and a little caution);
 *   - her mood (the label for now; see `channels` below);
 *   - her energy (the fatigue phase and level; asleep never moves);
 *   - what she is doing on her own (daydreaming or thinking: she gets carried along after a moment);
 *   - a chat request ("跳一个"): a large bonus for a while, shaped by her character;
 *   - later, the user moving to the beat (pose sensing, a plus; nothing sends it yet).
 *
 * The result is a score and one of three tiers: nothing, a light nod and sway to the beat (R18 small
 * motion), or the dance (the R15 motion). Pure: no clock, no I/O, no randomness; the director
 * (src/stage/music-choice.ts) owns the timing and the hysteresis.
 *
 * REPLACEABLE: `DanceDesireFn` is the one seam. After Codex T-106's
 * parameter table, new behaviours read the five raw mood channels instead of the label. The input
 * already carries `channels`; the label version below ignores it. Swap the function, keep the rest.
 */
import type { MoodLabel } from './mood';
import type { HerLifeActivity } from './her-life';

export type DanceTier = 'none' | 'nod' | 'dance';

export interface DanceDesireInput {
  /** MoodParameters.weights.playful and .cautious (1 = an average card). */
  playfulWeight: number;
  cautiousWeight: number;
  /** MoodParameters.intensity.playful (0..100, 50 = average): how playful her motions are. */
  playfulIntensity: number;
  mood: MoodLabel | string | null | undefined;
  fatigue: { phase?: string; F?: number; sleeping?: boolean } | null | undefined;
  /** What she is doing on her own (L2) and how many seconds of this song she has heard (the "carried along after a moment" lag). */
  activity: HerLifeActivity | string | null | undefined;
  heardSeconds: number;
  /** 0..1: the chat request's strength right now (danceRequestStrength). */
  request: number;
  /** 0..1: the user moving to the beat. Reserved for pose sensing; nothing sends it yet. */
  userMoving?: number;
  /** Reserved for the raw-channel version (Codex T-106): the five mood channel values, 0..100. */
  channels?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>> | null;
}

export interface DanceDesirePart { name: string; value: number }
export interface DanceDesire {
  /** 0..1 (before the director's small per-song variation). */
  score: number;
  /** The tier this score alone would give (no hysteresis). */
  tier: DanceTier;
  /** What moved the score, strongest first (only parts that mattered). */
  parts: DanceDesirePart[];
  /** One line for the developer panel. */
  reason: string;
  /** True when she cannot move at all right now (asleep). */
  asleep: boolean;
}
export type DanceDesireFn = (input: DanceDesireInput) => DanceDesire;

// ---------------------------------------------------------------- numbers (trial values, tuned in the user's trial)

export const DANCE_BASE = 0.38;
/** Score needed to start a light nod, and to start dancing; leaving takes this much less (hysteresis margin). */
export const DANCE_NOD_AT = 0.3;
export const DANCE_DANCE_AT = 0.55;
export const DANCE_STAY_MARGIN = 0.07;

/** How much each mood adds or takes away. Mood labels not listed add nothing. */
export const DANCE_MOOD: Readonly<Record<string, number>> = Object.freeze({
  excited: 0.3, happy: 0.22, relieved: 0.1, content: 0.08, close: 0.08,
  calm: 0, longing: -0.05, 'tense-expectation': -0.05,
  concerned: -0.15, disappointed: -0.2, upset: -0.25, sad: -0.3,
});
/** How receptive she is to being asked to dance in each mood (1 = fully). A sad or cross her stays stubborn. */
export const DANCE_RECEPTIVE: Readonly<Record<string, number>> = Object.freeze({
  sad: 0.5, upset: 0.3, disappointed: 0.5, concerned: 0.6, 'tense-expectation': 0.8, longing: 0.8,
});
/** What her own thing costs while it is fresh (it fades over `rampS` seconds of the song) or adds (humming). */
export const DANCE_ACTIVITY: Readonly<Record<string, { value: number; rampS: number }>> = Object.freeze({
  daydream: { value: -0.14, rampS: 8 },
  thinking: { value: -0.14, rampS: 6 },
  humming: { value: 0.08, rampS: 0 },
  drowsy: { value: -0.3, rampS: 0 },
  company: { value: 0, rampS: 0 },
});
const SLEEPY_PHASES = ['falling-asleep', 'asleep', 'micro-awake'];
const PHASE_COST: Readonly<Record<string, number>> = Object.freeze({ 'light-drowsy': -0.1, drowsy: -0.35 });
export const DANCE_REQUEST_BOOST = 0.45;
export const DANCE_USER_MOVING_BOOST = 0.25;

const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const clamp01 = (value: number) => clamp(value, 0, 1);
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const smoothstep = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };

export function danceTierOf(score: number): DanceTier {
  return score >= DANCE_DANCE_AT ? 'dance' : score >= DANCE_NOD_AT ? 'nod' : 'none';
}
/** The tier with hysteresis: moving up needs the full threshold, moving down only drops once clearly below. */
export function danceTierWithHysteresis(score: number, current: DanceTier): DanceTier {
  const up = danceTierOf(score);
  const rank = (tier: DanceTier) => tier === 'dance' ? 2 : tier === 'nod' ? 1 : 0;
  if (rank(up) >= rank(current)) return up;
  // Lower than where she is: stay one step up until the score is clearly below the threshold.
  if (current === 'dance') return score >= DANCE_DANCE_AT - DANCE_STAY_MARGIN ? 'dance' : score >= DANCE_NOD_AT - DANCE_STAY_MARGIN ? 'nod' : 'none';
  return score >= DANCE_NOD_AT - DANCE_STAY_MARGIN ? 'nod' : 'none';
}

export function isAsleep(fatigue: DanceDesireInput['fatigue']): boolean {
  return !!fatigue && (fatigue.sleeping === true || SLEEPY_PHASES.includes(fatigue.phase ?? ''));
}

const PART_NAMES = {
  base: '基础', playful: '爱玩倾向', cautious: '谨慎倾向', lively: '玩闹幅度', mood: '心情', tired: '精力', activity: '正在做的事',
  request: '你叫她跳', userMoving: '你在跟着动',
} as const;
const MOOD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  calm: '平静', close: '亲近', content: '满足', happy: '愉快', excited: '兴奋', concerned: '担心', disappointed: '失落', upset: '不满',
  longing: '想念', sad: '伤感', relieved: '释然', 'tense-expectation': '紧张期待',
});
const ACTIVITY_NAMES: Readonly<Record<string, string>> = Object.freeze({ company: '陪着你', daydream: '发呆', humming: '哼歌', thinking: '想事情', drowsy: '犯困' });
const TIER_NAMES: Readonly<Record<DanceTier, string>> = Object.freeze({ none: '不动', nod: '点头晃一晃', dance: '跳起来' });
export const danceTierName = (tier: DanceTier) => TIER_NAMES[tier];

/** The default: mood label + card tendencies + energy + what she is doing + a chat request. */
export const moodLabelDanceDesire: DanceDesireFn = input => {
  if (isAsleep(input.fatigue)) return { score: 0, tier: 'none', parts: [{ name: '睡着了', value: -1 }], reason: '想跳 0.00 · 不动 · 睡着了', asleep: true };
  const parts: DanceDesirePart[] = [];
  const add = (name: string, value: number) => { if (value !== 0) parts.push({ name, value }); return value; };
  let score = DANCE_BASE;
  // The card: 1 is average; the playful tendency moves it by up to about +-0.11 over the panel's 0.5..1.5 range.
  score += add(PART_NAMES.playful, 0.22 * (clamp(finite(input.playfulWeight, 1), 0, 2) - 1));
  score += add(PART_NAMES.cautious, -0.16 * (clamp(finite(input.cautiousWeight, 1), 0, 2) - 1));
  score += add(PART_NAMES.lively, 0.12 * (clamp(finite(input.playfulIntensity, 50), 0, 100) - 50) / 50);
  const mood = typeof input.mood === 'string' ? input.mood : '';
  score += add(`${PART_NAMES.mood}${MOOD_NAMES[mood] ?? ''}`, finite(DANCE_MOOD[mood], 0));
  // Energy: tiredness costs, and a rested, lively her loses nothing.
  const phase = input.fatigue?.phase ?? '';
  const level = clamp01((finite(input.fatigue?.F, 0.25) - 0.4) / 0.5);
  score += add(PART_NAMES.tired, finite(PHASE_COST[phase], 0) - 0.2 * level);
  // What she is doing on her own: the cost of a fresh daydream or thought fades as the song goes on.
  const activity = DANCE_ACTIVITY[typeof input.activity === 'string' ? input.activity : ''];
  if (activity) {
    const fade = activity.rampS > 0 ? 1 - smoothstep(finite(input.heardSeconds, 0) / activity.rampS) : 1;
    score += add(`${PART_NAMES.activity}${ACTIVITY_NAMES[input.activity as string] ?? ''}`, activity.value * fade);
  }
  // A chat request is a large bonus, shaped by how receptive she is in this mood and how awake she is.
  const receptive = finite(DANCE_RECEPTIVE[mood], 1) * (phase === 'drowsy' ? 0.3 : phase === 'light-drowsy' ? 0.7 : 1);
  score += add(PART_NAMES.request, DANCE_REQUEST_BOOST * clamp01(input.request) * receptive);
  score += add(PART_NAMES.userMoving, DANCE_USER_MOVING_BOOST * clamp01(finite(input.userMoving, 0)));
  score = clamp01(score);
  const tier = danceTierOf(score);
  parts.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const shown = parts.filter(part => Math.abs(part.value) >= 0.02).slice(0, 4);
  const reason = `想跳 ${score.toFixed(2)} · ${TIER_NAMES[tier]}${shown.length ? ` · ${shown.map(part => `${part.name}${part.value > 0 ? '+' : ''}${part.value.toFixed(2)}`).join('，')}` : ''}`;
  return { score, tier, parts, reason, asleep: false };
};

// ---------------------------------------------------------------- the chat request

/** The request lasts this long, counted from the message. */
export const DANCE_REQUEST_WINDOW_MS = 150_000;
const REQUEST_RAMP_MS = 2_000;
const REQUEST_FADE_MS = 40_000;
/** How long a reluctant character holds out before giving in, at most. */
export const DANCE_REQUEST_MAX_DELAY_MS = 25_000;

/** 0 (willing) .. 1 (stubborn), from the card: a low playful tendency or a high cautious one holds out. */
export function danceReluctance(card: { playfulWeight: number; cautiousWeight: number }): number {
  return clamp01(0.5 * (1 - finite(card.playfulWeight, 1)) + 0.5 * (finite(card.cautiousWeight, 1) - 1) + 0.15);
}

/** How long after the message the request has reached its full strength for this card (when to judge again). */
export function danceRequestSettleMs(card: { playfulWeight: number; cautiousWeight: number }): number {
  return danceReluctance(card) * DANCE_REQUEST_MAX_DELAY_MS + REQUEST_RAMP_MS + 300;
}

/**
 * How strongly a chat request ("跳一个") counts `ageMs` after the message: a willing character takes it
 * at once; a stubborn one holds out for up to DANCE_REQUEST_MAX_DELAY_MS ("嘴硬") and then gives in ("过一会儿自己跳").
 * It then fades out towards the end of the window, and is exactly 0 afterwards (it expires).
 */
export function danceRequestStrength(ageMs: number, card: { playfulWeight: number; cautiousWeight: number }): number {
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= DANCE_REQUEST_WINDOW_MS) return 0;
  const delay = danceReluctance(card) * DANCE_REQUEST_MAX_DELAY_MS;
  const rise = smoothstep((ageMs - delay) / REQUEST_RAMP_MS);
  const fall = 1 - smoothstep((ageMs - (DANCE_REQUEST_WINDOW_MS - REQUEST_FADE_MS)) / REQUEST_FADE_MS);
  return rise * fall;
}
