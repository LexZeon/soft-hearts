/**
 * X1 "等回复时也有表现" (docs/claude/2026-11-02-schedule-plan.md, item 1;
 * record: docs/claude/2026-11-02-waiting-expression.md).
 *
 * While a sent message waits for its first word, she thinks: at once a first
 * reaction (a glance up and aside, or a curious head tilt), and if the wait
 * grows past a threshold a different "still thinking" pose (the other of the
 * two, or eyes down-aside with softened lids), never the same motion again in
 * place. When the first word arrives (or the turn is cancelled, fails, is
 * replaced, or the character changes) the channel releases toward zero from
 * whatever it shows, so the reply starts from a living pose, not a cut.
 *
 * It is a parallel presentation channel only: the reply lifecycle sets a key,
 * nothing here is awaited, and it never touches the chat request or stream.
 *
 * Outputs (read by the stage's existing writers each frame):
 * - gazeX/gazeY/gazeBlend: an offset of the stage's gaze target, and how much of
 *   the pointer pull it replaces (the head then follows through the stage's own
 *   critically damped gaze; the eyes through its damped eye gaze);
 * - headX/headY/headZ: a small additive head rotation through the automatic-head
 *   path (head claims and deferral apply);
 * - lidSoft: a gentle lid lowering request for the eyelid compositor (natural
 *   blink keeps priority).
 *
 * Every output follows its target with a critically damped spring (no
 * velocity jump on any retarget: start, the switch to the second pose, a
 * release mid-rise, a gate closing). Character comes only from existing card
 * and mood data: MoodParameters.weights (playful/close/comfortable/cautious)
 * and intensity (gaze/posture/expression), plus the current companion tendency.
 */
import { dampCritical } from './procedural';
import { hashSeed } from './life-noise';

export type ThinkingPose = 'glance' | 'tilt' | 'ponder';
type Tendency = 'playful' | 'close' | 'comfortable' | 'cautious';

/** The card/mood data the channel reads (MoodView.parameters and .snapshot). */
export interface ThinkingCharacter {
  /** Character id: one character keeps one handwriting. */
  seedKey: string;
  weights?: Partial<Record<Tendency, number>> | null;
  intensity?: { gaze?: number; posture?: number; expression?: number } | null;
  companion?: string | null;
}
export interface ThinkingPlan {
  first: ThinkingPose;
  second: ThinkingPose;
  /** +1/-1: the side of the first pose; the second pose turns to the other side. */
  side: 1 | -1;
  /** Seconds of waiting before the second pose. */
  thresholdS: number;
  /** Spring rate (rad/s) of the approach; release and the switch derive from it. */
  omega: number;
  /** Scales of the head, gaze and lid parts (0 = that part shows nothing). */
  head: number;
  gaze: number;
  face: number;
  /** -0.6..0.9: playful/close lean positive, cautious/comfortable negative. */
  lively: number;
}
/** Which parts may show this frame (the stage's owners; a closed gate releases that part smoothly). */
export interface ThinkingGates { head: boolean; gaze: boolean; face: boolean }
export interface ThinkingInput {
  /** The mesh: a new owner starts from zero (nothing of the old model is shown). */
  owner: object | null;
  character: ThinkingCharacter | null;
  gates: ThinkingGates;
}
export interface ThinkingOutput {
  headX: number; headY: number; headZ: number;
  gazeX: number; gazeY: number; gazeBlend: number;
  lidSoft: number;
}
export interface ThinkingPort { head(x: number, y: number, z: number): void }

