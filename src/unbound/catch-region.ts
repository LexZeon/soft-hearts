/**
 * Full-screen Unbound: where the window catches the mouse. docs/claude/2026-11-25-click-through-tight.md
 *
 * Before: her bone capsules (radius covers 90% of a bone's vertices) were the whole answer, plus an 8 px margin to let go. Capsules are fat
 * where a bone's vertices spread (skirt, hair, sleeves), so empty space beside her took the mouse.
 * Now two steps, cheap first (the same two-step the small window uses, src/stage/pointer-passthrough.ts):
 *  1. coarse, every pointer move and frame, no GPU: the capsule distance. Farther than COARSE_MARGIN_PX from every capsule: nothing to ask.
 *  2. fine, only near her and at most every 50 ms: one 9x9 block of the frame she was just drawn into (StagePixelProbe, fence-based, no
 *     stall). Her alpha under the pointer decides; her outline is held a little wider (the probe's outer block) so it does not flicker.
 * The senses light and the game controls are DOM things with their own distance and are caught directly ('ui').
 */
import { PointerPassthrough, type PassthroughState, type PointTarget, type StageAlpha } from '../stage';
import type { InteractiveToggle } from '../../shared/unbound/hit-test';

/** The capsule prefilter only decides whether to ask the frame; the frame has the last word. Wide enough for thin hair tips and fingers. */
export const COARSE_MARGIN_PX = 16;

/** What is under the pointer, from the two distances (≤ 0 is on it): a control of hers, her coarse body, or nothing. */
export function figureTarget(bodyDistancePx: number, otherDistancePx: number, coarseMarginPx = COARSE_MARGIN_PX): PointTarget {
  if (otherDistancePx <= 0) return 'ui';
  return bodyDistancePx <= coarseMarginPx ? 'stage' : 'outside';
}

export interface FigureCatchPorts {
  toggle: InteractiveToggle;
  pointer: { readonly inside: boolean; readonly buttons: number };
  /** Page can be touched at all: she is shown, the page is visible, she is present. */
  available(): boolean;
  bodyDistance(x: number, y: number): number;
  otherDistance(x: number, y: number): number;
  probe(x: number, y: number, signal?: AbortSignal): Promise<StageAlpha | null>;
  /** A window mode that owns the mouse (none today in Unbound's figure page). */
  holds?(): boolean;
}

export class FigureCatch {
  private readonly controller: PointerPassthrough;
  constructor(private readonly ports: FigureCatchPorts) {
    const { toggle, pointer } = ports;
    this.controller = new PointerPassthrough({
      enabled: () => pointer.inside && ports.available(),
      holds: () => ports.holds?.() ?? false,
      classify: (x, y) => figureTarget(ports.bodyDistance(x, y), ports.otherDistance(x, y)),
      probe: (x, y, signal) => ports.probe(x, y, signal),
      request: async receive => {
        if (receive) toggle.pointer(0, pointer.buttons !== 0);
        else toggle.release(pointer.buttons !== 0 && pointer.inside);
        return toggle.interactive;
      },
      now: () => performance.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
  }
  /** A pointer reading (move, press, release) or a frame (she moves under a still cursor). */
  move(x: number, y: number, buttons: number): void { this.controller.move(x, y, buttons); }
  /** Something outside changed (frame, visibility, presence). */
  refresh(): void { this.controller.refresh(); }
  /** Clicks go through at once (the pointer left, the page was hidden, a peek started); a held button keeps her. */
  reset(): void { this.controller.leave(); this.controller.start(); }
  dispose(): void { this.controller.dispose(); }
  get state(): PassthroughState { return this.controller.state; }
}
