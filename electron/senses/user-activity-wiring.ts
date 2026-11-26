import { BrowserWindow, powerMonitor } from 'electron';
import { createUserActivity, type UserActivityPorts } from './user-activity';
import { screenLookWithClaude } from './user-activity-look';
import type { ScreenLook, UserActivitySwitchView } from '../../shared/behaviors/user-activity/interface';

/**
 * I-006 第 1 步 for the app: Electron's own `powerMonitor` (idle seconds, lock, sleep) and the windows' focus. Called once from
 * electron/main.ts; the logic and the tests live in electron/senses/user-activity.ts.
 *
 * I-066 你现在方便吗: her last interaction, the local camera's "somebody in front" (P1, only while it runs), and the opt-in screen look
 * (only while the user's screen sharing is on: the existing 320×200 thumbnail and one haiku call, electron/senses/user-activity-look.ts).
 */
export function createElectronUserActivity(wiring: {
  directory(): string | null; broadcast(view: UserActivitySwitchView): void;
  lastInteractionAt?(): number | null; person?(): boolean | null;
  screen?: { on(): boolean; capture(signal: AbortSignal): Promise<string | null> };
  looked?(verdict: ScreenLook | 'failed'): void;
}) {
  const screen: UserActivityPorts['screen'] = wiring.screen
    ? { on: wiring.screen.on, capture: wiring.screen.capture, ask: (picture, signal) => screenLookWithClaude(picture, signal) } : undefined;
  return createUserActivity({
    directory: wiring.directory, broadcast: wiring.broadcast,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    windowFocused: () => BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && win.isFocused()),
    power: powerMonitor,
    lastInteractionAt: wiring.lastInteractionAt, person: wiring.person, screen, looked: wiring.looked,
  });
}
