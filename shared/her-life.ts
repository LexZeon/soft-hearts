/**
 * 她自己的生活 (roadmap core item 4, principle 4; plan docs/claude/2026-11-02-her-life-plan.md,
 * record docs/claude/2026-11-02-her-life.md): what she is doing while the user is away.
 *
 * One data table drives everything: which states exist, how the host picks one (time of day, mood,
 * the card's tendency weights), how long one lasts (the card's own small-motion interval), what the
 * stage shows (offsets for the R18 procedural life, an optional existing library motion) and the
 * words used for the chat context and the diary. A new state ("看书", "伸懒腰", "被传染") is one
 * more row. Pure: no timer, no I/O, no clock; randomness is passed in.
 */
import type { FatiguePhase } from './fatigue';
import type { MoodLabel, MoodParameters, MoodTendency } from './mood';

export const HER_LIFE_ACTIVITIES = ['company', 'daydream', 'humming', 'thinking', 'drowsy', 'watching'] as const;
export type HerLifeActivity = typeof HER_LIFE_ACTIVITIES[number];
export const isHerLifeActivity = (value: unknown): value is HerLifeActivity =>
  typeof value === 'string' && (HER_LIFE_ACTIVITIES as readonly string[]).includes(value);

/** The library motions a state may add (Gene's own, pinned by the host: electron/her-life/motion-resource.ts). */
export const HER_LIFE_MOTION_IDS = ['thinking', 'sleepy'] as const;
export type HerLifeMotionId = typeof HER_LIFE_MOTION_IDS[number];
export const isHerLifeMotionId = (value: unknown): value is HerLifeMotionId =>
  typeof value === 'string' && (HER_LIFE_MOTION_IDS as readonly string[]).includes(value);
/** The renderer's grant for one of those motions: host-pinned bytes behind an mmd-asset URL. */
export interface HerLifeMotionResource { motionId: HerLifeMotionId; sha256: string; durationMs: number; url: string }

/** Who started the current state: first launch, the rules, the inner loop, the fatigue model, or the user's return. */
export type HerLifeSource = 'start' | 'rule' | 'inner' | 'fatigue' | 'return';

/**
 * What the stage shows for one state. Offsets are added to the R18 procedural life (src/stage/procedural-life.ts)
 * in its own units; multipliers are 1 for "unchanged". All of it fades with her presence weight.
 */
export interface HerLifePresentation {
  /** Gaze target offset (procedural gaze units; x is mirrored by her seeded side, y < 0 looks down). */
  gazeX: number;
  gazeY: number;
  /** How much the pointer still pulls her eyes (1 = as usual). Moving the pointer brings it back. */
  pointerFollow: number;
  /** Saccade size and frequency (1 = as usual; small = a fixed stare). */
  saccade: number;
  /** Chance of a look-at-you moment (1 = as usual). */
  lookAtUser: number;
  /** Head offsets (rad; x < 0 lifts the chin; y and z are mirrored by her side). */
  headX: number;
  headY: number;
  headZ: number;
  /** Weight-shift sway amplitude (1 = as usual). */
  sway: number;
  /** A rhythm (humming): beats per second, head roll and upper-body roll amplitude (rad). */
  beatHz: number;
  beatHead: number;
  beatBody: number;
  /** Blink interval (1 = as usual). */
  blinkInterval: number;
  /** Face requests (0..1): softly lowered lids, smiling eyes, a closed smile. Never an open mouth. */
  lidSoft: number;
  smileEyes: number;
  mouthSmile: number;
}

/**
 * An existing library motion held as a pose: two of its own keyframe poses (sampled once), eased back and
 * forth between them (zero speed at both ends, so it never kinks at an inner key or loops with a seam), and
 * blended over the base by `weight` for the bones `bones` matches. It enters and leaves like a keyframe
 * transition (src/stage/her-life-stage.ts).
 */
export interface HerLifeMotion {
  id: HerLifeMotionId;
  /** The two keyframe poses (frames at 30 fps in the original clip). */
  fromFrame: number;
  toFrame: number;
  /** Seconds for one there-and-back. */
  periodS: number;
  /** Blend weight at full presence (scaled by the card's posture intensity, ≤ 1). */
  weight: number;
  /** Bone names (MMD standard, after retargeting) the overlay may write; nothing else. */
  bones: string;
}

