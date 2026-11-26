// 角色卡 (cards): this part's slice of the window↔host API. DesktopAPI (shared/contracts.ts) extends every part's slice.
// A new window↔host call of this part goes here, and electron/safety/preload.ts gets the matching typed entry; never a generic invoke.
// The members came over verbatim from shared/contracts.ts in their old order (docs/claude/2026-11-16-contracts-split.md).
import type { CharacterCardState, CharacterDraft } from '../foundation/character-card';
import type {
  CharacterCardUpdatePreview, CharacterResponseProfile, CharacterResponseState, CharacterRosterView, LanguageProfile, LanguageState,
} from '../cards';
import type { EmojiId } from '../stage';

export interface CardsDesktopAPI {
  getCharacterStickers():Promise<import('../cards').CharacterStickerView>;
  beginCharacterStickerReference():Promise<import('../cards').StickerReferenceChallenge>;
  acceptCharacterStickerReference(value:{challengeId:string;png:string;modelUrl:string;loadGeneration:number}):Promise<import('../cards').CharacterStickerView>;
  generateCharacterSticker(value:{referenceId:string;intent:EmojiId}):Promise<import('../cards').CharacterStickerView>;
  saveCharacterSticker(value:{resultId:string}):Promise<import('../cards').CharacterStickerView>;
  previewCharacterSticker(value:{assetId:string}):Promise<boolean>;
  retireCharacterStickerReference(value:{challengeId:string}):Promise<import('../cards').CharacterStickerView>;
  cancelCharacterSticker():Promise<import('../cards').CharacterStickerView>;
  onCharacterStickers(callback:(view:import('../cards').CharacterStickerView)=>void):()=>void;
  getCharacterCards(): Promise<CharacterCardState>;
  saveCharacterCard(draft: CharacterDraft, id?: string): Promise<CharacterCardState>;
  /** F6 "更真实的情绪" of one card: on asks the user first in a native dialog (declined: the cards come back unchanged); off saves at once. */
  requestCharacterRealerEmotions(id: string, value: boolean): Promise<CharacterCardState>;
  activateCharacterCard(id: string): Promise<CharacterCardState>;
  deleteCharacterCard(id: string): Promise<CharacterCardState>;
  bindCharacterModel(id: string, enabled: boolean): Promise<CharacterCardState>;
  importCharacterCard(): Promise<CharacterCardState | null>;
  exportCharacterCard(id: string): Promise<boolean>;
  onCharacterCards(callback: (state: CharacterCardState) => void): () => void;
  /** C2 角色页: the card wall (display data only), refreshed on card changes and on `onCharacterRoster`. */
  getCharacterRoster(): Promise<CharacterRosterView>;
  /** C2 换成她: waits for her current line, then switches model, persona and memories together. */
  switchCharacter(id: string): Promise<CharacterCardState>;
  /** C2 新增角色 · 用现在的模型. */
  createCharacterForCurrentModel(): Promise<CharacterCardState>;
  /** C2 关联别的模型 / 重新选模型文件 (native file dialog in the host). */
  bindCharacterModelFile(id: string): Promise<CharacterCardState | null>;
  /** C2 小头像: a PNG data URL of the current card on its own model; stays on this computer. */
  saveCharacterAvatar(id: string, modelUrl: string, dataUrl: string): Promise<boolean>;
  /** C2 删除: only the card unless `forgetMemories` (the unticked "同时删除她的记忆"). */
  deleteCharacter(id: string, options: { forgetMemories: boolean }): Promise<CharacterCardState>;
  /** C3 用角色卡文件更新: the host's file dialog, then what the file would change on this card (null: cancelled). Nothing is written. */
  previewCharacterCardUpdate(id: string): Promise<CharacterCardUpdatePreview | null>;
  /** C3: applies exactly that preview to exactly that card, in place (same id; her memories stay hers). */
  /** `useFileVoice` (I-162 step 2): also take the file's voice; absent or false keeps her current voice. */
  applyCharacterCardUpdate(token: string, options?: { useFileVoice?: boolean }): Promise<CharacterCardState>;
  /** I-162 step 2 「她的声音」: set her card's voice (null: back to the default voice for new characters). Saves the card only; starts no voice and spends nothing. */
  saveCharacterVoice(id: string, voice: import('../foundation/character-voice').CharacterVoice | null): Promise<CharacterCardState>;
  discardCharacterCardUpdate(token: string): Promise<void>;
  onCharacterRoster(callback: () => void): () => void;
  /** I-018 理解讨论 (electron/cards/character-understanding.ts): the discussion the host keeps (null: none). */
  getCharacterUnderstanding(): Promise<import("../cards").UnderstandingView | null>;
  /** Opens a discussion about this card; Claude speaks first (the view follows on `onCharacterUnderstanding`). */
  startCharacterUnderstanding(id: string, trigger: import("../cards").UnderstandingTrigger, changedFields?: string[]): Promise<import("../cards").UnderstandingView>;
  replyCharacterUnderstanding(sessionId: string, text: string): Promise<import("../cards").UnderstandingView>;
  /** "就这样": Claude writes the 理解说明 now. */
  finishCharacterUnderstanding(sessionId: string): Promise<import("../cards").UnderstandingView>;
  retryCharacterUnderstanding(sessionId: string): Promise<import("../cards").UnderstandingView>;
  /** 跳过 / 关闭: nothing is saved. */
  closeCharacterUnderstanding(sessionId: string): Promise<void>;
  /** The user's OK: the 理解说明 (and the chosen mood plan) go into the same card, in place. */
  saveCharacterUnderstanding(sessionId: string, choices: import("../cards").UnderstandingSaveChoices): Promise<CharacterCardState>;
  onCharacterUnderstanding(callback: (view: import("../cards").UnderstandingView | null) => void): () => void;
  getCharacterResponse(id: string): Promise<CharacterResponseState>;
  saveCharacterResponse(id: string, profile: CharacterResponseProfile, expectedRevision?: number): Promise<CharacterResponseState>;
  copyCharacterResponse(sourceId: string, targetId: string): Promise<CharacterResponseState>;
  onCharacterResponse(callback: (state: CharacterResponseState) => void): () => void;
  openLanguageAuthoring(id: string, savedRevision: number): Promise<import('../cards').LanguageAuthoringSession>;
  researchLanguage(request: import('../cards').LanguageResearchRequest): Promise<import('../cards').LanguageResearchResult>;
  cancelLanguageAuthoring(id: string): Promise<void>;
  closeLanguageAuthoring(id: string): Promise<void>;
  getPersonalizeLanguage(id: string): Promise<LanguageState>;
  savePersonalizeLanguage(id: string, profile: LanguageProfile, expectedRevision: number): Promise<LanguageState>;
  undoPersonalizeLanguage(id: string, expectedRevision: number): Promise<LanguageState>;
  onPersonalizeLanguage(callback: (state: LanguageState) => void): () => void;
}
