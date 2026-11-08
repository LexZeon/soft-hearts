/**
 * Procedural life (roadmap "更远一步：动作模型" step 1; R18/R19): small
 * generated motions that keep her alive between replies, on any model.
 *
 * Primitives (all additive, through the R29 layer, written only via the
 * stage's existing writers):
 * - breathing: a variable-rate breath signal (mood tempo + smooth noise) that
 *   replaces the old fixed sine on the chest/center, plus a tiny shoulder rise;
 * - gaze: slow drift, occasional small saccades, look-at-user and look-away
 *   moments. It only offsets the stage's own pointer gaze target (head/eye split,
 *   damping and fatigue scaling stay the stage's), so gaze ownership is unchanged;
 * - micro head tilt: noise plus occasional curious tilt moments, through the
 *   stage's automatic-head path (head claims, deferral);
 * - weight-shift sway: slow upper-body roll/twist;
 * - blink rhythm: varied intervals and durations and occasional double blinks.
 *   It only shapes the natural-blink pulse the stage feeds to the eyelid
 *   compositor; it never writes a morph.
 * - R36 continuous expression (continuous-expression.ts): smile eyes, mouth
 *   smile, troubled brows, jitome when drowsy, blush, a tiny head pitch. Lid
 *   shapes are requests to the eyelid compositor; the mouth smile follows the
 *   mouth compositor's rule; slots the model's profile lacks are skipped.
 * - Expression previews (preview-performance.ts): while the controls' 惊喜 /
 *   害羞 preview plays, its model-agnostic additions (lowered gaze and lids,
 *   head pitch and turn, blush, closed smile / small "o") on the preview clock.
 *
 * Parameters (amplitude, speed, smoothness, asymmetry, gaze habits, breath and
 * blink rhythm) come from the card's mood intensity fields (`intensity.gaze`,
 * `posture`, `expression`) and the current mood snapshot (label, channel values,
 * companion tendency) and fatigue; they are smoothed so a mood change re-tempers
 * the motion instead of cutting it. A seeded noise source (`life-noise.ts`,
 * seeded by the character id) keeps the motion deterministic per seed and
 * never visibly looping.
 *
 * Priority (docs/claude/2026-11-02-R29-motion-foundation.md): this is the
 * lowest automatic layer. Each primitive fades out (0.3 s) whenever a higher
 * owner holds its part (contact, manual picks, chat gesture, music, automatic
 * body motion, sleep/fatigue, previews, camera/window adjusting) and fades back
 * in (0.8 s); the continuity guard only backs these fades up.
 *
 * Bounds: per-joint limits and a total head additive clamp; morph outputs are
 * capped. `frame()` allocates nothing (see scripts/bench-procedural-life.ts).
 */
import { SeededRandom, SmoothNoise, hashSeed } from './life-noise';
import { ContinuousExpression, EXPRESSION_LIMITS, emptyExpression, expressionTargets } from './continuous-expression';
import { composeBrows, composeMouthExpression } from './channel-compositors';
import { PERFORMANCE_LIMITS, emptyPerformance, previewPerformance } from './preview-performance';
import { SHOW_CLIP, SHOW_KEYS, emptyShow, showRecipeOfClip, showSample } from './expression-show';
import { SHOW_BONE_KEYS, ShowCarry, StrengthEase, clampStrength } from './show-blend';
import type { ExpressionRecipe } from '../../shared/expression-preview';

// ---------------------------------------------------------------- inputs

export interface LifeMood {
  primary?: string;
  companion?: string | null;
  values?: Partial<Record<'D' | 'O' | 'E' | 'N' | 'C', number>>;
  intensity?: { expression?: number; gaze?: number; posture?: number; playful?: number };
}
export interface LifeFatigue { phase?: string; F?: number; sleeping?: boolean }

/** What currently owns which part. Every field is a plain boolean the stage already knows. */
export interface LifeGates {
  /** Automatic presentation enabled (MoodView.expressions). */
  expressive: boolean;
  /** Direct contact: pat, hover, feeding, cheek pinch (incl. its residual), non-idle mood phase. */
  contact: boolean;
  manualPose: boolean;
  manualGesture: boolean;
  /** A picked motion animates the head. */
  manualHead: boolean;
  /** A picked expression owns the face. */
  manualExpression: boolean;
  manualMouth: boolean;
  chatGesture: boolean;
  music: boolean;
  /** Automatic body motion lease (active or pending). */
  bodyMotion: boolean;
  /** Another owner holds the head bone this frame. */
  headOwned: boolean;
  /** A reviewed behaviour expression state/reaction is playing. */
  authoredFace: boolean;
  /** A controls preview (visual, body, surprise/shy) owns the presentation. */
  preview: boolean;
  /** Camera edit, window move/resize. */
  adjusting: boolean;
  speaking: boolean;
  /** Fatigue: false while asleep. */
  gazeAllowed: boolean;
  /** A fatigue presentation drives the face this frame (drowsy lids, the reviewed drowsy nod). */
  fatigueFace?: boolean;
}
/** The card's blush profile (MoodParameters.blush): the continuous blush respects its switch, intensity and size. */
export interface LifeBlush { enabled: boolean; intensity: number; size: number }
export interface LifeSlots {
  smileEyes: number; mouthSmile: number; sad: number; angry: number; jitome: number;
  /** A small open-mouth shape for surprise (slot `o`); -1 when it is the lip-sync morph itself. */
  mouthOpen: number;
  /** E1 expression previews (expression-show.ts): raised brows and wide eyes (profile slots `browUp`, `surprise`); missing = -1. */
  browUp?: number;
  surprise?: number;
}
/** Bones and semantic morph slots of one model, resolved once at load (see `lifeRig`). */
export interface LifeRig<B> {
  readonly owner: object;
  readonly upperBody?: B;
  readonly shoulderLeft?: B;
  readonly shoulderRight?: B;
  readonly slots: LifeSlots;
}
/** The stage's existing writers: bone rotation (remembered/restored), automatic head, calibrated morph write. */
export interface LifePort<B> {
  rotate(bone: B | undefined, x: number, y: number, z: number): void;
  head(x: number, y: number, z: number): void;
  morph(index: number, weight: number): void;
}
export interface LifeInput<B> {
  enabled: boolean;
  /** The mesh: a new owner restarts from neutral. */
  owner: object | null;
  /** Seeds the noise (the character id): one character, one motion handwriting. */
  seedKey: string;
  rig: LifeRig<B> | null;
  mood: LifeMood | null | undefined;
  fatigue: LifeFatigue | null | undefined;
  pointerX: number;
  pointerY: number;
  /** The stage's breath setting (0..1). */
  breathStrength: number;
  hasEyes: boolean;
  blush?: LifeBlush | null;
  /** The controls' expression preview playing this frame (its host-issued clip id) and its clock. */
  previewClip?: string | null;
  previewElapsedMs?: number;
  /** I-038 / I-037: an E1 show's strength (0..1; absent = 1). */
  previewStrength?: number;
  /** The preview's own frame gate (hidden, camera/window, input focus, direct contact). */
  previewBlocked?: boolean;
  gates: LifeGates;
  /** 她自己的生活 (her-life-stage.ts): her own activity this frame, already eased; null = none. */
  activity?: LifeActivity | null;
  /** M1 (music-nod.ts): a light nod and sway to the music, added to the head tilt and upper-body sway under their yield weights. */
  beat?: LifeBeat | null;
}
/** Radians: head x > 0 nods the chin down; z is a head roll; bodyZ is an upper-body roll. */
export interface LifeBeat { headX: number; headZ: number; bodyZ: number }

/**
 * 她自己的生活: what her own activity adds this frame (her-life-stage.ts computes it from the shared table,
 * already faded by her presence and cross-faded between states). Offsets are added inside the primitives
 * below, so every existing owner/yield rule and bound still applies; multipliers are 1 for "unchanged".
 */
