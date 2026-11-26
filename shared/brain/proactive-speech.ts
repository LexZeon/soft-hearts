/** Host-supplied identifiers; none of these types authorizes an action in a renderer. */
/** `inner`: the inner loop's own short line (docs/claude/2026-11-02-inner-loop.md). */
export type ProactiveSpeechSource = 'vision' | 'ambient' | 'memorial' | 'agent-help' | 'inner';
// ProactiveContentSource and ProactiveOrigin (on a chat message) live in shared/foundation/chat.ts (2026-11-16).
import type { ProactiveContentSource, ProactiveOrigin } from '../foundation/chat';
export type { ProactiveContentSource, ProactiveOrigin };

/** An already accepted MoodHost speech opportunity, supplied only by the host. */
export interface ProactiveSpeechOpportunity {
  scope: string;
  opportunityId: string;
  /** Frozen request deadline, not the short expression cue's visual lifetime. */
  expiresAt: number;
}

export interface ProactiveSpeechLease {
  readonly id: string;
  readonly source: ProactiveSpeechSource;
  readonly signal: AbortSignal;
  /** Commit only after the owning UI acknowledges appending the offered line; late acknowledgements fail closed. */
  commit(): boolean;
  /** Cancellation consumes this opportunity; callers must not retry it. */
  cancel(): void;
}

export const PROACTIVE_REQUEST_LIMIT_MS = 120_000;
export const PROACTIVE_RECENT_OPPORTUNITIES = 128;
