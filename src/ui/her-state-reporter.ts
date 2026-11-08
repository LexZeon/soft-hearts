/**
 * I-017 (docs/claude/2026-11-03-her-state-line.md): the pet window tells the host what her body is doing to the sound, so the next
 * chat turn's perception line can say it. One value and one flag (shared/her-state.ts StageStateReport), sent when it changes and
 * at least every STAGE_STATE_HEARTBEAT_MS; the host drops anything older than its TTL, out of order or from a replaced page load.
 *
 * I-016 (docs/claude/2026-11-03-listen-kind.md): plus the stage's "像音乐" score (`beat`, 0..1) when the stage gives one; a move of
 * HER_STATE_BEAT_STEP or more counts as a change, so the host's 30–60 s judgement sees it within a second without a report per frame.
 */
import type { StageMusicState, StageStateReport } from '../../shared/her-state';

export const HER_STATE_REPORT_HEARTBEAT_MS = 5_000;
export const HER_STATE_REPORT_CHECK_MS = 1_000;
export const HER_STATE_BEAT_STEP = 0.1;

type StageRead = { music: StageMusicState; always: boolean; beat?: number };

export interface HerStateReporterOptions {
  read(): StageRead;
  send(report: StageStateReport): Promise<unknown> | unknown;
  now?(): number;
  /** One id per page load (crypto.randomUUID in the window). */
  instance?: string;
}

const beatOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 : undefined;

export class HerStateReporter {
  private seq = 0;
  private last: StageRead | null = null;
  private lastAt = -Infinity;
  private readonly instance: string;
  private readonly now: () => number;
  constructor(private readonly options: HerStateReporterOptions) {
    this.instance = options.instance ?? globalThis.crypto.randomUUID();
    this.now = options.now ?? Date.now;
  }

  /** Called every HER_STATE_REPORT_CHECK_MS; sends on a change or when the heartbeat is due. True when it sent. */
  tick(): boolean {
    let state: StageRead;
    try { state = this.options.read(); } catch { return false; }
    const now = this.now(), beat = beatOf(state.beat);
    const moved = beat !== undefined && (this.last?.beat === undefined || Math.abs(beat - this.last.beat) >= HER_STATE_BEAT_STEP - 1e-9);
    const changed = !this.last || this.last.music !== state.music || this.last.always !== state.always || moved;
    if (!changed && now - this.lastAt < HER_STATE_REPORT_HEARTBEAT_MS) return false;
    this.last = { music: state.music, always: state.always, ...(beat !== undefined ? { beat } : {}) }; this.lastAt = now;
    const report: StageStateReport = { instance: this.instance, seq: ++this.seq, music: state.music, always: state.always === true, ...(beat !== undefined ? { beat } : {}) };
    try { void Promise.resolve(this.options.send(report)).catch(() => {}); } catch { /* A report never changes what she does. */ }
    return true;
  }
}
