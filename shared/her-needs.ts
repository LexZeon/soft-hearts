/**
 * 她也会需要你 (L4, roadmap core item 6, principles 2, 4 and 6; idea I-005; plan
 * docs/claude/2026-11-03-she-needs-you-plan.md, record docs/claude/2026-11-03-she-needs-you.md):
 * now and then she has a small feeling of her own (a little bored of being alone, a bad dream, a low-energy day,
 * wanting someone to talk to). A pat, a snack or a few words from the user soothes it, and the warmth lingers.
 *
 * Light, cute and rare, and never a lever on the user (the user's own correction, 2026-11-03: a little guilt is care and is fine; the
 * "big line" is that she never uses it to control or punish, never makes the user afraid to leave, never piles it on, never brings up
 * old accounts, and never adds to it when the user is already sad; being 偏心 she is the one who makes up first):
 *   - how often follows her mood and character (a WANT, 0..1), pressed down softly by how much has already happened and by how
 *     she was left before (HerNeedLimitFn: replaceable; with the I-010 互动余额 wired, the budget's room replaces "needs today");
 *     no fixed N a day;
 *   - it only ever gets weaker (a short hold, then a slow fade), never bigger; once one has faded unanswered the next
 *     one waits until the user has interacted again, so it cannot escalate or repeat;
 *   - a need nobody answered leaves 低落 (capped, shown in her face and movement, fewer things started), which the user's
 *     first move turns into 释然: everything starts from her character and mood and returns to them
 *     (docs/claude/2026-11-03-mood-loop-design.md);
 *   - it counts only time the app is open and the user is not there: days away add nothing to it;
 *   - what she says (once, in the inner loop's own speech opportunity) may be a small 撒娇, never a lever.
 *
 * One data table drives it (HER_NEED_TABLE): when it can start, how long it lasts, what the stage shows (the same
 * offsets the R18 procedural life and 她自己的生活 use: shared/her-life.ts HerLifePresentation), what soothes it
 * and how much the mood lifts when it is soothed. A new need is one more row. Pure: no timer, no I/O, no clock, no
 * randomness of its own (passed in).
 *
 * REPLACEABLE: `HerNeedTriggerFn` is the one seam for "how much does she want it now". After
 * Codex T-106's parameter table, new behaviours read the five raw mood channels instead of the label. The signals
 * already carry `channels` and `baseline`; the default below uses the channels for closeness and liveliness and the label and
 * boredom for the rest. Swap the function, keep the rest.
 */
import type { FatiguePhase } from './fatigue';
import type { MoodLabel, MoodTendency, MoodValues } from './mood';
import { HER_LIFE_NEUTRAL_PRESENTATION, type HerLifePresentation } from './her-life';

export const HER_NEED_IDS = ['lonely', 'dream', 'lowEnergy', 'chatty'] as const;
export type HerNeedId = typeof HER_NEED_IDS[number];
export const isHerNeedId = (value: unknown): value is HerNeedId =>
  typeof value === 'string' && (HER_NEED_IDS as readonly string[]).includes(value);

/** What the user did that can soothe her: patting her head (or her cheek), feeding her, a chat message. */
export type HerNeedKind = 'touch' | 'food' | 'chat';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface HerNeedSpec {
  /** Developer panel. */
  label: string;
  /** "你刚才…" for the chat line after she was soothed, and "（…）" in the line while it is still there. */
  chat: string;
  /** What she feels, for the inner loop's one speech chance. */
  speak: string;
  /**
   * When it can begin. `perMinute`: the chance per minute while its conditions hold (scaled by the trigger's
   * multiplier). `chanceOnWake`: the chance, once per waking, that she wakes with it.
   */
  onset: { perMinute: number } | { chanceOnWake: number };
  /** Full strength for `holdMs`, then a straight fade over `fadeMs`; nothing makes it stronger. */
  holdMs: number;
  fadeMs: number;
  /** What the stage shows at full strength (offsets on the procedural life; shared/her-life.ts). */
  presentation: HerLifePresentation;
  /**
   * What soothes it, as the amount of each that is enough on its own: milliseconds of patting, snacks, chat
   * messages. They add up (half a pat and half the snacks it takes also soothes her).
   */
  soothe: { touchMs: number; foods: number; chatTurns: number };
  /** The mood lifts by this when she is soothed (MoodHost.lift): the same saturation as any event, no new user interaction. */
  comfort: Partial<MoodValues>;
  /** How much 低落 (HER_NEED_DEJECTION) it adds each time it showed and nobody answered, before the card's sensitivity. */
  dejection: number;
}

const look = (values: Partial<HerLifePresentation>): HerLifePresentation => Object.freeze({ ...HER_LIFE_NEUTRAL_PRESENTATION, ...values });

/**
 * The table. Numbers are trial values for the user's trial; the stage offsets are small on purpose (a few degrees
 * of head, a slower blink): "she is a little off today", not a performance.
 */
export const HER_NEED_TABLE: Readonly<Record<HerNeedId, HerNeedSpec>> = Object.freeze({
  lonely: {
    label: '有点闷', chat: '有点闷', speak: '有点闷，一个人待久了，想有人陪陪、想被摸摸头',
    onset: { perMinute: 1 / 120 }, holdMs: 6 * MINUTE, fadeMs: 14 * MINUTE,
    presentation: look({ gazeX: 0.12, gazeY: -0.1, pointerFollow: 0.5, saccade: 0.55, lookAtUser: 1.6, headX: 0.02, headY: 0.02, headZ: 0.035,
      sway: 0.55, blinkInterval: 1.3, lidSoft: 0.14 }),
    soothe: { touchMs: 5_000, foods: 2, chatTurns: 2 },
    comfort: { D: 12, O: 12, E: 8 },
    dejection: 0.35,
  },
  dream: {
    label: '做了个不开心的梦', chat: '做了个不开心的梦', speak: '刚做了个不开心的梦，心里有点沉沉的，想有人在身边',
    onset: { chanceOnWake: 0.18 }, holdMs: 8 * MINUTE, fadeMs: 12 * MINUTE,
    presentation: look({ gazeX: 0.1, gazeY: -0.12, pointerFollow: 0.35, saccade: 0.35, lookAtUser: 0.6, headX: 0.03, headY: 0.015, headZ: 0.03,
      sway: 0.45, blinkInterval: 1.5, lidSoft: 0.22 }),
    soothe: { touchMs: 6_000, foods: 2, chatTurns: 2 },
    comfort: { D: 8, O: 14, E: 8 },
    dejection: 0.3,
  },
  lowEnergy: {
    label: '今天有点没精神', chat: '有点没精神', speak: '今天有点没精神，懒洋洋的',
    onset: { perMinute: 1 / 80 }, holdMs: 10 * MINUTE, fadeMs: 20 * MINUTE,
    presentation: look({ gazeY: -0.09, pointerFollow: 0.5, saccade: 0.45, lookAtUser: 0.5, headX: 0.025, headZ: 0.02,
      sway: 0.4, blinkInterval: 1.4, lidSoft: 0.3 }),
    soothe: { touchMs: 8_000, foods: 1, chatTurns: 3 },
    comfort: { D: 8, O: 8, E: 10 },
    dejection: 0.15,
  },
  chatty: {
    label: '无聊得想找人说话', chat: '有点无聊、想找人说话', speak: '有点无聊，想找人随便说说话',
    onset: { perMinute: 1 / 180 }, holdMs: 5 * MINUTE, fadeMs: 10 * MINUTE,
    presentation: look({ gazeX: 0.02, gazeY: 0.01, pointerFollow: 1.3, saccade: 1.35, lookAtUser: 2.2, headY: 0.01, headZ: 0.03,
      sway: 1.4, blinkInterval: 0.9, smileEyes: 0.05, mouthSmile: 0.12 }),
    soothe: { touchMs: 4_000, foods: 2, chatTurns: 2 },
    comfort: { D: 12, O: 8, E: 6 },
    dejection: 0.25,
  },
});

