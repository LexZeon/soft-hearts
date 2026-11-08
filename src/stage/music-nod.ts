/**
 * The middle tier of "音频律动由她决定" (M1): she does not dance, she only nods and sways a little to the
 * beat. It goes through R18's small motions, not the dance: the offsets below are added to procedural
 * life's head tilt and upper-body sway (procedural-life.ts `beat` input), so every owner and yield rule
 * of the small motions still applies (a pat, a chat gesture, the dance itself, sleep, previews) and the
 * clamps bound it. The R29 rule holds: nothing starts or stops by a cut.
 *
 * The beat comes from the same local energy analysis as the dance (music-dance.ts `MusicDance`), run as
 * a second, separate instance that only this module reads. Its own envelopes give the smooth entry,
 * the 0.5 s ease-out when it stops, and R29b's hand-off when she speaks. The dance instance itself is
 * never touched, so R15 is exactly as it was.
 */
import { MusicDance, type MusicEnergySample } from './music-dance';
import { dampCritical } from './procedural';

/** Offsets for procedural life (radians; head x > 0 nods the chin down, as in LifeActivity). */
export interface MusicNodOffsets { headX: number; headZ: number; bodyZ: number }

/** Share of the dance's own pose a nod keeps. Trial values; the user's trial decides how much is "light". R18 (2026-11-03): pitch 0.4 -> 0.65 (with a softer follower, below), the real-Electron check showed a 0.1-0.5 deg nod. */
export const MUSIC_NOD_SCALE = Object.freeze({ pitch: 0.65, roll: 0.6, sway: 0.45 });
/** Hard bounds, inside procedural life's own head and sway limits. */
export const MUSIC_NOD_LIMITS = Object.freeze({ headX: 0.04, headZ: 0.015, bodyZ: 0.015 });

const clampSigned = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
/**
 * R29f: the engine's pose answers each beat's accent by a first-order step (its speed jumps at every kick) and its
 * ease-out starts at full rate; the nod follows it critically damped instead, so the head's speed is continuous
 * through every beat, the entry and the stop. ω 20 rad/s: 2 / ω = 100 ms of extra lag on a 0.5 s beat (R18 2026-11-03: was
 * 30 with pitch 0.4; the larger nod keeps the same R29f "no kick" bound, < 2 deg/s per frame, with the softer follower).
 */
export const MUSIC_NOD_FOLLOW = 20;
const KEYS = ['headX', 'headZ', 'bodyZ'] as const;

export class MusicNod {
  private readonly engine = new MusicDance();
  private on = false;
  private readonly offsets: MusicNodOffsets = { headX: 0, headZ: 0, bodyZ: 0 };
  private readonly velocity: MusicNodOffsets = { headX: 0, headZ: 0, bodyZ: 0 };

  /** Start or stop following the beat. Stopping eases out over the engine's release; starting waits for fresh audible input. */
  setActive(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) this.engine.resume(); else this.engine.stop();
  }
  /** Yield to a higher owner (she is speaking): a hand-off by the engine's own presence, then back in. */
  setSuppressed(value: boolean): void { this.engine.setSuppressed(value); }
  /** I-016: not recognized as music (talk, a show's dialogue): the beat analysis goes on, the nod eases out until it is. */
  setHeld(value: boolean): void { this.engine.setHeld(value); }
  update(sample: MusicEnergySample): void { if (this.on) this.engine.update(sample); }

  /** Still following the beat, or still easing out. When false the offsets are exactly zero. */
  get busy(): boolean {
    const state = this.engine.getState();
    return this.on || state.releasing || state.level > 1e-5 || KEYS.some(key => this.offsets[key] !== 0);
  }
  get active(): boolean { return this.on; }

  frame(deltaSeconds: number, strength: number): Readonly<MusicNodOffsets> {
    const pose = this.engine.frame(deltaSeconds, strength);
    const out = this.offsets, state = this.engine.getState();
    const goal: MusicNodOffsets = { headX: clampSigned(pose.headPitch * MUSIC_NOD_SCALE.pitch, MUSIC_NOD_LIMITS.headX),
      headZ: clampSigned(pose.headRoll * MUSIC_NOD_SCALE.roll, MUSIC_NOD_LIMITS.headZ), bodyZ: clampSigned(pose.sway * MUSIC_NOD_SCALE.sway, MUSIC_NOD_LIMITS.bodyZ) };
    const idle = !this.on && !state.releasing && state.level <= 1e-5;
    for (const key of KEYS) {
      out[key] = clampSigned(dampCritical(out[key], goal[key], MUSIC_NOD_FOLLOW, deltaSeconds, this.velocity, key), MUSIC_NOD_LIMITS[key]) + 0;
      // Settled after the engine stopped: exactly zero, so nothing is added any more.
      if (idle && Math.abs(out[key]) < 1e-6 && Math.abs(this.velocity[key]) < 1e-5) out[key] = this.velocity[key] = 0;
    }
    return out;
  }

  /** Hard cut for hide/dispose/scope changes only: nothing is shown, so nothing is handed off. */
  reset(): void {
    this.engine.reset();
    this.on = false;
    this.offsets.headX = this.offsets.headZ = this.offsets.bodyZ = 0;
    this.velocity.headX = this.velocity.headZ = this.velocity.bodyZ = 0;
  }

  getState() {
    return { active: this.on, engine: this.engine.getState(), headX: this.offsets.headX, headZ: this.offsets.headZ, bodyZ: this.offsets.bodyZ };
  }
}
