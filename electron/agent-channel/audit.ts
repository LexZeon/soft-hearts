import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAuditEntry } from './registry';

const MAX_LOG_BYTES = 256 * 1024;
const OUTCOMES = new Set(['allowed', 'denied', 'failed', 'invalid']);
const TIERS = new Set(['read', 'reversible', 'confirm', 'never', 'none']);

/**
 * One JSON line per call in `<profile>/dev/agent-channel-audit.jsonl`. Only the tool name,
 * tier, outcome, error code and duration are written: never arguments, paths, results,
 * tokens or chat text. Rotates once at 256 KB like the reply-latency log.
 */
export class AgentAuditLog {
  private queue: Promise<void> = Promise.resolve();
  readonly file: string;
  constructor(profileDirectory: string, private readonly write: (file: string, line: string) => Promise<void> = appendBounded) {
    this.file = path.join(profileDirectory, 'dev', 'agent-channel-audit.jsonl');
  }

  record(entry: AgentAuditEntry): void {
    const line = JSON.stringify(sanitizeAuditEntry(entry)) + '\n';
    this.queue = this.queue.then(() => this.write(this.file, line)).catch(() => { /* Audit is best effort. */ });
  }

  /** Resolves once queued lines are written (tests and shutdown). */
  flush(): Promise<void> { return this.queue; }
}

export function sanitizeAuditEntry(entry: AgentAuditEntry): AgentAuditEntry {
  const tool = typeof entry.tool === 'string' && /^(?:[a-z][a-z0-9_]{0,63}|\(auth\))$/.test(entry.tool) ? entry.tool : 'unknown';
  return {
    at: typeof entry.at === 'string' && entry.at.length <= 40 ? entry.at : new Date().toISOString(),
    tool,
    tier: TIERS.has(entry.tier) ? entry.tier : 'none',
    outcome: OUTCOMES.has(entry.outcome) ? entry.outcome : 'failed',
    ...(entry.code && /^[a-z_]{1,32}$/.test(entry.code) ? { code: entry.code } : {}),
    // I-014: how a confirm-tier call was approved (the user's click, or 三方互通 being on); I-025: the user's own words, length only.
    ...(entry.approval === 'dialog' || entry.approval === 'interconnect' || entry.approval === 'user-words' ? { approval: entry.approval } : {}),
    ...(entry.approval === 'user-words' && Number.isSafeInteger(entry.words) && entry.words! >= 0 ? { words: Math.min(entry.words!, 100_000) } : {}),
    ms: Number.isFinite(entry.ms) ? Math.max(0, Math.round(entry.ms)) : 0,
  };
}

async function appendBounded(file: string, line: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  try { if ((await stat(file)).size > MAX_LOG_BYTES) await rename(file, file.replace(/\.jsonl$/u, '') + '.old.jsonl'); } catch { /* New log. */ }
  await appendFile(file, line, 'utf8');
}