/** After she is soothed: she is plainly happy for a while, then it fades. Shown the same for every need. */
export const HER_NEED_GLOW = Object.freeze({
  holdMs: 4 * MINUTE, fadeMs: 10 * MINUTE,
  presentation: look({ gazeX: 0.02, pointerFollow: 1.2, lookAtUser: 1.8, headX: -0.008, headZ: 0.025, sway: 1.2,
    beatHz: 0.9, beatHead: 0.018, beatBody: 0.005, blinkInterval: 1, lidSoft: 0.04, smileEyes: 0.55, mouthSmile: 0.38 }),
});

// ---------------------------------------------------------------- what an unanswered need leaves: 低落, then 释然 (mood-loop design)

/**
 * A need that showed and went unanswered does not just fade away: it leaves 低落, a number 0..1 that piles up
 * with each such need (more for a sensitive card), is capped, and settles slowly by itself. It goes back into the mood as a small dip
 * (D and O a little lower: the more piled up, the bigger, capped), into the body as a quiet, subdued look (the `low` view, scaled by
 * it) and into her initiative (a dejected her starts fewer things: the limit function reads it). The moment the user does anything
 * with her it is over: a lift scaled by how much had piled up, and the label 释然 for a moment. It shows first of all in the face, the small
 * movements and how much she starts; in words it may only be a small 撒娇 inside the big line (principle 6 as the user corrected
 * it: a little guilt is care; never a lever, a punishment, a pile-on, an old account, or a reason to be afraid to leave).
 */
export const HER_NEED_DEJECTION = Object.freeze({
  cap: 1,
  /** It settles by itself with this half-life (a sensitive card takes longer, a carefree one less). Memory only: a restart starts clear. */
  halfLifeMs: 6 * HOUR,
  /** Below this it is gone (and a response needs at least this much to count as a relief). */
  clearBelow: 0.05,
  /** The dip when a need fades unanswered: D −(base + gain × 低落), O −(base + gain × 低落), scaled by the card's sensitivity. */
  dipBase: 2, dipGain: 4,
  /** The lift when the user finally comes: D and O +(base + gain × 低落), E half of that, C down by a third of it. */
  reliefBase: 4, reliefGain: 8,
});
/** How sensitive the card is to being left unanswered: close-leaning and cautious cards feel it more, carefree ones less. 1 = average. */
export function herNeedSensitivity(weights: Partial<Record<MoodTendency, number>> | null | undefined): number {
  const w = (tendency: MoodTendency) => clamp(finite(weights?.[tendency], 1), 0, 4);
  return clamp(0.4 + 0.4 * w('close') + 0.2 * w('cautious'), 0.4, 1.6);
}
/**
 * How plainly it shows (pretrial 2026-11-03, I-013: not one fixed size): the stage scales the look by this, ~0.7–1.5. A small feeling or
 * 低落 shows more on a sensitive card (close / cautious leaning, herNeedSensitivity) and the lower her mood is now (期待 D and 亲近 O
 * under the middle); the warmth after she was soothed shows more on a close or playful card and the happier she is now. Bounded so
 * the motion stays within R29's continuity (the stage follows it with the need's own 1.5 s easing; LIFE_LIMITS clamp the head).
 */
export function herNeedVisibility(mode: HerNeedView['mode'] | null | undefined, weights: Partial<Record<MoodTendency, number>> | null | undefined,
  values: Partial<MoodValues> | null | undefined): number {
  const mid = (finite(values?.D, 50) + finite(values?.O, 50)) / 2, w = (tendency: MoodTendency) => clamp(finite(weights?.[tendency], 1), 0, 4);
  if (mode === 'glow') return clamp(0.7 + 0.15 * w('close') + 0.15 * w('playful') + 0.3 * unit((mid - 50) / 25), 0.7, 1.5);
  return clamp(0.6 + 0.4 * herNeedSensitivity(weights) + 0.3 * unit((50 - mid) / 25), 0.7, 1.5);
}
/** How far the stage may push a look past its table value (herNeedVisibility's ceiling). */
export const HER_NEED_VISIBILITY_MAX = 1.5;

/** The small dip into the mood when a need fades unanswered, at this 低落 and sensitivity. */
export function herNeedDip(dejection: number, sensitivity: number): Partial<MoodValues> {
  const d = HER_NEED_DEJECTION, level = unit(dejection) / d.cap, k = clamp(sensitivity, 0.4, 1.6);
  return { D: -(d.dipBase + d.dipGain * level) * k, O: -(d.dipBase + d.dipGain * level) * k };
}
/** The lift into the mood when the user comes after she was left unanswered: more, the more had piled up. */
export function herNeedRelief(dejection: number): Partial<MoodValues> {
  const d = HER_NEED_DEJECTION, amount = d.reliefBase + d.reliefGain * unit(dejection) / d.cap;
  return { D: amount, O: amount, E: amount / 2, C: -amount / 3 };
}

/** What 低落 looks like (shown scaled by it; the `low` view): quieter, eyes lower, slower blinks, little swaying. Never a pout, never a mouth. */
export const HER_NEED_LOW = Object.freeze({
  presentation: look({ gazeX: 0.06, gazeY: -0.08, pointerFollow: 0.5, saccade: 0.45, lookAtUser: 0.7, headX: 0.03, headY: 0.015, headZ: 0.03,
    sway: 0.45, blinkInterval: 1.5, lidSoft: 0.14 }),
});

// ---------------------------------------------------------------- how often: her wish, softly pressed down

