// Renderer wiring, Companion window only: the companion page and toolbar (PetUI), her state reports, click-through pointer handling and framing.
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText } from '../foundation/ui-language';
import { PetFramingController } from '../stage';
import { PetUI, renderPet } from '../stage/PetUI'; // direct, not via ./stage: PetUI imports the brain, voice and senses pages, which import the stage page (docs/claude/2026-11-16-overhaul-parts-4.md)
import { laterPopup, requestCameraEdit } from '../stage';
import { installPetPointerPassthrough } from '../stage';
import { HER_STATE_REPORT_CHECK_MS, HerStateReporter } from '../mood';
import { ListenKindPanelFeed } from '../senses';
import { $, app, isPet, notify } from './shell-wiring';
import { requestAlwaysOnTop, settings } from './settings-wiring';
import { cameraEditing, stage, syncBehaviorGate } from './stage-wiring';
import { moodCompanion } from './mood-wiring';
import { ambientAudioController } from './voice-chat-wiring';
import { hostVisible, sendChat, stopChat } from './chat-wiring';
import { explainRuntimeReply, screenSharingOptions, toggleRuntime, toggleWatchTogether } from './senses-wiring';
import { userProfilePanel } from './memory-wiring';
export let petFramingController: PetFramingController | null = null;
export let petUI: PetUI | null = null;
export let petPointer: ReturnType<typeof installPetPointerPassthrough> | null = null; // click-through: her and her controls stay clickable
/** Companion window: the companion page and its toolbar (PetUI). */
export function mountPetWindow(): void {
    document.documentElement.classList.add("pet-root");
    document.body.classList.add("pet-mode");
    renderPet(app);
    petUI = new PetUI({
      edit: enabled => requestCameraEdit(stage, () => cameraEditing, enabled, message => notify(message, true)),
      toggleAlwaysOnTop: () => void requestAlwaysOnTop(!settings.pet.alwaysOnTop),
      onInteractionBlockChange: () => { moodCompanion?.reset('window-operation'); syncBehaviorGate(); },
      feature: feature => toggleRuntime(feature), watchTogether: () => void toggleWatchTogether(),
      camera: patch => window.desktop.setRuntimeState(patch), explainRuntime: reply => explainRuntimeReply(reply), // I-036: 发图片 / 姿势识别
      systemAudio: () => ambientAudioController?.toggleExpanded(),
      closeSystemAudioPanel: () => { if(ambientAudioController?.isExpanded)ambientAudioController.toggleExpanded(); },
      toggleUserProfile: () => userProfilePanel?.toggle(), closeUserProfile: () => userProfilePanel?.close(),
      popups: { // I-028: folding the toolbar closes these too (src/stage/pet-popups.ts)
        'screen-sharing-options': laterPopup(() => screenSharingOptions, options => options.isOpen, options => options.close()),
        'mood-companion': laterPopup(() => moodCompanion, mood => mood.panelOpen, mood => mood.closePanel()),
      },
      send: () => void sendChat(), stop: () => void stopChat(), error: message => notify(message, true),
    });
}
/** I-017 / I-016: her music state and the listen kind, reported from the companion window only. */
export function startHerStateReports(): void {
  // Overhaul step 7: the host's "the user is away" (no input for two minutes or the screen locked, 「知道你是不是在忙」 on): the stage's 24 fps away pace.
  if (isPet) { const follow = (view: { away?: true }) => stage.setUserAway(view.away === true); window.desktop.onUserActivity(follow); void window.desktop.getUserActivity().then(follow, () => {}); }
  // I-017: her body's music state for the next chat turn's perception line (companion window only; the host checks freshness and order).
  if (isPet) { const herState = new HerStateReporter({ read: () => stage.getMusicPresence(), send: report => window.desktop.noteStageState(report) }); setInterval(() => herState.tick(), HER_STATE_REPORT_CHECK_MS); }
  if (isPet) { const listenPanel = new ListenKindPanelFeed({ active: () => !!stage.getMusicChoiceLine(), read: () => window.desktop.readListenKind(), show: line => stage.setListenKindLine(line) }); setInterval(() => listenPanel.tick(), HER_STATE_REPORT_CHECK_MS); } // I-016: the host's kind on the developer line
}
/** Companion window only: click-through pointer handling and the framing controller. */
export function wirePetPointerAndFraming(): void {
  if (isPet) petPointer = installPetPointerPassthrough({ document, stageRoot: $('stage'), probe: (x, y, signal) => stage.pixelProbe.request(x, y, signal),
    enabled: () => settings.pet.clickThrough && hostVisible, holds: () => cameraEditing || !!petUI?.windowInteractionBlocked,
    request: receive => window.desktop.setPetPointerInput(receive), visibility: window.desktop.onWindowVisibility });
  if (isPet) {
    petFramingController = new PetFramingController(crypto.randomUUID(), {
      state: () => stage.getFramingView(),
      report: state => { void window.desktop.reportPetFramingState(state).catch(() => {}); },
      begin: id => window.desktop.beginPetFraming(id), complete: report => window.desktop.completePetFraming(report),
      frame: preset => stage.frame(preset) !== null,
    });
    window.desktop.onPetFramingRequest(request => { void petFramingController!.receive(request).catch(() => notify(uiText('这次取景结果尚未确认。'), true)); });
    petFramingController.report();
  }
}
