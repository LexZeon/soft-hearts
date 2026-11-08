/**
 * I-038 part A (docs/claude/2026-11-06-i038-universal-part-a.md): the loaded model as a target of things authored on Gene.
 *
 * Every library motion, the mood's body motions, the personal pose and brow/eye picks were authored on the bundled Gene, whose
 * rest pose is the universal skeleton's standard pose (shared/universal-skeleton.ts). So "authored on Gene" means "written in the
 * standard vocabulary": a Gene bone or morph name stands for a standard part. This module turns that vocabulary into the loaded
 * model's own names, and back, from the stage's retarget plan (src/stage/motion-retarget.ts, shared/motion-retarget.ts):
 *
 * - The reviewed Gene: everything is the identity, so its paths stay exactly as they were (callers keep their old code for it).
 * - Any other model with a plan: standard bones and finger joints by slot, morphs by profile slot (with the plan's amplitude
 *   ratio), any other name only if the model has it as is (what retargeting does with a track it cannot route).
 * - No plan (no profile, or planning failed): null. Callers then skip, as the motion library does.
 *
 * A static rotation authored on Gene goes through the very same retargeting as a motion (`convertRotations`): a one-frame motion
 * of those rotations, retargeted, read back. Nothing here touches the model or any file.
 */
import { LINEAR_INTERPOLATION, morphSlotRoute, retargetVmd, type RetargetPlan, type VmdLike } from '../../shared/motion-retarget';
import type { FingerSlot, MorphSlot, StandardBone } from '../../shared/universal-skeleton';

export type Quat4 = [number, number, number, number];
export interface UniversalTarget {
  /** True on the reviewed Gene: every map is the identity. */
  readonly reviewed: boolean;
  /** This model's bone for a Gene (standard) bone name; null when it has none. */
  targetBone(geneName: string): string | null;
  /** The Gene (standard) name of one of this model's bones; null when it stands for none. */
  standardBone(targetName: string): string | null;
  /** This model's morph for a Gene morph name, and the factor that keeps its visible amount; null when it has none. */
  targetMorph(geneName: string): { name: string; ratio: number } | null;
  /** The Gene morph name one of this model's morphs stands for; null when none. */
  standardMorph(targetName: string): string | null;
  /**
   * Local rotations authored on Gene (by Gene bone name, Three.js space, relative to an identity rest) as this model's local
   * rotations, through the same retargeting a motion gets. `lost` lists the Gene names that land on no bone of this model.
   */
  convertRotations(rows: readonly { name: string; quaternion: Readonly<Quat4> }[]): { rows: { name: string; quaternion: Quat4 }[]; lost: string[] };
}

const identity: UniversalTarget = Object.freeze({
  reviewed: true,
  targetBone: (name: string) => name, standardBone: (name: string) => name,
  targetMorph: (name: string) => ({ name, ratio: 1 }), standardMorph: (name: string) => name,
  convertRotations: (rows: readonly { name: string; quaternion: Readonly<Quat4> }[]) =>
    ({ rows: rows.map(row => ({ name: row.name, quaternion: [...row.quaternion] as Quat4 })), lost: [] }),
});