export interface LifeActivity {
  /** Gaze offset (same units as the drift). */
  gazeX: number;
  gazeY: number;
  /** I-006 step 3 "跟着看": a gaze offset toward a place on the screen (not mirrored by her side, unlike gazeX); absent = 0. */
  gazeFixedX?: number;
  gazeFixedY?: number;
  /** 0..1 of the pointer's pull that remains (a moving pointer restores it). */
  pointerFollow: number;
  /** Saccade size and frequency multiplier. */
  saccade: number;
  /** Look-at-user moment chance multiplier. */
  lookAtUser: number;
  /** Head offsets (rad), inside the head clamp. */
  headX: number;
  headY: number;
  headZ: number;
  /** Sway amplitude multiplier, and an extra upper-body roll (rad, the humming beat). */
  sway: number;
  bodyZ: number;
  blinkInterval: number;
  /** Face requests 0..1 (lowered lids, smiling eyes, closed smile). */
  lidSoft: number;
  smileEyes: number;
  mouthSmile: number;
  /** 0..1 "抬起头": eyes to the user, chin slightly up (shown even while her own activity yields). */
  lookUp: number;
  /** G1 猜拳 (rps-performance.ts): troubled / angry brows 0..1 for her reactions. Her own life never sets them. */
  sad?: number;
  angry?: number;
  /**
   * P1 第二阶段 (pose-reaction-stage.ts): an open mouth 0..1 for a yawn she caught, on the small-"o" slot under the mouth rule (speech
   * and feeding own the mouth first). Absent: exactly as before.
   */
  mouthOpen?: number;
}
/** Chin lift (rad) at the top of a look-up. */
export const LIFE_LOOK_UP_LIFT = 0.02;

// ---------------------------------------------------------------- parameters

export interface LifeParameters {
  /** Body and head motion scale (1 = default card at calm). */
  amplitude: number;
  /** Gaze drift/saccade scale. */
  gaze: number;
  /** Face scale for continuous expression (intensity.expression / 50). */
  expression: number;
  /** Tempo multiplier for noise, saccades and moments. */
  speed: number;
  /** 0..1: higher = fewer saccades, slower noise, longer holds. */
  smoothness: number;
  /** -1..1 side preference of tilts (sign from the seed, size from playfulness). */
  asymmetry: number;
  /** Relative chance of a look-at-user moment. */
  lookAtUser: number;
  /** Relative chance of an averted glance. */
  lookAway: number;
  /** Vertical bias of the drift (negative = downcast). */
  gazeDown: number;
  breathRate: number;
  blinkInterval: number;
  blinkDuration: number;
  doubleBlink: number;
  /** 0..1 drowsiness (fatigue F in drowsy phases). */
  drowsy: number;
}

interface Temper { amp: number; gaze: number; speed: number; smooth: number; look: number; away: number; down: number; breath: number; blink: number; double: number }
const T = (amp: number, gaze: number, speed: number, smooth: number, look: number, away: number, down: number, breath: number, blink: number, double = 0): Temper =>
  ({ amp, gaze, speed, smooth, look, away, down, breath, blink, double });
/** One table for every model and card: how each mood label tempers the motion. */
const TEMPER: Readonly<Record<string, Temper>> = Object.freeze({
  calm: T(0.9, 0.9, 0.9, 0.1, 0, 0, 0, 0.95, 1.1),
  close: T(1, 1, 0.95, 0.1, 0.25, 0.05, 0, 1, 1),
  content: T(0.9, 0.85, 0.85, 0.15, 0.1, 0, 0, 0.9, 1.15),
  happy: T(1.15, 1.1, 1.1, 0, 0.2, 0, 0.01, 1.05, 0.95),
  excited: T(1.35, 1.25, 1.3, -0.15, 0.15, 0, 0.01, 1.25, 0.8, 0.06),
  concerned: T(0.85, 1.1, 1.05, -0.1, 0.2, 0.1, -0.02, 1.1, 0.9, 0.03),
  disappointed: T(0.7, 0.8, 0.8, 0.05, -0.1, 0.25, -0.07, 0.9, 1.1),
  upset: T(0.9, 1, 1.1, -0.2, -0.15, 0.3, -0.03, 1.15, 0.85, 0.03),
  longing: T(0.75, 0.85, 0.8, 0.1, 0.1, 0.15, -0.04, 0.9, 1.1),
  sad: T(0.65, 0.7, 0.75, 0.1, -0.1, 0.3, -0.08, 0.85, 1.15),
  relieved: T(0.9, 0.9, 0.85, 0.15, 0.2, 0, 0, 0.9, 1.05),
  'tense-expectation': T(1.05, 1.2, 1.2, -0.2, 0.25, 0.05, 0, 1.2, 0.8, 0.05),
});
const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const clamp01 = (value: number) => clamp(value, 0, 1);
const smoothstep = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const channel = (values: LifeMood['values'], key: 'D' | 'O' | 'E' | 'N' | 'C') => {
  const value = values?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? clamp((value - 50) / 50, -1, 1) : 0;
};
const level = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? clamp(value / 50, 0, 2) : 1;

export function emptyLifeParameters(): LifeParameters {
  return { amplitude: 1, gaze: 1, expression: 1, speed: 1, smoothness: 0.6, asymmetry: 0, lookAtUser: 0.35, lookAway: 0.05, gazeDown: 0,
    breathRate: 0.23, blinkInterval: 4.2, blinkDuration: 0.16, doubleBlink: 0.07, drowsy: 0 };
}

/**
 * Mood and personality to motion parameters. `side` (+1/-1) is the seeded side
 * preference. Pure; writes into `out` when given (no allocation per frame).
 */
export function lifeParameters(mood: LifeMood | null | undefined, fatigue: LifeFatigue | null | undefined, side = 1,
  out: LifeParameters = emptyLifeParameters()): LifeParameters {
  const temper = TEMPER[mood?.primary ?? ''] ?? TEMPER.calm;
  const arousal = channel(mood?.values, 'N'), comfort = channel(mood?.values, 'E'), warmth = channel(mood?.values, 'O');
  const tension = Math.max(0, channel(mood?.values, 'C'));
  const phase = fatigue?.phase ?? 'awake';
  const F = typeof fatigue?.F === 'number' && Number.isFinite(fatigue.F) ? clamp01(fatigue.F) : 0;
  const drowsy = phase === 'drowsy' ? F : phase === 'light-drowsy' ? F * 0.5 : phase === 'falling-asleep' || phase === 'asleep' ? 1 : 0;
  const posture = level(mood?.intensity?.posture), gaze = level(mood?.intensity?.gaze);
  const playful = mood?.companion === 'playful' ? 1 : 0, cautious = mood?.companion === 'cautious' ? 1 : 0;
  out.amplitude = clamp(posture * temper.amp * (1 + 0.2 * arousal) * (1 - 0.45 * drowsy), 0, 2);
  out.gaze = clamp(gaze * temper.gaze * (1 + 0.15 * arousal) * (1 - 0.55 * drowsy), 0, 2);
  out.expression = level(mood?.intensity?.expression);
  out.speed = clamp(temper.speed * (1 + 0.25 * arousal + 0.1 * tension) * (1 - 0.35 * drowsy), 0.45, 1.6);
  out.smoothness = clamp01(0.55 + temper.smooth + 0.2 * comfort - 0.3 * tension + 0.2 * drowsy);
  out.asymmetry = clamp((Math.sign(side) || 1) * (0.25 + 0.45 * playful + 0.2 * Math.max(0, arousal)) * (1 - 0.5 * cautious), -1, 1);
  out.lookAtUser = clamp(0.35 + temper.look + 0.25 * warmth - 0.2 * cautious, 0.05, 0.9);
  out.lookAway = clamp(0.05 + temper.away + 0.25 * cautious + 0.1 * tension, 0, 0.6);
  out.gazeDown = clamp(temper.down - 0.03 * drowsy, -0.12, 0.03);
  out.breathRate = clamp(0.23 * temper.breath * (1 + 0.18 * arousal + 0.12 * tension) * (1 - 0.22 * drowsy), 0.12, 0.42);
  out.blinkInterval = clamp(4.2 * temper.blink * (1 - 0.22 * arousal - 0.18 * tension) * (1 + 0.35 * drowsy), 2, 7.5);
  out.blinkDuration = clamp(0.155 * (1 + 0.7 * drowsy) * (comfort > 0.3 ? 1.05 : 1), 0.12, 0.3);
  out.doubleBlink = clamp(0.06 + temper.double + 0.06 * Math.max(0, arousal) + 0.05 * tension - 0.04 * drowsy, 0, 0.3);
  out.drowsy = drowsy;
  return out;
}

