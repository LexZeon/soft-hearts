/**
 * Skeleton step 3: Gene-derived skeletons whose hands rest differently (no other model, nothing of the user's, no PMX bytes
 * written). Each edit changes bone rest positions in place, on a copy of Gene's parsed bones or the stage's rest bones.
 */
import { qaxisAngle, qrotate, vnormalize, vsub } from '../../shared/motion-retarget';
import type { Vec3 } from '../../shared/universal-skeleton';

export interface EditableBone { name: string; parent: number; position: Vec3 }

const find = (bones: readonly EditableBone[], name: string) => {
  const at = bones.findIndex(bone => bone.name === name);
  if (at < 0) throw Error(`no bone ${name}`);
  return at;
};
/** Every bone under `top` (not `top` itself). */
export function descendants(bones: readonly EditableBone[], top: number): number[] {
  const out: number[] = [];
  bones.forEach((_, index) => {
    for (let at = bones[index].parent, steps = 0; at >= 0 && steps <= bones.length; at = bones[at].parent, steps++) if (at === top) { out.push(index); break; }
  });
  return out;
}
/** Turns the bones under `top` (and, with `self`, top) about `axis` through `pivot`. */
export function turnUnder(bones: EditableBone[], top: number, pivot: Readonly<Vec3>, axis: Readonly<Vec3>, degrees: number, self = false): void {
  const q = qaxisAngle(axis, degrees * Math.PI / 180);
  for (const index of self ? [top, ...descendants(bones, top)] : descendants(bones, top)) {
    const offset = qrotate(q, vsub(bones[index].position, pivot));
    bones[index].position = [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]];
  }
}
const SIDE = { Left: '左', Right: '右' } as const;

/** The whole hand (everything under each 手首) rolled about its forearm axis (手首 − ひじ): the palm faces another way at rest. */
export function rollHands(bones: EditableBone[], degrees = 90): void {
  for (const [side, mark] of Object.entries(SIDE)) {
    const wrist = find(bones, `${mark}手首`), elbow = find(bones, `${mark}ひじ`);
    const axis = vnormalize(vsub(bones[wrist].position, bones[elbow].position));
    turnUnder(bones, wrist, bones[wrist].position, axis, side === 'Left' ? degrees : -degrees);
  }
}

/** Arms raised to a T (everything under each 腕 turned about the forward axis), then the hands rolled: a T-pose model, palms forward. */
export function tPoseRolled(bones: EditableBone[], degrees = 90): void {
  for (const [side, mark] of Object.entries(SIDE)) {
    const arm = find(bones, `${mark}腕`), wrist = find(bones, `${mark}手首`);
    const d = vsub(bones[wrist].position, bones[arm].position), lift = Math.atan2(-d[1], Math.abs(d[0])) * 180 / Math.PI;
    turnUnder(bones, arm, bones[arm].position, [0, 0, 1], side === 'Left' ? lift : -lift);
  }
  rollHands(bones, degrees);
}

/**
 * Each finger's rest axes changed: index and little spread apart, middle curled, ring bent back, the thumb turned about the
 * hand, and a bent second knuckle on every long finger (the "finger joints' local axes differ" case: MMD has no rest rotation,
 * so a finger's axes are its joint positions).
 */
export function reshapeFingers(bones: EditableBone[]): void {
  for (const [side, mark] of Object.entries(SIDE)) {
    const sign = side === 'Left' ? 1 : -1;
    const wrist = find(bones, `${mark}手首`), index1 = find(bones, `${mark}人指１`), little1 = find(bones, `${mark}小指１`), middle1 = find(bones, `${mark}中指１`);
    const across = vnormalize(vsub(bones[index1].position, bones[little1].position));
    const forward = vnormalize(vsub(bones[middle1].position, bones[wrist].position));
    const normal: Vec3 = vnormalize([forward[1] * across[2] - forward[2] * across[1], forward[2] * across[0] - forward[0] * across[2], forward[0] * across[1] - forward[1] * across[0]]);
    const chain = (name: string, axis: Vec3, degrees: number) => { const top = find(bones, `${mark}${name}`); turnUnder(bones, top, bones[top].position, axis, degrees * sign); };
    chain('人指１', normal, 25); chain('小指１', normal, -25); chain('中指１', across, 30); chain('薬指１', across, -20); chain('親指０', forward, 40);
    for (const finger of ['人指', '中指', '薬指', '小指']) chain(`${finger}２`, across, 20);
  }
}

/** Renames bones (same order, same positions) so the profile no longer reads them: a model that lacks those finger joints. */
export function hideBones(bones: EditableBone[], test: (name: string) => boolean): void {
  bones.forEach((bone, index) => { if (test(bone.name)) bone.name = `acc_${index}`; });
}
