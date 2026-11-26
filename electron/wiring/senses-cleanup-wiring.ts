// 感知's window steps (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md), moved from electron/main.ts's windowEvents
// word for word. electron/main.ts's order list (wireWindowEvents, electron/wiring/window-events-wiring.ts) says which run on which window
// event, in which order; the wiring golden pins it. A window step is called with the window's scope (win, owner, windowId); the three
// shared helpers here (revokeAmbientOwner, releaseAmbientOwner, revokeVisionOwner) are called with that same scope where the old code
// called its per-window closures.
// What they read is 感知's own: bound once by wireSensesCleanup to what its wire call provides (the very objects electron/main.ts had,
// so a listener the ready chain added with one of them is removed with the same one), or imported live.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, screen, type BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { createPoseQuitGate } from '../senses';
import { ambientAudio, ambientComments, asrTask, audioCapture, faceCheck, localAsr, poseSensing, userActivity, watchTogether, type SensesProvides } from './senses-wiring';
import { onScreen } from './stage-wiring';

let ambientSpeakingOwners!: SensesProvides['ambientSpeakingOwners'];
let suspendAmbientSpeech!: SensesProvides['suspendAmbientSpeech'];
let clearVisionContext!: SensesProvides['clearVisionContext'];
let refreshVisionContext!: SensesProvides['refreshVisionContext'];
let media!: SensesProvides['media'];
let mediaChanged!: SensesProvides['mediaChanged'];
let voiceHost!: SensesProvides['voiceHost'];
let revokeVoice!: SensesProvides['revokeVoice'];
let stopSystemAudio!: SensesProvides['stopSystemAudio'];
let proactiveVision!: SensesProvides['proactiveVision'];
let screenSnapshots!: SensesProvides['screenSnapshots'];
let screenGlance!: SensesProvides['screenGlance'];
let visualSelfRuntime!: SensesProvides['visualSelfRuntime'];
let cameraSamples!: SensesProvides['cameraSamples'];
let poseQuit!: ReturnType<typeof createPoseQuitGate>;

/** electron/main.ts binds the steps to 感知's own objects right after its wire call. */
export function wireSensesCleanup(provides: SensesProvides): void {
  ({ ambientSpeakingOwners, suspendAmbientSpeech, clearVisionContext, refreshVisionContext, media, mediaChanged, voiceHost, revokeVoice, stopSystemAudio,
    proactiveVision, screenSnapshots, screenGlance, visualSelfRuntime, cameraSamples } = provides);
  poseQuit = createPoseQuitGate(() => poseSensing, () => app.quit()); // quitting first lets the pose inference process end by itself (bounded)
}

// ---- window steps

/** Window helper (听): the window no longer speaks through the old ambient listening; on the companion window her comments stop. */
export function revokeAmbientOwner(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  ambientSpeakingOwners.delete(windowId); ambientAudio?.dropOwner(windowId);
  if (owner === 'pet') ambientComments?.clear();
  queueMicrotask(suspendAmbientSpeech);
}
/** Window helper (听): the window's audio capture ends, then revokeAmbientOwner (its page destroyed or gone). */
export function releaseAmbientOwner(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  audioCapture?.dropOwner(owner); revokeAmbientOwner(win, owner, windowId);
}
/** Window helper (看): the look's context is cleared and the window's camera or screen sharing ends (a new page, its page gone). */
export function revokeVisionOwner(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  clearVisionContext();
  const previous = { ...media.state };
  media.dropOwner(owner);
  mediaChanged(previous);
}
/** Window step (听): voice input this window started ends (a new page, its page gone). */
export function revokeWindowVoiceInput(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (voiceHost.capture?.sender === windowId) revokeVoice('scope-change');
}
/** New-document step (听): the window's audio capture is revoked, then revokeAmbientOwner. */
export function revokeAudioOwner(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  audioCapture?.revokeOwner(owner); revokeAmbientOwner(win, owner, windowId);
}
/** Window step (听): the companion window's page is new or closed: the computer's sound stops. */
export function stopPetSystemAudio(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (owner === "pet") stopSystemAudio();
}
/** Destroyed step (看): the look's context is cleared. */
export function clearClosedWindowVision(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  clearVisionContext();
}
/** Destroyed step (看), last: the closed window's camera or screen sharing ends. */
export function dropClosedMediaOwner(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  const previous = { ...media.state };
  media.dropOwner(owner);
  mediaChanged(previous);
}
/** Visibility step (听): voice input from a window that left the screen ends. */
export function revokeHiddenVoiceInput(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  if (!onScreen(win) && voiceHost.capture?.sender === windowId) revokeVoice('hide');
}
/** Visibility step (看), last: the look's context follows the window. */
export function refreshVisionOnVisibility(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  refreshVisionContext();
}

// ---- quit steps (electron/main.ts's wireQuit gives their order; electron/wiring/quit-wiring.ts)

/** Quit step: the pose inference process ends by itself first; the quit resumes once it has (≤2.5 s). */
export function holdForPoseInference(event: { preventDefault(): void }): void {
  if (poseQuit.hold()) event.preventDefault(); // electron/senses/pose/quit-gate.ts: the quit resumes once the inference process has ended (≤2.5 s)
}
/** Quit step: voice input's own recognizer and the face check end. */
export function stopSensorProcesses(): void {
  localAsr?.dispose();
  faceCheck?.host.dispose(); // I-135: checks stop, the counts so far go to the journal, the face-check process ends
}
/** Quit step: the look's context is cleared, the ready chain's display listeners go (the same function objects), the computer's sound stops. */
export function stopVisionAndSound(): void {
  clearVisionContext();
  screen.removeListener('display-removed', refreshVisionContext);
  screen.removeListener('display-metrics-changed', refreshVisionContext);
  stopSystemAudio();
}
/** Quit step: a running recognition is aborted. */
export function abortVoiceRecognition(): void {
  asrTask?.controller.abort();
}
/** Quit step: voice input ends; camera, microphone and screen are all given up; her proactive look stops. */
export function releaseCapture(): void {
  voiceHost.dispose();
  const previous = { ...media.state };
  media.reset();
  mediaChanged(previous);
  proactiveVision.dispose();
}
/** Quit step: screen snapshots, the glance, her visual self and camera samples stop. */
export function disposeLook(): void {
  screenSnapshots.dispose();
  screenGlance.dispose();
  visualSelfRuntime.dispose();
  cameraSamples.cancel();
}
/** Quit step: the user's activity is written. */
export function flushUserActivity(): void {
  void userActivity?.flush();
}
/** Flush step: watching together ends; its pending work stops. */
export async function stopWatching(): Promise<void> {
  await watchTogether?.dispose(); // I-048: nothing keeps watching; pending work stops
}
