/**
 * Unbound v1 step 2: the small input box's real window (docs/claude/2026-11-15-unbound-v1-step2-typing.md).
 *
 * Why a second window: the Unbound window is click-through and not focusable on purpose (clicking her must not take focus from
 * what the user is doing, and a transparent full-screen window that grabbed the keyboard would be the worst kind of overlay). Typing
 * needs the keyboard, so it gets its own tiny focusable window, next to her head, only while the user is typing to her.
 *
 * It is made on the first open and kept hidden afterwards (so the next open is instant), and destroyed when she goes back to the
 * small window or the app quits. It closes by itself when it loses focus (the user clicked elsewhere), on Esc, and after a send.
 * Its two requests are answered only for its own top frame; the page is a static file with the two-call preload.
 */
import { BrowserWindow, ipcMain, screen } from 'electron';
import type { ScreenSourceMenuView, ScreenSourceView } from '../../shared/senses';
import type { UnboundSenses } from '../../shared/unbound/senses';
import { INPUT_BOX_SIZE, INPUT_PANEL_SIZE } from '../../shared/unbound/typing';
import type { InputWatch } from './input-watch';
import path from 'node:path';
import type { Rect } from '../../shared/unbound/world';
import { currentUiLanguage } from '../../shared/foundation/ui-language';
import { UNBOUND_INPUT_CHANNELS } from './input-preload-api';
import type { BoxRefill, InputBoxPort } from './typing';
import { isInputWindowSender, type InputCallBridge } from './input-call';
import type { UnboundState } from '../../shared/unbound/scene';
import { UNBOUND_INPUT_PAGE, UNBOUND_INPUT_PRELOAD, inputWindowOptions } from './window-options';
import type { UnboundPageSource } from './window';
import type { DefaultPlaceLook } from '../../shared/unbound/life/place-record';
import type { CompanyLook } from '../../shared/unbound/company';

export interface InputBoxWiring {
  page: UnboundPageSource;
  /** Enter in the box (electron/unbound/typing.ts submit; it waits a moment for the control window's word that the line went out). */
  submit(text: string): Promise<{ ok: boolean; hint?: string }> | { ok: boolean; hint?: string };
  /** Esc in the box. */
  cancel(): void;
  /** 「打电话」: the call bridge (electron/unbound/input-call.ts) and where she is (a call can start only while she is out). */
  call: InputCallBridge;
  state(): UnboundState;
  /** I-190: the senses panel's two readers: the senses on now (the light's four), and the app's one screen choice. */
  senses?(): UnboundSenses | null;
  screen?: InputScreenPorts;
  /** I-190: 「和她一起看」 (electron/unbound/input-watch.ts). */
  watch?: InputWatch;
  /** 2026-11-23: a key went into the box (electron/unbound/typing.ts typed). */
  typed?(): void;
  /** 2026-11-23: the panel's 「设为默认位置」 (electron/unbound/place-keeper.ts); absent: the panel shows nothing of it. */
  place?: { look(): DefaultPlaceLook; set(on: boolean): DefaultPlaceLook | Promise<DefaultPlaceLook> };
  /** I-209 step 1: the panel's 「谁在场」 row (electron/unbound/company/host.ts); absent: the panel shows nothing of it. */
  company?: { look(): Promise<CompanyLook | null>; set(id: unknown, on: unknown): Promise<CompanyLook | null> };
  /** I-209 step 3: with several on stage, the name of the one whose box this is (the one you clicked); null alone: "对她说" as before. */
  to?(): string | null;
}
/** I-190: the screen choice (electron/wiring/screen-source-wiring.ts); only opaque ids cross, the titles are listed by the host. */
export interface InputScreenPorts {
  menu(): Promise<ScreenSourceMenuView>;
  choose(id: unknown): ScreenSourceView;
  subscribe(listener: (view: ScreenSourceView) => void): () => void;
}

/** A blur this soon after the box was shown is the window finishing taking focus, not the user clicking away. */
const BLUR_GRACE_MS = 250;

