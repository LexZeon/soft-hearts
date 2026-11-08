/**
 * I-016 A, the fast layer of "is it music" (docs/claude/2026-11-03-listen-kind.md). On the plan's fifth
 * question: "跟着跳是识别到音乐后决定？我记得有专门识别拍子的部分，可以加一个检测音乐根据拍子？"
 *
 * In the pet window, from the same energy samples the dance reads (src/ui/SystemAudio.ts: RMS and three band amplitudes at
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
 */
import type { MusicEnergySample } from './music-dance';

/** The grid the samples are binned onto (the capture's rate). */
export const LIKENESS_HZ = 30;
export const LIKENESS_WINDOW_S = 8;
/** Features are recomputed this often. */
export const LIKENESS_STEP_S = 0.5;
/** Below this much sound in the window nothing is decided (the score is held at 0). */
export const LIKENESS_MIN_SOUND_S = 2;
/** A sample this loud is sound (music-choice.ts MUSIC_AUDIBLE_RMS). */
export const LIKENESS_SOUND_RMS = 0.004;
/**
 * The verdict: music once the smoothed score has been ≥ MUSIC_ON for ON_HOLD_S; not once it has been < MUSIC_OFF for OFF_HOLD_S.
 * 2026-11-08 (user: "音乐检测门槛有点高", then "认定不是音乐…这些不改"): only ON 0.55 → 0.50. OFF and the holds stay as they were.
 * At 0.45 dialogue over a quiet beat counted as music; 0.50 does not (test signals). Not fixed by this: a voice-only stretch inside
 * a song pulls the 8-second score down for about 8 s (traced 2026-11-08; plan docs/claude/2026-11-08-music-detection-plan.md).
 */
