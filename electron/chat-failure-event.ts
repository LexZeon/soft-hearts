import type { StreamEvent } from '../shared/contracts';
import type { ChatOutageNotice } from '../shared/chat-availability';
import { incidentOf, type ChatIncident } from '../shared/chat-incident';

/**
 * The event that tells a window a task failed (the catch of `launchTask` in electron/main.ts).
 *
 * A failed chat turn that is not the user's own stop gets `outage` when the availability tracker has a notice for it
 * (electron/chat-availability.ts): the window then shows her line, or nothing when she has already said it, and never the
 * technical `text`. The same moment is noted for the developer-mode incident log, as a category only.
 */
export function chatFailureEvent(input: {
  id: string;
  kind: 'chat' | 'agent';
  error: unknown;
  /** The user (or a context change) stopped the task: not a failure of the reply. */
  aborted: boolean;
  availability: { notice(error: unknown): ChatOutageNotice | undefined };
  incidents?: { record(category: ChatIncident | null): boolean };
}): StreamEvent {
  const { id, kind, error, aborted } = input;
  const chat = kind === 'chat' && !aborted;
  if (chat) { try { input.incidents?.record(incidentOf(error)); } catch { /* A log never changes what the user sees. */ } }
  const outage = chat ? input.availability.notice(error) : undefined;
  const text = aborted ? '已停止。' : error instanceof Error ? error.message : '操作失败。';
  return { id, kind, type: 'error', text, ...(outage ? { outage } : {}) };
}
