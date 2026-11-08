/**
 * Skeleton step 4: Gene-derived bodies with other shoulder widths and arm lengths (no other model, nothing of the user's, no
 * PMX bytes written). Each edit moves bone rest positions in place, on a copy of Gene's parsed bones or the stage's rest
 * bones (tests/helpers/gene-stage-harness.ts restEdit). The hands keep Gene's size and shape: only where they hang changes.
 */
import type { Vec3 } from '../../shared/universal-skeleton';
import { descendants, type EditableBone } from './hand-variants';

const SIDES = [['左', 1], ['右', -1]] as const;
const find = (bones: readonly EditableBone[], name: string) => {
  const at = bones.findIndex(bone => bone.name === name);
  if (at < 0) throw Error(`no bone ${name}`);
  return at;
};
const shift = (bones: EditableBone[], indices: readonly number[], by: Readonly<Vec3>) => {
  for (const index of indices) { const p = bones[index].position; bones[index].position = [p[0] + by[0], p[1] + by[1], p[2] + by[2]]; }
};

/** Shoulders `factor` times as wide: each arm (腕 and everything under it) moved sideways; the torso, shoulder bone and hands unchanged. */
export function widenShoulders(bones: EditableBone[], factor: number): void {
  for (const [mark] of SIDES) {
    const arm = find(bones, `${mark}腕`);
    shift(bones, [arm, ...descendants(bones, arm)], [(factor - 1) * bones[arm].position[0], 0, 0]);
  }
}

/**
 * Arms `factor` times as long: the upper arm and forearm (腕 → ひじ → 手首, their twist bones included) scaled about the
 * shoulder joint (腕); the hand (手首 and everything under it) only moved along with the wrist, so it keeps Gene's size.
 */
export function scaleArms(bones: EditableBone[], factor: number): void {
  for (const [mark] of SIDES) {
    const arm = find(bones, `${mark}腕`), wrist = find(bones, `${mark}手首`), pivot = [...bones[arm].position] as Vec3;
    const hand = new Set([wrist, ...descendants(bones, wrist)]);
    const before = [...bones[wrist].position] as Vec3;
    for (const index of descendants(bones, arm)) {
      if (hand.has(index)) continue;
      const p = bones[index].position;
      bones[index].position = [pivot[0] + (p[0] - pivot[0]) * factor, pivot[1] + (p[1] - pivot[1]) * factor, pivot[2] + (p[2] - pivot[2]) * factor];
    }
    const to: Vec3 = [pivot[0] + (before[0] - pivot[0]) * factor, pivot[1] + (before[1] - pivot[1]) * factor, pivot[2] + (before[2] - pivot[2]) * factor];
    shift(bones, [...hand], [to[0] - before[0], to[1] - before[1], to[2] - before[2]]);
  }
}

/** The bodies step 4 is measured on (factors chosen so each one misses or overlaps visibly before the fit). */
export const BODY_VARIANTS = {
  'wide shoulders (×1.25)': (bones: EditableBone[]) => widenShoulders(bones, 1.25),
  'narrow shoulders (×0.8)': (bones: EditableBone[]) => widenShoulders(bones, 0.8),
  'long arms (×1.3)': (bones: EditableBone[]) => scaleArms(bones, 1.3),
  'short arms (×0.8)': (bones: EditableBone[]) => scaleArms(bones, 0.8),
} as const;

/**
 * Skeleton step 5: the same edit, with the skin following the bones (the bodies above move bones only, so on the real stage the
 * mesh stays Gene's and the fit check's skin-fitted body no longer sits on the arms: a T pose then reads as the arm inside the
 * chest). Each bone's change is read off three probe points hung under it (the helpers move a bone's whole subtree, probes
 * included), as an affine map; every vertex (and every absolute morph target) is moved by its skin weights over those maps.
 * Memory only: the parsed mesh of one test stage; nothing on disk changes.
 */
type MeshLike = { geometry: { attributes: Record<string, { count: number; itemSize: number; array: ArrayLike<number> & { [index: number]: number } }>;
  morphAttributes?: { position?: { array: ArrayLike<number> & { [index: number]: number } }[] }; morphTargetsRelative?: boolean } };
export function meshFollows(edit: (bones: EditableBone[]) => void): (bones: EditableBone[], mesh?: MeshLike) => void {
  return (bones, mesh) => {
    const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const before = bones.map(bone => [...bone.position] as Vec3);
    const probes: EditableBone[] = bones.flatMap((bone, index) => axes.map((axis, k) => ({ name: `__probe_${index}_${k}`, parent: index,
      position: [bone.position[0] + axis[0], bone.position[1] + axis[1], bone.position[2] + axis[2]] as Vec3 })));
    const all = [...bones, ...probes];
    edit(all); // the real bones are the same objects in `all`; the probes never reach the caller's list
    if (!mesh) return;
    // Bone i: v ↦ p'ᵢ + Aᵢ (v − pᵢ), Aᵢ's columns being where its probes went relative to it.
    const maps = bones.map((bone, index) => ({ from: before[index], to: bone.position, columns: axes.map((_, k) => {
      const probe = probes[index * 3 + k].position;
      return [probe[0] - bone.position[0], probe[1] - bone.position[1], probe[2] - bone.position[2]] as Vec3;
    }) }));
    const apply = (map: typeof maps[number], v: Vec3): Vec3 => {
      const d = [v[0] - map.from[0], v[1] - map.from[1], v[2] - map.from[2]], c = map.columns;
      return [map.to[0] + c[0][0] * d[0] + c[1][0] * d[1] + c[2][0] * d[2], map.to[1] + c[0][1] * d[0] + c[1][1] * d[1] + c[2][1] * d[2],
        map.to[2] + c[0][2] * d[0] + c[1][2] * d[1] + c[2][2] * d[2]];
    };
    const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
    const targets = [position.array, ...(mesh.geometry.morphTargetsRelative === false ? (mesh.geometry.morphAttributes?.position ?? []).map(target => target.array) : [])];
    for (let vertex = 0; vertex < position.count; vertex++) {
      let total = 0;
      const weights: [number, number][] = [];
      for (let k = 0; k < skinIndex.itemSize; k++) { const w = skinWeight.array[vertex * skinWeight.itemSize + k]; if (w > 0) { weights.push([skinIndex.array[vertex * skinIndex.itemSize + k], w]); total += w; } }
      if (!(total > 0) || weights.every(([bone]) => { const m = maps[bone]; return !m || (m.from.every((x, k) => x === m.to[k]) && m.columns.every((col, a) => col.every((x, k) => x === axes[a][k]))); })) continue;
      for (const array of targets) {
        const v: Vec3 = [array[vertex * 3], array[vertex * 3 + 1], array[vertex * 3 + 2]], out: Vec3 = [0, 0, 0];
        for (const [bone, w] of weights) { const moved = maps[bone] ? apply(maps[bone], v) : v; for (let k = 0; k < 3; k++) out[k] += moved[k] * w / total; }
        array[vertex * 3] = out[0]; array[vertex * 3 + 1] = out[1]; array[vertex * 3 + 2] = out[2];
      }
    }
  };
}
