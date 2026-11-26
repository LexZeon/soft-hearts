/**
 * Motion-model spike round 2 (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮 · 给 lapwing 展示的接口」): one small entry
 * point for whoever wants the learned idle (the lapwing showcase's quiet holds and "own world" beats first).
 *
 *   const idle = createLearnedIdle({ heightM: figure.heightM, activation: 0.4, seed: 7, weights, events });
 *   each frame:  figure.setPoseTargets(layerIdle(myTargets, idle.frame(dt), 1));      // or idle.frame(dt) alone
 *   in a chain:  new GeneratorChain([idle.generator, new ProceduralGenerator()])        // answers the 'idle' intent
 *
 * `weights` is the trained model's JSON (scripts/ml/train_idle_vae.py). The 100STYLE one lives under .local/ml/ only; the StayStill
 * one ships for the Unbound window (assets/bundled/unbound/idle/, bundled-idle.ts). Without weights it falls back to the procedural idle, so callers never
 * need two code paths. `events` (scripts/ml/idle_events.py) adds the people's quick small moves on top; without it, none.
 * Everything it returns is layer-2 targets: the intent layer's springs and the contact owner still decide how her body gets there.
 */
import { IdleGenerator, type ContinuousIdleSource, type IdleSource } from './idle-channels';
import { IdleModel, ModelIdle, type IdleModelWeights } from './idle-model';
import { IdleEvents, type IdleEventLibrary } from './idle-events';
import { ProceduralIdle } from './idle-procedural';
import { ZERO_ROT, type ArmRot, type BodySense, type PoseTargets, type Rot } from './generator';

export interface LearnedIdleOptions {
  /** Her height (m; figure.heightM): the hip shifts are per meter of height in the data. */
  heightM: number;
  /** Liveliness 0..1 (the knob of the liveliness research, rule 11). Default 0.5. */
  activation?: number;
  seed?: number;
  weights?: IdleModelWeights | null;
  events?: IdleEventLibrary | null;
  /** Move the hips and arms too (default true). */
  limbs?: boolean;
  /** Overall size (default 1: as much as the people). */
  gain?: number;
  /** Quick moves: scale on the training data's rate per liveliness (default LEARNED_IDLE_EVENT_RATE). */
  eventRate?: number;
  /** The model's calibration gains (default true; the StayStill model is shown without them: docs/claude/2026-11-14-staystill-idle.md). */
  calibrated?: boolean;
  /** The leash toward her stand pose (s, 0 = off; default the model idle's own, 12). */
  leashS?: number;
  /** Soft limits on what she is shown (absent: none). */
  bounds?: IdleBounds | null;
}

/**
 * Soft limits (docs/claude/2026-11-14-staystill-idle.md「接进 Unbound」): below the knee nothing changes; above it the value bends
 * smoothly toward the most (same value and slope at the knee, never past the most), so a long run cannot wander far off.
 *   head chain   torso + neck + head yaw together (deg), scaled as one so the three keep their shares
 *   hip shift    the pelvis' sideways and forward shift together (per meter of her height), toward the edge of her feet
 */
export interface IdleBounds { headYawKneeDeg: number; headYawMaxDeg: number; hipShiftKnee: number; hipShiftMax: number }

/** |x| up to `knee`: x; beyond: knee + (most − knee)·tanh((|x| − knee) / (most − knee)), same sign. */
export function softKnee(x: number, knee: number, most: number): number {
  if (!Number.isFinite(x)) return 0;
  if (!(most > knee)) return Math.max(-most, Math.min(most, x)); // no room to bend: a plain clamp
  const a = Math.abs(x);
  if (a <= knee) return x;
  return Math.sign(x) * (knee + (most - knee) * Math.tanh((a - knee) / (most - knee)));
}

export function boundIdle(t: PoseTargets, bounds: IdleBounds, heightM: number): PoseTargets {
  const D = Math.PI / 180, yaw = t.torso.yaw + t.neck.yaw + t.head.yaw;
  const yawScale = Math.abs(yaw) > 1e-9 ? softKnee(yaw, bounds.headYawKneeDeg * D, bounds.headYawMaxDeg * D) / yaw : 1;
  const h = Math.max(0.5, Math.min(3, heightM)), shift = Math.hypot(t.pelvis.lateral, t.pelvis.forward);
  const shiftScale = shift > 1e-9 ? softKnee(shift, bounds.hipShiftKnee * h, bounds.hipShiftMax * h) / shift : 1;
  if (yawScale === 1 && shiftScale === 1) return t;
  return {
    ...t,
    torso: { ...t.torso, yaw: t.torso.yaw * yawScale }, neck: { ...t.neck, yaw: t.neck.yaw * yawScale }, head: { ...t.head, yaw: t.head.yaw * yawScale },
    pelvis: { ...t.pelvis, lateral: t.pelvis.lateral * shiftScale, forward: t.pelvis.forward * shiftScale },
  };
}

