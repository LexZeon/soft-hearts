/**
 * I-077 step 1, layer 1 ("听出来什么"; docs/claude/2026-11-11-i077-music-reactions.md). From the capture's samples the stage already
 * gets (RMS, three band levels, the unsmoothed onset counters; about 30 a second; never audio), causally and cheaply:
 *  - section lift and fall: the last `section.currentSeconds` against the `referenceSeconds` before them (level, onset density, the
 *    bands' shares), each change measured against the reference's own natural variation, a change has to be corroborated (a level
 *    rise alone only when it is large; a density change only with a change of the bands) and to hold `dwell` seconds against the
 *    reference frozen when it began; then one event, and nothing again for `refractory` seconds. It never names "chorus" or "verse";
 *  - tone style: after each onset, how far the level falls within `tone.windowSeconds` (plucked or struck notes fall far, held notes
 *    and pads hardly): 1 = plucky, 0 = sustained, followed slowly;
 *  - brightness (the top band against the middle one) and bass weight (the low band's share) as continuous values;
 *  - the song's mood color: a slow estimate from tempo, brightness, onset density and tone (-1 slow and dark … +1 bright and upbeat);
 *  - the beat clock (beat-clock.ts) on the onsets, at the music layer's period.
 *
 * Ideas borrowed (ideas only; our own code and numbers) from the user's Words Actually Dance (MIT): the causal section lift (a short
 * current window against a longer preceding one, corroboration by density, bands and timbre, a dwell with a frozen reference) and the
 * tone style from the attack-and-decay envelope. We have three bands, not a spectrum, so "timbre" here is the bands' shares.
 *
 * Fixed-size buffers (5 s of 0.1 s buckets); no allocation per sample.
 */
import type { MusicEnergySample } from '../music-dance';
import { onsetDelta } from '../../../shared/senses';
import { BeatClock } from './beat-clock';
import { MUSIC_REACT_KNOBS } from './knobs';

export const BUCKET_S = 0.1;
const SOUND_RMS = 0.004;
const FLOOR_DB = -70;
/** Onsets closer than this (s) are one (a hit read by two frames). */
const ONSET_GAP_S = 0.15;
/** The summed onset weights per band (the voice band counts least, as in music-likeness.ts). */
const ONSET_WEIGHTS = [1, 0.45, 0.6] as const;
/** Onsets remembered to place a section's start. */
const RECENT = 24;

export interface SectionEvent {
  kind: 'lift' | 'fall';
  /** Sample time at which the change began (about), and when it was confirmed. */
  at: number;
  detectedAt: number;
  /** 0..1: how big the change was. */
  size: number;
}

export interface HearingState {
  /** Seconds of sound heard since the last reset. */
  soundS: number;
  /** 0..1, continuous. */
  brightness: number;
  bass: number;
  /** 0..1: 1 plucky, 0 sustained. */
  pluck: number;
  /** -1 slow and dark … +1 bright and upbeat. */
  color: number;
  /** Onsets per second (recent). */
  density: number;
  bpm: number | null;
  /** The beat clock's lock (0..1). */
  beat: number;
  /** The section comparison right now: the larger of the lift and fall scores, signed (+ lift, − fall). */
  section: number;
}

const clamp = (x: number, lo = 0, hi = 1) => Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
const db = (x: number) => x > 1e-6 ? Math.max(FLOOR_DB, 20 * Math.log10(x)) : FLOOR_DB;

interface Window { level: number; low: number; mid: number; high: number; rate: number; sound: number; spread: number; shareSpread: number }

