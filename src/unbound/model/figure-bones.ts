/**
 * I-152 step 2 (docs/claude/2026-11-19-vrm-motion-step2.md): how Unbound's body finds a bone on an MMD model. First by the exact
 * names each part of the engine always listed (so every model that worked before gets exactly the same bones: Gene, Akiko, any
 * model with MMD names); only when none of them is there, by the standard part those names stand for, through the app's alias
 * table (shared/foundation/universal-skeleton.ts: 'LeftArm', 'left_upperarm', '左上臂' are all armLeft; fingers by their joint),
 * so a PMX with renamed bones still gets her breath, gaze, lean and feet. A model on the standard skeleton (a VRM, standard-body.ts)
 * has the exact names and never needs the second step.
 */
import type { Bone, SkinnedMesh } from 'three';
import { fingerSlotOfName, standardBoneOfName } from '../../../shared/foundation/universal-skeleton';

/** The standard part a name stands for (a standard bone or a finger joint), or null. */
const partOf = (name: string): string | null => standardBoneOfName(name) ?? fingerSlotOfName(name);

/** For tests: every lookup that was answered by the alias table rather than by an exact name ("name→bone"). */
export const aliasHits: string[] = [];

/** The first bone with one of `names`; else the first bone that is the same standard part as one of them; else null. */
export function figureBone(mesh: Pick<SkinnedMesh, 'skeleton'>, names: readonly string[]): Bone | null {
  const bones = mesh.skeleton.bones;
  for (const name of names) { const bone = bones.find(b => b.name === name); if (bone) return bone; }
  for (const name of names) {
    const part = partOf(name);
    if (!part) continue;
    const bone = bones.find(b => partOf(b.name) === part);
    if (bone) { if (aliasHits.length < 256) aliasHits.push(`${name}→${bone.name}`); return bone; }
  }
  return null;
}
