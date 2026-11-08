import type { BehaviorMotionPlan } from './behavior-motion';
import type { BodyPoseBinding, BodyPoseProfile } from './personalize-body';

/** A transient presentation derived solely from an already-issued host cue. */
export interface BodyPosePresentation {
  cueId: string; expiresAt: number; strength: number; modelUrl: string; binding: BodyPoseBinding;
}

export function selectBodyPosePresentation(profile:BodyPoseProfile|null|undefined,binding:BodyPoseBinding|null,
  modelSha:string|null,modelUrl:string|null,plan:BehaviorMotionPlan|null|undefined,now:number):BodyPosePresentation|null {
  if(!profile?.enabled||!binding||!modelUrl||!modelSha||!Number.isFinite(now)||profile.targetModelSha!==modelSha
    ||binding.targetModelSha!==modelSha||binding.id!==profile.bindingId||binding.sourceSha!==profile.sourceSha||binding.qualifiedStrength!==profile.strength
    ||!Number.isFinite(profile.strength)||profile.strength<0||profile.strength>(profile.tweak||profile.right||profile.head||profile.torso?1:0.7)
    ||(profile.strength===0&&!binding.properties.some(p=>p.weight!==undefined&&p.weight>0)))return null;
  const cue=profile.semantic.startsWith('cue.')?plan?.reaction:plan?.state;
  if(!cue||cue.semantic!==profile.semantic||!Number.isFinite(cue.at)||!Number.isFinite(cue.expiresAt)
    ||cue.at>now||cue.expiresAt<=now||!Number.isFinite(cue.strength)||cue.strength<=0)return null;
  return {cueId:cue.id,expiresAt:cue.expiresAt,strength:profile.strength,modelUrl,binding:structuredClone(binding)};
}
