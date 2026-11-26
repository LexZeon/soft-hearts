// The synthetic body the jelly tests share (moved out of tests/jelly-soft.test.ts for tests/jelly-touch.test.ts, I-136 step 5d).
import { Bone, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';

/** A synthetic body: bones at human-like proportions (model units, she faces +z, her left is +x), a box of vertices per part. */
export function syntheticBody() {
  const spec: [string, string | null, [number, number, number]][] = [
    ['センター', null, [0, 9, 0]], ['下半身', 'センター', [0, 9.5, 0]], ['上半身', 'センター', [0, 10, 0]], ['上半身2', '上半身', [0, 12, 0]],
    ['首', '上半身2', [0, 14.5, 0]], ['頭', '首', [0, 15.5, 0]], ['左目', '頭', [0.6, 16.5, 0.8]], ['右目', '頭', [-0.6, 16.5, 0.8]],
    ['左肩', '上半身2', [0.5, 14, 0]], ['左腕', '左肩', [1.8, 13.8, 0]], ['左ひじ', '左腕', [3.8, 12.2, 0]], ['左手首', '左ひじ', [5.4, 10.8, 0]],
    ['右肩', '上半身2', [-0.5, 14, 0]], ['右腕', '右肩', [-1.8, 13.8, 0]], ['右ひじ', '右腕', [-3.8, 12.2, 0]], ['右手首', '右ひじ', [-5.4, 10.8, 0]],
    ['左足', '下半身', [0.9, 9, 0]], ['左ひざ', '左足', [0.9, 5, 0]], ['左足首', '左ひざ', [0.9, 1, 0]],
    ['右足', '下半身', [-0.9, 9, 0]], ['右ひざ', '右足', [-0.9, 5, 0]], ['右足首', '右ひざ', [-0.9, 1, 0]],
  ];
  const bones: Bone[] = [], byName = new Map<string, Bone>();
  for (const [name, parent, at] of spec) {
    const bone = new Bone(); bone.name = name;
    const p = parent ? byName.get(parent)! : null;
    const world = new Vector3(...at), parentWorld = p ? new Vector3(...spec.find(row => row[0] === parent)![2]) : new Vector3();
    bone.position.copy(world.sub(parentWorld));
    p?.add(bone); bones.push(bone); byName.set(name, bone);
  }
  // Boxes: [bone, centre, half size]. The trunk is split: belly box on 上半身, chest box on 上半身2, pelvis on 下半身.
  const boxes: [string, [number, number, number], [number, number, number]][] = [
    ['下半身', [0, 9.2, 0], [1.6, 0.8, 1.1]], ['上半身', [0, 10.8, 0], [1.4, 0.9, 1]], ['上半身2', [0, 13, 0], [1.6, 1.2, 1.1]],
    ['頭', [0, 16.4, 0], [1.2, 1.3, 1.2]], ['左腕', [2.8, 13, 0], [0.4, 0.4, 0.4]], ['右腕', [-2.8, 13, 0], [0.4, 0.4, 0.4]],
    ['左ひじ', [4.6, 11.5, 0], [0.35, 0.35, 0.35]], ['右ひじ', [-4.6, 11.5, 0], [0.35, 0.35, 0.35]], ['左手首', [5.8, 10.4, 0], [0.3, 0.3, 0.3]],
    ['左足', [0.9, 7, 0], [0.6, 2, 0.6]], ['右足', [-0.9, 7, 0], [0.6, 2, 0.6]], ['左ひざ', [0.9, 3, 0], [0.45, 2, 0.45]], ['左足首', [0.9, 0.5, 0.3], [0.4, 0.4, 0.7]],
  ];
  const positions: number[] = [], indices: number[] = [], weights: number[] = [], owner: string[] = [];
  const n = 6;
  for (const [name, c, h] of boxes) {
    const bone = bones.indexOf(byName.get(name)!);
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) {
      if (i % n && j % n && k % n) continue; // the surface only
      positions.push(c[0] + h[0] * (2 * i / n - 1), c[1] + h[1] * (2 * j / n - 1), c[2] + h[2] * (2 * k / n - 1));
      indices.push(bone, 0, 0, 0); weights.push(1, 0, 0, 0); owner.push(name);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const mesh = new SkinnedMesh(geometry, [new MeshBasicMaterial(), new MeshBasicMaterial()]);
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return { mesh, bones, byName, owner };
}

