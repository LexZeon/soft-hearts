export interface MusicEnergySample {
  /** Monotonic sample time in seconds; energy values are normalized to 0..1. */
  time: number;
  rms: number;
  low: number;
  mid: number;
  high: number;
}

export interface MusicDanceBeat {
  active: boolean;
  pulse: boolean;
  strength: number;
}

export interface MusicDancePose {
  /** Radians; bounce is a fraction of the current model's height. */
  sway: number;
  bounce: number;
  chestRoll: number;
  headRoll: number;
  headPitch: number;
}

export const MUSIC_DANCE_LIMITS: Readonly<MusicDancePose> = Object.freeze({
  sway: 0.045,
  bounce: 0.006,
  chestRoll: 0.035,
  headRoll: 0.025,
  headPitch: 0.14,
});

/**
 * Exit after the rhythm is turned off (R15). The dance keeps its own phase and
 * dies down under an ease-out envelope, so it never stops dead and never jumps
 * back to idle: fast at first, landing gently on the still-advancing base pose.
 */
export const MUSIC_RELEASE_SECONDS = 0.5;
/** Remaining share of the dance after `progress` (0..1) of the exit. */
export function musicReleaseGain(progress: number): number {
  const rest = 1 - clamp(Number.isFinite(progress) ? progress : 1);
  return rest * rest;
}

/**
 * R29b: yielding to a higher owner (speech, a pat or feeding, window/camera
 * adjusting, a manual head track) is a hand-off, not a reset. The dance keeps
 * its phase and level underneath; only its shown share (presence) eases out
 * and later back in, from whatever share is shown at that moment, with zero
 * speed at both ends so neither edge adds a kick to the moving dance.
 */
export const MUSIC_YIELD_SECONDS = MUSIC_RELEASE_SECONDS;
/** Coming back starts once fresh audible input arrives. */
export const MUSIC_RETURN_SECONDS = 0.6;
const easeInOut = (progress: number) => { const t = clamp(Number.isFinite(progress) ? progress : 1); return t * t * (3 - 2 * t); };

const ZERO_POSE: MusicDancePose = { sway: 0, bounce: 0, chestRoll: 0, headRoll: 0, headPitch: 0 };
const QUIET_BEAT: MusicDanceBeat = { active: false, pulse: false, strength: 0 };
function clamp(value: number, max = 1) { return Math.max(0, Math.min(max, value)); }
const unit = (value: number) => Number.isFinite(value) ? clamp(value) : 0;
const smooth = (current: number, target: number, delta: number, seconds: number) =>
  target + (current - target) * Math.exp(-delta / seconds);

/** Local energy/onset analysis and bounded offsets; it never owns audio or bones. */
export class MusicDance {
  private lastTime: number | null = null;
  private lastBeat = -Infinity;
  private previous = { low: 0, mid: 0, high: 0 };
  private baseline = { low: 0, mid: 0, high: 0 };
  private fluxBaseline = 0;
  private rmsBaseline = 0;
  private noise = 0.003;
  private bands = { low: 0, mid: 0, high: 0 };
  private density = 0;
  private targetLevel = 0;
  private level = 0;
  private activity = 0;
  private sampleAge = Infinity;
  private kick = 0;
  private signedKick = 0;
  private direction = 1;
  private phase = 0;
  private beatPeriod = 0.5;
  private pose = { ...ZERO_POSE };
  private suppressed = false;
  private acceptingSamples = true;
  /** Seconds into the exit; the shown dance is the live motion times musicReleaseGain. */
  private release: { elapsed: number } | null = null;
  /** Shown share of the dance (R29b), its value when the last yield/return began, and seconds since. */
  private presence = 1;
  private presenceFrom = 1;
  private presenceElapsed = 0;
  /**
   * I-016 (docs/claude/2026-11-03-listen-kind.md): what she hears is not recognized as music (talk, a show's dialogue, not
   * yet sure). Unlike a yield, the analysis is untouched (every sample, phase, tempo and level go on exactly as before), only
   * the shown share eases out and back in; so once music is recognized and the share is back to 1, every frame is R15's own.
   */
  private held = false;
  private hold = 1;
  private holdFrom = 1;
  private holdElapsed = 0;

  /** Read-only envelope facts, separate from the last captured signal. */
  getState(): { active: boolean; pulse: boolean; level: number; sampleAge: number | null; suppressed: boolean;
    releasing: boolean; releaseProgress: number; releaseRemainingMs: number; presence: number } {
    const active = this.acceptingSamples && !this.suppressed && this.sampleAge <= 0.2 && this.targetLevel > 0;
    return { active, pulse: active && this.lastTime === this.lastBeat && this.sampleAge <= 0.05,
      level: this.level, sampleAge: Number.isFinite(this.sampleAge) ? this.sampleAge : null, suppressed: this.suppressed,
      releasing: this.release !== null, releaseProgress: this.release ? clamp(this.release.elapsed / MUSIC_RELEASE_SECONDS) : 1,
      releaseRemainingMs: this.release ? Math.max(0, (MUSIC_RELEASE_SECONDS - this.release.elapsed) * 1000) : 0,
      presence: this.presence };
  }

