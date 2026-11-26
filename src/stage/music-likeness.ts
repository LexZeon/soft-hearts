/**
 * I-016 A, the fast layer of "is it music" (docs/claude/2026-11-03-listen-kind.md). On the plan's fifth
 * question: "跟着跳是识别到音乐后决定？我记得有专门识别拍子的部分，可以加一个检测音乐根据拍子？"
 *
 * In the companion window, from the same energy samples the dance reads (src/senses/SystemAudio.ts: RMS and three band amplitudes at
 * about 30 Hz; never audio), over the last LIKENESS_WINDOW_S seconds:
 *  - the beat: an onset strength (rises of the log band energies, like music-dance.ts's flux; per band and summed) has a
 *    clear autocorrelation peak at one period between 0.3 and 1.6 s, that period holds from one look to the next, and the
 *    onsets sit on its grid (their intervals are whole or half multiples of it; also given as the coefficient of variation
 *    of the folded intervals). The low and high bands are looked at on their own too, so a kick or a hi-hat still shows
 *    under a voice in the middle band;
 *  - a song without drums: the sound is sustained (no deep dips, little syllable-rate flutter), it is tonal rather than
 *    hiss (the top band does not dominate), and it still changes slowly (chords and swells), unlike steady noise;
 *  - speech pulls the other way: syllables at irregular intervals, deep dips between words, pauses.
 * One score 0..1 ("像音乐") and a verdict with hysteresis (`music`): that is what lets her hear a song (music-choice.ts) and
 * lets "让她一直跟着跳" show the dance. Pure: no clock, no I/O; the stage feeds the samples.
 *
 * What it cannot tell (see the record): a drone or an ambient piece that does not change for many seconds (it looks like
 * steady noise); dialogue over background music mixed loud enough to fill the dips with a steady beat (the host's slower
 * layer, with the recognizer's tags, is there for that); rap or chant over no beat.
 *
 * I-072:
 *  - the onsets of the computer's sound come from an unsmoothed analyser (counters, shared/senses/music-detect/onset.ts), not from the
 *    rise of the smoothed levels; the bins follow the frames' own phase;
 *  - singing is not dialogue: a voice band that holds steady (sung notes, vibrato) cancels the dips-and-flutter speech evidence;
 *    one that rises and falls syllable by syllable off the beat is speech even over a quiet beat (and is held for a few seconds);
 *  - a remembered song's soft passage is not silence; the song is remembered after it has sounded clearly like music for a while;
 *  - the tempo of the last song is taken back from a 2 s stretch (the summed or the kick band).
 */
import type { MusicEnergySample } from './music-dance';
import { MUSIC_DETECT_KNOBS } from '../../shared/senses/music-detect/knobs';
import type { MusicOffReason } from '../../shared/senses';
import { onsetDelta } from '../../shared/senses';

/** The grid the samples are binned onto (the capture's rate). */
export const LIKENESS_HZ = 30;
export const LIKENESS_WINDOW_S = 8;
/** Features are recomputed this often. */
export const LIKENESS_STEP_S = 0.5;
/** The beat is also looked for in just this last stretch of the window (I-053); the clearer of the two counts. */
export const LIKENESS_SHORT_S = 4;
const LIKENESS_SHORT_TRUST = 0.8;
/** Below this much sound in the window nothing is decided (the score is held at 0). */
export const LIKENESS_MIN_SOUND_S = 2;
/** A sample this loud is sound (music-choice.ts MUSIC_AUDIBLE_RMS). */
export const LIKENESS_SOUND_RMS = 0.004;
/**
 * The verdict: music once the smoothed score has been ≥ MUSIC_ON for ON_HOLD_S; not once it has been < MUSIC_OFF for OFF_HOLD_S.
 * 2026-11-08: only ON 0.55 → 0.50. OFF and the holds stay as they were.
 * At 0.45 dialogue over a quiet beat counted as music; 0.50 does not (test signals). Not fixed by this: a voice-only stretch inside
 * a song pulls the 8-second score down for about 8 s (traced 2026-11-08; plan docs/claude/2026-11-08-music-detection-plan.md).
 * 2026-11-10: ON 0.50 → 0.47, song memory after 5 s instead of 10 s
 * (shared/senses/music-detect/knobs.ts). The real data: she nodded 9 s and stopped, before the 10 s memory began. OFF and the holds
 * stay as the user set them. At 0.47 the test signals still keep dialogue over a quiet beat out of "music".
 */
export const LIKENESS_MUSIC_ON = 0.47;
export const LIKENESS_MUSIC_OFF = 0.35;
export const LIKENESS_ON_HOLD_S = 0.5;
/** Off: after OFF_HOLD_S when the sound is speech-like; after FADE_HOLD_S when only the beat faded (a break, a quiet bridge). */
export const LIKENESS_OFF_HOLD_S = 1;
export const LIKENESS_FADE_HOLD_S = 3;
/** The speech dips are also counted over just the last few seconds, so dialogue after a song shows quickly. */
export const LIKENESS_RECENT_S = 3;
/** I-072: the steadiness of the voice band (speech vs singing) is measured over just the last this many seconds. */
export const LIKENESS_STEADY_S = 3;
/** Nothing heard this long: not music any more. */
export const LIKENESS_SILENCE_OFF_S = 2;
/** I-072: dialogue heard syllable by syllable still counts this long after (a pause between sentences over a quiet beat is not a song). */
export const LIKENESS_SYLLABLE_HOLD_S = 4;
/** Smoothing of the score between looks (seconds). */
export const LIKENESS_SMOOTH_S = 1;

