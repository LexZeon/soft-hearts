import type { BodyPoseBinding } from './personalize-body';

/** Source binding is limited to the exact Gene CPU observation; actual UI and distribution qualification remain separate. */
const CANDIDATES: readonly BodyPoseBinding[] = [{
  id:'body.gene-left-arm-soft-bend',label:'左臂轻屈（固定姿势）',
  targetModelSha:'0ef63a75a7699f58399ae655357f91542fc5209355aac925a589aac42669df37',
  sourceSha:'88c9c426eb725ab6cb3448df2d614df4a020f5078d6814c92b41d6dd79b90ad7',
  mask:'gene-left-shoulder-arm-elbow-quaternion-v1',
  qualifiedStrength:0.5,
  properties:[
    {boneIndex:17,boneName:'左肩',quaternion:[0,0,-0.01745240643728351,0.9998476951563913]},
    {boneIndex:18,boneName:'左腕',quaternion:[0,0,-0.21643961393810288,0.9762960071199334]},
    {boneIndex:21,boneName:'左ひじ',quaternion:[-0.25881904510252074,0,0,0.9659258262890683]},
  ],
}];

// Root R42 adopts this exact fixed preset; prior CPU evidence remains limited.
const ADMITTED_SOURCE_SHAS:ReadonlySet<string>=new Set(['88c9c426eb725ab6cb3448df2d614df4a020f5078d6814c92b41d6dd79b90ad7']);
/** Only an explicitly admitted source/model pair may resolve. */
export function bodyPoseChoices(modelSha:string):readonly BodyPoseBinding[]{return CANDIDATES.filter(value=>value.targetModelSha===modelSha&&ADMITTED_SOURCE_SHAS.has(value.sourceSha));}
export function bodyPoseBinding(id:string,modelSha:string):BodyPoseBinding|null{return bodyPoseChoices(modelSha).find(value=>value.id===id)??null;}