  /**
   * Stop input now. The motion already on screen keeps its phase and its level
   * and eases out over MUSIC_RELEASE_SECONDS; no captured sample is used again.
   */
  stop(): void {
    if (!this.acceptingSamples) return;
    this.acceptingSamples = false;
    this.clearInput();
    if (!this.release && (Object.values(this.pose).some(value => value !== 0) || this.level > 1e-5 || this.activity > 1e-5))
      this.release = { elapsed: 0 };
  }

  /** A new capture does not resurrect the old onset or interrupt an unfinished exit. */
  resume(): void {
    this.acceptingSamples = true;
    this.clearInput();
  }

  /**
   * Yield to (or come back from) a higher owner. Input is rejected while
   * yielding and the next listen starts a fresh analysis, so no beat is queued
   * or replayed; the motion itself keeps its phase and level and only its
   * shown share eases out, then back in from whatever share is shown (R29b).
   */
  setSuppressed(suppressed: boolean): void {
    if (this.suppressed === suppressed) return;
    this.suppressed = suppressed;
    this.clearInput();
    this.presenceFrom = this.presence; this.presenceElapsed = 0;
  }

  /**
   * I-016: hold the shown dance back while the sound is not recognized as music (see `held`). With nothing shown yet the
   * share is set at once (there is nothing to ease); otherwise it eases out over MUSIC_YIELD_SECONDS and back in over
   * MUSIC_RETURN_SECONDS from whatever is shown, with zero speed at both ends.
   */
  setHeld(held: boolean): void {
    const on = held === true;
    if (on === this.held) return;
    this.held = on;
    this.holdFrom = this.hold; this.holdElapsed = 0;
    if (!this.release && Object.values(this.pose).every(value => value === 0)) this.hold = this.holdFrom = on ? 0 : 1;
  }
  get isHeld(): boolean { return this.held; }
  /** The shown share the hold leaves (1 = all of it). */
  get heldShare(): number { return this.hold; }

  update(sample: MusicEnergySample): MusicDanceBeat {
    if (!this.acceptingSamples || this.suppressed) return { ...QUIET_BEAT };
    if (!Number.isFinite(sample.time)) {
      this.reset();
      return { ...QUIET_BEAT };
    }
    if (this.lastTime !== null && sample.time < this.lastTime) this.reset();
    // Duplicate timestamps may be delivered by a paused capture; do not count twice.
    if (sample.time === this.lastTime) return { active: this.targetLevel > 0, pulse: false, strength: 0 };
    const delta = this.lastTime === null ? 1 / 30 : clamp(sample.time - this.lastTime, 2);
    this.lastTime = sample.time;
    this.sampleAge = 0;
    const rms = unit(sample.rms);
    const low = unit(sample.low), mid = unit(sample.mid), high = unit(sample.high);
    // Learn only below the quiet gate; sustained soft music must never train itself out.
    if (rms < 0.01) this.noise = smooth(this.noise, rms, delta, 2);
    const gate = Math.max(0.012, Math.min(0.015, this.noise * 1.5));
    const active = rms > gate;
    if (active) this.rejoin();
    const flux = Math.max(0, low - this.previous.low) +
      Math.max(0, mid - this.previous.mid) * 0.55 + Math.max(0, high - this.previous.high) * 0.2;
    const risingBand = low > this.baseline.low * 1.13 + 0.012 ||
      mid > this.baseline.mid * 1.2 + 0.015;
    const pulse = active && risingBand && flux > Math.max(0.018, this.fluxBaseline * 1.8) &&
      sample.time - this.lastBeat >= 0.18;
    let strength = 0;
    this.density *= Math.exp(-delta / 2);
    if (pulse) {
      const relativeEnergy = Math.max(0, rms - this.rmsBaseline);
      strength = clamp(0.12 + flux / (0.12 + this.baseline.low * 0.55 + this.baseline.mid * 0.25) * 0.55 + relativeEnergy * 0.5);
      const interval = sample.time - this.lastBeat;
      // A comfortable loop follows recent pulses without estimating a song's BPM.
      if (interval >= 0.25 && interval <= 1.2) this.beatPeriod = smooth(this.beatPeriod, interval, 1, 2);
      this.lastBeat = sample.time;
      this.direction *= -1;
      this.kick = Math.max(this.kick, strength);
      this.signedKick = this.direction * strength;
      this.density = clamp(this.density + 0.22);
    }
    this.previous = { low, mid, high };
    this.baseline.low = smooth(this.baseline.low, low, delta, 0.45);
    this.baseline.mid = smooth(this.baseline.mid, mid, delta, 0.45);
    this.baseline.high = smooth(this.baseline.high, high, delta, 0.45);
    this.fluxBaseline = smooth(this.fluxBaseline, flux, delta, 0.7);
    this.rmsBaseline = smooth(this.rmsBaseline, rms, delta, 4);
    const sum = low + mid + high;
    const proportion = sum > 1e-6 ? { low: low / sum, mid: mid / sum, high: high / sum } : { low: 0, mid: 0, high: 0 };
    for (const band of ["low", "mid", "high"] as const)
      this.bands[band] = smooth(this.bands[band], proportion[band], delta, 0.35);
    // Absolute loudness is bounded; relative change and pulse strength add variation.
    // A sustained loud passage settles back to its recent baseline instead of escalating.
    const relative = clamp((rms - this.rmsBaseline) / Math.max(0.06, this.rmsBaseline));
    this.targetLevel = active ? clamp(0.18 + Math.sqrt(clamp((rms - gate) * 3)) * 0.48 + relative * 0.16) : 0;
    return { active, pulse, strength };
  }