export interface HerLifePick {
  /** Picked by the rules (and offered to the inner loop); drowsy is fatigue's alone. */
  auto: boolean;
  base: number;
  /** Duration = the card's motionIntervalMs × a random factor in [min, max]. */
  duration: [number, number];
  /** Multipliers by local time of day. */
  time: Partial<Record<HerLifeDaypart, number>>;
  /** Multipliers by her current mood label. */
  mood: Partial<Record<MoodLabel, number>>;
  /** Sensitivity to the card's tendency weights (MoodParameters.weights, 1 = average): factor 1 + k × 2 × (w − 1). */
  tendencies: Partial<Record<MoodTendency, number>>;
  /**
   * I-006 第 1 步 "你在忙" multiplier at full focus (absent = 1): while the user is absorbed she thinks, hums without a sound and daydreams
   * more, and "陪着你" (always looking at the user) less. Applied in proportion to the focus (shared/behaviors/user-activity).
   */
  busy?: number;
  /**
   * I-006 step 3 "跟着看": the state exists only while screen sharing is on and the rough look says the user is watching a video ('video')
   * or playing ('game'); this is its base weight for each (absent = never picked for it). Shaped by the same mood and tendency
   * multipliers as the others, so a game is followed only as much as she likes to play. Never picked otherwise.
   */
  watch?: Partial<Record<HerLifeWatchKind, number>>;
}

/** What the user is doing on the shared screen that she may follow along with. */
export const HER_LIFE_WATCH_KINDS = ['video', 'game'] as const;
export type HerLifeWatchKind = typeof HER_LIFE_WATCH_KINDS[number];
export const isHerLifeWatchKind = (value: unknown): value is HerLifeWatchKind =>
  typeof value === 'string' && (HER_LIFE_WATCH_KINDS as readonly string[]).includes(value);
/** I-006 step 3: the host's reading for one tick. `fresh`: this kind just began (she may turn to it now instead of at her next change). */
export interface HerLifeWatch { kind: HerLifeWatchKind; fresh?: boolean }

/** I-006: how absorbed the user is (0..1) and how much longer each of her own things lasts then (× 1 + longer × focus). */
export interface HerLifeBusy { focus: number; longer: number }

export interface HerLifeSpec {
  /** Developer panel / inner-loop option label. */
  label: string;
  /** "你刚才在：…" for the one chat turn after she was interrupted. */
  chat: string;
  /** The diary line: 发了好久的呆 / 发了一会儿呆. Empty: never mentioned. */
  diaryLong: string;
  diaryShort: string;
  pick: HerLifePick;
  presentation: HerLifePresentation;
  motion?: HerLifeMotion;
}

export type HerLifeDaypart = 'night' | 'morning' | 'day' | 'evening';

const NEUTRAL: HerLifePresentation = Object.freeze({ gazeX: 0, gazeY: 0, pointerFollow: 1, saccade: 1, lookAtUser: 1, headX: 0, headY: 0, headZ: 0,
  sway: 1, beatHz: 0, beatHead: 0, beatBody: 0, blinkInterval: 1, lidSoft: 0, smileEyes: 0, mouthSmile: 0 });
const look = (values: Partial<HerLifePresentation>): HerLifePresentation => Object.freeze({ ...NEUTRAL, ...values });
/** The thinking clip's hand-to-chin arm, fingers and neck (MMD standard names). */
const THINKING_BONES = '^(?:首|[左右](?:肩|腕|腕捩|ひじ|手捩|手首)|[左右](?:親指|人指|中指|薬指|小指)[0-9０-９])$';

/**
 * The table. First version (user did not answer, recommended options, 2026-11-02): no "看书" (there is no
 * book prop yet), and humming is silent (rhythm and face only). Numbers are trial values for the user's trial.
 */
