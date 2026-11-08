/** Host-supplied identifiers; none of these types authorizes an action in a renderer. */
/** `inner`: the inner loop's own short line (docs/claude/2026-11-02-inner-loop.md). */
export type ProactiveSpeechSource = 'vision' | 'ambient' | 'memorial' | 'agent-help' | 'inner';
/** `feed`: her line after the user fed her something she recognized (I-019, electron/feed-recognition/). */
export type ProactiveContentSource = 'screen' | 'camera' | 'ambient' | 'text' | 'inner' | 'feed';

/** Metadata on an actual assistant message. Never manufacture a user message for it. */
export interface ProactiveOrigin {
  kind: 'proactive';
  id: string;
  at: number;
  sources: ProactiveContentSource[];
  /** Bounded display labels for the actual observations; no paths or provider identity. */
  labels: string[];
}

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
