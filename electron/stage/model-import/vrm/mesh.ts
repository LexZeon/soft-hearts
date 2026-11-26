/**
 * Geometry: every mesh node's triangle primitives merged into one vertex list in Three space, skinned to the PMX skeleton.
 *
 * Each vertex is put where the glTF rest pose puts it (Σ w · jointWorld · inverseBind · v), then through the A pose of the
 * bones it is weighted to (linear blend, the same way a skinned mesh would deform), so vertices, normals and morph offsets
 * all agree with the posed bones. Primitives that share their vertex accessors share vertices. KHR_texture_transform on the
 * base colour texture is baked into the UVs. Weights: joints mapped to PMX bones (duplicates summed), shared along the arm
 * with the twist bones, weights under 0.5 % dropped, at most four kept, normalised.
 */
import { Matrix3, Matrix4, Vector3 } from 'three';
import { readAccessor, type Glb, type GltfPrimitive } from './glb';
import type { SceneNodes } from './scene';
import type { Skeleton } from './skeleton';

export const MIN_WEIGHT = 0.005;

export interface MergedPrimitive { material: number; mesh: number; primitive: number; indices: Uint32Array }
export interface MergedMesh {
  positions: Float32Array; normals: Float32Array; uvs: Float32Array; skinIndices: Int32Array; skinWeights: Float32Array;
  primitives: MergedPrimitive[];
  /** Source morph target name → sparse offsets (merged across meshes; a name in two meshes is one morph). */
  morphs: Map<string, { indices: number[]; offsets: number[] }>;
  /** Mesh index → its morph target names by index. */
  targetNames: string[][];
  skipped: string[];
  uvTransforms: string[];
}

interface UvTransform { offset: [number, number]; scale: [number, number]; rotation: number }
function uvTransformOf(glb: Glb, material: number | undefined): UvTransform | null {
  const info = material !== undefined ? glb.json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture : undefined;
  const t = info?.extensions?.KHR_texture_transform as { offset?: number[]; scale?: number[]; rotation?: number } | undefined;
  if (!t) return null;
  return { offset: [t.offset?.[0] ?? 0, t.offset?.[1] ?? 0], scale: [t.scale?.[0] ?? 1, t.scale?.[1] ?? 1], rotation: t.rotation ?? 0 };
}
/** KHR_texture_transform: uv' = T · R · S · uv, R with columns (cos, sin) and (−sin, cos) as in the extension's reference shader. */
function applyUv(t: UvTransform, u: number, v: number): [number, number] {
  const su = u * t.scale[0], sv = v * t.scale[1], c = Math.cos(t.rotation), s = Math.sin(t.rotation);
  return [t.offset[0] + c * su - s * sv, t.offset[1] + s * su + c * sv];
}

export function targetNamesOf(glb: Glb): string[][] {
  return (glb.json.meshes ?? []).map(mesh => {
    const count = Math.max(0, ...mesh.primitives.map(p => p.targets?.length ?? 0));
    const names = mesh.extras?.targetNames ?? mesh.primitives.find(p => p.extras?.targetNames)?.extras?.targetNames ?? [];
    return Array.from({ length: count }, (_, k) => typeof names[k] === 'string' && names[k] ? names[k] : `morph${k}`);
  });
}