export const HER_LIFE_TABLE: Readonly<Record<HerLifeActivity, HerLifeSpec>> = Object.freeze({
  company: {
    label: '陪着你', chat: '安静地陪着用户', diaryLong: '', diaryShort: '',
    pick: { auto: true, base: 1, duration: [2, 4], time: {}, mood: { close: 1.5, longing: 1.4, happy: 1.1, relieved: 1.2 }, tendencies: { close: 0.6 }, busy: 0.4 },
    // Exactly the existing R18 idle life (its look-at-you moments included): "陪着你" changes nothing she already does.
    presentation: NEUTRAL,
  },
  daydream: {
    label: '发呆', chat: '发呆', diaryLong: '发了好久的呆', diaryShort: '发了一会儿呆',
    pick: { auto: true, base: 1, duration: [3, 6], time: { evening: 1.2, night: 1.2 },
      mood: { calm: 1.3, content: 1.2, longing: 1.3, sad: 1.2, excited: 0.5 }, tendencies: { comfortable: 0.6, cautious: 0.4 }, busy: 1.6 },
    presentation: look({ gazeX: 0.13, gazeY: 0.05, pointerFollow: 0.3, saccade: 0.25, lookAtUser: 0.2, headX: -0.012, headY: 0.02, headZ: 0.022,
      sway: 0.6, blinkInterval: 1.4, lidSoft: 0.12 }),
  },
  humming: {
    label: '哼歌', chat: '轻轻哼歌（没出声）', diaryLong: '轻轻哼了好久的歌', diaryShort: '轻轻哼了一会儿歌',
    pick: { auto: true, base: 0.8, duration: [2, 4], time: { night: 0.5 },
      mood: { happy: 1.8, excited: 1.6, content: 1.4, relieved: 1.2, sad: 0.3, upset: 0.2, concerned: 0.4, disappointed: 0.4 }, tendencies: { playful: 0.8 }, busy: 1.4 },
    presentation: look({ gazeX: 0.05, gazeY: 0.02, pointerFollow: 0.7, saccade: 0.8, lookAtUser: 0.6, sway: 0.8,
      beatHz: 0.8, beatHead: 0.022, beatBody: 0.006, blinkInterval: 1.1, lidSoft: 0.06, smileEyes: 0.35, mouthSmile: 0.25 }),
  },
  thinking: {
    label: '想事情', chat: '想事情', diaryLong: '想了好久的事', diaryShort: '想了一会儿事',
    pick: { auto: true, base: 0.8, duration: [3, 5], time: { day: 1.2 },
      mood: { concerned: 1.5, 'tense-expectation': 1.4, disappointed: 1.2, calm: 1.1 }, tendencies: { cautious: 0.6 }, busy: 1.8 },
    presentation: look({ gazeX: -0.1, gazeY: 0.08, pointerFollow: 0.45, saccade: 1.3, lookAtUser: 0.4, headX: -0.015, headY: 0.015, headZ: 0.035,
      sway: 0.7, blinkInterval: 0.9, lidSoft: 0.05 }),
    motion: { id: 'thinking', fromFrame: 70, toFrame: 160, periodS: 9, weight: 0.9, bones: THINKING_BONES },
  },
  drowsy: {
    label: '犯困', chat: '犯困', diaryLong: '困了好久', diaryShort: '犯了一会儿困',
    pick: { auto: false, base: 0, duration: [1, 1], time: {}, mood: {}, tendencies: {} },
    presentation: look({ gazeY: -0.09, pointerFollow: 0.5, saccade: 0.4, lookAtUser: 0.3, headX: 0.03, headZ: 0.02,
      sway: 0.5, blinkInterval: 1.3, lidSoft: 0.3 }),
    motion: { id: 'sleepy', fromFrame: 59, toFrame: 123, periodS: 14, weight: 0.45, bones: '^上半身2?$' },
  },
  // I-006 第 3 步：开着屏幕共享、你在看视频时她转过去跟着看，偶尔回头看你；你在玩游戏时有时跟着看，看她爱不爱玩。
  // 视线朝哪边由舞台按她的窗口在哪块屏幕上算（shared/behaviors/watch-along/direction.ts），这一行只管"晃得轻、少回头、眨眼慢一点"。
  watching: {
    label: '跟着看', chat: '跟着用户一起看', diaryLong: '', diaryShort: '',
    pick: { auto: false, base: 1, duration: [3, 5], time: {},
      mood: { happy: 1.2, excited: 1.5, content: 1.1, relieved: 1.1, sad: 0.8, upset: 0.5, concerned: 0.7, disappointed: 0.7 }, tendencies: { playful: 0.6, close: 0.25 },
      watch: { video: 8, game: 1.1 } },
    presentation: look({ pointerFollow: 0.25, saccade: 0.4, lookAtUser: 0.5, sway: 0.55, blinkInterval: 1.3 }),
  },
});

export const HER_LIFE_NEUTRAL_PRESENTATION = NEUTRAL;

// ---------------------------------------------------------------- timing

