// C2 删除角色: deleting a card deletes only the card by default; her memories
// stay. The confirmation has an unticked "同时删除她的记忆"; ticked, this removes what she remembers of the user:
// chat memory, the profile with her diary, familiarity and nickname, and G1's match counts. Text memorials (each
// one saved with the user's own yes) and her own mood state are not touched.
import type { ProviderConfig } from '../shared/contracts';
import type { MemoryScope } from '../shared/memory';

/** The chat connections a character's memories may sit under (memory and profile are per connection). */
export function forgettableProviderScopes(current: ProviderConfig, scopeOf: (provider: ProviderConfig) => string): string[] {
  // The Claude fork's connection differs only by the model name the user typed; the usual aliases are covered too.
  const models = new Set(['', 'haiku', 'sonnet', 'opus', current.model]);
  const scopes = new Set<string>([scopeOf(current)]);
  for (const model of models) scopes.add(scopeOf({ ...current, model }));
  return [...scopes];
}

/**
 * I-021 删除一致性 (docs/claude/2026-11-04-memory-notes-delete.md): the scopes above, plus every connection the chat archive
 * knows she was talked to under (MemoryStore.providerScopesOf), so a model the user typed earlier is covered too. Once each.
 */
export function characterProviderScopes(characterId: string, listed: readonly string[], known?: (characterId: string) => readonly string[]): string[] {
  let more: readonly string[] = [];
  try { more = known?.(characterId) ?? []; } catch { more = []; }
  return [...new Set([...listed, ...more])];
}

export interface CharacterForgetPorts {
  providerScopes(): string[];
  memory: { forgetScope(scope: MemoryScope): Promise<number>; providerScopesOf?(characterId: string): string[] };
  profiles: { forgetScope(scope: MemoryScope): Promise<boolean> } | null | undefined;
  relationship: { forget(characterId: string): Promise<void> };
  rps: { forget(characterId: string): boolean };
}

export interface CharacterForgetResult { records: number; profiles: number; failed: string[] }

/** Each part on its own: one that fails is reported, the others still go. */
export async function forgetCharacterMemories(characterId: string, ports: CharacterForgetPorts): Promise<CharacterForgetResult> {
  const result: CharacterForgetResult = { records: 0, profiles: 0, failed: [] };
  for (const providerScope of characterProviderScopes(characterId, ports.providerScopes(), id => ports.memory.providerScopesOf?.(id) ?? [])) {
    const scope = { characterId, providerScope };
    try { result.records += await ports.memory.forgetScope(scope); } catch { result.failed.push('memory'); }
    try { if (await ports.profiles?.forgetScope(scope)) result.profiles++; } catch { result.failed.push('profile'); }
  }
  try { await ports.relationship.forget(characterId); } catch { result.failed.push('relationship'); }
  try { ports.rps.forget(characterId); } catch { result.failed.push('rps'); }
  result.failed = [...new Set(result.failed)];
  return result;
}