// ---------------------------------------------------------------- yields

/** Why a primitive is (partly) silent this frame; decoded only for diagnostics. */
export const LIFE_YIELDS = Object.freeze(['disabled', 'paused', 'contact', 'manual-pose', 'manual-gesture', 'manual-head', 'manual-expression',
  'manual-mouth', 'chat-gesture', 'music', 'body-motion', 'head-owned', 'authored-face', 'preview', 'adjusting', 'sleep', 'speech', 'fatigue'] as const);
export type LifeYield = typeof LIFE_YIELDS[number];
const Y = Object.freeze(Object.fromEntries(LIFE_YIELDS.map((name, index) => [name, 1 << index])) as Record<LifeYield, number>);
export function decodeYields(mask: number): LifeYield[] { return LIFE_YIELDS.filter(name => (mask & Y[name]) !== 0); }

/** Fade times (s): primitives return gently and give way quickly. */
export const LIFE_FADE_IN = 0.8;
export const LIFE_FADE_OUT = 0.3;
const MASTER_IN = 0.6, MASTER_OUT = 0.35;

// ---------------------------------------------------------------- bounds

/** Per-joint additive limits (rad) and morph caps. */
export const LIFE_LIMITS = Object.freeze({
  head: Object.freeze({ x: 0.05, y: 0.06, z: 0.07, total: 0.08 }),
  sway: Object.freeze({ y: 0.02, z: 0.02 }),
  shoulder: 0.02,
  gaze: Object.freeze({ x: 0.3, y: 0.2 }),
});

/** The stage's blink shape (procedural.ts blinkWeight): closed at the midpoint. */
function pulse(t: number, duration: number): number {
  if (t < 0 || t > duration) return 0;
  const s = Math.sin((t / duration) * Math.PI);
  return s * s;
}
function ramp(value: number, target: number, dt: number): number {
  if (target > value) return Math.min(target, value + dt / LIFE_FADE_IN);
  return Math.max(target, value - dt / LIFE_FADE_OUT);
}
function ease(current: number, target: number, tau: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
}

// ---------------------------------------------------------------- the generator

export interface LifeState {
  enabled: boolean;
  active: boolean;
  master: number;
  seed: number;
  params: Record<keyof LifeParameters, number>;
  primitives: {
    breath: { weight: number; rateHz: number };
    gaze: { weight: number; moment: 'none' | 'user' | 'away'; saccades: number; yielding: LifeYield[] };
    tilt: { weight: number; moment: boolean; yielding: LifeYield[] };
    sway: { weight: number; yielding: LifeYield[] };
    blink: { intervalS: number; durationS: number; double: boolean; blinks: number; doubles: number };
    expression: { weight: number; smileEyes: number; mouthSmile: number; sad: number; angry: number; jitome: number; blush: number; headX: number;
      speechOwner: number; skipped: string[]; yielding: LifeYield[] };
    preview: { clip: string; elapsedMs: number; fade: number; headX: number; headY: number; eyePitch: number; eyeYaw: number; lidSoft: number; blush: number;
      mouthSmile: number; mouthOpen: number; blocked: boolean;
      /** E1 shows only (expression-show.ts). */
      headZ?: number; bodyX?: number; bodyZ?: number; browUp?: number; eyeWide?: number; skipped?: string[] } | null;
  };
  output: { headX: number; headY: number; headZ: number; swayY: number; swayZ: number; shoulder: number; gazeX: number; gazeY: number; gazeBlend: number;
    smileEyes: number; jitome: number; lidSoft: number; mouthSmile: number; mouthOpen: number; sad: number; angry: number; blush: number };
  rig: { upperBody: boolean; shoulders: boolean } | null;
}

export class ProceduralLife<B = unknown> {
  // seeding
  private owner: object | null = null;
  private seedKey = '';
  private seeded = false;
  private seed = 0;
  private random = new SeededRandom(1);
  private noise = new SmoothNoise(1);
  private side = 1;
  // clocks and weights
  private time = 0;
  private master = 0;
  private enabled = true;
  private wGaze = 0; private wTilt = 0; private wSway = 0;
  private yGaze = 0; private yTilt = 0; private ySway = 0;
  private readonly params = emptyLifeParameters();
  private readonly target = emptyLifeParameters();
  private paramsReady = false;
  private rig: LifeRig<B> | null = null;
  private breathStrength = 0.5;
  // breath
  private breathPhase = 0;
  // gaze
  private saccadeX = 0; private saccadeY = 0; private nextSaccade = 0; private saccades = 0;
  private moment: 0 | 1 | 2 = 0; private momentEnd = 0; private nextMoment = 0;
  private userWeight = 0; private awayWeight = 0; private awayX = 0; private awayY = 0;
  private lastPointerX = NaN; private lastPointerY = NaN; private activity = 0;
  // tilt
  private tiltStart = 0; private tiltEnd = -1; private tiltPeak = 0; private nextTilt = 0;
  // blink
  private blinkDur = 0.16; private blinkDouble = false; private blinkGap = 0.08; private blinkSecond = 0.14;
  private blinkIntervalS = 4.2; private blinks = 0; private doubles = 0; private speaking = false;
  // R36 expression
  private readonly expression = new ContinuousExpression();
  private readonly exprTarget = emptyExpression();
  private readonly wobble = { smile: 0, brow: 0, lid: 0, blush: 0 };
  private readonly brows = { sad: 0, angry: 0 };
  private yExpr = 0; private wExpr = 0; private speechOwner = 0; private exprHeadX = 0;
  // expression preview additions
  private readonly performance = emptyPerformance();
  private readonly performanceHeld = emptyPerformance();
  private previewFade = 0; private previewClip: string | null = null; private previewMs = 0; private previewBlocked = false;
  // E1 expression shows (expression-show.ts): the sample, its eased weight (0..1, 0.3 s) and the recipe still showing or fading
  private readonly showHeld = emptyShow();
  private showWeight = 0; private showRecipe: ExpressionRecipe | null = null;
  /** I-038 / I-037 (show-blend.ts): the show's strength (eased when a running show is asked for again), this frame's channels, replaced shows still fading out, and the gains they were shown with. */
  private readonly showStrength = new StrengthEase(); private readonly showShown = emptyShow(); private readonly showCarry = new ShowCarry();
  private readonly showGain = { bone: 0, face: 0 };
  // 她自己的生活 (her-life-stage.ts): this frame's activity and its eased lid request
  private act: LifeActivity | null = null;
  private beat: LifeBeat | null = null;
  private actLid = 0;
  private actMouth = 0;
  // output (read by the stage; never reallocated). pointerFollow scales the pointer's pull on the gaze (1 = as usual).
  readonly out = { breath: 0, mix: 0, headX: 0, headY: 0, headZ: 0, swayY: 0, swayZ: 0, shoulder: 0, gazeX: 0, gazeY: 0, gazeBlend: 0, pointerFollow: 1,
    smileEyes: 0, jitome: 0, lidSoft: 0, mouthSmile: 0, mouthOpen: 0, sad: 0, angry: 0, blush: 0,
    previewHeadX: 0, previewHeadY: 0, previewEyePitch: 0, previewEyeYaw: 0,
    // E1 shows: head tilt, upper body, raised brows, wide eyes
    previewHeadZ: 0, previewBodyX: 0, previewBodyZ: 0, browUp: 0, eyeWide: 0 };
  // diagnostics cache
  private diagnosticsAt = -Infinity;
  private diagnosticsText = 'null';