const MINUTE = 60_000;
/** She takes up her own things once the user has been away for the card's small-motion interval (clamped). */
export function herLifeIdleAfterMs(p: Pick<MoodParameters, 'frequency'>): number {
  return Math.min(15 * MINUTE, Math.max(MINUTE, p.frequency.motionIntervalMs));
}
/** The interrupted line waits this long for the next chat turn, then is dropped. */
export const HER_LIFE_LINE_TTL_MS = 10 * MINUTE;
/** The inner loop may change her state only after it lasted the card's small-motion interval. */
export function herLifeSwitchAfterMs(p: Pick<MoodParameters, 'frequency'>): number { return p.frequency.motionIntervalMs; }
export function herLifeDuration(activity: HerLifeActivity, p: Pick<MoodParameters, 'frequency'>, random: () => number, busy?: HerLifeBusy): number {
  const [low, high] = HER_LIFE_TABLE[activity].pick.duration;
  const factor = (low + (high - low) * clamp01(random())) * (busy ? 1 + Math.max(0, finite(busy.longer, 0)) * clamp01(busy.focus) : 1);
  return Math.round(Math.min(2 * 60 * MINUTE, Math.max(MINUTE, p.frequency.motionIntervalMs * factor)));
}

export function herLifeDaypart(localMinute: number): HerLifeDaypart {
  const m = ((Math.floor(Number.isFinite(localMinute) ? localMinute : 0) % 1440) + 1440) % 1440;
  return m < 300 || m >= 1380 ? 'night' : m < 690 ? 'morning' : m < 1050 ? 'day' : 'evening';
}

// ---------------------------------------------------------------- choosing

export interface HerLifeChoiceInput {
  current: HerLifeActivity;
  localMinute: number;
  mood: MoodLabel | string | null | undefined;
  weights: Partial<Record<MoodTendency, number>> | null | undefined;
  /** Only her own things (the "去忙自己的事" test shortcut): "陪着你" is not a choice. The same weights otherwise. */
  ownOnly?: boolean;
  /** I-006: the user is absorbed (shared/behaviors/user-activity/effects.ts herLifeBusy); absent = not. Only changes the weights, never adds a state. */
  busy?: HerLifeBusy;
  /** I-006 step 3: the user is watching a video or playing a game on the shared screen; absent = not (sharing off, or the rough look does not say so). */
  watch?: HerLifeWatch;
}

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Relative weights of the rule-picked states (the current one and drowsy excluded). */
export function herLifeWeights(input: HerLifeChoiceInput): Partial<Record<HerLifeActivity, number>> {
  const part = herLifeDaypart(input.localMinute), result: Partial<Record<HerLifeActivity, number>> = {};
  for (const activity of HER_LIFE_ACTIVITIES) {
    const pick = HER_LIFE_TABLE[activity].pick;
    // "跟着看" is not a rule-picked state: it is a candidate only while the user is watching/playing something she follows, and she may carry on with it.
    const followed = pick.watch !== undefined ? finite(input.watch ? pick.watch[input.watch.kind] : undefined, 0) : undefined;
    if (followed !== undefined ? !(followed > 0) || input.ownOnly : (!pick.auto || activity === input.current)) continue;
    if (input.ownOnly && activity === 'company') continue;
    let weight = pick.base * (followed ?? 1) * finite(pick.time[part], 1) * finite(pick.mood[input.mood as MoodLabel], 1);
    // I-006: the multiplier grows with the focus (1 at none, the table's number at full).
    if (input.busy && pick.busy !== undefined) weight *= 1 + (finite(pick.busy, 1) - 1) * clamp01(input.busy.focus);
    for (const [tendency, k] of Object.entries(pick.tendencies) as [MoodTendency, number][])
      weight *= Math.min(3, Math.max(0.2, 1 + k * 2 * (finite(input.weights?.[tendency], 1) - 1)));
    if (weight > 0) result[activity] = weight;
  }
  return result;
}

export function pickHerLifeActivity(input: HerLifeChoiceInput, random: () => number): HerLifeActivity {
  const weights = herLifeWeights(input), entries = Object.entries(weights) as [HerLifeActivity, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) return input.ownOnly ? HER_LIFE_ACTIVITIES.find(activity => HER_LIFE_TABLE[activity].pick.auto && activity !== 'company' && activity !== input.current) ?? 'daydream' : 'company';
  let roll = clamp01(random()) * total;
  for (const [activity, weight] of entries) { roll -= weight; if (roll < 0) return activity; }
  return entries.at(-1)![0];
}

// ---------------------------------------------------------------- the state machine

