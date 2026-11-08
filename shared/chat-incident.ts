// What kind of "no usable reply" a chat turn ended in, for the developer-mode incident log and for the places that decide
// how quietly to fail. Categories only: nothing in here can carry what was asked, answered or refused.

/**
 * refusal    the model stopped the reply itself (Claude Code's `refusal` stop reason, or its usage-policy notice)
 * empty      Claude Code finished and returned no text
 * draft-only the reply was nothing but internal draft and the draft filter (electron/reply-draft-guard.ts) removed it all
 * error      anything else that failed (limits, login, network, a crashed process, ...)
 */
export const CHAT_INCIDENTS = ['refusal', 'empty', 'draft-only', 'error'] as const;
export type ChatIncident = typeof CHAT_INCIDENTS[number];
/** The incidents an error object can carry itself (set where the error is made). */
export type ReplyIncident = Exclude<ChatIncident, 'error'>;

/**
 * The category of a chat error, or null when it is not an incident at all: the conversation changed under the turn
 * (`closed`), which is the app's own doing and not a problem with the reply.
 */
export function incidentOf(error: unknown): ChatIncident | null {
  if (!error || typeof error !== 'object') return 'error';
  const { incident, kind } = error as { incident?: unknown; kind?: unknown };
  if (kind === 'closed') return null;
  return incident === 'refusal' || incident === 'empty' || incident === 'draft-only' ? incident : 'error';
}

/** Whitelist copy of a log record: any other field is dropped, anything but a known category is refused. */
export function sanitizeChatIncident(value: unknown): { category: ChatIncident } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const category = (value as { category?: unknown }).category;
  return (CHAT_INCIDENTS as readonly unknown[]).includes(category) ? { category: category as ChatIncident } : null;
}
