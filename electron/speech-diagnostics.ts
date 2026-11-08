import { validateSpeechDiagnosticRecord } from '../shared/speech-diagnostics';
import { appendBounded } from './reply-latency';

/**
 * R02 developer-mode speech timing log (same gate as electron/reply-latency.ts).
 * Accepts only strictly validated renderer records: timings, counts, provider,
 * voice ID and text length. Nothing is kept or written outside developer mode.
 */
export interface SpeechDiagnosticsLogOptions {
  /** Developer mode, checked per record. */
  enabled(): boolean;
  /** JSON-lines file, or null when no profile directory is ready. */
  file(): string | null;
  now?(): number;
  wallNow?(): number;
  write?(file: string, line: string): Promise<void>;
}

/** A misbehaving renderer cannot flood the log: at most this many records per minute. */
export const SPEECH_DIAGNOSTICS_PER_MINUTE = 240;

export class SpeechDiagnosticsLog {
  private window = { start: -Infinity, count: 0 };
  constructor(private readonly options: SpeechDiagnosticsLogOptions) {}

  /** True when the record was accepted for writing. Never throws into the IPC caller. */
  record(value: unknown): boolean {
    let enabled = false, file: string | null = null;
    try { enabled = this.options.enabled(); file = enabled ? this.options.file() : null; } catch { return false; }
    if (!enabled || !file) return false;
    const record = validateSpeechDiagnosticRecord(value);
    if (!record) return false;
    const now = this.options.now?.() ?? performance.now();
    if (now - this.window.start >= 60_000) this.window = { start: now, count: 0 };
    if (++this.window.count > SPEECH_DIAGNOSTICS_PER_MINUTE) return false;
    const line = JSON.stringify({ at: new Date(this.options.wallNow?.() ?? Date.now()).toISOString(), ...record });
    void (this.options.write ?? appendBounded)(file, line + '\n').catch(() => {});
    return true;
  }
}