const N = LIKENESS_HZ * LIKENESS_WINDOW_S;
const STEP_BINS = Math.round(LIKENESS_STEP_S * LIKENESS_HZ);
const MIN_LAG = Math.round(0.3 * LIKENESS_HZ), MAX_LAG = Math.round(1.6 * LIKENESS_HZ);
const SLOW_MIN_LAG = Math.round(1.2 * LIKENESS_HZ), SLOW_MAX_LAG = Math.round(4 * LIKENESS_HZ);
const FLOOR_DB = -70;
const BANDS = ['low', 'mid', 'high'] as const;
type Band = typeof BANDS[number];
/** The summed onset: the voice band counts least (speech and singing live there; the beat mostly does not). */
const BAND_WEIGHTS: Readonly<Record<Band, number>> = { low: 1, mid: 0.45, high: 0.6 };

export interface LikenessFeatures {
  /** Seconds of sound in the window. */
  soundS: number;
  /** Autocorrelation peak of the onset strength at a beat period (0..1; the best of the summed, low and high onsets), and the period in seconds. */
  beatPeak: number;
  period: number;
  /** Share of the last looks whose period agreed with this one (0..1; octaves count as agreeing). */
  periodStable: number;
  /** Onsets on the period's grid: 1 − 2 × mean distance of each interval from a half multiple (0..1; random ≈ 0.5). */
  gridLock: number;
  /** Coefficient of variation of the folded inter-onset intervals (lower is steadier; 1 when too few). */
  ioiCv: number;
  /** Autocorrelation peak at slow periods (1.2–4 s): chord changes and swells (0..1). */
  slowPeak: number;
  /** Share of the sounding stretch more than 15 dB under its local peak: pauses and dips between words. */
  dipShare: number;
  /** Mean change of the level between neighbouring bins (dB): syllable-rate flutter. */
  flutter: number;
  /** Level range of the sounding stretch, 90th − 10th percentile (dB): swells; steady noise has almost none. */
  swing: number;
  /** Mean top band minus the louder of the low and middle bands (dB): hiss is high (> 0), tones are low. */
  tilt: number;
  /** Onsets per second. */
  onsetRate: number;
  /** In the last LIKENESS_RECENT_S: separate dips per second (speech has several; a break in a song is one). */
  recentDips: number;
  /** I-053: how steadily the onsets of the last knobs.reacquire.windowSeconds repeat at the tempo of the last song (0..1; 0 when no song is remembered; I-072: the summed or the low band, whichever is clearer). */
  tempoMatch: number;
  /**
   * I-072: in the last LIKENESS_RECENT_S, the share of the loud stretch (within 10 dB of its top) where the voice band's level stays within
   * knobs.speechVsSinging.steadyDb for ±0.1 s (0..1). Speech rises and falls with every syllable (3–7 a second), so it is seldom
   * steady (≈ 0.1–0.35); held sung notes and vibrato are (≈ 0.4–0.9). Absent when there is too little sound to tell.
   */
  steadyShare?: number;
  /** I-072: how well the voice band's onsets sit on the beat's grid (like gridLock; random ≈ 0.5). Absent without a beat period. */
  midLock?: number;
  /** I-072: syllabicVoice held for a moment (it fades over LIKENESS_SYLLABLE_HOLD_S), so a pause between sentences over a beat is still dialogue. */
  syllabicHold?: number;
  /** I-072 round 2: how steadily the voice band's onsets repeat at the beat period (autocorrelation at one and at two periods, the lower; 0..1; irregular speech ≈ 0). Absent without a beat period. */
  midPeriodic?: number;
}

export interface LikenessScore { score: number; beat: number; sustain: number; speech: number }
export const NO_LIKENESS: Readonly<LikenessScore> = Object.freeze({ score: 0, beat: 0, sustain: 0, speech: 0 });

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const db = (value: number) => Math.max(FLOOR_DB, 20 * Math.log10(Math.max(1e-6, Number.isFinite(value) ? value : 0)));

/** The score from the features (separate so the tests and the evaluation can see each part). */
export function likenessScore(f: LikenessFeatures): LikenessScore {
  if (f.soundS < LIKENESS_MIN_SOUND_S) return { ...NO_LIKENESS };
  const beat = clamp((f.beatPeak - 0.2) / 0.3) * (0.4 + 0.6 * f.periodStable) * clamp((f.gridLock - 0.5) / 0.3, 0.2, 1);
  // Sustained: no deep dips and little flutter (pads and held notes ~0.2–1 dB per bin; speech even under music ≥ 1.7).
  const smooth = clamp(1 - f.dipShare / 0.08) * clamp(1 - (f.flutter - 0.9) / 0.8);
  const moving = Math.max(clamp((f.swing - 1) / 3), clamp((f.slowPeak - 0.1) / 0.25));
  const tonal = clamp(1 - (f.tilt + 3) / 6);
  const sustain = smooth * moving * tonal * clamp((f.soundS - 3) / 3);
  // I-072: singing is not dialogue. Where the voice band holds steady (sung notes), the dips and flutter above say nothing about speech;
  // where it rises and falls with every syllable and those syllables are off the beat, it is speech even when a quiet beat fills the dips.
  // Round 2 (Codex T-234): dips that repeat at the beat's own period are the music's structure (side-chain pumping, rap syllables on the grid),
  // not pauses between words: with a clear beat they cancel the speech evidence the same way held notes do.
  const held = Math.max(heldVoice(f), onBeatDips(f)), syllabic = Math.max(syllabicVoice(f), f.syllabicHold ?? 0);
  const speech = Math.max(Math.max(clamp((f.dipShare - 0.08) / 0.17), clamp((f.flutter - 2.6) / 2), clamp((f.recentDips - 0.6) / 1.2)) * (1 - held), syllabic);
  // Either is music; both together (a beat under a held sung line) is more surely music than either alone.
  const score = clamp((1 - (1 - beat) * (1 - sustain * 0.9)) * (1 - speech));
  return { score, beat, sustain, speech };
}

