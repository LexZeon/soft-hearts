/**
 * I-159 C: the card's real window (electron/unbound/card-surface.ts decides what it shows). A small frameless window beside her
 * head, above everything, that does NOT take focus (showInactive, focusable:false: a tap on a button must not pull the keyboard
 * from what the user is doing). Made on the first card, kept hidden after it, destroyed when she goes back or the app quits.
 * Its one request (the tap) is answered only for its own top frame; the page is a static file with the two-call preload.
 */
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import type { ChatSettingCardView } from '../../shared/brain';
import type { Rect } from '../../shared/unbound/world';
import { currentUiLanguage } from '../../shared/foundation/ui-language';
import { UNBOUND_CARD_CHANNELS } from './card-preload-api';
import { cardRequestAllowed, type CardWindowPort } from './card-surface';
import { UNBOUND_CARD_PAGE, UNBOUND_CARD_PRELOAD, cardWindowOptions } from './window-options';
import type { UnboundPageSource } from './window';

export interface CardWindowWiring {
  page: UnboundPageSource;
  /** A tap in the card (the surface checks it names the card shown). */
  choose(request: unknown): Promise<unknown>;
}

export class UnboundCardWindow implements CardWindowPort {
  private win: BrowserWindow | null = null;
  private loaded: Promise<void> = Promise.resolve();
  private wanted = false;

  constructor(private readonly wiring: CardWindowWiring) {
    ipcMain.handle(UNBOUND_CARD_CHANNELS.choose, (event, request: unknown) => {
      const win = this.win;
      if (!cardRequestAllowed(win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents.id : null, event)) throw new Error('请求来源未授权。');
      return this.wiring.choose(request);
    });
  }

  show(rect: Rect, card: ChatSettingCardView): void {
    const win = this.ensure();
    this.wanted = true;
    win.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    void this.loaded.then(() => {
      if (!this.wanted || this.win !== win || win.isDestroyed()) return;
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
      this.send(card);
    });
  }

  push(card: ChatSettingCardView): void { void this.loaded.then(() => this.send(card)); }

  hide(): void {
    this.wanted = false;
    const win = this.win;
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  destroy(): void {
    this.wanted = false;
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  /** The app is quitting: the window goes and the request is no longer answered. */
  dispose(): void { this.destroy(); ipcMain.removeHandler(UNBOUND_CARD_CHANNELS.choose); }

  private send(card: ChatSettingCardView): void {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try { win.webContents.send(UNBOUND_CARD_CHANNELS.show, card, currentUiLanguage()); } catch { /* closing */ }
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { page } = this.wiring;
    const win = new BrowserWindow(cardWindowOptions({ x: 0, y: 0, width: 340, height: 250 }, path.join(page.electronDir, UNBOUND_CARD_PRELOAD)));
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('closed', () => { if (this.win === win) this.win = null; });
    win.webContents.on('render-process-gone', (_event, details) => { console.error(`Unbound card page process gone: ${details.reason}`); if (this.win === win) this.win = null; });
    this.loaded = (async () => {
      if (page.devUrl) await win.loadURL(new URL(UNBOUND_CARD_PAGE, page.devUrl.endsWith('/') ? page.devUrl : `${page.devUrl}/`).href);
      else await win.loadFile(path.join(page.distDir, UNBOUND_CARD_PAGE));
    })().catch(error => {
      console.error('Unbound card page did not load', error);
      if (this.win === win) this.win = null;
      if (!win.isDestroyed()) win.destroy();
      this.wanted = false;
    });
    return win;
  }
}