/**
 * "How often" is not "N a day" (a fixed cap is too stiff; reaching out should follow mood and character, and be
 * less rigidly capped; and "no answer, and she would rather not bring it up again" is more alive). So:
 *   1. WANT (`HerNeedTriggerFn`, 0..1): how much she wants to, from her mood (boredom, closeness, energy, the label, what she was
 *      doing) and the card's tendencies. 0 = cannot.
 *   2. SOFT FACTOR (`HerNeedLimitFn`, 0..1): how much has already happened (needs today, interactions since the last one and since
 *      this kind, the clock, the night) presses the rate down smoothly. A strong enough want climbs over it (HER_NEED_OVERRIDE_*).
 *      Without a `balance` this counts like the old fixed numbers did (about two a day, and not the same kind again soon) but
 *      smoothly. I-010 (互动余额): the app passes the interaction budget's room for a
 *      need (0..1) as `balance`; it replaces the two per-day terms (needs today, this kind today). Everything else stays: the
 *      spacing by the user's interactions, the warm-up, the quieter night, 低落 and the reluctance.
 *   3. RELUCTANCE (same function, NOT overridable by the want): a kind that showed and got no answer is remembered ("被晾过");
 *      she is much less willing to show that kind again, less and less so as time and the user's later interactions go by. The
 *      user's own pat, snack or words still soothe it as usual when it does come; nothing is ever said about it.
 * The hard rules left are the ones about not chasing the user: a need only gets weaker and fades when nobody answers, nothing new
 * begins until the user has interacted after one faded alone, she says at most one thing about a need, never at night or asleep,
 * and nothing shows while she sleeps or 自动表现 is off.
 */
/** "Ignored": the app has been open this long since the user last did anything with her. */
export const HER_NEED_IGNORED_MIN_MS = 40 * MINUTE;
/** A waking can still bring a bad dream for this long (she may be being touched at the moment of waking). */
export const HER_NEED_WAKE_WINDOW_MS = 3 * MINUTE;
/** A dream needs a real sleep behind it. */
export const HER_NEED_WAKE_MIN_SLEEP_MS = 10 * MINUTE;
/** The inner loop's speech chance only while the need is still at least this strong. */
export const HER_NEED_SPEAK_MIN_STRENGTH = 0.3;
/** Being soothed halfway makes it this much weaker (never stronger): strength × (1 − PERK × progress). */
export const HER_NEED_PERK = 0.5;
/** want (0..1) → rate per minute = the table's `perMinute` × this × want × the soft factor: a want of 0.5 runs at the table's own rate. */
export const HER_NEED_WANT_TO_RATE = 2;
/** A want above FROM starts to climb over the soft factor; at FULL it ignores it (never the reluctance). */
export const HER_NEED_OVERRIDE_FROM = 0.9;
export const HER_NEED_OVERRIDE_FULL = 1;
/** One "interaction" for the counts: a message, a snack, or about this many milliseconds of patting. */
export const HER_NEED_TOUCH_MS_PER_INTERACTION = 5_000;

/** The default numbers of the limit function (trial values; 等互动余额方案确认后替换). */
export const HER_NEED_LIMIT_DEFAULTS = Object.freeze({
  /** Needs started today press the rate with 1 / (1 + (started / perDay) ** dayPower): one is nearly free, a second still likely, then it falls off fast (about two a day, softly). */
  perDay: 1.3, dayPower: 6,
  /** The same kind again: × this for each time it already began today, and by interactions since it last began. */
  sameKindToday: 0.15, sameKindInteractions: 8, sameKindFloor: 0.2,
  /** Any two starts: by interactions since the last one; time only as a weaker second way (gapTimeWeight × the time term). */
  gapInteractions: 4, gapTimeMs: 3 * HOUR, gapTimeWeight: 0.5, gapFloor: 0.05,
  /** None at first in a run (a ramp), and a quieter night (the dream aside). */
  warmupMs: 15 * MINUTE, night: 0.2,
  /** 低落 makes her quieter: the soft factor × (1 − this × 低落). */
  dejectionQuiet: 0.6,
  /** 被晾过: right after a kind faded unanswered it is this much less likely; it fades with time and with interactions since. */
  reluctance: 0.97, reluctanceTauHours: 8, reluctanceTauInteractions: 10,
  /** A need that faded with less soothing than this (0..1) counts as unanswered. */
  unansweredBelowProgress: 0.5,
});

/** What the default trigger reads. `channels` and `baseline` are the five raw mood channels (T-106). */
export interface HerNeedSignals {
  now: number;
  localMinute: number;
  /** The inner loop's night window (shared/inner-loop.ts innerLoopQuiet). */
  night: boolean;
  fatiguePhase: FatiguePhase | null | undefined;
  /** Fatigue F, 0..1 (null: unknown). */
  fatigueF?: number | null;
  /** MoodSnapshot.boredom, 0..100. */
  boredom: number;
  /** MoodSnapshot.longing, 0..100: she is missing the user (the reunion's business, never a reason for a small sulk). */
  longing?: number;
  /** How long the app has been open without the user doing anything with her. Offline time never counts. */
  ignoredMs: number;
  mood: MoodLabel | string | null | undefined;
  channels: MoodValues;
  baseline: MoodValues;
  weights: Partial<Record<MoodTendency, number>> | null | undefined;
  /** The last waking from a sleep she was seen to have, while it is fresh; null otherwise. */
  wake: { at: number; sleptMs: number } | null;
}
/** How much she wants each need right now, 0..1; absent or 0 means it cannot start. The seam T-106 replaces. */
export type HerNeedTriggerFn = (signals: HerNeedSignals) => Partial<Record<HerNeedId, number>>;

const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const unit = (value: number) => clamp(value, 0, 1);
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const smooth01 = (value: number) => { const t = unit(value); return t * t * (3 - 2 * t); };

/** Feelings in which a small wish for company would be out of place (she is worried, hurt, or already missing the user). */
const HEAVY_MOODS: readonly string[] = ['concerned', 'disappointed', 'upset', 'sad', 'longing', 'tense-expectation'];
const LIGHT_MOODS: readonly string[] = ['calm', 'content', 'happy', 'excited', 'close', 'relieved'];
const LOW_ENERGY_FROM = 11 * 60;
const LOW_ENERGY_TO = 22 * 60;
const LIGHT_DROWSY_FROM = 0.38;
const LIGHT_DROWSY_TO = 0.58;

/**
 * The default wants, from the mood and the card:
 *   lonely    ignored 40+ minutes, bored (60+), closeness fallen back to its baseline (≤ +4), a heart that is not heavy; the more bored and the colder
 *             (closeness at or under its baseline), and the more the card leans close, the more she wants it;
 *   chatty    ignored 40+ minutes, very bored (75+), a light mood; more with boredom, with liveliness (D and E above baseline) and with the playful tendency;
 *   dream     woke (after at least 10 minutes asleep) within the last 3 minutes; more after a long sleep, a little more for a cautious card;
 *   lowEnergy lightly drowsy (not drowsy: that is her own "犯困"), between 11:00 and 22:00; more the closer to drowsy.
 * While she is missing the user (longing above 0) there is no lonely and no chatty: that is the reunion's business, and nothing
 * about the days the user was away may turn into a small sulk. "Closeness below its baseline": closeness only falls back to the
 * baseline, never under it (unless she was offended), so it reads as "at or near the baseline": nobody has been warm with her.
 * The night is not a condition here: the limit function quietens it (and speech is never offered at night).
 */
