import { watchKindOf } from '../shared/behaviors/watch-along/kind';
import type { ScreenActivity } from '../shared/screen-activity';
import type { HerLifeWatchKind } from '../shared/her-life';

/**
 * I-006 第 3 步 "跟着看": what the user is watching or playing, for her own life (shared/her-life.ts, the 「跟着看」 row).
 *
 * Only a category word reaches here: the rough look of electron/screen-glance.ts (a program the table knows, or the small model's one word
 * for a 320×200 thumbnail). Screen sharing off, or the user's "别看" holding: always null, so the row never appears and nothing follows.
 * A developer test command can pretend a kind for a few minutes; it reads no real screen and no real program.
 */
export interface WatchAlongPorts {
  /** Screen sharing is on. */
  sharing(): boolean;
  /** The user said no to looking right now (the same hold the rough reading for chat respects). */
  refused(): boolean;
  /** The rough activity her life follows (ScreenGlance.watching). */
  activity(): ScreenActivity | null;
  clock?(): number;
}

const PRETEND_MS = 10 * 60_000;

export function createWatchAlong(ports: WatchAlongPorts) {
  const clock = () => { try { const value = (ports.clock ?? Date.now)(); return Number.isFinite(value) ? value : Date.now(); } catch { return Date.now(); } };
  let pretended: { kind: HerLifeWatchKind; until: number } | null = null;
  return {
    /** The kind she follows now, or null. */
    kind(): HerLifeWatchKind | null {
      if (pretended && clock() < pretended.until) return pretended.kind;
      pretended = null;
      try { return ports.sharing() && !ports.refused() ? watchKindOf(ports.activity()) : null; } catch { return null; }
    },
    /** Developer test command: pretend a kind for ten minutes (null: stop). Needs no screen sharing, reads no real screen. */
    pretend(kind: HerLifeWatchKind | null): void { pretended = kind ? { kind, until: clock() + PRETEND_MS } : null; },
  };
}