  frame(deltaSeconds: number, strength = 0.7): MusicDancePose {
    const delta = Number.isFinite(deltaSeconds) ? clamp(deltaSeconds, 10) : 0;
    // An event between display ticks (or a bad frame time) never changes what is shown.
    if (delta === 0) return this.shown();
    this.stepPresence(delta);
    this.stepHold(delta);
    if (this.release) {
      this.release.elapsed = Math.min(MUSIC_RELEASE_SECONDS, this.release.elapsed + delta);
      if (this.release.elapsed >= MUSIC_RELEASE_SECONDS) { this.release = null; this.settle(); return { ...ZERO_POSE }; }
      // Keep dancing at the level shown when the rhythm was turned off; only the
      // envelope takes it away. Earlier beats still fade on their own clocks.
      this.advance(delta, strength, true);
      return this.shown();
    }
    // A yielding dance keeps its level and phase running underneath (no input is used).
    this.advance(delta, strength, this.suppressed);
    return this.shown();
  }

  /** R29b presence: eases out while yielding; back in once fresh audible input arrives. */
  private stepPresence(delta: number): void {
    if (this.suppressed) {
      this.presenceElapsed += delta;
      this.presence = this.presenceFrom * (1 - easeInOut(this.presenceElapsed / MUSIC_YIELD_SECONDS));
    } else if (this.presence < 1) {
      // Nothing to come back to yet: hold the shown share while the held level dies down like any silence.
      if (this.sampleAge > 0.2 || this.targetLevel <= 0) { this.presenceFrom = this.presence; this.presenceElapsed = 0; return; }
      this.presenceElapsed += delta;
      this.presence = this.presenceFrom + (1 - this.presenceFrom) * easeInOut(this.presenceElapsed / MUSIC_RETURN_SECONDS);
    }
  }

  /** I-016: the held share, toward 0 while held and back to exactly 1 (smoothstep, from whatever is shown). */
  private stepHold(delta: number): void {
    const target = this.held ? 0 : 1;
    if (this.hold === target) return;
    this.holdElapsed += delta;
    const progress = this.holdElapsed / (this.held ? MUSIC_YIELD_SECONDS : MUSIC_RETURN_SECONDS);
    this.hold = progress >= 1 ? target : this.holdFrom + (target - this.holdFrom) * easeInOut(progress);
  }

  private shown(): MusicDancePose {
    const gain = (this.release ? musicReleaseGain(this.release.elapsed / MUSIC_RELEASE_SECONDS) : 1) * this.presence * this.hold;
    if (gain === 1) return { ...this.pose };
    if (gain === 0) return { ...ZERO_POSE };
    const pose = { ...this.pose };
    for (const key of Object.keys(pose) as (keyof MusicDancePose)[]) pose[key] *= gain;
    return pose;
  }

  /** Fresh audible input during an exit continues from exactly what is shown. */
  private rejoin(): void {
    if (!this.release) return;
    const gain = musicReleaseGain(this.release.elapsed / MUSIC_RELEASE_SECONDS);
    for (const key of Object.keys(this.pose) as (keyof MusicDancePose)[]) this.pose[key] *= gain;
    this.level *= gain; this.activity *= gain; this.kick *= gain; this.signedKick *= gain;
    this.release = null;
  }

