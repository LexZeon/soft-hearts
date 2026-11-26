/**
 * I-164 VRM gaps (docs/claude/2026-11-20-vrm-gaps.md): what the engine's companion layers read off an MMD model's own data, read off a
 * model on the standard skeleton (a VRM) instead. (native, no conversion).
 *
 *  - `standardFaceMesh`: the face as her face actions' exclusive (src/stage/face-exclusive.ts) reads it. The exclusive writes the standard
 *    morphs (cheekPuff, ウィンク …, standard-skeleton.ts) and works out which other morphs share their vertices; here each standard morph's
 *    vertices ARE the model's: its binds' morph targets, times the bind weights, laid side by side over every face mesh they touch. So a wink
 *    owns the blink and the smile eyes it overlaps on this model exactly as on an MMD model, and nothing else.
 *  - `standardCapabilities`: the capability card (shared/stage/model-capability.ts) from what the model has: its expression slots and its
 *    humanoid bones, the same rule as an MMD model's profile, with no user choices (the character page keeps none for a VRM yet).
 *  - `standardSleepBones`: the sleep body's bone lookup (src/stage/sleep-body.ts): the standard skeleton's bones, so it plans on the
 *    skeleton the engine drives and the pose reaches the model through the transfer.
 *  - `standardMouth`: where her mouth is (head space), from where her own "aa" moves the face.
 * Pure three.js over the loaded model; no DOM.
 */
