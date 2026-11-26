// I-144 回收站：完整复原，放在删东西的地方旁边 (docs/claude/2026-11-16-recycle-bin-plan.md; record docs/claude/2026-11-16-i144-recycle-bin.md).
// The live stores → the recycle registry electron/foundation/data-map.ts asks for (one capture / remove / restore per 'take' row), the
// three single deletions that now go through the bin (a memory note, the moving memory, a listening note), finding any entry back, and the
// control window's IPC. electron/main.ts only hands over the stores it has (read at the moment of each action) and wraps each change in its
// mutation queue. The windows and the agent channel only ever see names, kinds, counts and times (shared/foundation/recycle-bin.ts).
// No Electron import: tests build all of it from real stores in a temporary folder.
import type { MemoryScope } from '../../shared/memory/memory';
import type { MemoryNoteState } from '../../shared/memory/memory-notes/interface';
import type { MovingMemoryView } from '../../shared/memory/moving-memory';
import type { RecycleBinView, RecycleEntryKind } from '../../shared/foundation/recycle-bin';
import type { ListenTogetherView } from '../../shared/senses/listen-together';
import type { KeywordRecord } from '../../shared/memory/memory-keywords/keyword-index';
import { relationshipFileName } from './relationship/store';
import { characterKey } from './memory-keywords/store';
import { userProfileScopeId } from './user-profile';
import type { MemoryStore } from './memory';
import type { MemoryRecycleBin, RecycleRawEntry, RecycleSummaryView } from './memory-recycle-bin';
import type { MemoryNotes } from './memory-notes/host';
import type { MemoryNotesPart } from './memory-notes/core';
import type { KeywordRecall } from './memory-keywords/recall';
import type { UserProfileStore } from './user-profile';
import type { UpcomingHost } from './upcoming/host';
import type { HerNoteStore } from './her-note/store';
import type { MovingMemoryHost } from './moving-memory/wiring';
import type { RelationshipHost } from './relationship/host';
import type { SpecialDayHost } from './special-day/host';
import type { SemanticRecall } from './memory-semantic/recall';
import { filesPort, removeFiles, type CharacterPort, type RecyclePort, type RecycleRegistry, type ScopePort } from './recycle/ports';
import { recycleCharacter, restoreCharacterEntry, type CharacterRecycleOutcome, type CharacterRestoreOutcome } from './recycle/character';
import type { RpsStore } from '../initiative/rps/store';
import type { FeedRecognitionStore } from '../senses/feed-recognition/store';
import type { SongMemoryHost } from '../senses/song-memory';
import type { ListenTogether } from '../senses/listen-together/host';
import type { ListenNotePart } from '../senses/listen-together/core';
import type { WatchTogether } from '../senses/watch-notes/wiring';
import type { HandsStore } from '../initiative/hands/store';
import type { OurThingsStore } from '../initiative/give/store';
import type { KeepsakeHost } from '../initiative/her-folder/keepsake';
import type { AudioReadingArchive } from '../voice/audio-reading-archive';
import type { AmbientScopePart } from '../senses/ambient-audio-store';
import type { CharacterCardStore } from '../cards/character-cards';
import type { CharacterResponseStore } from '../cards/character-response';
import type { CharacterAvatarStore } from '../cards/character-avatars';
import type { UpcomingPort } from './upcoming/store';
import type { ReviewPort } from './period-review/store';
import type { TextMemorialHost } from './text-memorial-host';
import { ITEM_RESTORERS, isItemKind, takeSongs, type ItemTake } from './recycle/items-wiring';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';
export { takeAmbientTranscript, takeAssistantChat, takeChatRecord, takeDiary, takeCardMilestone, takeObjectNote, takeHerNickname, takeListenRaw, takeNickname, takeOurThing, takePlans, takeProfileEntry, takeReview, takeSongs, takeTextMemorial, type ItemTake } from './recycle/items-wiring'; // I-144b: what main.ts wires around each single deletion

