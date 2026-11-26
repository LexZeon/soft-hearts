/**
 * I-152 step 3 (docs/claude/2026-11-21-vrm-physics.md): her hips, thighs and shins as capsules, for a coat or skirt that has no colliders
 * of its own on her legs (the user's VRoid model's coat has none). Measured once, at rest, from her own mesh; the file is never changed.
 *
 *  - A thigh runs from its joint to her knee, a shin from the knee to her ankle, her hips across her two thigh joints.
 *  - The radius covers RADIUS_COVER of the vertices her leg bone weighs most on, measured from the capsule's axis, in the innermost
 *    layer of mesh round it (each primitive measured on its own, the smallest kept). Clothes are layers outside her skin: a coat partly
 *    skinned to her thigh would make her legs as wide as the coat (measured on One: thigh 12.9 cm with every vertex, 7.7 cm from her
 *    skin). A primitive mostly carried by spring bones (a skirt, the coat's hem) is left out altogether.
 *  - Too few vertices of its own: a share of the bone's length (FALLBACK_SHARE).
 */
import { Matrix4, Vector3, type Bone, type Object3D, type SkinnedMesh } from 'three';
import type { StandardBone } from '../../../shared/foundation/universal-skeleton';
import type { RigCollider } from './spring-rig';

/** The nearest point of segment ab to p (into out); a sphere when b is null. */
export function nearestOnSegment(p: Vector3, a: Vector3, b: Vector3 | null, out: Vector3): Vector3 {
  if (!b) return out.copy(a);
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, length2 = abx * abx + aby * aby + abz * abz;
  const t = length2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / length2)) : 0;
  return out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}

const RADIUS_COVER = 0.8;
const MIN_VERTICES = 6;
/** A primitive with at least this share of its vertices carried by spring bones is clothing that swings, not her body. */
const SWINGING_SHARE = 0.3;
const FALLBACK_SHARE = 0.13;
/** A primitive counts as a layer round her bone with at least this share of the bone's vertices. */
const LAYER_SHARE = 0.1;

/** Each body collider bone and where its capsule ends: the next joint down (or, for her hips, across her thigh joints). */
const SEGMENTS: readonly { slot: StandardBone; to: StandardBone | 'thighs' }[] = [
  { slot: 'lowerBody', to: 'thighs' }, { slot: 'legLeft', to: 'kneeLeft' }, { slot: 'legRight', to: 'kneeRight' },
  { slot: 'kneeLeft', to: 'ankleLeft' }, { slot: 'kneeRight', to: 'ankleRight' },
];
export const BODY_COLLIDER_BONES: readonly StandardBone[] = SEGMENTS.map(segment => segment.slot);

/** The capsule of one of her leg bones (or null when the model has no such bone), in that bone's space, file metres. */
export function measureBodyCollider(slot: StandardBone, model: { bone(slot: StandardBone): Bone | undefined; meshes: readonly SkinnedMesh[] }, swinging: ReadonlySet<Object3D>): RigCollider | null {
  const segment = SEGMENTS.find(entry => entry.slot === slot), bone = model.bone(slot);
  if (!segment || !bone) return null;
  bone.updateWorldMatrix(true, false);
  const local = (other: Bone | undefined) => other ? bone.worldToLocal(other.getWorldPosition(new Vector3())) : null;
  let a = new Vector3(), b: Vector3 | null;
  if (segment.to === 'thighs') {
    const left = local(model.bone('legLeft')), right = local(model.bone('legRight'));
    if (left && right) { a = left; b = right; } else b = left ?? right;
  } else b = local(model.bone(segment.to));
  if (!b) b = new Vector3(0, -0.3, 0);
  // Her leg is the innermost layer round the bone: each primitive's own radius, the smallest of those with enough vertices (a coat
  // skinned partly to her thigh is a layer outside her skin and legwear).
  const layers = ownDistances(bone, model.meshes, swinging, a, b), total = layers.reduce((sum, layer) => sum + layer.length, 0);
  const radii = layers.filter(layer => layer.length >= Math.max(MIN_VERTICES, total * LAYER_SHARE)).map(layer => quantile(layer, RADIUS_COVER));
  const radius = radii.length ? Math.min(...radii) : Math.max(0.02, a.distanceTo(b) * FALLBACK_SHARE);
  return { bone, offset: a, tail: b, radiusM: Math.max(0.01, radius), added: true };
}

/** Per primitive: distances (bone space: file metres) from the segment ab to each vertex her bone weighs most on; clothes that swing left out. */
function ownDistances(bone: Bone, meshes: readonly SkinnedMesh[], swinging: ReadonlySet<Object3D>, a: Vector3, b: Vector3): number[][] {
  const out: number[][] = [], v = new Vector3(), near = new Vector3(), toBone = new Matrix4();
  for (const mesh of meshes) {
    const geometry = mesh.geometry, position = geometry.getAttribute('position'), skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight');
    const skeleton = mesh.skeleton, index = skeleton?.bones.indexOf(bone) ?? -1;
    if (!position || !skinIndex || !skinWeight || index < 0 || !skeleton.boneInverses[index]) continue;
    const dominant = (i: number) => {
      let best = -1, weight = 0;
      for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.getComponent(i, k); if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); } }
      return best;
    };
    let carried = 0;
    for (let i = 0; i < position.count; i++) { const owner = skeleton.bones[dominant(i)]; if (owner && swinging.has(owner)) carried++; }
    if (position.count && carried / position.count >= SWINGING_SHARE) continue; // clothing that swings: not her leg's size
    toBone.multiplyMatrices(skeleton.boneInverses[index], mesh.bindMatrix);
    const layer: number[] = [];
    for (let i = 0; i < position.count; i++) {
      if (dominant(i) !== index) continue;
      v.fromBufferAttribute(position, i).applyMatrix4(toBone);
      layer.push(v.distanceTo(nearestOnSegment(v, a, b, near)));
    }
    if (layer.length) out.push(layer);
  }
  return out;
}

const quantile = (values: number[], q: number) => { values.sort((x, y) => x - y); return values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0; };
