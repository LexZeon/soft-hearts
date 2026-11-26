/**
 * Unbound U1: her silhouette as one capsule per skinned bone, for "is the cursor on her" (shared/unbound/hit-test.ts).
 *
 * Measured once per model, at rest: every vertex belongs to the bone that weighs most on it; a bone's capsule runs from the bone
 * to whichever of its child bones (or its vertices' centre) fits its own vertices best, and its radius covers 90% of them. So it
 * follows any model's shape (hair, skirt, sleeves) without a list of bone names (I-024: adapts to uploaded models), and moves
 * with the skinned pose every frame at the cost of two matrix products per capsule.
 *
 * Step 5 (拉她, docs/claude/2026-11-18-unbound-step5-plan.md「5a」): moved here from src/unbound/silhouette.ts so the companion window's
 * stage and Unbound find the part under the mouse with the same capsules (rayCapsuleHit: the companion's camera may orbit, so it tests a
 * ray in 3D instead of projecting to the window).
 */
import { Bone, Matrix4, Vector3, type Camera, type Object3D, type SkinnedMesh } from 'three';

/** One capsule on the window (CSS px); the same shape as shared/unbound/hit-test.ts Capsule2D (kept here: the foundation imports no part). */
export interface Capsule2D { ax: number; ay: number; bx: number; by: number; r: number; bone?: number }

export interface BoneCapsule {
  /** Index of the mesh's skeleton bone it belongs to (the part names and the pull read it). */
  bone: number;
  /** Ends in the placing bone's own rest space (so its matrixWorld places them). */
  a: Vector3;
  b: Vector3;
  /** Radius in model units. */
  r: number;
  /**
   * The bone that places it when that is not the skeleton's bone itself (I-164 interaction: a VRM's own bone, posed by present(), while
   * `bone` names the standard skeleton's; src/unbound/model/standard-capsules.ts). Absent: mesh.skeleton.bones[bone] (every MMD model).
   */
  place?: Object3D;
}

const MIN_VERTICES = 6;
const COVER = 0.9;

function distanceToSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, length2 = abx * abx + aby * aby + abz * abz;
  const t = length2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / length2)) : 0;
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby), p.z - (a.z + t * abz));
}
const quantile = (values: number[], q: number) => { values.sort((x, y) => x - y); return values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0; };

/** The capsules of a model at rest. Bones with fewer than six vertices of their own have none. */
export function measureBoneCapsules(mesh: SkinnedMesh): BoneCapsule[] {
  const geometry = mesh.geometry, position = geometry.getAttribute('position'), skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight');
  if (!position || !skinIndex || !skinWeight) return [];
  const { bones, boneInverses } = mesh.skeleton;
  const bind = mesh.bindMatrix ?? new Matrix4();
  // Rest (bind) world position of every bone.
  const rest = boneInverses.map(inverse => new Vector3().setFromMatrixPosition(new Matrix4().copy(inverse).invert()));
  const groups = bones.map(() => [] as Vector3[]);
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    let best = -1, weight = 0;
    for (let k = 0; k < skinIndex.itemSize; k++) {
      const w = skinWeight.getComponent(i, k);
      if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); }
    }
    if (best < 0 || best >= bones.length) continue;
    v.fromBufferAttribute(position, i).applyMatrix4(bind);
    groups[best].push(v.clone());
  }
  const out: BoneCapsule[] = [];
  bones.forEach((bone, index) => {
    const points = groups[index];
    if (points.length < MIN_VERTICES) return;
    const start = rest[index];
    const centre = points.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / points.length);
    const ends = [centre, ...bone.children.filter((child): child is Bone => child instanceof Bone).map(child => rest[bones.indexOf(child)]).filter(Boolean)];
    let bestEnd = centre, bestRadius = Infinity;
    for (const end of ends) {
      const radius = quantile(points.map(p => distanceToSegment(p, start, end)), COVER);
      if (radius < bestRadius) { bestRadius = radius; bestEnd = end; }
    }
    const toBone = boneInverses[index];
    out.push({ bone: index, a: start.clone().applyMatrix4(toBone), b: bestEnd.clone().applyMatrix4(toBone), r: Math.max(0.05, bestRadius) });
  });
  return out;
}

/**
 * I-164 interaction (docs/claude/2026-11-20-vrm-interaction.md): a mesh whose body is drawn by other meshes (a VRM's standard skeleton has
 * no vertices of its own) says how its capsules are measured. Everything that measures her capsules asks measureBodyCapsules, so an MMD
 * mesh (nothing registered) measures itself exactly as before.
 */
