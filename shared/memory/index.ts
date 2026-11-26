// 记忆和关系 (part 4), shared side: the public page. Other parts, the wiring and the contract import this part only through this file
// (overhaul plan section 8). Files inside shared/memory/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part memory`), except
// the values of five host-only modules: the renderer imports this page too, and rolldown keeps every module a page re-exports values
// from, so they would add ~1.7 KB of host-only code to the window bundle. Their types are here; their importers import the values
// directly: memory-keywords/keyword, knobs, prompt (listening together, watching along, listen-note),
// people-things/gather (the card conversion). our-things (give) moved to the initiative part (wiring rewrite step 1).

// The chat archive: config, scopes, pages and queries, recent chat, recall matching.
export { DEFAULT_MEMORY_CONFIG, memoryRecallMatch } from './memory';
export type { MemoryConfig, MemoryEdit, MemoryInitiative, MemoryListQuery, MemoryMessage, MemoryPage, MemoryReadQuery, MemoryRecall, MemoryRecordPage, MemoryScope, MemoryStageLine, MemoryTurnHandle, RecentChat, RecentChatShown } from './memory';
// 体验记录 (the experience journal): the input and view types, motion activity names (the stage logs them).
export { MOTION_ACTIVITIES } from './journal';
export type { FirstCharReuse, GestureAnswer, JournalInput, JournalView, MotionActivity, MotionGlitchKind, PauseStuckKind, PoseJournalEvent } from './journal';
// Keepsakes (her folder draws and tells them on special dates).
export { daysUntil, drawForm, drawGapMs, emptyCharacter, emptyLedger, KEEPSAKE_KNOBS, leadDaysFor, ledgerKey, parseSpecialDates, readLedger, specialKey, startOfDay, tellDeadline } from './keepsake';
export type { CharacterKeepsakes, KeepsakeForm, KeepsakeLedger, PendingTell, SpecialDate } from './keepsake';
// Keywords (listening together and watching along file their notes by them).
export type { Keyword } from './memory-keywords/keyword';
// Memory notes, recall by meaning, moving memory, people and things: the wire types; gathering people and things.
export type { MemoryNote, MemoryNoteState, NoteSegmentInfo } from './memory-notes/interface';
export type { SemanticRecallView } from './memory-semantic/view';
export type { MovingMemoryView } from './moving-memory';
export type { PeopleThingsOp, PeopleThingsView } from './people-things/view';
// Our things (what she was given and keeps).
// The relationship: nicknames, stages and their labels, the view.
export { cleanNickname, NICKNAME_ASK_INSTRUCTION, STAGE_LABELS } from './relationship';
export { nameHeard, spokenForm, wakeNames, type NicknameTableView } from './nickname-table'; // Unbound v1 step 3 (spokenForm: step 4's name-call)
export type { RelationshipData, RelationshipStage, RelationshipView } from './relationship';
// Text memorials and the profile of the user: the wire types; checking the expected profile version.
export type { TextMemorialAcknowledgement, TextMemorialDelete, TextMemorialEdit, TextMemorialEvent, TextMemorialOfferState, TextMemorialPresented, TextMemorialView } from './text-memorials';
export { validateUserProfileExpected } from './user-profile-ui';
export type { UserDiaryClearRequest, UserDiaryDeleteRequest, UserDiaryEditRequest, UserProfileDeleteRequest, UserProfileEditRequest, UserProfileExpected, UserProfileToggleRequest, UserProfileView, UserReviewDeleteRequest, UserReviewEditRequest, UserUpcomingClearRequest, UserUpcomingDeleteRequest } from './user-profile-ui';
// I-144 the recycle bin as the windows and the agent channel see it (names, kinds, counts, times).
export { RECYCLE_DAYS_DEFAULT, RECYCLE_DAYS_MAX, RECYCLE_DAYS_MIN, RECYCLE_ENTRY_KINDS } from '../foundation/recycle-bin';
export type { RecycleBinView, RecycleEntryKind, RecycleSummary } from '../foundation/recycle-bin';
// I-208 角色档案: the sections, the limits, and the one read-only call's shapes (the character page draws them).
export { ARCHIVE_KINDS, ARCHIVE_LIMITS } from './archive';
export type { ArchiveItem, ArchiveKind, ArchiveSection, CharacterArchiveRequest, CharacterArchiveView } from './archive';
export { historyLabel, lineSpeaker, speakerName, validSpeaker, SPEAKER_WORDS_EN, SPEAKER_WORDS_ZH } from './speaker'; // I-209 step 2: who said each archived line
export type { LineSpeaker, MemorySpeaker, SpeakerWords, SpokenLine } from './speaker';
