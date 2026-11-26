// She steps aside from the control window's input / send / stop area (Codex T-253 option 1; X-549).
// Record: docs/claude/2026-11-19-control-window-avoid.md. Tests: tests/companion-step-aside.test.ts.
//
// - Only when her body really covers that area (her estimated body, not the transparent window around her, while click-through is on),
//   only while the user is not dragging her, never right after the user dropped her there (until the control window moves or reappears).
// - A small move: at most STEP_ASIDE.maxStep DIP, eased over a few hundred milliseconds, every tick a short step (no teleport); she stays
//   inside the work area. When the control window goes away or no longer needs the room, she walks back the same way.
// - Her home is only what this object remembers: nothing is saved, and a move by anyone else (the user's drag, recovery, a resize, keeping
//   her off the taskbar) makes the current place her home. Her top-most state is not touched: only setBounds is called, which does not
//   lift a window (the topmost guard, I-062).
// The precise composer element is not located: the protected area is the control window's content bottom band, where the composer and
// its send / stop buttons sit on the chat page (src/settings/layout.ts). On other pages the band holds other controls; it is still the
// control window's bottom edge, so the rule stays the same.

export interface StepRect { x: number; y: number; width: number; height: number }
export const STEP_ASIDE = {
  /** Height of the protected band at the bottom of the control window's content (DIP), at most bandShare of its height. */
  band: 200, bandShare: 0.4,
  /** Her body must overlap the band by at least this much in both directions to count as covering it (DIP). */
  minOverlap: 24,
  /** Space left between her body and the band after stepping aside (DIP). */
  margin: 12,
  /** The longest step she takes (DIP); farther than this she stays and the user can drag her. */
  maxStep: 320,
  /** The move's duration: per DIP, within [minMs, maxMs]. */
  msPerDip: 2.2, minMs: 320, maxMs: 700,
  tickMs: 16,
  /** How often the rule is re-read while the control window is shown (a missed event, a drag that ended). */
  pollMs: 500,
} as const;

const right = (rect: StepRect) => rect.x + rect.width;
const bottom = (rect: StepRect) => rect.y + rect.height;
const finite = (rect: StepRect | null | undefined): rect is StepRect => !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const near = (a: StepRect, b: StepRect, slack = 2) => Math.abs(a.x - b.x) <= slack && Math.abs(a.y - b.y) <= slack && Math.abs(a.width - b.width) <= slack && Math.abs(a.height - b.height) <= slack;
const rectKey = (rect: StepRect) => `${rect.x},${rect.y},${rect.width},${rect.height}`;

/** A window that may be avoided: shown, not minimized, not destroyed. */
export interface AvoidableWindow { isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; getBounds(): StepRect; getContentBounds(): StepRect }
/** The control window's rectangle while it is on screen (the bubble keeps clear of all of it); null while hidden, minimized or closed. */
export function shownWindowRect(win: AvoidableWindow | null | undefined): StepRect | null {
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null;
  const rect = win.getBounds();
  return finite(rect) ? rect : null;
}
/** The control window's input / send / stop area: the bottom band of its content while it is on screen. */
export function protectedRegion(win: AvoidableWindow | null | undefined): StepRect | null {
  if (!shownWindowRect(win)) return null;
  const content = win!.getContentBounds();
  if (!finite(content)) return null;
  const height = Math.min(STEP_ASIDE.band, Math.round(content.height * STEP_ASIDE.bandShare));
  return { x: content.x, y: bottom(content) - height, width: content.width, height };
}

