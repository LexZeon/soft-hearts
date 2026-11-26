// The shell (wiring rewrite step 3, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-3.md):
// the two windows and the tray, the window list, broadcast / send, loading a window, the tray menu, the global shortcuts, the session's
// permission handlers and display-media, and the security half of secureWindow. Moved from electron/main.ts unchanged; what the
// moved code reads from the rest of the app comes through ShellPorts (read at each call, never kept).
// The functions electron/main.ts calls from its ready chain and before-quit (createTray, guardSession, registerShortcuts,
// releaseShell) take what they read as parameters so their statements are the ones main.ts had (the wiring golden inlines them).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, globalShortcut, Menu, nativeImage, session, Tray, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { StreamEvent } from '../../shared/contracts';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import { t } from '../../shared/foundation/ui-language';
import { allowsClipboardWrite } from '../safety';
import { trayBitmap, type SystemAudioRuntime } from '../senses';
import { rescueFromTray, type ClickThroughJournal, type SettingsStore } from '../settings';
import type { UnboundHost } from '../unbound';
import type { UnboundEntryHandle } from '../unbound/entry-wiring';
import type { AppSessionHost } from '../memory/app-session/host';
import { controlNavigateRequest } from '../../shared/initiative';
import { closeIpcShells, openIpcShells, type PartIpc } from './ipc-wiring';
import { IPC_SHELL_METHODS } from './ipc-shells-wiring';
import { deferControlsLoad, lateControlsRequested } from './late-controls-wiring';
import { partHealthTrayLine } from '../../shared/foundation/part-health';
import { entryMenuItem } from '../unbound/entry';
import { unboundEntryAllowed } from './channel-gates-wiring';
import { answerOffUnits, partHealth } from './health-wiring';
import { partRunner } from './parts-wiring';
/** The tray's own words through the interface language (`{0}` filled in), for the one line about a part that is off. */
const trayText = (source: string, ...values: readonly unknown[]): string => t(source, Object.fromEntries(values.map((value, index) => [String(index), String(value)])));

/** What the shell reads from the rest of the app, at the moment it needs it (electron/main.ts passes getters). */
export interface ShellPorts {
  readonly controls: BrowserWindow | null;
  readonly pet: BrowserWindow | null;
  readonly store: SettingsStore;
  readonly unbound: UnboundHost | null;
  readonly unboundEntry: UnboundEntryHandle | null;
  readonly appSession: AppSessionHost;
  /** Shown or hidden; click-through stays as the user saved it (I-223). */
  togglePet(): Promise<void>;
  /** The tray's rescue writes one journal row when it turns click-through off. */
  readonly appJournal: ClickThroughJournal;
  journalCharacterId(): string | null;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  sync(exclude?: number): void;
}

/** The tray: created once in the ready chain (createTray), read everywhere. The two windows stay electron/main.ts's (ShellPorts). */
export let tray: Tray | null = null;

let shellPorts: ShellPorts | null = null;
/** electron/main.ts calls this once at start-up, before anything broadcasts. */
export function wireShell(ports: ShellPorts): void { shellPorts = ports; }
function shell(): ShellPorts {
  if (!shellPorts) throw new Error('The shell is not wired.');
  return shellPorts;
}
/** The companion window as it is now (electron/main.ts creates it in the ready chain). */
export function petWindow(): BrowserWindow | null { return shell().pet; }

