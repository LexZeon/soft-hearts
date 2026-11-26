/**
 * I-136 Unbound v1 step 5a「拉她」: one pull is one session (docs/claude/2026-11-18-unbound-step5-plan.md「5a」).
 *
 *   press on her → it becomes a pull once the pointer moved more than startMovePx or was held longer than startHoldMs (a click
 *   stays a click: shared/unbound/click.ts) → drag → release / cancel (Esc, the window hid, the pointer was lost, she fell asleep,
 *   the model changed) / break free (5e).
 *
 * Reports go to the brain side (electron/mood/touch/brain.ts) as a 'pull' touch: the part and side, how hard (the farthest the drag
 * got, as a share of fullPull × her height on screen), the direction at that moment, how long it was held, and how it ended. One
 * "still holding" report once the hold passes holdingReportMs, then one end report; a press that never became a pull reports
 * nothing. Fixed words and clamped numbers only (shared/mood/touch.ts parseTouchEvent checks them again on the host).
 *
 * No clock and no DOM of its own: the caller passes times and pixel positions, so tests drive it.
 */
import type { PullEnd, PullResponse, TouchPart } from '../../mood';
import { PULL_KNOBS, type PullKnobs } from './knobs';

/** Which part of her body answers a pull (the stage and Unbound map parts to bones through this). */
export type PullGroup = 'arm' | 'torso' | 'head' | 'leg';
export const PULL_GROUP_OF: Readonly<Record<TouchPart, PullGroup>> = Object.freeze({
  hand: 'arm', arm: 'arm', shoulder: 'torso', torso: 'torso', other: 'torso', head: 'head', face: 'head', hair: 'head', leg: 'leg', foot: 'leg',
});

export interface PullGrab { part: TouchPart; side: 'left' | 'right' | null }
export type PullPhase = 'idle' | 'pressed' | 'pulling';

/** What the host gets (it adds kind 'pull', the place and its own time). */
export interface PullReport {
  part: TouchPart;
  side: 'left' | 'right' | null;
  strength: number;
  direction?: { x: number; y: number };
  heldMs: number;
  ended: PullEnd;
  /** 5e: what her body did, when it was more than leaning (fixed words; shared/mood/touch.ts PULL_RESPONSES). */
  response?: PullResponse;
  /** 5c: steps she walked along (Unbound). */
  steps?: number;
}

export interface PullSessionPorts {
  report(report: PullReport): void;
}

interface Press { x: number; y: number; at: number; heightPx: number; grab: PullGrab }

const finite = (...values: number[]) => values.every(Number.isFinite);

export class PullSession {
  private press: Press | null = null;
  private pulling = false;
  private holdingSent = false;
  private dx = 0; private dy = 0;
  private peak = 0;
  private peakDirection: { x: number; y: number } | null = null;
  private response: PullResponse | null = null;
  private steps = 0;

  constructor(private readonly ports: PullSessionPorts, private readonly knobs: PullKnobs = PULL_KNOBS) {}

  get phase(): PullPhase { return !this.press ? 'idle' : this.pulling ? 'pulling' : 'pressed'; }
  get grab(): PullGrab | null { return this.press?.grab ?? null; }
  /** The drag from the press point (CSS px, x right, y down). */
  get drag(): { x: number; y: number } { return { x: this.dx, y: this.dy }; }
  /** How hard it is pulled right now, 0–1. */
  get strength(): number { return this.press ? this.strengthOf(this.dx, this.dy, this.press.heightPx) : 0; }

  /** A press on her (`grab` from the hit test); `heightPx`: her height on screen now. A press elsewhere is never a pull. */
  down(x: number, y: number, at: number, grab: PullGrab | null, heightPx: number): boolean {
    this.reset();
    if (!grab || !finite(x, y, at, heightPx) || heightPx <= 0) return false;
    this.press = { x, y, at, heightPx, grab: { part: grab.part, side: grab.side } };
    return true;
  }