export interface HerLifeRecord {
  activity: HerLifeActivity;
  since: number;
  until: number;
  source: HerLifeSource;
}
export interface HerLifeStepInput {
  now: number;
  /** "自动表现" on (MoodView.expressions); off freezes her where she is. */
  expressions: boolean;
  /** The user is away: the existing canExpress gate, an idle mood phase and no interaction for herLifeIdleAfterMs. */
  idle: boolean;
  fatigue: FatiguePhase | null | undefined;
  parameters: Pick<MoodParameters, 'frequency' | 'weights'>;
  mood: MoodLabel | string | null | undefined;
  localMinute: number;
  /** I-006: the user is absorbed (herLifeBusy); absent = not. */
  busy?: HerLifeBusy;
  /** I-006 step 3: the user is watching a video or playing on the shared screen (`fresh`: it just began); absent = not. */
  watch?: HerLifeWatch;
}
export type HerLifeStepReason = 'frozen' | 'busy' | 'unchanged' | 'fatigue' | 'awake' | 'elapsed' | 'away' | 'watch' | 'watch-over';

const DROWSY_PHASES: readonly (FatiguePhase | null | undefined)[] = ['drowsy', 'falling-asleep', 'asleep', 'micro-awake'];
export const herLifeDrowsy = (phase: FatiguePhase | null | undefined) => DROWSY_PHASES.includes(phase);

/**
 * One host tick. She only changes while the user is away; drowsy follows the fatigue model (sleep itself stays
 * with the sleep flow, which the stage yields to); otherwise a state runs its duration and the rules pick the next.
 */
/** A new state from `now`: its duration follows the card; drowsy lasts as long as the fatigue model says. */
export function startHerLife(activity: HerLifeActivity, now: number, source: HerLifeSource, p: Pick<MoodParameters, 'frequency'>, random: () => number, busy?: HerLifeBusy): HerLifeRecord {
  return { activity, since: now, source, until: activity === 'drowsy' ? Number.MAX_SAFE_INTEGER : now + herLifeDuration(activity, p, random, busy) };
}

export function stepHerLife(record: HerLifeRecord, input: HerLifeStepInput, random: () => number): { record: HerLifeRecord; reason: HerLifeStepReason } {
  if (!input.expressions) return { record, reason: 'frozen' };
  if (!input.idle) return { record, reason: 'busy' };
  const begin = (activity: HerLifeActivity, source: HerLifeSource) => startHerLife(activity, input.now, source, input.parameters, random, input.busy);
  if (herLifeDrowsy(input.fatigue)) {
    return record.activity === 'drowsy' ? { record, reason: 'unchanged' } : { record: begin('drowsy', 'fatigue'), reason: 'fatigue' };
  }
  const choose = () => pickHerLifeActivity({ current: record.activity, localMinute: input.localMinute, mood: input.mood, weights: input.parameters.weights, busy: input.busy, ...(input.watch ? { watch: input.watch } : {}) }, random);
  if (record.activity === 'drowsy') return { record: begin(choose(), 'rule'), reason: 'awake' };
  // I-006 step 3: what she follows ended (sharing off, the video over) → her own things again; it just began → she may turn to it now.
  if (record.activity === 'watching' && !input.watch) return { record: begin(choose(), 'rule'), reason: 'watch-over' };
  if (input.watch?.fresh && record.activity !== 'watching') return { record: begin(choose(), 'rule'), reason: 'watch' };
  // She was keeping the user company: once the user has been away she takes up something of her own.
  if (record.activity === 'company' && record.source === 'return') return { record: begin(choose(), 'rule'), reason: 'away' };
  if (input.now >= record.until) return { record: begin(choose(), 'rule'), reason: 'elapsed' };
  return { record, reason: 'unchanged' };
}

export interface HerLifeReturn {
  record: HerLifeRecord;
  /** The stage shows "抬起头" (her-life-stage.ts). */
  lookUp: boolean;
  /** For the next chat turn only: what she was doing and for how long. */
  interrupted: { activity: HerLifeActivity; minutes: number } | null;
}
/**
 * The user interacts (typing, chat, a touch, feeding, a sent message). She turns to the user: her own thing becomes
 * "陪着你". Whatever she was at, and however long the user was away (pretrial issue 6, 2026-11-03: the "测试：去忙自己的事"
 * shortcut, with the user right there, is the same as a real return), she looks up from it and the next chat turn hears
 * what it was. `minutes` is 0 when she had only just started.
 */
