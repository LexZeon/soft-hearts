import { sanitizeInnerLoopDiagnostic, type InnerLoopDiagnostic } from '../../shared/inner-loop';
import { appendBounded } from '../reply-latency';

const RECENT = 20;

/**
 * Developer-mode only: one JSON line per inner-loop opportunity in `<profile>/dev/inner-loop.jsonl`
 * (bounded, rotated by appendBounded) and the last 20 for the mood panel. Categories, timings and
 * token/cost counts only; never prompt, model output or the spoken line.
 */
export class InnerLoopDiagnostics {
  private readonly entries: InnerLoopDiagnostic[] = [];
  constructor(private readonly options: {
    enabled(): boolean;
    file(): string | null;
    write?: (file: string, line: string) => Promise<void>;
    changed?: () => void;
  }) {}

  record(value: InnerLoopDiagnostic): void {
    let enabled = false;
    try { enabled = this.options.enabled() === true; } catch { enabled = false; }
    if (!enabled) return;
    const entry = sanitizeInnerLoopDiagnostic(value);
    if (!entry) return;
    this.entries.push(entry);
    while (this.entries.length > RECENT) this.entries.shift();
    let file: string | null = null;
    try { file = this.options.file(); } catch { file = null; }
    if (file) void (this.options.write ?? appendBounded)(file, JSON.stringify(entry) + '\n').catch(() => {});
    try { this.options.changed?.(); } catch { /* A closed panel just misses this update. */ }
  }

  recent(): InnerLoopDiagnostic[] { return this.entries.map(entry => ({ ...entry })); }
}