export class InputBoxWindow implements InputBoxPort {
  private win: BrowserWindow | null = null;
  private loaded: Promise<void> = Promise.resolve();
  private shownAt = 0;
  private wanted = false;
  private lastRect: Rect | null = null;
  private retried = false;
  private refill: BoxRefill | null = null;
  private readonly handlers = [UNBOUND_INPUT_CHANNELS.submit, UNBOUND_INPUT_CHANNELS.cancel, UNBOUND_INPUT_CHANNELS.call,
    UNBOUND_INPUT_CHANNELS.senses, UNBOUND_INPUT_CHANNELS.screenMenu, UNBOUND_INPUT_CHANNELS.chooseScreen, UNBOUND_INPUT_CHANNELS.panel,
    UNBOUND_INPUT_CHANNELS.watch, UNBOUND_INPUT_CHANNELS.toggleWatch, UNBOUND_INPUT_CHANNELS.typed, UNBOUND_INPUT_CHANNELS.place, UNBOUND_INPUT_CHANNELS.setPlace,
    UNBOUND_INPUT_CHANNELS.company, UNBOUND_INPUT_CHANNELS.setCompany];
  private unsubscribeCall: () => void = () => {};
  private unsubscribeScreen: () => void = () => {};
  /** I-190: the panel is open (the box is taller); where the box's top was before opening moved it up. */
  private panelOpen = false;
  private closedY: number | null = null;

