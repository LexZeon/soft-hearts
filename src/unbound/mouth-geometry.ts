/**
 * The lip gap's input (shared/behaviors/part-mix/mouth-gap.ts) from a model as the Unbound engine holds it (docs/claude/2026-11-22-mouth-shut-while-talking.md):
 *  - an MMD mesh: its own geometry, its vowel and smile/pucker morphs by the universal aliases (the same ones the flap and the face find);
 *  - a VRM through the standard body: the standard slot's binds (the VRM's own expressions or part shapes), summed on the face's vertex block.
 * Everything in the mesh's bind space (vertices through the bind matrix, bones from their inverse bind matrices), so it reads the same whatever
 * pose she is in when the model arrives. Which way she faces: her lips against her head bone. Read once per model; three.js math only, no DOM.
 */
import { Matrix3, Matrix4, Vector3, type Bone, type BufferAttribute, type InterleavedBufferAttribute, type SkinnedMesh } from 'three';
import { MORPH_ALIASES, type MorphSlot } from '../../shared/foundation/universal-skeleton';
import { lipGapMeter, mouthGapProfile, type LipGapInput, type LipGapMeter, type MouthGapProfile } from '../../shared/behaviors/part-mix/mouth-gap';
import type { MorphBind } from '../stage';
import type { Vowel } from '../../shared/behaviors/part-mix/interface';
import { StandardBody } from './model/standard-body';

type Attribute = BufferAttribute | InterleavedBufferAttribute;
/** The mixes the meter reads: the five vowels and the two mouth base shapes. */
export const GAP_KEYS = ['a', 'i', 'u', 'e', 'o', 'mouthSmile', 'mouthPucker'] as const satisfies readonly MorphSlot[];
type GapKey = typeof GAP_KEYS[number];