export const herNeedTriggers: HerNeedTriggerFn = s => {
  const out: Partial<Record<HerNeedId, number>> = {};
  const mood = typeof s.mood === 'string' ? s.mood : '';
  const weight = (tendency: MoodTendency) => clamp(finite(s.weights?.[tendency], 1), 0.3, 2);
  const ignored = s.ignoredMs >= HER_NEED_IGNORED_MIN_MS && !(finite(s.longing, 0) > 0);
  const bored = (from: number) => unit((s.boredom - from) / (100 - from));
  const warmth = finite(s.channels?.O, 50) - finite(s.baseline?.O, 50);
  if (ignored && !HEAVY_MOODS.includes(mood) && s.boredom >= 60 && warmth <= 4)
    out.lonely = unit((0.3 + 0.45 * bored(60) + 0.25 * unit((4 - warmth) / 8)) * (0.7 + 0.3 * weight('close')));
  if (ignored && LIGHT_MOODS.includes(mood) && s.boredom >= 75) {
    const lively = unit((finite(s.channels?.D, 50) - finite(s.baseline?.D, 50) + finite(s.channels?.E, 50) - finite(s.baseline?.E, 50)) / 20);
    out.chatty = unit((0.3 + 0.45 * bored(75) + 0.25 * lively) * (0.7 + 0.3 * weight('playful')));
  }
  if (s.wake && s.wake.sleptMs >= HER_NEED_WAKE_MIN_SLEEP_MS && s.now - s.wake.at >= 0 && s.now - s.wake.at <= HER_NEED_WAKE_WINDOW_MS)
    out.dream = unit((0.5 + 0.5 * Math.min(1, s.wake.sleptMs / (8 * HOUR))) * (0.8 + 0.2 * weight('cautious')));
  const minute = Number.isFinite(s.localMinute) ? s.localMinute : 0;
  if (s.fatiguePhase === 'light-drowsy' && minute >= LOW_ENERGY_FROM && minute < LOW_ENERGY_TO)
    out.lowEnergy = unit(0.4 + 0.6 * unit((finite(s.fatigueF, LIGHT_DROWSY_FROM) - LIGHT_DROWSY_FROM) / (LIGHT_DROWSY_TO - LIGHT_DROWSY_FROM)));
  return out;
};

// ---------------------------------------------------------------- the limit function

/** What the limit function reads: counts and times, and a slot for the 互动余额 plan. */
export interface HerNeedLimitInput {
  now: number;
  /** Milliseconds since this run of the app began. */
  runMs: number;
  /** The needs that began today, in order (a kind may appear twice). */
  startsToday: readonly HerNeedId[];
  lastStartAt: number | null;
  /** The user's interactions (a message, a snack, about 5 s of patting, each one) since the last need began; null: none has yet. */
  interactionsSinceLastStart: number | null;
  /** …since each kind last began; a kind that never began is absent. */
  interactionsSinceKind: Partial<Record<HerNeedId, number>>;
  /** The user's interactions today (reserved for the interaction-balance plan). */
  interactionsToday: number;
  /** Kinds that showed and got no answer ("被晾过"): how long ago, and how many interactions since. */
  snubbed: Partial<Record<HerNeedId, { ageMs: number; interactionsSince: number }>>;
  night: boolean;
  /** 低落, 0..1 (HER_NEED_DEJECTION): a dejected her starts fewer things. */
  dejection: number;
  /**
   * I-010 互动余额: the budget's room for a need now (0..1, InteractionBudget.room(id, 'need').factor). null: not wired, and the old
   * per-day curve applies.
   */
  balance: number | null;
}
/**
 * `soft` (0..1) presses the rate down smoothly and a strong want can climb over it; `reluctance` (0..1) is her not wanting to bring
 * this kind up again after it went unanswered, and no want climbs over it. 1 = no pressure.
 */
export interface HerNeedLimitVerdict { soft: number; reluctance: number }
/** The one function that decides how pressed down each kind is; replaced as a whole when the interaction-balance plan is confirmed. */
export type HerNeedLimitFn = (input: HerNeedLimitInput, id: HerNeedId) => HerNeedLimitVerdict;

export const herNeedLimits: HerNeedLimitFn = (input, id) => {
  const c = HER_NEED_LIMIT_DEFAULTS;
  // I-010: with the budget wired its room replaces both per-day terms; without it, the old "about two a day" curve.
  const budgeted = typeof input.balance === 'number' && Number.isFinite(input.balance);
  const day = budgeted ? unit(input.balance as number) : 1 / (1 + Math.pow(input.startsToday.length / c.perDay, c.dayPower));
  const sameToday = budgeted ? 0 : input.startsToday.filter(kind => kind === id).length, sinceKind = input.interactionsSinceKind[id];
  const kind = Math.pow(c.sameKindToday, sameToday)
    * (sinceKind === undefined ? 1 : c.sameKindFloor + (1 - c.sameKindFloor) * smooth01(sinceKind / c.sameKindInteractions));
  // Between any two starts the user's interactions count most; time is a weaker second way (a long quiet day lets the next one come).
  const gap = input.lastStartAt === null ? 1
    : Math.max(c.gapFloor, smooth01(finite(input.interactionsSinceLastStart, 0) / c.gapInteractions), c.gapTimeWeight * smooth01((input.now - input.lastStartAt) / c.gapTimeMs));
  const warmup = smooth01(input.runMs / c.warmupMs);
  const night = input.night && id !== 'dream' ? c.night : 1;
  const quiet = 1 - c.dejectionQuiet * unit(input.dejection);
  const snub = input.snubbed[id];
  const reluctance = snub
    ? 1 - c.reluctance * Math.exp(-Math.max(0, snub.ageMs) / (c.reluctanceTauHours * HOUR)) * Math.exp(-Math.max(0, snub.interactionsSince) / c.reluctanceTauInteractions)
    : 1;
  return { soft: unit(day * kind * gap * warmup * night * quiet), reluctance: unit(reluctance) };
};

