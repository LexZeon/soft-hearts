// StayStill idle round (docs/claude/2026-11-14-staystill-idle.md): two measures Codex asked for (bridge X-518) on top of the
// "share of frames under 1°/s" that round 1-2 reported, which says nothing about how the stillness comes:
//   pauses      continuous runs where the head turns slower than a threshold for at least a minimum time (per minute, median
//               length, share of time inside them): "stops, then moves" rather than a slow drift that happens to dip under 1°/s
//   head/chest  how the head's turning about the vertical follows the chest's (world yaw rates): slope of head on chest (1 = the
//               head rides on the chest, 0 = the head holds its direction while the chest turns, < 0 = it turns back against it)
//               and their correlation
// Pure functions over plain numbers and quaternions, so they are tested alone (tests/staystill-idle.test.ts).
import { Quaternion, Vector3 } from 'three';

export interface PauseStats { perMinute: number; medianS: number; share: number; count: number }

/** Runs of `speeds` (deg/s, one per frame at `fps`) below `thresholdDegS` lasting at least `minS` seconds. */
export function pauseRuns(speeds: readonly number[], fps: number, thresholdDegS = 1, minS = 0.3): PauseStats {
  const lengths: number[] = [];
  let run = 0;
  for (let i = 0; i <= speeds.length; i++) {
    if (i < speeds.length && speeds[i] < thresholdDegS) { run++; continue; }
    if (run / fps >= minS) lengths.push(run / fps);
    run = 0;
  }
  const minutes = speeds.length / fps / 60;
  const sorted = [...lengths].sort((a, b) => a - b);
  const total = lengths.reduce((a, b) => a + b, 0);
  return {
    count: lengths.length,
    perMinute: minutes > 0 ? lengths.length / minutes : 0,
    medianS: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0,
    share: speeds.length ? total * fps / speeds.length : 0,
  };
}

/** World yaw rate (deg/s about +Y) between consecutive orientations: the vertical part of the rotation vector of q[i]·q[i-1]⁻¹. */
export function yawRates(quats: readonly Quaternion[], fps: number): number[] {
  const out: number[] = [];
  const d = new Quaternion(), inv = new Quaternion(), axis = new Vector3();
  for (let i = 1; i < quats.length; i++) {
    d.copy(quats[i]).multiply(inv.copy(quats[i - 1]).invert());
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const s = Math.sqrt(Math.max(0, 1 - d.w * d.w));
    const angle = 2 * Math.acos(Math.min(1, d.w));
    axis.set(d.x, d.y, d.z);
    out.push(s > 1e-9 ? axis.y / s * angle * fps * 180 / Math.PI : 0);
  }
  return out;
}

/** Slope (least squares through the means) and correlation of head yaw rate on chest yaw rate. */
export function headOnChest(head: readonly number[], chest: readonly number[]): { slope: number; corr: number } {
  const n = Math.min(head.length, chest.length);
  if (n < 2) return { slope: 0, corr: 0 };
  let mh = 0, mc = 0;
  for (let i = 0; i < n; i++) { mh += head[i]; mc += chest[i]; }
  mh /= n; mc /= n;
  let shc = 0, scc = 0, shh = 0;
  for (let i = 0; i < n; i++) { const h = head[i] - mh, c = chest[i] - mc; shc += h * c; scc += c * c; shh += h * h; }
  return { slope: scc > 0 ? shc / scc : 0, corr: scc > 0 && shh > 0 ? shc / Math.sqrt(scc * shh) : 0 };
}

/**
 * Codex X-518: compute time is not the first visible motion. Seconds from the idle's start until `angles` (deg, one per frame at
 * `fps`, e.g. the head's angle from its pose when the idle began) first exceeds `thresholdDeg`; null when it never does.
 */
export function firstExceed(angles: readonly number[], fps: number, thresholdDeg: number): number | null {
  const i = angles.findIndex(a => a > thresholdDeg);
  return i < 0 ? null : i / fps;
}
