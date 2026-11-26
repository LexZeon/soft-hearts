/**
 * Unbound U2, layer 2 (base motion, generated live): the one small interface between the director (layer 1, what and when) and
 * the body (layer 3, dynamics and the human-feel filter). docs/claude/2026-11-12-unbound-peek.md「三层」.
 *
 *   director ──MotionRequest(intent, t, sense)──▶ MotionGenerator ──PoseTargets──▶ figure (springs, contact, IK) ──▶ bones
 *
 * The director never touches bones or springs; a generator never decides what happens next and never writes bones. So a
 * generator can be replaced or blended (`blendPoseTargets`) without touching either side: today the procedural one
 * (procedural.ts: lean, aim, approach, computed on the spot), later a trained motion model (Codex T-246e) that returns the same
 * PoseTargets for the same intents.
 *
 * Every target is a *goal*: the figure moves toward it through its springs (src/unbound/intent-layer.ts), so a generator may jump
 * its output (a new intent, a new model) and she still never jumps. The only exception is `blink`, which is a value on a
 * keyframed curve (crisp on purpose: a blink must not be softened).
 */
import type { BodyFrame, EyeAim, LensView, V3 } from './lens-align';
import type { HopPhase, HopRequest } from '../gait';
import type { HandTargets } from '../arm-reach';
import type { MorphSlot } from '../../../shared/actions';
import type { FaceGeometry } from '../../../shared/unbound/arrival';

/** A small rotation (rad) in the bone's parent frame: pitch about her left-right axis (+ = forward / down), yaw about up (+ = toward her left), roll about forward (+ = toward her left shoulder). */
export interface Rot { pitch: number; yaw: number; roll: number }
export const ZERO_ROT: Readonly<Rot> = Object.freeze({ pitch: 0, yaw: 0, roll: 0 });

/** How layer 3 tunes its springs for these targets (the same goal, met calmly, briskly, or with a little startle; `address`: a quicker head and neck for turning to you and a small nod, docs/claude/2026-11-14-unbound-night-e3-speech.md). */
export type Tempo = 'calm' | 'brisk' | 'startle' | 'address';

export interface PoseTargets {
  /**
   * I-170, optional: a talk signal is on this frame (you type, she thinks, prepares, speaks or reads aloud, her reply arrives). Only the
   * idle layer reads it (unbound-idle.ts: its own head motion calms, shared/behaviors/talk-calm); absent: not talking.
   */
  talking?: boolean;
  /** I-175 step 4, optional: how much a deliberate head action (a nod, a beat's tilt) holds her head now (0..1; shared/behaviors/part-mix/lids-head.ts). Only the idle layer reads it: its own head sway yields. */
  headHeld?: number;
  /** Where she stands (her floor, world m): the gait walks there. null: stay. */
  place: { x: number; z: number } | null;
  /** Who she turns to when not walking (a far point on her floor, world m); null: whoever the scene says (you). */
  facing: { x: number; z: number } | null;
  /** Gait speed while going there (m/s); null: her usual. */
  walkSpeedMps: number | null;
  /** I-203, optional: one brisk step there (quicker to speed and to stop; the kiss's step in). */
  walkBrisk?: boolean;
  /** Her upper body (split between 上半身 and 上半身2), her neck, her head. */
  torso: Rot; neck: Rot; head: Rot;
  /**
   * Where she looks (rad, from her head as the posture above leaves it): yaw + = toward her left, pitch + = down. Not an eye angle:
   * E1 (docs/claude/2026-11-14-eye-head-fix.md) splits it between her eyes, head and upper body (src/stage/eye-head.ts), and lets
   * it go when it is behind her. REST_TARGETS' own `eyes` object means "no target" (asksForGaze).
   */
  eyes: { yaw: number; pitch: number };
  /** Hips offset from where the gait has them (her frame, m): lateral + = her left, forward, vertical. */
  pelvis: { lateral: number; forward: number; vertical: number };
  /** Up on her toes, 0..1 (the contact owner rolls both planted feet about their toes and lifts her hips by the same). */
  tiptoe: number;
  /** Breath depth, as a factor on her usual (she holds it a little while staring). */
  breath: number;
  /** Face cues 0..1 (layer 3 picks the model's own morphs for them). */
  face: { curious: number; smile: number; startle: number };
  /** Eyelids 0..1, crisp (not filtered). */
  blink: number;
  tempo: Tempo;
  /** U2 E2: both arms raised overhead, 0..1 (layer 3 blends the arm chain from the motion's pose toward straight up, through a spring). */
  arms: { raise: number };
  /** U2 E2: a hop on the spot (the gait plays it with gravity; a new id starts one, the same id handed again is the same hop). */
  hop: HopRequest | null;
  /**
   * Showcase (docs/claude/2026-11-14-lapwing-showcase.md), optional: the model's universal expression slots 0..1 (each through its
   * own spring in layer 3), and a hand reach per side (src/unbound/arm-reach.ts). Absent: layer 3 writes nothing for them.
   */
  expr?: Partial<Record<MorphSlot, number>>;
  /** Showcase: shapes outside the slots, keyed by '|'-separated name candidates (the first the model has; none: skipped). */
  exprNamed?: Record<string, number>;
  /** Showcase: how much of a held look the head takes over (E1's recenterShare, 0..1); absent: the coordinator's own. */
  gazeRecenter?: number;
  hands?: HandTargets;
  /**
   * Motion-model spike round 2 (only the idle sources set them; absent = nothing): the hips' own turn and the arms' small idle
   * movements, each about her body's axes relative to the bone's parent (src/unbound/limb-residual.ts).
   */
  hips?: Rot;
  armRot?: { left: ArmRot; right: ArmRot };
}
export interface ArmRot { upper: Rot; elbow: Rot }

