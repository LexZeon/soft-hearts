/**
 * Display-frame acceptance for the stage's single requestAnimationFrame loop.
 *
 * Reply, speech and waiting state are deliberately NOT inputs here: they may
 * change what a presentation layer shows, but never whether the base mixer
 * clock, breathing, gaze, physics and the renderer advance (R24). Only the
 * real display surface (host visibility, document visibility, size) and the
 * user's FPS cap decide.
 */
export interface FrameSurface {
  readonly hostVisible: boolean;
  readonly documentHidden: boolean;
  readonly width: number;
  readonly height: number;
}
export type FrameSkipReason = 'hidden' | 'zero-size' | 'throttled';
/**
 * `previous`: the accepted frame time to pass back next time (0 = none). `due`: R29f, when the next frame is
 * due on the cap's own schedule (pass it back too; 0 = none).
 */
export type FrameDecision =
  | { readonly render: false; readonly reason: FrameSkipReason; readonly previous: number; readonly due: number }
  | { readonly render: true; readonly delta: number; readonly physicsDelta: number; readonly previous: number; readonly due: number; readonly rearmed: boolean };

/** Animation stays bounded; physics sees the real gap so its stall reset can run. */
export const MAX_ANIMATION_DELTA = 0.1;
/** R29f: the default moved from 30 to 60 (settings migrate once, electron/validation.ts migrateStoredSettings). */
const DEFAULT_FPS = 60;
/**
 * R29f: how early (ms) a display callback may come and still take the frame that is due. Vsync times wobble by
 * a fraction of a millisecond; the old fixed 0.5 ms let a slightly early one skip, so a pose stood on screen for
 * a refresh longer and the next frame took a double step ("一卡一卡"). A quarter of the cap's interval, at most 4 ms.
 */
export const FRAME_SLACK_MS = 4;

export function frameRate(fps: unknown): number {
  return typeof fps === 'number' && Number.isFinite(fps) ? Math.min(60, Math.max(15, fps)) : DEFAULT_FPS;
}

/**
 * Pure decision for one rAF callback. `previous` is the last accepted frame
 * time (0 = none). A timestamp earlier than the accepted one re-arms the clock
 * instead of skipping every frame until real time catches up.
 *
 * R29f: frames are due on the cap's own fixed schedule (`due`, phase-locked to
 * the first frame), and a callback up to FRAME_SLACK_MS early still takes the
 * frame that is due. So a cap at the display's rate renders every refresh, a cap
 * at half of it every other one, and vsync wobble never adds a held frame. The
 * schedule restarts after a stall of a whole interval. Animation always advances
 * by the real time since the last rendered frame (bounded), never by the schedule.
 */
export function acceptStageFrame(previous: number, time: number, fps: unknown, surface: FrameSurface, due = 0): FrameDecision {
  if (!surface.hostVisible || surface.documentHidden) return { render: false, reason: 'hidden', previous: 0, due: 0 };
  if (!(surface.width > 0) || !(surface.height > 0)) return { render: false, reason: 'zero-size', previous: 0, due: 0 };
  const rate = frameRate(fps), interval = 1000 / rate;
  const last = Number.isFinite(previous) && previous > 0 ? previous : 0;
  const scheduled = Number.isFinite(due) && due > 0 ? due : 0;
  if (!Number.isFinite(time)) return { render: false, reason: 'throttled', previous: last, due: scheduled };
  const rearmed = last > 0 && time < last;
  const from = rearmed ? 0 : last;
  // A schedule from an older or foreign clock (or none yet) restarts from the last accepted frame.
  const slot = from ? (scheduled > from && scheduled <= from + 2 * interval ? scheduled : from + interval) : 0;
  if (from && time < slot - Math.min(FRAME_SLACK_MS, interval / 4)) return { render: false, reason: 'throttled', previous: from, due: slot };
  const physicsDelta = from ? Math.max(0, (time - from) / 1000) : 1 / rate;
  const next = from && time - slot < interval ? slot + interval : time + interval;
  return { render: true, delta: Math.min(physicsDelta, MAX_ANIMATION_DELTA), physicsDelta, previous: time, due: next, rearmed };
}

export interface FrameHeartbeatState {
  /** Rendered frames since this stage started. */
  readonly serial: number;
  readonly skipped: Readonly<Record<FrameSkipReason, number>>;
  readonly lastReason: FrameSkipReason | null;
  /** rAF time of the latest rendered frame. Compare with performance.now(). */
  readonly lastRenderAt: number | null;
  readonly rearmed: number;
}

/**
 * Small observable record of the frame loop, so a "frozen pet" can be told
 * apart on a real machine: no callbacks at all (serial and lastRenderAt stop),
 * skipped as hidden/zero-size, or rendering while some layer stays static.
 */
export class FrameHeartbeat {
  private serial = 0;
  private readonly skipped: Record<FrameSkipReason, number> = { hidden: 0, 'zero-size': 0, throttled: 0 };
  private lastReason: FrameSkipReason | null = null;
  private lastRenderAt: number | null = null;
  private rearmed = 0;

  record(decision: FrameDecision, time: number): void {
    if (decision.render) {
      this.serial++; this.lastReason = null; this.lastRenderAt = time;
      if (decision.rearmed) this.rearmed++;
    } else {
      this.skipped[decision.reason]++;
      if (decision.reason !== 'throttled') this.lastReason = decision.reason;
    }
  }

  getState(): FrameHeartbeatState {
    return { serial: this.serial, skipped: { ...this.skipped }, lastReason: this.lastReason,
      lastRenderAt: this.lastRenderAt, rearmed: this.rearmed };
  }
}