/** Her body inside her window: with click-through on the mouse passes everywhere else; with it off the whole window takes the mouse. */
export function bodyFootprint(win: StepRect, clickThrough: boolean): StepRect {
  if (!clickThrough) return { ...win };
  return { x: win.x + win.width * 0.25, y: win.y + win.height * 0.1, width: win.width * 0.5, height: win.height * 0.9 };
}
/** Her body covers the region by at least minOverlap in both directions. */
export function coversRegion(win: StepRect, region: StepRect, clickThrough: boolean): boolean {
  const body = bodyFootprint(win, clickThrough);
  const overlapX = Math.min(right(body), right(region)) - Math.max(body.x, region.x);
  const overlapY = Math.min(bottom(body), bottom(region)) - Math.max(body.y, region.y);
  return overlapX >= STEP_ASIDE.minOverlap && overlapY >= STEP_ASIDE.minOverlap;
}
function clampInto(win: StepRect, area: StepRect): StepRect {
  return { ...win, x: Math.round(Math.max(area.x, Math.min(right(area) - win.width, win.x))), y: Math.round(Math.max(area.y, Math.min(bottom(area) - win.height, win.y))) };
}
/** The nearest place within maxStep where her body clears the region, inside the work area; null when there is none. */
export function stepAsideTarget(home: StepRect, region: StepRect, area: StepRect, clickThrough: boolean): StepRect | null {
  const body = bodyFootprint(home, clickThrough), m = STEP_ASIDE.margin;
  const moves = [
    { dx: Math.floor(region.x - m - right(body)), dy: 0 },
    { dx: Math.ceil(right(region) + m - body.x), dy: 0 },
    { dx: 0, dy: Math.floor(region.y - m - bottom(body)) },
    { dx: 0, dy: Math.ceil(bottom(region) + m - body.y) },
  ];
  let best: { win: StepRect; distance: number } | null = null;
  for (const { dx, dy } of moves) {
    const win = clampInto({ ...home, x: home.x + dx, y: home.y + dy }, area);
    const distance = Math.hypot(win.x - home.x, win.y - home.y);
    if (distance < 1 || distance > STEP_ASIDE.maxStep || coversRegion(win, region, clickThrough)) continue;
    if (!best || distance < best.distance) best = { win, distance };
  }
  return best?.win ?? null;
}

export interface StepAsideDecision { target: StepRect; home: StepRect | null }
/**
 * Where she should be now. `home` is where she lives while stepped aside (null at home); `suppressed` means the user put her on this
 * region themselves. Pure: the controller below animates toward `target`.
 */
export function decideStepAside(input: { current: StepRect; home: StepRect | null; region: StepRect | null; area: StepRect; clickThrough: boolean; suppressed: boolean }): StepAsideDecision {
  const { current, home, region, area, clickThrough, suppressed } = input;
  const base = home ?? current;
  if (region && !suppressed && coversRegion(base, region, clickThrough)) {
    const target = stepAsideTarget(base, region, area, clickThrough);
    if (target) return { target, home: base };
    // No clear place within reach: stay where she is if that is already clear, else go (or stay) home.
    if (home && !coversRegion(current, region, clickThrough)) return { target: current, home };
  }
  return { target: base, home };
}

export interface StepAsideWindow { isDestroyed(): boolean; getBounds(): StepRect; setBounds(bounds: StepRect): void }
export interface StepAsidePorts {
  window(): StepAsideWindow | null;
  /** The protected region now (protectedRegion of the control window), or null. */
  region(): StepRect | null;
  /** The work area of the display holding this rectangle. */
  area(bounds: StepRect): StepRect;
  /** The user is dragging or resizing her (the window drag). */
  dragging(): boolean;
  /** She is shown at home (visible, not minimized, not out in Unbound). */
  enabled(): boolean;
  clickThrough(): boolean;
  now?(): number;
  schedule?(fn: () => void, ms: number): () => void;
}

