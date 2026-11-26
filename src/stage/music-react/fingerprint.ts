/**
 * I-077 step 2: measures a song's fingerprint from the samples the stage already gets (RMS and the three band levels; never audio).
 * The numbers are those of the intro, the stretch from `skipSeconds` to `skipSeconds + introSeconds` after the sound began: the three
 * bands' mean shares, the brightness (the top band against the middle one, on the music layer's own scale), the onset density and the
 * plucked-ness (the mean of the hearing layer's per-onset tone values; 0.5 when there were too few onsets to say), and, when the sketch
 * is asked for, the tempo the music layer has locked on; plus the times of the first section changes (as the hearing layer reports them).
 *
 * Everything is measured over that stretch itself (differences of running totals), never from the hearing layer's smoothed values, which
 * still carry the song before: two plays of one song measure the same numbers whatever was played in between. It follows the sound, not
 * the "is this music" verdict (which arrives some seconds in, and not at the same second each time). A silence of `SILENCE_S`, a gap in
 * the samples or a reset ends the song: if it was heard long enough, with its intro measured and music recognised at some point, the
 * finished sketch waits to be taken (`takeFinished`) and learned. Fixed-size state, no allocation per sample. Pure.
 */
import type { MusicEnergySample } from '../music-dance';
import { SONG_MEMORY_KNOBS } from '../../../shared/senses';
import { validateSketch, type SongSketch } from '../../../shared/senses';
import { MUSIC_REACT_KNOBS } from './knobs';

const SOUND_RMS = 0.004;
/** A pause this long (seconds) between sounds is the song's end (a quiet bridge is shorter). */
const SILENCE_S = 2;
/** Fewer sounding samples than this in the window (about 1.5 s of sound): no intro to speak of. */
const MIN_SAMPLES = 45;
/** Fewer onsets than this in the window: the song's plucked-ness is not measured (0.5). */
const MIN_ONSETS = 3;

export interface FinishedSong { sketch: SongSketch; heardS: number }
/** The hearing layer's running totals (hearing.ts `tally`). */
export interface HearingTally { onsets: number; toneSum: number; toneN: number }

const clamp = (x: number, lo = 0, hi = 1) => Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;

export class SongProfiler {
  private start = Number.NaN;
  private last = Number.NaN;
  private quiet = 0;
  private heard = 0;
  private n = 0;
  private low = 0; private mid = 0; private high = 0; private top = 0; private topN = 0;
  private from: HearingTally | null = null;
  private closed = false;
  private measured: { bright: number; pluck: number; dens: number } | null = null;
  private sections: number[] = [];
  private music = false;
  private bpm = 0;
  private finished: FinishedSong | null = null;

  /** One sample (`tally`: the hearing layer's totals right after it heard this sample). */
  add(sample: MusicEnergySample, tally: HearingTally): void {
    const t = sample.time;
    if (!Number.isFinite(t)) { this.reset(); return; }
    if (t === this.last) return;
    if (Number.isFinite(this.last) && (t < this.last || t - this.last > 1)) this.reset(); // a gap: the capture stopped
    const dt = Number.isFinite(this.last) ? Math.min(0.25, t - this.last) : 1 / 30;
    this.last = t;
    const rms = Number.isFinite(sample.rms) ? sample.rms : 0;
    if (rms < SOUND_RMS) {
      if (Number.isFinite(this.start) && (this.quiet += dt) >= SILENCE_S) this.endSong();
      return;
    }
    this.quiet = 0;
    if (!Number.isFinite(this.start)) this.start = t;
    this.heard += dt;
    if (this.closed) return;
    const k = SONG_MEMORY_KNOBS.recognition, from = this.start + k.skipSeconds, to = from + k.introSeconds;
    if (t < from) return;
    if (t > to) { this.close(tally, to - from); return; }
    if (!this.from) this.from = { onsets: tally.onsets, toneSum: tally.toneSum, toneN: tally.toneN };
    const low = Math.max(0, sample.low || 0), mid = Math.max(0, sample.mid || 0), high = Math.max(0, sample.high || 0), sum = low + mid + high;
    if (sum > 1e-9) { this.n++; this.low += low / sum; this.mid += mid / sum; this.high += high / sum; }
    if (mid + high > 1e-9) { this.top += high / (mid + high); this.topN++; }
  }

  /** The window is over: the numbers are fixed. */
  private close(tally: HearingTally, span: number): void {
    this.closed = true;
    const from = this.from;
    if (!from || this.n < MIN_SAMPLES) return;
    const c = MUSIC_REACT_KNOBS.color, onsets = tally.onsets - from.onsets, toneN = tally.toneN - from.toneN;
    const top = this.topN ? this.top / this.topN : 0;
    this.measured = { bright: clamp((top - c.darkShare) / (c.brightShare - c.darkShare)),
      pluck: toneN >= MIN_ONSETS ? clamp((tally.toneSum - from.toneSum) / toneN) : 0.5, dens: clamp(onsets / Math.max(1, span), 0, 40) };
  }

  /** The recognition's marker: music was recognised while this song played (a song she only heard as noise or speech is never learned). */
  markMusic(): void { this.music = true; }

  /** A section change at sample time `at` (the first few are kept, as seconds from the sound's start). */
  noteSection(at: number): void {
    if (!Number.isFinite(this.start) || !Number.isFinite(at) || at < this.start || this.sections.length >= 4) return;
    this.sections.push(at - this.start);
  }

  /** The intro measured: ready for a lookup. */
  get ready(): boolean { return this.measured !== null; }
  /** Seconds of sound heard in this song so far. */
  get heardSeconds(): number { return this.heard; }

  /** Remembers the tempo the music layer had locked when the sketch was asked for (a finished song learns with it). */
  rememberBpm(bpm: number | null): void { this.bpm = bpm && Number.isFinite(bpm) && bpm > 0 ? bpm : 0; }

  /** The intro's sketch with the tempo given (null: not ready). */
  sketch(bpm: number | null, withSections = false): SongSketch | null {
    const m = this.measured;
    if (!m) return null;
    const sum = this.low + this.mid + this.high || 1;
    return validateSketch({ bpm: bpm && Number.isFinite(bpm) && bpm > 0 ? Math.min(400, bpm) : 0,
      bands: [this.low / sum, this.mid / sum, this.high / sum], bright: m.bright, pluck: m.pluck, dens: m.dens, sec: withSections ? this.sections.slice() : [] });
  }

  /** A song that ended by itself (silence), once; null when there is none. */
  takeFinished(): FinishedSong | null { const f = this.finished; this.finished = null; return f; }

  private endSong(): void {
    if (this.music && this.measured && this.heard >= SONG_MEMORY_KNOBS.keep.minHeardSeconds) {
      const sketch = this.sketch(this.bpm, true);
      if (sketch) this.finished = { sketch, heardS: this.heard };
    }
    this.clear();
  }

  private clear(): void {
    this.start = Number.NaN; this.quiet = 0; this.heard = 0; this.n = 0; this.low = this.mid = this.high = this.top = this.topN = 0; this.from = null; this.closed = false;
    this.measured = null; this.sections = []; this.music = false; this.bpm = 0;
  }

  /** A hard cut (the capture stopped, a model change): the song in progress is dropped, nothing is learned from it. */
  reset(): void { this.clear(); this.last = Number.NaN; this.finished = null; }
}