const capsuleSources = new WeakMap<SkinnedMesh, () => BoneCapsule[]>();
export function setBodyCapsuleSource(mesh: SkinnedMesh, measure: (() => BoneCapsule[]) | null): void {
  if (measure) capsuleSources.set(mesh, measure); else capsuleSources.delete(mesh);
}
/** Her capsules: the registered source's, else the mesh's own (measureBoneCapsules). */
export function measureBodyCapsules(mesh: SkinnedMesh): BoneCapsule[] {
  const source = capsuleSources.get(mesh);
  return source ? source() : measureBoneCapsules(mesh);
}

/**
 * Capsules fitted in each bone's own rest space from several skinned meshes (a VRM's body, face, hair, clothes): each vertex goes to the
 * bone that weighs most on it, across all of them, and a bone's capsule is fitted as measureBoneCapsules fits one (from the bone to the
 * child joint or the vertices' centre that fits best, radius covering 90%). Each vertex is taken at its bind place in its bone's space, so
 * the pose the meshes show now does not matter, and the bone's own matrixWorld places the ends in any pose. The radius is in `frame`'s
 * units (the bone's local units times the bone's scale in that frame).
 */
export function measureOwnBoneCapsules(meshes: readonly SkinnedMesh[], frame: Object3D): { bone: Bone; a: Vector3; b: Vector3; r: number }[] {
  const points = new Map<Bone, number[]>();
  const v = new Vector3();
  for (const mesh of meshes) {
    const geometry = mesh.geometry, position = geometry.getAttribute('position'), skinIndex = geometry.getAttribute('skinIndex'), skinWeight = geometry.getAttribute('skinWeight');
    const skeleton = mesh.skeleton;
    if (!position || !skinIndex || !skinWeight || !skeleton) continue;
    const bind = mesh.bindMatrix ?? new Matrix4();
    const toLocal = skeleton.bones.map((_, k) => skeleton.boneInverses[k] ? new Matrix4().multiplyMatrices(skeleton.boneInverses[k], bind) : null);
    for (let i = 0; i < position.count; i++) {
      let best = -1, weight = 0;
      for (let k = 0; k < skinIndex.itemSize; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w > weight) { weight = w; best = skinIndex.getComponent(i, k); }
      }
      const bone = skeleton.bones[best], matrix = toLocal[best];
      if (!bone || !matrix) continue;
      v.fromBufferAttribute(position, i).applyMatrix4(matrix);
      let list = points.get(bone);
      if (!list) points.set(bone, list = []);
      list.push(v.x, v.y, v.z);
    }
  }
  frame.updateWorldMatrix(true, true);
  const toFrame = new Matrix4().copy(frame.matrixWorld).invert(), relative = new Matrix4(), origin = new Vector3();
  const out: { bone: Bone; a: Vector3; b: Vector3; r: number }[] = [];
  for (const [bone, flat] of points) {
    const count = flat.length / 3;
    if (count < MIN_VERTICES) continue;
    const list: Vector3[] = [];
    for (let i = 0; i < flat.length; i += 3) list.push(new Vector3(flat[i], flat[i + 1], flat[i + 2]));
    const centre = list.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / count);
    // A child joint sits at its own local position in this bone's space (joints do not slide).
    const ends = [centre, ...bone.children.filter((child): child is Bone => child instanceof Bone).map(child => child.position.clone())];
    let bestEnd = centre, bestRadius = Infinity;
    for (const end of ends) {
      const radius = quantile(list.map(p => distanceToSegment(p, origin, end)), COVER);
      if (radius < bestRadius) { bestRadius = radius; bestEnd = end; }
    }
    const scale = relative.multiplyMatrices(toFrame, bone.matrixWorld).getMaxScaleOnAxis();
    out.push({ bone, a: origin.clone(), b: bestEnd.clone(), r: Math.max(0.05, bestRadius * scale) });
  }
  return out;
}

/** The capsules' ends in world space now (pairs: a0, b0, a1, b1, ...). The skeleton's world matrices must be current. */
export function capsuleEnds(mesh: SkinnedMesh, capsules: readonly BoneCapsule[], out: Vector3[] = []): Vector3[] {
  const bones = mesh.skeleton.bones;
  capsules.forEach((capsule, i) => {
    const world = (capsule.place ?? bones[capsule.bone]).matrixWorld;
    (out[2 * i] ??= new Vector3()).copy(capsule.a).applyMatrix4(world);
    (out[2 * i + 1] ??= new Vector3()).copy(capsule.b).applyMatrix4(world);
  });
  out.length = capsules.length * 2;
  return out;
}

