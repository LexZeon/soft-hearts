/**
 * R18 / M1 "她听到了" (docs/claude/2026-11-03-e1-r18-fixes.md). The user (2026-11-03, U-009): with 音频律动 on and music
 * playing, she did not react, "像没听到". Since M1 a calm her only nods (a couple of degrees) and a low one stays still,
 * so the fact that she heard the music was invisible in most moods. This is the one cue every mood gets: when a song
 * becomes audible she lifts her head a little and tilts it, as if listening, then settles back into whatever she decided
 * (nothing, the light nod, or the dance). Not while asleep or with 自动表现 paused (she makes no move of her own then),
 * and never in "让她一直跟着跳" (that is R15, unchanged).
 *
 * It is an offset for procedural life's head tilt (the same `beat` input as the nod, music-nod.ts), so every owner and
 * yield rule of the small motions applies (a pat, a chat gesture, the dance itself, previews) and the clamps bound it.
 * Smoothstep in and out: zero speed at both ends, no step.
 *
 * Its size follows 律动强度 (MusicSettings.strength) like the nod and the dance: the look above is at the default strength,
 * and strength 0 means no musical movement at all, so no look either (Codex T-112 round-019: it kept a fixed 0.035/0.045 rad).
 */
import { DEFAULT_MUSIC_SETTINGS } from '../../shared/music-settings';

export const MUSIC_LISTEN = Object.freeze({ riseS: 0.45, holdS: 0.9, fallS: 0.8, headX: -0.035, headZ: 0.045 });
const smoothstep = (value: number) => { const t = Math.min(1, Math.max(0, value)); return t * t * (3 - 2 * t); };

export interface MusicListenOffsets { headX: number; headZ: number; bodyZ: number }

export class MusicListenCue {
  private t = Infinity;
  private side = 1;
  private cues = 0;
  private readonly out: MusicListenOffsets = { headX: 0, headZ: 0, bodyZ: 0 };

  /** A song just became audible: listen (again from the start if one was still showing). `side` picks the tilt (±1). */
  start(side: number): void { this.t = 0; this.side = side < 0 ? -1 : 1; this.cues++; }
  get active(): boolean { return this.t < MUSIC_LISTEN.riseS + MUSIC_LISTEN.holdS + MUSIC_LISTEN.fallS; }

  /** This frame's offsets at this 律动强度 (0..1; null once it is over: nothing is added). No allocation. */
  frame(deltaSeconds: number, strength: number = DEFAULT_MUSIC_SETTINGS.strength): Readonly<MusicListenOffsets> | null {
    if (!this.active) return null;
    this.t += Number.isFinite(deltaSeconds) ? Math.min(0.1, Math.max(0, deltaSeconds)) : 0;
    const { riseS, holdS, fallS } = MUSIC_LISTEN, t = this.t;
    const scale = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) / DEFAULT_MUSIC_SETTINGS.strength : 1;
    const envelope = (t >= riseS + holdS + fallS ? 0 : smoothstep(t / riseS) * (1 - smoothstep((t - riseS - holdS) / fallS))) * scale;
    this.out.headX = MUSIC_LISTEN.headX * envelope + 0;
    this.out.headZ = MUSIC_LISTEN.headZ * envelope * this.side + 0;
    return this.out;
  }

  reset(): void { this.t = Infinity; this.out.headX = this.out.headZ = 0; }

  getState() { return { active: this.active, cues: this.cues, headX: this.out.headX, headZ: this.out.headZ }; }
}
