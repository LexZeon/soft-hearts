// 声音's window steps (wiring rewrite step 5b, docs/claude/2026-11-17-wiring-step-5b.md), moved from electron/main.ts's windowEvents
// word for word. electron/main.ts's order list (wireWindowEvents, electron/wiring/window-events-wiring.ts) says which run on which window
// event, in which order; the wiring golden pins it. A window step is called with the window's scope (win, owner, windowId).
// What they read is 声音's own, bound once by wireVoiceCleanup to what its wire call provides (the objects electron/main.ts had).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import type { BrowserWindow } from 'electron';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import type { VoiceProvides } from './voice-wiring';

let speechRuntime!: VoiceProvides['speechRuntime'];
let dropReplySpeechOwner!: VoiceProvides['dropReplySpeechOwner'];
let voiceCall!: VoiceProvides['voiceCall'];
let speechPlaybackActivity!: VoiceProvides['speechPlaybackActivity'];

/** electron/main.ts binds the steps to 声音's own objects right after its wire call. */
export function wireVoiceCleanup(provides: VoiceProvides): void {
  ({ speechRuntime, dropReplySpeechOwner, voiceCall, speechPlaybackActivity } = provides);
}

/** I-188: a voice call with her is on (her moments never start then). False before 声音 is wired. */
export function voiceCallOn(): boolean { try { return voiceCall?.on === true; } catch { return false; } }

// ---- window steps

/** Window step: what this window was reading aloud, and the reply speech it owned, are dropped (a new page, its page gone, closed). */
export function dropWindowSpeech(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  speechRuntime.dropOwner(windowId);
  dropReplySpeechOwner(windowId);
}
/** Visibility step: the voice call checks it can go on. */
export function checkVoiceCall(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  voiceCall.check(); // I-091: a call ends when its window or her window leaves the screen
}

// ---- quit steps (electron/main.ts's wireQuit gives their order; electron/wiring/quit-wiring.ts)

/** Quit step: the playback lease ends. */
export function stopPlaybackActivity(): void {
  speechPlaybackActivity.dispose();
}
/** Quit step: reading aloud stops. */
export function stopSpeech(): void {
  speechRuntime.stop();
}
/** Quit step: the voice call ends. */
export function endVoiceCall(): void {
  voiceCall.dispose();
}
