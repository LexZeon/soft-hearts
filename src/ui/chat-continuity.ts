import type { ChatMessage } from '../../shared/contracts';
import type { RecentChat } from '../../shared/memory';
import { trimReplyHistory } from './reply-history';

/**
 * C2/C3 continuity (pretrial fixes 2026-11-03, docs/claude/2026-11-03-pretrial-fixes-continuity.md). When the active
 * character's card changes — updated in place, or another character chosen — the chat window is refilled with the
 * conversation the host says is hers now (electron/companion.ts recentChat, read from the existing chat memory) instead of
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
