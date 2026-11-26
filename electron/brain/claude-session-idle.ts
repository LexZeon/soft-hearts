/**
 * When an idle conversation process is closed (electron/brain/claude-session.ts scheduleIdle), as a pure rule.
 *
 * Seen: the ordinary idle limit (CLAUDE_SESSION_IDLE_MS, 10 minutes), closed as 'idle'. Not seen: the shorter hidden limit (3 minutes),
 * closed as 'hidden'. She is seen when her companion window is shown, or when something else shows her although that window is hidden:
 * out in full-screen Unbound the companion window is hidden on purpose while she is on screen (`seenElsewhere`, the wiring reads
 * electron/wiring/stage-window-wiring.ts herOnScreen). 2026-11-21: the 'hidden' close applied while she was out, so the next reply
 * started a cold process (first character 27.5 s; docs/claude/2026-11-21-warm-reuse-diverged.md).
 */
export interface SessionIdleInput {
  /** The companion window is shown and not minimised (PersistentClaudeChat.noteVisible). */
  visible: boolean;
  /** She is on screen elsewhere (full-screen Unbound) while that window is hidden; a throwing reader counts as not seen. */
  seenElsewhere?: (() => boolean) | null;
  idleMs: number;
  hiddenIdleMs: number;
}

export function sessionIdleRule(input: SessionIdleInput): { ms: number; reason: 'idle' | 'hidden' } {
  let seen = input.visible;
  if (!seen && input.seenElsewhere) { try { seen = input.seenElsewhere() === true; } catch { seen = false; } }
  return seen ? { ms: input.idleMs, reason: 'idle' } : { ms: input.hiddenIdleMs, reason: 'hidden' };
}
