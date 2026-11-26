// 角色卡 (part 10), shared half: the public page. Other parts, the wiring and the contract import the cards part only through this
// file (overhaul plan section 8). Files inside shared/cards/ import each other directly. The card types themselves (CharacterCard,
// CharacterCardState, CardLanguage, ...) live in the foundation (shared/foundation/character-card.ts); importing them from there is fine.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part cards`).

// Compiling a card into her persona, its language and mood (chat wiring, control window).
export { cardLanguageOf, compileCharacterPersona, effectiveCharacterMood } from './character-cards';
export type { CharacterCard, CharacterCardState } from './character-cards';
// Which model a card uses.
export { effectiveCardModel, sameModelReference, uniqueCharacterName } from './character-model';
export { canonicalModelReference, isBundledModelKey } from './bundled-characters';
export type { CharacterModelDecision } from './character-model';
// Response style (mood reads applyMoodResponse).
export { applyMoodResponse } from './character-response';
export type { CharacterResponseProfile, CharacterResponseState } from './character-response';
// I-207 a card's milestone: the line, the hidden marker's check, the page's view and calls (chat wiring, user profile page).
export { cardMilestoneView, isCardMilestoneRequest, isMilestoneMarker, milestoneLine } from './card-milestone';
export type { CardMilestoneRequest, CardMilestoneView } from './card-milestone';
// I-208 step 3 a card's object and her margin notes: the line, the marker, the recall, the page's two writes (chat wiring, the archive page).
export { NOTE_LIMITS, NOTE_PAGE_MAX, cleanNoteText, isObjectNoteRequest, noteDateText, objectFactLine, objectMaterial, parseNoteMarker, planNewNotes, recallObject } from './card-objects';
export type { ObjectNoteRequest, ObjectNoteView } from './card-objects';
// Her small slips (initiative's impulse expression).
export { cardSlipsFactor } from './card-slips';
export type { CardSlips } from './card-slips';
// Language profile and authoring (chat prompt, voice chat, body and visual authoring).
export { personalizeLanguageContext, validateLanguageCharacterId, validateLanguageRevision } from './personalize-language';
export type { LanguageProfile, LanguageState } from './personalize-language';
export { authoringText } from './personalize-authoring';
export type { LanguageAuthoringSession, LanguageResearchRequest, LanguageResearchResult } from './personalize-authoring';
// Updating a card in place (agent channel).
export { cardUpdateSummaryLines } from './character-card-update';
export type { CharacterCardUpdateOutcome, CharacterCardUpdatePlanView, CharacterCardUpdatePreview } from './character-card-update';
// Converting a card to another language: the job view and its labels (settings assistant).
export {
  CONVERSION_INTRO_NEXT_KEY, CONVERSION_LEFT_OUT_KINDS, CONVERSION_LEFT_OUT_REASON_LABELS, CONVERSION_LEFT_OUT_REASONS, CONVERSION_STEP_LABELS,
  CONVERSION_STEPS, CONVERSION_TARGET_LABELS, enforceExtraBy, leftOutAllFailures, leftOutSummary, MAX_LEFT_OUT_LISTED,
} from './character-convert';
export type { ConversionJobView } from './character-convert';
// Wire types the contract names: roster, stickers, understanding.
export type { CharacterRosterView } from './character-roster';
export type { CharacterStickerView, StickerCapture, StickerReferenceChallenge } from './character-sticker';
export type { UnderstandingSaveChoices, UnderstandingTrigger, UnderstandingView } from './character-understanding';
// 体验记录 (the experience journal): this part's entry types, their closed words, builder, reason and panel line (shared/memory/journal.ts joins the slices).
export { CARDS_JOURNAL_TYPES, CHARACTER_JOURNAL_EVENTS, buildCardsJournalEntry, cardsJournalReason, describeCardsJournalEntry } from './journal-entries';
export type { CardsJournalInput, CharacterJournalEvent, GreetingWhy } from './journal-entries';
// I-219 a language tag on card names in the lists where the user picks a character (display only; the base name stays what she is told).
export { baseCardName, cardDisplayNames, cardsMixLanguages, displayCardName, hasLanguageTag, languageTagText } from './card-language-tag';