/** Signed distance (model units) from a world point to the nearest capsule (≤ 0 inside). */
export function capsuleDistance3D(point: Vector3, capsules: readonly BoneCapsule[], ends: readonly Vector3[]): number {
  let best = Infinity;
  capsules.forEach((capsule, i) => { best = Math.min(best, distanceToSegment(point, ends[2 * i], ends[2 * i + 1]) - capsule.r); });
  return best;
}

/**
 * The capsules on the window, in CSS pixels. `pixelsPerUnit(aheadUnits)` turns a radius at a distance ahead of the eye into
 * pixels (shared/unbound/world.ts pixelsPerMeter, in scene units). The camera looks straight down -z (no rotation).
 */
export function projectCapsules(capsules: readonly BoneCapsule[], ends: readonly Vector3[], camera: Camera, width: number, height: number,
  pixelsPerUnit: (aheadUnits: number) => number, out: Capsule2D[] = []): Capsule2D[] {
  const p = new Vector3(), eyeZ = camera.position.z;
  let n = 0;
  capsules.forEach((capsule, i) => {
    const a = ends[2 * i], b = ends[2 * i + 1];
    const aheadA = eyeZ - a.z, aheadB = eyeZ - b.z;
    if (!(aheadA > 1e-3) || !(aheadB > 1e-3)) return;
    p.copy(a).project(camera); const ax = (p.x + 1) / 2 * width, ay = (1 - p.y) / 2 * height;
    p.copy(b).project(camera); const bx = (p.x + 1) / 2 * width, by = (1 - p.y) / 2 * height;
    const r = capsule.r * pixelsPerUnit((aheadA + aheadB) / 2);
    const c = (out[n] ??= { ax: 0, ay: 0, bx: 0, by: 0, r: 0 }); c.ax = ax; c.ay = ay; c.bx = bx; c.by = by; c.r = r; c.bone = capsule.bone; n++;
  });
  out.length = n;
  return out;
}

export interface CapsuleRayHit {
  /** Index into the capsules, and its bone. */
  index: number;
  bone: number;
  /** Distance from the ray to the capsule's axis minus its radius (≤ 0: the ray goes through it). */
  distance: number;
  /** Where the ray enters her there (world), and how far along the ray. */
  point: Vector3;
  t: number;
}

/** Closest points of the ray o + t·d (t ≥ 0, d unit) and the segment a–b: [t, s, distance]. */
export function raySegment(o: Vector3, d: Vector3, a: Vector3, b: Vector3): [number, number, number] {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, wx = o.x - a.x, wy = o.y - a.y, wz = o.z - a.z;
  const B = d.x * ux + d.y * uy + d.z * uz, C = ux * ux + uy * uy + uz * uz, D = d.x * wx + d.y * wy + d.z * wz, E = ux * wx + uy * wy + uz * wz;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const denom = C - B * B;
  let s = C > 1e-12 ? (denom > 1e-9 * C ? clamp01((E - B * D) / denom) : clamp01(E / C)) : 0;
  let t = Math.max(0, s * B - D);
  if (C > 1e-12) s = clamp01((t * B + E) / C);
  t = Math.max(0, s * B - D);
  const px = o.x + t * d.x - (a.x + s * ux), py = o.y + t * d.y - (a.y + s * uy), pz = o.z + t * d.z - (a.z + s * uz);
  return [t, s, Math.hypot(px, py, pz)];
}

/**
 * Step 5a: the piece of her a ray from the eye meets first. Among the capsules the ray goes through, the one it enters nearest the
 * eye; with none, the nearest one within `margin` (model units) of the ray; else null. The world matrices must be current (`ends`
 * from capsuleEnds).
 */
export function rayCapsuleHit(origin: Vector3, direction: Vector3, capsules: readonly BoneCapsule[], ends: readonly Vector3[], margin = 0): CapsuleRayHit | null {
  let best: CapsuleRayHit | null = null, near: CapsuleRayHit | null = null;
  for (let i = 0; i < capsules.length; i++) {
    const a = ends[2 * i], b = ends[2 * i + 1], capsule = capsules[i];
    if (!a || !b) continue;
    const [t, , axis] = raySegment(origin, direction, a, b), distance = axis - capsule.r;
    if (distance <= 0) {
      const entry = Math.max(0, t - Math.sqrt(Math.max(0, capsule.r * capsule.r - axis * axis)));
      if (!best || entry < best.t) best = { index: i, bone: capsule.bone, distance, t: entry, point: new Vector3() };
    } else if (distance <= margin && (!near || distance < near.distance)) near = { index: i, bone: capsule.bone, distance, t, point: new Vector3() };
  }
  const hit = best ?? near;
  if (hit) hit.point.copy(direction).multiplyScalar(hit.t).add(origin);
  return hit;
}