export class MusicHearing {
  readonly clock = new BeatClock();
  private readonly n: number;
  private readonly cur: number;
  // The buckets (ring): summed level (dB) and shares of sounding samples, their count, all samples, onsets.
  private readonly level: Float64Array; private readonly low: Float64Array; private readonly mid: Float64Array; private readonly high: Float64Array;
  private readonly sounding: Float64Array; private readonly samples: Float64Array; private readonly onsets: Float64Array;
  private head = -1;
  private filled = 0;
  private bucketId = Number.NaN;
  private lastTime = Number.NaN;
  private counters: [number | undefined, number | undefined, number | undefined] | null = null;
  private lastBands = [FLOOR_DB, FLOOR_DB, FLOOR_DB];
  private lastOnsetAt = -Infinity;
  private fluxMean = 0;
  /** The last onsets (time, strength), to find where a section began. */
  private readonly recentAt = new Float64Array(RECENT).fill(Number.NaN);
  private readonly recentStrength = new Float64Array(RECENT);
  private recentHead = 0;
  // Tone: the onset being followed (its peak level and the lowest level since), and the smoothed style.
  private toneFrom = Number.NaN; private tonePeak = FLOOR_DB; private toneMin = 0;
  private pluck_ = 0.5;
  private bright_ = Number.NaN; private bass_ = Number.NaN;
  private color_ = 0;
  private density_ = 0;
  private soundS_ = 0;
  private period = 0;
  // Section: a candidate (direction, start, the reference frozen at its start, how long it held) and the refractory end.
  private candidate: { dir: 1 | -1; from: number; held: number; ref: Window; size: number } | null = null;
  private quietUntil = -Infinity;
  private sectionNow = 0;
  private events: SectionEvent[] = [];
  /**
   * Running totals for the song fingerprint (step 2, fingerprint.ts), which measures a stretch of the song by their differences, so its
   * numbers never carry what the previous song left in the smoothed values: onsets heard, and the sum and count of the per-onset tone values.
   */
  readonly tally = { onsets: 0, toneSum: 0, toneN: 0 };
  private readonly scratch: Window = { level: 0, low: 0, mid: 0, high: 0, rate: 0, sound: 0, spread: 0, shareSpread: 0 };
  private readonly scratchRef: Window = { level: 0, low: 0, mid: 0, high: 0, rate: 0, sound: 0, spread: 0, shareSpread: 0 };

  constructor() {
    const k = MUSIC_REACT_KNOBS.section;
    this.cur = Math.round(k.currentSeconds / BUCKET_S);
    this.n = this.cur + Math.round(k.referenceSeconds / BUCKET_S);
    const f = () => new Float64Array(this.n);
    this.level = f(); this.low = f(); this.mid = f(); this.high = f(); this.sounding = f(); this.samples = f(); this.onsets = f();
  }

  /** The tempo the music layer found (seconds per beat; 0 = none). */
  setPeriod(period: number): void {
    this.period = period > 0 && Number.isFinite(period) ? period : 0;
    if (this.period) this.clock.setPeriod(this.period);
  }

  /** Section changes confirmed since the last call, oldest first. */
  takeEvents(): SectionEvent[] { const out = this.events; if (out.length) this.events = []; return out; }

  get state(): HearingState {
    const t = this.lastTime;
    const bpm = Number.isFinite(t) ? this.beatBpm(t) || null : null;
    return { soundS: this.soundS_, brightness: this.brightness, bass: this.bass, pluck: this.pluck_, color: this.color_, density: this.density_, bpm,
      beat: Number.isFinite(t) ? this.clock.confidence(t) : 0, section: this.sectionNow };
  }
  get time(): number { return this.lastTime; }
  /** The tempo while the beat clock is locked (an unlocked period says nothing about the song: 0). */
  private beatBpm(t: number): number { return this.clock.beatPeriod && this.clock.confidence(t) >= 0.3 ? 60 / this.clock.beatPeriod : 0; }
  get color(): number { return this.color_; }
  get pluck(): number { return this.pluck_; }
  /** 0..1 between the knobs' dark and bright shares. */
  get brightness(): number { const c = MUSIC_REACT_KNOBS.color; return Number.isFinite(this.bright_) ? clamp((this.bright_ - c.darkShare) / (c.brightShare - c.darkShare)) : 0.5; }
  /** 0..1: how much the low band carries (0.4 of the amplitude share or less = 0, 0.75 or more = 1). */
  get bass(): number { return Number.isFinite(this.bass_) ? clamp((this.bass_ - 0.4) / 0.35) : 0.5; }

