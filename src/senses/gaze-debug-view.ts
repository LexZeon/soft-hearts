/**
 * I-169 (docs/claude/2026-11-21-i169-gaze-debug.md): developer mode shows where she looks.
 *
 * A small label that follows her (line 1 who she looks at, line 2 the three weights and the last reason she switched, line 3 how far her
 * eyes and head are turned) and a dot where her gaze lands on the screen. Read only: it shows what the stage and the chooser already hold
 * (numbers and closed words), changes nothing about how she looks, stores nothing and logs nothing.
 *
 * Only while developer mode is on: `gazeDebug(owner, on)` creates the view on the first frame with `on` and takes its nodes away the
 * frame `on` is false; with it off there is no DOM node and no per-frame work beyond one WeakMap lookup. The three hosts (the companion
 * window's stage, the window on Unbound's engine, full-screen Unbound) each give one frame of plain numbers (`GazeDebugFrame`).
 *
 * Pure parts (`gazeLines`, `blendSpot`, `lineOfSight`, `unitsToPx`, `GazeDot`) are tested without a DOM.
 */
import { uiText } from '../foundation/ui-language';
import type { GazeReadout } from '../../shared/senses';

export interface Px { readonly x: number; readonly y: number }
export interface Turn { readonly yaw: number; readonly pitch: number }

/** One frame of what a host knows (angles in radians as the stage applies them; yaw + = toward the screen's right as you see it, pitch + = up). */
export interface GazeDebugFrame {
  readonly dt: number;
  readonly width: number;
  readonly height: number;
  /** The chooser's readout; null while it has not been created (pose sensing never ran: she looks at the mouse, or at nothing when it is off). */
  readonly chosen: GazeReadout | null;
  /** 「跟着鼠标看」 is on (matters only without the chooser). */
  readonly followMouse: boolean;
  /** What is applied now: the head's turn and the eyes' turn in her head. */
  readonly head: Turn;
  readonly eyes: Turn;
  /** Her eyes on the window (px; the label sits beside them), the cursor, your head, and where her line of sight meets the screen plane (px; null when it does not). */
  readonly anchor: Px | null;
  readonly mouse: Px | null;
  readonly user: Px | null;
  readonly sight: Px | null;
}

export interface GazeLineData {
  readonly target: 'user' | 'mouse' | 'away';
  readonly user: number; readonly mouse: number; readonly away: number;
  readonly why: string;
  readonly eyeDeg: number; readonly headDeg: number;
}

const DEG = 180 / Math.PI;
const finite = (value: number, otherwise = 0) => Number.isFinite(value) ? value : otherwise;
/** How far a turn is from straight ahead, in degrees. */
export const turnDeg = (turn: Turn): number => Math.hypot(finite(turn.yaw), finite(turn.pitch)) * DEG;
const one = (value: number) => (Math.round(finite(value) * 10) / 10).toFixed(1);
const weight = (value: number) => (Math.round(Math.max(0, Math.min(1, finite(value))) * 10) / 10).toFixed(1);

/**
 * What the label says when pose sensing never ran: she follows the mouse when 「跟着鼠标看」 is on, else she looks at neither (别处).
 */
export function fallbackReadout(followMouse: boolean): GazeReadout {
  return followMouse ? { target: 'mouse', user: 0, mouse: 1, away: 0, why: '' }
    : { target: 'away', user: 0, mouse: 0, away: 1, why: '没开「跟着鼠标看」' };
}

/** The three lines (the interface language's words; the Chinese is the source text). */
export function gazeLines(data: GazeLineData): readonly [string, string, string] {
  const who = { user: uiText('你'), mouse: uiText('鼠标'), away: uiText('别处') };
  const weights = `${who.user} ${weight(data.user)} · ${who.mouse} ${weight(data.mouse)} · ${who.away} ${weight(data.away)}`;
  const why = data.why ? uiText(data.why) : '';
  return [uiText('在看：{0}', who[data.target]), why ? `${weights} · ${uiText('刚换的原因：{0}', why)}` : weights,
    uiText('眼 {0}° · 头 {1}°', one(data.eyeDeg), one(data.headDeg))];
}