export const REST_TARGETS: Readonly<PoseTargets> = Object.freeze({
  place: null, facing: null, walkSpeedMps: null, torso: ZERO_ROT, neck: ZERO_ROT, head: ZERO_ROT, eyes: Object.freeze({ yaw: 0, pitch: 0 }),
  pelvis: Object.freeze({ lateral: 0, forward: 0, vertical: 0 }), tiptoe: 0, breath: 1, face: Object.freeze({ curious: 0, smile: 0, startle: 0 }), blink: 0, tempo: 'calm' as Tempo,
  arms: Object.freeze({ raise: 0 }), hop: null,
});

/** E1: whether targets ask her to look somewhere (any `eyes` but REST_TARGETS' own object, which `{ ...REST_TARGETS }` keeps). */
export const asksForGaze = (targets: PoseTargets): boolean => targets.eyes !== REST_TARGETS.eyes;

/** What her body measured on the last frame (world meters). */
export interface BodySense {
  root: { x: number; z: number; heading: number };
  /** Gait still walking or settling. */
  moving: boolean;
  /** I-203, optional: a foot is off the floor or about to be (walking, a step, a hop): `moving` without her slow last turn (absent: as `moving`). */
  stepping?: boolean;
  eyes: { left: V3 | null; right: V3 | null };
  head: V3 | null;
  /** Her current measurements in her own frame (null when the model lacks eye bones). */
  frame: BodyFrame | null;
  /** The hip offset and height the intent layer has realized right now (her frame, m; up includes her toes): the closed loop reads it. */
  offsets: { lateral: number; forward: number; up: number };
  /** How tall one of her eyes is (m; per model, at rest; null when unknown): the director sizes the close-up by it. `eyes` are the eyes as you see them (on their surface), not the bones. */
  eyeSizeM: number | null;
  /** How much higher her tiptoes can bring her (m). */
  tiptoeRise: number;
  /** I-192, optional: her face as the arrival targets read it (src/unbound/model/face-measure.ts; null or absent: unknown). */
  face?: FaceGeometry | null;
  /** U2 E2: the hop in progress (null when none), and how many she has landed since she appeared. */
  hop?: { phase: HopPhase | null; id: number; landed: number };
  /** U2 E2: her COM's margin over her support (m; null in the air or when it cannot be measured). */
  comMargin?: number | null;
}

/**
 * What the director asks for. `t` is seconds since this intent began. Intents are plain data, so a model-backed generator can
 * take the same ones.
 */