  /** True while any procedural output is shown (enabled, or still fading out). */
  get active(): boolean { return this.master > 0; }

  reset(seedKey = this.seedKey): void {
    this.seedKey = seedKey; this.seeded = true;
    this.seed = hashSeed(`soft-hearts-life:${seedKey}`);
    this.random = new SeededRandom(this.seed);
    this.noise = new SmoothNoise(this.seed ^ 0x5bd1e995);
    this.side = this.random.next() < 0.5 ? -1 : 1;
    this.time = 0; this.master = 0; this.wGaze = this.wTilt = this.wSway = 0; this.yGaze = this.yTilt = this.ySway = 0;
    this.paramsReady = false; this.breathPhase = this.random.range(0, Math.PI * 2);
    this.saccadeX = this.saccadeY = 0; this.nextSaccade = this.random.range(0.8, 2.5); this.saccades = 0;
    this.moment = 0; this.momentEnd = 0; this.nextMoment = this.random.range(3, 8);
    this.userWeight = this.awayWeight = this.awayX = this.awayY = 0;
    this.lastPointerX = this.lastPointerY = NaN; this.activity = 0;
    this.tiltStart = 0; this.tiltEnd = -1; this.tiltPeak = 0; this.nextTilt = this.random.range(4, 10);
    this.blinkDur = 0.16; this.blinkDouble = false; this.blinks = this.doubles = 0;
    this.yExpr = this.speechOwner = 0;
    this.zero();
    this.diagnosticsAt = -Infinity;
  }

  /** One display frame. Call once per rendered frame before the writers that read `out`. */
  frame(delta: number, input: LifeInput<B>): void {
    if (!this.seeded || input.owner !== this.owner || input.seedKey !== this.seedKey) { this.owner = input.owner; this.reset(input.seedKey); }
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0;
    this.enabled = input.enabled === true && input.owner !== null;
    this.rig = input.rig && input.rig.owner === input.owner ? input.rig : null;
    this.breathStrength = clamp01(input.breathStrength);
    this.speaking = input.gates.speaking === true;
    this.act = input.activity ?? null;
    this.beat = input.beat ?? null;
    this.master = this.enabled ? Math.min(1, this.master + dt / MASTER_IN) : Math.max(0, this.master - dt / MASTER_OUT);
    if (this.master <= 0) { this.zero(); return; }
    this.time += dt;
    lifeParameters(input.mood, input.fatigue, this.side, this.target);
    this.temper(dt);
    this.yieldWeights(dt, input.gates, input.fatigue);
    const p = this.params, m = smoothstep(this.master);
    this.breathe(dt, p, m);
    this.gaze(dt, input, p, m * smoothstep(this.wGaze));
    this.express(dt, input, p, m);
    this.perform(dt, input, m);
    this.tilt(p, m * smoothstep(this.wTilt));
    this.sway(p, m * smoothstep(this.wSway));
  }

  /** Mixes the stage's legacy breath sine with the procedural breath by the master fade. */
  mixBreath(legacy: number): number {
    const mix = this.out.mix;
    return mix <= 0 ? legacy : legacy * (1 - mix) + this.out.breath * mix;
  }

  /**
   * Called by the stage when a natural blink starts: picks this blink's shape
   * (duration, single/double) and returns the seconds until the next one.
   */
  beginBlink(): number {
    const p = this.params, r = this.random;
    this.blinkDur = clamp(p.blinkDuration * r.range(0.88, 1.12), 0.1, 0.32);
    this.blinkDouble = r.next() < p.doubleBlink;
    this.blinkGap = r.range(0.05, 0.09); this.blinkSecond = this.blinkDur * r.range(0.8, 0.95);
    this.blinks++; if (this.blinkDouble) this.doubles++;
    // Irregular, bell-shaped intervals around the mood's mean; speech blinks a little more often.
    const mean = p.blinkInterval * (this.speaking ? 0.85 : 1) * (this.act ? clamp(this.act.blinkInterval, 0.5, 2) : 1);
    this.blinkIntervalS = Math.max(1.1, mean * (0.42 + r.next() * 0.8 + r.next() * 0.4)) + (this.blinkDouble ? this.blinkGap + this.blinkSecond : 0);
    return this.blinkIntervalS;
  }

  /** The current natural-blink pulse (0 open .. 1 closed), `elapsed` seconds after the blink began. */
  blinkWeight(elapsed: number): number {
    const first = pulse(elapsed, this.blinkDur);
    return this.blinkDouble ? Math.max(first, pulse(elapsed - this.blinkDur - this.blinkGap, this.blinkSecond)) : first;
  }

  /** Shoulders, upper-body sway and head tilt through the stage's writers (skips missing bones). */
  applyBody(port: LifePort<B>): void {
    const out = this.out, rig = this.rig;
    if (this.master <= 0) return;
    if (rig) {
      if (rig.upperBody && (out.swayY !== 0 || out.swayZ !== 0)) port.rotate(rig.upperBody, 0, out.swayY, out.swayZ);
      // Both shoulders or neither: one raised shoulder would read as a shrug.
      if (rig.shoulderLeft && rig.shoulderRight && out.shoulder !== 0) { port.rotate(rig.shoulderLeft, 0, 0, out.shoulder); port.rotate(rig.shoulderRight, 0, 0, -out.shoulder); }
    }
    if (out.headX !== 0 || out.headY !== 0 || out.headZ !== 0) port.head(out.headX, out.headY, out.headZ);
  }

  /**
   * R36 face through the stage's calibrated morph writer, after the eyelid
   * compositor ran with this frame's `out` lid requests: lid shapes as the
   * compositor shows them, brows by the brow rule, mouth shapes yielding to
   * lip-sync and feeding (`feedOwner`, the mood feedback's feeding weight).
   * Slots the model lacks are skipped.
   */
  applyFace(port: LifePort<B>, lids: { readonly smileEyes: number; readonly jitome: number; readonly closure?: number }, feedOwner: number): void {
    const rig = this.rig, out = this.out;
    if (!rig || this.master <= 0) return;
    const slots = rig.slots;
    if (slots.smileEyes >= 0 && lids.smileEyes > 0) port.morph(slots.smileEyes, lids.smileEyes);
    if (slots.jitome >= 0 && lids.jitome > 0) port.morph(slots.jitome, lids.jitome);
    const brows = composeBrows(out.sad, out.angry, this.brows);
    if (slots.sad >= 0 && brows.sad > 0) port.morph(slots.sad, brows.sad);
    if (slots.angry >= 0 && brows.angry > 0) port.morph(slots.angry, brows.angry);
    // E1 shows: raised brows; wide eyes give way to whatever closes the lids this frame (a blink closes them as usual).
    const browUp = slots.browUp ?? -1, wide = slots.surprise ?? -1, lidsOpen = 1 - clamp01(lids.closure ?? 0);
    if (browUp >= 0 && out.browUp > 0) port.morph(browUp, out.browUp);
    if (wide >= 0 && out.eyeWide > 0 && lidsOpen > 0) port.morph(wide, out.eyeWide * lidsOpen);
    const feed = Number.isFinite(feedOwner) ? feedOwner : 0;
    const smile = composeMouthExpression(out.mouthSmile, this.speechOwner, feed), open = composeMouthExpression(out.mouthOpen, this.speechOwner, feed);
    if (slots.mouthSmile >= 0 && smile > 0) port.morph(slots.mouthSmile, smile);
    if (slots.mouthOpen >= 0 && open > 0) port.morph(slots.mouthOpen, open);
  }

