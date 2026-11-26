/**
 * Unbound showcase: the page's only window to its host (scripts/unbound/showcase-preload.ts exposes it; the host is
 * scripts/unbound/showcase-main.ts). Showcase and preview only: the app never loads this page.
 */
import type { ShowcaseBeat } from '../../../shared/unbound/showcase';
import type { UnboundWorld } from '../../../shared/unbound/scene';
import type { IdleModelWeights } from '../motion/idle-model';
import type { IdleEventLibrary } from '../motion/idle-events';

export interface ShowcasePlan {
  mode: 'record' | 'live';
  modelUrl: string; standUrl: string;
  world: UnboundWorld;
  /** Where she stands (m behind the screen) and across. */
  depthM: number; xM: number;
  liveliness: number; seed: number;
  /** Seconds of her own world before the performance (recording: before the camera rolls). */
  prerollS: number;
  /** Hard cap (s) from the page's start. */
  capS: number;
  physics: boolean;
  /** Before the first beat: in her own world (live: covers the wait for Claude) or just standing, looking at you (record). */
  opening: 'away' | 'standing';
  /** 'warm' (the showcase's own light: a warm key, a soft rim, deeper shadows) or 'stage' (the companion's lights, for comparison). */
  lighting: 'night' | 'night3' | 'warm' | 'stage';
  /** Record: soft background colors (top, bottom); live: transparent. */
  background: [string, string] | null;
  /** Stills to take (performance seconds). */
  stills: number[];
  /**
   * Round 7: the learned idle under quiet holds and her own world (null: off). The trained weights and quick-move library as the
   * host read them from .local/ml (missing: null, and the page falls back to the procedural idle).
   */
  idle: { weights: IdleModelWeights | null; events: IdleEventLibrary | null } | null;
}
export interface ShowcaseApi {
  plan(): Promise<ShowcasePlan>;
  onSegment(listener: (beats: ShowcaseBeat[]) => void): void;
  /** No more segments are coming (the host gave up on Claude or both are in). */
  onNoMore(listener: () => void): void;
  ready(): Promise<void>;
  chunk(data: ArrayBuffer): Promise<void>;
  still(name: string): Promise<void>;
  log(entry: unknown): void;
  /** Development: a picture the page composed itself (a contact sheet), as a PNG data URL. */
  saveImage(name: string, dataUrl: string): Promise<void>;
  done(result: unknown): Promise<void>;
}
declare global { interface Window { showcase?: ShowcaseApi } }
