// 记忆's wiring, what deleting goes through (split from electron/wiring/memory-wiring.ts,
// docs/claude/2026-11-17-split-initiative-memory-wiring.md): 数据地图 / I-144 回收站. privacyStores() (what 「允许记录」 off clears),
// recycleStores() (what deleting a character with her memories and every single deletion take into the bin), recycleSingle, the bin and
// its host (startRecycleBin, where registerIPC made them: before the card handlers that delete into it), the I-014 recoverable wiring
// the agent channel finds things back through. The stores those read are registered by the part that owns each one, as the data map
// says (registerPrivacyStores: 记忆 in memory-wiring.ts, 感知 in senses-wiring.ts, 角色卡 in cards-wiring.ts, 主动 in initiative-wiring.ts,
// 安全's Claude assistant in electron/main.ts until its wiring moves). The order the actions go through them stays the data map's.
// The statements are the ones memory-wiring.ts had; memory-wiring.ts re-exports what the other parts use. wireMemory hands this file
// its needs first. No module-level side effects: nothing here runs on import (`registered` starts empty).
import { MemoryRecycleBin } from '../memory';
import { followChatDeletions, speechBeatsFor } from '../brain';
import type { PrivacyStores } from '../memory/privacy-wiring';
import { createRecycleHost, recycleRegistry, recycleSuspendsProfile, type RecycleHost, type RecycleStores } from '../memory/recycle-wiring';
import { PROFILE_EXTRA_ROWS } from '../memory/recoverable-forget';
import { characterProviderScopes, forgettableProviderScopes } from '../cards';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import { broadcast } from './shell-wiring';
import { agentChannelRefresh, createMemoryBridge, type RecoverableMemoryWiring } from './safety-wiring';
import { watchTogether } from './senses-wiring';
import { movingMemory, userProfileManagement, userProfiles } from './memory-profile-wiring';
import { activateProfile, type MemoryNeeds } from './memory-wiring';
import { partRunner } from './parts-wiring';
import { PRIVACY_PART_OFF_MESSAGE } from '../../shared/foundation/part-health';

// ---- state other parts read (re-exported by memory-wiring.ts; live bindings electron/main.ts imports) ----
/** I-144 回收站: one bin for every deletion that keeps a copy (electron/memory/recycle-wiring.ts); made and loaded once the profile is known. */
export let recycleBin: MemoryRecycleBin | null = null; export let recycleHost: RecycleHost | null = null;

// Set by wireMemory (while electron/main.ts is evaluated, before anything below runs).
let needs!: MemoryNeeds;
/** wireMemory calls this first: the needs recycleStores, recycleChanged and startRecycleBin read. */
export function wireMemoryRecycle(given: MemoryNeeds): void { needs = given; }

// ---- 数据地图 owners: each part hands over the live stores it owns (wiring rewrite step 4d) ----
// Which part owns each store the privacy actions use is the data map's `owner` (electron/foundation/data-map.ts; the store's rows, checked
// by tests/memory-privacy-gates.test.ts). Each part registers its stores once, in its own wiring (electron/main.ts for the part whose
// wiring has not moved yet: 安全's Claude assistant). The order the actions go through the stores is the data map's, never the
// order of registration (electron/memory/recycle/character.ts, electron/memory/privacy-wiring.ts; the wiring golden's privacy section).
export type StoreOwner = 'memory' | 'senses' | 'initiative' | 'cards' | 'safety';
/** The bin's stores (RecycleStores), by owner. A store missing here, or given by no part, does not compile. */
export const RECYCLE_STORE_OWNERS = {
  memory: 'memory', textInvitations: 'memory', notes: 'memory', keywords: 'memory', semantic: 'memory', profiles: 'memory', upcoming: 'memory', herNote: 'memory',
  movingMemory: 'memory', relationship: 'memory', speechBeats: 'memory', specialDay: 'memory', textMemorials: 'memory', upcomingStore: 'memory', reviews: 'memory',
  feeding: 'senses', songs: 'senses', listen: 'senses', watch: 'senses', ambient: 'senses',
  rps: 'initiative', hands: 'initiative', ourThings: 'initiative', keepsakes: 'initiative',
  cards: 'cards', responses: 'cards', avatars: 'cards',
  assistant: 'safety',
} as const satisfies { readonly [K in Exclude<keyof RecycleStores, 'profileDirectory' | 'bin'>]-?: StoreOwner };
/** What 「允许记录」 off clears (PrivacyStores), by owner. */
export const RECORDING_OFF_STORE_OWNERS = {
  memory: 'memory', profiles: 'memory', relationship: 'memory', herNote: 'memory', movingMemory: 'memory', semantic: 'memory', upcoming: 'memory',
  feeding: 'senses', songMemory: 'senses', listenTogether: 'senses', watchTogether: 'senses', voiceprint: 'senses',
  rps: 'initiative', hands: 'initiative', reminders: 'initiative',
} as const satisfies { readonly [K in Exclude<keyof PrivacyStores, 'recycle'>]-?: StoreOwner };
/**
 * 隐私失败即关 (overhaul step 7, docs/claude/2026-11-17-isolation-step7.md; plan section 3): the unit whose start makes each store above
 * (null: a core unit, never switched off). While any of them is off, every privacy action refuses as a whole before it touches anything
 * (deleting a character with her memories, 「允许记录」 off, a single deletion, the recycle bin's put back and delete for good, the agent
 * channel's delete_memories / restore_memories): never half a deletion. A store missing here does not compile.
 */
