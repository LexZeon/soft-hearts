/**
 * I-164 VRM gaps (docs/claude/2026-11-20-vrm-gaps.md): the companion's painted blush and tear marks on a VRM's face, by the same look rules
 * as an MMD model's (src/stage/procedural-blush.ts, src/mood/procedural-tears.ts: the same probe, the same anchors, the same shader patch,
 * the same calibration). What differs is only where the face is: three's glTF loader makes each primitive its own mesh, so a VRoid face is
 * a face skin mesh, an iris mesh, a white mesh … side by side under the face node, with MToon materials (and an outline copy of some).
 *
 *  - The probe: the face node's primitives laid into ONE mesh (their own vertices, skin weights and bones; one group per primitive, the
 *    outline copies left out), so the companion's probe finds the face skin AND the eye surface it measures the eye spacing from, exactly
 *    as on a converted model. Material names lose the exporter's " (Instance)" so the eye surface is recognised by its usual name. Never drawn.
 *  - The paint: on the primitive that holds both cheeks, with that primitive's material indices (window-blush.ts paintOn). The patched clone
 *    keeps the original's place in the draw order (src/foundation/draw-order.ts keepDrawPlace, inside ProceduralBlush / ProceduralTears).
 *  - The pinch's cheeks when no face is found: from her own eyes (the eye surface, else the eye bones) and her mouth (where her "aa" moves).
 * Measured on her rest pose, put back for each measurement by the painter (window-blush.ts atRest), in the VRM head bone's own space.
 */
import { BufferAttribute, BufferGeometry, Skeleton, SkinnedMesh, Vector3, type Bone, type Material, type Matrix4 } from 'three';
import { cheekAnchorsFrom, eyeMaterialPriority, type BlushAnchors } from '../../stage';
import { WindowBlush, type BlushSurface } from '../window-mode/window-blush';
import { standardMouth } from '../model/standard-face';
import type { StandardBody } from '../model/standard-body';

/** An exporter's suffix on a VRM material name (UniVRM: "Face_00_SKIN (Instance)"). */
export const cleanMaterialName = (name: string): string => name.replace(/\s*\(Instance\)\s*$/iu, '').trim();
const isOutline = (material: Material) => (material as { isOutline?: boolean }).isOutline === true;

interface Owner { mesh: SkinnedMesh; material: number }

/** The painter for a model on the standard skeleton (the VRM's face), or null when it has no head or no face mesh to measure. */
export function standardBlush(body: StandardBody): WindowBlush | null {
  const head = body.head;
  if (!head) return null;
  const primitives = facePrimitives(body);
  const made = primitives.length ? probeOf(primitives) : null;
  if (!made) return null;
  const root = body.model.object, { probe, owners } = made, first = primitives[0];
  const prepare = () => {
    root.updateWorldMatrix(true, true);
    probe.matrix.copy(first.matrixWorld); probe.updateMatrixWorld(true); probe.skeleton.update();
  };
  prepare();
  const mouth = standardMouth(body, head);
  const surface: BlushSurface = {
    bones: body.model.bones, meshes: body.model.meshes, prepare,
    paintOn: anchors => paintTarget(anchors, owners),
    fallbackCheeks: fallbackCheeks(probe, head, body.eyes, mouth),
  };
  return new WindowBlush(probe, head, body.eyes, mouth, surface);
}

/** The probe's anchors → the one primitive both cheeks are on and its own material indices; null when they are on two meshes. */
export function paintTarget(anchors: BlushAnchors, owners: readonly Owner[]): { mesh: SkinnedMesh; anchors: BlushAnchors } | null {
  const mapped = anchors.materialIndices.map(index => owners[index]).filter((owner): owner is Owner => !!owner);
  if (!mapped.length || mapped.length !== anchors.materialIndices.length || new Set(mapped.map(owner => owner.mesh)).size !== 1) return null;
  return { mesh: mapped[0].mesh, anchors: { ...anchors, materialIndices: [...new Set(mapped.map(owner => owner.material))] } };
}

/** The face node's primitives: the mesh her "aa" moves and its siblings on the same skeleton (VRoid: Face's skin, mouth, eyes, brows …). */
function facePrimitives(body: StandardBody): SkinnedMesh[] {
  const mouth = body.model.expression('a')[0]?.mesh ?? body.model.meshes.find(mesh => materialsOf(mesh).some(material => /face|skin/i.test(cleanMaterialName(material.name))));
  if (!mouth) return [];
  const bones = mouth.skeleton?.bones ?? [];
  return body.model.meshes.filter(mesh => mesh.parent === mouth.parent && sameBones(mesh.skeleton?.bones ?? [], bones));
}
const materialsOf = (mesh: SkinnedMesh): Material[] => Array.isArray(mesh.material) ? mesh.material : [mesh.material];
const sameBones = (a: readonly Bone[], b: readonly Bone[]) => a.length === b.length && a.every((bone, i) => bone === b[i]);

