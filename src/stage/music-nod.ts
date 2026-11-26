/**
 * The middle tier of "音频律动由她决定" (M1): she does not dance, she nods and sways a little to the beat. The R29 rule holds: nothing
 * starts or stops by a cut.
 *
 * The level, the entry, the 0.5 s ease-out when it stops and R29b's hand-off when something takes her (speech, a touch, a camera move)
 * come from the same local energy analysis as the dance (music-dance.ts `MusicDance`), run as a second, separate instance that only this
 * module reads; the dance instance itself is never touched, so R15 is exactly as it was.
 *
 * 2026-11-24: the nod was the engine's own head pitch × 0.65
 * on a loop that does not follow the kicks (about 1° from top to bottom), added to procedural life's head goals; on the window engine's
 * livelier idle it did not show at all, and nothing of it showed while procedural life gave way. Now the chin goes down on the kicks
 * (music-nod-beat.ts: a phase pulled onto the kicks, shown only as far as it has locked on), as deep as the user's strength (MUSIC_NOD_PITCH
 * at strength 1), and the stage writes it on her head itself (window-music.ts), as it writes the dance. Roll and sway keep the engine's.
 */
import { MusicDance, type MusicEnergySample } from './music-dance';
import { dampCritical } from './procedural';
import { NodBeat, followerLagCycles } from './music-nod-beat';
import type { DanceShape } from './music-react/director';

/** Offsets for her head and upper body (radians; head x > 0 nods the chin down, as in LifeActivity). */
export interface MusicNodOffsets { headX: number; headZ: number; bodyZ: number }

/**
 * How far the chin goes down on a kick at strength 1 (rad, top to bottom; the follower shows about three quarters of it at 120 BPM). At
 * the default strength 0.7: about 2.5–3° shown (the song style may lower it a little), against the window idle's own head drift (docs/claude/2026-11-24-music-nod-window.md).
 */
export const MUSIC_NOD_PITCH = 0.11;
/** Share of the dance's own roll and sway a nod keeps (R18's trial values). */
export const MUSIC_NOD_SCALE = Object.freeze({ roll: 0.6, sway: 0.45 });
/** Hard bounds. */
export const MUSIC_NOD_LIMITS = Object.freeze({ headX: 0.12, headZ: 0.015, bodyZ: 0.015 });
/** The least of the user's strength that still shows a nod (below it the share told to her falls to 0 with the strength). */
export const MUSIC_NOD_SHOWN_STRENGTH = 0.25;

const clampSigned = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
/**
 * R29f: the nod follows its goal critically damped, so the head's speed is continuous through every beat, the entry and the stop.
 * ω 20 rad/s (R18 2026-11-03).
 */
export const MUSIC_NOD_FOLLOW = 20;
const KEYS = ['headX', 'headZ', 'bodyZ'] as const;

export class MusicNod {
  private readonly engine = new MusicDance();
  private readonly beat = new NodBeat();
  private on = false;
  private shape: Readonly<DanceShape> | null = null;
  private amount = 0;
  private readonly offsets: MusicNodOffsets = { headX: 0, headZ: 0, bodyZ: 0 };
  private readonly velocity: MusicNodOffsets = { headX: 0, headZ: 0, bodyZ: 0 };

  /** Start or stop following the beat. Stopping eases out over the engine's release; starting waits for fresh audible input. */
  setActive(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) this.engine.resume(); else this.engine.stop();
  }
  /** Yield to a higher owner (she is speaking, a touch, a camera move): a hand-off by the engine's own presence, then back in. */
  setSuppressed(value: boolean): void { this.engine.setSuppressed(value); }
  /** I-016: not recognized as music (talk, a show's dialogue): the beat analysis goes on, the nod eases out until it is. */
  setHeld(value: boolean): void { this.engine.setHeld(value); }
  /** I-077: the song's style and her reactions, as for the dance (music-react/dance-shape.ts); null = untouched. */
  setShape(shape: Parameters<MusicDance['setShape']>[0]): void { this.engine.setShape(shape); this.shape = shape; }
  update(sample: MusicEnergySample): void {
    if (!this.on) return;
    if (this.engine.update(sample).pulse) this.beat.kick();
  }

  /** Still following the beat, or still easing out. When false the offsets are exactly zero. */
  get busy(): boolean {
    const state = this.engine.getState();
    return this.on || state.releasing || state.level > 1e-5 || KEYS.some(key => this.offsets[key] !== 0);
  }
  get active(): boolean { return this.on; }
  /**
   * 0..1: how much of the nod is on her now (the engine's shown share, how far the beat is locked on, and the strength). What she is told
   * she does follows this (music-presence.ts), never the tier alone.
   */
  get shownShare(): number { return this.engine.shownShare * this.beat.share * Math.min(1, this.amount / MUSIC_NOD_SHOWN_STRENGTH); }

  frame(deltaSeconds: number, strength: number): Readonly<MusicNodOffsets> {
    const pose = this.engine.frame(deltaSeconds, strength);
    this.beat.advance(deltaSeconds);
    const out = this.offsets, state = this.engine.getState(), amount = this.amount = unit(strength), shape = this.shape;
    const envelope = this.engine.shownShare, period = this.beat.nodPeriod;
    const dip = this.beat.dip(followerLagCycles(MUSIC_NOD_FOLLOW, period)) * this.beat.share;
    const goal: MusicNodOffsets = {
      headX: clampSigned(amount * envelope * (MUSIC_NOD_PITCH * dip * (shape?.nod ?? 1) + 0.65 * (shape?.headX ?? 0)), MUSIC_NOD_LIMITS.headX),
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
    this.engine.reset(); this.beat.reset();
    this.on = false;
    this.offsets.headX = this.offsets.headZ = this.offsets.bodyZ = 0;
    this.velocity.headX = this.velocity.headZ = this.velocity.bodyZ = 0;
  }

  getState() {
    return { active: this.on, engine: this.engine.getState(), beat: this.beat.getState(), shown: this.shownShare, headX: this.offsets.headX, headZ: this.offsets.headZ, bodyZ: this.offsets.bodyZ };
  }
}