/** The moving part: one eased move at a time toward decideStepAside's target; re-read on events and every pollMs. */
export class CompanionStepAside {
  private home: StepRect | null = null;
  /** What this object last set; anything else means someone else moved her. */
  private expected: StepRect | null = null;
  private move: { from: StepRect; to: StepRect; start: number; duration: number } | null = null;
  private cancelTick: (() => void) | null = null;
  private cancelPoll: (() => void) | null = null;
  private sawDrag = false;
  private suppressKey: string | null = null;
  private stopped = false;
  constructor(private readonly ports: StepAsidePorts) {}
  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private schedule(fn: () => void, ms: number): () => void {
    if (this.ports.schedule) return this.ports.schedule(fn, ms);
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  }
  /** Where she lives while stepped aside (for tests and diagnostics). */
  get homeBounds(): StepRect | null { return this.home ? { ...this.home } : null; }
  get moving(): boolean { return this.move !== null; }
  start(): void {
    if (this.stopped || this.cancelPoll) return;
    const poll = () => { this.cancelPoll = null; if (this.stopped) return; this.check(); this.cancelPoll = this.schedule(poll, STEP_ASIDE.pollMs); };
    this.cancelPoll = this.schedule(poll, STEP_ASIDE.pollMs);
  }
  stop(): void { this.stopped = true; this.cancelMove(); this.cancelPoll?.(); this.cancelPoll = null; }
  private cancelMove(): void { this.move = null; this.cancelTick?.(); this.cancelTick = null; }
  private forget(): void { this.cancelMove(); this.home = null; this.expected = null; }
  /** Her window moved (every 'move' event, ours included): a drag forgets the home at once. Other movers are noticed by check and tick. */
  windowMoved(): void {
    if (this.stopped) return;
    if (this.ports.dragging()) { this.sawDrag = true; this.forget(); }
  }
  /** Re-read the rule: the control window showed, hid, moved or resized, she showed, or the poll. */
  check(): void {
    if (this.stopped) return;
    if (!this.ports.enabled()) { this.cancelMove(); return; }
    if (this.ports.dragging()) { this.sawDrag = true; this.forget(); return; }
    const win = this.ports.window();
    if (!win || win.isDestroyed()) return;
    const current = win.getBounds();
    if (!finite(current)) return;
    if (this.expected && !near(current, this.expected)) this.forget();
    const region = this.ports.region();
    if (!region) this.suppressKey = null;
    else if (this.suppressKey !== null && this.suppressKey !== rectKey(region)) this.suppressKey = null;
    // The user just dropped her: wherever that is, it is her place for this control window position.
    if (this.sawDrag) { this.sawDrag = false; this.home = null; this.suppressKey = region ? rectKey(region) : null; }
    const suppressed = !!region && this.suppressKey === rectKey(region);
    const decision = decideStepAside({ current, home: this.home, region, area: this.ports.area(this.home ?? current), clickThrough: this.ports.clickThrough(), suppressed });
    if (near(decision.target, current, 1)) {
      this.cancelMove();
      if (this.home && near(decision.target, this.home, 1)) { this.home = null; this.expected = null; }
      else this.home = decision.home;
      return;
    }
    this.home = decision.home;
    if (this.move && near(this.move.to, decision.target, 1)) return;
    const distance = Math.hypot(decision.target.x - current.x, decision.target.y - current.y);
    const duration = Math.max(STEP_ASIDE.minMs, Math.min(STEP_ASIDE.maxMs, distance * STEP_ASIDE.msPerDip));
    this.cancelMove();
    this.move = { from: { ...current }, to: { ...decision.target, width: current.width, height: current.height }, start: this.now(), duration };
    this.expected = { ...current };
    this.cancelTick = this.schedule(() => this.tick(), STEP_ASIDE.tickMs);
  }
  private tick(): void {
    this.cancelTick = null;
    const move = this.move;
    if (!move || this.stopped) return;
    // A drag that began since the last tick owns the window now: never move her under the user's hand.
    if (this.ports.dragging() || !this.ports.enabled()) { if (this.ports.dragging()) { this.sawDrag = true; this.forget(); } else this.cancelMove(); return; }
    const win = this.ports.window();
    if (!win || win.isDestroyed()) { this.cancelMove(); return; }
    if (this.expected && !near(win.getBounds(), this.expected)) { this.forget(); return; }
    const t = Math.max(0, Math.min(1, (this.now() - move.start) / move.duration));
    const eased = t * t * t * (t * (t * 6 - 15) + 10); // smootherstep: speed starts and ends at zero
    const next = { x: Math.round(move.from.x + (move.to.x - move.from.x) * eased), y: Math.round(move.from.y + (move.to.y - move.from.y) * eased), width: move.from.width, height: move.from.height };
    this.expected = next;
    win.setBounds(next);
    if (t >= 1) {
      this.move = null;
      if (this.home && near(next, this.home, 1)) { this.home = null; this.expected = null; }
      return;
    }
    this.cancelTick = this.schedule(() => this.tick(), STEP_ASIDE.tickMs);
  }
}
