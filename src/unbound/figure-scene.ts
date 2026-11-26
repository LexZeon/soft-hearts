/**
 * What a scene asks of a figure on the full-screen page (moved out of src/unbound/main.ts unchanged on 2026-11-24, I-209 step 1, so the page
 * file only shrinks and the others on stage use the same steps): her motion clips for a mesh, and her walk, stance and who she turns to.
 */
import type { AnimationClip } from 'three';
import type { VmdDataTransform } from '../foundation/vmd';
import { UNBOUND_BODY_DEFAULTS, type UnboundMotion, type UnboundScene } from '../../shared/unbound/scene';
import { loadClip, type UnboundFigure } from './figure';
import { loadPoseClip } from './rest-pose';

export const keyOfFigure = (s: UnboundScene) => JSON.stringify([s.modelUrl, s.reviewed]);
export const keyOfMotion = (s: UnboundScene) => JSON.stringify(s.motion);

/** Her motion layers as clips for this mesh (`transform`: a VRM's, or the retarget of a model that is not the reviewed Gene). */
export async function clipsFor(target: UnboundFigure, motion: UnboundMotion, transform: VmdDataTransform | undefined): Promise<{ pose: AnimationClip | null; gesture: AnimationClip | null; expression: AnimationClip | null }> {
  const load = (url: string | null) => url ? loadClip(url, target.mesh, transform) : Promise.resolve(null);
  const [pose, gesture, expression] = await Promise.all([loadPoseClip(motion, load), load(motion.gesture), motion.legacy ? Promise.resolve(null) : load(motion.expression)]);
  return { pose, gesture, expression };
}

/** Targets only: how she walks, how she stands, and who she turns to (your eye, on her floor's plane). */
export function applyBody(target: UnboundFigure, s: Pick<UnboundScene, 'body' | 'world'>): void {
  const body = s.body ?? UNBOUND_BODY_DEFAULTS;
  target.setGait({ speedMps: body.walkSpeedMps, stepLengthM: body.stepLengthM });
  target.setStance(body.stance);
  target.faceToward({ x: 0, z: s.world.viewerDistanceM });
}
