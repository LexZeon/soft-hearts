import { BrowserWindow, powerMonitor } from 'electron';
import { createUserActivity } from './user-activity';
import type { UserActivitySwitchView } from '../shared/behaviors/user-activity/interface';

/**
 * I-006 第 1 步 for the app: Electron's own `powerMonitor` (idle seconds, lock, sleep) and the windows' focus. Called once from
 * electron/main.ts; the logic and the tests live in electron/user-activity.ts.
 */
export function createElectronUserActivity(wiring: { directory(): string | null; broadcast(view: UserActivitySwitchView): void }) {
  return createUserActivity({
    directory: wiring.directory, broadcast: wiring.broadcast,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    windowFocused: () => BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && win.isFocused()),
    power: powerMonitor,
  });
}