/** The effective pressure on a kind at a want: the soft factor, climbed over by a strong want, times the reluctance. */
export function herNeedPressure(want: number, verdict: HerNeedLimitVerdict): number {
  const soft = unit(verdict.soft), override = smooth01((unit(want) - HER_NEED_OVERRIDE_FROM) / (HER_NEED_OVERRIDE_FULL - HER_NEED_OVERRIDE_FROM));
  return (soft + (1 - soft) * override) * unit(verdict.reluctance);
}
/** The chance per minute that a rate-driven kind begins (0 for a kind that begins on waking). */
export function herNeedStartRate(id: HerNeedId, want: number, verdict: HerNeedLimitVerdict): number {
  const onset = HER_NEED_TABLE[id].onset;
  return 'perMinute' in onset ? onset.perMinute * HER_NEED_WANT_TO_RATE * unit(want) * herNeedPressure(want, verdict) : 0;
}
/** The chance that she wakes with a bad dream (once per waking). */
export function herNeedWakeChance(want: number, verdict: HerNeedLimitVerdict): number {
  const onset = HER_NEED_TABLE.dream.onset;
  return 'chanceOnWake' in onset ? unit(onset.chanceOnWake * HER_NEED_WANT_TO_RATE * unit(want)) * herNeedPressure(want, verdict) : 0;
}

// ---------------------------------------------------------------- the state machine

export interface HerNeedActive {
  id: HerNeedId;
  since: number;
  /** 0..1: how far the user's pats, snacks and words have soothed it (1 = soothed). */
  progress: number;
  /** The inner loop's one speech chance has been given. */
  spoke: boolean;
  /** The one chat line about it has been told. */
  told: boolean;
}
export interface HerNeedGlow { id: HerNeedId; since: number; via: HerNeedKind; told: boolean }
/** A kind that showed and went unanswered: when, and how many interactions had been counted by then. */
export interface HerNeedSnub { at: number; interactions: number }
export interface HerNeedState {
  /** The local date the day's counts belong to. */
  day: string;
  /** Needs that have begun today (a kind may appear twice). */
  used: HerNeedId[];
  lastStartAt: number | null;
  /** The user's interactions counted so far (fractions: patting counts by 5-second units) and today. */
  interactions: number;
  interactionsToday: number;
  /** The interaction count when the last need began, and when each kind last began. */
  lastStartInteractions: number | null;
  kindStartInteractions: Partial<Record<HerNeedId, number>>;
  /** 被晾过: the kinds that faded unanswered, until the user soothes one of them or the memory has faded. */
  snubs: Partial<Record<HerNeedId, HerNeedSnub>>;
  /** 低落, 0..1 (HER_NEED_DEJECTION): piles up with each need that fades unanswered, settles slowly, ends when the user does anything. Memory only. */
  dejection: number;
  /** The kind whose going unanswered left it (the `low` view names it). */
  lowKind: HerNeedId | null;
  active: HerNeedActive | null;
  glow: HerNeedGlow | null;
  /** The user has interacted since the last need faded unanswered: another may begin. Cleared when one fades alone. */
  armed: boolean;
  lastStepAt: number | null;
  /** A bad dream rolled "yes" at waking: it starts as soon as she is free, until this time. */
  dreamUntil: number | null;
  /** The waking (its time) already rolled. */
  wokeRolled: number | null;
}
export function createHerNeedState(day: string): HerNeedState {
  return { day, used: [], lastStartAt: null, interactions: 0, interactionsToday: 0, lastStartInteractions: null, kindStartInteractions: {}, snubs: {},
    dejection: 0, lowKind: null, active: null, glow: null, armed: true, lastStepAt: null, dreamUntil: null, wokeRolled: null };
}

export type HerNeedEventType = 'started' | 'soothed' | 'faded' | 'cleared' | 'glow-ended';
export interface HerNeedEvent {
  type: HerNeedEventType; id: HerNeedId; via?: HerNeedKind;
  /** `faded` with (almost) no answer: remembered as 被晾过, it left 低落 (`dejection`, after) and this small dip for the mood. */
  snubbed?: boolean; dejection?: number; dip?: Partial<MoodValues>;
}

export interface HerNeedStepInput {
  now: number;
  /** The local date key (YYYY-MM-DD). */
  day: string;
  /** "自动表现" on (MoodView.expressions). Off: nothing shows, nothing starts. */
  expressions: boolean;
  /** The existing canExpress gate and an idle mood phase: nobody is touching or chatting with her right now. */
  idle: boolean;
  /** When this run of the app began (the warm-up is counted from it). */
  startedAt: number;
  signals: HerNeedSignals;
  trigger?: HerNeedTriggerFn;
  limits?: HerNeedLimitFn;
  /** I-010 互动余额: the budget's room for a need now, 0..1 (passed on to the limit function); null or absent: not wired. */
  balance?: number | null;
}

const asleepNow = (phase: FatiguePhase | null | undefined) => phase === 'asleep' || phase === 'micro-awake' || phase === 'falling-asleep';

export function herNeedTotalMs(id: HerNeedId): number { return HER_NEED_TABLE[id].holdMs + HER_NEED_TABLE[id].fadeMs; }
const GLOW_TOTAL_MS = HER_NEED_GLOW.holdMs + HER_NEED_GLOW.fadeMs;

/** How much of it shows now (0..1): full while it holds, a straight fade after that, weaker the more she has been soothed. Never rises. */
export function herNeedStrength(active: Pick<HerNeedActive, 'id' | 'since' | 'progress'>, now: number): number {
  const spec = HER_NEED_TABLE[active.id], age = Math.max(0, now - active.since);
  const fade = age <= spec.holdMs ? 1 : Math.max(0, 1 - (age - spec.holdMs) / spec.fadeMs);
  return clamp(fade * (1 - HER_NEED_PERK * clamp(active.progress, 0, 1)), 0, 1);
}
export function herNeedGlowStrength(glow: Pick<HerNeedGlow, 'since'>, now: number): number {
  const age = Math.max(0, now - glow.since);
  return age <= HER_NEED_GLOW.holdMs ? 1 : Math.max(0, 1 - (age - HER_NEED_GLOW.holdMs) / HER_NEED_GLOW.fadeMs);
}

/** The hard gates on beginning anything (null: free). Not counts and not feelings: the user is here, she is occupied, or she was left unanswered. */
function blockedFromStarting(state: HerNeedState, input: HerNeedStepInput): string | null {
  if (!input.expressions) return 'off';
  if (!input.idle) return 'busy';
  if (state.active || state.glow) return 'occupied';
  if (!state.armed) return 'unanswered';
  return null;
}

/** What the limit function is given for this moment. */
export function herNeedLimitInput(state: HerNeedState, input: Pick<HerNeedStepInput, 'now' | 'startedAt' | 'balance'> & { night: boolean }): HerNeedLimitInput {
  const since = (count: number) => Math.max(0, state.interactions - count);
  const kinds: Partial<Record<HerNeedId, number>> = {}, snubbed: HerNeedLimitInput['snubbed'] = {};
  for (const id of HER_NEED_IDS) {
    const began = state.kindStartInteractions[id], snub = state.snubs[id];
    if (began !== undefined) kinds[id] = since(began);
    if (snub) snubbed[id] = { ageMs: Math.max(0, input.now - snub.at), interactionsSince: since(snub.interactions) };
  }
  return { now: input.now, runMs: Math.max(0, input.now - input.startedAt), startsToday: state.used, lastStartAt: state.lastStartAt,
    interactionsSinceLastStart: state.lastStartInteractions === null ? null : since(state.lastStartInteractions), interactionsSinceKind: kinds,
    interactionsToday: state.interactionsToday, snubbed, night: input.night, dejection: unit(state.dejection), balance: typeof input.balance === 'number' && Number.isFinite(input.balance) ? input.balance : null };
}