export type MotionIntent =
  | { kind: 'rest' }
  /** Look at the lens (eyes first, head after), a little brow up. */
  | { kind: 'notice'; lens: LensView }
  /** Walk to `place` looking at the lens. */
  | { kind: 'walk'; lens: LensView; place: { x: number; z: number }; speedMps: number }
  /** Lean in and bring `eye` onto the axis, `distanceM` from the lens (eased over the request's `t` by the director). */
  | { kind: 'lens-eye'; lens: LensView; eye: EyeAim; distanceM: number; leanRad: number; tiltRad: number; stare: number; loop: number; saccade: { yaw: number; pitch: number }; blink: number }
  /** Back off: upright again, a little startled or with an after-smile. */
  | { kind: 'back'; lens: LensView; startled: boolean; smile: number; home: { x: number; z: number } | null }
  /** Standing idle at a liveliness 0..1 (motion-model spike, idle-channels.ts; nothing in the app asks for it yet). */
  | { kind: 'idle'; activity: number }
  /**
   * Turn to you before she speaks, and nod (docs/claude/2026-11-14-unbound-night-e3-speech.md). `look`: how much of each group's
   * share of the turn toward the lens is asked now (0..1; the director staggers them: eyes, then head, then shoulders). `nod`:
   * extra forward pitch (rad) on head, neck and upper body, already shaped in time by the director. `tempo`: how the springs meet it.
   */
  | { kind: 'address'; lens: LensView; look: { eyes: number; head: number; torso: number }; nod: { head: number; neck: number; torso: number }; tempo: Tempo }
  // ---- U2 experiment E2: her own movement (src/unbound/director/acts.ts plays them; t runs from the act's start) -------------
  /** A gentle sway from foot to foot, `cycles` times at `hz`, eased in and out; one natural blink at `blinkAt` (s). */
  | { kind: 'sway'; amplitude: number; hz: number; cycles: number; side: 1 | -1; blinkAt: number }
  /** A stretch: arms up overhead, an arch, up on her toes, a breath in; held; let go with a breath out. */
  | { kind: 'stretch'; amplitude: number; side: 1 | -1 }
  /** A small hop: `request` goes to the gait once (null before it is asked for); `phase` is where the body is in it. */
  | { kind: 'hop'; amplitude: number; request: HopRequest | null; phase: HopPhase | 'ready' | 'after' }
  /** Showcase (docs/claude/2026-11-14-lapwing-showcase.md): one frame of a live-choreographed performance (showcase-motion.ts). */
  | ShowcaseIntent;

/** Where she looks: at you (the lens) plus a small offset, or away in her own frame (rad: yaw + = her left, pitch + = down). */
export interface ShowcaseGaze { mode: 'lens' | 'away'; yaw: number; pitch: number }
/** Named face cues 0..1 (layer 2 maps them to the model's expression slots). */
export interface ShowcaseFace {
  confirm: number; warm: number; laugh: number; pout: number; shy: number; surprise: number; sly: number; content: number; yawn: number;
  /** Brows lifting on a stressed syllable while she talks (0..1). */
  stress: number;
  /** Eyes closed / half closed (own world), 0..1. */
  closed: number; half: number;
  /** Round 15: the blush, 0..1, on its own slow envelope (src/unbound/showcase/blush-envelope.ts), not the expression's onset. */
  blush: number;
  /** Mouth shapes while she murmurs (0..1 each). */
  mouth: { a: number; i: number; u: number; e: number; o: number };
  /** I-184, optional: one eye closed (0..1, a wink after a kiss or a hug). */
  wink?: number;
}
export interface ShowcaseIntent {
  kind: 'showcase'; lens: LensView; gaze: ShowcaseGaze;
  /** Where she stands (her floor, m) and how fast she steps there. */
  place: { x: number; z: number } | null; walkSpeedMps: number | null;
  /** I-203, optional: that step is one brisk step (gait GaitKnobs.brisk). */
  walkBrisk?: boolean;
  /** Upper body lean toward you (rad), head tilt (rad, + = toward her left shoulder), a nod (rad, + = down). */
  lean: number; tilt: number; nod: number;
  /** Her resting angle to you (rad): upper body and head turned a little (three-quarter, + = her left), chin up (−) or down (+); the gaze still finds you. */
  bias: { yaw: number; pitch: number };
  /** How much of a held look the head takes (lower: she keeps a three-quarter head and looks from the corner of her eyes). */
  gazeRecenter: number;
  hands: HandTargets; face: ShowcaseFace;
  /** Eyelids, crisp. */
  blink: number;
  /** 0..1: how still she holds (a quiet steady look breathes a little shallower). */
  stillness: number;
  tempo: Tempo;
  /**
   * Round 7, the learned idle (src/unbound/motion/learned-idle.ts; used only when the page turned it on): how much of it to lay on
   * (0..1, eased; quiet holds and her own world), its liveliness knob, and per arm how free that arm is (0 while a hand beat has it).
   */
  idle?: { weight: number; activation: number; arms: { left: number; right: number } };
  /** Round 9: a small quick head turn (rad, + = her left) of a quiet moment; her eyes stay where they look. */
  headYaw?: number;
  /**
   * I-192, optional: her face arrives on the lens axis (shared/unbound/arrival): every frame a closed loop moves her hips (and toes) until the
   * point `dropM` below her eyes' midpoint (along her head's own down) is `distanceM` from the lens. `weight` 0..1: how much the loop drives
   * (1 on the way in and through the hold; easing to 0 on the way back: her hips come home with it, never a jump).
   */
  arrive?: ShowcaseArrive;
}
export interface ShowcaseArrive { dropM: number; distanceM: number; weight: number; /** false on the way back: the loop stops chasing the point and its hips fade out by the weight. */ chase?: boolean;
  /** I-203: where in the window the point goes (u across, v up; ±1 the edges; absent: on the axis): the hug's ear at the screen's right. */
  spot?: { u: number; v: number };
  /** I-203: the point is this head point (from her eyes' midpoint along her head's axes) instead of `dropM` below her eyes: the hug's ear. */
  point?: { across: number; up: number; forward: number };
  /** I-203: how much of her toes the loop may use (0..1; absent: all): she never steps while up on her toes (the step in, the step back). */
  toes?: number }