/**
 * 边说边演 (electron/brain/speech-beats/archive.ts): what describes her replies follows her chat records. Structural, so this part does not import the brain's.
 * A copy is what the bin keeps (no words of anyone: the vocabulary's words, positions, the grey line).
 */
export interface SpeechBeatsPort {
  copyScope(scope: MemoryScope): unknown | null;
  copyTurns(scope: MemoryScope, turnIds: readonly string[]): unknown | null;
  removeScope(scope: MemoryScope): Promise<void>;
  restore(scope: MemoryScope, part: unknown): Promise<void>;
}

/** The stores the bin reads and writes; null/undefined = not running in this session. Read at the moment of each action. */
export interface RecycleStores {
  profileDirectory: string;
  bin: MemoryRecycleBin;
  memory: MemoryStore;
  textInvitations?: MemoryStore | null;
  notes?: MemoryNotes | null;
  keywords?: KeywordRecall | null;
  semantic?: Pick<SemanticRecall, 'forgetCharacter'> | null;
  profiles?: UserProfileStore | null;
  upcoming?: Pick<UpcomingHost, 'marks'> | null;
  speechBeats?: SpeechBeatsPort | null;
  herNote?: HerNoteStore | null;
  movingMemory?: Pick<MovingMemoryHost, 'store' | 'view'> | null;
  relationship?: Pick<RelationshipHost, 'forget'> & Partial<Pick<RelationshipHost, 'nicknameCopy' | 'restoreNickname' | 'herNicknames' | 'restoreHerNickname' | 'ensureCardMilestone' | 'restoreCardMilestone' | 'objectNotes' | 'restoreObjectNote'>> | null;
  rps?: RpsStore | null;
  feeding?: FeedRecognitionStore | null;
  songs?: SongMemoryHost | null;
  listen?: ListenTogether | null;
  watch?: Pick<WatchTogether, 'forgetCharacter' | 'texts'> | null;
  hands?: HandsStore | null;
  ourThings?: OurThingsStore | null;
  keepsakes?: KeepsakeHost | null;
  specialDay?: SpecialDayHost | null;
  ambient?: Pick<AudioReadingArchive, 'recycleCopy' | 'forgetScope' | 'recycleRestore' | 'transcriptCopy' | 'commentCopy' | 'restoreItem'> | null;
  cards?: CharacterCardStore | null;
  responses?: CharacterResponseStore | null;
  avatars?: Pick<CharacterAvatarStore, 'remove'> | null;
  /** I-144b: the stores single deletions take from (plans, look-backs, text memorials, the Claude assistant). */
  upcomingStore?: Pick<UpcomingPort, 'itemsCopy' | 'restoreItems'> | null;
  reviews?: Pick<ReviewPort, 'reviewCopy' | 'restoreReview'> | null;
  textMemorials?: Pick<TextMemorialHost, 'entryCopy' | 'restoreEntry'> | null;
  assistant?: { historyCopy(): Promise<unknown[]>; restoreHistory(messages: unknown): Promise<unknown[]> } | null;
}

