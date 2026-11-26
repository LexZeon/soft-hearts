/**
 * I-169 (docs/claude/2026-11-21-i169-gaze-debug.md): one frame of the gaze readout for the two flat hosts, the companion window's own stage
 * (src/stage/mmd/idle.ts) and the window on Unbound's engine (src/unbound/window-mode/window-liveliness.ts). Both know the cursor and her
 * eyes in the pointer's units (-1..1 of her window, y up), the head's and the eyes' turn as applied, and the chooser's readout; this turns
 * them into px and a `GazeDebugFrame` (gaze-debug-view.ts). Pure, read only; called only with developer mode on.
 *
 * Where her line of sight "meets the screen" is flat here: the window is the screen, so it is the look's angle carried the viewing
 * distance out (your reading's distance when pose sensing knows it, else about three half-widths: 60 cm on a 40 cm wide window).
 */
import type { GazeReadout } from '../../shared/senses';
import type { UserGazePoint } from '../../shared/behaviors/gaze-attention/geometry';
import { lineOfSight, unitsToPx, type GazeDebugFrame, type Px, type Turn } from './gaze-debug-view';

/** The viewing distance in half widths of the window when pose sensing does not know yours. */
export const DEFAULT_VIEW_HALF_WIDTHS = 3;

export interface FlatGazeInput {
  readonly dt: number;
  readonly width: number;
  readonly height: number;
  /** The stage's attention (null while it was never created) as StageGazeAttention.readout() gives it. */
  readonly attention: { chosen: GazeReadout; user: UserGazePoint | null } | null;
  readonly follow: boolean;
  readonly pointer: Px | null;
  readonly eyes: Px | null;
  readonly head: Turn;
  readonly eyesTurn: Turn;
}

export function flatGazeFrame(i: FlatGazeInput): GazeDebugFrame {
  const anchor = i.eyes ? unitsToPx(i.eyes.x, i.eyes.y, i.width, i.height) : null;
  const user = i.attention?.user ?? null;
  const distance = (user ? user.dx : DEFAULT_VIEW_HALF_WIDTHS) * i.width / 2;
  return {
    dt: i.dt, width: i.width, height: i.height, chosen: i.attention?.chosen ?? null, followMouse: i.follow, head: i.head, eyes: i.eyesTurn, anchor,
    mouse: i.follow && i.pointer ? unitsToPx(i.pointer.x, i.pointer.y, i.width, i.height) : null,
    user: user ? unitsToPx(user.x, user.y, i.width, i.height) : null,
    sight: anchor ? lineOfSight(anchor, i.head.yaw + i.eyesTurn.yaw, i.head.pitch + i.eyesTurn.pitch, distance) : null,
  };
}

/** The companion window's own stage (src/stage/MmdStage.ts), as far as the readout reads it. */
export interface LegacyGazeStage {
  readonly gazeAttention?: { readout(): { chosen: GazeReadout; user: UserGazePoint | null } } | null;
  readonly pointer: Px;
  readonly gaze: Px;
  readonly eyeGaze: Px;
  readonly moodFeedback?: { attentionWeight?: number } | null;
  readonly renderer?: { domElement?: { clientWidth: number; clientHeight: number } } | null;
}

/** The stage's head turn is in gazeTargets' radians (x right, y up), scaled down by the mood feedback's attention weight as it is applied. */
export function legacyGazeFrame(stage: LegacyGazeStage, dt: number, originX: number, originY: number, follow: boolean): GazeDebugFrame | null {
  try {
    const element = stage.renderer?.domElement, scale = 1 - (stage.moodFeedback?.attentionWeight ?? 0);
    return flatGazeFrame({ dt, width: element?.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0), height: element?.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 0),
      attention: stage.gazeAttention?.readout() ?? null, follow, pointer: stage.pointer, eyes: { x: originX, y: originY },
      head: { yaw: stage.gaze.x * scale, pitch: stage.gaze.y * scale }, eyesTurn: { yaw: stage.eyeGaze.x, pitch: stage.eyeGaze.y } });
  } catch { return null; } // a readout never breaks her
}
