/**
 * Unbound U1: the Unbound window (docs/claude/2026-11-12-unbound-u1-part1.md).
 *
 * One frameless, transparent window over the primary display's work area (she never covers the taskbar), at the companion's level
 * ('pop-up-menu', electron/stage/pet-topmost.ts: set once, never re-raised on a timer, so a top-most window shown after her stays
 * above her). She stays above full-screen programs too, never hidden for them (I-199): raised once, without activation, at the
 * moment one comes to the front (`raiseUnboundWindow`, called by the host on that event only). It never takes focus (no activation
 * when she is clicked) and has no taskbar button. Clicks go through
 * (`setIgnoreMouseEvents(true, { forward: true })`: the page still sees the cursor move) until the page says the cursor is on
 * her. Measured in U0: a 3840x2280 transparent layer holds 60 fps here and click-through works full screen.
 *
 * The page is sandboxed, isolated, without Node, and gets only the preload's whitelist (preload-api.ts). It can open no window
 * and navigate nowhere; the session's media permission handler already refuses every window but the companion and controls.
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { applyPetTopmost, raisePet } from '../stage'; // no-pet-ok: the stage part's existing function names
import type { Rect } from '../../shared/unbound/world';
import { UNBOUND_PAGE, UNBOUND_PRELOAD, unboundWindowOptions } from './window-options';

export { UNBOUND_PAGE, UNBOUND_PRELOAD, unboundWindowOptions };

export interface UnboundPageSource {
  /** The Vite dev server (source runs), or undefined for the built page. */
  devUrl?: string;
  /** Folder with dist-electron's files (preload). */
  electronDir: string;
  /** The built renderer folder (dist/). */
  distDir: string;
}

/** The window, hidden and not loaded yet (the host knows it before its page can ask anything). */
export function createUnboundWindow(bounds: Rect, source: UnboundPageSource): BrowserWindow {
  const win = new BrowserWindow(unboundWindowOptions(bounds, path.join(source.electronDir, UNBOUND_PRELOAD)));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.setIgnoreMouseEvents(true, { forward: true });
  applyPetTopmost(win, true);
  return win;
}

/**
 * I-199: a full-screen program just came to the front: her own moment, to the top of the always-on-top band once (no activation, no
 * move). A full-screen program that is itself topmost no longer covers her; anything topmost shown after this is above her (I-062).
 */
export function raiseUnboundWindow(win: BrowserWindow): void {
  if (!win.isDestroyed()) raisePet(win); // no-pet-ok: the stage part's existing function name
}

/** Loads the page (dev server or the built file). */
export async function loadUnboundPage(win: BrowserWindow, source: UnboundPageSource, query: Record<string, string> = {}): Promise<void> {
  if (source.devUrl) {
    const url = new URL(UNBOUND_PAGE, source.devUrl.endsWith('/') ? source.devUrl : `${source.devUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    await win.loadURL(url.href);
  } else await win.loadFile(path.join(source.distDir, UNBOUND_PAGE), { query });
}
