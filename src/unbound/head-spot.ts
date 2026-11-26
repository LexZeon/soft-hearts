// Where her head is on the Unbound window (split out of main.ts 2026-11-18, no behaviour change): the point the preview script reads and the
// middle-and-radius the bubble, the user's line, the senses light and the small input box keep clear of.
import { Vector3, type PerspectiveCamera } from 'three';
import type { HeadSpot } from '../../shared/unbound/typing';
import { pixelsPerUnit } from './camera';
import type { UnboundFigure } from './figure';

type Frustum = Parameters<typeof pixelsPerUnit>[0];

export class HeadLocator {
  private readonly point = new Vector3();
  private readonly centre = new Vector3();
  /** The figure and the frustum change while the page runs (a new model, a new scene), so they are read through functions. */
  constructor(private readonly camera: PerspectiveCamera, private readonly figure: () => UnboundFigure | null, private readonly frustum: () => Frustum) {}

  /** A point a little above the head bone, window pixels, and whether it is on the window. */
  onWindow(): { x: number; y: number; visible: boolean } {
    const figure = this.figure();
    if (!figure?.head) return { x: 0, y: 0, visible: false };
    figure.head.getWorldPosition(this.point);
    this.point.y += figure.heightUnits * 0.1;
    const p = this.point.project(this.camera);
    const x = (p.x + 1) / 2 * innerWidth, y = (1 - p.y) / 2 * innerHeight;
    return { x, y, visible: p.z < 1 && x > -50 && x < innerWidth + 50 && y > 40 && y < innerHeight };
  }

  /**
   * Step 2: her head on the window as a middle and a radius that covers it (CSS px): where the reply bubble, the user's line, the senses
   * light and the small input box go, none of them over her face. Null when her head is not on the window.
   */
  spot(): HeadSpot | null {
    const figure = this.figure();
    if (!figure?.head) return null;
    figure.head.getWorldPosition(this.centre);
    this.centre.y += figure.heightUnits * 0.055; // the head bone is at the base of the head; the middle of the head is a little higher
    const ahead = this.camera.position.z - this.centre.z;
    if (!(ahead > 1e-3)) return null;
    const p = this.centre.project(this.camera);
    const x = (p.x + 1) / 2 * innerWidth, y = (1 - p.y) / 2 * innerHeight;
    const r = Math.max(12, figure.heightUnits * 0.075 * pixelsPerUnit(this.frustum(), innerHeight, ahead));
    return p.z < 1 && x > -r && x < innerWidth + r && y > -r && y < innerHeight + r ? { x, y, r } : null;
  }
}
