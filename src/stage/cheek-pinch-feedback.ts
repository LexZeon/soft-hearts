export interface CheekPinchMotionInput {
  pinching: boolean;
  /** Drag from the frozen press point, in frozen projected head-width units. */
  x: number;
  y: number;
  side: 'left' | 'right' | null;
}

export interface CheekPinchMotionStyle {
  /** Existing character expression strengths, 0..100. */
  posture: number;
  face: number;
  playful: number;
  mood: string;
  /** Existing rua sensitivity, 0..2; it never supplies another mood reward. */
  sensitivity: number;
}

export interface CheekPinchMotionFrame {
  /** Local additive Euler angles in radians. Screen-down drag gives positive X. */
  headX: number;
  headY: number;
  headZ: number;
  bodyX: number;
  bodyY: number;
  bodyZ: number;
  /** Model-height ratios: right is +X and model-up is +Y. */
  headOffsetX: number;
  headOffsetY: number;
  bodyOffsetX: number;
  bodyOffsetY: number;
  /** Blend weights. The stage remains responsible for manual-face priority. */
  smile: number;
  eyelids: number;
  headWeight: number;
  bodyWeight: number;
}

const KEYS = [
  'headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ',
  'headOffsetX', 'headOffsetY', 'bodyOffsetX', 'bodyOffsetY',
  'smile', 'eyelids', 'headWeight', 'bodyWeight',
] as const;
type Key = typeof KEYS[number];
const emptyFrame = (): CheekPinchMotionFrame => ({
  headX: 0, headY: 0, headZ: 0, bodyX: 0, bodyY: 0, bodyZ: 0,
  headOffsetX: 0, headOffsetY: 0, bodyOffsetX: 0, bodyOffsetY: 0,
  smile: 0, eyelids: 0, headWeight: 0, bodyWeight: 0,
});
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const bounded = (value: number, min: number, max: number, fallback = 0) =>
  Number.isFinite(value) ? clamp(value, min, max) : fallback;
const smoothstep = (value: number) => value * value * (3 - 2 * value);

/** A removable display layer. It owns no bones, input clock, resources or rewards. */
export class CheekPinchMotion {
  private value = emptyFrame();
  private velocity = emptyFrame();

  reset(): void {
    this.value = emptyFrame();
    this.velocity = emptyFrame();
  }

  frame(delta: number, input: CheekPinchMotionInput, style: CheekPinchMotionStyle): CheekPinchMotionFrame {
    const dt = bounded(delta, 0, 0.1);
    // Zero-time layer rebuilds must reproduce the current pose, not advance it.
    if (dt === 0) return { ...this.value };
    const target = this.target(input, style);
    const omega = 18;
    const decay = Math.exp(-omega * dt);
    for (const key of KEYS) {
      // Closed-form critically damped spring. A suspended frame cannot inject
      // unstable Euler integration or turn a held target into accumulated motion.
      const displacement = this.value[key] - target[key];
      const slope = this.velocity[key] + omega * displacement;
      this.value[key] = target[key] + (displacement + slope * dt) * decay;
      this.velocity[key] = (this.velocity[key] - omega * slope * dt) * decay;
      if (Math.abs(this.value[key]) < 1e-9 && Math.abs(this.velocity[key]) < 1e-8) {
        this.value[key] = 0;
        this.velocity[key] = 0;
      }
    }
    this.limit(['headX', 'headY', 'headZ'], Math.PI / 15);
    this.limit(['bodyX', 'bodyY', 'bodyZ'], Math.PI / 30);
    this.limit(['headOffsetX', 'headOffsetY'], 0.025);
    this.limit(['bodyOffsetX', 'bodyOffsetY'], 0.02);
    for (const key of ['smile', 'eyelids', 'headWeight', 'bodyWeight'] as const) {
      const next = clamp(this.value[key], 0, 1);
      if (next !== this.value[key]) { this.value[key] = next; this.velocity[key] = 0; }
    }
    return { ...this.value };
  }

