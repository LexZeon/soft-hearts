// Renderer wiring, 角色卡: the active card, its greeting and hints, and the reading language it sets (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText, uiTemplate } from '../foundation/ui-language';
import { cardLanguageOf, compileCharacterPersona, type CharacterCardState } from '../../shared/cards';
import { setSpeechLanguageSource } from '../voice';
import { $, immersiveNotice, isPet, notify } from './shell-wiring';
import { stage } from './stage-wiring';
import { moodCompanion } from './mood-wiring';
import { feedCuePrefetch, noteVoicePlan } from './voice-wiring';
import { activeChat, clearChat, history, refillChat } from './chat-wiring';
import { ambientTranscriptHistory, memoryPanel } from './memory-wiring';
import { petFramingController } from './pet-window-wiring';
import { characterControls, characterPage, emotionalVoiceControls } from './control-window-wiring';
export let characterState: CharacterCardState | null = null;
/** Her reading language follows the active card (src/voice). */
export function wireSpeechLanguage(): void {
setSpeechLanguageSource(() => cardLanguageOf(characterState?.cards.find(card => card.id === characterState?.activeId))); // I-071 v2: the active card's language picks the system voice
}
export let characterName = uiText('桌面伙伴');
/** Character card changes from the host. */
export function wireCharacterCards(): void {
  window.desktop.onCharacterCards(applyCharacterCards);
}

export function applyCharacterCards(next: CharacterCardState): void {
  if (characterState && (next.revision ?? 0) < (characterState.revision ?? 0)) return;
  const previousActiveId = characterState?.activeId ?? null;
  if (previousActiveId !== next.activeId) petFramingController?.invalidate();
  const current = characterState?.cards.find(card => card.id === characterState!.activeId);
  const selected = next.cards.find(card => card.id === next.activeId);
  const signature = (card: typeof selected) => card ? [card.id, card.name, card.greeting, compileCharacterPersona(card)].join('\0') : '';
  const changed = !!characterState && signature(current) !== signature(selected);
  characterState = next;
  characterName = selected?.name ?? uiText('桌面伙伴');
  stage?.setSleepHabit?.(selected?.sleepHabit); // I-078 第 3 步: her 睡相 (the card's setting) for the sleep body
  characterControls?.applyState(next);
  characterPage?.applyCardState(next);
  emotionalVoiceControls?.refresh();
  feedCuePrefetch.voiceContextChanged();
  noteVoicePlan(); // I-162: one line in the control window when she cannot speak with her own voice
  $('pet-answer')?.setAttribute('aria-label', uiTemplate`${characterName}的回答`);
  if (changed || previousActiveId !== next.activeId) moodCompanion?.reset('character');
  if (changed) {
    ambientTranscriptHistory?.reset(); void ambientTranscriptHistory?.refresh();
    memoryPanel?.reset();
    // C2/C3 (pretrial fixes 2026-11-03): updated in place or switched to her, the window shows her current conversation
    // (the host's chat memory); only a character who never opened with the user starts with her greeting (src/brain/greeting-gate.ts).
    clearChat(false);
    refillChat(true);
  } else if (!history.length && !activeChat && selected?.greeting && !current) {
    refillChat(true); // 2026-11-25: the first card state of a run asks the host too; a character who ever talked with the user is not greeted again
  }
  if (next.notice) notify(next.notice, true);
  else if (next.hint && !isPet) showCharacterHint(next.hint); // C1: which card the model went with
}
export let lastCharacterHint = { text: '', at: 0 };
/** C1: a short toast (ordinary notices are quiet, guidance is not), and the full line beside the model and on the character page. */
export function showCharacterHint(hint: string): void {
  const now = Date.now();
  if (hint === lastCharacterHint.text && now - lastCharacterHint.at < 3000) return; // The broadcast and the returned state carry the same line.
  lastCharacterHint = { text: hint, at: now };
  // The toast holds 160 characters: the whole line when it fits, else its first sentence (the full line stays inline).
  const first = hint.split(/(?<=[。！？.!?])\s*/u)[0] || hint, toast = hint.length <= 160 ? hint : first;
  immersiveNotice?.publishAction(toast.length <= 160 ? toast : `${toast.slice(0, 158)}…`);
  const line = $('model-character-hint');
  if (line) { line.textContent = hint; line.hidden = false; }
  characterPage?.showHint(hint);
}
export function chatContext(): string { return `${characterState?.revision ?? 0}:${characterState?.activeId ?? ''}`; }
