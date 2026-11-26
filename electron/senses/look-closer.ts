import { TEXT_FIRST_KNOBS, type TextFirstKnobs } from '../../shared/brain';
import { curiousCloserLook, type WatchSight } from '../../shared/brain';
import { riseAboveBaseline } from '../../shared/initiative';
import type { MoodView } from '../../shared/mood';
import { selfLookMood } from '../initiative/self-look/wiring';

/** D 好奇 above the card's baseline (0–1) from her mood view, read the way her own look reads it; null: no mood yet. */
export function curiosityFrom(view: MoodView | null): number | null {
  const mood = selfLookMood(view);
  return mood ? riseAboveBaseline(mood, 'D') : null;
}

export interface CloserLookPorts {
  /** D 好奇 above the card's baseline, 0–1 (shared/initiative/self-look.ts riseAboveBaseline); null: not known. */
  curiosity(): number | null;
  /** The latest description of 和她一起看 (electron/senses/watch-notes/session.ts sight); null: none yet. */
  sight(): WatchSight | null;
  clock?: () => number;
  knobs?: TextFirstKnobs;
}

/**
 * I-085 第 3 步: her own closer look at the shared screen while watching together (shared/brain/text-first.ts curiousCloserLook decides).
 * `claim` is asked by electron/senses/look-attachments.ts only for an ordinary message of 和她一起看 with no "别看" in force and nothing asked;
 * a yes counts as her look right then (a frame that then fails still counts: no retry loop), so there is at most one per `cooldownMs`.
 * Memory only: the time of her last closer look.
 */
export class CloserLook {
  private lastAt: number | null = null;
  readonly stats = { asked: 0, claimed: 0 };
  constructor(private readonly ports: CloserLookPorts) {}

  claim(): boolean {
    this.stats.asked++;
    const now = (this.ports.clock ?? Date.now)();
    let curiosity: number | null = null, sight: WatchSight | null = null;
    try { curiosity = this.ports.curiosity(); } catch { curiosity = null; }
    try { sight = this.ports.sight(); } catch { sight = null; }
    if (!curiousCloserLook({ curiosity, sight, now, lastAt: this.lastAt }, this.ports.knobs ?? TEXT_FIRST_KNOBS)) return false;
    this.lastAt = now;
    this.stats.claimed++;
    return true;
  }
}