const CHANNELS = ['headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'gazeBlend', 'lidSoft'] as const;
type Channel = typeof CHANNELS[number];

/** Pose targets at scale 1 for side +1 (radians for the head, gaze-target units for the gaze). */
interface PoseShape { headX: number; headY: number; headZ: number; gazeX: number; gazeY: number; blend: number; lidSoft: number }
export const THINKING_POSES: Readonly<Record<ThinkingPose, Readonly<PoseShape>>> = Object.freeze({
  // 抬眼想一想: eyes up and aside, chin lifts a little, a slight tilt toward the look.
  glance: Object.freeze({ headX: -0.022, headY: 0, headZ: 0.03, gazeX: 0.3, gazeY: 0.48, blend: 1, lidSoft: 0 }),
  // 轻轻歪头: a curious tilt, still mostly looking at you.
  tilt: Object.freeze({ headX: 0.012, headY: 0.02, headZ: 0.095, gazeX: 0.06, gazeY: 0.05, blend: 0.3, lidSoft: 0 }),
  // 还在想: eyes down and aside, chin down a touch, lids a little lowered.
  ponder: Object.freeze({ headX: 0.032, headY: 0, headZ: 0.04, gazeX: 0.26, gazeY: -0.24, blend: 0.9, lidSoft: 0.13 }),
});
/** Hard bounds of the outputs (the head adds to her other head layers). */
export const THINKING_LIMITS = Object.freeze({ head: 0.14, gaze: 0.6, lidSoft: 0.25 });

const clamp = (value: number, low: number, high: number) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const scale = (intensity: unknown) => clamp(finite(intensity, 50) / 50, 0, 1.6);

/**
 * The plan for one wait, from the character only (pure). `turnKey` picks the
 * side per reply, so two replies in a row need not mirror each other.
 */
export function thinkingPlan(character: ThinkingCharacter, turnKey: string): ThinkingPlan {
  const tendencies: Tendency[] = ['playful', 'close', 'comfortable', 'cautious'];
  const weight = (key: Tendency) => clamp(finite(character.weights?.[key], 1), 0, 4);
  const total = tendencies.reduce((sum, key) => sum + weight(key), 0);
  const share = (key: Tendency) => total > 0 ? weight(key) / total : 0.25;
  // Neutral (equal weights) is 0. The card's leanings, nudged by how she feels right now.
  const companion = character.companion;
  const lively = clamp((share('playful') - 0.25) + 0.5 * (share('close') - 0.25) - 0.5 * ((share('cautious') - 0.25) + (share('comfortable') - 0.25))
    + (companion === 'playful' ? 0.15 : companion === 'close' ? 0.05 : companion === 'cautious' || companion === 'comfortable' ? -0.1 : 0), -0.6, 0.9);
  const seed = hashSeed(`soft-hearts-thinking:${character.seedKey}`);
  // A small per-character bias decides the tie of a perfectly neutral card, the same way every time.
  const bias = ((seed % 1000) / 1000 - 0.5) * 0.16;
  const first: ThinkingPose = lively + bias > 0 ? 'tilt' : 'glance';
  const second: ThinkingPose = lively >= 0.15 ? (first === 'tilt' ? 'glance' : 'tilt') : 'ponder';
  const side: 1 | -1 = (hashSeed(`${character.seedKey}\u0000${turnKey}`) & 1) === 0 ? 1 : -1;
  const amp = clamp(1 + 0.5 * lively, 0.65, 1.4);
  return {
    first, second, side, lively,
    thresholdS: clamp(2.6 * (1 - 0.45 * lively), 1.7, 4),
    omega: 4.2 * clamp(1 + 0.45 * lively, 0.7, 1.35),
    head: amp * scale(character.intensity?.posture),
    gaze: (0.85 + 0.15 * amp) * scale(character.intensity?.gaze),
    face: scale(character.intensity?.expression),
  };
}

export interface ThinkingState {
  waiting: boolean;
  phase: 'none' | 'first' | 'second';
  pose: ThinkingPose | null;
  waitedS: number;
  plan: ThinkingPlan | null;
  gates: ThinkingGates;
  output: ThinkingOutput;
}

export class ReplyThinking {
  readonly out: ThinkingOutput = { headX: 0, headY: 0, headZ: 0, gazeX: 0, gazeY: 0, gazeBlend: 0, lidSoft: 0 };
  private readonly velocity: Record<Channel, number> = { headX: 0, headY: 0, headZ: 0, gazeX: 0, gazeY: 0, gazeBlend: 0, lidSoft: 0 };
  private readonly target: ThinkingOutput = { headX: 0, headY: 0, headZ: 0, gazeX: 0, gazeY: 0, gazeBlend: 0, lidSoft: 0 };
  private key: string | null = null;
  private waiting = false;
  /** Keys already released: a late or repeated set of the same reply never restarts it. */
  private readonly released = new Set<string>();
  private plan: ThinkingPlan | null = null;
  private planFor = '';
  private waited = 0;
  private time = 0;
  private owner: object | null = null;
  private gates: ThinkingGates = { head: false, gaze: false, face: false };

  /** True while waiting or while anything is still shown (releasing). */
  get active(): boolean { return this.waiting || CHANNELS.some(name => this.out[name] !== 0 || this.velocity[name] !== 0); }

  /**
   * The reply lifecycle: the accepted reply that is waiting for its first word,
   * or null (first word, done, failed, cancelled, cleared, hidden). Only a new
   * key starts; null and released keys release smoothly from what is shown.
   */
  set(key: string | null): void {
    if (key === null) {
      if (this.waiting && this.key) this.remember(this.key);
      this.waiting = false;
      return;
    }
    if (typeof key !== 'string' || !key || key === this.key && this.waiting || this.released.has(key)) return;
    if (this.waiting && this.key) this.remember(this.key);
    this.key = key; this.waiting = true; this.waited = 0; this.plan = null; this.planFor = '';
  }

  /** Nothing is shown (hidden, not rendering, model gone): drop the pose at once, keep the waiting key. */
  hide(): void {
    for (const name of CHANNELS) { this.out[name] = 0; this.velocity[name] = 0; }
  }

  /** One display frame, before the writers read `out`. */
  frame(delta: number, input: ThinkingInput): void {
    const dt = Number.isFinite(delta) ? clamp(delta, 0, 0.1) : 0;
    if (input.owner !== this.owner) { this.owner = input.owner; this.hide(); }
    this.gates = { head: input.gates.head === true, gaze: input.gates.gaze === true, face: input.gates.face === true };
    const character = input.character;
    if (this.waiting && character && (!this.plan || this.planFor !== character.seedKey)) {
      this.plan = thinkingPlan(character, this.key ?? ''); this.planFor = character.seedKey;
    }
    const plan = this.plan;
    if (this.waiting) this.waited += dt;
    this.time += dt;
    const target = this.target;
    const second = !!plan && this.waited >= plan.thresholdS;
    target.headX = target.headY = target.headZ = target.gazeX = target.gazeY = target.gazeBlend = target.lidSoft = 0;
    if (this.waiting && plan && this.owner) {
      const shape = THINKING_POSES[second ? plan.second : plan.first], side = second ? -plan.side : plan.side;
      // A slow, small drift keeps a held pose alive (never a loop of the first motion).
      const drift = Math.sin(this.time * (second ? 1.1 : 0.8) + (plan.side > 0 ? 0 : 1.7));
      if (this.gates.head && plan.head > 0) {
        target.headX = shape.headX * plan.head;
        target.headY = (shape.headY + (second ? 0.012 * drift : 0.005 * drift)) * side * plan.head;
        target.headZ = (shape.headZ + 0.006 * drift) * side * plan.head;
      }
      if (this.gates.gaze && plan.gaze > 0) {
        target.gazeX = (shape.gazeX + (second ? 0.04 : 0.02) * drift) * side * plan.gaze;
        target.gazeY = shape.gazeY * plan.gaze;
        target.gazeBlend = shape.blend;
      }
      if (this.gates.face) target.lidSoft = shape.lidSoft * plan.face;
      // Bound the targets (the springs never overshoot a target they start toward from rest).
      const norm = Math.sqrt(target.headX * target.headX + target.headY * target.headY + target.headZ * target.headZ);
      if (norm > THINKING_LIMITS.head) { const k = THINKING_LIMITS.head / norm; target.headX *= k; target.headY *= k; target.headZ *= k; }
      target.gazeX = clamp(target.gazeX, -THINKING_LIMITS.gaze, THINKING_LIMITS.gaze);
      target.gazeY = clamp(target.gazeY, -THINKING_LIMITS.gaze, THINKING_LIMITS.gaze);
      target.lidSoft = clamp(target.lidSoft, 0, THINKING_LIMITS.lidSoft);
    }
    // Toward a pose: the first reaction at the character's rate, the switch to the second pose a slower crossfade.
    // Toward zero (first word, cancel, a closed gate): brisker, still from what is shown and its current velocity.
    const approach = plan ? plan.omega * (second ? 0.8 : 1) : 4.2, release = clamp((plan?.omega ?? 4.2) * 1.4, 5, 6.5);
    const out = this.out, velocity = this.velocity;
    for (const name of CHANNELS) out[name] = dampCritical(out[name], target[name], target[name] === 0 ? release : approach, dt, velocity, name);
    // Weights stay weights; settle exact zeros so an idle channel writes nothing.
    out.gazeBlend = clamp(out.gazeBlend, 0, 1);
    out.lidSoft = clamp(out.lidSoft, 0, THINKING_LIMITS.lidSoft);
    if (!this.waiting) for (const name of CHANNELS)
      if (Math.abs(out[name]) < 1e-4 && Math.abs(velocity[name]) < 1e-3) { out[name] = 0; velocity[name] = 0; }
  }

  /** The head part, through the stage's automatic-head writer. */
  applyHead(port: ThinkingPort): void {
    const out = this.out;
    if (out.headX !== 0 || out.headY !== 0 || out.headZ !== 0) port.head(out.headX, out.headY, out.headZ);
  }

  getState(): ThinkingState {
    const round = (value: number) => Math.round(value * 1e4) / 1e4;
    const plan = this.plan, second = !!plan && this.waited >= plan.thresholdS;
    const output = {} as ThinkingOutput;
    for (const name of CHANNELS) output[name] = round(this.out[name]);
    return { waiting: this.waiting, phase: !this.waiting || !plan ? 'none' : second ? 'second' : 'first',
      pose: this.waiting && plan ? (second ? plan.second : plan.first) : null, waitedS: round(this.waited),
      plan, gates: { ...this.gates }, output };
  }

  private remember(key: string): void {
    this.released.add(key);
    if (this.released.size > 64) this.released.delete(this.released.values().next().value!);
  }
}