const bindOf = (mesh: SkinnedMesh): Matrix4 => (mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh && mesh.bindMatrix ? mesh.bindMatrix : new Matrix4();

function bindPositions(mesh: SkinnedMesh, position: Attribute): Float32Array {
  const bind = bindOf(mesh), out = new Float32Array(position.count * 3), v = new Vector3();
  for (let k = 0; k < position.count; k++) { v.fromBufferAttribute(position, k).applyMatrix4(bind); out[k * 3] = v.x; out[k * 3 + 1] = v.y; out[k * 3 + 2] = v.z; }
  return out;
}
/** One morph's offsets in bind space (relative), × weight, added into `into`. */
function addOffsets(into: Float32Array, mesh: SkinnedMesh, index: number, weight: number): boolean {
  const geometry = mesh.geometry, target = geometry.morphAttributes.position?.[index] as Attribute | undefined, position = geometry.getAttribute('position') as Attribute | undefined;
  if (!target || !position || target.count !== position.count || into.length !== position.count * 3) return false;
  const relative = geometry.morphTargetsRelative === true, linear = new Matrix3().setFromMatrix4(bindOf(mesh)), v = new Vector3(), r = new Vector3();
  for (let k = 0; k < position.count; k++) {
    v.fromBufferAttribute(target, k);
    if (!relative) v.sub(r.fromBufferAttribute(position, k));
    v.applyMatrix3(linear);
    into[k * 3] += v.x * weight; into[k * 3 + 1] += v.y * weight; into[k * 3 + 2] += v.z * weight;
  }
  return true;
}
/** A bone's place at bind (from the mesh's inverse bind matrix; a bone outside its skeleton: where it is now). */
function bindPlace(mesh: SkinnedMesh, bone: Bone | null | undefined): Vector3 | null {
  if (!bone) return null;
  const index = mesh.skeleton?.bones.indexOf(bone) ?? -1, inverse = index >= 0 ? mesh.skeleton.boneInverses[index] : null;
  if (inverse) return new Vector3().setFromMatrixPosition(inverse.clone().invert());
  bone.updateWorldMatrix(true, false);
  return bone.getWorldPosition(new Vector3());
}
function finish(mesh: SkinnedMesh, position: Attribute, morphs: Partial<Record<GapKey, Float32Array>>, eyes: readonly (Bone | null | undefined)[], head: Bone | null | undefined): LipGapInput | null {
  const a = morphs.a, eyePlaces = eyes.map(bone => bindPlace(mesh, bone)).filter((p): p is Vector3 => !!p), pivot = bindPlace(mesh, head) ?? eyePlaces[0];
  if (!a || !eyePlaces.length || !pivot) return null;
  const positions = bindPositions(mesh, position);
  let z = 0, w = 0;
  for (let k = 0; k < position.count; k++) { const m = Math.hypot(a[k * 3], a[k * 3 + 1], a[k * 3 + 2]); if (m > 0) { z += positions[k * 3 + 2] * m; w += m; } }
  return { positions, morphs, eyeY: eyePlaces.reduce((s, p) => s + p.y, 0) / eyePlaces.length, frontZ: w > 0 && z / w < pivot.z ? -1 : 1 };
}

/** The meter's input for an MMD mesh (Gene, a converted VRoid): null without an open-mouth morph or eye bones. `vowels`: the flap's own vowel morphs. */
export function mmdLipGapInput(mesh: SkinnedMesh, vowels: Readonly<Record<Vowel, number>>): LipGapInput | null {
  const position = mesh.geometry?.getAttribute('position') as Attribute | undefined, dictionary = mesh.morphTargetDictionary;
  if (!position || !dictionary) return null;
  const keys = Object.keys(dictionary);
  const indexOf = (slot: GapKey): number => {
    if (slot in vowels) return vowels[slot as Vowel];
    for (const alias of MORPH_ALIASES[slot]) { const key = keys.find(k => k.toLowerCase() === alias.toLowerCase()); if (key !== undefined) return dictionary[key]; }
    return -1;
  };
  const morphs: Partial<Record<GapKey, Float32Array>> = {};
  for (const slot of GAP_KEYS) {
    const index = indexOf(slot);
    if (index < 0) continue;
    const offsets = new Float32Array(position.count * 3);
    if (addOffsets(offsets, mesh, index, 1)) morphs[slot] = offsets;
  }
  const bones = mesh.skeleton?.bones ?? [], named = (name: string) => bones.find(b => b.name === name);
  // ui-zh-ok: MMD bone names inside the model file, not interface text
  return finish(mesh, position, morphs, [named('左目'), named('右目')], named('頭'));
}

/** The face's vertex block behind the standard body (a glTF mesh's primitives can share one position attribute): the one its あ moves the most vertices of. */
export function standardFaceBlock(model: { expression(slot: MorphSlot): readonly MorphBind[] }): { mesh: SkinnedMesh; position: Attribute } | null {
  let best: { mesh: SkinnedMesh; position: Attribute; moved: number } | null = null;
  for (const bind of model.expression('a')) {
    const position = bind.mesh.geometry.getAttribute('position') as Attribute | undefined, target = bind.mesh.geometry.morphAttributes.position?.[bind.index] as Attribute | undefined;
    if (!position || !target) continue;
    let moved = 0;
    for (let k = 0; k < target.count; k++) if (Math.abs(target.getX(k)) + Math.abs(target.getY(k)) + Math.abs(target.getZ(k)) > 1e-7) moved++;
    if (!best || moved > best.moved) best = { mesh: bind.mesh, position, moved };
  }
  return best;
}

/** The meter's input for a model behind the standard body (a VRM): its slots' binds summed on the face's vertex block. */
export function standardLipGapInput(model: { expression(slot: MorphSlot): readonly MorphBind[]; bone(slot: 'eyeLeft' | 'eyeRight' | 'head'): Bone | undefined }): LipGapInput | null {
  const best = standardFaceBlock(model);
  if (!best) return null;
  const { mesh, position } = best, morphs: Partial<Record<GapKey, Float32Array>> = {};
  for (const slot of GAP_KEYS) {
    // One bind per vertex block (every primitive sharing it carries the same target).
    const seen = new Set<number>(), offsets = new Float32Array(position.count * 3);
    let any = false;
    for (const bind of model.expression(slot)) {
      if (bind.mesh.geometry.getAttribute('position') !== position || seen.has(bind.index)) continue;
      seen.add(bind.index);
      any = addOffsets(offsets, bind.mesh, bind.index, bind.weight) || any;
    }
    if (any) morphs[slot] = offsets;
  }
  return finish(mesh, position, morphs, [model.bone('eyeLeft'), model.bone('eyeRight')], model.bone('head'));
}

/** The meter and the flap's profile from an input (null when the lips cannot be found). */
export function mouthGapOf(input: LipGapInput | null): { meter: LipGapMeter; profile: MouthGapProfile } | null {
  if (!input) return null;
  const meter = lipGapMeter(input), profile = mouthGapProfile(meter, input.morphs);
  return meter && profile ? { meter, profile } : null;
}

/** The flap's profile for the mesh the engine drives (a VRM's standard mesh: its model's face), or null (the flap stays uncalibrated). Never throws. */
export function mouthGapForMesh(mesh: SkinnedMesh, vowels: Readonly<Record<Vowel, number>>): MouthGapProfile | null {
  try {
    const standard = StandardBody.ofMesh(mesh);
    return mouthGapOf(standard ? standardLipGapInput(standard.model) : mmdLipGapInput(mesh, vowels))?.profile ?? null;
  } catch { return null; }
}