export const LIKENESS_MUSIC_ON = 0.5;
export const LIKENESS_MUSIC_OFF = 0.35;
export const LIKENESS_ON_HOLD_S = 0.5;
/** Off: after OFF_HOLD_S when the sound is speech-like; after FADE_HOLD_S when only the beat faded (a break, a quiet bridge). */
export const LIKENESS_OFF_HOLD_S = 1;
export const LIKENESS_FADE_HOLD_S = 3;
/** The speech dips are also counted over just the last few seconds, so dialogue after a song shows quickly. */
export const LIKENESS_RECENT_S = 3;
/** Nothing heard this long: not music any more. */
export const LIKENESS_SILENCE_OFF_S = 2;
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
  const speech = Math.max(clamp((f.dipShare - 0.08) / 0.17), clamp((f.flutter - 2.6) / 2), clamp((f.recentDips - 0.6) / 1.2));
  // Either is music; both together (a beat under a held sung line) is more surely music than either alone.
  const score = clamp((1 - (1 - beat) * (1 - sustain * 0.9)) * (1 - speech));
  return { score, beat, sustain, speech };
}

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

  get music(): boolean { return this.verdict; }
  get score(): number { return this.smoothed; }

  update(sample: MusicEnergySample): void {
    if (!Number.isFinite(sample.time)) { this.reset(); return; }
    const bin = Math.floor(sample.time * LIKENESS_HZ);
    if (this.lastBin !== null && (bin < this.lastBin || bin - this.lastBin > 2 * LIKENESS_HZ)) this.reset();
    const rms = Number.isFinite(sample.rms) ? sample.rms : 0, loud = rms >= LIKENESS_SOUND_RMS;
    const levels: Record<Band, number> = { low: db(sample.low), mid: db(sample.mid), high: db(sample.high) };
    const rise: Record<Band, number> = { low: 0, mid: 0, high: 0 };
    for (const band of BANDS) { rise[band] = loud ? Math.min(20, Math.max(0, levels[band] - this.bands[band])) : 0; this.bands[band] = levels[band]; }
    if (this.lastBin !== null && bin === this.lastBin) {
      // Two samples in one bin: keep the stronger rise and the latest level.
      for (const band of BANDS) { this.onset[band][this.head] = Math.max(this.onset[band][this.head]!, rise[band]); this.level[band][this.head] = levels[band]; }
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
    // The beat: the best of the summed onset and the low and high bands alone.
    let best = periodicity(summed), beatOnset = summed;
    for (const band of ['low', 'high'] as const) {
      const candidate = periodicity(bandOnsets[band]);
      if (candidate.peak > best.peak + 0.05) { best = candidate; beatOnset = bandOnsets[band]; }
    }
    const { peak: beatPeak, period, slowPeak } = best;
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
    // Period stability across the last looks (the same beat within 8 %: also its double, triple or quadruple, either way).
    const agree = (a: number, b: number) => [1 / 4, 1 / 3, 0.5, 1, 2, 3, 4].some(k => Math.abs(a - b * k) <= 0.08 * a);
    const stable = period > 0 && this.periods.length ? this.periods.filter(p => agree(period, p)).length / this.periods.length : 0;
    return {
      soundS, beatPeak: clamp(beatPeak), period, periodStable: stable, gridLock: clamp(lock), ioiCv,
      slowPeak: clamp(slowPeak), dipShare: span ? dips / span : 0, flutter: flutterN ? flutter / flutterN : 0,
      swing: sounding.length ? pct(0.9) - pct(0.1) : 0, tilt: tiltN ? tilt / tiltN : 0, onsetRate: peaks.length / (n / LIKENESS_HZ),
      recentDips: episodes / Math.min(LIKENESS_RECENT_S, n / LIKENESS_HZ),
    };
  }

  private look(): void {
    const f = this.features();
    this.lastFeatures = f;
    const part = f ? likenessScore(f) : { ...NO_LIKENESS };
    this.lastScore = part;
    if (f && f.period > 0) { this.periods.push(f.period); if (this.periods.length > 8) this.periods.shift(); }
    const dt = LIKENESS_STEP_S;
    this.smoothed = part.score + (this.smoothed - part.score) * Math.exp(-dt / LIKENESS_SMOOTH_S);
    // Hysteresis with a hold on both sides. Going off is quick when it is speech, slow when only the beat faded (a break, a bridge).
    const flip = this.verdict ? this.smoothed < LIKENESS_MUSIC_OFF : this.smoothed >= LIKENESS_MUSIC_ON;
    this.pendingS = flip ? this.pendingS + dt : 0;
    this.verdictS += dt;
    const offHold = part.speech >= 0.3 ? LIKENESS_OFF_HOLD_S : LIKENESS_FADE_HOLD_S;
    if (flip && this.pendingS >= (this.verdict ? offHold : LIKENESS_ON_HOLD_S) - 1e-9) {
      this.verdict = !this.verdict; this.pendingS = 0; this.verdictS = 0;
    }
    // Silence is no song: off once nothing has been heard for LIKENESS_SILENCE_OFF_S (a break shorter than that keeps it).
    if (this.verdict && this.quietBins >= LIKENESS_SILENCE_OFF_S * LIKENESS_HZ) { this.verdict = false; this.pendingS = 0; this.verdictS = 0; this.smoothed = Math.min(this.smoothed, LIKENESS_MUSIC_OFF); }
  }

  getState(): MusicLikenessState {
    return { music: this.verdict, score: this.smoothed, last: { ...this.lastScore }, features: this.lastFeatures ? { ...this.lastFeatures } : null, heldS: this.verdictS };
  }

  /** The capture stopped (or the clock went back): start over, not music. */
  reset(): void {
    this.energy.fill(0); this.active.fill(0);
    for (const band of BANDS) { this.onset[band].fill(0); this.level[band].fill(0); this.bands[band] = FLOOR_DB; }
    this.head = -1; this.lastBin = null; this.filled = 0; this.sinceLook = 0; this.periods = [];
    this.smoothed = 0; this.verdict = false; this.pendingS = 0; this.verdictS = 0; this.quietBins = 0;
    this.lastScore = { ...NO_LIKENESS }; this.lastFeatures = null;
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