/** The pointer's units (-1..1, y up, her window) as px of a width x height surface. */
export const unitsToPx = (x: number, y: number, width: number, height: number): Px => ({ x: (finite(x) + 1) / 2 * width, y: (1 - finite(y)) / 2 * height });

/**
 * Where a look from `from` (px) with these angles meets a plane `distancePx` away (px): the window's flat version of "the line of sight
 * meets the screen". yaw + = right, pitch + = up. null when the distance or the angles are not usable.
 */
export function lineOfSight(from: Px, yaw: number, pitch: number, distancePx: number): Px | null {
  if (!(distancePx > 0) || !Number.isFinite(yaw) || !Number.isFinite(pitch) || Math.abs(yaw) >= 1.5 || Math.abs(pitch) >= 1.5) return null;
  return { x: from.x + Math.tan(yaw) * distancePx, y: from.y - Math.tan(pitch) * distancePx };
}

/**
 * The dot's goal: the cursor for the mouse's share, your head for yours, the line of sight for looking away, by the chooser's weights
 * (a switch is already a blend over its length, so the goal does not jump); a place that is not known leaves its share to the others.
 */
export function blendSpot(data: Pick<GazeLineData, 'user' | 'mouse' | 'away'>, places: { mouse: Px | null; user: Px | null; sight: Px | null }): Px | null {
  let total = 0, x = 0, y = 0;
  for (const [share, at] of [[data.mouse, places.mouse], [data.user, places.user], [data.away, places.sight]] as const) {
    if (!at || !(share > 0) || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    total += share; x += share * at.x; y += share * at.y;
  }
  return total > 1e-6 ? { x: x / total, y: y / total } : null;
}

/**
 * The dot eased in px: it heads for the goal at a speed that falls off as it gets close (and brakes in time to stop on it), its speed
 * never passing `maxSpeed` px/s and its speed changing by at most `maxAccel` px/s² (so a goal that switches far away is left from rest:
 * a few px in the first frame at 30 or 60 fps, not a jump). The first goal places it where it is (nothing to ease from).
 */
export class GazeDot {
  x = 0; y = 0;
  private vx = 0; private vy = 0;
  private placed = false;
  constructor(private readonly omega = 8, private readonly maxSpeed = 1800, private readonly maxAccel = 8000) {}

  /** Forget the place (the goal went away): the next goal appears in place. */
  reset(): void { this.placed = false; this.vx = this.vy = 0; }
  get shown(): boolean { return this.placed; }

  frame(dt: number, goal: Px): void {
    const step = Math.min(0.1, Math.max(0, finite(dt)));
    if (!this.placed) { this.x = goal.x; this.y = goal.y; this.vx = this.vy = 0; this.placed = true; return; }
    if (step <= 0) return;
    const dx = goal.x - this.x, dy = goal.y - this.y, dist = Math.hypot(dx, dy);
    if (dist < 0.05 && Math.hypot(this.vx, this.vy) < 1) { this.x = goal.x; this.y = goal.y; this.vx = this.vy = 0; return; }
    // The speed it wants: an exponential approach, but never more than it can brake from.
    const want = Math.min(this.maxSpeed, this.omega * dist, Math.sqrt(2 * this.maxAccel * 0.8 * dist)), k = dist > 0 ? want / dist : 0;
    let ax = dx * k - this.vx, ay = dy * k - this.vy;
    const change = Math.hypot(ax, ay), most = this.maxAccel * step;
    if (change > most) { ax *= most / change; ay *= most / change; }
    this.vx += ax; this.vy += ay;
    const nx = this.x + this.vx * step, ny = this.y + this.vy * step;
    // Never past the goal.
    if ((nx - this.x) * dx + (ny - this.y) * dy >= dist * dist) { this.x = goal.x; this.y = goal.y; this.vx = this.vy = 0; return; }
    this.x = nx; this.y = ny;
  }
}

const STYLE_LABEL = 'position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;white-space:pre;font:11px/1.35 ui-monospace,Consolas,monospace;'
  + 'color:#f4f7ff;background:rgba(20,26,40,0.72);border:1px solid rgba(160,190,255,0.5);border-radius:6px;padding:4px 7px;max-width:360px;';
const STYLE_DOT = 'position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;'
  + 'background:rgba(255,120,170,0.85);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.45);';
const MARGIN = 8;

type Doc = Pick<Document, 'createElement'> & { body: Pick<HTMLElement, 'append'> };

/** The label and the dot on a document; `frame` once per frame while developer mode is on. */
export class GazeDebugView {
  private readonly box: HTMLDivElement;
  private readonly dot: HTMLDivElement;
  private readonly easing = new GazeDot();
  private text = '';

  constructor(doc: Doc) {
    this.box = doc.createElement('div'); this.box.dataset.gazeDebug = 'label'; this.box.style.cssText = STYLE_LABEL;
    this.dot = doc.createElement('div'); this.dot.dataset.gazeDebug = 'dot'; this.dot.style.cssText = STYLE_DOT; this.dot.style.display = 'none';
    doc.body.append(this.box, this.dot);
  }

  /** One frame (null: the host could not build one). Anything that goes wrong here is dropped: the readout never breaks her. */
  frame(f: GazeDebugFrame | null): void {
    if (f) try { this.draw(f); } catch { /* read only; nothing to repair */ }
  }

  private draw(f: GazeDebugFrame): void {
    const chosen = f.chosen ?? fallbackReadout(f.followMouse);
    const data: GazeLineData = { target: chosen.target, user: chosen.user, mouse: chosen.mouse, away: chosen.away, why: chosen.why, eyeDeg: turnDeg(f.eyes), headDeg: turnDeg(f.head) };
    const text = gazeLines(data).join('\n');
    if (text !== this.text) { this.text = text; this.box.textContent = text; }
    // The label sits up and to the right of her eyes (kept inside the window); without an anchor it stays in the corner.
    const ax = f.anchor ? f.anchor.x + 34 : MARGIN, ay = f.anchor ? f.anchor.y - 62 : MARGIN;
    const w = this.box.offsetWidth || 190, h = this.box.offsetHeight || 54;
    const bx = Math.max(MARGIN, Math.min(ax, Math.max(MARGIN, f.width - w - MARGIN))), by = Math.max(MARGIN, Math.min(ay, Math.max(MARGIN, f.height - h - MARGIN)));
    this.box.style.transform = `translate(${Math.round(bx)}px,${Math.round(by)}px)`;
    const goal = blendSpot(data, { mouse: f.mouse, user: f.user, sight: f.sight });
    if (!goal) { this.easing.reset(); this.dot.style.display = 'none'; return; }
    this.easing.frame(f.dt, goal);
    // Past the window's edge the dot waits at the edge (dimmer): the screen goes on past what this window shows.
    const x = Math.max(MARGIN / 2, Math.min(f.width - MARGIN / 2, this.easing.x)), y = Math.max(MARGIN / 2, Math.min(f.height - MARGIN / 2, this.easing.y));
    this.dot.style.display = '';
    this.dot.style.opacity = x === this.easing.x && y === this.easing.y ? '1' : '0.45';
    this.dot.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
  }

  /** The dot's eased place (px), for tests. */
  get dotAt(): Px | null { return this.easing.shown ? { x: this.easing.x, y: this.easing.y } : null; }

  dispose(): void { this.box.remove(); this.dot.remove(); }
}

const views = new WeakMap<object, GazeDebugView>();

/**
 * The gate: the owner's view while `on`, made on first use; null while off, and the nodes of an earlier one are taken away at once.
 * With `on` false nothing is created and nothing is computed (callers write `gazeDebug(this, dev)?.frame(...)`: the frame is built only when on).
 */
export function gazeDebug(owner: object, on: boolean, doc?: Doc): GazeDebugView | null {
  const had = views.get(owner);
  if (!on) { if (had) { had.dispose(); views.delete(owner); } return null; }
  if (had) return had;
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  // A readout never breaks her: no usable document (a test stand-in, a page being torn down) means no readout.
  if (!target || typeof target.createElement !== 'function' || !target.body) return null;
  try { const view = new GazeDebugView(target); views.set(owner, view); return view; } catch { return null; }
}
