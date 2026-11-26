// 角色卡 (part 10), host side: the public page. Other parts and the wiring import the cards part only through this file (overhaul
// plan section 8; the layer check counts any other way in as debt). Files inside electron/cards/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part cards`).
// The conversion wiring (character-convert/electron-wiring.ts) is wiring: the agent channel's wiring imports it directly.

// The card store, revision history (also used by the body and visual stores), lint wrapper and in-place update with its backup.
export { CharacterCardStore } from './character-cards';
export { CharacterRevisionStore } from './character-revision-store';
export { withCardLint } from './character-card-lint';
export { backupBeforeUpdate, CharacterCardUpdater } from './character-card-update';
export { saveCharacterVoice } from './character-voice-save'; // I-162 step 2: the character page's 「她的声音」
export type { CharacterCardUpdateResult } from './character-card-update';
// Roster, switching, which model a card is bound to, and the preinstalled Gene card.
export { buildCharacterRoster } from './character-roster';
export { CharacterSwitchGate, activateCardCommitted, type CardActivationPorts } from './character-switch';
export { planCardForModel, readModelIdentity, splitCardFromModelAtStartup, stageModelIdentity } from './character-model-link';
export { inspectGeneProfile } from './gene-preinstalled-card';
export { bundledReferenceForPath, relocateBundledModel, resolveBundledCharacterModel } from './bundled-character-models'; // 0.2.0: One and Mumi come with the app
// Forgetting one character's memories (used by the recoverable-forget flow and the privacy wiring).
export { characterProviderScopes, forgetCharacterMemories, forgettableProviderScopes } from './character-forget';
export type { CharacterForgetRegistry, ForgetClear } from './character-forget';
// Avatars and stickers.
export { avatarBytesFromDataUrl, CharacterAvatarStore } from './character-avatars';
export { CharacterStickerHost, registerCharacterStickerControls } from './character-sticker-host';
export { CharacterStickerStore } from './character-sticker-store';
// Response style, understanding a card, and language authoring.
export { CharacterResponseService, CharacterResponseStore } from './character-response';
export { characterUnderstandingHandlers, CharacterUnderstandingHost } from './character-understanding';
export { PersonalizeAuthoring } from './personalize-authoring';
export { PersonalizeLanguageStore } from './personalize-language';
// Converting a card to another language (the job service and its agent-channel tools, and the quit gate).
export { ConversionService } from './character-convert/service';
export { createConversionTools } from './character-convert/tools';
export { createConversionQuitGate } from './character-convert/quit';
