/**
 * Keeping the companion window on top (the user's "保持置顶" switch).
 *
 * The rule (I-062): with the switch on she stays above ordinary windows.
 * She does not fight other always-on-top windows: any one that appears after her (the screenshot overlay, other programs'
 * pinned windows, the taskbar's popups) stays above her. She goes to the top of the always-on-top band only at her own
 * moments: shown or restored, the user clicks, drags or touches her (all activate her window), and the switch turned on.
 * Out in full-screen Unbound one more moment is hers (I-199): a full-screen program just came to
 * the front (electron/unbound/window.ts raiseUnboundWindow, once per arrival, never on a timer). She never takes focus.
 *
 * Measured on Windows (2026-11-06, scripts/pretrial launcher): after an outside loss of the topmost style, single
 * `setAlwaysOnTop(true, 'floating')` calls did not always bring it back. `applyPetTopmost` reads the result and, when the style
 * did not come back, toggles it off and on.
 *
 * Measured on Windows (2026-11-08 and 2026-11-10, isolated Electron 45 probe, native z-order read with GetWindow;
 * scripts/dev/topmost-probe, docs/claude/2026-11-10-topmost-rework.md):
 *  - 'floating' (Electron's default, also what `new BrowserWindow({ alwaysOnTop: true })` uses) inserts the window directly
 *    behind the taskbar. Inserting a window behind a window that is not topmost takes it, and every window in its owner
 *    family, out of the band; the taskbar is not topmost while a full-screen app is in front. Electron re-applies that
 *    insertion on restore while the flag is set. That is how the style used to be lost.
 *  - 'pop-up-menu' is plain HWND_TOPMOST: the top of the band, no activation, no move; one call restores a lost style. Every
 *    window of hers uses it, so nothing of hers is inserted behind the taskbar any more.
 *  - Calling it while she already has the style lifts her above every topmost window shown after her. The old guard did that
 *    every 2 s and covered a later topmost window (and a full-screen overlay) within 1.3 s. The periodic check now only reads
 *    the style.
 *  - Her owned windows (reply, emoji) share her style: they lose and regain it with her. A z-order call on an owned window
 *    (setAlwaysOnTop) drags her up with it; showInactive, hide and setBounds on them do not.
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

/**
 * Makes the style what is wanted and says how it went. "On" while she already has the style is no call at all: it must not
 * lift her over a window that appeared after her (settings changes go through here). A missing style is set (the top of the
 * band), verified and forced if needed.
 */
export function applyPetTopmost(win: TopmostWindow, want: boolean, level: TopmostLevel = PET_TOPMOST_LEVEL): TopmostOutcome {
  if (win.isDestroyed()) return 'failed';
  if (!want) {
    if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false, level);
    return win.isAlwaysOnTop() ? 'failed' : 'unchanged';
  }
  if (win.isAlwaysOnTop()) return 'unchanged';
  win.setAlwaysOnTop(true, level);
  if (win.isAlwaysOnTop()) return 'applied';
  // The call did not take (measured 2026-11-06 with 'floating'): force a real change, at most twice.
  for (let round = 0; round < 2 && !win.isAlwaysOnTop(); round++) {
    win.setAlwaysOnTop(false, level);
    win.setAlwaysOnTop(true, level);
  }
  if (win.isAlwaysOnTop() && win.isVisible() && !win.isMinimized()) win.moveTop();
  return win.isAlwaysOnTop() ? 'forced' : 'failed';
}

/** Her own moment: to the top of the band (no activation). A missing style is restored the same way. */
export function raisePet(win: TopmostWindow, level: TopmostLevel = PET_TOPMOST_LEVEL): TopmostOutcome | 'raised' {
  if (win.isDestroyed()) return 'failed';
  if (!win.isAlwaysOnTop()) return applyPetTopmost(win, true, level);
  win.setAlwaysOnTop(true, level);
  return 'raised';
}

/** Repairs of a style that keeps getting lost wait longer each time: 2 s, 4 s, 8 s ... 60 s; back to 2 s after 5 quiet minutes. */
export interface RepairBackoff { firstMs: number; maxMs: number; quietMs: number }
export const REPAIR_BACKOFF: RepairBackoff = { firstMs: 2_000, maxMs: 60_000, quietMs: 5 * 60_000 };
export function repairDelayMs(repairsInStreak: number, backoff: RepairBackoff = REPAIR_BACKOFF): number {
  return Math.min(backoff.maxMs, backoff.firstMs * 2 ** Math.max(0, Math.min(30, repairsInStreak - 1)));
}

export interface TopmostGuardPorts {
  window(): TopmostWindow | null;
  /** The saved "保持置顶" setting. */
  wanted(): boolean;
  log?(line: string): void;
  /** 体验记录: one repair (how it went, whether the window was shown, how many repairs since the app started); never the foreground app. */
  journal?(outcome: TopmostOutcome, visible: boolean, nth: number): void;
  now?(): number;
}

export type GuardCheck = TopmostOutcome | 'skipped' | 'ok' | 'waiting';

export class PetTopmostGuard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private repairs = 0;
  private streak = 0;
  private lastLossAt = Number.NEGATIVE_INFINITY;
  private nextRepairAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly ports: TopmostGuardPorts, private readonly level: TopmostLevel = PET_TOPMOST_LEVEL,
    private readonly backoff: RepairBackoff = REPAIR_BACKOFF) {}

  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private shown(): TopmostWindow | null {
    const win = this.ports.window();
    if (!win || win.isDestroyed() || !this.ports.wanted()) return null;
    return win.isVisible() && !win.isMinimized() ? win : null;
  }
  private record(win: TopmostWindow, outcome: TopmostOutcome): void {
    this.ports.log?.(`pet lost topmost; ${outcome}`);
    try { this.ports.journal?.(outcome, win.isVisible(), ++this.repairs); } catch { /* the journal never changes the guard */ }
  }

  /**
   * The periodic check. Only reads the style of a shown companion whose switch is on ('ok': nothing is called, she stays wherever
   * she is in the band). A lost style is put back, which lands her at the top of the band; when it keeps getting lost, the
   * next repair waits ('waiting', `repairDelayMs`), so she never ping-pongs with another window.
   */
  check(): GuardCheck {
    const win = this.shown();
    if (!win) return 'skipped';
    if (win.isAlwaysOnTop()) return 'ok';
    const now = this.now();
    if (now - this.lastLossAt >= this.backoff.quietMs) this.streak = 0;
    this.lastLossAt = now;
    if (now < this.nextRepairAt) return 'waiting';
    const outcome = applyPetTopmost(win, true, this.level);
    this.streak++;
    this.nextRepairAt = now + repairDelayMs(this.streak, this.backoff);
    this.record(win, outcome);
    return outcome;
  }

  /**
   * Her own moment (shown, restored, clicked, dragged, touched): to the top of the band at once, never held back. Not a repair
   * for the journal: at startup she is shown before the style is first set (the companion is created without it).
   */
  ownMoment(): GuardCheck | 'raised' {
    const win = this.shown();
    return win ? raisePet(win, this.level) : 'skipped';
  }

  /** Starts the periodic check: one boolean read every two seconds. */
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