export const windows = () => {
  const { controls, pet } = shell();
  return [controls, pet].filter(
    (w): w is BrowserWindow =>
      !!w && !w.isDestroyed() && !w.webContents.isDestroyed(),
  );
};
export function broadcast(channel: string, value: unknown, exclude?: number): void {
  const { unbound } = shell();
  for (const win of windows())
    if (win.webContents.id !== exclude) win.webContents.send(channel, value);
  unbound?.retracted(channel, value); // read-aloud: her line taken back is taken out of her Unbound bubble too
  unbound?.voiceReply?.(channel, value); // Unbound v1 step 3: her spoken reply (a call) shows in her bubble too
  unbound?.mood?.(channel, value); // I-154 follow-up: her mood view reaches her full-screen face too (electron/unbound/mood-bridge.ts)
  try { broadcastTap?.(channel, value); } catch { /* a tap never stops a broadcast */ }
}
/** I-209 step 4: one listener of every broadcast (the stage's music relay to the others on stage, electron/wiring/unbound-senses-wiring.ts); null removes it. */
let broadcastTap: ((channel: string, value: unknown) => void) | null = null;
export function tapBroadcast(tap: ((channel: string, value: unknown) => void) | null): void { broadcastTap = tap; }
export function send(owner: number, event: StreamEvent): void {
  const { unbound } = shell();
  const recipients = event.kind === "chat" ? windows() : windows().filter(w => w.webContents.id === owner);
  for (const win of recipients) win.webContents.send("desk:stream", event);
  if (event.kind === "chat") unbound?.stream(event); // Unbound U1: her reply as a small bubble near her head
}
export function showControls(): void {
  const { controls } = shell();
  controls?.show();
  controls?.focus();
}
export function ownerFor(sender: number): MediaOwner {
  const { pet } = shell();
  return sender === pet?.webContents.id ? "pet" : "controls";
}
export function updateTray(): void {
  const { store, unbound, unboundEntry, appSession, togglePet, mutate, sync } = shell();
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      // Overhaul step 7: one line while a part is off (shared/foundation/part-health.ts); nothing on the companion.
      ...(partHealthTrayLine(partHealth(), trayText) ? [{ label: partHealthTrayLine(partHealth(), trayText), enabled: false }, { type: 'separator' as const }] : []),
      { label: t("打开控制台"), click: showControls },
      {
        label: store.current.pet.visible ? t("隐藏桌宠") : t("显示桌宠"),
        click: () => void togglePet(),
      },
      // Unbound v1 step 1; 「让她出来」 is left out while the way in is off (stable's default until the user switches it on in settings); coming back is always there
      ...(entryMenuItem(unbound?.state, unboundEntryAllowed()) ? [{ label: entryMenuItem(unbound?.state, unboundEntryAllowed()) === "back" ? t("回到小窗") : t("让她出来"), accelerator: "CommandOrControl+Alt+U", registerAccelerator: false, click: () => void unboundEntry?.toggle() }] : []),
      {
        label: t("恢复鼠标交互"),
        click: () =>
          void mutate(async () => {
            await rescueFromTray(store, shell().appJournal, shell().journalCharacterId()); // the user's explicit rescue: shown, click-through off (a journal row says how)
            sync();
          }),
      },
      { type: "separator" },
      { label: t("退出 soft hearts"), click: () => { appSession.noteCause('tray'); app.quit(); } },
    ]),
  );
}
/** The shell's handler inside the agent channel's recorder (moved from electron/main.ts's registerIPC, wiring rewrite step 5). */
export function registerShell(ipc: PartIpc): void {
  const { host } = ipc;
  // I-065: an optional page, the same move as 「带我去」 (the channel's open_control_page); navigation only, anything else is ignored.
  host('getPartHealth', () => partHealth()); // overhaul step 7: which units are off (read only, control window only: electron/wiring/health-wiring.ts)
  host("openControls", (page?: unknown, focus?: unknown) => { const { controls } = shell(); /* read when called */ showControls(); const request = controlNavigateRequest(page, focus); /* I-173: an item to flash (an element id, a card id); malformed parts are dropped */ if (request) controls?.webContents.send('desk:control-navigate', request); }, false);
}
/** 退出 from the control window: registered after the agent channel's recorder stopped (the channel never quits the app). */
export function registerQuit(ipc: PartIpc): void {
  const { host } = ipc;
  const { appSession } = shell(); // made while electron/main.ts is evaluated, never replaced
  host("quit", () => { appSession.noteCause('controls'); app.quit(); });
  answerOffUnits(); // step 7: the last registration: a unit that did not start answers PART_OFF, not "no handler"
  closeIpcShells(); // step 8: every part registered; a shell nothing filled answers "no handler" from here on (electron/wiring/ipc-wiring.ts)
  partRunner()?.startsDone(); // step 8: the parts' starts are over (SOFT_HEARTS_FAIL_PART then reaches every tick and callback)
}
/** Sync step (托盘): the tray menu follows the settings (wireSettingsSync in electron/main.ts gives the order). */
export function syncTray(): void {
  updateTray();
}
export async function loadWindow(win: BrowserWindow, petMode: boolean): Promise<void> {
  const devUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
  if (devUrl) {
    const url = new URL(devUrl);
    if (petMode) url.searchParams.set("pet", "1");
    await win.loadURL(url.href);
  } else
    await win.loadFile(path.join(__dirname, "../dist/index.html"), {
      query: { ...(petMode ? { pet: "1" } : {}), ...(["SOFT_HEARTS_STAGE_DIAGNOSTICS", "SOFT_HEARTS_PET_DIAGNOSTICS"].some(name => process.env[name] === "1") ? { stageDiagnostics: "1" } : {}), ...(process.env.SOFT_HEARTS_CALM_PACE === "1" ? { calmPace: "1" } : {}) }, // P1 舞台少画: src/stage/stage-pace.ts readStageFlags
    });
}

/**
 * Overhaul step 8 (docs/claude/2026-11-17-lazy-loading-step8.md): the ready chain makes both windows right after the settings and the
 * interface language (the protocol, secureWindow and the permission handlers first), and they start loading here, while the parts that do
 * not draw start. A desk: call a window makes before its part registered waits in its IPC shell (electron/wiring/ipc-wiring.ts) until
 * registerIPC fills it; registerQuit closes the shells. The promise is awaited where the chain waited for both windows before.
 * With the developer switch SOFT_HEARTS_LATE_CONTROLS=1 (electron/wiring/late-controls-wiring.ts, off by default) only the companion loads now;
 * the control window loads on its first show.
 */