export const PRIVACY_STORE_UNITS = {
  memory: null, relationship: null, textInvitations: ['memory', 'text-memorials'], textMemorials: ['memory', 'text-memorials'], notes: ['memory', 'memory-notes'],
  semantic: ['memory', 'memory-semantic'], profiles: ['memory', 'user-profiles'], upcomingStore: ['memory', 'user-profiles'], reviews: ['memory', 'user-profiles'],
  upcoming: ['memory', 'upcoming'], speechBeats: null, herNote: ['memory', 'her-note'], movingMemory: ['memory', 'moving-memory'], specialDay: ['initiative', 'special-day'],
  keywords: ['senses', 'ambient-audio'], listen: ['senses', 'ambient-audio'], listenTogether: ['senses', 'ambient-audio'], watch: ['senses', 'ambient-audio'],
  watchTogether: ['senses', 'ambient-audio'], ambient: ['senses', 'ambient-audio'], songs: null, songMemory: null, feeding: ['initiative', 'feeding'],
  rps: ['initiative', 'rps'], hands: ['initiative', 'hands'], ourThings: ['initiative', 'give'], keepsakes: ['initiative', 'keepsake'],
  cards: null, avatars: null, responses: ['cards', 'responses'], assistant: ['safety', 'agent-channel'], voiceprint: null, reminders: ['initiative', 'moments'],
} as const satisfies { readonly [K in keyof typeof RECYCLE_STORE_OWNERS | keyof typeof RECORDING_OFF_STORE_OWNERS]-?: readonly [string, string] | null };
/** The refusal while an owner unit is off (null: every owner is on, or the runner is strict). */
export function privacyRefusal(): Error | null {
  const runner = partRunner();
  if (!runner) return null;
  const units = (Object.values(PRIVACY_STORE_UNITS) as readonly (readonly [string, string] | null)[]).flatMap(owner => owner ? [{ part: owner[0], unit: owner[1] }] : []);
  return runner.firstOff(units) ? new Error(PRIVACY_PART_OFF_MESSAGE) : null;
}
function refuseWhilePartOff(): void { const refused = privacyRefusal(); if (refused) throw refused; }
/** The recycle host with every action that changes something refused as a whole while an owner unit is off (view and setDays stay). */
export function gatedRecycleHost(host: RecycleHost): RecycleHost {
  const gate = <A extends unknown[], R>(run: (...args: A) => Promise<R>) => (...args: A): Promise<R> => { const refused = privacyRefusal(); return refused ? Promise.reject(refused) : run(...args); };
  return { ...host, deleteCharacter: gate(host.deleteCharacter), deleteMemoryNote: gate(host.deleteMemoryNote), deleteMovingMemory: gate(host.deleteMovingMemory),
    deleteListenNote: gate(host.deleteListenNote), recycled: gate(host.recycled) as RecycleHost['recycled'], restore: gate(host.restore), deleteForGood: gate(host.deleteForGood) };
}
type RecycleOwned<P extends StoreOwner> = { [K in keyof typeof RECYCLE_STORE_OWNERS as (typeof RECYCLE_STORE_OWNERS)[K] extends P ? K : never]-?: RecycleStores[K] };
type RecordingOffOwned<P extends StoreOwner> = { [K in keyof typeof RECORDING_OFF_STORE_OWNERS as (typeof RECORDING_OFF_STORE_OWNERS)[K] extends P ? K : never]-?: PrivacyStores[K] };
/** One part's stores, read at the moment of each action (null: not running in this session). */
export interface OwnedStores<P extends StoreOwner> { recycle(): RecycleOwned<P>; recordingOff(): RecordingOffOwned<P> }
const registered: { [P in StoreOwner]?: OwnedStores<P> } = {};
/** A part hands over the stores it owns (once). */
export function registerPrivacyStores<P extends StoreOwner>(owner: P, stores: OwnedStores<P>): void {
  if (registered[owner]) throw new Error(`数据地图: ${owner} registered its stores twice`);
  (registered as { [K in StoreOwner]?: OwnedStores<K> })[owner] = stores as never;
}
/** A part's stores; a part that has not registered them stops the action before anything is deleted. */
function owned<P extends StoreOwner>(owner: P): OwnedStores<P> {
  const stores = registered[owner] as OwnedStores<P> | undefined;
  if (!stores) throw new Error(`数据地图：${owner} 还没登记它的存储，这一次什么都没删。`);
  return stores;
}
/** 数据地图 (electron/foundation/data-map.ts): the stores the privacy actions clear, read at the moment of the action (electron/memory/privacy-wiring.ts). */
export function privacyStores(): PrivacyStores {
  refuseWhilePartOff(); // step 7: before anything is cleared
  const all: PrivacyStores & Record<Exclude<keyof PrivacyStores, 'recycle'>, unknown> = { ...owned('memory').recordingOff(), ...owned('senses').recordingOff(),
    ...owned('initiative').recordingOff(), ...owned('cards').recordingOff(), ...owned('safety').recordingOff() };
  return all;
}
export function recycleStores(): RecycleStores {
  refuseWhilePartOff(); // step 7: before anything is taken
  const all: RecycleStores & Record<keyof RecycleStores, unknown> = { profileDirectory: needs.store.directory, bin: recycleBin!, ...owned('memory').recycle(), ...owned('senses').recycle(),
    ...owned('initiative').recycle(), ...owned('cards').recycle(), ...owned('safety').recycle() };
  return all;
}
/** I-144: the bin changed: the control window reads it again (names, kinds, counts, times), and the agent channel's view too. */
/** I-144b 单条删除也先进回收站: one single deletion (or clear) goes into the bin first (electron/memory/recycle-wiring.ts recycled). */
export function recycleSingle<T>(take: Parameters<RecycleHost['recycled']>[0], remove: () => Promise<T> | T, removed?: (result: T) => boolean): Promise<T> { return recycleHost ? recycleHost.recycled(take, remove, removed) : Promise.reject(new Error('回收站还没准备好，这一项没有删，稍后再试。')); }
export const field = (value: unknown, name: string): unknown => value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
function recycleChanged(): void { const { controls } = needs; /* read when called */ if (recycleHost && controls && !controls.isDestroyed()) controls.webContents.send('desk:recycle-bin', recycleHost.view()); agentChannelRefresh(); }

