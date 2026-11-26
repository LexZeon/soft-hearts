import { hideEndsReply, type AwayWindow } from '../../shared/foundation/step-away';

/**
 * I-171 (docs/claude/2026-11-21-i171-minimize-keeps-her.md): what the companion window leaving the screen does, as steps the wiring hands in.
 * Off the screen the computer's sound stops and the pointer input ends; a hide to the tray also ends the reply she was finishing, a
 * minimize does not (she is only stepping away: the reply goes on and its bubble is kept for the window's return).
 *
 * 2026-11-24 (续, docs/claude/2026-11-24-watch-turns-off.md): a minimize is also told (`minimized`, BEFORE the sound stops, so what was on is seen as on),
 * and the window being back on the screen is told (`restored`); 「和她一起看」 pauses and resumes by itself with them.
 */
export interface CompanionHiddenPorts {
  onScreen(win: AwayWindow): boolean;
  stopSystemAudio(): void;
  cancelCompletedReply(): void;
  resetPointer(): void;
  minimized?(): void;
  restored?(): void;
}
export function companionHiddenStep(win: AwayWindow, ports: CompanionHiddenPorts): void {
  if (win.isVisible() && !win.isMinimized()) { try { ports.restored?.(); } catch { /* watching's own steps never change the window's */ } return; }
  if (win.isMinimized()) { try { ports.minimized?.(); } catch { /* the same */ } }
  if (!ports.onScreen(win)) ports.stopSystemAudio();
  if (hideEndsReply(win)) ports.cancelCompletedReply();
  ports.resetPointer();
}
