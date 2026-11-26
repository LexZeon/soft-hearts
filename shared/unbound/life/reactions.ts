/**
 * Unbound v1 step 4, afternoon addition A: what she notices you do, from the signals already on, and how she
 * answers it with the motions she already has (docs/claude/2026-11-17-unbound-step4.md「她注意到你」):
 *
 *   you leave (the camera sees nobody for a while)    → she wanders freely (changing place more often, anywhere)
 *   you come back (after at least a minute away)       → she walks a little closer and glances at you: a welcome
 *   you face her                                       → she looks back (I-081's gaze attention; the arbiter owns her gaze)
 *   you wave                                           → she turns and looks at you
 *   you lean back or slump                             → she relaxes and moves less
 *   you stretch                                        → only a glance (her own stretch is batch 2)
 *   you talk to someone else, or the computer plays    → quieter, no peek
 *
 * Confidence (pose-read.ts): sure → she reacts and it may be told as a fact; maybe → only a glance, told with "好像"; unsure → as if
 * not seen. Pure; the host feeds it once a second. Each cue is also what the interaction history records (kinds and counts only).
 */
import type { LifeDrives } from './mood-read';
import type { ConfidenceBand } from './pose-read';
import type { LifeSignals } from './signals';

export type LifeCueKind = 'left' | 'came-back' | 'facing' | 'wave' | 'stretch' | 'leaned-back';
export interface LifeCue {
  kind: LifeCueKind;
  /** How sure (presence has no band of its own: the camera's present is taken as sure). */
  band: Exclude<ConfidenceBand, 'unsure'>;
  at: number;
  /** came-back: how long you were away (ms). */
  awayMs?: number;
}

export const REACTION_TIMING = Object.freeze({
  /** Nobody in front this long: you left. */
  leftAfterMs: 30_000,
  /** Away at least this long before coming back counts as a return (a welcome). */
  backAfterMs: 60_000,
  /** Facing her (sure) this long: you face her (one cue per time you turn to her). */
  facingMs: 3_000,
  /** Leaning back or slumped (sure) this long. */
  postureMs: 10_000,
  /** One wave / stretch cue at most this often (ms). */
  eventGapMs: 8_000,
  /** A reaction still counts this long after its cue (ms): after that she lets it go. */
  freshMs: 45_000,
});

/** Turns the once-a-second signals into cues (memory only). */
export class PresenceTracker {
  private presentSince: number | null = null;
  private absentSince: number | null = null;
  private leftTold = false;
  private facingSince: number | null = null;
  private facingTold = false;
  private postureSince: number | null = null;
  private postureTold = false;
  private lastEvent: Partial<Record<'wave' | 'stretch', number>> = {};
  /** You left a while ago and have not come back (she wanders). */
  get away(): boolean { return this.leftTold; }

  update(signals: LifeSignals, now: number): LifeCue[] {
    const cues: LifeCue[] = [], pose = signals.pose;
    if (!pose) { this.reset(); return cues; }
    if (!pose.present) {
      this.presentSince = null; this.facingSince = null; this.facingTold = false; this.postureSince = null; this.postureTold = false;
      this.absentSince ??= now;
      if (!this.leftTold && now - this.absentSince >= REACTION_TIMING.leftAfterMs) { this.leftTold = true; cues.push({ kind: 'left', band: 'sure', at: now }); }
      return cues;
    }
    if (this.presentSince === null) {
      const awayMs = this.absentSince !== null ? now - this.absentSince : 0;
      if (this.leftTold && awayMs >= REACTION_TIMING.backAfterMs) cues.push({ kind: 'came-back', band: 'sure', at: now, awayMs });
      this.presentSince = now; this.absentSince = null; this.leftTold = false;
    }
    const facing = pose.facing;
    if (facing && facing.value === 'toward' && facing.band !== 'unsure') {
      this.facingSince ??= now;
      if (!this.facingTold && now - this.facingSince >= REACTION_TIMING.facingMs) { this.facingTold = true; cues.push({ kind: 'facing', band: facing.band, at: now }); }
    } else { this.facingSince = null; this.facingTold = false; }
    const posture = pose.posture;
    if (posture && (posture.value === 'leaning-back' || posture.value === 'slumped') && posture.band === 'sure') {
      this.postureSince ??= now;
      if (!this.postureTold && now - this.postureSince >= REACTION_TIMING.postureMs) { this.postureTold = true; cues.push({ kind: 'leaned-back', band: 'sure', at: now }); }
    } else { this.postureSince = null; this.postureTold = false; }
    for (const kind of ['wave', 'stretch'] as const) {
      const band = pose[kind];
      if (band !== 'sure' && band !== 'maybe') continue;
      const last = this.lastEvent[kind];
      if (last !== undefined && now - last < REACTION_TIMING.eventGapMs) continue;
      this.lastEvent[kind] = now;
      cues.push({ kind, band, at: now });
    }
    return cues;
  }

  /** The camera stopped (or she went in): nothing carries over. */
  reset(): void {
    this.presentSince = this.absentSince = this.facingSince = this.postureSince = null;
    this.leftTold = this.facingTold = this.postureTold = false;
  }
}

/** Leaning back (sure) and quiet surroundings set her pace: relaxed → less energy; you talking to someone or sound playing → quieter. */
export function temperDrives(drives: LifeDrives, signals: LifeSignals): LifeDrives {
  const posture = signals.pose?.posture;
  const relaxed = !!posture && posture.band === 'sure' && (posture.value === 'leaning-back' || posture.value === 'slumped');
  const quieter = signals.talkingToOthers || signals.soundPlaying;
  if (!relaxed && !quieter) return drives;
  const energy = Math.max(0, drives.energy - (relaxed ? 0.2 : 0) - (quieter ? 0.25 : 0));
  return { ...drives, energy, amplitude: Math.max(0.5, drives.amplitude - (quieter ? 0.15 : 0)) };
}

/** What a cue asks her body to do (the arbiter still decides when): action ids from the registry, in order. */
export function reactionFor(cue: LifeCue): readonly string[] {
  switch (cue.kind) {
    case 'came-back': return ['place', 'glance'];
    case 'wave': case 'stretch': return ['glance'];
    case 'facing': return cue.band === 'maybe' ? ['glance'] : []; // sure: she looks back through her gaze (no action)
    case 'left': case 'leaned-back': return [];
  }
}

export const CUE_WORDS: Readonly<Record<LifeCueKind, string>> = Object.freeze({
  left: '你走开了', 'came-back': '你回来了', facing: '你看着她', wave: '你挥手', stretch: '你伸懒腰', 'leaned-back': '你往后靠着',
});