export function noteHerLifeReturn(record: HerLifeRecord, now: number): HerLifeReturn {
  if (record.activity === 'company') return { record, lookUp: false, interrupted: null };
  const lasted = Math.max(0, now - record.since);
  return {
    record: { activity: 'company', since: now, until: Number.MAX_SAFE_INTEGER, source: 'return' },
    lookUp: true,
    interrupted: { activity: record.activity, minutes: Math.round(lasted / MINUTE) },
  };
}

// ---------------------------------------------------------------- "抬起头": how she looks up (I-013)

export const HER_LIFE_LOOK_UP_KINDS = ['soft', 'bright', 'curious', 'startled', 'sleepy'] as const;
export type HerLifeLookUpKind = typeof HER_LIFE_LOOK_UP_KINDS[number];
/**
 * One look-up, as the stage plays it (src/stage/her-life-stage.ts). Multipliers are 1 for the plain look-up: eyes to the
 * user and the chin lifted a little over 0.35 s, held 1 s, let go over 0.8 s.
 */
export interface HerLifeLookUpStyle {
  kind: HerLifeLookUpKind;
  /** Rise and fall time × this (> 1 slower). */
  pace: number;
  /** Hold time × this. */
  hold: number;
  /** Chin lift × this. */
  lift: number;
  /** A small head tilt (rad, toward her own side), riding the same envelope. */
  tilt: number;
  /** Smiling eyes (and a softer closed smile) during it, 0..1. */
  smile: number;
}
type Range = readonly [number, number];
interface LookUpSpec { label: string; pace: Range; hold: Range; lift: Range; tilt: Range; smile: Range }
/** The looks and their ranges (trial values; one more look is one more row). */
export const HER_LIFE_LOOK_UPS: Readonly<Record<HerLifeLookUpKind, LookUpSpec>> = Object.freeze({
  soft: { label: '轻轻抬眼', pace: [1.15, 1.45], hold: [0.9, 1.3], lift: [0.5, 0.8], tilt: [0, 0.01], smile: [0.05, 0.15] },
  bright: { label: '眼睛一亮', pace: [0.8, 0.95], hold: [1, 1.4], lift: [1, 1.3], tilt: [0, 0.012], smile: [0.25, 0.4] },
  curious: { label: '歪头看你', pace: [0.9, 1.1], hold: [1.1, 1.5], lift: [0.8, 1.05], tilt: [0.018, 0.03], smile: [0.08, 0.2] },
  startled: { label: '回过神', pace: [0.8, 0.9], hold: [0.7, 1], lift: [1.15, 1.4], tilt: [0, 0.008], smile: [0, 0.06] },
  sleepy: { label: '慢慢睁眼', pace: [1.4, 1.7], hold: [0.8, 1.1], lift: [0.45, 0.7], tilt: [0.008, 0.02], smile: [0, 0.08] },
});
/** How likely each look is, by what she was doing, her mood and her card's tendencies (1 = no effect). */
const LOOK_UP_FROM: Partial<Record<HerLifeActivity, Partial<Record<HerLifeLookUpKind, number>>>> = {
  daydream: { startled: 1.6, soft: 1.2 }, humming: { bright: 1.6, curious: 1.2 }, thinking: { curious: 1.4, soft: 1.1 },
  drowsy: { sleepy: 4, soft: 1.2, bright: 0.4, curious: 0.5, startled: 0.6 },
};
const LOOK_UP_MOOD: Partial<Record<MoodLabel, Partial<Record<HerLifeLookUpKind, number>>>> = {
  happy: { bright: 1.8, curious: 1.2, startled: 0.7 }, excited: { bright: 1.8, curious: 1.2, startled: 0.7 },
  content: { bright: 1.5, curious: 1.2 }, relieved: { bright: 1.5, soft: 1.1 }, close: { bright: 1.6, soft: 1.2 }, longing: { bright: 1.6, soft: 1.2 },
  sad: { soft: 1.8, bright: 0.4, curious: 0.7 }, upset: { soft: 1.6, bright: 0.4, curious: 0.7 }, disappointed: { soft: 1.6, bright: 0.5, curious: 0.8 },
  concerned: { startled: 1.5, soft: 1.1, bright: 0.7 }, 'tense-expectation': { startled: 1.5, curious: 1.1 }, calm: { soft: 1.3, curious: 1.1 },
};
const LOOK_UP_TENDENCY: Partial<Record<MoodTendency, Partial<Record<HerLifeLookUpKind, number>>>> = {
  playful: { curious: 0.8, bright: 0.5 }, cautious: { startled: 0.8, soft: 0.4 }, comfortable: { soft: 0.6 }, close: { bright: 0.6 },
};
export interface HerLifeLookUpInput {
  /** What she was doing when the user came. */
  from: HerLifeActivity;
  mood: MoodLabel | string | null | undefined;
  weights: Partial<Record<MoodTendency, number>> | null | undefined;
  /** The look she gave last time: never twice in a row. */
  previous: HerLifeLookUpKind | null | undefined;
}
/**
 * How she looks up this time: a look picked by her mood, her card's tendencies and what she was doing, then values
 * drawn inside that look's ranges ("有个性的随机", README 补充原则 / I-013). "慢慢睁眼" only out of drowsiness.
 */