  private target(input: CheekPinchMotionInput, style: CheekPinchMotionStyle): CheekPinchMotionFrame {
    const target = emptyFrame();
    if (!input.pinching || (input.side !== 'left' && input.side !== 'right')
      || !Number.isFinite(input.x) || !Number.isFinite(input.y)) return target;
    let x = clamp(input.x, -2, 2), y = clamp(input.y, -2, 2);
    const length = Math.hypot(x, y);
    if (length > 2) { x *= 2 / length; y *= 2 / length; }
    const distance = Math.min(2, length);
    const far = smoothstep(clamp((distance - 0.2) / 1.1, 0, 1));
    const bodyWeight = 0.1 + 0.68 * far;
    const headWeight = 1 - bodyWeight;
    const serious = /^(concerned|disappointed|upset|sad|longing|tense-expectation|担心|关切|失落|不满|伤感|想念|紧张期待)$/.test(style.mood);
    const pleasant = /^(close|content|happy|excited|relieved|亲近|满足|愉快|兴奋|释然)$/.test(style.mood);
    const sensitivity = bounded(style.sensitivity, 0, 2, 1);
    const posture = bounded(style.posture, 0, 100, 50) / 50;
    // Physical direct feedback remains readable at zero sensitivity/posture.
    // Automatic-expression enablement is deliberately absent from this contract.
    const gain = (0.45 + sensitivity * 0.55) * (0.25 + posture * 0.75) * (serious ? 0.8 : 1);
    const head = headWeight * gain, body = bodyWeight * gain;
    target.headX = y * 0.11 * head;
    target.headY = x * 0.14 * head;
    target.headZ = -x * 0.10 * head;
    target.bodyX = y * 0.035 * body;
    target.bodyY = x * 0.045 * body;
    target.bodyZ = -x * 0.04 * body;
    target.headOffsetX = x * 0.018 * head;
    target.headOffsetY = -y * 0.018 * head;
    target.bodyOffsetX = x * 0.016 * body;
    target.bodyOffsetY = -y * 0.016 * body;
    const face = bounded(style.face, 0, 100, 50) / 50;
    const playful = bounded(style.playful, 0, 100, 50) / 100;
    // A serious mood gives a smaller, watchful reaction instead of a forced smile.
    target.smile = serious ? 0 : face * (pleasant ? 0.14 + 0.12 * playful : 0.035 * playful);
    target.eyelids = face * (serious ? 0.055 : pleasant ? 0.22 + 0.1 * playful : 0.09);
    target.headWeight = headWeight;
    target.bodyWeight = bodyWeight;
    // Bound targets as well as displayed output, so high card strengths cannot
    // store an excessive spring displacement behind the visible limits.
    limitTarget(target, ['headX', 'headY', 'headZ'], Math.PI / 15);
    limitTarget(target, ['bodyX', 'bodyY', 'bodyZ'], Math.PI / 30);
    limitTarget(target, ['headOffsetX', 'headOffsetY'], 0.025);
    limitTarget(target, ['bodyOffsetX', 'bodyOffsetY'], 0.02);
    target.smile = clamp(target.smile, 0, 1);
    target.eyelids = clamp(target.eyelids, 0, 1);
    return target;
  }

  private limit(keys: readonly Key[], maximum: number): void {
    const magnitude = Math.hypot(...keys.map(key => this.value[key]));
    if (magnitude <= maximum) return;
    const scale = maximum / magnitude;
    for (const key of keys) { this.value[key] *= scale; this.velocity[key] *= scale; }
  }
}

function limitTarget(target: CheekPinchMotionFrame, keys: readonly Key[], maximum: number): void {
  const magnitude = Math.hypot(...keys.map(key => target[key]));
  if (magnitude <= maximum) return;
  const scale = maximum / magnitude;
  for (const key of keys) target[key] *= scale;
}
