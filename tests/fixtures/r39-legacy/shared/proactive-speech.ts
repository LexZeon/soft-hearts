/** Host-supplied identifiers; none of these types authorizes an action in a renderer. */
export type ProactiveSpeechSource = 'vision' | 'ambient';
export type ProactiveContentSource = 'screen' | 'camera' | 'ambient';

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
