// I-178 (docs/claude/2026-11-22-i178-proactive-context.md): the one reader every proactive prompt asks for "what the two of you talked about
// lately". The wirings of the paths that make her speak on her own (一起听 and 系统音频 comments, the screen/camera topic, the inner loop,
// the special-day line) each call this with the parts they already have; it reads her CURRENT conversation scope from the chat memory.
// No module-level side effects: nothing runs until a prompt asks.
import { cardLanguageOf } from '../../shared/cards';
import type { MemoryScope } from '../../shared/memory';
import { proactiveChatReader } from '../brain';

/** The two parts every wiring already holds: the companion (memory and the open scope) and the card manager (who is speaking). */
export interface ProactiveChatParts {
  companion: { currentScope(): MemoryScope; memory: { chatWindowSource(scope: MemoryScope): readonly { role: 'user' | 'assistant'; content: string; createdAt: number; speaker?: 'visitor' }[] } };
  characterCards: { getActive(): Parameters<typeof cardLanguageOf>[0] & { id: string } };
}

/** () => the recent-chat block for the character who is speaking now ('' when there is none). Parts are read when called. */
export function proactiveChatFor(parts: () => ProactiveChatParts | null | undefined, now: () => number = Date.now, audience: 'her' | 'judge' = 'her'): () => string {
  const read = <T>(pick: (p: ProactiveChatParts) => T, fallback: T): T => { const p = parts(); return p ? pick(p) : fallback; };
  return proactiveChatReader({
    rows: scope => read(p => p.companion.memory.chatWindowSource(scope), []),
    scope: () => read(p => p.companion.currentScope(), { characterId: '', providerScope: '' }),
    activeCharacterId: () => read(p => p.characterCards.getActive().id, ''),
    language: () => read(p => cardLanguageOf(p.characterCards.getActive()), 'zh-CN' as const),
    now, audience,
  });
}
