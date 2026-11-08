/**
 * Keeping her off the system's own bottom-of-screen UI (user report: "置顶还把下方系统托盘挡住了").
 *
 * The keep-on-top guard raises her to the top of the always-on-top band every 2 s (electron/pet-topmost.ts). The taskbar's
 * popups are always-on-top windows too: tray icon menus, the "show hidden icons" overflow, taskbar thumbnails. They open above
 * her, and the next raise put her over them where they overlap (she sits bottom right, right above the tray). The app has no
 * native module, so it cannot list those windows; what it can read cheaply is the cursor. Every one of those popups is opened
 * from the taskbar strip (a display's bounds outside its work area), so: while the cursor is on a taskbar strip, and for
 * `holdMs` after it last was, the periodic raise waits. Her own events (show, restore, the switch) still raise at once.
 *
 * Trade-off: a tray menu or flyout left open longer than `holdMs` next to her may be covered where they overlap; another
 * program's always-on-top window can stay above her for up to `holdMs` after the user last touched the taskbar (otherwise 2 s).
 * Sampling is one getCursorScreenPoint every 250 ms while she is shown with the switch on.
 */
export interface HoldRect { x: number; y: number; width: number; height: number }
export interface HoldDisplay { bounds: HoldRect; workArea: HoldRect }
export interface ShellHoldPorts {
  cursor(): { x: number; y: number };
  displays(): readonly HoldDisplay[];
  /** Only sampled while this is true (she is shown and the switch is on). */
  active(): boolean;
  now?(): number;
}

export const SHELL_HOLD_MS = 15_000;
export const SHELL_SAMPLE_MS = 250;

const inside = (r: HoldRect, p: { x: number; y: number }) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;

/** True when the point is on a display but outside its work area: the taskbar strip (or another docked shell bar). */
export function onShellStrip(displays: readonly HoldDisplay[], point: { x: number; y: number }): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return displays.some(d => inside(d.bounds, point) && !inside(d.workArea, point));
}

export class ShellUiHold {
  private lastOnStrip = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly ports: ShellHoldPorts, private readonly holdMs = SHELL_HOLD_MS) {}

  private now(): number { return this.ports.now?.() ?? Date.now(); }

  /** One cursor read. */
  sample(): void {
    try { if (onShellStrip(this.ports.displays(), this.ports.cursor())) this.lastOnStrip = this.now(); }
    catch { /* A failed read never holds or releases anything. */ }
  }

  /** Whether a periodic raise should wait now (samples first). */
  held(): boolean {
    this.sample();
    return this.now() - this.lastOnStrip < this.holdMs;
  }

  start(sampleMs = SHELL_SAMPLE_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { if (this.ports.active()) this.sample(); }, sampleMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
