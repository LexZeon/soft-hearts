/**
 * Seeded randomness for procedural life (procedural-life.ts). Pure, no Three,
 * no allocation after construction.
 *
 * - `hashSeed`: a stable 32-bit seed from a text key (the character id), so the
 *   same character keeps the same motion "handwriting" across sessions.
 * - `SeededRandom`: mulberry32, for discrete events (saccade timing, blink
 *   intervals, tilt moments).
 * - `SmoothNoise`: 1D gradient noise on a hashed integer lattice. It is
 *   C2-continuous (quintic fade), roughly in [-1, 1], and has no period short
 *   of 2^32 lattice cells, so a drift never visibly loops. `fbm` adds a second
 *   octave at an irrational ratio for an organic, non-repeating wander.
 */

export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  const value = String(text ?? '');
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Integer avalanche (murmur3 finalizer). */
function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = (seed >>> 0) || 0x9e3779b9; }
  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(low: number, high: number): number { return low + (high - low) * this.next(); }
}

/** fbm second-octave ratio (golden ratio squared): never commensurate with the first. */
const OCTAVE = 2.618033988749895;

export class SmoothNoise {
  private readonly seed: number;
  constructor(seed: number) { this.seed = mix32(seed >>> 0); }

  /** Lattice gradient in [-1, 1] for one channel. */
  private gradient(cell: number, channel: number): number {
    return mix32(Math.imul(cell | 0, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77) ^ this.seed) / 2147483647.5 - 1;
  }

  /** Smooth noise at time `t` (lattice units) on an independent `channel`; about [-1, 1]. */
  sample(t: number, channel: number): number {
    if (!Number.isFinite(t)) return 0;
    const cell = Math.floor(t), f = t - cell;
    // Lattice cells beyond 2^31 wrap; a drift sampled at <= 1 Hz needs decades to get there.
    const g0 = this.gradient(cell, channel), g1 = this.gradient(cell + 1, channel);
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    return 2 * (g0 * f * (1 - u) + g1 * (f - 1) * u);
  }

  /** Two octaves, normalized to about [-1, 1]. */
  fbm(t: number, channel: number): number {
    return (this.sample(t, channel) + 0.5 * this.sample(t * OCTAVE + 17.31, channel + 101)) / 1.5;
  }
}
