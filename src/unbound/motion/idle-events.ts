/**
 * Motion-model spike round 2 (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮」): the event layer. The model (or any idle
 * source) makes the slow idle; people also make quick small moves while standing (a head flick, a turn of the head with the chest
 * following, a quick shift of weight). Those are cut out of the same people's data (scripts/ml/idle_events.py: peaks of the head's
 * turning speed, 1.2 s windows with the line between their ends taken out and tapered ends) and laid over the slow idle here, as
 * often as the people made them at that liveliness. Nothing is hand-written: the library and the rates are data.
 *
 * An event adds onto whatever the source shows and starts and ends at zero with zero speed, so it never makes a step; the intent
 * layer's springs still decide how fast her body follows.
 */
import { IDLE_DIM, mirrorFrame, seededRandom, type IdleSource } from './idle-channels';

export interface IdleEventLibrary {
  /** events × frames × IDLE_DIM, 30 Hz, each starting and ending at zero. */
  events: Float32Array;
  frames: number;
  /** How many the people made per minute at each fifth of liveliness (0–0.2, …, 0.8–1). */
  perMinuteByActivityFifth: readonly number[];
}

export interface IdleEventOptions { seed: number; /** Scales the people's rate (1 = as often as they did). */ rateScale: number; /** Quiet time after an event (s). */ gapS: number }
export const IDLE_EVENT_DEFAULTS: Readonly<IdleEventOptions> = Object.freeze({ seed: 5, rateScale: 1, gapS: 1.2 });

/** The people's rate (per minute) at a liveliness, linear between the fifths' centres. */
export function eventRatePerMinute(library: IdleEventLibrary, activity: number): number {
  const r = library.perMinuteByActivityFifth, x = Math.max(0, Math.min(1, activity)) * 5 - 0.5;
  const i = Math.max(0, Math.min(r.length - 2, Math.floor(x))), u = Math.max(0, Math.min(1, x - i));
  return Math.max(0, r[i] + (r[i + 1] - r[i]) * u);
}

export class IdleEvents implements IdleSource {
  readonly id: string;
  private readonly options: IdleEventOptions;
  private random: () => number;
  private readonly count: number;
  private playing = -1;
  private mirrored = false;
  private at = 0;
  private quiet = 0;
  private readonly frame = new Float32Array(IDLE_DIM);
  private readonly flipped = new Float32Array(IDLE_DIM);
  private readonly out = new Float32Array(IDLE_DIM);
  /** Events played so far (for measurements). */
  fired = 0;
  /** A quick move is playing now (Unbound step 4: an idle pause waits for it to end). */
  get busy(): boolean { return this.playing >= 0; }

  constructor(private readonly base: IdleSource, private readonly library: IdleEventLibrary, options: Partial<IdleEventOptions> = {}) {
    this.options = { ...IDLE_EVENT_DEFAULTS, ...options };
    this.random = seededRandom(this.options.seed);
    this.count = Math.floor(library.events.length / (library.frames * IDLE_DIM));
    this.id = `${base.id}+events`;
  }

  reset(seed?: number): void {
    this.base.reset(seed);
    this.random = seededRandom(seed ?? this.options.seed);
    this.playing = -1; this.at = 0; this.quiet = 0; this.fired = 0;
  }

  next(activity: number): Float32Array {
    this.out.set(this.base.next(activity));
    if (this.playing < 0) {
      this.quiet -= 1 / 30;
      const perFrame = eventRatePerMinute(this.library, activity) * this.options.rateScale / 60 / 30;
      if (this.count > 0 && this.quiet <= 0 && this.random() < perFrame) {
        this.playing = Math.min(this.count - 1, Math.floor(this.random() * this.count));
        this.mirrored = this.random() < 0.5;
        this.at = 0;
        this.fired++;
      }
    }
    if (this.playing >= 0) {
      const base = (this.playing * this.library.frames + this.at) * IDLE_DIM;
      this.frame.set(this.library.events.subarray(base, base + IDLE_DIM));
      const add = this.mirrored ? mirrorFrame(this.frame, this.flipped) : this.frame;
      for (let c = 0; c < IDLE_DIM; c++) this.out[c] += add[c];
      if (++this.at >= this.library.frames) { this.playing = -1; this.quiet = this.options.gapS; }
    }
    return this.out;
  }
}
