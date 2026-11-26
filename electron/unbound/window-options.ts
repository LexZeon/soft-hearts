/** Unbound U1: the Unbound window's options (window.ts makes it). Kept apart so a test can read them without Electron. */
import type { BrowserWindowConstructorOptions } from 'electron';
import type { Rect } from '../../shared/unbound/world';

export const UNBOUND_PAGE = 'src/unbound/index.html';
export const UNBOUND_PRELOAD = 'unbound-preload.cjs';

export function unboundWindowOptions(bounds: Rect, preload: string): BrowserWindowConstructorOptions {
  return {
    x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)),
    transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false, thickFrame: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, show: false, alwaysOnTop: false, title: 'soft hearts · Unbound',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true, spellcheck: false },
  };
}

/**
 * Unbound v1 step 2: the small input box beside her head. The Unbound window itself can never take the keyboard (focusable:
 * false, so clicking her never steals focus from the user's own window), so typing to her happens in this second, tiny window:
 * focusable, frameless, above everything, no taskbar button, hidden until a click on her (or the shortcut) opens it. It loads one
 * static page of its own (src/unbound/input.html) with its own two-call preload, sandboxed like the Unbound page.
 */
export const UNBOUND_INPUT_PAGE = 'src/unbound/input.html';
export const UNBOUND_INPUT_PRELOAD = 'unbound-input-preload.cjs';

export function inputWindowOptions(bounds: Rect, preload: string): BrowserWindowConstructorOptions {
  return {
    x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)),
    transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false, thickFrame: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: true, show: false, alwaysOnTop: true, title: 'soft hearts · 对她说',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true, spellcheck: false }, // as the Unbound window
  };
}

/**
 * I-159 C: the card beside her (electron/unbound/card-window.ts): a card she offers while she is out shows here, with its buttons.
 * Frameless, transparent, above everything, no taskbar button, and not focusable: a tap on a button never takes the keyboard. One
 * static page (src/unbound/card.html) with its own two-call preload, sandboxed like the others.
 */
export const UNBOUND_CARD_PAGE = 'src/unbound/card.html';
export const UNBOUND_CARD_PRELOAD = 'unbound-card-preload.cjs';

export function cardWindowOptions(bounds: Rect, preload: string): BrowserWindowConstructorOptions {
  return {
    x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)),
    transparent: true, backgroundColor: '#00000000', frame: false, hasShadow: false, thickFrame: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true, title: 'soft hearts · Unbound card',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true, spellcheck: false },
  };
}
