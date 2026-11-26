import type { PoseRates } from './motion-transition';

/**
 * Hand-back velocity (docs/claude/2026-11-21-motion-handback-velocity.md): the speed of a shown pose, per track, from
 * the last two frames it was shown, for a hand-back bridge on an engine without the old stage's display guard (its
 * StageContinuity.rates). Feed it what was shown at the end of every frame (`.bones[名].quaternion` → x, y, z, w;
 * `.bones[名].position` → x, y, z) with that frame's delta; `lookup` hands the bridge (MotionTransition.start) the
 * rates as they are now: a bone-local angular velocity (rad/s, the bridge's `from · exp(rate · t)`) for a rotation,
 * per axis for a position. A track not shown on the frame before has no rate (it starts from rest); `clear` forgets
 * everything (hidden, a cut: nothing on screen to keep moving).
 */
export class ShownRates {
  private last = new Map<string, readonly number[]>();
  private rates = new Map<string, number[]>();

  record(shown: ReadonlyMap<string, readonly number[]>, delta: number): void {
    const next = new Map<string, number[]>();
    const dt = Number.isFinite(delta) ? delta : 0;
    for (const [name, value] of shown) {
      const before = this.last.get(name);
      // A zero-delta frame (a rebuild between ticks) says nothing about speed: the rate it had stays.
      const rate = !before ? null : dt > 0 ? rateOf(name, before, value, dt) : this.rates.get(name) ?? null;
      if (rate) next.set(name, rate);
    }
    this.rates = next;
    this.last = new Map([...shown].map(([name, value]) => [name, [...value]]));
  }

  /** The rates now, copied (later frames do not change what a bridge started with). */
  lookup(names: Iterable<string>): PoseRates {
    const held = new Map<string, readonly number[]>();
    for (const name of names) { const rate = this.rates.get(name); if (rate) held.set(name, [...rate]); }
    return name => held.get(name) ?? null;
  }

  clear(): void { this.last.clear(); this.rates.clear(); }
}

/** One track's rate from `a` to `b` over `dt` seconds, or null when it is not a bone rotation or position. */
export function rateOf(name: string, a: readonly number[], b: readonly number[], dt: number): number[] | null {
  if (!(dt > 0) || a.length !== b.length || ![...a, ...b].every(Number.isFinite)) return null;
  if (name.endsWith('.position') && a.length === 3) return [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt];
  if (!name.endsWith('.quaternion') || a.length !== 4) return null;
  // d = a⁻¹ · b (bone-local: b = a · d), the shorter way round; rate = axis · angle / dt.
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b, na = Math.hypot(ax, ay, az, aw), nb = Math.hypot(bx, by, bz, bw);
  if (!(na > 1e-9) || !(nb > 1e-9)) return null;
  let x = (aw * bx - ax * bw - ay * bz + az * by) / (na * nb);
  let y = (aw * by + ax * bz - ay * bw - az * bx) / (na * nb);
  let z = (aw * bz - ax * by + ay * bx - az * bw) / (na * nb);
  let w = (aw * bw + ax * bx + ay * by + az * bz) / (na * nb);
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (!(s > 1e-12)) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, w), scale = angle / s / dt;
  return [x * scale, y * scale, z * scale];
}