/** I-072: 1 when the voice band holds steady like sung notes (0 below knobs.speechVsSinging.heldShare, 1 at 0.2 above it). */
export function heldVoice(f: Pick<LikenessFeatures, 'steadyShare'>): number {
  const k = MUSIC_DETECT_KNOBS.speechVsSinging;
  return f.steadyShare === undefined ? 0 : clamp((f.steadyShare - k.heldShare) / 0.2);
}
/**
 * I-072 round 2: 1 when the voice band's dips and onsets repeat at the beat period (knobs.speechVsSinging.onBeatFrom, full 0.25 above it) and the
 * beat is clear (the beat part of likenessScore, without the period's stability). Irregular syllables, and words over a beat, do not repeat at it.
 */
export function onBeatDips(f: Partial<Pick<LikenessFeatures, 'midPeriodic' | 'beatPeak' | 'gridLock'>>): number {
  if (f.midPeriodic === undefined || f.beatPeak === undefined || f.gridLock === undefined) return 0;
  const beat = clamp((f.beatPeak - 0.2) / 0.3) * clamp((f.gridLock - 0.5) / 0.3, 0.2, 1);
  return clamp((f.midPeriodic - MUSIC_DETECT_KNOBS.speechVsSinging.onBeatFrom) / 0.25) * beat;
}
/** I-072: 1 when the voice band rises and falls syllable by syllable (steady ≤ syllabicShare) off the beat's grid (midLock ≤ offBeatLock − 0.2). */
export function syllabicVoice(f: Pick<LikenessFeatures, 'steadyShare' | 'midLock'> & Partial<Pick<LikenessFeatures, 'midPeriodic' | 'beatPeak' | 'gridLock'>>): number {
  const k = MUSIC_DETECT_KNOBS.speechVsSinging;
  if (f.steadyShare === undefined) return 0;
  const offBeat = f.midLock === undefined ? 1 : clamp((k.offBeatLock - f.midLock) / 0.2);
  return clamp((k.syllabicShare + 0.15 - f.steadyShare) / 0.15) * offBeat * (1 - onBeatDips(f));
}

/** One flip of the verdict, numbers only (never sound, titles or words): what the journal's 'music-verdict' line is made of. */
export interface MusicVerdictFlip { music: boolean; score: number; beat: number; speech: number; soundS: number; reason?: MusicOffReason }

export interface MusicLikenessState {
  /** The verdict (with hysteresis): she can hear that this is music. */
  music: boolean;
  /** The smoothed score 0..1. */
  score: number;
  /** The last look's parts. */
  last: LikenessScore;
  features: LikenessFeatures | null;
  /** Seconds since the verdict last changed. */
  heldS: number;
}

/** The fast "is it music" layer. Feed every sample (`update`); read `music` and `score`. */
export class MusicLikeness {
  private readonly energy = new Float32Array(N);
  private readonly level: Record<Band, Float32Array> = { low: new Float32Array(N), mid: new Float32Array(N), high: new Float32Array(N) };
  private readonly onset: Record<Band, Float32Array> = { low: new Float32Array(N), mid: new Float32Array(N), high: new Float32Array(N) };
  private readonly active = new Uint8Array(N);
  private readonly bands: Record<Band, number> = { low: FLOOR_DB, mid: FLOOR_DB, high: FLOOR_DB };
  private head = -1;
  private lastBin: number | null = null;
  private lastTime = -Infinity;
  // I-072: the phase of the capture's frames on the 30 Hz grid (a smoothed unit vector), so bins are cut half a bin away from them
  private phaseC = 0;
  private phaseS = 0;
  private filled = 0;
  private sinceLook = 0;
  private periods: number[] = [];
  private smoothed = 0;
  private verdict = false;
  private pendingS = 0;
  private verdictS = 0;
  private lastScore: LikenessScore = { ...NO_LIKENESS };
  private lastFeatures: LikenessFeatures | null = null;
  private quietBins = 0;
  // I-053: song memory, beat re-acquisition, the energy of the song, and the flips waiting to be told
  private lookS = 0;
  private songPeriod = 0;
  private songPeriodAt = -Infinity;
  private speechRunS = 0;
  private speechGapS = 0;
  private fadeRunS = 0;
  private energy_: number | null = null;
  private flips: MusicVerdictFlip[] = [];
  // I-072: the last sample's onset counters (the unsmoothed analyser), and whether a song is remembered (quiet counts less as silence then)
  private counters: [number | undefined, number | undefined, number | undefined] | null = null;
  private remembered = false;
  private syllableHold = 0;
  private readonly lastRise: Record<Band, number> = { low: 0, mid: 0, high: 0 };
  private clearS = 0;

  get music(): boolean { return this.verdict; }
  get score(): number { return this.smoothed; }
  /** 0..1: how energetic the song is now (a stronger and faster beat is higher); 0 while it is not music. */
  get songEnergy(): number { return this.verdict && this.energy_ !== null ? this.energy_ : 0; }
  /** The verdict flips since the last call, oldest first (the stage hands them to the experience journal). */
  takeFlips(): MusicVerdictFlip[] { const out = this.flips; this.flips = []; return out; }

