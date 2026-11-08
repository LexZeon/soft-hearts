// I-047 陪看要及时: the "talking about the show" window (docs/claude/2026-11-07-watch-timely.md). Opened by a local ask match or by haiku's
// `transcript` judgment, renewed by each new trigger, closed by a refusal, 一起听 going off, another character or conversation, the user's
// clear, or quit. It holds, in memory only, who it is for, when it ends and the latest haiku summary of the show. Never saved, never
// logged (counts only). `epoch` moves on every close so a turn composed earlier can tell its block went.

import { WATCH_TIMELY_KNOBS, type WatchTimelyKnobs } from '../../shared/watch-timely';

export class WatchWindow {
  epoch = 0;
  readonly stats = { opened: 0, renewed: 0, closed: 0, blocks: 0, blockChars: 0, summaries: 0 };
  private state: { characterId: string; scope: string; until: number; summary: { text: string; at: number } | null } | null = null;
  private readonly knobs: Pick<WatchTimelyKnobs, 'windowMs' | 'summaryMaxAgeMs'>;

  constructor(knobs: Partial<WatchTimelyKnobs> = {}) { this.knobs = { ...WATCH_TIMELY_KNOBS, ...knobs }; }

  /** A trigger: opens the window for this character and conversation, or renews it (the summary is kept on a renewal). */
  open(characterId: string, scope: string, now: number): 'open' | 'renew' {
    const same = !!this.state && this.state.characterId === characterId && this.state.scope === scope && this.state.until >= now;
    const summary = same ? this.state!.summary : null;
    if (!same) this.close();
    this.state = { characterId, scope, until: now + Math.max(0, this.knobs.windowMs), summary };
    if (same) { this.stats.renewed++; return 'renew'; }
    this.stats.opened++;
    return 'open';
  }

  /** Is it open for this character and conversation right now? A stale one is closed on the way. */
  isOpen(characterId: string | null, scope: string, now: number): boolean {
    const state = this.state;
    if (!state) return false;
    if (state.characterId !== characterId || state.scope !== scope || now > state.until) { this.close(); return false; }
    return true;
  }

  close(): boolean {
    if (!this.state) return false;
    this.state = null; this.epoch++; this.stats.closed++;
    return true;
  }

  /** haiku's summary of the show (only while the window is open for this turn's character and conversation). */
  setSummary(characterId: string, scope: string, text: string, now: number): boolean {
    const clean = text.trim();
    if (!clean || !this.isOpen(characterId, scope, now)) return false;
    this.state!.summary = { text: clean, at: now };
    this.stats.summaries++;
    return true;
  }

  /** The summary while it is young enough; null otherwise. */
  summary(characterId: string, scope: string, now: number): string | null {
    const state = this.state;
    if (!state || state.characterId !== characterId || state.scope !== scope || !state.summary) return null;
    return now - state.summary.at <= this.knobs.summaryMaxAgeMs ? state.summary.text : null;
  }
}
