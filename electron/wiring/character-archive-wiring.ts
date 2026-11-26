// I-208 角色档案: the live end of the archive page's one read-only call (electron/memory/archive/ holds the reading and takes ports; docs/claude/2026-11-24-i208-archive-step1.md).
// The call arrives from the control window only (`getCharacterArchive`, a character id and search words, nothing else). The reader is made on the first call, from
// the live stores the memory wiring was given. Nothing here writes, and nothing here is read by a prompt. No module-level side effects.
import { CharacterArchiveReader } from '../memory';
import { characterProviderScopes, forgettableProviderScopes } from '../cards';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import type { PartIpc } from './ipc-wiring';
import type { MemoryNeeds } from './memory-wiring';

export function registerCharacterArchive(ipc: PartIpc, needs: Pick<MemoryNeeds, 'store' | 'companion' | 'characterCards'>): void {
  let reader: CharacterArchiveReader | null = null;
  const made = (): CharacterArchiveReader => reader ??= new CharacterArchiveReader({
    profileDirectory: needs.store.directory,
    card: id => needs.characterCards.publicState().cards.find(card => card.id === id),
    providerScopes: id => characterProviderScopes(id, forgettableProviderScopes(needs.store.current.provider, memoryProviderScope), characterId => needs.companion.memory.providerScopesOf(characterId)),
    noteScope: scope => needs.companion.memory.noteScope(scope),
    noteSegments: now => needs.companion.memory.noteSegments(now),
    relationship: id => needs.companion.relationship.snapshot(id),
    now: () => Date.now(),
  });
  ipc.host('getCharacterArchive', (request: unknown) => made().read(request));
}