  update(sample: MusicEnergySample): void {
    if (!Number.isFinite(sample.time)) { this.reset(); return; }
    // I-072: frames at ~30 Hz (a 30 Hz display, or every other frame of a 60 Hz one) can sit right on the edges of the 30 Hz bins; then
    // their jitter of a millisecond or two throws them into the bin before or after, two in one and none in the next, and the beat
    // smears (traced: recognized after 8.5 s instead of 2.5 s). A display a little off 30 / 60 Hz drifts onto the edges every half
    // minute. So the bins follow the frames' own phase: a sample is put in the bin whose middle is nearest to it.
    const raw = sample.time * LIKENESS_HZ, angle = 2 * Math.PI * (raw - Math.floor(raw));
    if (this.lastBin === null || sample.time < this.lastTime) { this.phaseC = Math.cos(angle); this.phaseS = Math.sin(angle); }
    else { this.phaseC += (Math.cos(angle) - this.phaseC) * 0.1; this.phaseS += (Math.sin(angle) - this.phaseS) * 0.1; }
    const phase = Math.hypot(this.phaseC, this.phaseS) > 0.3 ? Math.atan2(this.phaseS, this.phaseC) / (2 * Math.PI) : 0;
    let bin = Math.floor(raw - phase + 0.5);
    if (this.lastBin !== null && (sample.time < this.lastTime || bin - this.lastBin > 2 * LIKENESS_HZ)) this.reset();
    // The phase moving across its wrap can step one bin back: that sample joins the last bin (only time going back starts over).
    if (this.lastBin !== null) bin = Math.max(bin, this.lastBin);
    this.lastTime = sample.time;
    // I-072: a remembered song's soft passage is still sound down to knobs.quiet.rememberedRms (≈ -60 dBFS), not silence.
    const rms = Number.isFinite(sample.rms) ? sample.rms : 0, loud = rms >= (this.remembered ? MUSIC_DETECT_KNOBS.quiet.rememberedRms : LIKENESS_SOUND_RMS);
    const levels: Record<Band, number> = { low: db(sample.low), mid: db(sample.mid), high: db(sample.high) };
    const rise: Record<Band, number> = { low: 0, mid: 0, high: 0 };
    // I-072: the computer's sound brings onset counters from an unsmoothed analyser (shared/senses/music-detect/onset.ts): the rise since the
    // last sample is their difference (a repeated sample adds 0, a dropped one moves its rise here). Without them (the microphone), the
    // rise of the smoothed band level, as before.
    const counters: [number | undefined, number | undefined, number | undefined] = [sample.onsetLow, sample.onsetMid, sample.onsetHigh];
    const fromCounters = BANDS.map((_, i) => onsetDelta(counters[i], this.counters?.[i]));
    const counted = fromCounters.every(value => Number.isFinite(value));
    this.counters = counters;
    // A hit read by two frames (its attack straddles them) is split between two samples; each counted rise also carries the one before
    // (the flux of the last ~67 ms), so a split hit and a whole one look the same whatever the frames' phase against the beat.
    BANDS.forEach((band, i) => {
      const now = counted ? Math.max(0, fromCounters[i]!) : 0;
      const value = counted ? now + this.lastRise[band] : levels[band] - this.bands[band];
      this.lastRise[band] = now;
      rise[band] = loud ? Math.min(20, Math.max(0, value)) : 0; this.bands[band] = levels[band];
    });
    if (this.lastBin !== null && bin === this.lastBin) {
      // Two samples in one bin: the latest level, and the stronger rise (counted rises add up: each is only the part since the last sample).
      for (const band of BANDS) { this.onset[band][this.head] = counted ? Math.min(20, this.onset[band][this.head]! + rise[band]) : Math.max(this.onset[band][this.head]!, rise[band]); this.level[band][this.head] = levels[band]; }
      this.energy[this.head] = db(rms); if (loud) { this.active[this.head] = 1; this.quietBins = 0; }
      return;
    }
    // A missed bin (the capture runs on display frames) holds the level and has no onset of its own.
    const gap = this.lastBin === null ? 1 : bin - this.lastBin;
    for (let i = 1; i < gap; i++) this.hold();
    this.head = (this.head + 1) % N;
    for (const band of BANDS) { this.onset[band][this.head] = rise[band]; this.level[band][this.head] = levels[band]; }
    this.energy[this.head] = db(rms); this.active[this.head] = loud ? 1 : 0;
    this.filled = Math.min(N, this.filled + 1);
    this.lastBin = bin;
    this.quietBins = loud ? 0 : this.quietBins + gap;
    for (let i = 0; i < gap; i++) if (++this.sinceLook >= STEP_BINS) { this.sinceLook = 0; this.look(); }
  }

  private hold(): void {
    const previous = this.head;
    this.head = (this.head + 1) % N;
    for (const band of BANDS) { this.onset[band][this.head] = 0; this.level[band][this.head] = previous >= 0 ? this.level[band][previous]! : FLOOR_DB; }
    this.energy[this.head] = previous >= 0 ? this.energy[previous]! : FLOOR_DB;
    this.active[this.head] = previous >= 0 ? this.active[previous]! : 0;
    this.filled = Math.min(N, this.filled + 1);
  }

  /** The window oldest first. */
  private series(source: Float32Array | Uint8Array): Float64Array {
    const out = new Float64Array(this.filled);
    for (let i = 0; i < this.filled; i++) out[i] = source[(this.head - this.filled + 1 + i + N) % N]!;
    return out;
  }

