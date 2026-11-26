// 舞台's window steps (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md), moved from electron/main.ts's windowEvents
// word for word. electron/main.ts's order list (wireWindowEvents, electron/wiring/window-events-wiring.ts) says which run on which window
// event, in which order; the wiring golden pins it. A window step is called with the window's scope (win, owner, windowId).
// The companion window's own blocks are here whole, as one `if (owner === 'pet')` each: what her window's new page, lost renderer, hiding and
// closing do to her body, her mood view's body presentation and the reply she was finishing (the golden pins each block as written).
// The control window's hide closes its open tools (the surprise preview, personalize authoring, the sticker picker) in one block too.
// What they read: other parts' live bindings, imported; the two functions only electron/main.ts's table has, bound by wireStageCleanup.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import type { ReadingCancelBy } from '../../shared/voice';
import type { SettingsStore } from '../settings';
import { companionHiddenStep } from '../stage/companion-hidden';
import { companion } from './brain-wiring';
import { watchContinuity } from './senses-listen-wiring';
import { characterStickerHost } from './cards-ready-wiring';
import { surprisePreviewHost } from './initiative-handlers-wiring';
import { bodyAuthoring, bumpBodyModelGeneration, nativeVisibility, onScreen, petPointerInput, petPresentation, petWindowDrag, singleEmojiCues, singleEmojiWindow,
  visualAuthoring } from './stage-wiring';

/** What the steps read that only electron/main.ts's table has (each read when a step runs). */
export interface StageCleanupNeeds {
  readonly store: SettingsStore;
  cancelCompletedReply(id?: string, by?: ReadingCancelBy): boolean;
  stopSystemAudio(): void;
}
let needs!: StageCleanupNeeds;
let cancelCompletedReply!: (by?: ReadingCancelBy) => void;
let stopSystemAudio!: () => void;

export function wireStageCleanup(given: StageCleanupNeeds): void {
  needs = given;
  cancelCompletedReply = by => { needs.cancelCompletedReply(undefined, by); };
  stopSystemAudio = () => needs.stopSystemAudio();
}

// ---- window steps

/** New-document step: the companion's new page: old body receipts go stale, her body presentation and the reply she was finishing stop. */
export function resetPetBody(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === 'pet') { bumpBodyModelGeneration(); companion?.mood.cancelBodyPresentation(); cancelCompletedReply('window'); }
}
/** New-document step: a drag of the companion window ends. */
export function cancelPetDrag(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === 'pet') petWindowDrag?.cancel();
}
/** Page-gone step: the companion's renderer is gone: receipts go stale, her body presentation, a drag, the pointer input, the computer's sound and the reply end. */
export function petPageGone(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === "pet") { bumpBodyModelGeneration(); companion?.mood.cancelBodyPresentation(); petWindowDrag?.cancel(); petPointerInput.reset(); stopSystemAudio(); cancelCompletedReply('window'); }
}
/** Hide step: the control window hides: its surprise preview, personalize visual and body authoring and the sticker picker close. */
export function closeControlsTools(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if(owner==='controls'){surprisePreviewHost?.stop(windowId);visualAuthoring?.close(windowId);bodyAuthoring?.close(windowId);characterStickerHost?.cancel();}
}
/** Destroyed step: personalize visual and body authoring of the closed window end. */
export function closeWindowAuthoring(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  visualAuthoring?.close(windowId);
  bodyAuthoring?.close(windowId);
}
/** Destroyed step: the companion window closed: her mood view is invalid, the reply she was finishing stops. */
export function petWindowClosed(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === 'pet') { companion?.mood.invalidate(); cancelCompletedReply('window'); }
}
/** Visibility step: her body is visible only while the companion window is shown and she is set visible; hidden or minimized, her view is invalid. */
export function notePetBodyVisible(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === 'pet') companion?.mood.setBodyVisible(win.isVisible() && !win.isMinimized() && !!needs.store?.current.pet.visible);
  if (owner === 'pet' && (!win.isVisible() || win.isMinimized())) companion?.mood.invalidate();
}
/** Visibility step: the companion hidden or minimized: off the screen the computer's sound stops and the pointer input ends; a hide also ends the reply, a minimize keeps it (I-171, electron/stage/companion-hidden.ts). */
export function petHidden(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === "pet") companionHiddenStep(win, { onScreen, stopSystemAudio, cancelCompletedReply: () => cancelCompletedReply('hidden'), resetPointer: () => petPointerInput.reset(),
    minimized: () => watchContinuity?.minimized(), restored: () => { void watchContinuity?.restored(); } }); // 2026-11-24 (续): 一起看 pauses with a minimize and resumes when she is back (electron/senses/watch-continuity/)
}
/** Visibility step: the window's page is told its native visibility. */
export function sendNativeVisibility(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  win.webContents.send(
    "desk:visibility",
    nativeVisibility(win),
  );
}

// ---- quit steps (electron/main.ts's wireQuit gives their order; electron/wiring/quit-wiring.ts)

/** Quit step: the single-emoji cues and window end. */
export function disposeSingleEmoji(): void {
  singleEmojiCues?.dispose(); singleEmojiWindow?.dispose();
}
/** Quit step: a drag of the companion window ends; her presentation notes stop. */
export function releasePetWindow(): void {
  petWindowDrag?.cancel(); petPresentation.dispose();
}