  /**
   * Expression-preview head and eyes, called by the stage inside the preview
   * frame with the preview's own ownership gates. Returns how many bones it
   * rotated. Missing bones are skipped.
   */
  applyPreview(port: LifePort<B>, head: B | undefined, eyes: readonly B[], headAllowed: boolean, eyesAllowed: boolean, body?: B, bodyAllowed = false): number {
    const out = this.out;
    let applied = 0;
    if (headAllowed && head && (out.previewHeadX !== 0 || out.previewHeadY !== 0 || out.previewHeadZ !== 0)) { port.rotate(head, out.previewHeadX, out.previewHeadY, out.previewHeadZ); applied++; }
    // E1 shows: the upper body leans back (surprise) or draws in (shy).
    if (bodyAllowed && body && (out.previewBodyX !== 0 || out.previewBodyZ !== 0)) { port.rotate(body, out.previewBodyX, 0, out.previewBodyZ); applied++; }
    if (eyesAllowed && (out.previewEyePitch !== 0 || out.previewEyeYaw !== 0)) for (const eye of eyes) { port.rotate(eye, out.previewEyePitch, out.previewEyeYaw, 0); applied++; }
    return applied;
  }

  /** Plain-data state for `data-procedural-life` and tests. */
  getState(): LifeState {
    const round = (value: number) => Math.round(value * 1e4) / 1e4;
    const params = {} as Record<keyof LifeParameters, number>;
    for (const key of Object.keys(this.params) as (keyof LifeParameters)[]) params[key] = round(this.params[key]);
    const m = smoothstep(this.master), o = this.out;
    return {
      enabled: this.enabled, active: this.active, master: round(this.master), seed: this.seed, params,
      primitives: {
        breath: { weight: round(m), rateHz: round(this.params.breathRate) },
        gaze: { weight: round(m * smoothstep(this.wGaze)), moment: this.moment === 1 ? 'user' : this.moment === 2 ? 'away' : 'none', saccades: this.saccades,
          yielding: decodeYields(this.yGaze | (this.enabled ? 0 : Y.disabled)) },
        tilt: { weight: round(m * smoothstep(this.wTilt)), moment: this.time < this.tiltEnd, yielding: decodeYields(this.yTilt | (this.enabled ? 0 : Y.disabled)) },
        sway: { weight: round(m * smoothstep(this.wSway)), yielding: decodeYields(this.ySway | (this.enabled ? 0 : Y.disabled)) },
        blink: { intervalS: round(this.blinkIntervalS), durationS: round(this.blinkDur), double: this.blinkDouble, blinks: this.blinks, doubles: this.doubles },
        expression: { weight: round(m * smoothstep(this.wExpr)), smileEyes: round(o.smileEyes), mouthSmile: round(o.mouthSmile), sad: round(o.sad), angry: round(o.angry),
          jitome: round(o.jitome), blush: round(o.blush), headX: round(this.exprHeadX * m), speechOwner: round(this.speechOwner),
          skipped: (['smileEyes', 'mouthSmile', 'sad', 'angry', 'jitome'] as const).filter(slot => !this.rig || this.rig.slots[slot] < 0),
          yielding: decodeYields(this.yExpr | (this.enabled ? 0 : Y.disabled)) },
        preview: this.previewClip === null ? null : { clip: this.previewClip, elapsedMs: round(this.previewMs), fade: round(this.previewFade),
          headX: round(o.previewHeadX), headY: round(o.previewHeadY), eyePitch: round(o.previewEyePitch), eyeYaw: round(o.previewEyeYaw),
          lidSoft: round(o.lidSoft), blush: round(this.showRecipe ? this.showHeld.blush : this.performanceHeld.blush),
          mouthSmile: round(this.showRecipe ? this.showHeld.mouthSmile : this.performanceHeld.mouthSmile), mouthOpen: round(o.mouthOpen),
          blocked: this.previewBlocked,
          ...(this.showRecipe ? { fade: round(this.showWeight), headZ: round(o.previewHeadZ), bodyX: round(o.previewBodyX), bodyZ: round(o.previewBodyZ),
            browUp: round(o.browUp), eyeWide: round(o.eyeWide),
            skipped: (['browUp', 'surprise', 'mouthSmile', 'mouthOpen', 'smileEyes', 'sad'] as const).filter(slot => !this.rig || (this.rig.slots[slot] ?? -1) < 0) } : {}) },
      },
      output: { headX: round(o.headX), headY: round(o.headY), headZ: round(o.headZ), swayY: round(o.swayY), swayZ: round(o.swayZ), shoulder: round(o.shoulder),
        gazeX: round(o.gazeX), gazeY: round(o.gazeY), gazeBlend: round(o.gazeBlend), smileEyes: round(o.smileEyes), jitome: round(o.jitome), lidSoft: round(o.lidSoft),
        mouthSmile: round(o.mouthSmile), mouthOpen: round(o.mouthOpen), sad: round(o.sad), angry: round(o.angry), blush: round(o.blush) },
      rig: this.rig ? { upperBody: this.rig.upperBody !== undefined, shoulders: this.rig.shoulderLeft !== undefined && this.rig.shoulderRight !== undefined } : null,
    };
  }

  /** `data-procedural-life` text, refreshed at most every 250 ms of the caller's clock (ms). */
  diagnostics(nowMs: number): string {
    if (!(nowMs - this.diagnosticsAt < 250)) { this.diagnosticsAt = nowMs; this.diagnosticsText = JSON.stringify(this.getState()); }
    return this.diagnosticsText;
  }

  // ------------------------------------------------------------ internals

  private zero(): void {
    const out = this.out;
    out.breath = out.mix = out.headX = out.headY = out.headZ = out.swayY = out.swayZ = out.shoulder = out.gazeX = out.gazeY = out.gazeBlend = 0;
    out.pointerFollow = 1; this.actLid = 0; this.actMouth = 0;
    out.smileEyes = out.jitome = out.lidSoft = out.mouthSmile = out.mouthOpen = out.sad = out.angry = out.blush = 0;
    out.previewHeadX = out.previewHeadY = out.previewEyePitch = out.previewEyeYaw = 0;
    out.previewHeadZ = out.previewBodyX = out.previewBodyZ = out.browUp = out.eyeWide = 0;
    this.wGaze = this.wTilt = this.wSway = this.wExpr = 0; this.exprHeadX = 0;
    this.expression.reset();
    this.previewFade = 0; this.previewClip = null; this.previewMs = 0; this.previewBlocked = false;
    this.showWeight = 0; this.showRecipe = null; showSample(null, Number.NaN, true, this.showHeld);
    this.showStrength.reset(1); this.showCarry.reset(); showSample(null, Number.NaN, true, this.showShown); this.showGain.bone = this.showGain.face = 0;
  }

  /** Parameters follow the mood with a ~1.5 s time constant (the first frame adopts them). */
  private temper(dt: number): void {
    const p = this.params, t = this.target, k = this.paramsReady ? 1 - Math.exp(-dt / 1.5) : 1;
    p.amplitude += (t.amplitude - p.amplitude) * k; p.gaze += (t.gaze - p.gaze) * k; p.expression += (t.expression - p.expression) * k;
    p.speed += (t.speed - p.speed) * k; p.smoothness += (t.smoothness - p.smoothness) * k; p.asymmetry += (t.asymmetry - p.asymmetry) * k;
    p.lookAtUser += (t.lookAtUser - p.lookAtUser) * k; p.lookAway += (t.lookAway - p.lookAway) * k; p.gazeDown += (t.gazeDown - p.gazeDown) * k;
    p.breathRate += (t.breathRate - p.breathRate) * k; p.blinkInterval += (t.blinkInterval - p.blinkInterval) * k;
    p.blinkDuration += (t.blinkDuration - p.blinkDuration) * k; p.doubleBlink += (t.doubleBlink - p.doubleBlink) * k; p.drowsy += (t.drowsy - p.drowsy) * k;
    this.paramsReady = true;
  }