  update(sample: MusicEnergySample): void {
    const t = sample.time;
    if (!Number.isFinite(t)) { this.reset(); return; }
    if (t === this.lastTime) return; // a repeated sample adds nothing
    if (Number.isFinite(this.lastTime) && (t < this.lastTime || t - this.lastTime > 1)) this.reset();
    const dt = Number.isFinite(this.lastTime) ? Math.min(0.25, t - this.lastTime) : 1 / 30;
    this.lastTime = t;
    const rms = Number.isFinite(sample.rms) ? sample.rms : 0, sound = rms >= SOUND_RMS, levelDb = db(rms);
    const low = Math.max(0, sample.low || 0), mid = Math.max(0, sample.mid || 0), high = Math.max(0, sample.high || 0), sum = low + mid + high;
    // The onset: the unsmoothed counters' rise (the computer's sound), or the rise of the band levels (the microphone).
    const counters: [number | undefined, number | undefined, number | undefined] = [sample.onsetLow, sample.onsetMid, sample.onsetHigh];
    const bands = [db(low), db(mid), db(high)];
    let strength = 0, lowRise = 0;
    for (let i = 0; i < 3; i++) {
      const fromCounter = onsetDelta(counters[i], this.counters?.[i]);
      const rise = Number.isFinite(fromCounter) ? fromCounter : this.counters ? 0 : Math.max(0, bands[i]! - this.lastBands[i]!);
      const value = Math.min(20, Math.max(0, rise));
      strength += value * ONSET_WEIGHTS[i]!;
      if (i === 0) lowRise = value;
      this.lastBands[i] = bands[i]!;
    }
    this.counters = counters[0] === undefined && counters[1] === undefined && counters[2] === undefined ? null : counters;
    // An onset stands out from the recent flux (held notes and pads ripple a little all the time; a hit is several times that).
    const onset = sound && strength >= Math.max(3, 2.5 * this.fluxMean) && t - this.lastOnsetAt >= ONSET_GAP_S;
    this.fluxMean += (strength - this.fluxMean) * (1 - Math.exp(-dt / 1));
    if (onset) { this.tally.onsets++; this.lastOnsetAt = t; this.recentAt[this.recentHead] = t; this.recentStrength[this.recentHead] = strength; this.recentHead = (this.recentHead + 1) % RECENT; }
    this.clock.advance(t);
    if (onset && this.period) this.clock.onset(t, strength, lowRise);
    // Buckets.
    const id = Math.floor(t / BUCKET_S);
    if (id !== this.bucketId) {
      if (Number.isFinite(this.bucketId)) this.closeBucket(this.bucketId);
      const gap = Number.isFinite(this.bucketId) ? Math.min(this.n, id - this.bucketId) : 1;
      for (let i = 0; i < gap; i++) this.openBucket();
      this.bucketId = id;
    }
    const h = this.head;
    this.samples[h]! += 1;
    if (sound) { this.sounding[h]! += 1; this.level[h]! += levelDb; if (sum > 1e-9) { this.low[h]! += low / sum; this.mid[h]! += mid / sum; this.high[h]! += high / sum; } }
    if (onset) this.onsets[h]! += 1;
    if (!sound) return;
    this.soundS_ += dt;
    // Tone: the level's fall after each onset, over the window.
    const tone = MUSIC_REACT_KNOBS.tone;
    if (onset) { this.finishTone(); this.toneFrom = t; this.tonePeak = levelDb; this.toneMin = levelDb; }
    else if (Number.isFinite(this.toneFrom)) {
      if (t - this.toneFrom <= 0.07) this.tonePeak = Math.max(this.tonePeak, levelDb);
      this.toneMin = Math.min(this.toneMin, levelDb);
      if (t - this.toneFrom >= tone.windowSeconds) this.finishTone();
    }
    // Brightness and bass, followed over ~3 s.
    if (sum > 1e-9) {
      const k = 1 - Math.exp(-dt / 3);
      const top = mid + high > 1e-9 ? high / (mid + high) : 0; // the top band against the middle: the bass and kick do not darken it
      this.bright_ = Number.isFinite(this.bright_) ? this.bright_ + (top - this.bright_) * k : top;
      this.bass_ = Number.isFinite(this.bass_) ? this.bass_ + (low / sum - this.bass_) * k : low / sum;
    }
    // The song's color, slowly.
    const c = MUSIC_REACT_KNOBS.color, bpm = this.beatBpm(t);
    const tempo = bpm ? clamp((bpm - c.slowBpm) / (c.fastBpm - c.slowBpm)) * 2 - 1 : -0.6;
    const target = 0.45 * tempo + 0.2 * (this.brightness * 2 - 1) + 0.2 * (clamp(this.density_ / 4) * 2 - 1) + 0.15 * (this.pluck_ * 2 - 1);
    this.color_ += (clamp(target, -1, 1) - this.color_) * (1 - Math.exp(-dt / c.follow));
  }

