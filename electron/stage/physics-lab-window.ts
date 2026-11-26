/**
 * R01 物理调参台: the developer-only lab window. One at a time, a normal framed window owned by nothing (the user tunes beside the
 * companion). Sandboxed, isolated, no Node; it gets only the preload's whitelist (physics-lab-preload-api.ts) and answers only to its own
 * main frame. It can open no window and navigate nowhere. Which model it shows, and where a tuning is stored, the host decides.
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { PHYSICS_LAB_EVENTS, PHYSICS_LAB_REQUESTS, type PhysicsLabModel } from '../../shared/stage/physics-lab';
import type { ModelPhysicsTuning } from '../../shared/stage/physics-tuning';
import { labSenderAllowed } from './physics-lab-guard';

export const PHYSICS_LAB_PAGE = 'src/stage/physics-lab/index.html';
export const PHYSICS_LAB_PRELOAD = 'physics-lab-preload.cjs';

export interface PhysicsLabPorts {
  /** The Vite dev server (source runs), or the built page; dist-electron for the preload. */
  page(): { devUrl?: string; electronDir: string; distDir: string };
  model(): Promise<PhysicsLabModel>;
  save(tuning: unknown): Promise<ModelPhysicsTuning>;
  clear(): Promise<boolean>;
}

export class PhysicsLabWindow {
  private window: BrowserWindow | null = null;
  private registered = false;

  constructor(private readonly ports: PhysicsLabPorts) {}

  get isOpen(): boolean { return !!this.window && !this.window.isDestroyed(); }

  /** Opens (or brings forward) the lab. */
  async open(): Promise<boolean> {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return true; }
    this.register();
    const page = this.ports.page();
    const win = this.window = new BrowserWindow({
      width: 1180, height: 820, minWidth: 900, minHeight: 600, show: false, title: 'soft hearts · 物理调参台', backgroundColor: '#1b1d24',
      webPreferences: { preload: path.join(page.electronDir, PHYSICS_LAB_PRELOAD), contextIsolation: true, nodeIntegration: false,
        sandbox: true, webSecurity: true, backgroundThrottling: false, spellcheck: false },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.on('closed', () => { if (this.window === win) this.window = null; });
    if (page.devUrl) await win.loadURL(new URL(PHYSICS_LAB_PAGE, page.devUrl.endsWith('/') ? page.devUrl : `${page.devUrl}/`).href);
    else await win.loadFile(path.join(page.distDir, PHYSICS_LAB_PAGE));
    return true;
  }

  /** The active model or its tuning changed: the lab reloads them. */
  changed(): void {
    const win = this.window;
    if (win && !win.isDestroyed()) win.webContents.send(PHYSICS_LAB_EVENTS.changed);
  }

  close(): void {
    const win = this.window; this.window = null;
    if (win && !win.isDestroyed()) win.destroy();
    if (this.registered) {
      for (const channel of Object.values(PHYSICS_LAB_REQUESTS)) ipcMain.removeHandler(channel);
      this.registered = false;
    }
  }

  /** Only the lab's own main frame is answered. */
  private allowed(event: IpcMainInvokeEvent): boolean {
    return labSenderAllowed(this.window, event.sender, event.senderFrame);
  }

  private register(): void {
    if (this.registered) return;
    this.registered = true;
    const guard = <T>(operation: (...args: unknown[]) => Promise<T>) => (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!this.allowed(event)) throw new Error('只有物理调参台窗口可以这样做。');
      return operation(...args);
    };
    ipcMain.handle(PHYSICS_LAB_REQUESTS.model, guard(() => this.ports.model()));
    ipcMain.handle(PHYSICS_LAB_REQUESTS.save, guard(tuning => this.ports.save(tuning)));
    ipcMain.handle(PHYSICS_LAB_REQUESTS.clear, guard(() => this.ports.clear()));
  }
}
