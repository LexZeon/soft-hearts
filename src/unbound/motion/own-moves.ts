/**
 * Unbound U2 experiment E2, layer 2: her own movement, computed on the spot (docs/claude/2026-11-14-unbound-night-e2-autonomy.md).
 * Used by the procedural generator (procedural.ts) for the intents 'sway', 'stretch' and 'hop'.
 *
 * Each is a function of the act's own time t and gives goals only, smooth in t (S5 ramps, eased envelopes), so even before the
 * springs of layer 3 nothing in the targets jumps, except a blink (crisp on purpose). `amplitude` (0.5..1; stress makes it
 * smaller) scales the size. The hop itself (crouch, push, flight under soft gravity, landing) is the gait's (hop.ts): here is only
 * the rest of her body around it.
 */
import { REST_TARGETS, type MotionIntent, type PoseTargets } from './generator';

const S5 = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (10 + x * (-15 + 6 * x)); };

/** A blink at `at` (s): closes in 70 ms, stays 40 ms, opens in 130 ms (the peek's own blink shape). */
export function blinkCurve(t: number, at: number): number {
  const d = t - at;
  if (d < 0 || d > 0.24) return 0;
  return d < 0.07 ? S5(d / 0.07) : d < 0.11 ? 1 : 1 - S5((d - 0.11) / 0.13);
}

type Sway = Extract<MotionIntent, { kind: 'sway' }>;
type Stretch = Extract<MotionIntent, { kind: 'stretch' }>;
type Hop = Extract<MotionIntent, { kind: 'hop' }>;

/** The sway's length (s). */
export const swayDuration = (intent: Pick<Sway, 'cycles' | 'hz'>) => intent.cycles / intent.hz;
/** Sway sizes at amplitude 1: hips across (m), upper-body roll, head roll back the other way (rad). */
export const SWAY_SIZE = Object.freeze({ hips: 0.022, dip: 0.004, torsoRoll: 0.035, neckRoll: 0.01, headRoll: 0.018, headYaw: 0.02 });

/**
 * Sway: her hips go from foot to foot (a pendulum, `cycles` times at `hz`), her upper body leans a little with them, her head
 * stays nearly level (it tilts back the other way), a small dip at each side; eased in over the first part and out over the last.
 * A small content smile; one natural blink.
 */
export function swayTargets(intent: Sway, t: number): PoseTargets {
  const T = swayDuration(intent), ramp = Math.min(1.4, T / 3), z = SWAY_SIZE;
  const env = S5(t / ramp) * S5((T - t) / ramp), phase = 2 * Math.PI * intent.hz * t, a = intent.amplitude * env;
  const s = Math.sin(phase) * intent.side;
  return {
    ...REST_TARGETS,
    pelvis: { lateral: z.hips * a * s, forward: 0, vertical: -z.dip * a * (1 - Math.cos(2 * phase)) / 2 },
    torso: { pitch: 0, yaw: 0, roll: z.torsoRoll * a * s },
    neck: { pitch: 0, yaw: 0, roll: -z.neckRoll * a * s },
    head: { pitch: 0, yaw: z.headYaw * a * Math.sin(phase - 0.6) * intent.side, roll: -z.headRoll * a * s },
    face: { curious: 0, smile: 0.22 * env, startle: 0 },
    blink: blinkCurve(t, intent.blinkAt),
    tempo: 'calm',
  };
}

/** The stretch's beats (s): get ready, arms up, hold, let go, settle. */
export const STRETCH_BEATS = Object.freeze({ ready: 0.35, up: 1.05, hold: 1.3, down: 1.0, settle: 0.6 });
export const stretchDuration = () => Object.values(STRETCH_BEATS).reduce((a, b) => a + b, 0);
/** When the stretch is at its highest (s): arms up, held. */
export const stretchPeakAt = () => STRETCH_BEATS.ready + STRETCH_BEATS.up + 0.5 * STRETCH_BEATS.hold;

/**
 * Stretch: a small gather (a breath, a slight forward lean), then arms up overhead as she arches back a little, looks up and
 * rises onto her toes, breathing in, eyes squeezed shut; a lean to one side while she holds it; then arms down with a breath
 * out and a content smile.
 */
export function stretchTargets(intent: Stretch, t: number): PoseTargets {
  const b = STRETCH_BEATS, a = intent.amplitude;
  const upAt = b.ready, holdAt = upAt + b.up, downAt = holdAt + b.hold, endAt = downAt + b.down;
  const raise = S5((t - upAt) / b.up) * (1 - S5((t - downAt) / b.down));
  const gather = S5(t / b.ready) * (1 - S5((t - upAt) / (0.6 * b.up)));
  const holding = S5((t - holdAt) / (0.5 * b.hold)) * (1 - S5((t - downAt) / (0.5 * b.down)));
  const exhale = S5((t - downAt) / (0.5 * b.down)) * (1 - S5((t - endAt) / b.settle));
  return {
    ...REST_TARGETS,
    arms: { raise: raise * (0.75 + 0.25 * a) },
    torso: { pitch: 0.05 * gather - 0.13 * a * raise, yaw: 0, roll: 0.06 * a * holding * intent.side },
    neck: { pitch: -0.04 * a * raise, yaw: 0, roll: 0 },
    head: { pitch: -0.12 * a * raise, yaw: 0, roll: -0.03 * a * holding * intent.side },
    eyes: { yaw: 0, pitch: -0.08 * raise },
    tiptoe: 0.45 * a * raise,
    breath: 1 + 0.12 * gather + 0.3 * raise - 0.3 * exhale,
    face: { curious: 0, smile: 0.3 * exhale + 0.1 * raise, startle: 0 },
    blink: 0.85 * S5((t - upAt - 0.4) / 0.35) * (1 - S5((t - downAt - 0.1) / 0.2)),
    tempo: 'calm',
  };
}

/** Torso lean per hop phase (rad, at amplitude 1). */
export const HOP_LEAN = Object.freeze({ ready: 0, crouch: 0.16, push: 0.05, flight: 0, land: 0.09, after: 0 });
/**
 * Hop: around the gait's hop, a forward lean as she crouches, upright through the push and the air, a little lean to take the
 * landing, then upright with a smile (and a blink once she has settled). Brisk springs through it, calm after.
 */
export function hopTargets(intent: Hop, t: number): PoseTargets {
  const a = intent.amplitude, p = intent.phase, lean = HOP_LEAN[p];
  return {
    ...REST_TARGETS,
    hop: intent.request,
    torso: { pitch: lean * a, yaw: 0, roll: 0 },
    head: { pitch: -0.6 * lean * a, yaw: 0, roll: 0 },
    face: { curious: p === 'ready' ? 0.4 : 0, smile: p === 'ready' ? 0.2 : p === 'crouch' || p === 'push' ? 0.3 : 0.55, startle: 0 },
    blink: p === 'after' ? blinkCurve(t, 0.35) : 0,
    tempo: p === 'after' ? 'calm' : 'brisk',
  };
}