  private finishTone(): void {
    if (!Number.isFinite(this.toneFrom)) return;
    const tone = MUSIC_REACT_KNOBS.tone, drop = this.tonePeak - this.toneMin;
    const value = clamp((drop - tone.sustainDb) / (tone.pluckDb - tone.sustainDb));
    // Each onset is one look; weighted so a beat's worth of onsets moves it by about 1 / follow-seconds.
    this.tally.toneSum += value; this.tally.toneN++;
    this.pluck_ += (value - this.pluck_) * clamp(0.5 / tone.follow);
    this.toneFrom = Number.NaN;
  }

  /**
   * Where a section began, from the remembered onsets within ±`span` s of the estimate `time` (null: none): a lift begins at the first
   * hit nearly as strong as the strongest there; a fall begins one beat after the last such hit (the old section's last beat).
   */
  private sectionStart(time: number, span: number, dir: 1 | -1): number | null {
    let max = 0;
    for (let i = 0; i < RECENT; i++) if (Math.abs(this.recentAt[i]! - time) <= span) max = Math.max(max, this.recentStrength[i]!);
    if (!(max > 0)) return null;
    let best: number | null = null;
    for (let i = 0; i < RECENT; i++) {
      const at = this.recentAt[i]!;
      if (!(Math.abs(at - time) <= span) || this.recentStrength[i]! < 0.7 * max) continue;
      if (best === null || (dir > 0 ? at < best : at > best)) best = at;
    }
    if (best === null || dir > 0) return best;
    return this.clock.beatPeriod ? best + this.clock.beatPeriod : null;
  }

  private openBucket(): void {
    this.head = (this.head + 1) % this.n;
    const h = this.head;
    this.level[h] = this.low[h] = this.mid[h] = this.high[h] = this.sounding[h] = this.samples[h] = this.onsets[h] = 0;
    this.filled = Math.min(this.n, this.filled + 1);
  }

  /** Mean of `count` buckets ending `skip` buckets before the newest closed one. */
  private window(into: Window, skip: number, count: number): Window {
    let level = 0, low = 0, mid = 0, high = 0, sounding = 0, samples = 0, onsets = 0;
    let s1 = 0, s2 = 0, blocks = 0, block = 0, blockN = 0, sh1 = 0, sh2 = 0, blockLow = 0;
    const per = Math.round(1 / BUCKET_S);
    for (let k = 0; k < count; k++) {
      const i = ((this.head - 1 - skip - k) % this.n + this.n) % this.n;
      level += this.level[i]!; low += this.low[i]!; mid += this.mid[i]!; high += this.high[i]!;
      sounding += this.sounding[i]!; samples += this.samples[i]!; onsets += this.onsets[i]!;
      block += this.sounding[i]! ? this.level[i]! / this.sounding[i]! : FLOOR_DB; blockLow += this.sounding[i]! ? this.low[i]! / this.sounding[i]! : 0; blockN++;
      if (blockN === per || k === count - 1) { const m = block / blockN, ml = blockLow / blockN; s1 += m; s2 += m * m; sh1 += ml; sh2 += ml * ml; blocks++; block = 0; blockLow = 0; blockN = 0; }
    }
    into.level = sounding ? level / sounding : FLOOR_DB;
    into.low = sounding ? low / sounding : 0; into.mid = sounding ? mid / sounding : 0; into.high = sounding ? high / sounding : 0;
    into.rate = onsets / (count * BUCKET_S);
    into.sound = samples ? sounding / samples : 0;
    into.spread = blocks > 1 ? Math.sqrt(Math.max(0, s2 / blocks - (s1 / blocks) ** 2)) : 0;
    into.shareSpread = blocks > 1 ? Math.sqrt(Math.max(0, sh2 / blocks - (sh1 / blocks) ** 2)) : 0;
    return into;
  }