const PLAIN_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const SONG_ID = /^[A-Za-z0-9._-]{8,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nothing = async () => undefined;

function scopePort(port: Omit<ScopePort, 'per'>): ScopePort { return { per: 'scope', ...port }; }
function characterPort(port: Omit<CharacterPort, 'per'>): CharacterPort { return { per: 'character', ...port }; }

/** The registry: every 'take' row of the data map from the live stores (the type makes a missing row a compile error). */
export function recycleRegistry(s: RecycleStores): RecycleRegistry {
  const root = () => s.profileDirectory;
  const sid = (scope: MemoryScope) => userProfileScopeId(scope);
  const files = (rels: (id: string) => string[], remove: (id: string) => Promise<unknown>, more: { drop?(id: string): Promise<unknown>; reloaded?(id: string): unknown; folders?(id: string): string[] } = {}) =>
    filesPort<'character', string>('character', { root, rels, remove, ...more });
  const scopeFiles = (rel: (scope: MemoryScope) => string, remove: (scope: MemoryScope) => Promise<unknown>, more: { drop?(scope: MemoryScope): Promise<unknown>; reloaded?(scope: MemoryScope): unknown } = {}) =>
    filesPort<'scope', MemoryScope>('scope', { root, rels: scope => [rel(scope)], remove, ...more });
  const plainRemove = (rels: string[]) => removeFiles(s.profileDirectory, rels);
  const { memory, notes, keywords, semantic, profiles, upcoming, herNote, movingMemory, relationship, rps, feeding, songs, listen, watch, hands, ourThings,
    keepsakes, specialDay, ambient, cards, responses, avatars, textInvitations, bin, speechBeats } = s;

  const keywordRel = (id: string) => [`memory-keywords/${characterKey(id)}.json`];
  const vectorRel = (id: string) => [`memory-vectors/${characterKey(id)}.json`];
  const watchRel = (id: string) => [`watch-notes/${characterKey(id)}.json`];
  const relationshipRel = (id: string) => [`relationship/${relationshipFileName(id)}`];
  const songRel = (id: string) => SONG_ID.test(id) ? [`song-memory-${id}.json`] : [];
  const handsRel = (id: string) => PLAIN_ID.test(id) ? [`hands/${id}.json`] : [];
  const thingsRel = (id: string) => PLAIN_ID.test(id) ? [`our-things/${id}.json`] : [];
  const thingsFolder = (id: string) => PLAIN_ID.test(id) ? [`our-things/${id}`] : [];
  const peopleRel = (id: string) => PLAIN_ID.test(id) ? [`people-things/${id}.json`] : [];
  const avatarRel = (id: string) => UUID.test(id) ? [`character-avatars/${id.toLowerCase()}.png`] : [];
  const profileRel = (scope: MemoryScope) => `user-profiles/profile-${sid(scope)}.json`;
  const upcomingRel = (scope: MemoryScope) => `user-profiles/upcoming-${sid(scope)}.json`;
  const reviewRel = (scope: MemoryScope) => `user-profiles/review-${sid(scope)}.json`;
  const herNoteRel = (scope: MemoryScope) => `user-profiles/her-note-${sid(scope)}.json`;
  const movingRel = (scope: MemoryScope) => `user-profiles/moving-memory-${sid(scope)}.json`;
  const journalPort = (store: MemoryStore) => scopePort({
    capture: scope => store.recycleCopy(scope),
    remove: scope => store.forgetScope(scope),
    restore: async (scope, captured) => { await store.recycleRestore(scope, captured); },
  });

  return {
    'chat-memory': journalPort(memory),
    'memory-scopes': characterPort({
      capture: async id => memory.ownersCopy(id),
      remove: id => memory.forgetOwners(id),
      restore: (id, captured) => memory.restoreOwners(id, captured),
    }),
    // Her notebook leaves with her chat memory (MemoryStore tells it); its copy is taken first and put back after the chat memory.
    'memory-notes': notes ? scopePort({
      capture: async scope => notes.recycleCopy(memory.recordIds(scope)),
      remove: nothing,
      restore: (_scope, captured) => notes.recycleRestore(captured as MemoryNotesPart),
    }) : null,
    // Their entries also go with a chat record's turns (MemoryStore.onTurnsRemoved); this is the whole scope's copy, put back with it.
    'speech-beats': speechBeats ? scopePort({
      capture: async scope => speechBeats.copyScope(scope),
      remove: scope => speechBeats.removeScope(scope),
      restore: (scope, captured) => speechBeats.restore(scope, captured),
    }) : null,
    'memory-keywords': files(keywordRel, id => keywords ? keywords.forgetCharacter(id) : plainRemove(keywordRel(id))),
    'memory-vectors': files(vectorRel, id => semantic ? semantic.forgetCharacter(id) : plainRemove(vectorRel(id))),
    'user-profile': scopeFiles(profileRel, scope => profiles ? profiles.forgetScope(scope) : plainRemove([profileRel(scope)]), {
      drop: async scope => { profiles?.closeScope(scope); await plainRemove([profileRel(scope)]); },
    }),
    'upcoming-plans': scopeFiles(upcomingRel, scope => profiles ? profiles.forgetCompanion(scope, 'upcoming') : plainRemove([upcomingRel(scope)])),
    'upcoming-marks': upcoming ? scopePort({
      capture: async scope => upcoming.marks.recycleCopy(memory.recordIds(scope)),
      remove: async (_scope, captured) => { const ids = (captured as { items?: { value: string }[] } | null)?.items?.map(item => item.value) ?? []; upcoming.marks.remove(ids); await upcoming.marks.flush(); },
      restore: (_scope, captured) => upcoming.marks.recycleRestore(captured as never),
    }) : null,
    'period-reviews': scopeFiles(reviewRel, scope => profiles ? profiles.forgetCompanion(scope, 'reviews') : plainRemove([reviewRel(scope)])),
    'her-note': scopeFiles(herNoteRel, scope => herNote ? herNote.clear(scope) : plainRemove([herNoteRel(scope)]),
      { drop: scope => herNote ? herNote.reload(scope) : nothing(), reloaded: scope => herNote?.reload(scope) }),
    'moving-memory': scopeFiles(movingRel, scope => movingMemory ? movingMemory.store.clear(scope) : plainRemove([movingRel(scope)]),
      { drop: scope => movingMemory ? movingMemory.store.reload(scope) : nothing(), reloaded: scope => movingMemory?.store.reload(scope) }),
    relationship: files(relationshipRel, id => relationship ? relationship.forget(id) : plainRemove(relationshipRel(id))),
    rps: rps ? characterPort({
      capture: async id => rps.recycleCopy(id),
      remove: async id => { rps.forget(id); await rps.flush(); },
      restore: async (id, captured) => { rps.recycleRestore(id, captured as never); await rps.flush(); },
    }) : null,
    feeding: feeding ? characterPort({
      capture: async id => feeding.recycleCopy(id),
      remove: async id => { feeding.forget(id); await feeding.flush(); },
      restore: async (id, captured) => { feeding.recycleRestore(id, captured as never); await feeding.flush(); },
    }) : null,
    'song-memory': files(songRel, id => songs ? songs.clear(id) : plainRemove(songRel(id)),
      { drop: id => songs ? songs.clear(id) : nothing(), reloaded: id => songs?.reload(id) }),
    'listen-together': listen ? characterPort({
      capture: async id => listen.recycleCopy(id),
      remove: async id => { listen.forgetCharacter(id); await listen.core.flush(); },
      restore: async (id, captured) => { listen.recycleRestore(id, captured as never); await listen.core.flush(); },
    }) : null,
    // Her watch notes, their keywords and the screenshot cache go together; the keywords file is its own row (put back after this one).
    'watch-notes': files(watchRel, id => watch ? watch.forgetCharacter(id) : plainRemove(watchRel(id)),
      { drop: async id => { watch?.texts.forget(id); }, reloaded: id => watch?.texts.forget(id) }),
    hands: files(handsRel, id => hands ? hands.forget(id) : plainRemove(handsRel(id))),
    'our-things': files(thingsRel, id => ourThings ? ourThings.forget(id) : plainRemove([...thingsRel(id), ...thingsFolder(id)]), { folders: thingsFolder }),
    'people-things': files(peopleRel, id => notes ? notes.people.forgetCharacter(id) : plainRemove(peopleRel(id)), { reloaded: id => notes?.people.reloaded(id) }),
    'ambient-transcripts': ambient ? scopePort({
      capture: scope => ambient.recycleCopy(scope),
      remove: scope => ambient.forgetScope(scope),
      restore: (scope, captured) => ambient.recycleRestore(scope, captured as AmbientScopePart),
    }) : null,
    'text-invitations': textInvitations ? journalPort(textInvitations) : null,
    'special-day': specialDay ? characterPort({
      capture: async id => specialDay.recycleCopy(id),
      remove: id => specialDay.forgetCharacter(id),
      restore: (id, captured) => specialDay.recycleRestore(id, captured),
    }) : null,
    keepsakes: keepsakes ? characterPort({
      capture: async id => keepsakes.recycleCopy(id),
      remove: id => keepsakes.forgetCharacter(id),
      restore: (id, captured) => keepsakes.recycleRestore(id, captured),
    }) : null,
    // Her own earlier entries ride inside the new one, byte for byte, and go back into the bin under their own ids and times.
    'recycle-bin': characterPort({
      capture: async id => { const entries = await bin.rawEntries(id); return entries.length ? { entries } : null; },
      remove: async (id, captured) => {
        const ids = (captured as { entries?: { id: string }[] } | null)?.entries?.map(entry => entry.id) ?? bin.summaries(id).map(entry => entry.id);
        for (const entryId of ids) await bin.remove(entryId);
      },
      restore: async (id, captured) => {
        const entries = (captured as { entries?: { raw: RecycleRawEntry }[] } | null)?.entries;
        if (!Array.isArray(entries)) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
        await bin.adoptRaw(id, entries.map(entry => entry.raw));
      },
    }),
    'character-cards': cards ? characterPort({
      capture: async id => cards.recycleCopy(id),
      remove: nothing, // the host removes the card itself (CharacterResponseService.remove)
      restore: async (id, captured) => { await cards.recycleRestore(id, captured); },
    }) : null,
    'character-response': responses ? characterPort({
      capture: async id => responses.recycleCopy(id),
      remove: nothing, // goes with the card
      restore: (id, captured) => responses.recycleRestore(id, captured),
    }) : null,
    'character-avatars': files(avatarRel, id => avatars && UUID.test(id) ? avatars.remove(id) : plainRemove(avatarRel(id))),
  };
}

// ---- the three single deletions (each in its own panel), and finding any entry back ----

/** What the host provides around the bin: its stores, where she is now, and a wrapper that runs a change on its mutation queue. */
export interface RecycleHostDeps {
  /** The bin (the same one stores() hands over). */
  bin: MemoryRecycleBin;
  stores(): RecycleStores;
  /** The shown character and connection (the panels act on it), or null. */
  currentScope(): MemoryScope | null;
  characterName(characterId: string): string;
  /** Every connection she may have memories under (characterProviderScopes). */
  providerScopes(characterId: string): string[];
  cardExists(characterId: string): boolean;
  /** I-014: chat and profile entries keep their own restore (electron/memory/recoverable-forget.ts through the agent memory bridge). */
  restoreMemoryPart(entryId: string): Promise<unknown>;
  /** Runs a change on the host's mutation queue; `kind` and the character say what is about to change. */
  change<T>(kind: RecycleEntryKind | 'delete-character', characterId: string, run: () => Promise<T>): Promise<T>;
  /** After any change: the windows read the bin again (and what came back). */
  changed?(kind: RecycleEntryKind, characterId: string): void;
}

const day = (ms: number) => { const date = new Date(ms); return `${date.getMonth() + 1}月${date.getDate()}日`; };
const NOT_THERE = '回收站里没有这一项（可能已经找回或到期清理了）。';

export interface RecycleHost {
  view(): RecycleBinView;
  /** removeCard: the host's card removal (CharacterResponseService.remove, then switching away from her); it may refuse (the last card). */
  deleteCharacter(characterId: string, forgetMemories: boolean, removeCard: () => Promise<void>): Promise<CharacterRecycleOutcome>;
  deleteMemoryNote(recordId: unknown): Promise<MemoryNoteState>;
  deleteMovingMemory(scope: MemoryScope | null, chosenAt: unknown): Promise<MovingMemoryView | null>;
  deleteListenNote(id: unknown): Promise<ListenTogetherView>;
  /**
   * I-144b: one single deletion (or clear) through the bin. `take` copies what is about to go (null: nothing to keep; the deletion runs as
   * before and reports its own error); the entry is written; then `remove` deletes as before. When `remove` fails (or `removed` says it did
   * not remove anything), the entry is taken out again. While the bin is not ready nothing is deleted.
   */
  recycled<T>(take: () => Promise<ItemTake | null> | ItemTake | null, remove: () => Promise<T> | T, removed?: (result: T) => boolean, entered?: (entry: RecycleSummaryView) => void): Promise<T>;
  restore(entryId: unknown): Promise<{ restored: RecycleSummaryView; failed: string[]; replaced: RecycleSummaryView | null }>;
  deleteForGood(entryId: unknown): Promise<void>;
  setDays(days: unknown): Promise<number>;
}

export function createRecycleHost(deps: RecycleHostDeps): RecycleHost {
  const characterPorts = (removeCard: () => Promise<void> = () => Promise.reject(new Error('角色卡只能从角色页删除。'))) => {
    const stores = deps.stores();
    return { bin: stores.bin, registry: recycleRegistry(stores), providerScopes: (id: string) => deps.providerScopes(id),
      removeCard: () => removeCard(), cardExists: (id: string) => deps.cardExists(id) };
  };
  // An entry whose thing still lives in its own list (the moving memory stays there after "删掉这一件") is finished there when it expires.
  const finalize = async (summary: RecycleSummaryView, data: unknown) => {
    if (summary.part !== 'moving-memory') return;
    const value = data as { providerScope?: unknown; chosenAt?: unknown } | null;
    const moving = deps.stores().movingMemory;
    if (moving && typeof value?.providerScope === 'string' && typeof value.chosenAt === 'number')
      await moving.store.dropVersion({ characterId: summary.characterId, providerScope: value.providerScope }, value.chosenAt);
  };
  deps.bin.finalize = finalize;
  const ensureFinalize = () => deps.bin;
  const told = (kind: RecycleEntryKind, characterId: string) => { try { deps.changed?.(kind, characterId); } catch { /* Status only. */ } };

  return {
    view: () => { const b = ensureFinalize(); return { days: b.retentionDays, entries: b.ready ? b.summaries() : [], ready: b.ready }; },

    deleteCharacter: (characterId, forgetMemories, removeCard) => deps.change('delete-character', characterId, async () => {
      ensureFinalize();
      const outcome = await recycleCharacter(characterId, deps.characterName(characterId), forgetMemories, characterPorts(removeCard));
      told('character', characterId);
      return outcome;
    }),

    deleteMemoryNote: recordId => {
      const scope = deps.currentScope(), stores = deps.stores(), notes = stores.notes;
      if (!scope || !notes) return Promise.reject(new Error('这条笔记不存在或已经删除。'));
      return deps.change('memory-note', scope.characterId, async () => {
        const part = notes.noteCopy(recordId);
        const note = part?.notes?.items[0]?.value;
        if (!part || !note) throw new Error('这条笔记不存在或已经删除。');
        if (!stores.bin.ready) throw new Error('回收站还没准备好，这条笔记没有删，稍后再试。');
        const keyword = await stores.keywords?.entry(scope.characterId, note.recordId).catch(() => null) ?? null;
        const entry = await stores.bin.put({ characterId: scope.characterId, characterName: deps.characterName(scope.characterId), part: 'memory-note', count: 1,
          label: `${day(note.segmentAt)}那段聊天的笔记` }, { kind: 'memory-note', providerScope: scope.providerScope, part, keyword });
        try { const state = await notes.deleteNote(recordId); told('memory-note', scope.characterId); return state; }
        catch (error) { await stores.bin.discard(entry.id).catch(() => {}); throw error; }
      });
    },

    deleteMovingMemory: (scope, chosenAt) => {
      const stores = deps.stores(), moving = stores.movingMemory;
      if (!scope || !moving || typeof chosenAt !== 'number') return Promise.resolve(null);
      return deps.change('moving-memory', scope.characterId, async () => {
        const shown = moving.view(scope).versions.find(version => version.current && version.chosenAt === chosenAt);
        if (!shown) return moving.view(scope);
        if (!stores.bin.ready) throw new Error('回收站还没准备好，这一件没有删，稍后再试。');
        const entry = await stores.bin.put({ characterId: scope.characterId, characterName: deps.characterName(scope.characterId), part: 'moving-memory', count: 1,
          label: `最打动她的那一件（${shown.date}）` }, { kind: 'moving-memory', providerScope: scope.providerScope, chosenAt });
        const deleted = await moving.store.deleteCurrent(scope, chosenAt).catch(error => { void stores.bin.discard(entry.id).catch(() => {}); throw error; });
        if (!deleted) await stores.bin.discard(entry.id).catch(() => {});
        else told('moving-memory', scope.characterId);
        return moving.view(scope);
      });
    },

    deleteListenNote: id => {
      const stores = deps.stores(), listen = stores.listen;
      if (!listen) return Promise.reject(new Error('这条记录不存在或已经删除。'));
      const copy = listen.noteCopy(id);
      if (!copy) return Promise.reject(new Error('这条记录不存在或已经删除。'));
      return deps.change('listen-note', copy.characterId, async () => {
        if (!stores.bin.ready) throw new Error('回收站还没准备好，这条记录没有删，稍后再试。');
        const note = copy.part.item.value;
        const keyword = await stores.keywords?.entry(copy.characterId, note.id).catch(() => null) ?? null;
        const entry = await stores.bin.put({ characterId: copy.characterId, characterName: deps.characterName(copy.characterId), part: 'listen-note', count: 1,
          label: `一起听的一条笔记（${day(note.startedAt)}）` }, { kind: 'listen-note', part: copy.part, keyword });
        try { const view = listen.deleteNote(id); told('listen-note', copy.characterId); return view; }
        catch (error) { await stores.bin.discard(entry.id).catch(() => {}); throw error; }
      });
    },

    recycled: async <T>(take: () => Promise<ItemTake | null> | ItemTake | null, remove: () => Promise<T> | T, removed?: (result: T) => boolean, entered?: (entry: RecycleSummaryView) => void): Promise<T> => {
      const stores = deps.stores();
      if (!stores.bin.ready) throw new Error('回收站还没准备好，这一项没有删，稍后再试。');
      const item = await take();
      if (!item) return await remove();
      const name = item.kind === 'assistant-chat' ? `${ASSISTANT_NAME} 助手` : deps.characterName(item.characterId);
      const entry = await stores.bin.put({ characterId: item.characterId, characterName: name, part: item.kind, count: item.count, label: item.label,
        ...(item.itemAt !== undefined ? { itemAt: item.itemAt } : {}) }, item.data);
      let result: T;
      try { result = await remove(); }
      catch (error) { await stores.bin.discard(entry.id).catch(() => {}); throw error; }
      if (removed && !removed(result)) await stores.bin.discard(entry.id).catch(() => {});
      else { told(item.kind, item.characterId); try { entered?.(entry); } catch { /* status only */ } }
      return result;
    },

    restore: async entryId => {
      const b = ensureFinalize();
      const summary = typeof entryId === 'string' ? b.summaries().find(item => item.id === entryId.toLowerCase()) : undefined;
      if (!summary) throw new Error(NOT_THERE);
      if (summary.part === 'chat' || summary.part === 'profile') {
        await deps.restoreMemoryPart(summary.id);
        told(summary.part, summary.characterId);
        return { restored: summary, failed: [], replaced: null };
      }
      return deps.change(summary.part, summary.characterId, async () => {
        const stores = deps.stores();
        let outcome: { restored: RecycleSummaryView; failed: string[]; replaced: RecycleSummaryView | null };
        if (summary.part === 'character') {
          const result: CharacterRestoreOutcome = await restoreCharacterEntry(summary.id, characterPorts());
          outcome = { restored: result.restored, failed: result.failed, replaced: result.replaced };
        } else {
          const { data } = await stores.bin.read(summary.id);
          const value = data as Record<string, unknown> | null;
          if (!value || value.kind !== summary.part || !isItemKind(summary.part)) throw new Error('回收站里这一项的数据不完整，原文件已保留。');
          // I-144b: what was put there meanwhile goes into a new entry of the same owner first (the restorer says when).
          const replaced = await ITEM_RESTORERS[summary.part](summary, value, { stores, keep: item => stores.bin.put({ characterId: item.characterId,
            characterName: summary.characterName, part: item.kind, count: item.count, label: item.label, ...(item.itemAt !== undefined ? { itemAt: item.itemAt } : {}) }, item.data) });
          await stores.bin.remove(summary.id);
          outcome = { restored: summary, failed: [], replaced };
        }
        told(summary.part, summary.characterId);
        return outcome;
      });
    },

    deleteForGood: async entryId => {
      const b = ensureFinalize();
      const summary = typeof entryId === 'string' ? b.summaries().find(item => item.id === entryId.toLowerCase()) : undefined;
      if (!summary) throw new Error(NOT_THERE);
      await deps.change(summary.part, summary.characterId, () => b.deleteForGood(summary.id));
      told(summary.part, summary.characterId);
    },

    setDays: async days => { const value = await ensureFinalize().setRetentionDays(days); return value; },
  };
}

/**
 * The control window's IPC (control window only). Everything returns the bin's view: names, kinds, counts, times. 「永久删除」 is here and
 * nowhere else: the agent channel can list and find back, never delete for good.
 */
export function registerRecycleIpc(host: (method: string, operation: (...args: any[]) => unknown) => void, recycle: () => RecycleHost | null): void {
  const get = () => { const value = recycle(); if (!value) throw new Error('回收站还没准备好，稍后再试。'); return value; };
  const empty: RecycleBinView = { days: 7, entries: [], ready: false };
  host('getRecycleBin', () => recycle()?.view() ?? empty);
  host('restoreRecycleEntry', async (id: unknown) => {
    const outcome = await get().restore(id);
    return { view: get().view(), failed: outcome.failed.length > 0, replaced: !!outcome.replaced };
  });
  host('deleteRecycleEntryForGood', async (id: unknown) => { await get().deleteForGood(id); return get().view(); });
  host('setRecycleBinDays', async (days: unknown) => { await get().setDays(days); return get().view(); });
}

/**
 * Whether finding an entry of this kind back closes the shown profile first (main.ts activates it again after). The I-144 kinds did; of the
 * I-144b kinds only the profile's own (its file is written back); plans need the profile open (「允许记录」 is read from it), and a chat
 * record or a transcript can bring plans back with it.
 */
export function recycleSuspendsProfile(kind: RecycleEntryKind | 'delete-character'): boolean {
  return ['memory-note', 'moving-memory', 'listen-note', 'profile-entry', 'diary-day', 'diary-all'].includes(kind);
}

/**
 * I-144b: 「清除她记得的歌」 (the control window) and the agent channel's clear_song_memory go through the bin. Same shape as the channel's song
 * bridge: the undo it offers finds the entry back (and is a no-op once the entry has been found back or has expired).
 */
export function songsThroughBin(recycle: () => RecycleHost | null, stores: () => RecycleStores, characterId: () => string):
  { count(): Promise<number>; clear(): Promise<{ count: number; restore(): Promise<void> }> } {
  return {
    count: async () => { const songs = stores().songs, id = characterId(); return songs && id ? songs.count(id) : 0; },
    clear: async () => {
      const host = recycle(), s = stores(), songs = s.songs, id = characterId();
      if (!host || !songs || !id) throw new Error('回收站还没准备好，她记得的歌没有清除，稍后再试。');
      let entryId: string | null = null;
      const outcome = await host.recycled(() => takeSongs(s, id), () => songs.clear(id), result => result.count > 0, entry => { entryId = entry.id; });
      return { count: outcome.count, restore: async () => {
        if (entryId && host.view().entries.some(entry => entry.id === entryId)) await host.restore(entryId);
      } };
    },
  };
}
