/**
 * Keeping the pet window on top (the user's "保持置顶" switch).
 *
 * Measured on Windows (2026-11-06, scripts/pretrial launcher, native WS_EX_TOPMOST read next to isAlwaysOnTop): once the HWND has
 * lost its topmost style by anything outside this app, a single `setAlwaysOnTop(true, 'floating')` is not reliable. The first calls
 * after the loss left the window non-topmost; only a later call took. `applySettings` used to make that one call and never checked,
 * so a pet that lost the style stayed behind other windows until the user flipped the switch.
 *
 * `applyPetTopmost` makes the call, reads the result, and when the style did not come back toggles it off and on, then raises the
 * window. `PetTopmostGuard` re-checks while the pet is shown (a cheap `isAlwaysOnTop()` read) and on window events.
 *
 * Measured on Windows (2026-11-08, isolated Electron 45 probe, native z-order read with GetWindow): Electron's 'floating' level,
 * which is also its default and what `new BrowserWindow({ alwaysOnTop: true })` uses, does not put a window at the top of the
 * always-on-top band. It inserts it directly behind the taskbar (Shell_TrayWnd). An always-on-top window above the taskbar that
 * overlaps her stays above her, and applying 'floating' again (startup, the guard, the reply and emoji windows, which drag their
 * owner along) never lifts her. If the taskbar itself is not topmost at that moment, inserting behind it takes her out of the
 * band. 'pop-up-menu' is plain HWND_TOPMOST: the top of the band, no activation, no move. `PET_TOPMOST_LEVEL` is that level on
 * Windows; every window of hers uses it.
 */
export type TopmostLevel = 'floating' | 'pop-up-menu';
export function petTopmostLevel(platform: string = process.platform): TopmostLevel { return platform === 'win32' ? 'pop-up-menu' : 'floating'; }
export const PET_TOPMOST_LEVEL: TopmostLevel = petTopmostLevel();
export interface TopmostWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  isAlwaysOnTop(): boolean;
  setAlwaysOnTop(flag: boolean, level?: TopmostLevel): void;
  moveTop(): void;
}

export type TopmostOutcome = 'unchanged' | 'applied' | 'forced' | 'failed';

/** Applies the wanted state and says how it went. Asking for "off" is a plain call; "on" is verified and forced if needed. */
export function applyPetTopmost(win: TopmostWindow, want: boolean, level: TopmostLevel = PET_TOPMOST_LEVEL): TopmostOutcome {
  if (win.isDestroyed()) return 'failed';
  if (!want) {
    if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false, level);
    return win.isAlwaysOnTop() ? 'failed' : 'unchanged';
  }
  const had = win.isAlwaysOnTop();
  // Also when she already has the style: on Windows this call is what puts her back at the top of the band.
  win.setAlwaysOnTop(true, level);
  if (win.isAlwaysOnTop()) return had ? 'unchanged' : 'applied';
  // The call did not take (measured: the first two calls after an outside loss both did nothing): force a real change, at most
  // twice, then raise the window above the other topmost ones. The guard tries again two seconds later if this still fails.
  for (let round = 0; round < 2 && !win.isAlwaysOnTop(); round++) {
    win.setAlwaysOnTop(false, level);
    win.setAlwaysOnTop(true, level);
  }
  if (win.isAlwaysOnTop() && win.isVisible() && !win.isMinimized()) win.moveTop();
  return win.isAlwaysOnTop() ? 'forced' : 'failed';
}

export interface TopmostGuardPorts {
  window(): TopmostWindow | null;
  /** The saved "保持置顶" setting. */
  wanted(): boolean;
  log?(line: string): void;
  /** 体验记录: one repair (how it went, whether the window was shown, how many repairs since the app started); never the foreground app. */
  journal?(outcome: TopmostOutcome, visible: boolean, nth: number): void;
  /** True while the system's taskbar UI may be open near her (electron/pet-shell-hold.ts): periodic checks wait. */
  shellHeld?(): boolean;
}

export class PetTopmostGuard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private repairs = 0;
  constructor(private readonly ports: TopmostGuardPorts, private readonly level: TopmostLevel = PET_TOPMOST_LEVEL) {}

  /**
   * One check. Only a shown pet whose setting is on is touched; a hidden or minimized one is left alone (it is re-checked on
   * show). A pet that still has the style is raised back to the top of the band ('raised'), so an always-on-top window another
   * program shows later is under her again within one period: one SetWindowPos without activation, nothing changes when she is
   * already on top. Trade-off: another program's always-on-top window that overlaps her does not stay above her (that is what the
   * switch promises); if that program keeps raising itself too, the overlap can swap once per period. She never takes focus, so
   * typing and full-screen input are not interrupted.
   *
   * The periodic check waits ('held') while the taskbar's own popups may be open (`shellHeld`, electron/pet-shell-hold.ts), so
   * tray menus, the hidden-icons overflow and thumbnails are not covered. `fromEvent` is her own show/restore: it never waits.
   */
  check(fromEvent = false): TopmostOutcome | 'skipped' | 'raised' | 'held' {
    const win = this.ports.window();
    if (!win || win.isDestroyed() || !this.ports.wanted()) return 'skipped';
    if (!win.isVisible() || win.isMinimized()) return 'skipped';
    if (!fromEvent && this.ports.shellHeld?.()) return 'held';
    if (win.isAlwaysOnTop()) { win.setAlwaysOnTop(true, this.level); if (win.isAlwaysOnTop()) return 'raised'; }
    const outcome = applyPetTopmost(win, true, this.level);
    this.ports.log?.(`pet lost topmost; ${outcome}`);
    try { this.ports.journal?.(outcome, win.isVisible(), ++this.repairs); } catch { /* the journal never changes the guard */ }
    return outcome;
  }

  /** Starts the periodic check. Two seconds: the cost is one boolean read and one no-op SetWindowPos; a lost style or place is put back before it is noticed for long. */
  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.check(); } catch { /* A failed check must not hurt the app. */ } }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
