// I-178 (docs/claude/2026-11-22-i178-proactive-context.md): the host reader behind every proactive prompt's recent-chat block. It reads
// her CURRENT conversation scope from the existing chat memory (nothing new is stored), hands the rows to the pure block builder
// (shared/foundation/proactive-context.ts) together with the character who is about to speak, and gives back one string ('' when there is
// no chat, or when anything goes wrong: a proactive line never waits on or fails because of this).
import type { MemoryScope } from '../../shared/memory';
import type { CardLanguage } from '../../shared/foundation/character-card';
import { proactiveChatBlock, type ProactiveChatRow } from '../../shared/foundation/proactive-context';

export interface ProactiveChatReaderDeps {
  /** companion.memory.chatWindowSource: the scope's finished turns and her own lines, oldest first, text only. */
  rows(scope: MemoryScope): readonly ProactiveChatRow[];
  /** companion.currentScope(): whose conversation is open right now. */
  scope(): MemoryScope;
  /** The character who is speaking (the active card), read separately from the scope so a switch in between yields nothing. */
  activeCharacterId(): string;
  language?(): CardLanguage;
  now?(): number;
  /** I-205: 'judge' for the small deciders (reaction, mood, pause-talk): third-person wording; the same rows, caps and character check. */
  audience?: 'her' | 'judge';
}

/** () => the block text for this moment. Safe to call from any proactive path. */
export function proactiveChatReader(deps: ProactiveChatReaderDeps): () => string {
  return () => {
    try {
      const scope = deps.scope(), language = (() => { try { return deps.language?.() ?? 'zh-CN'; } catch { return 'zh-CN' as const; } })();
      return proactiveChatBlock({ characterId: scope.characterId, rows: deps.rows(scope) }, deps.activeCharacterId(), (deps.now ?? Date.now)(), language, deps.audience);
    } catch { return ''; }
  };
}
