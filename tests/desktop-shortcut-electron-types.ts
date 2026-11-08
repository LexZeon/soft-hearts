import type { shell } from 'electron';
import type { DesktopShortcutShell } from '../electron/desktop-shortcut';

// Type-only compatibility check; never imports or starts Electron at runtime.
declare const actualShell: typeof shell;
const compatible: DesktopShortcutShell = actualShell;
export type ElectronShellCompatibility = typeof compatible;
