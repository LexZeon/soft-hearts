/**
 * I-077 step 1 (docs/claude/2026-11-11-i077-music-reactions.md): where the beats are, and which beat starts a group of four, so a
 * reaction can begin on a phrase boundary instead of half a beat off.
 *
 * Idea borrowed (only the idea, our own code and numbers) from the user's Words Actually Dance (MIT): a clock that runs at the tempo
 * and is only nudged by the onsets it hears (a phase-locked loop), never jumped or rewound. That project defines no bars; the group
 * of four here is ours: of the four beat slots, the one where the low band (kick, bass, chord changes) has hit hardest lately is
 * taken as the group's first beat.
 *
 * The tempo is not estimated here: the stage passes the period the fast "is it music" layer already found (music-likeness.ts), folded
 * into 0.4–1.0 s. Pure: no clock of its own; the caller feeds sample times.
 */

/** A beat period is folded into this range (seconds): 60–150 BPM. */
export const BEAT_MIN_S = 0.4, BEAT_MAX_S = 1.0;
/** How far an onset may sit from a predicted beat and still count as that beat (share of the period). */
const MATCH = 0.2;
/** Share of a matched onset's timing error taken per onset (the loop's gain), and the most one onset may move the clock. */
const GAIN = 0.25, MAX_STEP = 0.08;
/** Matches older than this (s) no longer count toward the lock. */
const LOCK_WINDOW_S = 4;
/** The downbeat evidence fades with this time constant (s). */
const SLOT_FADE_S = 10;
/** An onset drives the clock only with at least this much low-band rise (dB). */
const LOW_DB = 2;
/** A section start counts this many times all the kicks together, fading with this time constant (s). */
const ANCHOR_WEIGHT = 1, ANCHOR_FADE_S = 40;

export function foldPeriod(period: number): number {
  if (!(period > 0) || !Number.isFinite(period)) return 0;
  let p = period;
  while (p < BEAT_MIN_S) p *= 2;
  while (p > BEAT_MAX_S) p /= 2;
  return p;
}

export class BeatClock {
  private period = 0;
  /** Time of the next predicted beat and its index (beats counted from the clock's start). */
  private next = Number.NaN;
  private index = 0;
  private readonly matches: number[] = [];
  private readonly slots = [0, 0, 0, 0];
  private slotAt = Number.NaN;
  private lastOnset = -Infinity;
  private readonly misses: number[] = [];
  private anchorSlot = -1;
  private anchorAt = Number.NaN;

  /** The tempo from the music layer; a change of more than 8 % starts the phase over at the next onset. */
  setPeriod(period: number): void {
    const p = foldPeriod(period);
    if (!p) return;
    if (this.period && Math.abs(p - this.period) <= 0.08 * this.period) { this.period += (p - this.period) * 0.2; return; }
    // The same tempo an octave away (the music layer flips between a beat and its double): keep the running clock.
    if (this.period && (Math.abs(p - 2 * this.period) <= 0.08 * p || Math.abs(2 * p - this.period) <= 0.08 * this.period)) return;
    this.period = p; this.next = Number.NaN; this.matches.length = 0; this.slots.fill(0); this.anchorSlot = -1;
  }

  get beatPeriod(): number { return this.period; }

  /** Moves the clock up to `time` (beats that passed are counted). */
  advance(time: number): void {
    if (!this.period || !Number.isFinite(this.next)) return;
    if (time - this.next > 8 * this.period) { this.next = Number.NaN; return; } // a long gap: start over at the next onset
    while (time >= this.next) { this.next += this.period; this.index++; }
  }

  /** An onset at `time` with its strength; `low` is its low-band part (downbeat evidence). */
  onset(time: number, strength: number, low: number): void {
    if (!this.period || !(strength > 0)) return;
    this.advance(time);
    // Only kicks and bass notes (an onset with a real low-band part) drive the clock: off-beat hi-hats and snares never pull it there.
    if (low < LOW_DB) return;
    if (!Number.isFinite(this.next)) { this.next = time + this.period; this.index = 1; this.lastOnset = time; this.note(time, 0, low); return; }
    const before = this.next - this.period;
    const nearPrevious = Math.abs(time - before) <= Math.abs(time - this.next);
    const target = nearPrevious ? before : this.next, error = time - target;
    if (Math.abs(error) > MATCH * this.period) { this.miss(time, low); return; }
    // Nudge the rate, never jump: the next beat moves by a bounded share of the error.
    this.next += Math.max(-MAX_STEP * this.period, Math.min(MAX_STEP * this.period, GAIN * error));
    if (time - this.lastOnset > 0.5 * this.period) this.matches.push(time);
    this.lastOnset = time;
    this.note(time, nearPrevious ? this.index - 1 : this.index, low);
  }

