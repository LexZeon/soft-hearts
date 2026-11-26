// 记忆's wiring, what she remembers about the user (split from electron/wiring/memory-wiring.ts,
// docs/claude/2026-11-17-split-initiative-memory-wiring.md): the profile and her diary, her look-backs (I-088), her note (I-134), the
// thing that moved her most (I-139 A3), the plans she remembers (P-001), her chat notes (I-021) and recall by meaning (I-111), made by the
// ready-chain step startMemory (top-level, so the wiring golden reads its statements in place); whether a user message may go into the
// profile (currentProfileMessage, acceptProfileMessage). The statements are the ones memory-wiring.ts had. The state is re-exported
// by memory-wiring.ts (live bindings electron/main.ts and the other parts read). wireMemory hands this file its needs first.
// No module-level side effects: nothing here runs on import.
import path from 'node:path';
import { DiaryWriter, generateDiaryWithClaude, MemoryNotes, ProfileUpcomingBook, UpcomingHost, UpcomingStore, UserProfileContext, UserProfileManagement, UserProfileStore,
  userProfileScopeId, type PeriodReviewWriter, type UserProfileAcceptance } from '../memory';
import { createHerNote, type HerNoteHost } from '../memory/her-note/wiring';
import { createMovingMemory, type MovingMemoryHost } from '../memory/moving-memory/wiring';
import { createPeriodReviewWriter, createReviewStore, reviewRecallSource } from '../memory/period-review/wiring';
import { createSemanticOrNull, type SemanticParts } from '../memory/memory-semantic/electron-wiring';
import { recordingOffRegistry, runRecordingOff } from '../memory/privacy-wiring';
import { claudeCallsInFlight, chatAvailability } from '../brain';
import { quickLineWithClaude } from '../initiative';
import { SYSTEM_FATIGUE_CLOCK } from '../mood';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import { getPromptSwitches } from '../../shared/brain';
import { cardLanguageOf, compileCharacterPersona } from '../../shared/cards';
import { personalizeLanguageContext } from '../../shared/cards';
import type { UserProfileExpected } from '../../shared/memory';
import type { SettingsStore } from '../settings';
import type { CompanionService } from '../brain';
import { broadcast } from './shell-wiring';
import { asrTask, userInputUntil, watchTogether } from './senses-wiring';
import { privacyStores } from './memory-recycle-wiring';
import { startUnit, startUnitSync } from './parts-wiring';
import type { MemoryNeeds } from './memory-wiring';

// ---- state other parts read (re-exported by memory-wiring.ts; live bindings electron/main.ts imports) ----
export let userProfiles: UserProfileStore | undefined;
export let userProfileManagement: UserProfileManagement | undefined;
export let userProfileContext: UserProfileContext | undefined;
/** L3 diary (electron/memory/diary/); the inner loop may call diaryWriter?.recentDiaryPoints(scope, now, maxChars). */
export let diaryWriter: DiaryWriter | undefined;
export let reviewWriter: PeriodReviewWriter | undefined; // I-088 第 1 条: her weekly and monthly look-backs (electron/memory/period-review/)
/** I-134 step 3: her nightly note about the user (electron/memory/her-note/). The chat session's openingNote reads herNote?.noteFor(scope). */
export let herNote: HerNoteHost | undefined;
/** I-139 A3: the thing that moved her most (electron/memory/moving-memory/); read only while getPromptSwitches().relaxed is true. */
export let movingMemory: MovingMemoryHost | undefined;
export let memoryNotes: MemoryNotes | null = null; // I-021: electron/memory/memory-notes/
export let semantic: SemanticParts | null = null; // I-111: electron/memory/memory-semantic/
export let upcoming: UpcomingHost | null = null; // P-001: electron/memory/upcoming/ (the plans she remembers, step 1)

// Set by wireMemory (while electron/main.ts is evaluated, before anything below runs).
let needs!: MemoryNeeds;
/** wireMemory calls this first: the needs startMemory reads. */
export function wireMemoryProfile(given: MemoryNeeds): void { needs = given; }