export function loadWindowsEarly(controls: BrowserWindow, pet: BrowserWindow): Promise<void> {
  openIpcShells(IPC_SHELL_METHODS);
  const late = lateControlsRequested(process.env) ? deferControlsLoad(controls, () => loadWindow(controls, false)) : null;
  const loaded = Promise.all([late ? null : loadWindow(controls, false), loadWindow(pet, true)]).then(() => undefined);
  loaded.catch(() => undefined); // awaited later in the chain: a failed load fails it there, as before
  return loaded;
}

/** The ready chain's tray (electron/main.ts). */
export function createTray(showControls: () => void): void {
  tray = new Tray(
    nativeImage.createFromBitmap(trayBitmap(false), { width: 24, height: 24 }),
  );
  tray.setToolTip(t("soft hearts · Ctrl+Alt+P 显示/隐藏"));
  tray.on("double-click", showControls);
}

/** What the session's media and display-capture checks read (electron/main.ts). */
export interface SessionGuardPorts {
  systemAudio: Pick<SystemAudioRuntime, 'displayStreams'>;
  stopSystemAudio(): void;
  allowsOwnedMedia(owner: MediaOwner, kind: 'audio' | 'video', manualCamera?: boolean): boolean;
}
/** The session's display-media and permission handlers, unchanged; the camera switch is read at each check. */
export function guardSession({ systemAudio, stopSystemAudio, allowsOwnedMedia }: SessionGuardPorts, cameraEnabled: () => boolean): void {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const currentPet = petWindow();
    if (!currentPet || currentPet.isDestroyed() || currentPet.webContents.isDestroyed()
      || request.frame !== currentPet.webContents.mainFrame) {
      callback(null);
      return;
    }
    const grant = systemAudio.displayStreams(currentPet.webContents.id, true, request.audioRequested);
    try {
      // Chromium requires video when requested. Supply only this exact companion frame,
      // which the client immediately stops; never enumerate a desktop source.
      callback(grant ? { ...grant, ...(request.videoRequested ? { video: request.frame! } : {}) } : null);
    } catch {
      stopSystemAudio();
      try { callback(null); } catch { /* A failed callback must not crash the host. */ }
    }
  });
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) => {
      // The app's own windows may write (never read) the clipboard: every 「复制」 button needs it.
      if (allowsClipboardWrite(permission, details.isMainFrame, !!webContents && windows().some((win) => win.webContents.id === webContents.id)))
        return true;
      if (permission === "display-capture")
        return !!webContents && webContents.id === petWindow()?.webContents.id
          && !!systemAudio.displayStreams(webContents.id, details.isMainFrame, true);
      if (
        permission !== "media" ||
        !webContents ||
        !details.isMainFrame ||
        !windows().some((win) => win.webContents.id === webContents.id)
      )
        return false;
      const owner = ownerFor(webContents.id);
      return details.mediaType === "audio"
        ? allowsOwnedMedia(owner, "audio")
        : details.mediaType === "video"
          ? allowsOwnedMedia(owner, "video", cameraEnabled())
          : allowsOwnedMedia(owner, "audio") ||
            allowsOwnedMedia(owner, "video", cameraEnabled());
    },
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (allowsClipboardWrite(permission, details.isMainFrame, windows().some((win) => win.webContents.id === webContents.id))) {
        callback(true);
        return;
      }
      if (permission === "display-capture") {
        callback(webContents.id === petWindow()?.webContents.id
          && !!systemAudio.displayStreams(webContents.id, details.isMainFrame, true));
        return;
      }
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : [];
      callback(
        permission === "media" &&
          details.isMainFrame &&
          windows().some((win) => win.webContents.id === webContents.id) &&
          !!mediaTypes?.length &&
          mediaTypes.every((type) =>
            allowsOwnedMedia(
              ownerFor(webContents.id),
              type,
              cameraEnabled(),
            ),
          ),
      );
    },
  );
}

/** The two global shortcuts (electron/main.ts ready chain). */
export function registerShortcuts(togglePet: () => Promise<void>, unboundEntry: () => UnboundEntryHandle | null): void {
  globalShortcut.register(
    "CommandOrControl+Alt+P",
    () => void togglePet(), // a plain show / hide; click-through is left as the user saved it (I-223)
  );
  globalShortcut.register("CommandOrControl+Alt+U", () => void unboundEntry()?.toggle()); // Unbound v1 step 1: out, or back to the small window
}
/** The shortcuts and the tray go last at quit (electron/main.ts before-quit). */
export function releaseShell(): void {
  globalShortcut.unregisterAll();
  tray?.destroy();
}

/** The security half of secureWindow (electron/wiring/lifecycle-wiring.ts): no new windows, no navigation, no webviews. */
export function guardWindowNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
