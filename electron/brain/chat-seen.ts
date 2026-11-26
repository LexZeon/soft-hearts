import { chatSeen, type AwayWindow } from '../../shared/foundation/step-away';

/**
 * I-171 (docs/claude/2026-11-21-i171-minimize-keeps-her.md): her chat process is told whether she is seen, once at the start and on each
 * window event. A minimize counts as seen (the 10-minute idle rule, electron/brain/claude-session-idle.ts); only a hide to the tray is
 * "hidden" (the 3-minute rule).
 */
export interface SeenWindow extends AwayWindow { on(event: 'show' | 'hide' | 'minimize' | 'restore', listener: () => void): unknown }
export function watchChatSeen(win: SeenWindow, note: (seen: boolean) => void): void {
  for (const name of ['show', 'hide', 'minimize', 'restore'] as const) win.on(name, () => note(chatSeen(win)));
  note(chatSeen(win));
}