  constructor(private readonly wiring: InputBoxWiring) {
    const owner = (event: { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }) => {
      if (!isInputWindowSender(event, this.win)) throw new Error('请求来源未授权。');
    };
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.submit, (event, text: unknown) => { owner(event); return this.wiring.submit(typeof text === 'string' ? text : ''); });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.cancel, event => { owner(event); this.wiring.cancel(); });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.typed, event => { owner(event); this.wiring.typed?.(); }); // 2026-11-23: only that a key went in
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.call, async (event, on: unknown) => {
      owner(event);
      const result = await this.wiring.call.request(on, () => this.wiring.state());
      if (result.ok && result.on) this.wiring.cancel(); // a call is hands-free: the box has done its job
      return result;
    });
    this.unsubscribeCall = this.wiring.call.subscribe(on => this.sendCallState(on));
    // I-190: the senses panel. Each answers only the box's own top frame; a pick is never a switch (it reaches only the screen choice).
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.senses, event => { owner(event); return this.wiring.senses?.() ?? null; });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.screenMenu, async event => { owner(event); return this.wiring.screen ? this.wiring.screen.menu() : { choice: null, entries: [] }; });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.chooseScreen, (event, id: unknown) => { owner(event); if (!this.wiring.screen) throw new Error('现在选不了屏幕。'); return this.wiring.screen.choose(id); });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.panel, (event, open: unknown) => { owner(event); this.fitPanel(open === true); });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.watch, event => { owner(event); return this.wiring.watch?.look() ?? null; });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.toggleWatch, async event => { owner(event); return this.wiring.watch ? this.wiring.watch.toggle() : null; });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.place, event => { owner(event); return this.wiring.place?.look() ?? null; });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.setPlace, (event, on: unknown) => { owner(event); return this.wiring.place?.set(on === true) ?? null; });
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.company, async event => { owner(event); return this.wiring.company ? this.wiring.company.look() : null; }); // I-209
    ipcMain.handle(UNBOUND_INPUT_CHANNELS.setCompany, async (event, id: unknown, on: unknown) => { owner(event); return this.wiring.company ? this.wiring.company.set(id, on) : null; });
    this.unsubscribeScreen = this.wiring.screen?.subscribe(view => this.sendTo(UNBOUND_INPUT_CHANNELS.screenState, view)) ?? (() => {});
  }

  /** `panel`: a right click on her: the box opens with the senses panel open (`rect` is already the taller size). `refill`: a line that did not go out. */
  open(rect: Rect, panel = false, refill?: BoxRefill): void {
    this.lastRect = rect; this.retried = false; this.refill = refill ?? null;
    this.panelOpen = panel; this.closedY = null;
    this.openNow(rect, panel);
  }

  private openNow(rect: Rect, panel = false): void {
    const win = this.ensure();
    this.wanted = true;
    this.shownAt = Date.now();
    win.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    void this.loaded.then(() => {
      if (!this.wanted || this.win !== win || win.isDestroyed()) return;
      this.shownAt = Date.now();
      win.setAlwaysOnTop(true, 'screen-saver'); // above her window (companion level) and everything the user has open
      win.show();
      win.focus();
      win.webContents.focus();
      const refill = this.refill; this.refill = null; // 2026-11-22: a line that did not go out comes back with the hint
      const to = (() => { try { return this.wiring.to?.() ?? null; } catch { return null; } })(); // I-209 step 3: whose box
      try { win.webContents.send(UNBOUND_INPUT_CHANNELS.open, refill || to ? { language: currentUiLanguage(), ...(refill ? { text: refill.text, hint: refill.hint } : {}), ...(to ? { to } : {}) } : currentUiLanguage()); } catch { /* closing */ }
      this.sendCallState(this.wiring.call.isOn());
      if (panel) this.sendTo(UNBOUND_INPUT_CHANNELS.panelOpen, true);
    });
  }

  /**
   * I-190: the panel opened (taller) or closed (back to the line). It grows downward and moves up only as far as the work area needs; closing
   * puts the line back where it was.
   */
  private fitPanel(open: boolean): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds(), height = open ? INPUT_PANEL_SIZE.height : INPUT_BOX_SIZE.height;
    this.panelOpen = open;
    if (bounds.height === height) return;
    let y = bounds.y;
    if (open) {
      const area = screen.getDisplayMatching(bounds).workArea, bottom = area.y + area.height - 8;
      if (y + height > bottom) { this.closedY = y; y = Math.max(area.y + 8, bottom - height); }
    } else if (this.closedY !== null) { y = this.closedY; this.closedY = null; }
    win.setBounds({ x: bounds.x, y, width: bounds.width, height });
  }

  private sendTo(channel: string, value: unknown): void {
    const win = this.win;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) { try { win.webContents.send(channel, value); } catch { /* closing */ } }
  }

  private sendCallState(on: boolean): void {
    const win = this.win;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) { try { win.webContents.send(UNBOUND_INPUT_CHANNELS.callState, on); } catch { /* closing */ } }
  }

  /** Step 4: the box is on screen (you are typing to her). */
  isOpen(): boolean { const win = this.win; return !!win && !win.isDestroyed() && win.isVisible(); }

  close(): void {
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

  /** The app is quitting: the window goes and the requests are no longer answered. */
  dispose(): void {
    this.destroy();
    this.unsubscribeCall();
    this.unsubscribeScreen();
    for (const channel of this.handlers) ipcMain.removeHandler(channel);
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { page } = this.wiring;
    const win = new BrowserWindow(inputWindowOptions({ x: 0, y: 0, width: 320, height: 78 }, path.join(page.electronDir, UNBOUND_INPUT_PRELOAD)));
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('blur', () => {
      if (this.win !== win || !this.wanted || Date.now() - this.shownAt < BLUR_GRACE_MS) return;
      this.wanted = false;
      if (!win.isDestroyed()) win.hide();
    });
    win.on('closed', () => { if (this.win === win) this.win = null; });
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => { if (isMainFrame) console.error(`Unbound input box page failed: ${code} ${description} ${url}`); });
    win.webContents.on('render-process-gone', (_event, details) => { console.error(`Unbound input box page process gone: ${details.reason}`); if (this.win === win) this.win = null; });
    this.loaded = (async () => {
      if (page.devUrl) await win.loadURL(new URL(UNBOUND_INPUT_PAGE, page.devUrl.endsWith('/') ? page.devUrl : `${page.devUrl}/`).href);
      else await win.loadFile(path.join(page.distDir, UNBOUND_INPUT_PAGE));
    })().catch(error => {
      // A page that did not load is no use: drop the window; if the box was wanted, one more try with a fresh window (a load
      // that fails once, seen in the smoke under load, usually works the second time), else the next click makes a fresh one.
      console.error('Unbound input box did not load', error);
      if (this.win === win) this.win = null;
      if (!win.isDestroyed()) win.destroy();
      if (this.wanted && !this.retried && this.lastRect && this.win === null) { this.retried = true; this.openNow(this.lastRect); }
      else this.wanted = false;
    });
    return win;
  }
}
