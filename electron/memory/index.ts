// 记忆和关系 (part 4), host side: the public page. Other parts and the wiring import this part only through this file (overhaul plan
// section 8; the layer check counts any other way in as debt). Files inside electron/memory/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part memory`).
// The part's wiring modules (privacy-wiring.ts, her-note/, moving-memory/, period-review/, special-day/ wiring.ts,
// memory-semantic/electron-wiring.ts) are wiring: electron/main.ts imports them directly.
// Not here (their types are): the values of two modules that import back into modules that import this page, so through this page
// they would close a runtime import cycle. Their importers import them directly; untangling is left for the cards / voice / core work:
//   - journal/extras.ts (-> voice index -> voice-companion.ts -> this page): companion.ts, chat-actions-host.ts, main.ts;
//   - recoverable-forget.ts (-> cards index -> character-convert/service.ts -> this page): safety/agent-channel/memory-bridge.ts.

// The chat archive and recall: the store, recall matching late in a turn, the text-invitation id prefix.
export { MemoryStore, TEXT_INVITATION_ID_PREFIX } from './memory';
export { recallLateCheck } from './recall-late-check';
export { DayReadStore } from './day-read';
// The recycle bin and forgetting recoverably (the agent channel's memory bridge).
export { MemoryRecycleBin } from './memory-recycle-bin';
export type { RecoverableForgetPorts } from './recoverable-forget';
// Her diary: the writer, the local date key many hosts use, the data and limits a card conversion reads.
export { DiaryWriter, generateDiaryWithClaude } from './diary/diary-writer';
export { localDateKey } from './diary/diary-dates';
export { DIARY_LIMITS, diaryText } from './diary/diary-data';
export type { UserDiaryEntry } from './diary/diary-data';
// 体验记录 (the experience journal): the journal, its IPC, the build commit, and the inputs other hosts record into it.
export { AppJournal, readBuildCommit, registerJournalIpc } from './journal/app-journal';
export type { BlushMoment } from './journal/extras';
export { boredomLevel, herLifeInput, herNeedInput, herNeedReliefInput, longingLevel, MoodJournal, poseInput, relationshipInput, userStateInput } from './journal/sources';
export { moodNowFromView, withMoodNow } from './journal/mood-snapshots';
export type { JournalSink, MoodJournalEvent } from './journal/sources';
// Keyword recall (watching along keeps its notes with it) and memory notes.
export { KeywordRecall } from './memory-keywords/recall';
export type { RecallTextPort } from './memory-keywords/recall';
export { characterKey, KeywordIndexStore } from './memory-keywords/store';
export { MemoryNotes, registerMemoryNotesIpc } from './memory-notes/host';
export { MEMORY_NOTES_FILE, validateMemoryNotesFile } from './memory-notes/store';
// Recall by meaning: the component version (the face check shares the runtime component).
export { SEMANTIC_COMPONENT_VERSION } from './memory-semantic/manifest';
// People and things, period reviews (the card conversion reads both).
export { readPeopleThingsDecisions } from './people-things/store';
export { REVIEW_LIMITS, reviewWords, validateReviewData } from './period-review/data';
export type { ReviewData, ReviewEntry } from './period-review/data';
export { finishedWeeks, readyMonth } from './period-review/period';
export { ReviewStore } from './period-review/store';
export { PeriodReviewWriter } from './period-review/writer';
// The relationship: the host, the nickname route, the file name, the backfill key.
export { relationshipBackfillKey, relationshipCardOf, RelationshipHost } from './relationship/host';
export type { RelationshipOpening } from './relationship/host';
export { createNicknameRoute } from './relationship/nickname-route';
export { relationshipFileName } from './relationship/store';
// Special days and upcoming plans.
export { combineTellPorts, joinHintLines, SpecialDayHost } from './special-day/host';
export { ProfileUpcomingBook } from './upcoming/book';
export { UpcomingHost } from './upcoming/host';
export { UpcomingStore } from './upcoming/store';
// Text memorials.
export { buildTextMemorialPrompt, parseTextMemorialInvitation } from './text-memorial-dialogue';
export type { TextMemorialPromptInput } from './text-memorial-dialogue';
export { TextMemorialHost } from './text-memorial-host';
export { textMemorialReplyContext } from './text-memorials';
export type { TextMemorialHumanTurn, TextMemorialTurn } from './text-memorials';
// The profile of the user: the store, its context, management, reply collector and source; ids and markers the conversion reads.
export { profileTextFingerprint, RECORDING_ON_MARKER, userProfileScopeId, UserProfileStore } from './user-profile';
export type { UserProfileAcceptance, UserProfileEntry } from './user-profile';
export { UserProfileContext } from './user-profile-context';
export { UserProfileManagement } from './user-profile-management';
export { UserProfileReplyCollector } from './user-profile-reply';
export { UserProfileSource } from './user-profile-source';
// Read-only readers of one character's files (the card conversion and the archive page, I-208) and the archive's reader.
export { PROFILE_FOLDER_NAME, readJson, readSourceNotes, readSourceProfile, readSourceUpcoming } from './archive/readers';
export { CharacterArchiveReader, type ArchivePorts } from './archive/reader';
