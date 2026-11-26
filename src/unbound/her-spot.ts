/**
 * I-212 on the page: where her first frame stands, and the pull's bounds, in
 * screen terms through the one conversion (shared/unbound/screen-terms).
 *  - startPlacement: an entry's start comes as a look (`scene.start`: across, size) until the page has reported her height. Her first frame is
 *    placed by it with her measured height (the same measure UnboundFigure takes: figureHeightUnits), so she appears at the size the user
 *    should see on this screen. The host works out the same placement from the ready report's height: no jump, no walk.
 *  - followClamps: the pull's far / near bounds (shared/unbound/pull.ts followDepthRange) for this screen and her height.
 */
import type { SkinnedMesh } from 'three';
import type { UnboundScene } from '../../shared/unbound/scene';
import { MMD_UNIT_M, type Placement } from '../../shared/unbound/world';
import { placementOfLook } from '../../shared/unbound/screen-terms';
import { clampFollowDepth, clampFollowX, followDepthRange } from '../../shared/unbound/pull';
import { figureHeightUnits } from './figure';

/** Her first frame's placement: by the scene's start (screen terms) for this model's height, else the scene's placement as it is. */
export function startPlacement(scene: UnboundScene, mesh: SkinnedMesh): Placement {
  if (!scene.start) return scene.world.placement;
  return placementOfLook(scene.world, figureHeightUnits(mesh) * MMD_UNIT_M, scene.start) ?? scene.world.placement;
}

/** The pull's clamps (src/unbound/pull-input.ts ports): across inside her stand range, depth inside the screen-terms bounds for her height. */
export function followClamps(scene: () => UnboundScene | null, figure: () => { heightM: number; placement: Placement } | null, nearM: () => number | null | undefined) {
  return {
    clampX: (xM: number, depthM?: number) => { const s = scene(); return s ? clampFollowX(s.world, xM, depthM ?? figure()?.placement.depthM ?? s.world.placement.depthM) : xM; },
    clampDepth: (depthM: number) => { const s = scene(), f = figure(); return clampFollowDepth(depthM, nearM(), s && f ? followDepthRange(s.world, f.heightM) : undefined); },
  };
}