  private yieldWeights(dt: number, g: LifeGates, fatigue: LifeFatigue | null | undefined): void {
    const asleep = fatigue?.sleeping === true || fatigue?.phase === 'falling-asleep' || fatigue?.phase === 'asleep' || fatigue?.phase === 'micro-awake';
    const common = (g.expressive ? 0 : Y.paused) | (g.contact ? Y.contact : 0) | (g.preview ? Y.preview : 0) | (g.adjusting ? Y.adjusting : 0);
    const body = (g.manualPose ? Y['manual-pose'] : 0) | (g.manualGesture ? Y['manual-gesture'] : 0) | (g.chatGesture ? Y['chat-gesture'] : 0)
      | (g.music ? Y.music : 0) | (g.bodyMotion ? Y['body-motion'] : 0) | (asleep ? Y.sleep : 0);
    this.yGaze = common | (g.manualExpression ? Y['manual-expression'] : 0) | (!g.gazeAllowed || asleep ? Y.sleep : 0);
    // The fatigue presentation's own drowsy nod owns the head pitch/tilt while it shows.
    this.yTilt = common | body | (g.manualHead ? Y['manual-head'] : 0) | (g.headOwned ? Y['head-owned'] : 0) | (g.fatigueFace ? Y.fatigue : 0);
    this.ySway = common | body;
    this.yExpr = (g.expressive ? 0 : Y.paused) | (g.contact ? Y.contact : 0) | (g.preview ? Y.preview : 0) | (g.manualExpression ? Y['manual-expression'] : 0)
      | (g.authoredFace ? Y['authored-face'] : 0) | (asleep ? Y.sleep : 0);
    this.wExpr = ramp(this.wExpr, this.yExpr ? 0 : 1, dt);
    this.wGaze = ramp(this.wGaze, this.yGaze ? 0 : 1, dt);
    this.wTilt = ramp(this.wTilt, this.yTilt ? 0 : 1, dt);
    this.wSway = ramp(this.wSway, this.ySway ? 0 : 1, dt);
  }

  private breathe(dt: number, p: LifeParameters, m: number): void {
    const t = this.time, n = this.noise;
    const rate = p.breathRate * (1 + 0.1 * n.sample(t * 0.05, 1));
    this.breathPhase = (this.breathPhase + Math.PI * 2 * rate * dt) % (Math.PI * 2);
    const depth = 1 + 0.14 * n.sample(t * 0.035, 2);
    this.out.breath = Math.sin(this.breathPhase) * depth;
    this.out.mix = m;
    // Shoulders rise a little on the inhale, slightly after the chest.
    const inhale = (Math.sin(this.breathPhase - 0.6) + 1) / 2;
    this.out.shoulder = clamp(0.0065 * inhale * depth * this.breathStrength * m * smoothstep(this.wSway), 0, LIFE_LIMITS.shoulder);
  }

  private gaze(dt: number, input: LifeInput<B>, p: LifeParameters, w: number): void {
    const t = this.time, r = this.random, n = this.noise, out = this.out;
    // The user's own pointer leads: while it moves, drift and moments step back.
    const px = Number.isFinite(input.pointerX) ? input.pointerX : 0, py = Number.isFinite(input.pointerY) ? input.pointerY : 0;
    // Plain arithmetic, not Math.hypot: the builtin call boxes its double arguments every frame.
    const dx = px - this.lastPointerX, dy = py - this.lastPointerY;
    const speed = Number.isFinite(dx) && Number.isFinite(dy) && dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;
    this.lastPointerX = px; this.lastPointerY = py;
    const moving = clamp01(speed / 0.6);
    this.activity = moving > this.activity ? ease(this.activity, moving, 0.08, dt) : ease(this.activity, moving, 1.2, dt);
    const tempo = Math.max(0.3, p.speed), act = this.act, sacc = act ? clamp(act.saccade, 0.1, 2) : 1;
    if (t >= this.nextSaccade) {
      const radius = (0.03 + 0.06 * r.next()) * p.gaze * sacc, angle = r.range(0, Math.PI * 2);
      this.saccadeX = Math.cos(angle) * radius; this.saccadeY = Math.sin(angle) * radius * 0.6;
      this.nextSaccade = t + (0.9 + 2.4 * p.smoothness) * r.range(0.6, 1.4) / tempo / Math.max(0.5, sacc);
      this.saccades++;
    }
    if (this.moment !== 0 && t >= this.momentEnd) { this.moment = 0; this.nextMoment = t + r.range(5, 12) / tempo; }
    if (this.moment === 0 && t >= this.nextMoment) {
      const lookAtUser = p.lookAtUser * (act ? clamp(act.lookAtUser, 0, 3) : 1);
      const roll = r.next() * (1 + lookAtUser + p.lookAway), user = lookAtUser + (this.speaking ? 0.3 : 0);
      if (roll < user) { this.moment = 1; this.momentEnd = t + r.range(1, 2.6); this.saccadeX = this.saccadeY = 0; }
      else if (roll < user + p.lookAway) {
        this.moment = 2; this.momentEnd = t + r.range(0.8, 1.8);
        this.awayX = (r.next() < 0.5 ? -1 : 1) * r.range(0.12, 0.22) * p.gaze; this.awayY = r.range(-0.12, -0.05) * p.gaze + p.gazeDown;
      } else this.nextMoment = t + r.range(5, 12) / tempo;
    }
    this.userWeight = ease(this.userWeight, this.moment === 1 ? 1 : 0, 0.22, dt);
    this.awayWeight = ease(this.awayWeight, this.moment === 2 ? 1 : 0, 0.3, dt);
    const f = tempo * (1.25 - 0.5 * p.smoothness);
    const driftX = 0.032 * p.gaze * n.fbm(t * 0.09 * f, 3), driftY = 0.02 * p.gaze * n.fbm(t * 0.07 * f, 4) + p.gazeDown;
    const lead = 1 - 0.75 * this.activity, gaze = 1 - 0.75 * this.userWeight;
    // 她自己的生活: her own far look rides on the drift (a moving pointer leads it back too); a look-up turns her eyes to the user.
    const up = act ? clamp01(act.lookUp) * smoothstep(this.master) : 0, ax = act ? act.gazeX * this.side + (act.gazeFixedX ?? 0) : 0, ay = act ? act.gazeY + (act.gazeFixedY ?? 0) : 0;
    out.gazeX = clamp(w * lead * ((driftX + this.saccadeX + ax) * gaze + this.awayX * this.awayWeight) * (1 - up), -LIFE_LIMITS.gaze.x, LIFE_LIMITS.gaze.x) + 0;
    out.gazeY = clamp(w * lead * ((driftY + this.saccadeY + ay) * gaze + this.awayY * this.awayWeight) * (1 - up), -LIFE_LIMITS.gaze.y, LIFE_LIMITS.gaze.y) + 0;
    out.gazeBlend = clamp01(Math.max(w * this.userWeight * (1 - this.activity), up)) + 0;
    out.pointerFollow = act ? clamp01(1 - w * (1 - clamp01(act.pointerFollow)) * (1 - this.activity) * (1 - up)) : 1;
  }

