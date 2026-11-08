/** Frame-rate independent interpolation, also stable after a suspended window resumes. */
export function damp(
  current: number,
  target: number,
  speed: number,
  delta: number,
): number {
  return (
    current +
    (target - current) *
      (1 - Math.exp(-speed * Math.min(0.1, Math.max(0, delta))))
  );
}

/**
 * R29d: critically damped follow (a spring with exactly enough damping not to
 * overshoot), exact for any frame time. Unlike `damp`, a new target is met
 * from rest: the first frame after a jump in the target moves gently and the
 * speed builds up, instead of starting at full speed. With `omega = 2 * speed`
 * it keeps damp's lag behind a steadily moving target (2 / omega = 1 / speed)
 * and reaches 90% of a step about as soon (0.39 s vs 0.46 s at speed 5).
 * `velocity[axis]` (units/s) is the follower's own state, updated in place.
 */
export function dampCritical<K extends string>(current: number, target: number, omega: number, delta: number,
  velocity: Record<K, number>, axis: K): number {
  const dt = Math.min(0.1, Math.max(0, Number.isFinite(delta) ? delta : 0));
  const speed = Number.isFinite(velocity[axis]) ? velocity[axis] : 0;
  if (!Number.isFinite(current)) { velocity[axis] = 0; return Number.isFinite(target) ? target : 0; }
  // Like damp with speed 0: no response holds still (and drops any motion).
  if (!Number.isFinite(target) || !(omega > 0) || !Number.isFinite(omega)) { velocity[axis] = 0; return current; }
  // x(t) = target + (e + (v + w e) t) exp(-w t),  v(t) = (v - w (v + w e) t) exp(-w t)
  const error = current - target, decay = Math.exp(-omega * dt), carry = speed + omega * error;
  velocity[axis] = (speed - omega * carry * dt) * decay;
  return target + (error + carry * dt) * decay;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Nearby targets use the eyes first; smooth head share rises with angular distance. */
export function gazeTargets(x: number, y: number, hasEyes = true) {
  x = Number.isFinite(x) ? clamp(x, -1, 1) : 0;
  y = Number.isFinite(y) ? clamp(y, -1, 1) : 0;
  const distance = clamp((Math.hypot(x, y) - 0.1) / 0.9, 0, 1);
  const headWeight = hasEyes ? 0.12 + 0.66 * distance * distance * (3 - 2 * distance) : 1;
  const yaw = x * 0.48, pitch = y * 0.28;
  return {
    headWeight,
    headX: clamp(yaw * headWeight, -0.38, 0.38),
    headY: clamp(pitch * headWeight, -0.22, 0.22),
    eyeX: hasEyes ? clamp(yaw * (1 - headWeight), -0.18, 0.18) : 0,
    eyeY: hasEyes ? clamp(pitch * (1 - headWeight), -0.12, 0.12) : 0,
  };
}

/** A compact eyelid pulse: zero outside a blink, closed at its midpoint. */
export function blinkWeight(elapsed: number, duration = 0.16): number {
  if (elapsed < 0 || elapsed > duration) return 0;
  return Math.sin((elapsed / duration) * Math.PI) ** 2;
}

/** Upper-arm roll needed for a relaxed pose, preserving already lowered arms. */
export function relaxedArmRoll(x: number, y: number): number {
  if (Math.abs(x) < 0.001) return 0;
  const restAngle = Math.atan2(y, Math.abs(x));
  const adjustment = Math.max(0, Math.PI * 0.36 + restAngle);
  return adjustment ? -Math.sign(x) * adjustment : 0;
}
