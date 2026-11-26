// 记忆's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4d.md).
// Moved from electron/main.ts; the statements are the ones main.ts had. Split by feature (docs/claude/2026-11-17-split-initiative-
// memory-wiring.md); what the other parts import from 记忆's wiring they still import from this file (the feature files' exports are
// re-exported here):
// - memory-profile-wiring.ts: the profile and her diary, her look-backs (I-088), her note (I-134), the thing that moved her most (I-139
//   A3), the plans she remembers (P-001), her chat notes (I-021), recall by meaning (I-111): made by the ready-chain step startMemory.
// - memory-recycle-wiring.ts: 数据地图 / I-144 回收站, what deleting her memories goes through: privacyStores(), recycleStores(),
//   recycleSingle, registerPrivacyStores, the bin and its host (startRecycleBin), the I-014 recoverable wiring.
// - here: MemoryNeeds, 记忆's own data-map registration (registerPrivacyStores('memory', …)), text memorials and their invitation
//   journal (made by the ready-chain step initTextMemorials), and register(): the handlers, inside the agent channel's recorder where
//   main.ts registered them: the chat memory, text memorials, the profile with her diary, plans and look-backs, the moving memory, the
//   nickname, 一起听 records, chat notes, recall by meaning, the bin, and deleting a heard transcript.
// tests/memory-privacy-gates.test.ts and the tests that read the wiring as text (tests/helpers/wiring-source.ts) evaluate it across
// the three files.
// - What the lines read from the rest of the app comes through MemoryNeeds (getters electron/main.ts gives): `const { store } = needs; //
//   read when called` at the top of a function, `needs.<name>` inside a constructor's ports. The functions main.ts calls from its ordered
//   lists (activateUserProfile from saveSettings and the ready chain, initTextMemorials from the ready chain) are made inside wireMemory and
//   handed back (main.ts takes them from memory.provides), so the golden keeps them as calls.
// What stays in electron/main.ts and why (docs/claude/2026-11-16-wiring-step-4d.md): the experience journal and app session (other parts
// record through them while main.ts is evaluated), the order lists (saveSettings, the ready chain, before-quit), the songs' handler (I-077,
// 感知's), the special days (I-059, made beside the keepsakes; 记忆 reads them through needs).
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { MemoryStore, registerMemoryNotesIpc, TEXT_INVITATION_ID_PREFIX, TextMemorialHost, UserProfileSource, type DiaryWriter } from '../memory';
import { registerSemanticControls } from '../memory/memory-semantic/electron-wiring';
import { registerRecycleIpc, songsThroughBin, takeAmbientTranscript, takeChatRecord, takeDiary, takeHerNickname, takeListenRaw, takeNickname, takePlans, takeProfileEntry,
  takeReview, takeTextMemorial, type RecycleStores } from '../memory/recycle-wiring';
import { composeSpeechConfig } from '../mood';
import { characterSpeechPersona } from '../voice';
import { registerListenTogetherIpc } from '../senses';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import { characterTtsConfig } from '../../shared/voice';
import type { SettingsStore } from '../settings';
import type { CharacterCardStore, PersonalizeLanguageStore } from '../cards';
import type { CompanionService } from '../brain';
import { speechBeatsFor } from '../brain'; // 边说边演: her beats follow her chat records (docs/claude/2026-11-20-speech-beats-leftovers.md)
import type { AppJournal } from '../memory';
import type { CharacterCard } from '../../shared/cards';
import { broadcast, windows } from './shell-wiring';
import type { RecoverableMemoryWiring } from './safety-wiring';
import { ambientComments, ambientStore, listenTogether, userInputUntil, watchTogether } from './senses-wiring';
import type { VoiceNeeds } from './voice-wiring';
import type { ReplySpeechStyles } from '../mood';
import type { PartIpc } from './ipc-wiring';
import type { PartHandle } from './parts-wiring';
import { herNote, memoryNotes, movingMemory, semantic, upcoming, userProfileManagement, userProfiles, wireMemoryProfile } from './memory-profile-wiring';
import { registerCharacterArchive } from './character-archive-wiring';
import { field, privacyRefusal, recycleHost, recycleSingle, recycleStores, registerPrivacyStores, wireMemoryRecycle } from './memory-recycle-wiring';