  private tilt(p: LifeParameters, w: number): void {
    const t = this.time, r = this.random, n = this.noise, out = this.out, f = Math.max(0.3, p.speed) * (1.25 - 0.5 * p.smoothness);
    if (t >= this.nextTilt) {
      if (t >= this.tiltEnd && r.next() < 0.5 + 0.25 * Math.abs(p.asymmetry)) {
        const side = r.next() < 0.5 + 0.35 * p.asymmetry ? 1 : -1;
        this.tiltStart = t; this.tiltEnd = t + r.range(1.4, 3) * (0.8 + 0.4 * p.smoothness); this.tiltPeak = side * r.range(0.026, 0.042);
      }
      this.nextTilt = t + r.range(7, 16) / Math.max(0.3, p.speed);
    }
    const moment = t < this.tiltEnd ? smoothstep((t - this.tiltStart) / 0.45) * (1 - smoothstep((t - (this.tiltEnd - 0.6)) / 0.6)) * this.tiltPeak : 0;
    const a = p.amplitude * w, act = this.act;
    let x = a * 0.006 * n.fbm(t * 0.08 * f, 5) + this.exprHeadX * smoothstep(this.master);
    let y = a * 0.009 * n.fbm(t * 0.06 * f, 6);
    let z = a * (0.011 * n.fbm(t * 0.11 * f, 7) + 0.005 * p.asymmetry + moment);
    // 她自己的生活: her own head angle (mirrored by her side) and the look-up's small chin lift, under the same owners and clamp.
    if (act) { x += w * (act.headX - LIFE_LOOK_UP_LIFT * clamp01(act.lookUp)); y += w * act.headY * this.side; z += w * act.headZ * this.side; }
    // M1: the light nod to the music rides the same weight and the same clamps.
    const beat = this.beat;
    if (beat) { x += w * beat.headX; z += w * beat.headZ; }
    x = clamp(x, -LIFE_LIMITS.head.x, LIFE_LIMITS.head.x); y = clamp(y, -LIFE_LIMITS.head.y, LIFE_LIMITS.head.y); z = clamp(z, -LIFE_LIMITS.head.z, LIFE_LIMITS.head.z);
    const norm = Math.sqrt(x * x + y * y + z * z);
    if (norm > LIFE_LIMITS.head.total) { const k = LIFE_LIMITS.head.total / norm; x *= k; y *= k; z *= k; }
    // `+ 0` keeps a yielded output a plain zero (never -0) for the stage's `!== 0` checks and diagnostics.
    out.headX = x + 0; out.headY = y + 0; out.headZ = z + 0;
  }

  /** R36: mood targets, gated by owners and missing slots, then the bounded 0.35 s / 0.5 s smoothing. */
  private express(dt: number, input: LifeInput<B>, p: LifeParameters, m: number): void {
    const t = this.time, n = this.noise, wobble = this.wobble, target = this.exprTarget, out = this.out, g = input.gates;
    this.speechOwner = ease(this.speechOwner, g.speaking ? 1 : 0, g.speaking ? 0.08 : 0.35, dt);
    wobble.smile = n.sample(t * 0.11, 20); wobble.brow = n.sample(t * 0.09, 21); wobble.lid = n.sample(t * 0.07, 22); wobble.blush = n.sample(t * 0.05, 23);
    const blush = input.blush, blushScale = blush && blush.enabled === true && blush.size > 0 && Number.isFinite(blush.intensity) ? blush.intensity / 35 : 0;
    expressionTargets(input.mood, p.expression, p.drowsy, blushScale, wobble, target);
    // 她自己的生活: her own activity's face (humming: smiling eyes, a closed smile) joins the mood's, under the same gates.
    const act = this.act;
    if (act) {
      target.smileEyes = Math.max(target.smileEyes, clamp01(act.smileEyes) * Math.min(1, p.expression));
      target.mouthSmile = Math.max(target.mouthSmile, clamp01(act.mouthSmile) * Math.min(1, p.expression));
      if (act.sad) target.sad = Math.max(target.sad, clamp01(act.sad) * Math.min(1, p.expression));
      if (act.angry) target.angry = Math.max(target.angry, clamp01(act.angry) * Math.min(1, p.expression));
    }
    this.actLid = act && !this.yExpr ? clamp01(act.lidSoft) * Math.min(1, p.expression) * m * smoothstep(this.wExpr) : 0;
    this.actMouth = act?.mouthOpen && !this.yExpr ? clamp01(act.mouthOpen) * Math.min(1, p.expression) * m * smoothstep(this.wExpr) : 0;
    const slots = this.rig?.slots;
    if (this.yExpr) target.smileEyes = target.mouthSmile = target.sad = target.angry = target.jitome = target.blush = 0;
    if (!slots || slots.smileEyes < 0) target.smileEyes = 0;
    if (!slots || slots.mouthSmile < 0 || g.manualMouth) target.mouthSmile = 0;
    if (!slots || slots.sad < 0) target.sad = 0;
    if (!slots || slots.angry < 0) target.angry = 0;
    // A fatigue presentation already shows the drowsy lids: R36 adds no second half-lid.
    if (!slots || slots.jitome < 0 || g.fatigueFace) target.jitome = 0;
    // The tiny pitch follows the head's owners (tilt yields) as well as the face's.
    if (this.yExpr || this.yTilt) target.headX = 0;
    const value = this.expression.frame(dt, target);
    out.smileEyes = value.smileEyes * m; out.mouthSmile = value.mouthSmile * m; out.sad = value.sad * m; out.angry = value.angry * m;
    out.jitome = value.jitome * m; out.blush = value.blush * m; out.lidSoft = 0; out.mouthOpen = 0;
    this.exprHeadX = clamp(value.headX, -EXPRESSION_LIMITS.headX, EXPRESSION_LIMITS.headX);
  }

  /**
   * Expression-preview additions on the preview's clock. Face channels merge
   * into the R36 outputs (which yield during previews); if the preview is cut
   * short they fade out over 0.3 s instead of popping (the blink and mouth
   * morphs and the blush have no continuity guard). Head and eyes are applied
   * only inside the preview frame (`applyPreview`), where the guard catches a cut.
   */
  private perform(dt: number, input: LifeInput<B>, m: number): void {
    const out = this.out, g = input.gates, held = this.performanceHeld, clip = typeof input.previewClip === 'string' ? input.previewClip : null;
    out.previewHeadZ = out.previewBodyX = out.previewBodyZ = out.browUp = out.eyeWide = 0;
    const show = showRecipeOfClip(clip);
    if (show !== null || (clip === null && this.showRecipe !== null)) { this.performShow(dt, input, m, show); return; }
    if (clip !== null) {
      const sample = previewPerformance(clip, input.previewElapsedMs ?? Number.NaN, input.hasEyes, this.performance);
      held.headX = clamp(sample.headX, -PERFORMANCE_LIMITS.headX, PERFORMANCE_LIMITS.headX); held.headY = clamp(sample.headY, -PERFORMANCE_LIMITS.headY, PERFORMANCE_LIMITS.headY);
      held.eyePitch = clamp(sample.eyePitch, -PERFORMANCE_LIMITS.eyePitch, PERFORMANCE_LIMITS.eyePitch); held.eyeYaw = clamp(sample.eyeYaw, -PERFORMANCE_LIMITS.eyeYaw, PERFORMANCE_LIMITS.eyeYaw);
      held.lidSoft = clamp(sample.lidSoft, 0, PERFORMANCE_LIMITS.lidSoft); held.blush = clamp(sample.blush, 0, PERFORMANCE_LIMITS.blush);
      held.mouthSmile = clamp(sample.mouthSmile, 0, PERFORMANCE_LIMITS.mouthSmile); held.mouthOpen = clamp(sample.mouthOpen, 0, PERFORMANCE_LIMITS.mouthOpen);
      this.previewFade = 1; this.previewClip = clip; this.previewMs = input.previewElapsedMs ?? 0;
    } else if (this.previewFade > 0) {
      this.previewFade = Math.max(0, this.previewFade - dt / LIFE_FADE_OUT);
      if (this.previewFade === 0) { this.previewClip = null; held.headX = held.headY = held.eyePitch = held.eyeYaw = held.lidSoft = held.blush = held.mouthSmile = held.mouthOpen = 0; }
    }
    this.previewBlocked = input.previewBlocked === true;
    const fade = clip !== null ? 1 : smoothstep(this.previewFade);
    // The preview's own gate and a picked expression win over its face, as they do over its brows and eyes.
    const face = this.previewBlocked || g.contact || g.adjusting || g.manualExpression ? 0 : fade * m;
    const blush = input.blush, blushScale = blush && blush.enabled === true && blush.size > 0 && Number.isFinite(blush.intensity) ? clamp(blush.intensity / 35, 0.6, 1.5) : 0;
    out.lidSoft = Math.max(held.lidSoft * face, this.actLid);
    out.blush = Math.max(out.blush, held.blush * blushScale * face);
    out.mouthSmile = Math.max(out.mouthSmile, g.manualMouth ? 0 : held.mouthSmile * face);
    out.mouthOpen = g.manualMouth ? 0 : this.actMouth > 0 ? Math.max(held.mouthOpen * face, this.actMouth) : held.mouthOpen * face;
    const bones = clip !== null && !this.previewBlocked ? m : 0;
    out.previewHeadX = held.headX * bones + 0; out.previewHeadY = held.headY * bones + 0;
    out.previewEyePitch = held.eyePitch * bones + 0; out.previewEyeYaw = held.eyeYaw * bones + 0;
  }