import { BufferAttribute, Vector3, type Bone, type SkinnedMesh } from 'three';
import type { FaceExclusive, MorphBind } from '../../stage';
import { deriveModelCapabilities, type ModelCapabilities } from '../../../shared/stage';
import { MORPH_SLOTS, STANDARD_BONES, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import { standardMorphBinds } from './body-transfer';
import type { StandardBody } from './standard-body';

export type StandardFaceMesh = ConstructorParameters<typeof FaceExclusive>[0];

/** A morph target moves a vertex when its offset is longer than this (model units; the exclusive's own threshold is on its side). */
const MOVES = 1e-7;

/**
 * The face exclusive's view of this model's face: `morphTargetInfluences` is the standard mesh's (what the exclusive writes and the
 * transfer reads); the geometry is every face vertex the standard morphs touch, each morph's offsets summed from its binds.
 */
export function standardFaceMesh(body: Pick<StandardBody, 'mesh' | 'morphs' | 'model'>): StandardFaceMesh {
  const perMorph = body.morphs.map(morph => standardMorphBinds(body.model, morph));
  // Every distinct vertex block once (a glTF mesh's primitives may share one position attribute).
  const blocks = new Map<unknown, { mesh: SkinnedMesh; offset: number; count: number }>();
  let total = 0;
  for (const binds of perMorph) for (const bind of binds) {
    const position = bind.mesh.geometry.getAttribute('position');
    if (!position || blocks.has(position)) continue;
    blocks.set(position, { mesh: bind.mesh, offset: total, count: position.count });
    total += position.count;
  }
  const base = new Float32Array(total * 3);
  for (const [position, block] of blocks) {
    const attribute = position as BufferAttribute;
    for (let v = 0; v < block.count; v++) base.set([attribute.getX(v), attribute.getY(v), attribute.getZ(v)], (block.offset + v) * 3);
  }
  const morphs = perMorph.map(binds => new BufferAttribute(offsets(binds, blocks, total), 3)), rest = new BufferAttribute(base, 3);
  return {
    morphTargetInfluences: body.mesh.morphTargetInfluences,
    geometry: { getAttribute: name => name === 'position' ? rest : undefined, morphAttributes: { position: morphs }, morphTargetsRelative: true },
  };
}

function offsets(binds: readonly MorphBind[], blocks: Map<unknown, { offset: number; count: number }>, total: number): Float32Array {
  const out = new Float32Array(total * 3), seen = new Set<string>();
  for (const bind of binds) {
    const geometry = bind.mesh.geometry, position = geometry.getAttribute('position'), block = position ? blocks.get(position) : undefined;
    const target = geometry.morphAttributes.position?.[bind.index];
    if (!block || !target || target.count !== block.count) continue;
    const key = `${block.offset}:${bind.index}`;
    if (seen.has(key)) continue; // the same target through two primitives of one mesh counts once
    seen.add(key);
    const relative = geometry.morphTargetsRelative === true;
    for (let v = 0; v < block.count; v++) {
      const dx = target.getX(v) - (relative ? 0 : position!.getX(v)), dy = target.getY(v) - (relative ? 0 : position!.getY(v)), dz = target.getZ(v) - (relative ? 0 : position!.getZ(v));
      if (dx * dx + dy * dy + dz * dz <= MOVES * MOVES) continue;
      const at = (block.offset + v) * 3;
      out[at] += dx * bind.weight; out[at + 1] += dy * bind.weight; out[at + 2] += dz * bind.weight;
    }
  }
  return out;
}

/** What her face actions need of a model on the standard skeleton (window-motions.ts): the exclusive's face and how to show what it wrote. */
export function standardFaceOf(body: StandardBody): { mesh: StandardFaceMesh; present(): void } {
  return { mesh: standardFaceMesh(body), present: () => body.presentFace() };
}

/** The capability card of a model on the standard skeleton: what its own expressions and humanoid bones allow, no user choices. */
export function standardCapabilities(body: Pick<StandardBody, 'has' | 'model'>): ModelCapabilities {
  const morphs = Object.fromEntries(MORPH_SLOTS.map(slot => [slot, { index: body.has(slot) ? 0 : -1 }]));
  const map = Object.fromEntries(STANDARD_BONES.flatMap(bone => body.model.bone(bone) ? [[bone, { index: 0, name: bone }]] : []));
  return deriveModelCapabilities({ morphs, bones: { map, duplicates: [] } });
}

/** The sleep body's lookup (src/stage/sleep-body.ts SleepBodyStageArgs.profile): the standard skeleton's bones; no fitted capsules. */
export function standardSleepBones(body: Pick<StandardBody, 'standardBone'>): { bone(slot: StandardBone): Bone | undefined; profile: null } {
  return { bone: slot => body.standardBone(slot), profile: null };
}

/**
 * Her mouth in `head`'s own space at rest: the middle of what her "aa" moves, each vertex by how far it moves (the model profile measures an
 * MMD model's mouth the same way). null when she has no "aa" or it moves nothing.
 */
export function standardMouth(body: Pick<StandardBody, 'model'>, head: Bone | null): Vector3 | null {
  const binds = body.model.expression('a');
  if (!head || !binds.length) return null;
  head.updateWorldMatrix(true, false);
  const toHead = head.matrixWorld.clone().invert(), sum = new Vector3(), point = new Vector3();
  let weight = 0;
  for (const bind of binds) {
    const mesh = bind.mesh, target = mesh.geometry.morphAttributes.position?.[bind.index], position = mesh.geometry.getAttribute('position');
    if (!target || !position || target.count !== position.count) continue;
    mesh.updateWorldMatrix(true, false); mesh.skeleton?.update();
    const relative = mesh.geometry.morphTargetsRelative === true;
    for (let v = 0; v < position.count; v++) {
      const dx = target.getX(v) - (relative ? 0 : position.getX(v)), dy = target.getY(v) - (relative ? 0 : position.getY(v)), dz = target.getZ(v) - (relative ? 0 : position.getZ(v));
      const moved = Math.hypot(dx, dy, dz) * Math.abs(bind.weight);
      if (!(moved > MOVES)) continue;
      mesh.getVertexPosition(v, point);
      point.applyMatrix4(mesh.matrixWorld).applyMatrix4(toHead);
      sum.addScaledVector(point, moved); weight += moved;
    }
  }
  if (!(weight > 0)) return null;
  const mouth = sum.divideScalar(weight);
  return [mouth.x, mouth.y, mouth.z].every(Number.isFinite) ? mouth : null;
}
