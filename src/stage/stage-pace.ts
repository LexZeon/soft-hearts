/**
 * P1 舞台少画 (docs/claude/2026-11-16-stage-pace.md; plan: docs/claude/2026-11-16-wiring-rewrite-plan.md section 四).
 *
 * How many frames a second the companion stage draws right now. The user's fps setting stays the ceiling; the stage only draws
 * fewer while nothing on screen needs them:
 *  - full: the setting. While anything moves or responds (PaceReason), and for PACE_HOLD_MS after it ends;
 *  - away: min(setting, AWAY_FPS), on by default. The user is away (the host's signal, MmdStage.setUserAway) or she is asleep;
 *  - calm: min(setting, CALM_FPS) while she is calm and nothing moves. Behind a switch that is off by default (R29f: the user
 *    found 30 fps "一卡一卡" and confirmed the move to 60), turned on only for a trial (readStageFlags `calmPace`).
 *
 * Time stays continuous whatever the pace: the frame clock (frame-clock.ts acceptStageFrame) advances animation by the real
 * time since the last drawn frame (capped by MAX_ANIMATION_DELTA), so a slower pace samples the same motion less often and
 * never replays or skips any of it. Pure: no DOM, no three.js; the stage feeds it (MmdStage.framePace).
 */
import { frameRate } from './frame-clock';

/** Full pace stays this long after the last thing that moved or responded (ms). */
export const PACE_HOLD_MS = 1_500;
/** The away pace: a setting the user can already choose, and the one physics already runs at. */
export const AWAY_FPS = 24;
/** The calm pace (behind the switch). */
export const CALM_FPS = 30;
/** A body bone turning faster than this (°/s) is motion. Gene's idle (breathing, small life, a glance) peaks near 10.5. */
export const PACE_BODY_SPEED = 20;
/** A physics bone (hair, chest) turning faster than this (°/s) is motion. A trial value: no physics in the tests. */
export const PACE_PHYSICS_SPEED = 30;

export type PaceMode = 'full' | 'away' | 'calm';
/** What kept the stage at full pace (closed names, for the diagnostics only). */
export type PaceReason =
  | 'input' | 'pointer' | 'touch' | 'camera' | 'typing' | 'speaking' | 'reply' | 'chat-gesture' | 'her-action' | 'body-motion'
  | 'transition' | 'expression' | 'dance' | 'game' | 'tears' | 'fade' | 'moving' | 'physics' | 'preview';

export interface StagePaceSnapshot {
  /** Now, on the same clock as lastActiveAt (the stage uses its rAF time, ms). */
  readonly now: number;
  /** The user's fps setting (settings.pet.fps); frameRate() clamps it as the frame clock does. */
  readonly setting: unknown;
  /** When something last moved or responded (ms), or null for never. */
  readonly lastActiveAt: number | null;
  /** The host says the user is away or the screen is locked (no such broadcast yet: always false today). */
  readonly userAway: boolean;
  /** She is asleep (fatigue phase 'asleep'). */
  readonly asleep: boolean;
  /** The calm-30 switch (off by default). */
  readonly calmSwitch: boolean;
  /** She is calm: no touch, cheek or feeding phase in progress (the mood phase is idle). */
  readonly calm: boolean;
}
export interface StagePaceDecision { readonly fps: number; readonly mode: PaceMode }

/** Target fps for this frame. Full beats away beats calm; anything unsure stays at full. */
export function stagePace(snapshot: StagePaceSnapshot): StagePaceDecision {
  const full = frameRate(snapshot.setting);
  const last = snapshot.lastActiveAt;
  const held = last !== null && Number.isFinite(last) && Number.isFinite(snapshot.now) && snapshot.now - last < PACE_HOLD_MS;
  if (held || !Number.isFinite(snapshot.now)) return { fps: full, mode: 'full' };
  if (snapshot.userAway === true || snapshot.asleep === true) return { fps: Math.min(full, AWAY_FPS), mode: 'away' };
  if (snapshot.calmSwitch === true && snapshot.calm === true) return { fps: Math.min(full, CALM_FPS), mode: 'calm' };
  return { fps: full, mode: 'full' };
}

/**
 * The renderer-side flags: the companion window's URL query, which the host sets from its environment in one line of
 * electron/main.ts loadWindow (SOFT_HEARTS_STAGE_DIAGNOSTICS=1 or SOFT_HEARTS_PET_DIAGNOSTICS=1 → stageDiagnostics=1,
 * SOFT_HEARTS_CALM_PACE=1 → calmPace=1). The packaged page only (loadFile); a Vite dev-server run does not pass them.
 */
export interface StageFlags {
  /** Write the per-frame canvas `data-*` diagnostics (pretrial, smoke checks, SOFT_HEARTS_PET_DIAGNOSTICS). */
  readonly diagnostics: boolean;
  /** The calm-30 switch (SOFT_HEARTS_CALM_PACE=1; off by default). */
  readonly calmPace: boolean;
}
export const NO_STAGE_FLAGS: StageFlags = Object.freeze({ diagnostics: false, calmPace: false });

/** Reads `?stageDiagnostics=1&calmPace=1` (only the exact value "1" counts; anything else is off). */
export function readStageFlags(search: unknown): StageFlags {
  if (typeof search !== 'string' || !search) return NO_STAGE_FLAGS;
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return NO_STAGE_FLAGS; }
  return { diagnostics: params.get('stageDiagnostics') === '1', calmPace: params.get('calmPace') === '1' };
}

let forcedDiagnostics = false;
/** Tests and harnesses that read the canvas datasets turn them on here (the app reads its flags and developer mode). */
export function setStageDiagnostics(on: boolean): void { forcedDiagnostics = on === true; }
export function stageDiagnosticsForced(): boolean { return forcedDiagnostics; }

/**
 * The stage's pace state across frames: when something last moved or responded, and the latest decision. `note` marks
 * activity at a frame time; `wake` (an input between frames) is taken at the next frame's time.
 */
export class StagePaceTracker {
  private lastActiveAt: number | null = null;
  private woken = false;
  private reason: PaceReason | null = null;
  private decision: StagePaceDecision = { fps: frameRate(undefined), mode: 'full' };
  private frames = { full: 0, away: 0, calm: 0 };

  /** An input arrived between frames: the next frame is at full pace (the stage also clears its frame-due time). */
  wake(reason: PaceReason = 'input'): void { this.woken = true; this.reason = reason; }
  /** Something moved or responded on the frame at `now`. */
  note(now: number, reason: PaceReason): void { if (Number.isFinite(now)) { this.lastActiveAt = now; this.reason = reason; } }
  /** The pace for the frame at `now`. */
  decide(input: Omit<StagePaceSnapshot, 'lastActiveAt'>): StagePaceDecision {
    if (this.woken) { this.woken = false; if (Number.isFinite(input.now)) this.lastActiveAt = input.now; }
    this.decision = stagePace({ ...input, lastActiveAt: this.lastActiveAt });
    return this.decision;
  }
  /** A drawn frame at the current decision (counted for the diagnostics). */
  drawn(): void { this.frames[this.decision.mode]++; }
  /** Not drawing (hidden): no hold carries over. */
  reset(): void { this.lastActiveAt = null; this.woken = false; this.reason = null; }
  getState() { return { ...this.decision, reason: this.reason, lastActiveAt: this.lastActiveAt, frames: { ...this.frames } }; }
}