  /** The features of the current window (null before there is a second of it). */
  features(): LikenessFeatures | null {
    const n = this.filled;
    if (n < LIKENESS_HZ) return null;
    const energy = this.series(this.energy), active = this.series(this.active);
    const bandOnsets = { low: this.series(this.onset.low), mid: this.series(this.onset.mid), high: this.series(this.onset.high) };
    const summed = new Float64Array(n);
    for (const band of BANDS) for (let i = 0; i < n; i++) summed[i]! += bandOnsets[band][i]! * BAND_WEIGHTS[band];
    let sound = 0; for (const value of active) sound += value;
    const soundS = sound / LIKENESS_HZ;
    // The beat on the whole window (8 s) and on its last LIKENESS_SHORT_S as well; the clearer one counts. A voice-only stretch in a
    // song spoils the 8-second window for about 8 s after it ends, while the short one has the beat back after a few seconds (I-053).
    let beat = analyseBeat(summed, bandOnsets);
    const shortN = Math.round(LIKENESS_SHORT_S * LIKENESS_HZ);
    if (n >= shortN + LIKENESS_HZ) {
      const from = n - shortN;
      const quick = analyseBeat(summed.subarray(from), { low: bandOnsets.low.subarray(from), mid: bandOnsets.mid.subarray(from), high: bandOnsets.high.subarray(from) });
      // Four seconds hold fewer onsets, so chance rhythms (words over a quiet beat) fool it more easily: its peak counts at 0.8.
      quick.peak *= LIKENESS_SHORT_TRUST;
      if (beatValue(quick) > beatValue(beat) + 1e-9) beat = quick;
    }
    const { peak: beatPeak, period, slowPeak, lock, ioiCv, peaks } = beat;
    // Inside the sounding stretch (within 1 s of sound): dips more than 15 dB under the local (±0.5 s) peak, flutter, range, tilt.
    let span = 0, dips = 0, flutter = 0, flutterN = 0, tilt = 0, tiltN = 0, episodes = 0, run = 0;
    const recentFrom = n - Math.round(LIKENESS_RECENT_S * LIKENESS_HZ);
    // The recent dips are measured against the window's median level (a pause between words falls far below it; the space
    // between two kicks does not) and must last at least two bins.
    const levels: number[] = []; for (let i = 0; i < n; i++) if (active[i]) levels.push(energy[i]!);
    levels.sort((a, b) => a - b);
    const median = levels.length ? levels[Math.floor(levels.length / 2)]! : FLOOR_DB;
    const sounding: number[] = [];
    let lastActive = -Infinity, nextActive = Infinity;
    const nextFrom = (i: number) => { for (let j = i; j < n; j++) if (active[j]) return j; return Infinity; };
    nextActive = nextFrom(0);
    const lowL = this.series(this.level.low), midL = this.series(this.level.mid), highL = this.series(this.level.high);
    for (let i = 0; i < n; i++) {
      if (active[i]) lastActive = i;
      if (nextActive < i) nextActive = nextFrom(i);
      if (i - lastActive > LIKENESS_HZ && nextActive - i > LIKENESS_HZ) { run = 0; continue; }
      span++;
      let peak = FLOOR_DB;
      for (let j = Math.max(0, i - 15); j <= Math.min(n - 1, i + 15); j++) peak = Math.max(peak, energy[j]!);
      if (energy[i]! < peak - 15) dips++;
      run = energy[i]! < median - 12 ? run + 1 : 0;
      if (run === 2 && i >= recentFrom) episodes++;
      if (active[i]) {
        sounding.push(energy[i]!);
        tilt += highL[i]! - Math.max(lowL[i]!, midL[i]!); tiltN++;
        if (i > 0 && active[i - 1]) { flutter += Math.abs(energy[i]! - energy[i - 1]!); flutterN++; }
      }
    }
    sounding.sort((a, b) => a - b);
    const pct = (p: number) => sounding.length ? sounding[Math.min(sounding.length - 1, Math.floor(p * sounding.length))]! : 0;
    const steadyShare = steadyVoice(midL, active, n - Math.round(LIKENESS_STEADY_S * LIKENESS_HZ));
    // The grid of the voice band's onsets needs a few seconds of them; before that only the steadiness counts.
    const midLock = period > 0 && soundS >= LIKENESS_SHORT_S ? gridLock(bandOnsets.mid, period).lock : undefined;
    const midPeriodic = period > 0 && soundS >= LIKENESS_SHORT_S ? Math.max(periodicAt(bandOnsets.mid, period), periodicAt(midL, period)) : undefined;
    // Period stability across the last looks (the same beat within 8 %: also its double, triple or quadruple, either way).
    const agree = (a: number, b: number) => [1 / 4, 1 / 3, 0.5, 1, 2, 3, 4].some(k => Math.abs(a - b * k) <= 0.08 * a);
    const stable = period > 0 && this.periods.length ? this.periods.filter(p => agree(period, p)).length / this.periods.length : 0;
    return {
      soundS, beatPeak: clamp(beatPeak), period, periodStable: stable, gridLock: clamp(lock), ioiCv,
      slowPeak: clamp(slowPeak), dipShare: span ? dips / span : 0, flutter: flutterN ? flutter / flutterN : 0,
      swing: sounding.length ? pct(0.9) - pct(0.1) : 0, tilt: tiltN ? tilt / tiltN : 0, onsetRate: peaks / (beat.n / LIKENESS_HZ),
      recentDips: episodes / Math.min(LIKENESS_RECENT_S, n / LIKENESS_HZ),
      tempoMatch: this.songPeriod > 0 ? Math.max(tempoMatch(summed, this.songPeriod), tempoMatch(bandOnsets.low, this.songPeriod)) : 0,
      ...(steadyShare === undefined ? {} : { steadyShare }), ...(midLock === undefined ? {} : { midLock }), ...(midPeriodic === undefined ? {} : { midPeriodic }),
    };
  }