export function mergeMeshes(glb: Glb, scene: SceneNodes, skeleton: Skeleton): MergedMesh {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], skinIndices: number[] = [], skinWeights: number[] = [];
  const primitives: MergedPrimitive[] = [], skipped: string[] = [], uvTransforms: string[] = [];
  const morphs = new Map<string, { indices: number[]; offsets: number[] }>();
  const targetNames = targetNamesOf(glb);
  const blocks = new Map<string, number>(); // vertex accessors (per node) → first vertex index
  const nodes = glb.json.nodes ?? [];
  nodes.forEach((node, nodeIndex) => {
    if (node.mesh === undefined) return;
    const mesh = glb.json.meshes?.[node.mesh];
    if (!mesh) return;
    const skin = node.skin !== undefined ? glb.json.skins?.[node.skin] : undefined;
    const inverseBind = skin?.inverseBindMatrices !== undefined ? readAccessor(glb, skin.inverseBindMatrices).data : null;
    // Per joint: posed bind matrix (A pose of its PMX bone · model world · inverse bind), its PMX bone.
    const joints = (skin?.joints ?? []).map((joint, k) => {
      const bone = skeleton.nodeBone[joint];
      const bind = inverseBind ? new Matrix4().fromArray(Array.from(inverseBind.subarray(k * 16, k * 16 + 16))) : new Matrix4();
      return { bone, matrix: skeleton.pose[bone].clone().multiply(scene.model[joint]).multiply(bind) };
    });
    const rigidBone = skeleton.nodeBone[nodeIndex];
    const rigid = skeleton.pose[rigidBone].clone().multiply(scene.model[nodeIndex]);
    mesh.primitives.forEach((primitive, primitiveIndex) => {
      const label = `${mesh.name ?? `mesh${node.mesh}`}#${primitiveIndex}`;
      if ((primitive.mode ?? 4) !== 4 || primitive.attributes.POSITION === undefined) { skipped.push(`${label}（不是三角形）`); return; }
      const key = `${nodeIndex}|${blockKey(primitive)}`;
      let base = blocks.get(key);
      if (base === undefined) {
        base = positions.length / 3;
        blocks.set(key, base);
        appendBlock(primitive, label);
      }
      const indices = primitive.indices !== undefined ? readAccessor(glb, primitive.indices).data : Float64Array.from({ length: readAccessor(glb, primitive.attributes.POSITION).count }, (_, k) => k);
      const out = new Uint32Array(indices.length - (indices.length % 3));
      for (let k = 0; k < out.length; k++) out[k] = base + indices[k];
      primitives.push({ material: primitive.material ?? -1, mesh: node.mesh!, primitive: primitiveIndex, indices: out });
    });

    function appendBlock(primitive: GltfPrimitive, label: string) {
      const position = readAccessor(glb, primitive.attributes.POSITION), count = position.count, start = positions.length / 3;
      const normal = primitive.attributes.NORMAL !== undefined ? readAccessor(glb, primitive.attributes.NORMAL).data : null;
      const uv = primitive.attributes.TEXCOORD_0 !== undefined ? readAccessor(glb, primitive.attributes.TEXCOORD_0).data : null;
      const transform = uvTransformOf(glb, primitive.material);
      if (transform) uvTransforms.push(`${label}: offset ${transform.offset.join(',')} scale ${transform.scale.join(',')} rotation ${transform.rotation}`);
      const sets = [0, 1].filter(set => primitive.attributes[`JOINTS_${set}`] !== undefined && primitive.attributes[`WEIGHTS_${set}`] !== undefined)
        .map(set => ({ joints: readAccessor(glb, primitive.attributes[`JOINTS_${set}`]).data, weights: readAccessor(glb, primitive.attributes[`WEIGHTS_${set}`]).data }));
      const skinned = !!skin && sets.length > 0;
      const matrices: Matrix4[] = [];
      const p = new Vector3(), n = new Vector3(), linear = new Matrix3();
      for (let v = 0; v < count; v++) {
        const weights = new Map<number, number>();
        const blend = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        let total = 0;
        if (skinned) for (const set of sets) for (let k = 0; k < 4; k++) {
          const weight = set.weights[v * 4 + k], joint = joints[set.joints[v * 4 + k]];
          if (!(weight > 0) || !joint) continue;
          total += weight;
          addScaled(blend, joint.matrix, weight);
          weights.set(joint.bone, (weights.get(joint.bone) ?? 0) + weight);
        }
        if (!(total > 1e-6)) { blend.copy(rigid); weights.clear(); weights.set(rigidBone, 1); }
        else if (Math.abs(total - 1) > 1e-6) scaleMatrix(blend, 1 / total);
        matrices.push(blend);
        p.set(position.data[v * 3], position.data[v * 3 + 1], position.data[v * 3 + 2]).applyMatrix4(blend);
        positions.push(p.x, p.y, p.z);
        linear.setFromMatrix4(blend);
        if (normal) { n.set(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]).applyMatrix3(linear).normalize(); normals.push(n.x, n.y, n.z); }
        else normals.push(0, 0, 0);
        const [u, w] = uv ? transform ? applyUv(transform, uv[v * 2], uv[v * 2 + 1]) : [uv[v * 2], uv[v * 2 + 1]] : [0, 0];
        uvs.push(u, w);
        const kept = splitTwists(weights, p, skeleton);
        for (let k = 0; k < 4; k++) { skinIndices.push(kept[k]?.[0] ?? -1); skinWeights.push(kept[k]?.[1] ?? 0); }
      }
      if (!normal) computeNormals(primitive, start, count);
      const names = targetNames[node.mesh!] ?? [];
      (primitive.targets ?? []).forEach((target, k) => {
        if (target.POSITION === undefined) return;
        const deltas = readAccessor(glb, target.POSITION).data, name = names[k] ?? `morph${k}`;
        const entry = morphs.get(name) ?? { indices: [], offsets: [] };
        const d = new Vector3();
        for (let v = 0; v < count; v++) {
          d.set(deltas[v * 3], deltas[v * 3 + 1], deltas[v * 3 + 2]);
          if (d.lengthSq() < 1e-16) continue;
          d.applyMatrix3(linear.setFromMatrix4(matrices[v]));
          entry.indices.push(start + v); entry.offsets.push(d.x, d.y, d.z);
        }
        morphs.set(name, entry);
      });
    }
    function computeNormals(primitive: GltfPrimitive, start: number, count: number) {
      const indices = primitive.indices !== undefined ? readAccessor(glb, primitive.indices).data : Float64Array.from({ length: count }, (_, k) => k);
      const a = new Vector3(), b = new Vector3(), c = new Vector3();
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const [i, j, k] = [indices[t], indices[t + 1], indices[t + 2]].map(x => start + x);
        a.fromArray(positions, i * 3); b.fromArray(positions, j * 3); c.fromArray(positions, k * 3);
        const face = b.sub(a).cross(c.sub(a));
        for (const x of [i, j, k]) for (let q = 0; q < 3; q++) normals[x * 3 + q] += face.getComponent(q);
      }
      for (let v = start; v < start + count; v++) { a.fromArray(normals, v * 3).normalize(); normals[v * 3] = a.x; normals[v * 3 + 1] = a.y; normals[v * 3 + 2] = a.z; }
    }
  });
  return {
    positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs),
    skinIndices: Int32Array.from(skinIndices), skinWeights: Float32Array.from(skinWeights), primitives, morphs, targetNames, skipped, uvTransforms,
  };
}

