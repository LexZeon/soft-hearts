/**
 * Full-screen Unbound: her silhouette on the window, for "is the cursor on her" (click-through only over her), which part a click lands
 * on, and her nearest point (the near plane). Moved out of main.ts (I-164 interaction, docs/claude/2026-11-20-vrm-interaction.md) so tests
 * run the page's own hit test: a VRM's capsules come from its own meshes (measureBodyCapsules → model/standard-capsules.ts), an MMD
 * model's from its mesh exactly as before. No DOM: the page passes its camera, window size and units-to-pixels.
 */
import { Vector3, type Camera, type SkinnedMesh } from 'three';
import { nearestCapsule, silhouetteDistance, type Capsule2D } from '../../shared/unbound/hit-test';
import { capsuleEnds, measureBodyCapsules, projectCapsules, type BoneCapsule } from '../foundation/body-capsules';

export class BodyHit {
  private mesh: SkinnedMesh | null = null;
  private capsules: BoneCapsule[] = [];
  /** Capsule ends in world space after the last update (pairs a0, b0, a1, b1 …). */
  readonly ends: Vector3[] = [];
  /** The capsules on the window after the last update (CSS px). */
  shown: Capsule2D[] = [];

  /** A newly loaded body: measured once (at rest, before she moves). */
  measure(mesh: SkinnedMesh): void { this.mesh = mesh; this.capsules = measureBodyCapsules(mesh); this.ends.length = 0; this.shown = []; }
  get count(): number { return this.capsules.length; }
  /** Each capsule's radius (model units), in the order of `ends`. */
  radii(): number[] { return this.capsules.map(capsule => capsule.r); }

  /** After her frame: the ends where she is shown now, and the window's capsules. `mesh` null: nothing on the window. */
  update(mesh: SkinnedMesh | null, camera: Camera, width: number, height: number, pixelsPerUnit: (aheadUnits: number) => number): void {
    if (!mesh || mesh !== this.mesh) { this.shown = []; return; }
    capsuleEnds(mesh, this.capsules, this.ends);
    this.shown = projectCapsules(this.capsules, this.ends, camera, width, height, pixelsPerUnit, this.shown);
  }

  /** Signed distance (CSS px) from the point to her silhouette (≤ 0 on her). */
  distance(x: number, y: number): number { return silhouetteDistance(x, y, this.shown); }
  /** The piece of her nearest the point: its skeleton bone and the signed distance, or null. */
  nearest(x: number, y: number): { bone: number | undefined; distance: number } | null {
    const hit = nearestCapsule(x, y, this.shown);
    return hit ? { bone: hit.capsule.bone, distance: hit.distance } : null;
  }
  /** Names of a skeleton bone and its ancestors, the bone first (the part names read them). */
  names(index: number): string[] {
    const names: string[] = [];
    let bone: { name: string; parent: unknown } | null = this.mesh?.skeleton.bones[index] ?? null;
    for (let depth = 0; bone && depth < 64; depth++) {
      names.push(bone.name);
      const parent: unknown = bone.parent;
      bone = parent && typeof (parent as { name?: unknown }).name === 'string' && (parent as { isBone?: boolean }).isBone ? parent as { name: string; parent: unknown } : null;
    }
    return names;
  }
}