  /** The lift (+) and fall (−) scores of `cur` against `ref` (0..1 each). */
  private score(cur: Window, ref: Window): { lift: number; fall: number } {
    const k = MUSIC_REACT_KNOBS.section;
    const dDb = cur.level - ref.level, slack = Math.min(3, 1.5 * ref.spread);
    const ampLift = clamp((dDb - k.liftDb - slack) / (k.fullDb - k.liftDb)), ampFall = clamp((-dDb - k.liftDb - slack) / (k.fullDb - k.liftDb));
    const densRel = (cur.rate - ref.rate) / Math.max(1, ref.rate);
    // Relative and absolute: a sparse passage gaining or losing one onset a second (a chord change) is not a new section.
    const densAbs = clamp((Math.abs(cur.rate - ref.rate) - 1.5) / 1.5);
    const densLift = clamp((densRel - k.densityRise) / 0.5) * densAbs, densFall = clamp((-densRel - k.densityRise) / 0.5) * densAbs;
    const shift = Math.abs(cur.low - ref.low) + Math.abs(cur.mid - ref.mid) + Math.abs(cur.high - ref.high) - 2 * ref.shareSpread;
    const band = clamp((shift - k.bandShift) / 0.1);
    // Timbre: the top band against the middle one (brighter cymbals, a fuller top), relative to where it was.
    const topCur = cur.high / Math.max(1e-6, cur.mid + cur.high), topRef = ref.high / Math.max(1e-6, ref.mid + ref.high);
    const timbre = clamp((Math.abs(topCur - topRef) / Math.max(0.05, topRef) - 0.15) / 0.3);
    const layers = Math.max(band, timbre);
    // A level change alone counts only when large; a density change only with the bands or the timbre changing too.
    const lift = Math.max(ampLift * (0.6 + 0.4 * Math.max(densLift, layers)), Math.min(densLift, layers));
    const fall = Math.max(ampFall * (0.6 + 0.4 * Math.max(densFall, layers)), Math.min(densFall, layers));
    return { lift, fall };
  }

  private closeBucket(id: number): void {
    if (this.filled < this.n) return;
    const k = MUSIC_REACT_KNOBS.section, now = (id + 1) * BUCKET_S;
    const cur = this.window(this.scratch, -1, this.cur);
    this.density_ += (cur.rate - this.density_) * (1 - Math.exp(-BUCKET_S / 3));
    const ref = this.candidate ? this.candidate.ref : this.window(this.scratchRef, this.cur - 1, this.n - this.cur);
    // Neither side may be silence: a song that stops is the song ending, not a quieter section.
    if (cur.sound < 0.4 || ref.sound < 0.4) { this.candidate = null; this.sectionNow = 0; return; }
    const { lift, fall } = this.score(cur, ref);
    this.sectionNow = lift >= fall ? lift : -fall;
    const c = this.candidate;
    if (c) {
      const value = c.dir > 0 ? lift : fall;
      if (value < 0.6 * k.score) { this.candidate = null; return; }
      c.held += BUCKET_S; c.size = Math.max(c.size, value);
      if (c.held + 1e-9 >= k.dwell) {
        // Where it began: the strongest onset near the estimate (a section starts with a hit), which also tells the beat clock where a bar starts.
        const at = this.sectionStart(c.from, 0.6, c.dir);
        if (at !== null) this.clock.anchor(at);
        this.events.push({ kind: c.dir > 0 ? 'lift' : 'fall', at: at ?? c.from, detectedAt: now, size: c.size });
        if (this.events.length > 8) this.events.shift();
        this.candidate = null; this.quietUntil = now + k.refractory;
      }
      return;
    }
    if (now < this.quietUntil) return;
    const dir: 1 | -1 | 0 = lift >= k.score && lift >= fall ? 1 : fall >= k.score ? -1 : 0;
    if (!dir) return;
    const frozen = this.scratchRef === ref ? { ...ref } : ref;
    this.candidate = { dir, from: now - 0.5 * k.currentSeconds, held: 0, ref: frozen, size: dir > 0 ? lift : fall };
  }

  reset(): void {
    this.clock.reset();
    this.head = -1; this.filled = 0; this.bucketId = Number.NaN; this.lastTime = Number.NaN; this.counters = null;
    this.lastBands = [FLOOR_DB, FLOOR_DB, FLOOR_DB]; this.lastOnsetAt = -Infinity; this.fluxMean = 0; this.recentAt.fill(Number.NaN); this.recentStrength.fill(0); this.recentHead = 0;
    this.toneFrom = Number.NaN; this.pluck_ = 0.5; this.bright_ = Number.NaN; this.bass_ = Number.NaN; this.color_ = 0; this.density_ = 0; this.soundS_ = 0;
    this.candidate = null; this.quietUntil = -Infinity; this.sectionNow = 0; this.events = []; this.tally.onsets = 0; this.tally.toneSum = 0; this.tally.toneN = 0;
    for (const a of [this.level, this.low, this.mid, this.high, this.sounding, this.samples, this.onsets]) a.fill(0);
  }
}
