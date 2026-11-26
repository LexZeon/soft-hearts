// C2 删除角色: deleting a card deletes only the card by default; her memories
// stay. The confirmation has an unticked "同时删除她的记忆"; ticked, this removes what she remembers of the user:
// chat memory, the profile with her diary, familiarity and nickname, and G1's match counts. Text memorials (each
// one saved with the user's own yes) and her own mood state are not touched.
// 数据地图 (docs/claude/2026-11-16-data-map.md): what goes is every row of electron/foundation/data-map.ts whose characterForget is 'delete',
// each through one clear function in the registry below (electron/memory/privacy-wiring.ts builds it from the live stores). The registry's
// type is made from the table, so a new 'delete' row does not compile until its clear is wired.
import type { ProviderConfig } from '../../shared/foundation/settings';
import type { MemoryScope } from '../../shared/memory';
import { characterForgetIds, type CharacterForgetId } from '../foundation/data-map';

/** The chat connections a character's memories may sit under (memory and profile are per connection). */
export function forgettableProviderScopes(current: ProviderConfig, scopeOf: (provider: ProviderConfig) => string): string[] {
  // The Claude fork's connection differs only by the model name the user typed; the usual aliases are covered too.
  // I-222: the memory is filed under the pinned memoryModel since 0.2.0; the variants set it too, so the scopes a model chosen before
  // the pin used (0.1.x filed by the chat model) are still reached, and the chat model now chosen as well.
  const models = new Set(['', 'haiku', 'sonnet', 'opus', current.model, ...(typeof current.memoryModel === 'string' ? [current.memoryModel] : [])]);
  const scopes = new Set<string>([scopeOf(current)]);
  for (const model of models) scopes.add(scopeOf({ ...current, model, memoryModel: model }));
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

/** One store's clear: per connection scope (called once for each scope the character may have), or once per character. */
export type ForgetClear =
  | { readonly per: 'scope'; clear(scope: MemoryScope): unknown }
  | { readonly per: 'character'; clear(characterId: string): unknown };

/** Every 'delete' row of the data map. null: that part is not running in this session (nothing of it to clear now). */
export type CharacterForgetRegistry = { readonly [K in CharacterForgetId]: ForgetClear | null };

export interface CharacterForgetPorts {
  providerScopes(): string[];
  /** I-021: the other connections the chat archive knows she was talked to under (MemoryStore.providerScopesOf). */
  providerScopesOf?(characterId: string): string[];
  clears: CharacterForgetRegistry;
}

/** `records`: chat records removed; `profiles`: profile files removed; `failed`: data-map ids of the parts that failed. */
export interface CharacterForgetResult { records: number; profiles: number; failed: CharacterForgetId[] }

/** Each part on its own, in the table's order: one that fails is reported, the others still go. */
export async function forgetCharacterMemories(characterId: string, ports: CharacterForgetPorts): Promise<CharacterForgetResult> {
  const result: CharacterForgetResult = { records: 0, profiles: 0, failed: [] };
  const scopes = characterProviderScopes(characterId, ports.providerScopes(), id => ports.providerScopesOf?.(id) ?? []);
  for (const id of characterForgetIds()) {
    const entry = ports.clears[id];
    if (!entry) continue;
    if (entry.per === 'scope') {
      for (const providerScope of scopes) {
        try {
          const out = await entry.clear({ characterId, providerScope });
          if (id === 'chat-memory' && typeof out === 'number') result.records += out;
          if (id === 'user-profile' && out === true) result.profiles++;
        } catch { result.failed.push(id); }
      }
    } else {
      try { await entry.clear(characterId); } catch { result.failed.push(id); }
    }
  }
  result.failed = [...new Set(result.failed)];
  return result;
}
