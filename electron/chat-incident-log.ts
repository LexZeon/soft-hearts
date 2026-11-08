import { sanitizeChatIncident, type ChatIncident } from '../shared/chat-incident';
import { appendBounded } from './reply-latency';

/**
 * Developer-mode log of the times a chat turn ended without a usable reply: one JSON line `{"at":"<time>","category":"<one of
 * refusal | empty | draft-only | error>"}` in `<profile>/dev/chat-incidents.jsonl` (bounded and rotated by appendBounded).
 * Time and category only; never the user's message, the reply, the refusal wording or the error text. The "what just happened"
 * log that is planned collects its records from here.
 */
export interface ChatIncidentLogOptions {
  /** Developer mode, checked per record. */
  enabled(): boolean;
  /** JSON-lines file, or null when no profile directory is ready. */
  file(): string | null;
  wallNow?(): number;
  write?(file: string, line: string): Promise<void>;
}

export class ChatIncidentLog {
  constructor(private readonly options: ChatIncidentLogOptions) {}

  /** True when a line was handed to the writer. Never throws into the chat path. */
  record(category: ChatIncident | null): boolean {
    if (category === null) return false;
    let file: string | null = null;
    try { file = this.options.enabled() ? this.options.file() : null; } catch { return false; }
    const entry = sanitizeChatIncident({ category });
    if (!file || !entry) return false;
    const line = JSON.stringify({ at: new Date(this.options.wallNow?.() ?? Date.now()).toISOString(), category: entry.category });
    void (this.options.write ?? appendBounded)(file, line + '\n').catch(() => {});
    return true;
  }
}

/** The error the host throws when the draft filter left nothing of a reply (see electron/main.ts). */
export class DraftOnlyReplyError extends Error {
  readonly incident = 'draft-only' as const;
  constructor() { super('这条回复被过滤后是空的，已丢弃。'); this.name = 'DraftOnlyReplyError'; }
}
