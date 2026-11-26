/**
 * I-147 全身果冻, layer 3: where the soft regions are on a model (docs/claude/2026-11-17-whole-body-jelly.md). Pure: reads the
 * mesh's bind-pose vertices, its skinning weights and its bones; changes nothing and paints nothing.
 *
 * A region is a soft blob: its mask bones (the model's own skinning weights say how much a vertex belongs to it), a centre and a
 * size in the bind pose, and the deform bone that carries it (its driver: the spring follows that point's acceleration).
 * Centres and sizes come from the skeleton's proportions (scale-free) and, for the front or back surface, from the vertices.
 * Three's MMD coordinates: +y up, she faces +z, her left is +x (shared/foundation/universal-skeleton.ts).
 *
 * Per vertex at most SLOTS regions (the strongest by mask × closeness within the largest allowed radius), as two vec3 attributes:
 * region indices and mask weights. The vertex shader applies the falloff from the centre with the live radius and exponent.
 */
import { Matrix4, Vector3, type BufferAttribute, type InterleavedBufferAttribute, type SkinnedMesh } from 'three';
import { standardBoneOfName, type StandardBone } from '../../../shared/foundation/universal-skeleton';
import { JELLY_BOUNDS, type SoftRegion } from '../../../shared/stage/jelly-tuning';

export const MAX_SOFT_REGIONS = 12;
export const SLOTS = 3;

export interface SoftRegionInfo {
  kind: SoftRegion;
  /** -1 her right, 0 middle, 1 her left. */
  side: -1 | 0 | 1;
  /** Bones whose skinning weight puts a vertex in this region. */
  bones: number[];
  /** The deform bone that carries the region (its point's acceleration drives the spring). */
  driver: number;
  /** Bind-pose centre (mesh space) and size (model units). */
  center: [number, number, number];
  radius: number;
}

