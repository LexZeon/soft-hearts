// I-134 new chat: the host's wiring of the window builder (electron/brain/long-chat/window.ts) to her archives, kept out of electron/main.ts.
import type { ChatMessage } from '../../../shared/foundation/chat';
import type { MemoryScope } from '../../../shared/memory';
import type { LongChatKnobs } from '../../../shared/behaviors/long-chat/knobs';
import { buildLongChatWindow, type LongChatLabels, type LongChatSourceMessage } from './window';

/** The two journals her words live in: the chat memory (ordinary chat and her own lines) and the text-invitations journal. */
export interface LongChatArchive {
  chatWindowSource(scope: MemoryScope, excludeTurnId?: string): LongChatSourceMessage[];
}

export interface LongChatMessagesInput {
  knobs: LongChatKnobs | null | undefined;
  archives: readonly (LongChatArchive | null | undefined)[];
  scope: MemoryScope;
  /** The turn being answered: left out of the archive part, and given as `current`. */
  turnId?: string;
  current: { content: string; createdAt?: number | null | (() => number | null | undefined) };
  now?: number;
  /** I-139: the window's labels while the switch is on (electron/brain/long-chat/window.ts LongChatLabels). Absent: as before. */
  labels?: LongChatLabels | null;
  /** The card's language (I-071): an English card's replies stay in the window (window.ts LongChatWindowInput.language). Absent: Chinese. */
  language?: string | null;
}

/**
 * `[...window, current]` for a session or the per-message prompt, or null when new chat is off or her archive cannot be read
 * right now (the caller then uses the renderer's window, as before). Never throws into the chat path.
 */
export function longChatMessages(input: LongChatMessagesInput): ChatMessage[] | null {
  if (!input.knobs?.enabled) return null;
  try {
    const now = input.now ?? Date.now();
    const messages = input.archives.flatMap(archive => archive ? archive.chatWindowSource(input.scope, input.turnId) : []);
    const window = buildLongChatWindow({ messages, now, knobs: input.knobs, self: input.scope.characterId, ...(input.labels ? { labels: input.labels } : {}), ...(input.language ? { language: input.language } : {}),
      current: { content: input.current.content, createdAt: (typeof input.current.createdAt === 'function' ? input.current.createdAt() : input.current.createdAt) ?? now } });
    return window.current ? [...window.history, window.current] : null;
  } catch { return null; }
}

/** The window alone, for a voice utterance whose own message is added leg by leg (electron/voice/voice-chat-host.ts). Same nulls as above. */
export function longChatHistory(input: Omit<LongChatMessagesInput, 'current'>): ChatMessage[] | null {
  if (!input.knobs?.enabled) return null;
  try {
    const messages = input.archives.flatMap(archive => archive ? archive.chatWindowSource(input.scope, input.turnId) : []);
    return buildLongChatWindow({ messages, now: input.now ?? Date.now(), knobs: input.knobs, self: input.scope.characterId, ...(input.labels ? { labels: input.labels } : {}), ...(input.language ? { language: input.language } : {}) }).history;
  } catch { return null; }
}