  private look(): void {
    const f = this.features();
    this.lastFeatures = f;
    if (f) f.syllabicHold = this.syllableHold = Math.max(syllabicVoice(f), this.syllableHold * Math.exp(-LIKENESS_STEP_S / LIKENESS_SYLLABLE_HOLD_S));
    const part = f ? likenessScore(f) : { ...NO_LIKENESS };
    const dt = LIKENESS_STEP_S, knobs = MUSIC_DETECT_KNOBS;
    this.lookS += dt;
    // Beat re-acquisition: the beat of the last song is back at the same tempo (the octaves count too): take it at once, without
    // waiting for the smoothing, and without the speech part of the 8-second window that a voice-only stretch left behind.
    let reacquired = false;
    if (f && this.songPeriod > 0 && this.lookS - this.songPeriodAt <= knobs.reacquire.rememberSeconds && f.tempoMatch >= knobs.reacquire.minBeat
      && syllabicVoice(f) < 0.5) { // I-072: words over the same beat are dialogue, not the song coming back
      reacquired = true;
      part.score = Math.max(part.score, clamp(0.5 + 0.4 * f.tempoMatch));
      part.beat = Math.max(part.beat, f.tempoMatch); // I-072: the beat is back (taken by the tempo it had), and the song's energy follows it
    }
    this.lastScore = part;
    if (f && f.period > 0) { this.periods.push(f.period); if (this.periods.length > 8) this.periods.shift(); }
    this.smoothed = part.score + (this.smoothed - part.score) * Math.exp(-dt / LIKENESS_SMOOTH_S);
    if (reacquired) this.smoothed = Math.max(this.smoothed, part.score);
    // Dialogue-like sound right now: pauses between words in the last few seconds, and nothing that looks like music again.
    // I-072: and not sung (the voice holds its notes), or plainly syllable by syllable off the beat even with no deep pauses.
    const speechNow = !!f && !reacquired && ((f.recentDips >= 0.6 && heldVoice(f) < 0.5 && onBeatDips(f) < 0.5) || syllabicVoice(f) >= 0.5);
    if (speechNow) { this.speechRunS += dt; this.speechGapS = 0; } else if ((this.speechGapS += dt) >= 1.5) this.speechRunS = 0;
    // A song she has heard as music for a while is remembered: a voice-only stretch or a quiet bridge does not end it.
    // I-072: remembered once it has sounded clearly like music (the smoothed score over the "music" line) for minMusicSeconds, not just
    // been judged music that long: a short opening whose score is already falling into dialogue is not remembered.
    const remembered = this.verdict && (this.remembered || this.clearS >= knobs.songMemory.minMusicSeconds);
    this.verdictS += dt;
    if (this.verdict && this.smoothed >= LIKENESS_MUSIC_ON) this.clearS += dt;
    if (remembered) {
      this.fadeRunS = this.smoothed < LIKENESS_MUSIC_OFF ? this.fadeRunS + dt : 0;
      if (this.speechRunS >= knobs.songMemory.speechSeconds) { this.flip(false, part, f, 'memory-ended'); this.songPeriod = 0; } // dialogue after a song: its tempo is forgotten
      else if (this.fadeRunS >= knobs.songMemory.fadeSeconds) this.flip(false, part, f, 'beat-faded');
    } else {
      // Hysteresis with a hold on both sides. Going off is quick when it is speech, slow when only the beat faded (a break, a bridge).
      // I-072: and never on in silence (the window still holds the beat of a song that just stopped: it would go on and off again).
      const flip = this.verdict ? this.smoothed < LIKENESS_MUSIC_OFF : this.smoothed >= LIKENESS_MUSIC_ON && this.quietBins < LIKENESS_HZ;
      this.pendingS = flip ? this.pendingS + dt : 0;
      const offHold = part.speech >= 0.3 ? LIKENESS_OFF_HOLD_S : LIKENESS_FADE_HOLD_S;
      if (flip && this.pendingS >= (this.verdict ? offHold : LIKENESS_ON_HOLD_S) - 1e-9)
        this.flip(!this.verdict, part, f, part.speech >= 0.3 ? 'speech-like' : 'beat-faded');
    }
    // Silence is no song: off once nothing has been heard for LIKENESS_SILENCE_OFF_S (a break shorter than that keeps it; a
    // remembered song waits knobs.songMemory.silenceSeconds).
    const silenceS = remembered ? knobs.songMemory.silenceSeconds : LIKENESS_SILENCE_OFF_S;
    if (this.verdict && this.quietBins >= silenceS * LIKENESS_HZ) { this.flip(false, part, f, 'silence'); this.smoothed = Math.min(this.smoothed, LIKENESS_MUSIC_OFF); }
    // The song's tempo is remembered while the beat is clear, and its energy follows (the first look as music starts it).
    if (this.verdict && f && f.period > 0 && part.beat >= 0.7 && f.periodStable >= 0.8) { this.songPeriod = f.period; this.songPeriodAt = this.lookS; }
    if (this.verdict && f && f.period > 0) {
      const bpm = foldBpm(60 / f.period), now = 0.6 * part.beat + 0.4 * clamp((bpm - 80) / 50);
      this.energy_ = this.energy_ === null ? now : this.energy_ + (now - this.energy_) * (1 - Math.exp(-dt / 4));
    }
    this.remembered = this.verdict && (this.remembered || this.clearS >= knobs.songMemory.minMusicSeconds);
  }

  /** The verdict changes (and the journal is told, with numbers only). */
  private flip(music: boolean, part: LikenessScore, f: LikenessFeatures | null, reason: MusicOffReason): void {
    if (music === this.verdict) return;
    this.verdict = music; this.pendingS = 0; this.verdictS = 0; this.clearS = 0; this.remembered = false; this.fadeRunS = 0; this.speechRunS = 0; this.speechGapS = 0;
    if (music) this.energy_ = null;
    if (this.flips.length < 8) this.flips.push({ music, score: this.smoothed, beat: part.beat, speech: part.speech, soundS: f?.soundS ?? 0, ...(music ? {} : { reason }) });
  }

  getState(): MusicLikenessState {
    return { music: this.verdict, score: this.smoothed, last: { ...this.lastScore }, features: this.lastFeatures ? { ...this.lastFeatures } : null, heldS: this.verdictS };
  }

  /** The capture stopped (or the clock went back): start over, not music. */
  reset(): void {
    this.energy.fill(0); this.active.fill(0);
    for (const band of BANDS) { this.onset[band].fill(0); this.level[band].fill(0); this.bands[band] = FLOOR_DB; }
    this.head = -1; this.lastBin = null; this.lastTime = -Infinity; this.filled = 0; this.sinceLook = 0; this.periods = [];
    if (this.verdict && this.flips.length < 8) this.flips.push({ music: false, score: this.smoothed, beat: this.lastScore.beat, speech: this.lastScore.speech, soundS: this.lastFeatures?.soundS ?? 0, reason: 'capture-stopped' });
    this.smoothed = 0; this.verdict = false; this.pendingS = 0; this.verdictS = 0; this.quietBins = 0;
    this.lastScore = { ...NO_LIKENESS }; this.lastFeatures = null;
    this.songPeriod = 0; this.songPeriodAt = -Infinity; this.speechRunS = 0; this.speechGapS = 0; this.fadeRunS = 0; this.energy_ = null;
    this.counters = null; this.remembered = false; this.syllableHold = 0; this.clearS = 0;
    for (const band of BANDS) this.lastRise[band] = 0;
  }
}

