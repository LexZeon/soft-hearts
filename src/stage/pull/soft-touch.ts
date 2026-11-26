/**
 * I-136 step 5d「碰了才软」: which touches reach the jelly's layer 3 (src/stage/jelly/), and when.
 *   - a pull: the press dents the soft region under it (a kick along the view), holding moves that region's rest point with the
 *     drag (capped), letting go eases it back from what shows;
 *   - a pinch on her cheek: the same, on that cheek (her left / right), with the pinch's drag.
 * The jelly decides everything about shape and caps (soft-jelly.ts: the same cap as layer 3); this only says where and when.
 * Off (the switch in the lab, resolved by the host) or no soft region there: nothing happens, nothing is patched.
 */
import { Vector3, type Camera } from 'three';

/** What the stage's jelly offers (stage-jelly.ts). */
export interface JellyTouchPort {
  readonly touchEnabled: boolean;
  touchPress(point: Vector3, into: Vector3): number;
  touchPressKind(kind: 'cheeks', side: -1 | 0 | 1, into: Vector3): number;
  touchHold(region: number, offset: Vector3 | null): void;
}
export interface PinchInput { pinching: boolean; side: 'left' | 'right' | null; x: number; y: number }

const into = new Vector3(), right = new Vector3(), up = new Vector3(), offset = new Vector3();

export class SoftTouch {
  private pull = -1;
  private pinch = -1;
  private pinchSide: 'left' | 'right' | null = null;

  pullStart(jelly: JellyTouchPort | null | undefined, point: Vector3, camera: Camera): void {
    this.pullEnd(jelly);
    if (!jelly?.touchEnabled) return;
    this.pull = jelly.touchPress(point, camera.getWorldDirection(into));
  }
  /** `shown`: the pull as the body shows it (world); the region's rest point follows a part of it. */
  pullHold(jelly: JellyTouchPort | null | undefined, shown: Vector3): void { if (this.pull >= 0) jelly?.touchHold(this.pull, offset.copy(shown).multiplyScalar(0.25)); }
  pullEnd(jelly: JellyTouchPort | null | undefined): void { if (this.pull >= 0) jelly?.touchHold(this.pull, null); this.pull = -1; }

  /** Every frame with the pinch's state (src/mood/CheekPinch.ts feedback): a new pinch dents that cheek; its drag holds it. */
  pinchFrame(jelly: JellyTouchPort | null | undefined, pinch: PinchInput | null | undefined, camera: Camera, headWidth: number): void {
    const on = !!pinch?.pinching && (pinch.side === 'left' || pinch.side === 'right');
    if (!on || pinch!.side !== this.pinchSide) {
      if (this.pinch >= 0) jelly?.touchHold(this.pinch, null);
      this.pinch = -1; this.pinchSide = null;
      if (!on || !jelly?.touchEnabled) return;
      this.pinchSide = pinch!.side;
      this.pinch = jelly.touchPressKind('cheeks', pinch!.side === 'left' ? 1 : -1, camera.getWorldDirection(into));
    }
    if (this.pinch < 0 || !jelly) return;
    camera.updateWorldMatrix(true, false);
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize(); up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    // The pinch's drag is in head widths (screen down positive): the cheek is drawn along, capped by the jelly.
    jelly.touchHold(this.pinch, offset.copy(right).multiplyScalar(pinch!.x * headWidth * 0.2).addScaledVector(up, -pinch!.y * headWidth * 0.2));
  }

  /** Hidden or the model changed: the jelly clears itself; forget what was held. */
  reset(): void { this.pull = -1; this.pinch = -1; this.pinchSide = null; }
}