/** One mesh made of `primitives` (their rest vertices and skin, one group per surface material, outline copies out). */
export function probeOf(primitives: readonly SkinnedMesh[]): { probe: SkinnedMesh; owners: Owner[] } | null {
  const positions: number[] = [], normals: number[] = [], joints: number[] = [], weights: number[] = [], indices: number[] = [];
  const materials: Material[] = [], owners: Owner[] = [], geometry = new BufferGeometry();
  let base = 0;
  for (const mesh of primitives) {
    const source = mesh.geometry, position = source.getAttribute('position'), normal = source.getAttribute('normal');
    const skinIndex = source.getAttribute('skinIndex'), skinWeight = source.getAttribute('skinWeight');
    if (!position || !normal || !skinIndex || !skinWeight) continue;
    for (let v = 0; v < position.count; v++) {
      positions.push(position.getX(v), position.getY(v), position.getZ(v)); normals.push(normal.getX(v), normal.getY(v), normal.getZ(v));
      joints.push(skinIndex.getX(v), skinIndex.getY(v), skinIndex.getZ(v), skinIndex.getW(v)); weights.push(skinWeight.getX(v), skinWeight.getY(v), skinWeight.getZ(v), skinWeight.getW(v));
    }
    const own = materialsOf(mesh), index = source.index, count = index?.count ?? position.count;
    const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const group of groups) {
      const material = own[group.materialIndex ?? 0];
      if (!material || isOutline(material)) continue;
      const start = indices.length;
      for (let item = group.start; item < Math.min(count, group.start + group.count); item++) indices.push(base + (index ? index.getX(item) : item));
      // A view of the material under its plain name (the probe reads names, opacity and shaders; it is never drawn).
      const view = Object.create(material) as Material;
      Object.defineProperty(view, 'name', { value: cleanMaterialName(material.name) });
      geometry.addGroup(start, indices.length - start, materials.length);
      materials.push(view); owners.push({ mesh, material: group.materialIndex ?? 0 });
    }
    base += position.count;
  }
  if (!materials.length) return null;
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(joints), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(weights), 4));
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  const first = primitives[0], probe = new SkinnedMesh(geometry, materials);
  probe.name = 'vrm-face-probe';
  probe.matrixAutoUpdate = false;
  probe.bindMode = first.bindMode;
  probe.bind(new Skeleton([...first.skeleton.bones], first.skeleton.boneInverses.map(matrix => matrix.clone())), first.bindMatrix.clone());
  return { probe, owners };
}

/** Pinch-only cheeks from her eyes (the eye surface's two halves, else the eye bones) and her mouth, in the head's space. */
function fallbackCheeks(probe: SkinnedMesh, head: Bone, eyeBones: readonly Bone[], mouth: Vector3 | null): BlushAnchors | null {
  if (!mouth) return null;
  head.updateWorldMatrix(true, false);
  const toHead = head.matrixWorld.clone().invert();
  const eyes = surfaceEyes(probe, toHead) ?? eyeBones.map(bone => bone.getWorldPosition(new Vector3()).applyMatrix4(toHead));
  return eyes.length === 2 ? cheekAnchorsFrom(eyes, mouth) : null;
}

/** The two halves of the best-named eye surface (iris before white), as head-space centres; null without one. */
function surfaceEyes(probe: SkinnedMesh, toHead: Matrix4): Vector3[] | null {
  const materials = materialsOf(probe), index = probe.geometry.index;
  let best = -1, priority = Infinity;
  materials.forEach((material, k) => { const p = eyeMaterialPriority(material.name); if (p >= 0 && p < priority) { priority = p; best = k; } });
  if (best < 0 || !index) return null;
  const halves = [new Vector3(), new Vector3()], counts = [0, 0], point = new Vector3(), seen = new Set<number>();
  for (const group of probe.geometry.groups) {
    if (group.materialIndex !== best) continue;
    for (let item = group.start; item < group.start + group.count; item++) {
      const vertex = index.getX(item);
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      probe.getVertexPosition(vertex, point).applyMatrix4(probe.matrixWorld).applyMatrix4(toHead);
      const side = point.x < 0 ? 0 : 1;
      halves[side].add(point); counts[side]++;
    }
  }
  if (!counts[0] || !counts[1]) return null;
  return halves.map((sum, side) => sum.divideScalar(counts[side]));
}