function blockKey(primitive: GltfPrimitive): string {
  const attributes = Object.keys(primitive.attributes).sort().map(name => `${name}=${primitive.attributes[name]}`).join(',');
  const targets = (primitive.targets ?? []).map(target => target.POSITION ?? -1).join(',');
  return `${attributes}|${targets}`;
}
function addScaled(into: Matrix4, matrix: Matrix4, weight: number) { for (let k = 0; k < 16; k++) into.elements[k] += matrix.elements[k] * weight; }
function scaleMatrix(matrix: Matrix4, factor: number) { for (let k = 0; k < 16; k++) matrix.elements[k] *= factor; }
const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** Shares a twist base bone's weight with its twist bone along the segment, then keeps the four largest weights over MIN_WEIGHT. */
export function splitTwists(weights: Map<number, number>, at: Vector3, skeleton: Pick<Skeleton, 'twists'>): [number, number][] {
  for (const split of skeleton.twists) {
    const weight = weights.get(split.base);
    if (!weight) continue;
    const dx = split.end[0] - split.start[0], dy = split.end[1] - split.start[1], dz = split.end[2] - split.start[2];
    const length = dx * dx + dy * dy + dz * dz;
    if (!(length > 0)) continue;
    const t = ((at.x - split.start[0]) * dx + (at.y - split.start[1]) * dy + (at.z - split.start[2]) * dz) / length;
    const share = weight * smooth(t);
    if (share <= 0) continue;
    weights.set(split.base, weight - share);
    weights.set(split.twist, (weights.get(split.twist) ?? 0) + share);
  }
  let kept = [...weights].filter(([, weight]) => weight >= MIN_WEIGHT).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
  if (!kept.length) kept = [[...weights].sort((a, b) => b[1] - a[1])[0] ?? [0, 1]];
  const sum = kept.reduce((total, [, weight]) => total + weight, 0);
  return kept.map(([bone, weight]) => [bone, weight / sum]);
}