/**
 * The training stretches are calmer than the held-out people (short stretches before walking): their rate table gives 0.87 quick
 * moves a minute at the middle of the knob, the people made 8.0 a minute on average with the same detector. ×9 ≈ the people's.
 */
export const LEARNED_IDLE_EVENT_RATE = 9;

export interface LearnedIdle {
  /** 'model', 'model+events' or 'procedural' (no weights). */
  readonly id: string;
  readonly learned: boolean;
  activation: number;
  /** This frame's targets (advances by `dt` seconds; `activation` changes the knob from now on). */
  frame(dt: number, activation?: number): PoseTargets;
  /** A layer-2 generator for the 'idle' intent (put it first in a GeneratorChain). */
  readonly generator: IdleGenerator;
  reset(seed?: number): void;
  /** Unbound step 4: a quick move (the events layer) is under way now; absent or false without one. */
  quickBusy?(): boolean;
}

const SENSE = { root: { x: 0, z: 0, heading: 0 }, moving: false, eyes: { left: null, right: null }, head: null, frame: null, offsets: { lateral: 0, forward: 0, up: 0 }, eyeSizeM: null, tiptoeRise: 0 } as BodySense;

export function createLearnedIdle(options: LearnedIdleOptions): LearnedIdle {
  const seed = options.seed ?? 1;
  let source: IdleSource | ContinuousIdleSource;
  let learned = false;
  try {
    if (options.weights) {
      const leashS = options.leashS !== undefined && Number.isFinite(options.leashS) ? { leashS: Math.max(0, options.leashS) } : {};
      const model = new ModelIdle(new IdleModel(options.weights), { seed, ...leashS, ...(options.calibrated === false ? { calibrated: false } : {}) });
      source = options.events ? new IdleEvents(model, options.events, { seed: seed + 100, rateScale: options.eventRate ?? LEARNED_IDLE_EVENT_RATE }) : model;
      learned = true;
    } else source = new ProceduralIdle(seed);
  } catch { source = new ProceduralIdle(seed); learned = false; } // weights for other channels: fall back, never throw at her
  const generator = new IdleGenerator(source, { heightM: options.heightM, gain: options.gain, limbs: options.limbs });
  const idle: LearnedIdle = {
    id: source.id, learned, generator,
    activation: clamp01(options.activation ?? 0.5),
    frame(dt: number, activation?: number) {
      if (activation !== undefined && Number.isFinite(activation)) idle.activation = clamp01(activation);
      const targets = generator.generate({ intent: { kind: 'idle', activity: idle.activation }, t: 0, dt, sense: SENSE });
      return options.bounds ? boundIdle(targets, options.bounds, options.heightM) : targets;
    },
    reset(next?: number) { generator.reset(); if (next !== undefined) source.reset(next); },
    quickBusy: () => source instanceof IdleEvents && source.busy,
  };
  return idle;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
const addRot = (a: Rot, b: Rot, w: number): Rot => ({ pitch: a.pitch + b.pitch * w, yaw: a.yaw + b.yaw * w, roll: a.roll + b.roll * w });
const addArm = (a: ArmRot | undefined, b: ArmRot, w: number): ArmRot => ({ upper: addRot(a?.upper ?? ZERO_ROT, b.upper, w), elbow: addRot(a?.elbow ?? ZERO_ROT, b.elbow, w) });

/**
 * Lays an idle on top of other targets (a held look, a lean, a pose of the showcase): torso, neck, head, hips, arms and hip shift
 * add (scaled by `weight` 0..1, which the caller eases so the idle fades in and out); everything else (place, facing, eyes, face,
 * blink, tiptoe, tempo) stays the base's.
 */
export function layerIdle(base: PoseTargets, idle: PoseTargets, weight: number, headScale = 1): PoseTargets {
  const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0));
  if (w === 0) return base;
  // I-170: while you talk only the idle's own head and neck are calmed (shared/behaviors/talk-calm); her torso and hips sway as before.
  const wh = w * Math.max(0, Math.min(1, Number.isFinite(headScale) ? headScale : 1));
  const out: PoseTargets = {
    ...base,
    torso: addRot(base.torso, idle.torso, w), neck: addRot(base.neck, idle.neck, wh), head: addRot(base.head, idle.head, wh),
    pelvis: { lateral: base.pelvis.lateral + idle.pelvis.lateral * w, forward: base.pelvis.forward + idle.pelvis.forward * w, vertical: base.pelvis.vertical + idle.pelvis.vertical * w },
  };
  if (idle.hips) out.hips = addRot(base.hips ?? ZERO_ROT, idle.hips, w);
  if (idle.armRot) out.armRot = { left: addArm(base.armRot?.left, idle.armRot.left, w), right: addArm(base.armRot?.right, idle.armRot.right, w) };
  return out;
}

