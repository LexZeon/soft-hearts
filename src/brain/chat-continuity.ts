import type { ChatMessage } from '../../shared/foundation/chat';
import type { RecentChat, RecentChatShown } from '../../shared/memory';
import { trimReplyHistory } from './reply-history';

/**
 * C2/C3 continuity (pretrial fixes 2026-11-03, docs/claude/2026-11-03-pretrial-fixes-continuity.md). When the active
 * character's card changes — updated in place, or another character chosen — the chat window is refilled with the
 * conversation the host says is hers now (electron/brain/companion.ts recentChat, read from the existing chat memory) instead of
 * staying an empty new chat. The window's history is what the next message carries to Claude, so this is also what keeps
 * "the sentence before the update" in the conversation. The refill itself is src/main.ts refillChat (on any change of the
 * active card's identity or persona, the same change that clears the window).
 */

/**
 * The window history from the host's answer. Only for the character the request was made for, and only while she is
 * still the active one (a late answer after another switch fills nothing). Bounded like the window's own history.
 */
export function restoredChatHistory(recent: RecentChat | null | undefined, requestedFor: string | null, activeNow: string | null): ChatMessage[] {
  if (!recent || !requestedFor || recent.characterId !== requestedFor || activeNow !== requestedFor || !Array.isArray(recent.messages)) return [];
  const messages = recent.messages.filter(message => (message?.role === 'user' || message?.role === 'assistant')
    && typeof message.content === 'string' && message.content.trim())
    .map(message => ({ role: message.role, content: message.content }));
  return trimReplyHistory(messages);
}

/**
 * 边说边演: the rows the chat page draws for the same conversation when one of its replies was only a performance (the grey line,
 * `performed`). Null when there is no such reply (the page draws the history as before). Display only: the history above stays what the
 * next message carries to Claude, so the grey line is never her words and never reaches her.
 */
export function restoredChatRows(recent: RecentChat | null | undefined, requestedFor: string | null, activeNow: string | null): RecentChatShown[] | null {
  if (!recent || !requestedFor || recent.characterId !== requestedFor || activeNow !== requestedFor) return null;
  return cleanChatRows(recent.shown);
}

/** The rows as the page may draw them (also what the other window sends along): known roles, text only, bounded; null when no row is a grey line. */
export function cleanChatRows(value: unknown): RecentChatShown[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter(row => (row?.role === 'user' || row?.role === 'assistant') && typeof row.content === 'string' && row.content.trim())
    .map(row => ({ role: row.role as 'user' | 'assistant', content: row.content as string, ...(row.role === 'assistant' && row.performed === true ? { performed: true as const } : {}),
      ...(row.role === 'assistant' && cleanRowCut(row.cut, row.content) ? { cut: cleanRowCut(row.cut, row.content)! } : {}) })); // 2026-11-23: the quiet marker of a cut reply
  return rows.some(row => row.performed || row.cut) ? rows.slice(-24) : null;
}

/** The cut marker of a row as the page may draw it: where it sits in the text (clamped) and its fixed words (bounded); null when it is not one. */
export function cleanRowCut(value: unknown, content: unknown): { at: number; label: string } | null {
  const v = value as { at?: unknown; label?: unknown } | null;
  if (!v || typeof content !== 'string' || typeof v.at !== 'number' || !Number.isFinite(v.at) || typeof v.label !== 'string' || !v.label.trim()) return null;
  return { at: Math.max(0, Math.min(content.length, Math.floor(v.at))), label: v.label.trim().slice(0, 80) };
}