/**
 * One host tick. Starts at most one need, fades or ends the current one, and rolls the day over.
 * `events` are for the developer log only.
 */
export function stepHerNeed(state: HerNeedState, input: HerNeedStepInput, random: () => number): { state: HerNeedState; events: HerNeedEvent[] } {
  const events: HerNeedEvent[] = [];
  const next: HerNeedState = { ...state, used: [...state.used], kindStartInteractions: { ...state.kindStartInteractions }, snubs: { ...state.snubs },
    active: state.active && { ...state.active }, glow: state.glow && { ...state.glow } };
  const now = input.now;
  const dt = state.lastStepAt === null ? 0 : clamp(now - state.lastStepAt, 0, 5_000);
  next.lastStepAt = now;
  if (input.day !== next.day) { next.day = input.day; next.used = []; next.interactionsToday = 0; }
  const phase = input.signals.fatiguePhase;
  // 低落 settles by itself (slower for a sensitive card); this tick's decay uses the same capped dt as the rate.
  const sensitivity = herNeedSensitivity(input.signals.weights);
  if (next.dejection > 0) {
    next.dejection *= Math.pow(0.5, dt / (HER_NEED_DEJECTION.halfLifeMs * clamp(sensitivity, 0.5, 1.6)));
    if (next.dejection < HER_NEED_DEJECTION.clearBelow) { next.dejection = 0; next.lowKind = null; }
  }
  // Off, or asleep: whatever shows is put away at once (nothing is refunded: it still began today, and it is not 被晾过).
  if (!input.expressions || asleepNow(phase)) {
    if (next.active) { events.push({ type: 'cleared', id: next.active.id }); next.active = null; }
    if (next.glow) { events.push({ type: 'cleared', id: next.glow.id }); next.glow = null; }
    next.dreamUntil = null;
    return { state: next, events };
  }
  if (next.active && now - next.active.since >= herNeedTotalMs(next.active.id)) {
    // Faded alone: nothing more until the user has interacted again, and (if hardly anyone answered) she remembers this kind went
    // unanswered. It never comes back bigger.
    const id = next.active.id, snubbed = next.active.progress < HER_NEED_LIMIT_DEFAULTS.unansweredBelowProgress;
    if (snubbed) {
      next.snubs[id] = { at: now, interactions: next.interactions };
      // It piles up (capped), and goes back into the mood as a small dip, more the more has piled up.
      next.dejection = Math.min(HER_NEED_DEJECTION.cap, next.dejection + HER_NEED_TABLE[id].dejection * sensitivity);
      next.lowKind = id;
      events.push({ type: 'faded', id, snubbed: true, dejection: next.dejection, dip: herNeedDip(next.dejection, sensitivity) });
    } else events.push({ type: 'faded', id });
    next.active = null; next.armed = false;
  }
  if (next.glow && now - next.glow.since >= GLOW_TOTAL_MS) { events.push({ type: 'glow-ended', id: next.glow.id }); next.glow = null; }
  if (next.dreamUntil !== null && now > next.dreamUntil) next.dreamUntil = null;

  const wants = (input.trigger ?? herNeedTriggers)(input.signals), limits = input.limits ?? herNeedLimits;
  const limitInput = herNeedLimitInput(next, { now, startedAt: input.startedAt, balance: input.balance, night: input.signals.night });
  const verdict = (id: HerNeedId) => limits(limitInput, id);
  // A waking: one roll for a bad dream (whatever she is doing at the moment, so a touch at that moment cannot cost the roll).
  const wake = input.signals.wake;
  if (wake && next.wokeRolled !== wake.at) {
    next.wokeRolled = wake.at;
    const want = finite(wants.dream, 0);
    if (want > 0 && random() < herNeedWakeChance(want, verdict('dream'))) next.dreamUntil = wake.at + HER_NEED_WAKE_WINDOW_MS;
  }

  if (blockedFromStarting(next, input)) return { state: next, events };
  const start = (id: HerNeedId) => {
    next.active = { id, since: now, progress: 0, spoke: false, told: false };
    next.used = [...next.used, id]; next.lastStartAt = now; next.dreamUntil = null;
    next.lastStartInteractions = next.interactions; next.kindStartInteractions[id] = next.interactions;
    events.push({ type: 'started', id });
  };
  // The bad dream she woke with begins as soon as she is free.
  if (next.dreamUntil !== null) { start('dream'); return { state: next, events }; }
  let best: { id: HerNeedId; rate: number } | null = null;
  for (const id of HER_NEED_IDS) {
    const want = finite(wants[id], 0);
    // Drowsy is her own "犯困" (shared/her-life.ts); only a bad dream may be told while she is still drowsy from waking.
    if (!(want > 0) || phase === 'drowsy' || !('perMinute' in HER_NEED_TABLE[id].onset)) continue;
    const rate = herNeedStartRate(id, want, verdict(id));
    if (random() < 1 - Math.exp(-rate * dt / MINUTE) && (!best || rate > best.rate)) best = { id, rate };
  }
  if (best) start(best.id);
  return { state: next, events };
}

/**
 * The user did something with her. It always counts as "the user is here" (another need may come, later) and as an interaction
 * (the limit function counts them), and soothes the one she has: touch by the measured milliseconds of patting, food by snacks,
 * chat by messages. Soothing a kind also lets go of its 被晾过. If 低落 had piled up, the first thing the user does ends it:
 * `relieved` is how much there was (0..1), for the lift and the label 释然 (herNeedRelief).
 */
export interface HerNeedInteractionResult { state: HerNeedState; soothed: HerNeedId | null; relieved: number | null }
export function noteHerNeedInteraction(state: HerNeedState, kind: HerNeedKind, amount: number, now: number): HerNeedInteractionResult {
  // No amount (0, negative, NaN, Infinity) is no interaction: nothing changes, not even "armed" (T-112 round-007).
  if (!(amount > 0) || !Number.isFinite(amount)) return { state: { ...state }, soothed: null, relieved: null };
  const next: HerNeedState = { ...state, active: state.active && { ...state.active }, armed: true, snubs: { ...state.snubs } };
  const counted = kind === 'touch' ? amount / HER_NEED_TOUCH_MS_PER_INTERACTION : amount;
  next.interactions += counted; next.interactionsToday += counted;
  // 释然: the user came. Whatever had piled up is over (it is not carried into the next hour or the next need).
  const relieved = next.dejection >= HER_NEED_DEJECTION.clearBelow ? next.dejection : null;
  next.dejection = 0; next.lowKind = null;
  const active = next.active;
  if (!active) return { state: next, soothed: null, relieved };
  const need = HER_NEED_TABLE[active.id].soothe;
  const required = kind === 'touch' ? need.touchMs : kind === 'food' ? need.foods : need.chatTurns;
  active.progress = clamp(active.progress + (required > 0 ? amount / required : 1), 0, 1);
  if (active.progress < 1) return { state: next, soothed: null, relieved };
  next.active = null;
  next.glow = { id: active.id, since: now, via: kind, told: false };
  delete next.snubs[active.id];
  return { state: next, soothed: active.id, relieved };
}

