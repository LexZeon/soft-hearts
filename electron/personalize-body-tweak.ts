import { BODY_TWEAK_BASE, BODY_TWEAK_BINDING, BODY_TWEAK_TARGET, validateBodyPoseOffsets, validateBodyPoseProfile, validateBodyRightSelection, validateBodyHeadSelection,
  type BodyPoseBinding, type BodyPoseOffsets, type BodyPoseProfile, type BodyRightSelection, type BodyHeadSelection, type BodyTorsoSelection } from '../shared/personalize-body';

/** Host-only derivation from the closed Gene base; the renderer supplies no bone or quaternion data. */
export function applyBodyPoseTweak(base: BodyPoseBinding | null, offsets: BodyPoseOffsets, strength: number): BodyPoseBinding {
  const values=validateBodyPoseOffsets(offsets);
  if (!base || base.id!==BODY_TWEAK_BINDING || base.targetModelSha!==BODY_TWEAK_TARGET || base.sourceSha!==BODY_TWEAK_BASE
    || base.mask!=='gene-left-shoulder-arm-elbow-quaternion-v1' || typeof strength!=='number' || !Number.isFinite(strength) || strength<0 || strength>1) {
    throw Error('当前模型或姿势调整不在允许范围内。');
  }
  const rotation=(degrees:number,axis:'x'|'z'):readonly [number,number,number,number]=>{
    const half=degrees*Math.PI/360, s=Math.sin(half), c=Math.cos(half);
    return axis==='x'?[s,0,0,c]:[0,0,s,c];
  };
  return {...base,qualifiedStrength:strength,properties:[
    {boneIndex:17,boneName:'左肩',quaternion:rotation(-2+values.shoulderOffsetDegrees,'z')},
    {boneIndex:18,boneName:'左腕',quaternion:rotation(-25+values.upperArmOffsetDegrees,'z')},
    {boneIndex:21,boneName:'左ひじ',quaternion:rotation(-30+values.elbowOffsetDegrees,'x')},
  ]};
}
/** Add only active right-hand contributions; identity never claims a bone or substitutes bind pose. */
export function applyBodyRightTweak(base:BodyPoseBinding|null,input:BodyRightSelection,leftStrength:number):BodyPoseBinding {
  const right=validateBodyRightSelection(input);
  if(!base||base.id!==BODY_TWEAK_BINDING||base.targetModelSha!==BODY_TWEAK_TARGET||base.sourceSha!==BODY_TWEAK_BASE
    ||base.mask!=='gene-left-shoulder-arm-elbow-quaternion-v1'||!Number.isFinite(leftStrength)||leftStrength<0||leftStrength>1||base.qualifiedStrength!==leftStrength)throw Error('当前模型或姿势目标不正确。');
  const properties=leftStrength===0?[]:[...base.properties];
  if(right.enabled&&right.strength>0){
    const add=(boneIndex:number,boneName:string,degrees:number,axis:'x'|'z')=>{
      if(degrees===0)return;const half=degrees*Math.PI/360,s=Math.sin(half),c=Math.cos(half);
      // Finite nonzero angles can underflow to an actual identity quaternion.
      if(s===0&&(c===1||c===-1))return;
      properties.push({boneIndex,boneName,quaternion:axis==='x'?[s,0,0,c]:[0,0,s,c],weight:right.strength});
    };
    add(26,'右肩',right.shoulderOffsetDegrees,'z');add(27,'右腕',right.upperArmOffsetDegrees,'z');add(30,'右ひじ',right.elbowOffsetDegrees,'x');
  }
  return {...base,properties};
}
/** A valid current head is the only source of head ownership; identity is never bound or claimed. */
export function applyBodyHeadTweak(base:BodyPoseBinding|null,input:BodyHeadSelection,leftStrength:number):BodyPoseBinding {
  const head=validateBodyHeadSelection(input);
  if(!base||base.id!==BODY_TWEAK_BINDING||base.targetModelSha!==BODY_TWEAK_TARGET||base.sourceSha!==BODY_TWEAK_BASE
    ||base.mask!=='gene-left-shoulder-arm-elbow-quaternion-v1'||!Number.isFinite(leftStrength)||leftStrength<0||leftStrength>1||base.qualifiedStrength!==leftStrength)throw Error('当前模型或头部目标不正确。');
  const properties=leftStrength===0?base.properties.filter(p=>p.weight!==undefined&&p.weight>0):[...base.properties];
  if(head.enabled&&head.strength>0&&head.offsetDegrees!==0){
    const half=head.offsetDegrees*Math.PI/360,s=Math.sin(half),c=Math.cos(half);
    if(!(s===0&&(c===1||c===-1)))properties.push({boneIndex:9,boneName:'頭',quaternion:[0,0,s,c],weight:head.strength});
  }
  return {...base,properties};
}
/** Closed host-derived current-base delta; the model/renderer cannot choose its property or mode. */
export function applyBodyTorsoTweak(base:BodyPoseBinding|null,input:BodyTorsoSelection,leftStrength:number):BodyPoseBinding {
  const torso=validateBodyHeadSelection(input);
  if(!base||base.id!==BODY_TWEAK_BINDING||base.targetModelSha!==BODY_TWEAK_TARGET||base.sourceSha!==BODY_TWEAK_BASE
    ||base.mask!=='gene-left-shoulder-arm-elbow-quaternion-v1'||!Number.isFinite(leftStrength)||leftStrength<0||leftStrength>1||base.qualifiedStrength!==leftStrength)throw Error('当前模型或躯干目标不正确。');
  const properties=leftStrength===0?base.properties.filter(p=>p.weight!==undefined&&p.weight>0):[...base.properties];
  if(torso.enabled&&torso.strength>0&&torso.offsetDegrees!==0){
    const half=(torso.offsetDegrees*torso.strength)*Math.PI/360,s=Math.sin(half),c=Math.cos(half);
    if(!(s===0&&(c===1||c===-1)))properties.push({boneIndex:5,boneName:'上半身',quaternion:[0,0,s,c],weight:1,currentTorsoDelta:true});
  }
  return {...base,properties};
}
export function bodyBindingForProfile(base:BodyPoseBinding|null, profile:BodyPoseProfile):BodyPoseBinding|null {
  try { const v=validateBodyPoseProfile(profile);if(!v)return null;
    const left=v.tweak?applyBodyPoseTweak(base,{shoulderOffsetDegrees:v.tweak.shoulderOffsetDegrees,upperArmOffsetDegrees:v.tweak.upperArmOffsetDegrees,elbowOffsetDegrees:v.tweak.elbowOffsetDegrees},v.strength):base;
    const right=v.right?{enabled:v.right.enabled,strength:v.right.strength,shoulderOffsetDegrees:v.right.shoulderOffsetDegrees,upperArmOffsetDegrees:v.right.upperArmOffsetDegrees,elbowOffsetDegrees:v.right.elbowOffsetDegrees}:null;
    const withRight=right?applyBodyRightTweak(left,right,v.strength):left;
    const withHead=v.head?applyBodyHeadTweak(withRight,{enabled:v.head.enabled,strength:v.head.strength,offsetDegrees:v.head.offsetDegrees},v.strength):withRight;
    return v.torso?applyBodyTorsoTweak(withHead,{enabled:v.torso.enabled,strength:v.torso.strength,offsetDegrees:v.torso.offsetDegrees},v.strength):withHead; } catch { return null; }
}