  /**
   * E1 shows (expression-show.ts) on their own clock. One weight carries face and bones alike: a show starts at full
   * weight (its tracks start at 0), and when something takes over (a pat, a window move, hidden) or it is cut short the
   * weight eases out over 0.3 s from what is shown — and back in if it is free again — so nothing pops, bones included.
   */
  private performShow(dt: number, input: LifeInput<B>, m: number, recipe: ExpressionRecipe | null): void {
    const out = this.out, g = input.gates, held = this.showHeld, carry = this.showCarry;
    const blocked = input.previewBlocked === true || g.contact || g.adjusting;
    // I-038 / I-037 (show-blend.ts): the same show again from its start, or the other one, while one shows: the one that
    // was showing keeps playing on its own clock and fades out (captured before this frame's step, so it is in this frame).
    const restart = recipe !== null && this.showRecipe !== null && this.showWeight > 0 && (this.showRecipe !== recipe || (input.previewElapsedMs ?? 0) < this.previewMs);
    if (restart) carry.capture(this.showRecipe!, this.previewMs, input.hasEyes, this.showGain.bone, this.showGain.face);
    carry.step(dt);
    if (recipe !== null) {
      const strength = clampStrength(input.previewStrength);
      showSample(recipe, input.previewElapsedMs ?? Number.NaN, input.hasEyes, held);
      if (this.showRecipe !== recipe || restart) { this.showWeight = blocked ? 0 : 1; this.showStrength.reset(strength); }
      else {
        this.showWeight = blocked ? Math.max(0, this.showWeight - dt / LIFE_FADE_OUT) : Math.min(1, this.showWeight + dt / LIFE_FADE_OUT);
        this.showStrength.step(strength, dt); // asked again while it holds: the higher strength, eased in
      }
      this.showRecipe = recipe; this.previewClip = SHOW_CLIP[recipe]; this.previewMs = input.previewElapsedMs ?? 0;
    } else {
      // Ended or cut: what is shown eases out over 0.3 s (an ended show is already at rest).
      this.showWeight = Math.max(0, this.showWeight - dt / LIFE_FADE_OUT);
      if (this.showWeight === 0) { this.showRecipe = null; this.previewClip = null; showSample(null, Number.NaN, true, held); }
    }
    this.previewBlocked = blocked;
    // A strength of 1 multiplies exactly, so a full-strength show without a carry is the very same arithmetic as before.
    const w = smoothstep(this.showWeight) * m * this.showStrength.value, face = g.manualExpression ? 0 : w;
    this.showGain.bone = w; this.showGain.face = face;
    const blush = input.blush, blushScale = blush && blush.enabled === true && blush.size > 0 && Number.isFinite(blush.intensity) ? clamp(blush.intensity / 35, 0.6, 1.5) : 0;
    const shown = this.showShown, faceOn = g.manualExpression ? 0 : 1, mouthOn = g.manualMouth ? 0 : faceOn;
    for (const key of SHOW_KEYS) shown[key] = held[key] * (SHOW_BONE_KEYS.has(key) ? w : face);
    if (carry.active) for (const key of SHOW_KEYS) shown[key] += carry.at(key) * (SHOW_BONE_KEYS.has(key) ? 1 : key === 'mouthSmile' || key === 'mouthOpen' ? mouthOn : faceOn);
    const c = carry.active;
    out.lidSoft = Math.max(c ? shown.lidSoft : held.lidSoft * face, this.actLid);
    out.blush = Math.max(out.blush, c ? shown.blush * blushScale : held.blush * blushScale * face);
    out.mouthSmile = Math.max(out.mouthSmile, g.manualMouth ? 0 : c ? shown.mouthSmile : held.mouthSmile * face);
    const mouthOpen = c ? shown.mouthOpen : held.mouthOpen * face;
    out.mouthOpen = g.manualMouth ? 0 : this.actMouth > 0 ? Math.max(mouthOpen, this.actMouth) : mouthOpen;
    out.smileEyes = Math.max(out.smileEyes, c ? shown.smileEyes : held.smileEyes * face);
    out.sad = Math.max(out.sad, c ? shown.browSad : held.browSad * face);
    out.browUp = (c ? shown.browUp : held.browUp * face) + 0; out.eyeWide = (c ? shown.eyeWide : held.eyeWide * face) + 0;
    out.previewHeadX = shown.headX + 0; out.previewHeadY = shown.headY + 0; out.previewHeadZ = shown.headZ + 0;
    out.previewBodyX = shown.bodyX + 0; out.previewBodyZ = shown.bodyZ + 0;
    out.previewEyePitch = shown.eyePitch + 0; out.previewEyeYaw = shown.eyeYaw + 0;
  }

  private sway(p: LifeParameters, w: number): void {
    const t = this.time, n = this.noise, act = this.act, k = act ? clamp(act.sway, 0, 2) : 1, a = p.amplitude * w * k, f = Math.max(0.3, p.speed);
    this.out.swayZ = clamp(a * 0.0065 * n.fbm(t * 0.07 * f, 8) + (act ? w * act.bodyZ : 0) + (this.beat ? w * this.beat.bodyZ : 0), -LIFE_LIMITS.sway.z, LIFE_LIMITS.sway.z) + 0;
    this.out.swayY = clamp(a * 0.005 * n.fbm(t * 0.05 * f, 9), -LIFE_LIMITS.sway.y, LIFE_LIMITS.sway.y) + 0;
  }
}

/** Resolves the rig of one model from its profile (standard bones, semantic slots); missing parts stay undefined / -1. */
export function lifeRig<B>(owner: object, profile: {
  bone(slot: 'upperBody' | 'shoulderLeft' | 'shoulderRight'): B | undefined;
  readonly profile: { readonly morphs: Readonly<Record<string, { readonly index: number }>> } | null;
  readonly indices: { readonly mouth: number };
} | null | undefined, fallbackUpper?: B): LifeRig<B> {
  const slot = (name: string) => { const index = profile?.profile?.morphs[name]?.index; return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : -1; };
  const open = slot('o');
  return {
    owner, upperBody: profile?.bone('upperBody') ?? fallbackUpper, shoulderLeft: profile?.bone('shoulderLeft'), shoulderRight: profile?.bone('shoulderRight'),
    slots: { smileEyes: slot('smileEyes'), mouthSmile: slot('mouthSmile'), sad: slot('sad'), angry: slot('angry'), jitome: slot('jitome'),
      mouthOpen: open >= 0 && open !== profile?.indices.mouth ? open : -1, browUp: slot('browUp'), surprise: slot('surprise') },
  };
}
