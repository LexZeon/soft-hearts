// 数据地图 (docs/claude/2026-11-16-data-map.md): the live stores → the two privacy registries electron/foundation/data-map.ts asks for.
//  - characterForgetRegistry: what "删除角色" with "同时删除她的记忆" ticked clears (electron/cards/character-forget.ts runs it).
//  - recordingOffRegistry / runRecordingOff: what "允许记录" turned off clears (and, for rows marked diaryCleared, clearing the diary).
// Each registry is typed from the table: a row that says 'delete' does not compile until it has a clear here, and a clear here without
// a row does not compile either. electron/main.ts only hands over the stores it has (lazily, at the moment of the action).
// No Electron import: tests build the registries from real stores in a temporary folder.
import type { MemoryScope } from '../../shared/memory/memory';
import type { CharacterForgetRegistry, ForgetClear } from '../cards';
import { DATA_MAP, recordingOffIds, type DataStoreRow, type RecordingOffId, type RecycleId } from '../foundation/data-map';
import type { RecycleRegistry } from './recycle/ports';

/** The stores the privacy actions touch; null/undefined = not running in this session. */
export interface PrivacyStores {
  memory: { forgetScope(scope: MemoryScope): Promise<number> };
  profiles: { forgetScope(scope: MemoryScope): Promise<boolean> } | null | undefined;
  relationship: { forget(characterId: string): Promise<void> };
  rps: { forget(characterId: string): boolean };
  feeding: { forget(characterId: string): boolean };
  herNote: { clear(scope: MemoryScope): Promise<void> } | null | undefined;
  movingMemory: { clear(scope: MemoryScope): Promise<void> } | null | undefined;
  songMemory: { clear(characterId: string): Promise<unknown> } | null | undefined;
  semantic: { forgetCharacter(characterId: string): Promise<void> } | null | undefined;
  listenTogether: { forgetCharacter(characterId: string): void } | null | undefined;
  watchTogether: { forgetCharacter(characterId: string): Promise<void> } | null | undefined;
  upcoming: { recordingOff(): Promise<void> } | null | undefined;
  hands: { recordingOff(): void } | null | undefined;
  /** I-188: the reminders the user asked her for (electron/initiative/moments/reminder-store.ts); deleting a character takes hers. */
  reminders?: { forgetCharacter(characterId: string): number } | null;
  /** Unbound v1 step 3: the voiceprint (electron/senses/voiceprint/host.ts); its delete removes the file and what is in memory. */
  voiceprint?: { deleteData(): Promise<unknown> } | null;
  /** I-144: the recycle registry (electron/memory/recycle-wiring.ts); its remove is the clear of the rows that came out of "待用户定" on 2026-11-16. */
  recycle?: RecycleRegistry | null;
}

export function characterForgetRegistry(s: PrivacyStores): CharacterForgetRegistry {
  const { profiles, herNote, movingMemory, songMemory, semantic, listenTogether, watchTogether } = s;
  return {
    'chat-memory': { per: 'scope', clear: scope => s.memory.forgetScope(scope) },
    'memory-vectors': semantic ? { per: 'character', clear: id => semantic.forgetCharacter(id) } : null,
    'user-profile': profiles ? { per: 'scope', clear: scope => profiles.forgetScope(scope) } : null,
    'her-note': herNote ? { per: 'scope', clear: scope => herNote.clear(scope) } : null, // her note and her bookmark go with her memory (56d28afc)
    'moving-memory': movingMemory ? { per: 'scope', clear: scope => movingMemory.clear(scope) } : null,
    relationship: { per: 'character', clear: id => s.relationship.forget(id) },
    rps: { per: 'character', clear: id => s.rps.forget(id) },
    feeding: { per: 'character', clear: id => s.feeding.forget(id) },
    'song-memory': songMemory ? { per: 'character', clear: id => songMemory.clear(id) } : null,
    'listen-together': listenTogether ? { per: 'character', clear: id => listenTogether.forgetCharacter(id) } : null, // I-016
    'watch-notes': watchTogether ? { per: 'character', clear: id => watchTogether.forgetCharacter(id) } : null, // I-048: notes, keywords, screenshots
    reminders: s.reminders ? { per: 'character', clear: id => s.reminders!.forgetCharacter(id) } : null, // I-188: the reminders she was asked for
    // I-144: what was 待用户定 goes too, through the recycle registry's remove.
    'memory-scopes': viaRecycle(s, 'memory-scopes'), hands: viaRecycle(s, 'hands'), 'our-things': viaRecycle(s, 'our-things'),
    'people-things': viaRecycle(s, 'people-things'), 'ambient-transcripts': viaRecycle(s, 'ambient-transcripts'), 'text-invitations': viaRecycle(s, 'text-invitations'),
    'speech-beats': viaRecycle(s, 'speech-beats'), 'special-day': viaRecycle(s, 'special-day'), keepsakes: viaRecycle(s, 'keepsakes'), 'recycle-bin': viaRecycle(s, 'recycle-bin'),
  };
}

/** A row's clear from the recycle registry's remove (nothing kept), or null when that store is not running. */
function viaRecycle(s: PrivacyStores, id: RecycleId): ForgetClear | null {
  const port = s.recycle?.[id];
  if (!port) return null;
  return port.per === 'scope' ? { per: 'scope', clear: scope => port.remove(scope, undefined) } : { per: 'character', clear: characterId => port.remove(characterId, undefined) };
}

export type RecordingOffReason = 'recording-off' | 'diary-cleared';
/** `scope`: the profile scope shown when the switch went off (the clear decides how far it reaches: that scope, that character, or all). */
export type RecordingOffRegistry = { readonly [K in RecordingOffId]: ((scope: MemoryScope) => unknown) | null };

export function recordingOffRegistry(s: PrivacyStores): RecordingOffRegistry {
  const { herNote, movingMemory, upcoming, hands, voiceprint } = s;
  return {
    'upcoming-marks': upcoming ? () => upcoming.recordingOff() : null, // P-001: every mark goes (the plans themselves: UserProfileStore.setEnabled)
    'her-note': herNote ? scope => herNote.clear(scope) : null,
    'moving-memory': movingMemory ? scope => movingMemory.clear(scope) : null,
    rps: scope => s.rps.forget(scope.characterId), // G1
    feeding: scope => s.feeding.forget(scope.characterId), // I-019
    hands: hands ? () => hands.recordingOff() : null, // I-087: the pinky promises go with the plans
    voiceprint: voiceprint ? () => voiceprint.deleteData() : null, // Unbound v1 step 3: the user's voiceprint goes too
  };
}

const diaryClearedIds = new Set<string>((DATA_MAP as readonly DataStoreRow[]).filter(row => row.diaryCleared === true).map(row => row.id));

/** Runs every clear the reason calls for, each on its own: one that throws or rejects does not stop the others. */
export function runRecordingOff(registry: RecordingOffRegistry, scope: MemoryScope, reason: RecordingOffReason): void {
  for (const id of recordingOffIds()) {
    if (reason === 'diary-cleared' && !diaryClearedIds.has(id)) continue;
    const clear = registry[id];
    if (!clear) continue;
    try { void Promise.resolve(clear(scope)).catch(() => undefined); } catch { /* reported by the store itself; the switch already changed */ }
  }
}