export interface SoftRegionMap {
  regions: SoftRegionInfo[];
  /** Per vertex, SLOTS region indices (as floats, for the shader) and SLOTS mask weights (0..1). */
  slotRegion: Float32Array;
  slotWeight: Float32Array;
  /** Vertices with any weight, per region (for tests and the lab's numbers). */
  counts: number[];
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;
const D_BONE = /^(左|右)足D$/u, TWIST = /^(左|右)腕捩\d?$/u;

/** Bind-pose position of every bone in mesh space (bindMatrixInverse · inverse(boneInverse) · origin). */
export function bindBonePositions(mesh: SkinnedMesh): Vector3[] {
  const toMesh = new Matrix4().copy(mesh.bindMatrixInverse), m = new Matrix4();
  return mesh.skeleton.bones.map((_, index) => {
    const inverse = mesh.skeleton.boneInverses[index];
    if (!inverse) return new Vector3(Number.NaN, Number.NaN, Number.NaN);
    m.copy(inverse).invert().premultiply(toMesh);
    return new Vector3().setFromMatrixPosition(m);
  });
}

function roles(mesh: SkinnedMesh): Map<StandardBone, number> {
  const out = new Map<StandardBone, number>();
  mesh.skeleton.bones.forEach((bone, index) => { const role = standardBoneOfName(bone.name); if (role && !out.has(role)) out.set(role, index); });
  return out;
}

/** Extra mask bones by name: MMD's D bones (足D carry the thigh skin on many models) and arm twist bones. */
function namedBones(mesh: SkinnedMesh, pattern: RegExp, side: '左' | '右'): number[] {
  const out: number[] = [];
  mesh.skeleton.bones.forEach((bone, index) => { const name = bone.name.normalize('NFKC'); if (pattern.test(name) && name.startsWith(side)) out.push(index); });
  return out;
}

/**
 * The model's soft regions. `hasChestBones`: the model's own physics already moves the chest (then no chest region here).
 * A region whose bones or landmarks are missing is simply left out.
 */
export function findSoftRegions(mesh: SkinnedMesh, hasChestBones: boolean): SoftRegionInfo[] {
  const role = roles(mesh), at = bindBonePositions(mesh);
  const pos = (key: StandardBone) => { const index = role.get(key); return index === undefined || !Number.isFinite(at[index].x) ? null : at[index]; };
  const upper = pos('upperBody'), upper2 = pos('upperBody2') ?? upper, neck = pos('neck'), lower = pos('lowerBody') ?? upper;
  const armL = pos('armLeft'), armR = pos('armRight');
  if (!upper || !upper2 || !neck || !lower || !armL || !armR) return [];
  const width = Math.abs(armL.x - armR.x), torso = Math.max(1e-6, neck.y - lower.y);
  if (!(width > 0)) return [];
  const geometry = mesh.geometry, position = geometry.getAttribute('position') as Attribute | undefined;
  const skinIndex = geometry.getAttribute('skinIndex') as Attribute | undefined, skinWeight = geometry.getAttribute('skinWeight') as Attribute | undefined;
  if (!position || !skinIndex || !skinWeight) return [];
  const index = (key: StandardBone) => role.get(key);
  const out: SoftRegionInfo[] = [];
  const add = (kind: SoftRegion, side: -1 | 0 | 1, bones: (number | undefined)[], driver: number | undefined, center: Vector3 | null, radius: number) => {
    const list = [...new Set(bones.filter((value): value is number => value !== undefined))];
    if (!list.length || driver === undefined || !center || !(radius > 0) || out.length >= MAX_SOFT_REGIONS) return;
    out.push({ kind, side, bones: list, driver, center: [center.x, center.y, center.z], radius });
  };
  /** The front (+1) or back (-1) surface z of the vertices that belong to `bones`, near (x, y). */
  const surface = (bones: (number | undefined)[], x: number, y: number, dir: 1 | -1, band: number): number | null => {
    const set = new Set(bones.filter((value): value is number => value !== undefined));
    let best: number | null = null;
    for (let v = 0; v < position.count; v++) {
      if (Math.abs(position.getY(v) - y) > band || Math.abs(position.getX(v) - x) > band) continue;
      let w = 0;
      for (let k = 0; k < 4; k++) if (set.has(skinIndex.getComponent(v, k))) w += skinWeight.getComponent(v, k);
      if (w < 0.3) continue;
      const z = position.getZ(v) * dir;
      if (best === null || z > best) best = z;
    }
    return best === null ? null : best * dir;
  };
  const inside = (x: number, y: number, z: number | null, dir: 1 | -1, depth: number) => z === null ? null : new Vector3(x, y, z - dir * depth);

  // Belly: the front of the trunk around the lower spine bone.
  { const r = 0.32 * width, y = upper.y + 0.05 * torso, bones = [index('upperBody'), index('lowerBody'), index('waist')];
    add('belly', 0, bones, index('upperBody'), inside(0, y, surface(bones, 0, y, 1, 0.12 * torso), 1, 0.25 * r), r); }
  // Hips: the back below the lower body bone.
  { const r = 0.3 * width, y = lower.y - 0.12 * torso, bones = [index('lowerBody'), index('legLeft'), index('legRight'), ...namedBones(mesh, D_BONE, '左'), ...namedBones(mesh, D_BONE, '右')];
    add('hips', 0, bones, index('lowerBody'), inside(0, y, surface(bones, 0, y, -1, 0.12 * torso), -1, 0.2 * r), r); }
  for (const [side, mark] of [[1, '左'], [-1, '右']] as const) {
    const leg = pos(side > 0 ? 'legLeft' : 'legRight'), knee = pos(side > 0 ? 'kneeLeft' : 'kneeRight');
    if (leg && knee) add('thighs', side, [index(side > 0 ? 'legLeft' : 'legRight'), ...namedBones(mesh, D_BONE, mark)], index(side > 0 ? 'legLeft' : 'legRight'),
      leg.clone().lerp(knee, 0.4), 0.45 * leg.distanceTo(knee));
    const arm = side > 0 ? armL : armR, elbow = pos(side > 0 ? 'elbowLeft' : 'elbowRight');
    if (elbow) add('upperArms', side, [index(side > 0 ? 'armLeft' : 'armRight'), ...namedBones(mesh, TWIST, mark)], index(side > 0 ? 'armLeft' : 'armRight'),
      arm.clone().lerp(elbow, 0.55), 0.42 * arm.distanceTo(elbow));
  }
  // Cheeks: below and a little outside each eye, at the face's front surface.
  const eyeL = pos('eyeLeft'), eyeR = pos('eyeRight'), head = index('head');
  if (eyeL && eyeR && head !== undefined) {
    const d = eyeL.distanceTo(eyeR);
    for (const [side, eye] of [[1, eyeL], [-1, eyeR]] as const) {
      const r = 0.5 * d, x = eye.x + side * 0.15 * d, y = eye.y - 0.55 * d;
      const z = surface([head], x, y, 1, 0.3 * d);
      add('cheeks', side, [head], head, inside(x, y, z, 1, 0.25 * r), r);
    }
  }
  // Chest, only when the model's own physics does not move it.
  if (!hasChestBones) {
    const bones = [index('upperBody2') ?? index('upperBody')], y = upper2.y + 0.35 * (neck.y - upper2.y), r = 0.26 * width;
    for (const side of [1, -1] as const) {
      const x = side * 0.25 * width;
      add('chest', side, bones, bones[0], inside(x, y, surface(bones, x, y, 1, 0.15 * torso), 1, 0.3 * r), r);
    }
  }
  return out;
}

/** The falloff the vertex shader applies (the same formula, for tests and the CPU side): 0 outside the radius. */
export function softFalloff(distance: number, radius: number, falloff: number): number {
  if (!(radius > 0)) return 0;
  const u = Math.min(1, Math.max(0, 1 - distance / radius));
  return u <= 0 ? 0 : Math.pow(u, falloff);
}

/** Per-vertex slots: the regions a vertex belongs to by its skinning weights, strongest first, within the largest allowed radius. */
export function softRegionMap(mesh: SkinnedMesh, regions: readonly SoftRegionInfo[]): SoftRegionMap {
  const geometry = mesh.geometry, position = geometry.getAttribute('position') as Attribute;
  const skinIndex = geometry.getAttribute('skinIndex') as Attribute, skinWeight = geometry.getAttribute('skinWeight') as Attribute;
  const count = position.count, slotRegion = new Float32Array(count * SLOTS), slotWeight = new Float32Array(count * SLOTS);
  const counts = regions.map(() => 0);
  const byBone = new Map<number, number[]>();
  regions.forEach((region, r) => { for (const bone of region.bones) { const list = byBone.get(bone) ?? []; list.push(r); byBone.set(bone, list); } });
  const reach = JELLY_BOUNDS.radius[1];
  const mask = new Float64Array(regions.length), picked: { r: number; w: number; rank: number }[] = [];
  for (let v = 0; v < count; v++) {
    mask.fill(0);
    for (let k = 0; k < 4; k++) {
      const weight = skinWeight.getComponent(v, k);
      if (weight <= 0) continue;
      for (const r of byBone.get(skinIndex.getComponent(v, k)) ?? []) mask[r] += weight;
    }
    picked.length = 0;
    const x = position.getX(v), y = position.getY(v), z = position.getZ(v);
    for (let r = 0; r < regions.length; r++) {
      if (mask[r] <= 1e-4) continue;
      const c = regions[r].center, distance = Math.hypot(x - c[0], y - c[1], z - c[2]);
      const closeness = 1 - distance / (regions[r].radius * reach);
      if (closeness > 0) picked.push({ r, w: Math.min(1, mask[r]), rank: Math.min(1, mask[r]) * closeness });
    }
    picked.sort((a, b) => b.rank - a.rank);
    for (let s = 0; s < Math.min(SLOTS, picked.length); s++) {
      slotRegion[v * SLOTS + s] = picked[s].r; slotWeight[v * SLOTS + s] = picked[s].w; counts[picked[s].r]++;
    }
  }
  return { regions: [...regions], slotRegion, slotWeight, counts };
}
