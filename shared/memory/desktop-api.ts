// 记忆和关系 (memory): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type {
  MemoryConfig, MemoryEdit, MemoryListQuery, MemoryPage, MemoryReadQuery, MemoryRecordPage, RecentChat, TextMemorialAcknowledgement,
  TextMemorialDelete, TextMemorialEdit, TextMemorialEvent, TextMemorialOfferState, TextMemorialPresented, TextMemorialView, UserDiaryClearRequest,
  UserDiaryDeleteRequest, UserDiaryEditRequest, UserProfileDeleteRequest, UserProfileEditRequest, UserProfileToggleRequest, UserProfileView,
  UserReviewDeleteRequest, UserReviewEditRequest, UserUpcomingClearRequest, UserUpcomingDeleteRequest,
} from '../memory';

export interface MemoryDesktopAPI {
  listMemories(query?: MemoryListQuery): Promise<MemoryPage>;
  readMemory(id: string, query?: MemoryReadQuery): Promise<MemoryRecordPage>;
  /** C2/C3: her current conversation for the chat window (either window; read from the existing chat memory). */
  getRecentChat(): Promise<RecentChat>;
  editMemory(id: string, edit: MemoryEdit): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  /** I-021 (control window): one memory's note, read only, and deleting just the note (the memory stays). */
  readMemoryNote(id: string): Promise<import('../memory').MemoryNoteState>;
  deleteMemoryNote(id: string): Promise<import('../memory').MemoryNoteState>;
  /** I-088: 你生活里的人和事 (control window): the entries gathered from her notes, and the user's decisions about them. */
  getPeopleThings(): Promise<import('../memory').PeopleThingsView>;
  changePeopleThings(op: import('../memory').PeopleThingsOp): Promise<import('../memory').PeopleThingsView>;
  getMemoryConfig(): Promise<MemoryConfig>;
  setMemoryConfig(config: unknown): Promise<void>;
  onMemoryChanged(callback: () => void): () => void;
  getUserProfile(): Promise<UserProfileView | null>;
  setUserProfileEnabled(request: UserProfileToggleRequest): Promise<UserProfileView>;
  editUserProfile(request: UserProfileEditRequest): Promise<UserProfileView>;
  deleteUserProfile(request: UserProfileDeleteRequest): Promise<UserProfileView>;
  /** L3 diary, inside the same profile scope. */
  editUserDiary(request: UserDiaryEditRequest): Promise<UserProfileView>;
  deleteUserDiary(request: UserDiaryDeleteRequest): Promise<UserProfileView>;
  clearUserDiary(request: UserDiaryClearRequest): Promise<UserProfileView>;
  deleteUserUpcoming(request: UserUpcomingDeleteRequest): Promise<UserProfileView>;
  /** I-088 第 1 条: her weekly and monthly look-backs, edited or deleted by the user. */
  editUserReview(request: UserReviewEditRequest): Promise<UserProfileView>;
  deleteUserReview(request: UserReviewDeleteRequest): Promise<UserProfileView>;
  clearUserUpcoming(request: UserUpcomingClearRequest): Promise<UserProfileView>;
  /** 熟悉度: what she calls the user, agreed in chat (electron/memory/relationship/). View, change (1–8 characters) or clear (null). */
  getRelationshipNickname(): Promise<string | null>;
  setRelationshipNickname(value: string | null): Promise<string | null>;
  /** Unbound v1 step 3: the nickname table (shared/memory/nickname-table.ts). Add or remove a name you call her (removing goes into the bin). Control window only. */
  getNicknameTable(): Promise<import('./nickname-table').NicknameTableView>;
  addHerNickname(name: string): Promise<string[]>;
  removeHerNickname(name: string): Promise<string[]>;
  /** Developer mode only, until restart: pretend the relationship stage is this (null: the real one). */
  setRelationshipStage(stage: import('../memory').RelationshipStage | null): Promise<void>;
  onUserProfileChanged(callback: (view: UserProfileView | null) => void): () => void;
  getCurrentTextMemorialOffer(): Promise<TextMemorialOfferState>;
  acknowledgeTextMemorial(request: TextMemorialAcknowledgement): Promise<TextMemorialPresented | null>;
  onTextMemorialEvent(callback: (event: TextMemorialEvent) => void): () => void;
  getTextMemorials(): Promise<TextMemorialView | null>;
  editTextMemorial(request: TextMemorialEdit): Promise<TextMemorialView>;
  deleteTextMemorial(request: TextMemorialDelete): Promise<TextMemorialView>;
  onTextMemorialsChanged(callback: (view: TextMemorialView | null) => void): () => void;
  /** I-111 recall by meaning (聊天记忆): the switch, the one-time download it starts, and deleting the model. */
  getSemanticRecall(): Promise<import('../memory').SemanticRecallView>;
  onSemanticRecall(callback: (view: import('../memory').SemanticRecallView) => void): () => void;
  setSemanticRecall(on: boolean): Promise<import('../memory').SemanticRecallView>;
  retrySemanticDownload(): Promise<import('../memory').SemanticRecallView>;
  cancelSemanticDownload(): Promise<void>;
  removeSemanticRecall(): Promise<import('../memory').SemanticRecallView>;
  /**
   * I-144 回收站 (control window only), shown next to where things are deleted (the character page, the memory panel, the single-delete panels):
   * names, kinds, counts and times only, never contents. 「永久删除」 is here and nowhere else (never over the agent channel).
   */
  getRecycleBin(): Promise<import('../memory').RecycleBinView>;
  restoreRecycleEntry(id: string): Promise<{ view: import('../memory').RecycleBinView; failed: boolean; replaced: boolean }>;
  deleteRecycleEntryForGood(id: string): Promise<import('../memory').RecycleBinView>;
  setRecycleBinDays(days: number): Promise<import('../memory').RecycleBinView>;
  onRecycleBin(callback: (view: import('../memory').RecycleBinView) => void): () => void;
  /** I-208 角色档案 (control window only, read only): what one character's memory holds, by kind, newest first, searched and paged; no path, no raw file (shared/memory/archive.ts). */
  getCharacterArchive(request: import('../memory').CharacterArchiveRequest): Promise<import('../memory').CharacterArchiveView>;
  /** 体验记录 (E2): "刚才发生了什么" and the switch "保留体验记录（只存本机）" (control window). */
  getJournal(): Promise<import('../memory').JournalView>;
  setExperienceJournal(enabled: boolean): Promise<import('../memory').JournalView>;
  onJournal(callback: (view: import('../memory').JournalView) => void): () => void;
  /** The companion window's music tier for the 体验记录 (a closed tier and a 0..1 score; anything else is ignored). */
  noteMusicTier(value: { tier: 'none' | 'nod' | 'dance'; score: number | null }): Promise<boolean>;
  /** 动作跳变记录 for the 体验记录: a guard catch or a physics kick (numbers, a bone or morph name, closed activities; anything else is ignored). */
  /** 体验记录 (first batch): a window tells a number-only fact ('voice-capture' summary, 'blush-stage', 'launch'); only the companion window may tell the others ('music-verdict': I-053, numbers and a closed reason). */
  noteJournalFact(kind: 'voice-capture' | 'blush-stage' | 'launch' | 'music-verdict' | 'music-reaction' | 'gaze' | 'mouth-reading' | 'pose-use' | 'send-dropped' | 'reading-dropped', value: unknown): Promise<boolean>; // I-189 'pose-use': her reading paused for you, a turned face in a call (closed words); 2026-11-22 'send-dropped': a typed line that did not go out
  noteMotionGlitch(value: { kind: 'guard' | 'physics' | 'block'; part: 'bone' | 'morph' | 'geometry' | 'gpu'; name: string; size: number; activities: string[]; fps: number | null; frameMs: number | null; cleared?: boolean }): Promise<boolean>;
  /** I-139 A3: the thing that moved her most, for the control page (view, delete the current one, bring an older one back). */
  getMovingMemory(): Promise<import('../memory').MovingMemoryView>;
  deleteMovingMemory(chosenAt: number): Promise<import('../memory').MovingMemoryView>;
  restoreMovingMemory(chosenAt: number): Promise<import('../memory').MovingMemoryView>;
}