  /**
   * An onset off the clock's beats. When the clock has lost the song (after a break the drums come back half a beat away, which the
   * loop alone would never correct) and several kicks in a row agree with each other, the clock starts again from the latest one.
   * Only onsets with a real low-band part count (off-beat hi-hats never pull it).
   */
  private miss(time: number, low: number): void {
    while (this.misses.length && time - this.misses[0]! > 2.5) this.misses.shift();
    this.misses.push(time);
    if (this.misses.length < 3 || this.confidence(time) >= 0.35) return;
    const phase = (t: number) => { const x = ((time - t) / this.period) % 1; return Math.min(x, 1 - x); };
    if (this.misses.some(t => phase(t) > 0.15)) return;
    this.next = time + this.period; this.index++; this.slots.fill(0); this.anchorSlot = -1; this.matches.length = 0; this.matches.push(time); this.misses.length = 0; this.lastOnset = time;
  }

  private note(time: number, beat: number, low: number): void {
    if (Number.isFinite(this.slotAt)) { const k = Math.exp(-Math.max(0, time - this.slotAt) / SLOT_FADE_S); for (let i = 0; i < 4; i++) this.slots[i]! *= k; }
    this.slotAt = time;
    this.slots[((beat % 4) + 4) % 4]! += Math.max(0, low);
    while (this.matches.length && time - this.matches[0]! > LOCK_WINDOW_S) this.matches.shift();
  }

  /** 0..1: the share of the last few seconds' beats that an onset confirmed. */
  confidence(time: number): number {
    if (!this.period || !Number.isFinite(this.next)) return 0;
    let n = 0; for (const t of this.matches) if (time - t <= LOCK_WINDOW_S) n++;
    return Math.min(1, n / Math.max(1, Math.floor(LOCK_WINDOW_S / this.period) - 1));
  }

  /**
   * A section of the song began at `time` (hearing.ts, snapped to its strongest onset): sections start on bar lines, so the beat
   * nearest to it is the strongest evidence of where a group of four begins. It outweighs the kicks for a while (fading over ~40 s).
   */
  anchor(time: number): void {
    if (!this.period || !Number.isFinite(this.next)) return;
    const k = Math.round((time - this.next) / this.period);
    this.anchorSlot = (((this.index + k) % 4) + 4) % 4; this.anchorAt = time;
  }

  /** The slot (0..3) taken as the first beat of a group of four. */
  get downbeat(): number {
    const fade = Number.isFinite(this.anchorAt) && Number.isFinite(this.slotAt) ? Math.exp(-Math.max(0, this.slotAt - this.anchorAt) / ANCHOR_FADE_S) : 0;
    const total = this.slots[0]! + this.slots[1]! + this.slots[2]! + this.slots[3]!;
    let best = 0, bestValue = -1;
    for (let i = 0; i < 4; i++) { const v = this.slots[i]! + (i === this.anchorSlot ? ANCHOR_WEIGHT * fade * Math.max(1, total) : 0); if (v > bestValue + 1e-9) { best = i; bestValue = v; } }
    return best;
  }

  /** The time of the first group start at or after `time` (null without a running clock). */
  nextGroupStart(time: number): number | null {
    if (!this.period || !Number.isFinite(this.next)) return null;
    // Beats at next + k·period have index + k; the first one ≥ time whose index ≡ downbeat (mod 4).
    let k = Math.ceil((time - this.next) / this.period - 1e-9);
    const want = this.downbeat;
    for (let guard = 0; guard < 4; guard++, k++) if ((((this.index + k) % 4) + 4) % 4 === want) return this.next + k * this.period;
    return null;
  }

  /** The time of the beat nearest to `time` (null without a running clock). */
  nearestBeat(time: number): number | null {
    if (!this.period || !Number.isFinite(this.next)) return null;
    return this.next + Math.round((time - this.next) / this.period) * this.period;
  }

  reset(): void { this.period = 0; this.next = Number.NaN; this.index = 0; this.matches.length = 0; this.slots.fill(0); this.slotAt = Number.NaN; this.lastOnset = -Infinity; this.misses.length = 0; this.anchorSlot = -1; this.anchorAt = Number.NaN; }
}