export interface MotionRequest { intent: MotionIntent; t: number; dt: number; sense: BodySense }

export interface MotionGenerator {
  readonly id: string;
  /** Whether it can make this intent (a model may support only some; the director falls back to the procedural one). */
  supports(kind: MotionIntent['kind']): boolean;
  generate(request: MotionRequest): PoseTargets;
  /** A new performance begins (any memory, e.g. a closed loop, starts over). */
  reset(): void;
}

const mixN = (a: number, b: number, w: number) => a + (b - a) * w;
const mixRot = (a: Rot, b: Rot, w: number): Rot => ({ pitch: mixN(a.pitch, b.pitch, w), yaw: mixN(a.yaw, b.yaw, w), roll: mixN(a.roll, b.roll, w) });

const REST_ARM: ArmRot = { upper: ZERO_ROT, elbow: ZERO_ROT };
const mixArm = (a: ArmRot, b: ArmRot, w: number): ArmRot => ({ upper: mixRot(a.upper, b.upper, w), elbow: mixRot(a.elbow, b.elbow, w) });
const mixArms = (a: PoseTargets['armRot'], b: PoseTargets['armRot'], w: number) =>
  ({ left: mixArm(a?.left ?? REST_ARM, b?.left ?? REST_ARM, w), right: mixArm(a?.right ?? REST_ARM, b?.right ?? REST_ARM, w) });

/** Blends two generators' targets (w = 0: a, 1: b). Discrete fields (place, tempo) come from the heavier side. */
export function blendPoseTargets(a: PoseTargets, b: PoseTargets, w: number): PoseTargets {
  const k = Math.min(1, Math.max(0, Number.isFinite(w) ? w : 0)), heavier = k >= 0.5 ? b : a;
  return {
    place: heavier.place, facing: heavier.facing, walkSpeedMps: heavier.walkSpeedMps, ...(heavier.walkBrisk ? { walkBrisk: true } : {}), tempo: heavier.tempo, hop: heavier.hop,
    arms: { raise: mixN(a.arms.raise, b.arms.raise, k) },
    torso: mixRot(a.torso, b.torso, k), neck: mixRot(a.neck, b.neck, k), head: mixRot(a.head, b.head, k),
    eyes: { yaw: mixN(a.eyes.yaw, b.eyes.yaw, k), pitch: mixN(a.eyes.pitch, b.eyes.pitch, k) },
    pelvis: { lateral: mixN(a.pelvis.lateral, b.pelvis.lateral, k), forward: mixN(a.pelvis.forward, b.pelvis.forward, k), vertical: mixN(a.pelvis.vertical, b.pelvis.vertical, k) },
    tiptoe: mixN(a.tiptoe, b.tiptoe, k), breath: mixN(a.breath, b.breath, k),
    face: { curious: mixN(a.face.curious, b.face.curious, k), smile: mixN(a.face.smile, b.face.smile, k), startle: mixN(a.face.startle, b.face.startle, k) },
    blink: Math.max(a.blink, b.blink),
    ...(a.hips || b.hips ? { hips: mixRot(a.hips ?? ZERO_ROT, b.hips ?? ZERO_ROT, k) } : {}),
    ...(a.armRot || b.armRot ? { armRot: mixArms(a.armRot, b.armRot, k) } : {}),
  };
}

/** Picks, per intent, the first generator that supports it (a model first, the procedural one as the fallback). */
export class GeneratorChain implements MotionGenerator {
  readonly id: string;
  constructor(private readonly generators: readonly MotionGenerator[]) { this.id = generators.map(g => g.id).join('>'); }
  supports(kind: MotionIntent['kind']): boolean { return this.generators.some(g => g.supports(kind)); }
  generate(request: MotionRequest): PoseTargets {
    const generator = this.generators.find(g => g.supports(request.intent.kind));
    return generator ? generator.generate(request) : { ...REST_TARGETS };
  }
  reset(): void { for (const g of this.generators) g.reset(); }
}
