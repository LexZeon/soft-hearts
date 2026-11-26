// Renderer wiring, 心情: the mood companion (both windows) and the developer mode it reports.
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { MoodCompanion, windowTouchable } from '../mood';
import { mountPhysicsLabButton } from '../stage/physics-lab/open-button';
import { $, immersiveNotice, isPet, lastStageStatus, notify, updateStageStatus } from './shell-wiring';
import { settings } from './settings-wiring';
import { cameraEditing, composing, stage } from './stage-wiring';
import { feedPause } from './voice-wiring';
import { hostVisible } from './chat-wiring';
import { feedSnacks, giveOverlay, handsOverlay } from './initiative-wiring';
import { characterState } from './cards-wiring';
import { petUI } from './pet-window-wiring';
export let immersiveDeveloperMode = false;
export let moodCompanion: MoodCompanion | null = null;
/** The mood companion (both windows), then the visibility it needs. */
export async function startMoodCompanion(): Promise<void> {
  if (!isPet) queueMicrotask(() => mountPhysicsLabButton(document.querySelector<HTMLElement>('.mood-companion-body'))); // R01 物理调参台 (developer panel)
  moodCompanion = new MoodCompanion({
    isPet, surface: $('stage'), getHeadRegion: () => stage.getInteractionRegion(),
    getCharacterId: () => characterState?.cards.some(card => card.id === characterState!.activeId) ? characterState!.activeId : null,
    onScopeInvalidated: () => stage.invalidateMoodScope(),
    canInteract: () => windowTouchable({ model: !!settings.model, hostVisible, hidden: document.hidden, cameraEditing, interactionBlocked: !!petUI?.windowInteractionBlocked, composing }), // one rule with full-screen (I-174)
    onFeedback: feedback => { if (feedback.contact || feedback.feeding) { giveOverlay?.interrupt(); handsOverlay?.interrupt(); } stage.setMoodContact(feedback); feedPause.feedback(feedback); petUI?.setInteractionProgress(feedback.contact || feedback.feeding ? 1 : feedback.hover ?? 0); },
    getDegradation: () => stage.getMoodDegradation(),
    getMusicDesire: () => stage.getMusicChoiceLine(),
    getExpressionSupport: recipe => stage.expressionSupport(recipe), // E1: the developer panel's 「预览：惊喜 / 害羞」
    onProceduralLife: enabled => stage.setProceduralLife(enabled),
    onInteraction: active => petUI?.setInteraction(active),
    onView: view => {
      stage.setMood(view);petUI?.setDeveloperMode(view.developerMode);
      immersiveDeveloperMode=view.developerMode;
      document.body.classList.toggle('developer-mode',view.developerMode);
      immersiveNotice?.setDeveloperMode(view.developerMode);
      updateStageStatus(lastStageStatus);
    },
    onSnack: (file, sessionId) => { void feedSnacks?.send(file, sessionId); },
    pull: isPet ? { stage, send: report => { void window.desktop.petTouch(report).catch(() => {}); } } : undefined, // I-136 5a 拉她
    onError: message => notify(message, true),
  });
  await moodCompanion.init();
  petUI?.setHostVisible(hostVisible);
  moodCompanion.setHostVisible(hostVisible);
  stage.setVisible(hostVisible);
}