/**
 * registerIPC (记忆): the app's one recycle bin and its host, loaded before anything is put in (until then a deletion that needs it keeps
 * everything where it is), and the I-014 wiring the agent channel's delete_memories / restore_memories use. Runs where main.ts made them:
 * before the card handlers that delete into the bin. Returns the recoverable wiring the agent channel is given.
 */
export function startRecycleBin(): RecoverableMemoryWiring {
  const { store, companion, characterCards, mutations } = needs; // set before registerIPC and never replaced
  recycleBin = new MemoryRecycleBin(store.directory, Date.now, () => recycleChanged());
  const recycleScopes = (id: string) => characterProviderScopes(id, forgettableProviderScopes(store.current.provider, memoryProviderScope), characterId => companion.memory.providerScopesOf(characterId));
  recycleHost = gatedRecycleHost(createRecycleHost({ bin: recycleBin, stores: recycleStores, currentScope: () => { try { return companion.currentScope(); } catch { return null; } },
    characterName: id => characterCards.publicState().cards.find(card => card.id === id)?.name ?? '', providerScopes: recycleScopes,
    cardExists: id => characterCards.publicState().cards.some(card => card.id === id),
    restoreMemoryPart: id => createMemoryBridge(recycleBin!, recoverable).restore(id, () => {}),
    change: (kind, characterId, run) => kind === 'delete-character' ? run() : mutations.run(async () => {
      const previous = characterCards.getActive(), active = previous.id === characterId;
      const suspend = active && recycleSuspendsProfile(kind); // I-144b: plans need the profile open (「允许记录」 is read from it)
      if (suspend) userProfileManagement?.suspendScope();
      try { return await run(); }
      finally {
        if (kind === 'character') { await needs.syncCharacter(false, previous).catch(() => undefined); broadcast('desk:character-roster', undefined); }
        if (suspend) await activateProfile();
        broadcast('desk:memory-changed', undefined);
      }
    }) }));
  followChatDeletions(companion.memory, speechBeatsFor(store.directory).archive); // 边说边演: nothing of a deleted reply stays
  void recycleBin.load().then(() => recycleChanged(), () => undefined);
  setInterval(() => { void recycleBin?.purge().catch(() => {}); }, 60 * 60_000).unref?.(); // expired entries go once an hour (and at every start)
  // I-014 回收站: delete_memories / restore_memories (electron/memory/recoverable-forget.ts) on the host's mutation queue. Forgetting
  // the current character's chat stops her turns and starts a fresh conversation, like deleting one memory does.
  const recoverable: RecoverableMemoryWiring = {
    providerScopes: () => forgettableProviderScopes(store.current.provider, memoryProviderScope),
    chat: () => companion.memory, profiles: () => userProfiles ?? null, watch: () => watchTogether?.recyclePort(), // I-048: her watch notes ride in the chat entry
    beats: () => { const beats = recycleStores().speechBeats; return beats ? { capture: scope => beats.copyScope(scope), restore: (scope, part) => beats.restore(scope, part) } : undefined; }, // 边说边演: the beats of those replies ride in it too
    profileExtras: () => { const registry = recycleRegistry(recycleStores()); return Object.fromEntries(PROFILE_EXTRA_ROWS.map(row => [row, registry[row]])) as RecoverableMemoryWiring extends { profileExtras?(): infer R } ? R : never; }, // I-144: ride in the profile entry
    restoreOther: id => recycleHost!.restore(id), // I-144: a deleted character, a single note
    change: (characterId, parts, mode, guard, run) => privacyRefusal() ? Promise.reject(privacyRefusal()) : mutations.run(async () => { // step 7: refused as a whole while an owner unit is off
      const active = companion.currentScope().characterId === characterId;
      const chat = active && mode === 'forget' && parts.includes('chat'), profile = active && parts.includes('profile');
      if (chat) {
        needs.stopSystemAudio(); needs.proactiveSpeechGate.cancel('delete'); needs.clearVisionContext(); needs.speechRuntime.stop(); needs.clearReplySpeech();
        for (const task of needs.pending.values()) if (task.kind === 'chat') task.controller.abort();
      }
      if (profile) userProfileManagement?.suspendScope();
      const bookmarks = mode === 'forget' && parts.includes('chat') ? characterProviderScopes(characterId, recoverable.providerScopes(), id => companion.memory.providerScopesOf(id)) : []; // I-139 A3: her bookmarks under those connections are re-checked after
      try { return chat ? await companion.forgetCurrentMemories(run) : await run(); }
      finally {
        if (profile) await activateProfile();
        if (chat) { broadcast('desk:chat-reset', undefined); needs.refreshVisionContext(); }
        for (const providerScope of bookmarks) void movingMemory?.prune({ characterId, providerScope });
        broadcast('desk:memory-changed', undefined);
      }
    }, guard),
  };
  return recoverable;
}