export function currentProfileMessage(expected?: UserProfileExpected): boolean {
  const view = userProfileManagement?.get();
  return !!view?.enabled && !!expected && view.scopeId === expected.scopeId
    && view.generation === expected.generation && view.revision === expected.revision;
}
export function acceptProfileMessage(id: string, text: string, source: 'text' | 'voice-final', expected?: UserProfileExpected): UserProfileAcceptance | null {
  if (!userProfiles || !userProfileManagement?.get()) return null;
  if (userProfileManagement.get()?.enabled && !currentProfileMessage(expected)) return null;
  try { return userProfiles.acceptUserMessage({ requestId: id, messageId: id, source, text, acceptedAt: Date.now() }); }
  catch { return null; } // Unsupported/long input is not silently truncated into a different source.
}

/**
 * Ready-chain step (记忆): the profile with her diary, her look-backs, her note, the thing that moved her most, then (after the profile is
 * active, the text memorials are loaded, R20 and 一起听 are made) the plans she remembers, recall by meaning and her chat notes. The
 * parameters keep the names the ready chain had (the wiring golden reads these statements in place).
 */
export async function startMemory(store: SettingsStore, companion: CompanionService, activateUserProfile: () => Promise<void>, initTextMemorials: () => Promise<void>,
  initR20ProactiveOffers: () => void, initAmbientAudio: () => Promise<void>, directory: string): Promise<void> {
  // P-001: the plans she remembers are files of their own beside the profile files (never part of them, so a previous build reads the profiles as ever).
  const upcomingStore = new UpcomingStore(path.join(store.directory, 'user-profiles'), { recording: () => userProfileManagement?.get()?.enabled === true });
  const reviewStore = createReviewStore(path.join(store.directory, 'user-profiles'), () => userProfileManagement?.get()?.enabled === true); // I-088 第 1 条: their own files beside the profile files
  userProfiles = new UserProfileStore(path.join(store.directory, 'user-profiles'), {
    onInvalidated: () => { userProfileContext?.invalidate(); }, upcoming: upcomingStore, reviews: reviewStore,
  });
  userProfileContext = new UserProfileContext(userProfiles);
  userProfileManagement = new UserProfileManagement(userProfiles, view => { broadcast('desk:user-profile-changed', view); diaryWriter?.tick(); reviewWriter?.tick(); }, () => {
    try {
      const scope = companion.currentScope();
      return scope.characterId === needs.characterCards.getActive().id && scope.providerScope === memoryProviderScope(store.current.provider)
        ? { characterId: scope.characterId, providerScope: scope.providerScope } : null;
    } catch { return null; }
  }, (scope, reason) => { runRecordingOff(recordingOffRegistry(privacyStores()), scope, reason); }); // 数据地图: G1 / I-019 / P-001 / I-134 / I-139 / I-087 privacy, every recordingOff 'delete' row of electron/foundation/data-map.ts (match counts and what she was fed also when the diary is cleared)
  diaryWriter = new DiaryWriter({ profiles: userProfiles, scope: () => userProfileManagement?.get() ? companion.currentScope() : null,
    messages: (scope, start, end) => companion.memory.conversationMessages(scope, start, end),
    character: scope => { const card = needs.characterCards.getActive(); return card.id !== scope.characterId ? null
      : { persona: compileCharacterPersona(card), language: personalizeLanguageContext(needs.personalizeLanguage?.effectiveProfile(card.id)) }; },
    model: () => store.current.provider.kind === 'claude' ? store.current.provider.model : null,
    generate: (request, signal) => generateDiaryWithClaude(request, signal),
    herLife: (scope, start, end) => companion.herLife.diaryLine(scope.characterId, start, end, SYSTEM_FATIGUE_CLOCK.localMinute),
    games: (scope, start, end) => needs.rps.host.diaryLine(scope.characterId, start, end), // G1 猜拳: what they played that day
    feeds: (scope, start, end) => needs.feeding.host.diaryLine(scope.characterId, start, end), // I-019: what the user fed her that day
    written: date => { userProfileManagement?.publishCurrent(); try { companion.mood.moments.note('diary', companion.currentScope().characterId, date); } catch { /* 心情第二批: writing it down eases C a little */ } try { void companion.relationship.noteQuality(companion.currentScope().characterId, date); } catch { /* A moment that changed scope is not counted. */ } } });
  reviewWriter = createPeriodReviewWriter({ profiles: userProfiles, store: reviewStore, scope: () => userProfileManagement?.get() ? companion.currentScope() : null, // I-088 第 1 条: one call a week and one a month, the diary's model and path
    notes: (scope, start, end) => memoryNotes?.notesBetween(scope, start, end) ?? [],
    character: scope => { const card = needs.characterCards.getActive(); return card.id !== scope.characterId ? null
      : { persona: compileCharacterPersona(card), language: personalizeLanguageContext(needs.personalizeLanguage?.effectiveProfile(card.id)), english: cardLanguageOf(card) === 'en' }; },
    model: () => store.current.provider.kind === 'claude' ? store.current.provider.model : null,
    generate: (request, signal) => generateDiaryWithClaude(request, signal), diaryBusy: () => diaryWriter?.busy === true,
    changed: () => userProfileManagement?.publishCurrent(), journal: entry => { if (entry) needs.appJournal.record(entry); } });
  herNote = createHerNote(path.join(store.directory, 'user-profiles'), { // I-134 step 3: consent is the diary's "允许记录" (the diary ticket); one call a day at most, the diary's model, no tools
    enabled: () => needs.LONG_CHAT.enabled, // I-134: the note is written only where the new chat is on (development, source runs)
    profiles: userProfiles, scope: () => userProfileManagement?.get() ? companion.currentScope() : null,
    messages: (scope, start, end) => companion.memory.conversationMessages(scope, start, end),
    character: scope => { const card = needs.characterCards.getActive(); return card.id !== scope.characterId ? null : { persona: compileCharacterPersona(card) }; },
    model: () => store.current.provider.kind === 'claude' ? store.current.provider.model : null,
    lastChatAt: () => { const at = companion.mood.get().snapshot.lastInteractionAt; return typeof at === 'number' ? at : null; } });
  movingMemory = createMovingMemory(path.join(store.directory, 'user-profiles'), { // I-139 A3: the diary's "允许记录" is the consent; at most one short call a day, in the background, her note's model and path
    enabled: () => getPromptSwitches().relaxed === true,
    profiles: userProfiles, scope: () => userProfileManagement?.get() ? companion.currentScope() : null,
    messages: (scope, start, end) => companion.memory.conversationMessages(scope, start, end),
    character: scope => { const card = needs.characterCards.getActive(); return card.id !== scope.characterId ? null : { persona: compileCharacterPersona(card), english: cardLanguageOf(card) === 'en' }; },
    model: () => store.current.provider.kind === 'claude' ? store.current.provider.model : null,
    busy: () => claudeCallsInFlight() > 0 || needs.pending.size > 0 });
  companion.memory.setReviewRecall(reviewRecallSource(reviewStore)); // her look-backs are offered as a memory when the user's words point at one
  // Overhaul step 7: each unit's start runs through the part runner (one failing is switched off alone; electron/wiring/parts-wiring.ts).
  await startUnit('memory', 'user-profiles', () => activateUserProfile());
  await startUnit('memory', 'text-memorials', () => initTextMemorials());
  startUnitSync('initiative', 'r20-offers', () => initR20ProactiveOffers());
  await startUnit('senses', 'ambient-audio', () => initAmbientAudio());
  // P-001 step 1: marks a chat segment "may record" while the switch is on, and keeps what she remembers of the user's plans (electron/memory/upcoming/).
  // The notebook and the plan memory's early look (two quiet minutes after a plan is said) share one set of gates.
  const noteGate = { userBusy: () => {
      const { exiting, pending, replySpeechBusy, speechPlaybackActivity, ambientSpeakingOwners, proactiveSpeechGate, voiceHost, foregroundAsr } = needs; // read when called
      return exiting || pending.size > 0 || Date.now() < userInputUntil || replySpeechBusy() || speechPlaybackActivity.busy || ambientSpeakingOwners.size > 0
      || proactiveSpeechGate.busy || voiceHost.busy || foregroundAsr.busy || !!asrTask; },
    modelBusy: () => claudeCallsInFlight() > 0 || !chatAvailability.isAvailable(),
    lastActivityAt: () => companion.mood.get().snapshot.lastInteractionAt };
  await startUnit('memory', 'upcoming', async () => {
  upcoming = new UpcomingHost({ directory: path.join(store.directory, 'user-profiles'), book: new ProfileUpcomingBook(upcomingStore, () => userProfileManagement?.get()?.scopeId ?? null), recording: () => userProfileManagement?.get()?.enabled === true,
    scopeOf: key => { try { const owner = companion.memory.ownerOfScope(key); return owner ? userProfileScopeId(owner) : null; } catch { return null; } }, changed: () => userProfileManagement?.publishCurrent(),
    ask: { hour: () => new Date().getHours(), asleep: () => needs.innerLoopHost.loop.quietNow().asleep === true, userState: () => companion.userState.current(companion.mood.get().characterId)?.state ?? null }, // P-001 steps 2-3
    early: { archive: companion.memory, write: async (prompt, system, signal) => (await quickLineWithClaude(prompt, system, signal)).text, ...noteGate },
    journal: (event, count, via) => { const hands = needs.hands; if (event === 'recorded' && hands) hands.host.planNoted(via); /* I-087: a plan just said → her pinky */ try { needs.appJournal.record({ type: 'upcoming', characterId: needs.journalCharacterId(), event, count, ...(via ? { via } : {}) }); } catch { /* the journal never changes what she remembers */ } } });
  await upcoming.start().catch(error => console.error('Plan memory could not start:', error));
  });
  companion.memory.onTurnBegun(info => upcoming?.turnBegun(info));
  // I-021: one note per finished chat segment, old ones filled in slowly; only while the user is not with her and no other model call runs.
  // I-111: recall by meaning; off by default, nothing is downloaded or computed until the user turns it on.
  await startUnit('memory', 'memory-semantic', async () => {
  semantic = createSemanticOrNull({ directory, profileDirectory: store.directory, publish: view => broadcast('desk:memory-semantic', view), archive: companion.memory,
    currentScope: () => companion.currentScope(), userBusy: noteGate.userBusy });
  await semantic?.host.init().catch(() => undefined);
  });
  companion.setSemanticPrefetch(semantic ? text => semantic!.prefetch(text) : null);
  await startUnit('memory', 'memory-notes', async () => {
  memoryNotes = new MemoryNotes({ directory: store.directory, archive: companion.memory, write: async (prompt, system, signal) => (await quickLineWithClaude(prompt, system, signal)).text,
    userBusy: noteGate.userBusy, modelBusy: noteGate.modelBusy, lastActivityAt: noteGate.lastActivityAt, scope: () => companion.currentScope(),
    changed: () => broadcast('desk:memory-changed', undefined), developerMode: () => !!companion?.mood.isDeveloperMode(),
    keywords: watchTogether?.keywords, previousLines: needs.recentLines, upcoming: upcoming?.hooks(), /* step 7: the plans may be off; the notes go on without them */ semantic: semantic?.recall });
  await memoryNotes.start().catch(error => console.error('Memory notes could not start:', error));
  });
  companion.setTodayNotes((scope, start, end) => memoryNotes?.notesBetween(scope, start, end) ?? []); // I-115 A: one or two of today's chat notes join her situation text
}
