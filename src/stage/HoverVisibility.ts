interface HoverClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
const clock: HoverClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface HoverRect { left: number; top: number; width: number; height: number; }
/** How far outside its box a hidden toolbar/chat already reveals itself for an approaching pointer (CSS px). */
export const HOVER_REVEAL_MARGIN = 24;
/** A layout-only test; no transparent input surface is created over the model. */
export function nearHoverZone(rect: HoverRect, x: number, y: number, alreadyNear = false): boolean {
  if (![rect.left, rect.top, rect.width, rect.height, x, y].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return false;
  const margin = alreadyNear ? 32 : HOVER_REVEAL_MARGIN;
  return x >= rect.left - margin && x < rect.left + rect.width + margin && y >= rect.top - margin && y < rect.top + rect.height + margin;
}

/** Mouse focus does not hold the toolbar open; a held drag and keyboard focus do. */
export class HoverVisibility {
  private inside = false;
  private held = false;
  private keyboard = false;
  private visible = false;
  private timer: unknown;
  private revision = 0;
  private contactActive = false;
  private contactFaded = false;
  private contactTimer: unknown;
  private contactRevision = 0;
  constructor(private readonly changed: (visible: boolean) => void, private readonly timers: HoverClock = clock) {}
  enter(): void { this.inside = true; if (!this.contactFaded || this.held || this.keyboard) this.show(); }
  leave(): void { this.inside = false; this.schedule(); }
  hold(held: boolean): void { this.held = held; if (held) this.show(); else this.release(); }
  focus(keyboard: boolean): void { this.keyboard = keyboard; if (keyboard) this.show(); else this.release(); }
  /** A hit starts one deadline. It never reveals an otherwise hidden zone. */
  contact(active: boolean): void {
    if (this.contactActive === active) return;
    this.contactActive = active;
    this.cancelContact();
    const faded = this.contactFaded;
    this.contactFaded = false;
    if (!active) {
      // A new real pointer/focus sample may reveal it again. A stale `inside`
      // value from the contact's entry must not resurrect a hidden toolbar.
      if (faded && !this.held && !this.keyboard) this.setVisible(false);
      else this.release();
      return;
    }
    this.cancel();
    const revision = this.contactRevision;
    this.contactTimer = this.timers.setTimeout(() => {
      if (revision !== this.contactRevision || !this.contactActive) return;
      this.contactTimer = undefined; this.contactFaded = true;
      if (!this.held && !this.keyboard) this.setVisible(false);
    }, 2000);
  }
  reset(): void {
    this.inside = this.held = this.keyboard = false;
    this.contactActive = this.contactFaded = false; this.cancelContact();
    this.cancel(); this.setVisible(false);
  }
  private release(): void {
    if (this.contactFaded && !this.held && !this.keyboard) { this.cancel(); this.setVisible(false); }
    else this.schedule();
  }
  private show(): void { this.cancel(); this.setVisible(true); }
  private schedule(): void {
    if (this.inside || this.held || this.keyboard || (this.contactActive && !this.contactFaded) || !this.visible || this.timer !== undefined) return;
    const revision = this.revision;
    this.timer = this.timers.setTimeout(() => {
      if (revision !== this.revision) return;
      this.timer = undefined; this.setVisible(false);
    }, 1000);
  }
  private cancel(): void {
    this.revision++;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private cancelContact(): void {
    this.contactRevision++;
    if (this.contactTimer !== undefined) this.timers.clearTimeout(this.contactTimer);
    this.contactTimer = undefined;
  }
  private setVisible(value: boolean): void { if (value !== this.visible) { this.visible = value; this.changed(value); } }
}