  private advance(delta: number, strength: number, holdLevel: boolean): void {
    const amount = unit(strength);
    this.sampleAge += delta;
    if (!holdLevel) {
      const target = this.suppressed || this.sampleAge > 0.2 ? 0 : this.targetLevel;
      this.level = smooth(this.level, target, delta, target > this.level ? 0.12 : 0.45);
      // Activity owns entry/exit; volume changes the accent without shrinking soft
      // but valid audio into an imperceptible head movement.
      const active = target > 0 ? 1 : 0;
      this.activity = smooth(this.activity, active, delta, active > this.activity ? 0.16 : 0.35);
    }
    this.kick *= Math.exp(-delta / 0.2);
    this.signedKick *= Math.exp(-delta / 0.24);
    if (!holdLevel && this.level < 1e-5 && this.activity < 1e-5 && this.kick < 1e-5 &&
      Object.values(this.pose).every(value => Math.abs(value) < 1e-7)) {
      this.level = 0;
      this.activity = 0;
      this.kick = 0;
      this.signedKick = 0;
      this.phase = 0;
      this.pose = { ...ZERO_POSE };
      return;
    }
    this.phase = (this.phase + delta * Math.PI / this.beatPeriod) % (Math.PI * 4);
    const { low, mid, high } = this.bands;
    const swayWeight = 0.35 + mid * 0.65;
    const bounceWeight = (0.35 + low * 0.65) * (0.5 + this.density * 0.5);
    const headWeight = 0.2 + high * 0.8;
    // One continuous phase follows the recent pulse interval. A down-and-back
    // nod survives sustained audio without new onsets; fresh kicks only accent
    // it. Low-frequency music is not penalized by the treble proportion.
    const nod = clamp(0.5 - Math.cos(this.phase * 2) * 0.5 + this.kick * 0.18);
    const headAmount = this.activity * (0.45 + this.level * 0.4 + this.kick * 0.15);
    const targets: MusicDancePose = {
      sway: amount * MUSIC_DANCE_LIMITS.sway * this.level * clampSigned(Math.sin(this.phase) * swayWeight + this.signedKick * 0.2),
      bounce: amount * MUSIC_DANCE_LIMITS.bounce * this.level * clamp(this.kick * bounceWeight + (0.5 - Math.cos(this.phase * 2) * 0.5) * low * 0.1),
      chestRoll: amount * MUSIC_DANCE_LIMITS.chestRoll * this.level * -Math.sin(this.phase + 0.3) * (0.25 + mid * 0.75) * (0.4 + this.kick * 0.6),
      headRoll: amount * MUSIC_DANCE_LIMITS.headRoll * this.level * Math.sin(this.phase * 0.5) * headWeight * (0.4 + this.kick * 0.6),
      headPitch: amount * MUSIC_DANCE_LIMITS.headPitch * headAmount * nod,
    };
    for (const channel of Object.keys(this.pose) as (keyof MusicDancePose)[]) {
      this.pose[channel] = smooth(this.pose[channel], targets[channel], delta, 0.055);
      this.pose[channel] = channel === "bounce"
        ? clamp(this.pose[channel], MUSIC_DANCE_LIMITS[channel])
        : clampSigned(this.pose[channel], MUSIC_DANCE_LIMITS[channel]);
      if (Math.abs(this.pose[channel]) < 1e-7) this.pose[channel] = 0;
    }
  }

  /** Hard cut for hide/dispose only: nothing is shown, so nothing is handed off. */
  reset(): void {
    this.clearSignal();
    this.release = null;
    this.pose = { ...ZERO_POSE };
    this.presence = this.presenceFrom = this.suppressed ? 0 : 1; this.presenceElapsed = 0;
    this.hold = this.holdFrom = this.held ? 0 : 1; this.holdElapsed = 0;
  }

  private settle(): void {
    this.clearMotion();
    this.pose = { ...ZERO_POSE };
  }

  private clearSignal(): void {
    this.clearInput();
    this.clearMotion();
  }

  /** Capture analysis only: what the next sample is compared against. */
  private clearInput(): void {
    this.lastTime = null;
    this.lastBeat = -Infinity;
    this.previous = { low: 0, mid: 0, high: 0 };
    this.baseline = { low: 0, mid: 0, high: 0 };
    this.fluxBaseline = 0;
    this.rmsBaseline = 0;
    this.noise = 0.003;
    this.targetLevel = 0;
    this.sampleAge = Infinity;
    this.direction = 1;
  }

  /** The motion being shown: its phase, tempo, spectrum weights and envelope. */
  private clearMotion(): void {
    this.bands = { low: 0, mid: 0, high: 0 };
    this.density = 0;
    this.level = 0;
    this.activity = 0;
    this.kick = 0;
    this.signedKick = 0;
    this.phase = 0;
    this.beatPeriod = 0.5;
  }
}

function clampSigned(value: number, limit = 1): number {
  return Math.max(-limit, Math.min(limit, value));
}
