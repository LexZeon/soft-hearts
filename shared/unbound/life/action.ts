/**
 * Unbound v1 step 4: what one of her own actions is (docs/claude/2026-11-17-unbound-step4.md「好加」). An action is one file under
 * actions/ that exports a LifeActionSpec, and one line in registry.ts. The arbiter, the schedule, the cooldowns and the mood reading
 * do not change when one is added; the page plays its key frames with the one player it has (src/unbound/life/player.ts).
 */
import type { LifeSituation } from './arbiter';
import type { LifeDrives, LifeRates } from './mood-read';
import type { LifeCue } from './reactions';
import type { LifeLevel, LifePlan } from './types';
import type { LookSpot } from '../screen-terms';

/**
 * A spot as the user sees it (I-212): across 0..1 of the screen width (her centre), and her size (her height
 * as a share of the usable screen height; shared/unbound/screen-terms converts it to metres for this screen and her height).
 */
export type LifeSpot = LookSpot;

/** What an action may read when it decides and plans (memory only; a fresh one each time). */
export interface LifeContext {
  now: number;
  situation: LifeSituation;
  drives: LifeDrives;
  rates: LifeRates;
  /** Where she stands now (null: not known yet). */
  here: LifeSpot | null;
  /** A spot → her floor (world m), or null when her world is not known yet. */
  toWorld(spot: LifeSpot): { xM: number; depthM: number } | null;
  /** 0..1. */
  random(): number;
  /** 「试一下」 from the developer panel: plan it even when `notNow` would say no. */
  trial: boolean;
  /** The cue this is a reaction to (reactions.ts), or null for her own time. */
  cue: LifeCue | null;
  /** The camera saw you leave and you have not come back: she wanders freely. */
  youLeft: boolean;
  /** I-205b: she chose where to stand in her own reply a little while ago (her-position/keep.ts): her own place changes leave her there. */
  chosenSpotKept?: boolean;
}

/** One plan, and whether you answering it counts (the 'peek-answered' moment: only for coming closer to you). */
export interface LifeChoice { plan: LifePlan; answerable: boolean }

export interface LifeActionSpec {
  readonly id: string;
  /** Her free time only: you and the peek are the arbiter's own levels. */
  readonly level: Exclude<LifeLevel, 'user' | 'peek'>;
  /** Plain words for the developer panel. */
  readonly words: string;
  /** Seconds between two of these at this pace (the schedule draws ×0.6..1.4 around it). */
  interval(rates: LifeRates): number;
  /** Why not now, in plain words (the panel shows it), or null. Asked only when nothing stops her free time as a whole. */
  notNow(context: LifeContext): string | null;
  /** The plan, or null when there is nothing to do (e.g. she already stands where she would go). */
  plan(context: LifeContext): LifeChoice | null;
}
