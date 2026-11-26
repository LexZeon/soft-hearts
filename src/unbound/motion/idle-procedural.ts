/**
 * Motion-model spike, group A (docs/claude/2026-11-14-motion-model-spike.md): the procedural idle, the hand-made baseline the
 * data-driven sources are compared with. Per channel, three slow sines whose periods are not multiples of each other plus a
 * smoothed (roughly 1/f) noise, the recipe of docs/claude/2026-11-14-liveliness-research.md 规则 5; a function of time only, so
 * any display rate shows the same curve. Amplitudes are per channel (`IDLE_SCALE`, the same order as the human data's spread)
 * and grow with the liveliness knob.
 */
import { IDLE_DIM, seededRandom, type ContinuousIdleSource } from './idle-channels';

/**
 * Typical spread per channel (standard deviation; pelvis per meter of height, rotations in rad): round 2, the median over the
 * 20 curated people's standing stretches of each stretch's own spread, so group A moves about as much as they do.
 */
export const IDLE_SCALE: readonly number[] = [0.0034, 0.0059, 0.0004, 0.039, 0.016, 0.010, 0.019, 0.0066, 0.0065, 0.035, 0.012, 0.012,
  0.015, 0.0086, 0.0045, 0.062, 0.087, 0.120, 0.068, 0.085, 0.040, 0.061, 0.082, 0.119, 0.067, 0.093, 0.045];
/** Periods (s) of the three sines, per channel family (pelvis, torso, neck, head, hips, arms). */
const PERIODS = [[15.53, 6.53, 3.53], [15.53, 8.11, 4.37], [11.3, 5.77, 3.23], [9.71, 6.53, 2.93], [13.1, 7.3, 3.9], [10.7, 4.9, 2.71]];

/** Smooth value noise: a cubic through random knots every `period` seconds. */
function valueNoise(knots: Float64Array, t: number, period: number): number {
  const x = t / period, i = Math.floor(x), u = x - i, n = knots.length;
  const k = (j: number) => knots[((j % n) + n) % n];
  const p0 = k(i - 1), p1 = k(i), p2 = k(i + 1), p3 = k(i + 2), u2 = u * u, u3 = u2 * u;
  return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

export class ProceduralIdle implements ContinuousIdleSource {
  readonly id = 'procedural';
  private phases = new Float64Array(IDLE_DIM * 3);
  private knots: Float64Array[] = [];
  private readonly out = new Float32Array(IDLE_DIM);
  constructor(seed = 1) { this.reset(seed); }
  reset(seed = 1): void {
    const random = seededRandom(seed);
    this.phases = Float64Array.from({ length: IDLE_DIM * 3 }, () => random() * Math.PI * 2);
    // Two noise octaves per channel (2.5 s and 0.9 s knots, the faster one at half the amplitude: about 1/f).
    this.knots = Array.from({ length: IDLE_DIM * 2 }, () => Float64Array.from({ length: 512 }, () => random() * 2 - 1));
  }
  at(t: number, activity: number): Float32Array {
    const a = 0.55 + 0.9 * Math.max(0, Math.min(1, activity));
    for (let c = 0; c < IDLE_DIM; c++) {
      const family = c < 3 ? 0 : c < 6 ? 1 : c < 9 ? 2 : c < 12 ? 3 : c < 15 ? 4 : 5, [p1, p2, p3] = PERIODS[family];
      const sines = 0.9 * Math.sin(2 * Math.PI * t / p1 + this.phases[3 * c]) + 0.5 * Math.sin(2 * Math.PI * t / p2 + this.phases[3 * c + 1])
        + 0.25 * Math.sin(2 * Math.PI * t / p3 + this.phases[3 * c + 2]);
      const noise = 0.9 * valueNoise(this.knots[2 * c], t, 2.5) + 0.45 * valueNoise(this.knots[2 * c + 1], t, 0.9);
      // sines' std ≈ 0.75, noise's ≈ 0.45: normalized to about one spread at activity 0.5.
      this.out[c] = IDLE_SCALE[c] * a * (sines + noise) / 0.9;
    }
    return this.out;
  }
}