export function herLifeLookUpStyle(input: HerLifeLookUpInput, random: () => number): HerLifeLookUpStyle {
  const weights = new Map<HerLifeLookUpKind, number>();
  for (const kind of HER_LIFE_LOOK_UP_KINDS) {
    if (kind === 'sleepy' && input.from !== 'drowsy') continue;
    let weight = finite(LOOK_UP_FROM[input.from]?.[kind], 1) * finite(LOOK_UP_MOOD[input.mood as MoodLabel]?.[kind], 1);
    for (const [tendency, table] of Object.entries(LOOK_UP_TENDENCY) as [MoodTendency, Partial<Record<HerLifeLookUpKind, number>>][]) {
      const k = table[kind];
      if (k) weight *= Math.min(3, Math.max(0.2, 1 + k * 2 * (finite(input.weights?.[tendency], 1) - 1)));
    }
    if (weight > 0) weights.set(kind, weight);
  }
  if (weights.size > 1 && input.previous) weights.delete(input.previous);
  const entries = [...weights], total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = clamp01(random()) * total, kind: HerLifeLookUpKind = entries.at(-1)?.[0] ?? 'soft';
  for (const [candidate, weight] of entries) { roll -= weight; if (roll < 0) { kind = candidate; break; } }
  const spec = HER_LIFE_LOOK_UPS[kind], draw = ([low, high]: Range) => Math.round((low + (high - low) * clamp01(random())) * 1e4) / 1e4;
  return { kind, pace: draw(spec.pace), hold: draw(spec.hold), lift: draw(spec.lift), tilt: draw(spec.tilt), smile: draw(spec.smile) };
}
/** The stage's reading of a style from the host: anything missing or out of range falls back to the plain look-up. */
export function readHerLifeLookUpStyle(value: unknown): HerLifeLookUpStyle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!(HER_LIFE_LOOK_UP_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const within = (key: keyof LookUpSpec, low: number, high: number) => typeof v[key] === 'number' && Number.isFinite(v[key]) && (v[key] as number) >= low && (v[key] as number) <= high;
  if (!within('pace', 0.5, 2) || !within('hold', 0.5, 2) || !within('lift', 0, 2) || !within('tilt', -0.05, 0.05) || !within('smile', 0, 1)) return null;
  return { kind: v.kind as HerLifeLookUpKind, pace: v.pace as number, hold: v.hold as number, lift: v.lift as number, tilt: v.tilt as number, smile: v.smile as number };
}

/** What the inner loop may choose from now ("换件事做"), or null when she should not change. */
export interface HerLifeSwitchOffer {
  current: HerLifeActivity;
  minutes: number;
  choices: readonly HerLifeActivity[];
}
export function herLifeSwitchOffer(record: HerLifeRecord, input: Pick<HerLifeStepInput, 'now' | 'expressions' | 'idle' | 'fatigue' | 'parameters'>): HerLifeSwitchOffer | null {
  if (!input.expressions || !input.idle || herLifeDrowsy(input.fatigue) || record.activity === 'drowsy' || record.activity === 'watching') return null;
  const lasted = input.now - record.since;
  if (!(lasted >= herLifeSwitchAfterMs(input.parameters))) return null;
  const choices = HER_LIFE_ACTIVITIES.filter(activity => HER_LIFE_TABLE[activity].pick.auto && activity !== record.activity);
  return { current: record.activity, minutes: Math.max(1, Math.round(lasted / MINUTE)), choices };
}

// ---------------------------------------------------------------- words