  /** The pointer moved. Returns 'started' on the move that turned the press into a pull. */
  move(x: number, y: number, at: number): 'idle' | 'pressed' | 'started' | 'pulling' {
    const press = this.press;
    if (!press) return 'idle';
    if (!finite(x, y, at)) return this.pulling ? 'pulling' : 'pressed';
    this.dx = x - press.x; this.dy = y - press.y;
    this.notePeak();
    if (this.pulling) return 'pulling';
    if (Math.hypot(this.dx, this.dy) > this.knobs.startMovePx || at - press.at > this.knobs.startHoldMs) { this.pulling = true; return 'started'; }
    return 'pressed';
  }

  /** Time passed without a move: a held press becomes a pull; a long pull reports "still holding" once. */
  tick(at: number): 'started' | 'holding' | null {
    const press = this.press;
    if (!press || !Number.isFinite(at)) return null;
    if (!this.pulling) {
      if (at - press.at <= this.knobs.startHoldMs) return null;
      this.pulling = true;
      return 'started';
    }
    if (!this.holdingSent && at - press.at >= this.knobs.holdingReportMs) {
      this.holdingSent = true;
      this.send('holding', at);
      return 'holding';
    }
    return null;
  }

  /** The release. True when it was a pull (and was reported); a press that never became one reports nothing. */
  up(at: number): boolean { return this.end('released', at); }
  /** Esc, the window hid, the pointer was lost, she fell asleep, the model changed. */
  cancel(at: number): boolean { return this.end('cancelled', at); }
  /** I-196: a pull that starts by itself (the joystick's pointer left its dead zone, a wheel notch): true when it began. */
  begin(): boolean { if (!this.press || this.pulling) return false; this.pulling = true; return true; }
  /** Forget this press without a report (the host said no before anything showed). */
  drop(): void { this.reset(); }
  /** 5e: what her body did (kept for the reports from now on; "pulled back" is not undone by a later moment). */
  respond(response: PullResponse): void { if (this.pulling && this.response !== 'pulled-back') this.response = response; }
  /** 5c: she walked along this many steps so far (Unbound). */
  walked(steps: number): void { if (this.pulling && Number.isFinite(steps)) this.steps = Math.max(this.steps, Math.min(50, Math.floor(steps))); }
  /** 5e: she slipped free (only from a pull that is going on). */
  breakFree(at: number): boolean { return this.end('broke-free', at); }

  private end(ended: PullEnd, at: number): boolean {
    const was = this.pulling && !!this.press;
    if (was) this.send(ended, at);
    this.reset();
    return was;
  }

  private send(ended: PullEnd, at: number): void {
    const press = this.press!;
    const heldMs = Number.isFinite(at) ? Math.max(0, at - press.at) : 0;
    const report: PullReport = { part: press.grab.part, side: press.grab.side, strength: round(this.peak), heldMs: Math.round(heldMs), ended };
    if (this.peakDirection) report.direction = { x: round(this.peakDirection.x), y: round(this.peakDirection.y) };
    if (this.response) report.response = this.response;
    if (this.steps > 0) report.steps = this.steps;
    try { this.ports.report(report); } catch { /* a report is never a reason for an error */ }
  }

  private notePeak(): void {
    const press = this.press!, strength = this.strengthOf(this.dx, this.dy, press.heightPx), length = Math.hypot(this.dx, this.dy);
    if (strength >= this.peak && length > 0) { this.peak = strength; this.peakDirection = { x: this.dx / length, y: this.dy / length }; }
  }

  private strengthOf(dx: number, dy: number, heightPx: number): number {
    return Math.min(1, Math.hypot(dx, dy) / Math.max(1e-6, this.knobs.fullPull * heightPx));
  }

  private reset(): void {
    this.press = null; this.pulling = false; this.holdingSent = false; this.dx = 0; this.dy = 0; this.peak = 0; this.peakDirection = null;
    this.response = null; this.steps = 0;
  }
}

const round = (value: number) => Math.round(value * 1000) / 1000;