/** The loaded model as a target (see the file comment); null when nothing authored on Gene can be mapped onto it. */
export function universalTarget(retarget: { readonly reviewed: boolean; readonly plan: RetargetPlan | null } | null | undefined): UniversalTarget | null {
  if (!retarget) return null;
  if (retarget.reviewed) return identity;
  const plan = retarget.plan;
  if (!plan) return null;
  const { source, target } = plan;
  const toTarget = new Map<string, string>(), toStandard = new Map<string, string>();
  const pair = (from: string | undefined, to: string | undefined) => {
    if (from === undefined || to === undefined || toTarget.has(from) || toStandard.has(to)) return;
    toTarget.set(from, to); toStandard.set(to, from);
  };
  for (const slot of Object.keys(source.slots) as StandardBone[])
    pair(source.bones[source.slots[slot]!]?.name, target.slots[slot] === undefined ? undefined : target.bones[target.slots[slot]!]?.name);
  for (const slot of Object.keys(source.fingers ?? {}) as FingerSlot[]) {
    const from = source.fingers![slot], to = target.fingers?.[slot];
    pair(from === undefined ? undefined : source.bones[from]?.name, to === undefined ? undefined : target.bones[to]?.name);
  }
  // A name the model has as is (and no slot took): retargeting keeps such a track under its own name.
  const targetNames = new Set(target.bones.map(bone => bone.name)), sourceNames = new Set(source.bones.map(bone => bone.name));
  const unique = (names: readonly string[], name: string) => names.filter(value => value === name).length === 1;
  const targetBoneNames = target.bones.map(bone => bone.name);
  const morphTo = new Map<string, { name: string; ratio: number }>(), morphFrom = new Map<string, string>();
  for (const slot of Object.keys(source.morphSlots) as MorphSlot[]) {
    const from = source.morphSlots[slot]!.name, route = morphSlotRoute(source, target, slot);
    if (!route || morphTo.has(from) || morphFrom.has(route.target)) continue;
    morphTo.set(from, { name: route.target, ratio: route.ratio }); morphFrom.set(route.target, from);
  }
  const targetMorphs = new Set(target.morphNames);
  const sourceMorphSlots = new Set(Object.values(source.morphSlots).map(entry => entry!.name));
  return Object.freeze({
    reviewed: false,
    targetBone: (name: string) => toTarget.get(name)
      ?? (targetNames.has(name) && !toStandard.has(name) && unique(targetBoneNames, name) ? name : null),
    standardBone: (name: string) => toStandard.get(name)
      ?? (sourceNames.has(name) && !toTarget.has(name) && targetNames.has(name) ? name : null),
    targetMorph: (name: string) => morphTo.get(name) ?? (!sourceMorphSlots.has(name) && targetMorphs.has(name) && !morphFrom.has(name) ? { name, ratio: 1 } : null),
    standardMorph: (name: string) => morphFrom.get(name) ?? (targetMorphs.has(name) && !sourceMorphSlots.has(name) ? name : null),
    convertRotations: (rows: readonly { name: string; quaternion: Readonly<Quat4> }[]) => convert(plan, rows),
  });
}

/** One key per bone at frame 0 (and the same at frame 1, so no track reads as a lone default key), retargeted, read back. */
function convert(plan: RetargetPlan, rows: readonly { name: string; quaternion: Readonly<Quat4> }[]): { rows: { name: string; quaternion: Quat4 }[]; lost: string[] } {
  const motions = rows.flatMap(row => [0, 1].map(frameNum => ({ boneName: row.name, frameNum, position: [0, 0, 0], rotation: [...row.quaternion],
    interpolation: LINEAR_INTERPOLATION })));
  const vmd: VmdLike = { metadata: { motionCount: motions.length, morphCount: 0 }, motions, morphs: [] };
  const { vmd: out, report } = retargetVmd(vmd, plan);
  const byName = new Map<string, Quat4>();
  for (const frame of out.motions) {
    if (frame.frameNum !== 0) continue;
    const q = frame.rotation, length = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!(length > 0)) continue;
    const value: Quat4 = [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
    // Rotations that came out as the identity (a bone the motion does not turn) are not part of the pose.
    if (Math.abs(value[3]) > 1 - 1e-12) continue;
    byName.set(frame.boneName, value);
  }
  const dropped = new Set([...(report.lost ?? []), ...report.droppedBones]);
  const lost = rows.filter(row => Math.abs(row.quaternion[3]) <= 1 - 1e-12 && dropped.has(row.name)).map(row => row.name);
  return { rows: [...byName].map(([name, quaternion]) => ({ name, quaternion })), lost };
}

/**
 * I-038 (1): the mood's body motions. The reviewed Gene as before (the host's content check); any other model that is a target
 * here. Each motion is then judged on this model by the fit check before it starts (MmdStage.loadBodyMotionClip, R29d), so a
 * model a motion does not suit simply does not get that one.
 */
export function bodyMotionTarget(reviewed: boolean, retarget: Parameters<typeof universalTarget>[0]): { supported: boolean; standardName?: (name: string) => string | null } {
  if (reviewed) return { supported: true };
  const target = universalTarget(retarget);
  return target && !target.reviewed ? { supported: true, standardName: target.standardBone } : { supported: false };
}