/** The developer panel's words for the fast layer: score, its parts and the verdict. */
export function likenessLine(state: MusicLikenessState | undefined): string {
  if (!state) return '像音乐：还没收到声音';
  const f = state.features, part = state.last;
  const detail = !f || f.soundS < LIKENESS_MIN_SOUND_S ? '声音不够，先不判断'
    : `节拍 ${part.beat.toFixed(2)}${f.period > 0 ? `（周期 ${f.period.toFixed(2)} s，稳 ${f.periodStable.toFixed(2)}，对齐 ${f.gridLock.toFixed(2)}）` : ''} · 持续 ${part.sustain.toFixed(2)} · 像说话 ${part.speech.toFixed(2)}`;
  return `像音乐 ${state.score.toFixed(2)}（${detail}）→ ${state.music ? '认出是音乐' : '不是音乐'}`;
}

interface BeatResult { peak: number; period: number; slowPeak: number; lock: number; ioiCv: number; peaks: number; n: number }
/** What a beat result is worth to the score (the beat part of likenessScore, without the period's stability). */
const beatValue = (b: BeatResult) => clamp((b.peak - 0.2) / 0.3) * clamp((b.lock - 0.5) / 0.3, 0.2, 1);

/** The beat of one stretch of onsets: the best of the summed onset and the low and high bands alone, and how well the onsets sit on its grid. */
function analyseBeat(summed: Float64Array, bandOnsets: Record<Band, Float64Array>): BeatResult {
  const n = summed.length;
  let best = periodicity(summed), beatOnset = summed;
  for (const band of ['low', 'high'] as const) {
    const candidate = periodicity(bandOnsets[band]);
    if (candidate.peak > best.peak + 0.05) { best = candidate; beatOnset = bandOnsets[band]; }
  }
  const { peak, period, slowPeak } = best;
  const { lock, ioiCv, peaks } = gridLock(beatOnset, period);
  return { peak, period, slowPeak, lock, ioiCv, peaks, n };
}

/** How well the onsets of one signal sit on the grid of `period` (or a subdivision down to 0.25 s), and the folded intervals' spread. */
function gridLock(beatOnset: Float64Array, period: number): { lock: number; ioiCv: number; peaks: number } {
  const n = beatOnset.length;
  // Onsets of that signal: local peaks above its mean + one deviation, at least 0.13 s apart.
  let mean = 0; for (const value of beatOnset) mean += value; mean /= n;
  let variance = 0; for (const value of beatOnset) variance += (value - mean) ** 2;
  const sd = Math.sqrt(variance / n), peaks: number[] = [];
  for (let i = 1; i < n - 1; i++)
    if (beatOnset[i]! > mean + sd && beatOnset[i]! >= beatOnset[i - 1]! && beatOnset[i]! > beatOnset[i + 1]! && (!peaks.length || i - peaks.at(-1)! >= 4)) peaks.push(i);
  let lock = 0, ioiCv = 1;
  if (period > 0 && peaks.length >= 3) {
    // The autocorrelation may have picked two or three beats (a bar pattern): the grid is the best of the period and its
    // subdivisions down to 0.25 s.
    for (const split of [1, 2, 3, 4]) {
      const grid = period / split;
      if (grid < 0.25 - 1e-9 && split > 1) break;
      let miss = 0; const folded: number[] = [];
      for (let i = 1; i < peaks.length; i++) {
        const ioi = (peaks[i]! - peaks[i - 1]!) / LIKENESS_HZ, multiple = Math.max(0.5, Math.round(ioi / grid * 2) / 2);
        // Halves count: an off-beat hit is still on the grid of eighths.
        miss += Math.abs(ioi / grid - multiple) * 2;
        folded.push(ioi / multiple);
      }
      const value = 1 - 2 * miss / (peaks.length - 1);
      if (value > lock) {
        lock = value;
        const m = folded.reduce((s, v) => s + v, 0) / folded.length;
        ioiCv = folded.length >= 2 ? Math.sqrt(folded.reduce((s, v) => s + (v - m) ** 2, 0) / folded.length) / Math.max(1e-6, m) : 1;
      }
    }
  }
  return { lock, ioiCv, peaks: peaks.length };
}

/** I-072: the steady share of the voice band (LikenessFeatures.steadyShare) over the bins from `from` on; undefined when under 0.5 s is loud. */
function steadyVoice(level: Float64Array, active: Float64Array, from: number): number | undefined {
  const n = level.length, start = Math.max(0, from), loud: number[] = [];
  for (let i = start; i < n; i++) if (active[i]) loud.push(level[i]!);
  if (loud.length < LIKENESS_HZ / 2) return undefined;
  loud.sort((a, b) => a - b);
  const top = loud[Math.floor(0.9 * (loud.length - 1))]!, limit = MUSIC_DETECT_KNOBS.speechVsSinging.steadyDb, half = Math.round(0.1 * LIKENESS_HZ);
  let counted = 0, steady = 0;
  for (let i = start; i < n; i++) {
    if (!active[i] || level[i]! < top - 10) continue;
    counted++;
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(start, i - half); j <= Math.min(n - 1, i + half); j++) { lo = Math.min(lo, level[j]!); hi = Math.max(hi, level[j]!); }
    if (hi - lo < limit) steady++;
  }
  return counted >= LIKENESS_HZ / 2 ? steady / counted : undefined;
}

/**
 * How steadily the onsets of the last knobs.reacquire.windowSeconds (I-072: 2 s, was 2.5; a narrow check at one known period, not a blind search) repeat at `periodS` (or half or twice it): the normalized autocorrelation at that
 * one lag (±6 %), needing at least three onsets on it. 0..1.
 */