/** The one private-context line of the chat turn after she was interrupted (never in the fixed system prompt). */
export function herLifeChatLine(interrupted: { activity: HerLifeActivity; minutes: number } | null | undefined): string {
  if (!interrupted || !isHerLifeActivity(interrupted.activity) || interrupted.activity === 'company') return '';
  const minutes = Math.max(0, Math.round(finite(interrupted.minutes, 1)));
  return `你刚才在：${HER_LIFE_TABLE[interrupted.activity].chat}（${minutes >= 1 ? `约 ${minutes} 分钟` : '刚开始没一会儿'}），被用户打断了；可以自然提一句，不用每次都提。`;
}

export interface HerLifeLogEntry { activity: HerLifeActivity; from: number; to: number }
const DAYPART_WORDS: readonly [number, string][] = [[300, '凌晨'], [480, '清晨'], [690, '上午'], [810, '中午'], [1050, '下午'], [1140, '傍晚'], [1380, '晚上'], [1440, '深夜']];
const daypartWord = (minute: number) => DAYPART_WORDS.find(([end]) => minute < end)?.[1] ?? '深夜';

/**
 * One material line for that day's diary (no extra call): the longest few things she did on her own,
 * by time of day. Empty when nothing lasted long enough.
 */
export function herLifeDiaryLine(entries: readonly HerLifeLogEntry[], start: number, end: number, localMinute: (ms: number) => number): string {
  const totals = new Map<string, { activity: HerLifeActivity; word: string; ms: number; first: number }>();
  for (const entry of entries) {
    const spec = HER_LIFE_TABLE[entry.activity];
    if (!spec?.diaryLong) continue;
    const from = Math.max(start, entry.from), to = Math.min(end, entry.to);
    if (!(to - from > 0)) continue;
    const word = daypartWord(localMinute(from)), key = `${word}|${entry.activity}`;
    const total = totals.get(key) ?? { activity: entry.activity, word, ms: 0, first: from };
    total.ms += to - from; totals.set(key, total);
  }
  const items = [...totals.values()].filter(item => item.ms >= 5 * MINUTE).sort((a, b) => b.ms - a.ms).slice(0, 3).sort((a, b) => a.first - b.first);
  if (!items.length) return '';
  const words = items.map(item => `${item.word}${item.ms >= 30 * MINUTE ? HER_LIFE_TABLE[item.activity].diaryLong : HER_LIFE_TABLE[item.activity].diaryShort}（约 ${Math.round(item.ms / MINUTE)} 分钟）`);
  return `这天用户不在时你自己做过的事（应用记下的，只是素材，可写可不写）：${words.join('；')}。`;
}

// ---------------------------------------------------------------- view and storage

/** Host → stage and developer panel. Names and times only. */
export interface HerLifeView {
  activity: HerLifeActivity;
  since: number;
  /** Planned change time; MAX_SAFE_INTEGER while it lasts as long as its cause (company after a return, drowsy). */
  until: number;
  source: HerLifeSource;
  /** Changes once per "抬起头"; null when none is pending. `style`: how she looks up this time (absent: the plain look-up). */
  lookUp: { id: string; at: number; style?: HerLifeLookUpStyle } | null;
  /** I-006 step 3: present only while she is following the shared screen (activity 'watching'): what kind, nothing about the content. */
  watch?: { kind: HerLifeWatchKind };
}

export function readHerLifeRecord(value: unknown): HerLifeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const sources: readonly unknown[] = ['start', 'rule', 'inner', 'fatigue', 'return'];
  if (!isHerLifeActivity(v.activity) || !Number.isSafeInteger(v.since) || !Number.isSafeInteger(v.until) || (v.since as number) < 0
    || (v.until as number) < (v.since as number) || !sources.includes(v.source)) return null;
  return { activity: v.activity, since: v.since as number, until: v.until as number, source: v.source as HerLifeSource };
}
export function readHerLifeLog(value: unknown): HerLifeLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-HER_LIFE_LOG_MAX).flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const r = row as Record<string, unknown>;
    return isHerLifeActivity(r.activity) && Number.isSafeInteger(r.from) && Number.isSafeInteger(r.to) && (r.to as number) >= (r.from as number)
      ? [{ activity: r.activity, from: r.from as number, to: r.to as number }] : [];
  });
}
export const HER_LIFE_LOG_MAX = 96;
/** The diary writes up to a few days back; older log entries are dropped. */
export const HER_LIFE_LOG_KEEP_MS = 4 * 24 * 60 * MINUTE;