type DiaryOptions = ConstructorParameters<typeof DiaryWriter>[0];
type TextMemorialOptions = ConstructorParameters<typeof TextMemorialHost>[0];

/** What 记忆's lines read from the rest of the app (electron/main.ts gives getters; a value is read when it is used). */
export interface MemoryNeeds {
  readonly store: SettingsStore;
  readonly companion: CompanionService;
  readonly characterCards: CharacterCardStore;
  readonly personalizeLanguage: PersonalizeLanguageStore | undefined;
  readonly controls: BrowserWindow | null;
  readonly pet: BrowserWindow | null;
  readonly petReply: ReturnType<TextMemorialOptions['surface']>;
  readonly petWindowDrag: { readonly active: boolean } | null;
  readonly exiting: boolean;
  readonly pending: ReadonlyMap<unknown, { readonly kind: string; readonly controller: AbortController }>;
  readonly proactiveSpeechGate: TextMemorialOptions['gate'] & { cancel(reason: 'delete'): void; readonly busy: boolean };
  readonly replySpeechStyles: ReplySpeechStyles;
  readonly speechRuntime: { stop(): void; cancelReply(owner: number, id: string): unknown };
  readonly speechPlaybackActivity: { readonly busy: boolean };
  readonly ambientSpeakingOwners: { readonly size: number };
  readonly voiceHost: { readonly busy: boolean };
  readonly foregroundAsr: { readonly busy: boolean };
  readonly innerLoopHost: { readonly loop: { quietNow(): { readonly asleep?: boolean } } };
  readonly mutations: { run<T>(operation: () => Promise<T>, guard?: Parameters<RecoverableMemoryWiring['change']>[3]): Promise<T> };
  readonly LONG_CHAT: { readonly enabled: boolean };
  readonly appJournal: AppJournal;
  // what the diary and the plans read of other parts (G1, I-019, I-087), and 记忆's special days (I-059, still made by electron/main.ts)
  readonly rps: { readonly host: { diaryLine: NonNullable<DiaryOptions['games']> extends (scope: never, ...rest: infer A) => infer R ? (characterId: string, ...rest: A) => R : never } };
  readonly feeding: { readonly host: { diaryLine: NonNullable<DiaryOptions['feeds']> extends (scope: never, ...rest: infer A) => infer R ? (characterId: string, ...rest: A) => R : never } };
  readonly hands: { readonly host: { planNoted(via: 'note' | 'early' | undefined): void } } | null;
  readonly specialDay: NonNullable<RecycleStores['specialDay']>;
  // the other parts' functions
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  speechScope(): string;
  stopSystemAudio(): void;
  clearVisionContext(): void;
  refreshVisionContext(): unknown;
  clearReplySpeech(): void;
  cancelReplyStyle(id: string): void;
  replySpeechBusy(): boolean;
  completedFatigueFeeling(identity: string, cardId: string): ReturnType<VoiceNeeds['completedFatigueFeeling']>;
  syncCharacter(applyModel: boolean, previousCard: CharacterCard): Promise<unknown>;
  journalCharacterId(): string | null;
  recentLines(): string[];
}

/** What other parts call (main.ts takes these from memory.provides, so its ordered lists keep them as calls). */
export interface MemoryProvides {
  activateUserProfile(): Promise<void>;
  initTextMemorials(): Promise<void>;
  songsBin: ReturnType<typeof songsThroughBin>;
}

// ---- state other parts read (live bindings electron/main.ts imports) ----
export { userProfiles, userProfileManagement, userProfileContext, diaryWriter, reviewWriter, herNote, movingMemory, memoryNotes, semantic, upcoming,
  currentProfileMessage, acceptProfileMessage, startMemory } from './memory-profile-wiring';
