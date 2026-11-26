/**
 * I-164 interaction (docs/claude/2026-11-20-vrm-interaction.md): her body capsules for a model the standard skeleton drives (a VRM).
 *
 * The standard skeleton's mesh has no vertices, so everything that measured her silhouette from it (full-screen Unbound's hit test and
 * click, the pull in both modes) found nothing: clicks fell through to the desktop and she could not be pulled. Her capsules come from
 * the model's OWN skinned meshes instead (all of them: VRoid splits body, face, hair and clothes), fitted per model bone in that bone's
 * space (src/foundation/body-capsules.ts measureOwnBoneCapsules), and placed every frame by the model bone's world matrix (present() poses
 * it): a VRM rests in a T pose while the standard skeleton rests its arms at Gene's angle, so capsules on the model's own bones never
 * disagree with what is drawn. Each capsule names the standard bone it belongs to (the one that drives its model bone, else the nearest
 * driven ancestor's), so the part names (shared/mood/touch-part.ts read the standard names), the pull rig and everything keyed by the
 * standard skeleton's bones work as on an MMD model. Units are the standard mesh's (model units), like an MMD model's capsules.
 */
import type { Bone, Object3D } from 'three';
import type { LoadedModel } from '../../stage';
import { measureOwnBoneCapsules, type BoneCapsule } from '../../foundation/body-capsules';
import type { StandardBoneSpec } from './standard-skeleton';

/** The standard skeleton index each model bone belongs to: the spec that drives it, else its nearest driven ancestor's; else 下半身. */
export function standardOwnerOf(specs: readonly StandardBoneSpec[]): (bone: Object3D) => number {
  const driven = new Map<Object3D, number>();
  specs.forEach((spec, index) => { if (spec.drives && !driven.has(spec.drives)) driven.set(spec.drives, index); });
  const hips = Math.max(0, specs.findIndex(spec => spec.slot === 'lowerBody'));
  return bone => {
    for (let node: Object3D | null = bone, depth = 0; node && depth < 256; node = node.parent, depth++) {
      const index = driven.get(node);
      if (index !== undefined) return index;
    }
    return hips;
  };
}

/** Her capsules on the model's own meshes, each placed by its model bone and named by its standard bone. */
export function measureStandardCapsules(standard: Object3D, specs: readonly StandardBoneSpec[], model: Pick<LoadedModel, 'meshes'>): BoneCapsule[] {
  const owner = standardOwnerOf(specs);
  return measureOwnBoneCapsules(model.meshes, standard).map(({ bone, a, b, r }) => ({ bone: owner(bone), a, b, r, place: bone as Bone }));
}