// ---------------------------------------------------------------- views

/** Host → stage and developer panel. Names, times and a strength: no text. */
export interface HerNeedView {
  id: HerNeedId;
  /** `need`: she has it; `glow`: she was soothed and is still warm; `low`: a need went unanswered and 低落 is still with her (strength = 低落). */
  mode: 'need' | 'glow' | 'low';
  since: number;
  /** 0..1 at the moment of the view; only ever falls while the need runs. */
  strength: number;
  /** How many needs have started today (for the developer panel). */
  usedToday: number;
}
export function herNeedView(state: HerNeedState, now: number): HerNeedView | null {
  if (state.active) {
    const strength = herNeedStrength(state.active, now);
    return strength > 0 ? { id: state.active.id, mode: 'need', since: state.active.since, strength, usedToday: state.used.length } : null;
  }
  if (state.glow) {
    const strength = herNeedGlowStrength(state.glow, now);
    return strength > 0 ? { id: state.glow.id, mode: 'glow', since: state.glow.since, strength, usedToday: state.used.length } : null;
  }
  if (state.lowKind && state.dejection >= HER_NEED_DEJECTION.clearBelow)
    return { id: state.lowKind, mode: 'low', since: state.snubs[state.lowKind]?.at ?? now, strength: unit(state.dejection), usedToday: state.used.length };
  return null;
}
export function readHerNeedView(value: unknown): HerNeedView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isHerNeedId(v.id) || (v.mode !== 'need' && v.mode !== 'glow' && v.mode !== 'low') || typeof v.strength !== 'number' || !Number.isFinite(v.strength)
    || typeof v.since !== 'number' || !Number.isFinite(v.since)) return null;
  return { id: v.id, mode: v.mode, since: v.since, strength: clamp(v.strength, 0, 1), usedToday: typeof v.usedToday === 'number' && Number.isFinite(v.usedToday) ? v.usedToday : 0 };
}

const PRESENTATION_KEYS = Object.keys(HER_LIFE_NEUTRAL_PRESENTATION) as (keyof HerLifePresentation)[];
/**
 * The stage's target at a strength: the table's offsets scaled from "none" (the neutral life) to full. `out` is written and returned
 * when given (the frame loop reuses one object).
 */
export function scaledHerNeedPresentation(view: Pick<HerNeedView, 'id' | 'mode'>, strength: number, out?: HerLifePresentation): HerLifePresentation {
  const target = view.mode === 'glow' ? HER_NEED_GLOW.presentation : view.mode === 'low' ? HER_NEED_LOW.presentation : HER_NEED_TABLE[view.id].presentation, k = clamp(strength, 0, HER_NEED_VISIBILITY_MAX);
  const result = out ?? { ...HER_LIFE_NEUTRAL_PRESENTATION };
  for (const key of PRESENTATION_KEYS) result[key] = HER_LIFE_NEUTRAL_PRESENTATION[key] + (target[key] - HER_LIFE_NEUTRAL_PRESENTATION[key]) * k;
  return result;
}

/** Developer panel line (also used by tests). */
export function formatHerNeedLine(view: HerNeedView | null | undefined, now = Date.now()): string {
  if (!view) return '她的小情绪：没有';
  const minutes = Math.max(0, Math.floor((now - view.since) / MINUTE));
  const label = view.mode === 'glow' ? `被哄好了，还开心着（${HER_NEED_TABLE[view.id].label}）`
    : view.mode === 'low' ? `有点低落（${HER_NEED_TABLE[view.id].label}，没人接）` : HER_NEED_TABLE[view.id].label;
  return `她的小情绪：${label} · 已经 ${minutes} 分钟 · 强度 ${Math.round(view.strength * 100)}% · 今天第 ${Math.max(1, view.usedToday)} 次`;
}

// ---------------------------------------------------------------- words (private context, never the fixed system prompt)

/**
 * The "big line" in her words (the user's correction, 2026-11-03: a little guilt is care; these are the few things it must never
 * become). Used in every line below, so a change is made once.
 */
export const BIG_LINE_WORDS = '不拿它惩罚或控制用户，不让用户不敢离开，不加码，不翻旧账';
const SAD_USER_WORDS = '如果用户这次带来的是难过的事，先陪着用户，不撒娇抱怨';

/**
 * The inner loop's one speech chance, as one line of the prompt of that opportunity. She may say one very short, cute
 * thing in her own voice, or choose not to. It may be a small 撒娇 or a little sulk, in her character; it asks nothing of the
 * user, is no lever (BIG_LINE_WORDS), never grows.
 */
export function herNeedSpeechLine(id: HerNeedId): string {
  if (!isHerNeedId(id)) return '';
  return `你此刻有一点轻轻的小情绪：${HER_NEED_TABLE[id].speak}。这次如果开口，只说一句很短、很可爱的话，用你自己的口吻轻轻说出来；按你的性格，可以小小地撒个娇、别扭一下，但只是小情绪的分量：不要求用户做什么，${BIG_LINE_WORDS}，也不要越说越委屈。不想说就选别的。`;
}
/**
 * One line for the one chat turn she has it in (`need`: still there, the user came; `soothed`: the user just soothed her;
 * `relief`: the user came after she was left unanswered). She is the one who makes up first, and does not bring up the old
 * let-down as an account to settle.
 */
export function herNeedChatLine(kind: 'need' | 'soothed' | 'relief', id?: HerNeedId): string {
  if (kind === 'relief') return `你前面一个人待着有点低落；用户来了，你松了口气，很开心。按你的性格可以小小地撒个娇、嘀咕一句，但随即由你先给台阶、先和好：${BIG_LINE_WORDS}。${SAD_USER_WORDS}。`;
  if (!isHerNeedId(id)) return '';
  const spec = HER_NEED_TABLE[id];
  return kind === 'need'
    ? `你此刻有一点轻轻的小情绪（${spec.chat}）；用户来了，你很高兴。按你的性格可以小小地撒个娇、别扭一下，也可以不提，但只是小情绪的分量：${BIG_LINE_WORDS}；你先和好。${SAD_USER_WORDS}。`
    : `你刚才${spec.chat}，被用户哄好了，现在心情明显变好、很开心。自然地开心就好，不用解释，也不翻之前的不开心。`;
}

/**
 * The chat turn: the user is soothing her with a message. Tells the line for this turn once per state.
 * `soothed` is the need this very message soothed (from noteHerNeedInteraction), if any.
 */