export let userProfileSource!: UserProfileSource;
export let textMemorialHost: TextMemorialHost | null = null;
export let textInvitationMemory: MemoryStore | null = null;
export let textInvitationMemoryError = '';
export { recycleBin, recycleHost, RECYCLE_STORE_OWNERS, RECORDING_OFF_STORE_OWNERS, registerPrivacyStores, privacyStores, recycleStores, recycleSingle, field,
  startRecycleBin, type StoreOwner, type OwnedStores } from './memory-recycle-wiring';

// Set by wireMemory (while electron/main.ts is evaluated, before anything below runs).
let needs!: MemoryNeeds;
/** startRecycleBin reads it (memory-recycle-wiring.ts): the profile is activated again after a deletion that suspended it. */
export let activateProfile!: () => Promise<void>;

// ---- 数据地图: what the other parts' wiring takes from 记忆 (each part's registerPrivacyStores is in memory-recycle-wiring.ts) ----
export type { RecycleStores } from '../memory/recycle-wiring'; // the other parts' wiring types the stores they hand over with it
// 主动's wiring (electron/wiring/initiative-wiring.ts, step 4e) makes I-059's special days beside the keepsakes and deletes one of 我们的小东西
// into the bin: 记忆's own modules, handed over here so that wiring reaches into no other part's inside.
export { createSpecialDay } from '../memory/special-day/wiring';
export { takeCardMilestone, takeObjectNote, takeOurThing } from '../memory/recycle-wiring';
export function wireMemory(given: MemoryNeeds): PartHandle<MemoryProvides> & { register(ipc: PartIpc): void } {
  needs = given;
  // The feature files read the same needs (memory-profile-wiring.ts, memory-recycle-wiring.ts).
  wireMemoryProfile(given); wireMemoryRecycle(given);
  // 数据地图: the stores 记忆 owns (keywords live in 一起看's timeline, special days are still made by electron/main.ts: read through them).
  registerPrivacyStores('memory', {
    recycle: () => { const { companion, specialDay } = needs; /* read when called */ return { memory: companion.memory, textInvitations: textInvitationMemory, notes: memoryNotes, keywords: watchTogether?.keywords ?? null,
      semantic: semantic?.recall ?? null, profiles: userProfiles ?? null, upcoming, herNote: herNote?.store ?? null, movingMemory: movingMemory ?? null, relationship: companion.relationship,
      specialDay, textMemorials: textMemorialHost ?? null, upcomingStore: userProfiles?.companionStores().upcoming ?? null, reviews: userProfiles?.companionStores().reviews ?? null,
      speechBeats: speechBeatsFor(needs.store.directory).archive }; }, // 边说边演: her beats follow her chat records
    recordingOff: () => { const { companion } = needs; /* read when called */ return { memory: companion.memory, profiles: userProfiles, relationship: companion.relationship, herNote: herNote?.store,
      movingMemory: movingMemory?.store, semantic: semantic?.recall, upcoming }; },
  });
  userProfileSource = new UserProfileSource();
  async function activateUserProfile(): Promise<void> {
    if (!userProfileManagement) return;
    try {
      const scope = needs.companion.currentScope();
      await userProfileManagement.activate({ characterId: scope.characterId, providerScope: scope.providerScope });
      textMemorialHost?.sync();
    } catch { /* Optional profile availability cannot reject ordinary chat or startup. */ }
  }
  activateProfile = activateUserProfile;
  function textMemorialEligible():boolean {
    const { companion, store, pet, petWindowDrag, pending } = needs; // read when called
    return !!textInvitationMemory && !!companion && !!store && !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized()
      && !petWindowDrag?.active && Date.now() >= userInputUntil
      && companion.mood.get().snapshot.phase === 'idle'
      && ![...pending.values()].some(task=>task.kind==='chat');
  }
  async function initTextMemorials():Promise<void> {
    const { store, companion, characterCards, proactiveSpeechGate, speechScope, replySpeechStyles, completedFatigueFeeling, speechRuntime, cancelReplyStyle } = needs; // made before the ready chain runs this, never replaced
    const archive = new MemoryStore(store.directory, 'text-invitations');
    try { await archive.load(); textInvitationMemory = archive; textInvitationMemoryError = ''; }
    catch { textInvitationMemory = null; textInvitationMemoryError = '主动邀请记录无法读取，原文件已保留；本次不会展示新的纪念邀请。'; }
    textMemorialHost=new TextMemorialHost({
      directory:path.join(store.directory,'text-memorials'),gate:proactiveSpeechGate,
      scope:()=>{try{const scope=companion.currentScope();return scope.characterId===characterCards.getActive().id&&scope.providerScope===memoryProviderScope(store.current.provider)?scope:null;}catch{return null;}},
      identity:speechScope,gateScope:()=>`${speechScope()}:${companion.mood.get().token}`,
      owner:()=>{const pet=needs.pet;return pet&&!pet.isDestroyed()?pet.webContents.id:null;},surface:()=>needs.petReply,eligible:textMemorialEligible,
      event:event=>broadcast('desk:text-memorial-event',event),changed:view=>broadcast('desk:text-memorials-changed',view),
      archive:async(offer,at,current)=>{
        if (!textInvitationMemory) throw new Error('主动邀请记录尚未就绪。');
        const identity = speechScope(), scope = companion.currentScope();
        await textInvitationMemory.appendInitiative(scope,{id:offer.id,text:offer.invite,at,
          origin:{kind:'proactive',id:offer.id,at,sources:['text'],labels:['本次文字纪念邀请']}},
          () => current() && !needs.exiting && identity === speechScope());
        broadcast('desk:memory-changed',undefined);
      },
      freezeSpeech:(owner,offer)=>{
        const identity=speechScope(),card=characterCards.getActive(),snapshot=companion.mood.get().snapshot;
        const mood={primary:snapshot.primary,context:snapshot.context};
        const config=characterTtsConfig(store.current, card);
        replySpeechStyles.begin(owner,offer.id,identity);
        replySpeechStyles.complete(owner,offer.id,identity,mood,composeSpeechConfig(config,mood,characterSpeechPersona(card),completedFatigueFeeling(identity,card.id)));
      },
      cancelSpeech:id=>{for(const win of windows())speechRuntime.cancelReply(win.webContents.id,id);cancelReplyStyle(id);},
    });
    textMemorialHost.sync();
  }
  /** A fixed opaque selector chooses only the current profile's two known journals. */
  function managedMemory(id:unknown):{memory:MemoryStore;id:string;invitation:boolean} {
    const { companion } = needs; // read when called
    if (typeof id !== 'string' || !id || id.length > 256 || id.includes('\0')) throw new Error('记忆记录编号不正确。');
    if (!id.startsWith(TEXT_INVITATION_ID_PREFIX)) return {memory:companion.memory,id,invitation:false};
    const local = id.slice(TEXT_INVITATION_ID_PREFIX.length);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(local)
      || companion.memory.read(companion.currentScope(),id)) throw new Error('主动邀请记录编号不正确。');
    if (!textInvitationMemory) throw new Error(textInvitationMemoryError || '主动邀请记录尚未就绪。');
    return {memory:textInvitationMemory,id:local,invitation:true};
  }
  const songsBin = songsThroughBin(() => recycleHost, () => recycleStores(), () => needs.companion?.mood.get().characterId ?? ''); // I-144b: 「清除她记得的歌」 and clear_song_memory

  return {
    id: 'memory',
    units: ['user-profiles', 'diary', 'period-review', 'her-note', 'moving-memory', 'text-memorials', 'upcoming', 'memory-semantic', 'memory-notes', 'recycle-bin'],
    /** Overhaul step 7: the recycle bin stays fatal (every deletion goes through it; the agent channel and the card handlers are made with it). */
    core: ['recycle-bin'],
    ipc: { 'user-profiles': ['getUserProfile', 'setUserProfileEnabled', 'editUserProfile', 'deleteUserProfile', 'editUserDiary', 'deleteUserDiary', 'clearUserDiary', 'deleteUserUpcoming', 'clearUserUpcoming', 'editUserReview', 'deleteUserReview'],
      'text-memorials': ['getCurrentTextMemorialOffer', 'acknowledgeTextMemorial', 'getTextMemorials', 'editTextMemorial', 'deleteTextMemorial'],
      'memory-semantic': ['getSemanticRecall', 'setSemanticRecall', 'retrySemanticDownload', 'cancelSemanticDownload', 'removeSemanticRecall'],
      'memory-notes': ['readMemoryNote', 'deleteMemoryNote', 'getPeopleThings', 'changePeopleThings'], 'moving-memory': ['getMovingMemory', 'deleteMovingMemory', 'restoreMovingMemory'] },
    provides: { activateUserProfile, initTextMemorials, songsBin },
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      // What the handlers read: set before the ready chain registers (registerIPC) and not replaced later.
      const { companion, mutate, speechScope, stopSystemAudio, proactiveSpeechGate, clearVisionContext, speechRuntime, clearReplySpeech, refreshVisionContext, pending } = needs;
      registerCharacterArchive(ipc, needs); // I-208: the character page's 档案 (read only)
      scopedHost('getMovingMemory', () => movingMemory?.view(userProfileManagement?.get() ? companion.currentScope() : null) ?? { active: false, versions: [] }, true); // I-139 A3: the control page's view, delete and restore
      scopedHost('deleteMovingMemory', async (_sender, chosenAt) => { const scope = userProfileManagement?.get() ? companion.currentScope() : null; return (recycleHost && movingMemory?.view(scope).active ? await recycleHost.deleteMovingMemory(scope, chosenAt) : null) ?? movingMemory?.view(scope) ?? { active: false, versions: [] }; }, true); // I-144: into the recycle bin; // the version the window showed, by chosenAt
      scopedHost('restoreMovingMemory', (_sender, chosenAt) => movingMemory?.restore(userProfileManagement?.get() ? companion.currentScope() : null, chosenAt) ?? { active: false, versions: [] }, true);
      host('listMemories', query => {
        const page = companion.memory.list(companion.currentScope(), query, Date.now(), textInvitationMemory ?? undefined);
        if (textInvitationMemoryError) page.notice = [page.notice, textInvitationMemoryError].filter(Boolean).join(' ');
        return page;
      });
      host('readMemory', (id, query) => {
        const selected = managedMemory(id), record = selected.memory.read(companion.currentScope(), selected.id, query);
        if (!record) throw new Error('聊天记录不存在或不属于当前角色和连接。');
        return selected.invitation ? {...record,id} : record;
      });
      host('editMemory', async (id, edit) => {
        const selected = managedMemory(id), scope = companion.currentScope(), identity = speechScope();
        if (selected.invitation) {
          if (!selected.memory.read(scope,selected.id)) throw new Error('主动邀请记录不属于当前角色和连接。');
          textMemorialHost?.cancel();
        }
        await selected.memory.edit(scope, selected.id, edit, selected.invitation ? () => !needs.exiting && identity === speechScope() : undefined); void movingMemory?.prune(scope); // I-139 A3: a bookmark whose words are no longer in her records goes
        broadcast('desk:memory-changed', undefined);
      });
      host('deleteMemory', id => mutate(() => recycleSingle(() => { const selected = managedMemory(id); return takeChatRecord(recycleStores(), companion.currentScope(), selected.id, selected.invitation ? 'text-invitations' : 'conversation'); }, async () => { // I-144b: into the recycle bin first
        const selected = managedMemory(id), scope = companion.currentScope(), record = selected.memory.read(scope, selected.id);
        if (selected.invitation && !record) throw new Error('主动邀请记录不属于当前角色和连接。');
        textMemorialHost?.cancel();
        if (selected.invitation) {
          const identity = speechScope();
          await selected.memory.delete(scope,selected.id,() => !needs.exiting && identity === speechScope());
          broadcast('desk:memory-changed', undefined);
          return;
        }
        stopSystemAudio(); proactiveSpeechGate.cancel('delete');
        clearVisionContext();
        speechRuntime.stop();
        clearReplySpeech();
        for (const task of pending.values()) if (task.kind === 'chat') task.controller.abort();
        const removed = companion.removeMemory(id, record?.origin?.sources.includes('ambient') ? async currentScope => {
          await ambientStore.deleteComment(currentScope, record.origin!.id);
          broadcast('desk:ambient-changed', undefined);
        } : undefined);
        broadcast('desk:chat-reset', undefined);
        await removed; void movingMemory?.prune(scope); // I-139 A3: the bookmark does not outlive the record it quotes
        refreshVisionContext();
        broadcast('desk:memory-changed', undefined);
      })));
      host('getMemoryConfig', () => companion.memory.getConfig());
      host('getCurrentTextMemorialOffer', () => textMemorialHost?.getOffer() ?? {revision:0,offer:null}, false);
      scopedHost('acknowledgeTextMemorial', (sender, value) => textMemorialHost?.acknowledge(sender,value) ?? null, false);
      host('getTextMemorials', () => textMemorialHost?.get() ?? null, false);
      host('editTextMemorial', value => {if(!textMemorialHost)throw Error('文字纪念尚未就绪。');return textMemorialHost.edit(value);}, false);
      host('deleteTextMemorial', value => {if(!textMemorialHost)throw Error('文字纪念尚未就绪。');const memorials=textMemorialHost;return recycleSingle(() => takeTextMemorial(recycleStores(), field(value, 'id')), () => memorials.delete(value));}, false); // I-144b: into the recycle bin first
      scopedHost('getUserProfile', () => userProfileManagement?.get() ?? null, false);
      scopedHost('setUserProfileEnabled', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        if (field(request, 'enabled') === false) { const refused = privacyRefusal(); if (refused) throw refused; } // step 7: 「允许记录」 off clears everything or nothing
        return userProfileManagement.setEnabled(request);
      }, false);
      scopedHost('editUserProfile', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        return userProfileManagement.edit(request);
      }, false);
      scopedHost('deleteUserProfile', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        const profiles = userProfileManagement; return recycleSingle(() => takeProfileEntry(recycleStores(), companion.currentScope(), field(request, 'id')), () => profiles.delete(request)); // I-144b
      }, false);
      scopedHost('editUserDiary', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        return userProfileManagement.editDiary(request);
      }, false);
      scopedHost('deleteUserDiary', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        const profiles = userProfileManagement; return recycleSingle(() => takeDiary(recycleStores(), companion.currentScope(), field(request, 'date')), () => profiles.deleteDiary(request)); // I-144b
      }, false);
      scopedHost('clearUserDiary', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        const profiles = userProfileManagement; return recycleSingle(() => takeDiary(recycleStores(), companion.currentScope(), '*'), () => profiles.clearDiary(request)); // I-144b
      }, false);
      scopedHost('deleteUserUpcoming', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        const profiles = userProfileManagement; return recycleSingle(() => takePlans(recycleStores(), companion.currentScope(), field(request, 'id')), () => profiles.deleteUpcoming(request)); // I-144b
      }, false);
      scopedHost('clearUserUpcoming', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        const profiles = userProfileManagement; return recycleSingle(() => takePlans(recycleStores(), companion.currentScope(), '*'), () => profiles.clearUpcoming(request)); // I-144b
      }, false);
      scopedHost('editUserReview', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        return userProfileManagement.editReview(request);
      }, false);
      scopedHost('deleteUserReview', (_sender, request) => {
        if (!userProfileManagement) throw Error('用户画像暂时不可用。');
        const profiles = userProfileManagement; return recycleSingle(() => takeReview(recycleStores(), companion.currentScope(), field(request, 'kind'), field(request, 'key')), () => profiles.deleteReview(request)); // I-144b
      }, false);
      host('setMemoryConfig', async config => { await companion.memory.configure(config); });
      host('getRelationshipNickname', async () => {
        if (!companion) return null;
        const id = companion.mood.get().characterId;
        await companion.relationship.ensure(id);
        return companion.relationship.nickname(id);
      }, false);
      host('setRelationshipNickname', async value => {
        if (!companion) throw Error('关系数据暂时不可用。');
        const characterId = companion.mood.get().characterId;
        return value === null ? recycleSingle(() => takeNickname(recycleStores(), characterId), () => companion.relationship.setNickname(characterId, null)) : companion.relationship.setNickname(characterId, value); // I-144b: deleting it goes into the recycle bin first
      }, false);
      host('setRelationshipStage', stage => { companion.relationship.setStageOverride(stage); }, false);
      // Unbound v1 step 3: the nickname table (her real name, what you call her, what she calls you); removing one goes into the bin first.
      host('getNicknameTable', async () => {
        const characterId = companion.mood.get().characterId;
        await companion.relationship.ensure(characterId);
        return { herName: needs.characterCards.getActive().id === characterId ? needs.characterCards.getActive().name ?? null : null,
          herNicknames: companion.relationship.herNicknames(characterId), userNickname: companion.relationship.nickname(characterId) };
      }, false);
      host('addHerNickname', async value => {
        const characterId = companion.mood.get().characterId;
        await companion.relationship.ensure(characterId);
        if (await companion.relationship.addHerNickname(characterId, value) === 'invalid') throw Error('称呼需要是 1 到 8 个字的普通文字。');
        return companion.relationship.herNicknames(characterId);
      });
      host('removeHerNickname', async value => {
        const characterId = companion.mood.get().characterId;
        await companion.relationship.ensure(characterId);
        await recycleSingle(() => takeHerNickname(recycleStores(), characterId, value), () => companion.relationship.removeHerNickname(characterId, value));
        return companion.relationship.herNicknames(characterId);
      });
      registerListenTogetherIpc(host, () => listenTogether, id => recycleHost ? recycleHost.deleteListenNote(id) : Promise.reject(new Error('回收站还没准备好，这条记录没有删。')), () => recycleSingle(() => takeListenRaw(recycleStores(), companion.currentScope().characterId), () => listenTogether!.clearRaw())); // I-144b: 「清空原文」 too // I-144: into the recycle bin; // I-016: the control window's 一起听 records
      registerMemoryNotesIpc(host, () => memoryNotes, id => recycleHost ? recycleHost.deleteMemoryNote(id) : Promise.reject(new Error('回收站还没准备好，这条笔记没有删。'))); registerRecycleIpc(host, () => recycleHost); // I-144: into the recycle bin; // I-021: one memory's note in 聊天记忆 (read, delete)
      registerSemanticControls(host, () => semantic?.host ?? null); // I-111: the recall-by-meaning switch in 聊天记忆
      host('deleteAmbientTranscript', id => mutate(() => recycleSingle(() => { const scope = companion.currentScope(); return takeAmbientTranscript(recycleStores(), scope, String(id), ambientStore.comments(scope, String(id)).flatMap(comment => { const handle = companion.memory.findInitiative(scope, comment.id); return handle ? [handle.recordId] : []; })); }, async () => { // I-144b: into the recycle bin first
        const scope = companion.currentScope();
        stopSystemAudio(); proactiveSpeechGate.cancel('delete');
        clearVisionContext();
        speechRuntime.stop(); clearReplySpeech();
        for (const task of pending.values()) if (task.kind === 'chat') task.controller.abort();
        // Invalidate the old conversation before storage awaits. A new user turn
        // accepted after this boundary must never be reset by a late deletion.
        userProfileManagement?.cancelPending();
        const reset = companion.newConversation();
        broadcast('desk:chat-reset', undefined);
        await reset;
        refreshVisionContext();
        // Remove duplicate normal-chat comment archives first. On failure the source
        // transcript remains available for a visible retry rather than a false success.
        for (const comment of ambientStore.comments(scope, id)) {
          const handle = companion.memory.findInitiative(scope, comment.id);
          if (handle) await companion.memory.delete(scope, handle.recordId);
        }
        const result = await ambientStore.delete(scope, id);
        ambientComments?.clear(); broadcast('desk:ambient-changed', undefined); broadcast('desk:memory-changed', undefined);
        return result;
      }, result => result.deleted)));
    },
  };
}