const TEMPO_MIN_HIT_DB = 3;
function tempoMatch(summed: Float64Array, periodS: number): number {
  const n = Math.min(summed.length, Math.round(MUSIC_DETECT_KNOBS.reacquire.windowSeconds * LIKENESS_HZ));
  if (n < LIKENESS_HZ) return 0;
  const x = summed.subarray(summed.length - n);
  let mean = 0; for (const value of x) mean += value; mean /= n;
  let r0 = 0; for (const value of x) r0 += (value - mean) ** 2;
  // I-072: no real hit (a rise of a few dB) in the stretch, no tempo: the flicker of a pad or a hiss, normalized, can look periodic.
  let top = 0; for (const value of x) top = Math.max(top, value);
  if (r0 <= 1e-9 || top < TEMPO_MIN_HIT_DB) return 0;
  const at = (centre: number) => {
    let top = -1; const spread = Math.max(1, centre * MUSIC_DETECT_KNOBS.reacquire.periodTolerance);
    for (let lag = Math.round(centre - spread); lag <= Math.round(centre + spread); lag++) {
      if (lag < 6 || lag > n - 10) continue;
      let sum = 0; for (let i = lag; i < n; i++) sum += (x[i]! - mean) * (x[i - lag]! - mean);
      top = Math.max(top, sum / r0 * n / (n - lag));
    }
    return top;
  };
  // A steady beat repeats at the period and again at twice it (a stray syllable rhythm rarely does both).
  let best = 0;
  for (const k of [1, 0.5, 2]) {
    const one = at(periodS * k * LIKENESS_HZ), two = at(2 * periodS * k * LIKENESS_HZ);
    if (one >= 0) best = Math.max(best, two >= 0 ? Math.min(one, two) : one * 0.8);
  }
  return clamp(best);
}
/** The normalized autocorrelation of an onset signal at `periodS` and at twice it (±6 %, the lower of the two): 0..1. */
function periodicAt(x: Float64Array, periodS: number): number {
  const n = x.length;
  let mean = 0; for (const value of x) mean += value; mean /= n;
  let r0 = 0; for (const value of x) r0 += (value - mean) ** 2;
  if (r0 <= 1e-9) return 0;
  const at = (centre: number) => {
    let top = -1; const spread = Math.max(1, centre * 0.06);
    for (let lag = Math.round(centre - spread); lag <= Math.round(centre + spread); lag++) {
      if (lag < 6 || lag > n - 10) continue;
      let sum = 0; for (let i = lag; i < n; i++) sum += (x[i]! - mean) * (x[i - lag]! - mean);
      top = Math.max(top, sum / r0 * n / (n - lag));
    }
    return top;
  };
  const one = at(periodS * LIKENESS_HZ), two = at(2 * periodS * LIKENESS_HZ);
  return clamp(one >= 0 ? (two >= 0 ? Math.min(one, two) : one * 0.8) : 0);
}
/** A tempo in BPM folded into 70..150 (the autocorrelation cannot tell a beat from its double). */
function foldBpm(bpm: number): number {
  let value = Number.isFinite(bpm) && bpm > 0 ? bpm : 100;
  while (value < 70) value *= 2;
  while (value >= 150) value /= 2;
  return value;
}

/**
 * Autocorrelation of one onset signal (mean removed, lag-unbiased): the beat period is the shortest local peak in 0.3–1.6 s
 * within 85 % of the strongest one (so a bar or three beats does not win over the beat itself); slowPeak is the strongest
 * local peak in 1.2–4 s.
 */
function periodicity(onset: Float64Array): { peak: number; period: number; slowPeak: number } {
  const n = onset.length;
  let mean = 0; for (const value of onset) mean += value; mean /= n;
  let r0 = 0; for (const value of onset) r0 += (value - mean) ** 2;
  const top = Math.min(SLOW_MAX_LAG, n - 2);
  if (r0 <= 1e-9 || top <= MIN_LAG) return { peak: 0, period: 0, slowPeak: 0 };
  const acs = new Float64Array(top + 2);
  for (let lag = 1; lag <= top + 1; lag++) {
    let s = 0; for (let i = lag; i < n; i++) s += (onset[i]! - mean) * (onset[i - lag]! - mean);
    acs[lag] = s / r0 * n / (n - lag);
  }
  const local = (lag: number) => acs[lag]! >= acs[lag - 1]! && acs[lag]! >= acs[lag + 1]!;
  // A beat period has peaks at its multiples too (two beats, a bar): score each candidate by the mean of those, so the
  // beat wins over the bar and over a stray peak; a slight preference for the shorter one breaks near ties.
  const at = (lag: number) => { const i = Math.round(lag); return i >= 1 && i <= top ? Math.max(acs[i - 1]!, acs[i]!, acs[i + 1]!) : null; };
  let beatLag = 0, peak = 0;
  for (let lag = MIN_LAG; lag <= Math.min(MAX_LAG, top); lag++) {
    if (!local(lag) || acs[lag]! <= 0) continue;
    const multiples = [1, 2, 3, 4].map(k => at(lag * k)).filter((v): v is number => v !== null);
    const comb = multiples.reduce((s, v) => s + Math.max(0, v), 0) / multiples.length * (1 - 0.1 * lag / MAX_LAG);
    if (comb > peak) { peak = comb; beatLag = lag; }
  }
  let slowPeak = 0;
  for (let lag = SLOW_MIN_LAG; lag <= top; lag++) if (local(lag)) slowPeak = Math.max(slowPeak, acs[lag]!);
  // Refine between bins (parabolic) so tempos off the 30 Hz grid fold cleanly.
  let period = beatLag / LIKENESS_HZ;
  if (beatLag > 0) {
    const a = acs[beatLag - 1]!, b = acs[beatLag]!, c = acs[beatLag + 1]!, d = a - 2 * b + c;
    if (d < 0) period = (beatLag + clamp(0.5 * (a - c) / d, -0.5, 0.5)) / LIKENESS_HZ;
  }
  return { peak: clamp(peak), period, slowPeak: clamp(slowPeak) };
}