export function takeHerNeedChatLine(state: HerNeedState, soothed: HerNeedId | null, relieved: number | null, now: number): { state: HerNeedState; line: string } {
  const next: HerNeedState = { ...state, active: state.active && { ...state.active }, glow: state.glow && { ...state.glow } };
  if (soothed && next.glow && next.glow.id === soothed) { next.glow.told = true; return { state: next, line: herNeedChatLine('soothed', soothed) }; }
  // The user came after she was left unanswered: glad, said once (the first message).
  if (relieved !== null) return { state: next, line: herNeedChatLine('relief') };
  if (next.active && !next.active.told && herNeedStrength(next.active, now) > 0) {
    next.active.told = true;
    return { state: next, line: herNeedChatLine('need', next.active.id) };
  }
  if (next.glow && !next.glow.told && herNeedGlowStrength(next.glow, now) > 0) {
    next.glow.told = true;
    return { state: next, line: herNeedChatLine('soothed', next.glow.id) };
  }
  return { state: next, line: '' };
}

/**
 * Look, don't take (I-020 #10, electron/inner-loop/opening-host.ts): the need takeHerNeedSpeech would give now, without giving it.
 * The opening choice weighs "she has a small need" with this before anything is chosen; only the inner loop's prompt spends it.
 */
export function peekHerNeedSpeech(state: HerNeedState, now: number): HerNeedId | null {
  const active = state.active;
  return !active || active.spoke || herNeedStrength(active, now) < HER_NEED_SPEAK_MIN_STRENGTH ? null : active.id;
}

/** The inner loop's one speech chance for the need she has now; null when there is none (or it was given, or it has nearly faded). */
export function takeHerNeedSpeech(state: HerNeedState, now: number): { state: HerNeedState; id: HerNeedId | null } {
  const active = state.active;
  if (!active || active.spoke || herNeedStrength(active, now) < HER_NEED_SPEAK_MIN_STRENGTH) return { state, id: null };
  return { state: { ...state, active: { ...active, spoke: true } }, id: active.id };
}

// ---------------------------------------------------------------- welcome back (the user comes back after a long time)

/**
 * The line that replaces "主感受…" in the chat context (and the inner loop's) once she has been missing the user, and for
 * the moment of the reunion: she is glad to see the user. Before this the first reply after a long absence was written under
 * "主感受伤感" and "不因先前舒适而强行欢快", which pulls toward reproach. A little 撒娇 ("想你了", a small mutter) is fine and in
 * character (the user's correction, 2026-11-03); what it must not become is a punishment, a pile-on, an old account, or a reason
 * the user is afraid to leave again. She is the one who makes up first.
 */
export const WELCOME_BACK_LINE =
  '用户隔了一阵子才又出现。你很想用户，见到用户非常开心：让想念变成见面的欢喜和撒娇，按你自己的性格表达（傲娇的也可以藏不住高兴），'
  + '可以小小地嘀咕一句，但只是撒娇的分量：不惩罚、不加码、不翻旧账，不要用户道歉或补偿，不让用户不敢再离开；由你先给台阶、先和好。'
  + `${SAD_USER_WORDS}，欢喜放在后面`;

export function welcomeBackLine(input: { longing: number; longingAt: number; lastInteractionAt: number | null; reunion: boolean }): string {
  if (input.reunion) return WELCOME_BACK_LINE;
  return input.lastInteractionAt !== null && Number.isFinite(input.longing) && input.longing > 0 && input.longing >= input.longingAt ? WELCOME_BACK_LINE : '';
}

// ---------------------------------------------------------------- storage

/**
 * What survives a restart (so a restart is no way round the pressure, and a kind that was left unanswered is still remembered):
 * today's starts, the interaction counts the limit function reads, and the 被晾过 memory. Never a need that was showing.
 */
export interface HerNeedSaved {
  day: string;
  used: HerNeedId[];
  lastStartAt: number | null;
  interactions: number;
  interactionsToday: number;
  lastStartInteractions: number | null;
  kindStartInteractions: Partial<Record<HerNeedId, number>>;
  snubs: Partial<Record<HerNeedId, HerNeedSnub>>;
}
export function serializeHerNeedState(state: HerNeedState): HerNeedSaved {
  return { day: state.day, used: [...state.used], lastStartAt: state.lastStartAt, interactions: state.interactions, interactionsToday: state.interactionsToday,
    lastStartInteractions: state.lastStartInteractions, kindStartInteractions: { ...state.kindStartInteractions },
    snubs: Object.fromEntries(Object.entries(state.snubs).map(([id, snub]) => [id, { ...snub }])) as HerNeedSaved['snubs'] };
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e12;
const stamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function readHerNeedSaved(value: unknown): HerNeedSaved | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(v.day) || !Array.isArray(v.used) || v.used.length > 16 || !v.used.every(isHerNeedId)
    || (v.lastStartAt !== null && !stamp(v.lastStartAt))) return null;
  // The counts are optional (a file from before they existed) but never wrong.
  const interactions = v.interactions === undefined ? 0 : v.interactions, today = v.interactionsToday === undefined ? 0 : v.interactionsToday;
  const lastStartInteractions = v.lastStartInteractions === undefined ? null : v.lastStartInteractions;
  if (!count(interactions) || !count(today) || (lastStartInteractions !== null && !count(lastStartInteractions))) return null;
  const kinds: Partial<Record<HerNeedId, number>> = {}, snubs: Partial<Record<HerNeedId, HerNeedSnub>> = {};
  for (const [name, source, apply] of [
    ['kindStartInteractions', v.kindStartInteractions, (id: HerNeedId, row: unknown) => { if (!count(row)) return false; kinds[id] = row; return true; }],
    ['snubs', v.snubs, (id: HerNeedId, row: unknown) => {
      const snub = row as Record<string, unknown> | null;
      if (!snub || typeof snub !== 'object' || !stamp(snub.at) || !count(snub.interactions)) return false;
      snubs[id] = { at: snub.at, interactions: snub.interactions }; return true;
    }],
  ] as const) {
    if (source === undefined) continue;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    for (const [id, row] of Object.entries(source)) if (!isHerNeedId(id) || !apply(id, row)) return null;
    void name;
  }
  return { day: v.day, used: v.used as HerNeedId[], lastStartAt: v.lastStartAt as number | null, interactions, interactionsToday: today, lastStartInteractions, kindStartInteractions: kinds, snubs };
}
export function restoreHerNeedState(saved: HerNeedSaved): HerNeedState {
  return { ...createHerNeedState(saved.day), used: [...saved.used], lastStartAt: saved.lastStartAt, interactions: saved.interactions, interactionsToday: saved.interactionsToday,
    lastStartInteractions: saved.lastStartInteractions, kindStartInteractions: { ...saved.kindStartInteractions }, snubs: { ...saved.snubs } };
}
