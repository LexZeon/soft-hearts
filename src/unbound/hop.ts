/**
 * Unbound U2 experiment E2: the path of her hips in a small hop (docs/claude/2026-11-14-unbound-night-e2-autonomy.md). Pure.
 *
 * The design doc: "起跳前先蹲一下（蓄力），空中按重力走弧线，落地时膝盖弯下去缓冲，落得越重弯得越深。重力可以比真实的软一点".
 * Height y (m) of her hips over where they stand, in four parts:
 *  - crouch: down by `crouchM` on an S5 (speed and acceleration 0 at both ends);
 *  - push: a quintic from the crouch (at rest) to take-off: at `takeoffY` (on her toes) with the speed that reaches the apex and
 *    the acceleration of gravity, so position, speed and acceleration are all continuous through take-off (C²). Its length is a
 *    share of the longest push that still only rises (a monotone push, about 1 g at most for the default hop);
 *  - flight: the parabola under (soft) gravity, back down to `takeoffY`;
 *  - land: a critically damped return to standing from the touch-down speed, stiff enough that the knees take `landDepthM`
 *    (deeper for a higher hop). Position and speed continue through touch-down; the acceleration changes there, as a landing does.
 */
import type { HopPhase, HopRequest } from './gait';

const HOP_CROUCH_S = 0.32, HOP_PUSH_SHARE = 0.85;

export interface HopPlan {
  crouchM: number; takeoffY: number; gravity: number; heightM: number;
  crouchS: number; pushS: number; flightS: number;
  /** Take-off speed (m/s, up) and the push quintic's normalized coefficients (y = y0 + A u³ + B u⁴ + C u⁵, u = τ / pushS). */
  v0: number; quintic: { A: number; B: number; C: number };
  /** The landing's stiffness (rad/s) and how far below standing her hips go (m). */
  omega: number; landDepthM: number;
}

const S5 = (u: number) => u * u * u * (10 + u * (-15 + 6 * u));
const S5d = (u: number) => 30 * u * u * (1 - u) * (1 - u);
const S5dd = (u: number) => 60 * u * (1 - u) * (1 - 2 * u);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** How far below standing her hips go on landing from a hop of `heightM` (m): deeper for a higher hop. */
export const landDepthFor = (heightM: number, crouchM: number) => clamp(0.6 * crouchM + 0.25 * heightM, 0.02, 0.09);

export function planHop(spec: Pick<HopRequest, 'crouchM' | 'heightM' | 'gravity'>, takeoffY: number): HopPlan {
  const g = spec.gravity, H = spec.heightM, c = spec.crouchM, y1 = Math.max(0, takeoffY);
  const v0 = Math.sqrt(2 * g * H), delta = y1 + c;
  // The cubic term of the push is ≥ 0 (it starts upward) while g T²/2 + 4 v0 T − 10 Δ ≤ 0: the longest such T, and a share of it.
  const longest = (-4 * v0 + Math.sqrt(16 * v0 * v0 + 20 * g * delta)) / g;
  const T = HOP_PUSH_SHARE * longest;
  const C = (-g * T * T + 12 * delta - 6 * v0 * T) / 2, B = v0 * T - 3 * delta - 2 * C, A = delta - B - C;
  const depth = landDepthFor(H, c);
  return { crouchM: c, takeoffY: y1, gravity: g, heightM: H, crouchS: HOP_CROUCH_S, pushS: T, flightS: 2 * v0 / g, v0, quintic: { A, B, C }, omega: landingOmega(y1, -v0, depth), landDepthM: depth };
}

/** The critically damped stiffness whose dip below 0 from (y0, v) is `depth` (bisection; the dip shrinks as ω grows). */
function landingOmega(y0: number, v: number, depth: number): number {
  const dip = (w: number) => { // −min y of (y0 + (v + w y0) τ) e^(−wτ)
    const k = v + w * y0;
    if (k >= 0) return 0;
    const tau = v / (w * k);
    return -((y0 + k * tau) * Math.exp(-w * tau));
  };
  let lo = 0.5, hi = y0 > 0 ? -v / y0 - 1e-6 : 200;
  if (dip(lo) < depth) return lo;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (dip(mid) > depth) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export interface HopSample { phase: HopPhase | 'done'; y: number; v: number; a: number; /** 0..1 through the flight (for the tuck). */ flightU: number }

/** Where her hips are `t` seconds into the hop. */
export function hopAt(plan: HopPlan, t: number): HopSample {
  const { crouchS: tc, pushS: tp, flightS: tf } = plan;
  if (t < tc) {
    const u = Math.max(0, t) / tc;
    return { phase: 'crouch', y: -plan.crouchM * S5(u), v: -plan.crouchM * S5d(u) / tc, a: -plan.crouchM * S5dd(u) / (tc * tc), flightU: 0 };
  }
  if (t < tc + tp) {
    const u = (t - tc) / tp, { A, B, C } = plan.quintic;
    return { phase: 'push', y: -plan.crouchM + A * u ** 3 + B * u ** 4 + C * u ** 5, v: (3 * A * u * u + 4 * B * u ** 3 + 5 * C * u ** 4) / tp,
      a: (6 * A * u + 12 * B * u * u + 20 * C * u ** 3) / (tp * tp), flightU: 0 };
  }
  if (t < tc + tp + tf) {
    const tau = t - tc - tp, g = plan.gravity;
    return { phase: 'flight', y: plan.takeoffY + plan.v0 * tau - g * tau * tau / 2, v: plan.v0 - g * tau, a: -g, flightU: tau / tf };
  }
  const tau = t - tc - tp - tf, w = plan.omega, y0 = plan.takeoffY, v = -plan.v0, k = v + w * y0, e = Math.exp(-w * tau);
  if (tau >= 9 / w) return { phase: 'done', y: 0, v: 0, a: 0, flightU: 1 };
  return { phase: 'land', y: (y0 + k * tau) * e, v: (k - w * (y0 + k * tau)) * e, a: (-2 * w * k + w * w * (y0 + k * tau)) * e, flightU: 1 };
}

/** The whole hop's length (s), to its settled end. */
export const hopDuration = (plan: HopPlan) => plan.crouchS + plan.pushS + plan.flightS + 9 / plan.omega;
