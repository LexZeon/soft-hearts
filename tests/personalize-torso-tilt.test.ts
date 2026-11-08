import test from 'node:test';import assert from 'node:assert/strict';
import {Bone,BufferGeometry,MeshBasicMaterial,Quaternion,Skeleton,SkinnedMesh,Vector3} from 'three';
import {BODY_TWEAK_BASE,BODY_TWEAK_BINDING,BODY_TWEAK_TARGET,makeBodyHeadTweak,makeBodyTorsoTweak,parseBodyVisualStudy,validateBodyPoseProfile,validateBodyPoseSelection} from '../shared/personalize-body';
import {bodyPoseBinding} from '../shared/personalize-body-bindings';import {applyBodyPoseTweak,applyBodyHeadTweak,applyBodyTorsoTweak,bodyBindingForProfile} from '../electron/personalize-body-tweak';
import {PersonalizeStaticPose} from '../src/stage/personalize-static-pose';import {MmdStage} from '../src/stage/MmdStage';
const base=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!;
const offsets={shoulderOffsetDegrees:0,upperArmOffsetDegrees:0,elbowOffsetDegrees:0},torso=(offsetDegrees:number,enabled=true,strength=.5)=>({offsetDegrees,enabled,strength});
const fixed={bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'test',strength:.5,enabled:true,targetModelSha:BODY_TWEAK_TARGET,sourceSha:BODY_TWEAK_BASE} as const;
test('closed torso scalar validates exact target, leaves legacy absent and preserves head',()=>{
 assert.equal(Object.hasOwn(validateBodyPoseProfile(fixed)!,'torso'),false);
 const head=makeBodyHeadTweak({enabled:true,strength:.3,offsetDegrees:4}),saved=validateBodyPoseProfile({...fixed,head,torso:makeBodyTorsoTweak(torso(8))})!;
 assert.deepEqual(saved.head,head);assert.deepEqual(saved.torso,makeBodyTorsoTweak(torso(8)));
 assert.throws(()=>validateBodyPoseProfile({...fixed,torso:{...saved.torso,mode:'arbitrary'}}));
 assert.throws(()=>validateBodyPoseProfile({...fixed,targetModelSha:'f'.repeat(64),torso:saved.torso}));
 assert.throws(()=>validateBodyPoseSelection({...fixed,torso:{...torso(1),boneIndex:5}}));
 assert.throws(()=>makeBodyTorsoTweak(torso(Infinity)));assert.throws(()=>makeBodyTorsoTweak(torso(10.1)));
 const binding=bodyBindingForProfile(base,saved)!;assert.deepEqual(binding.properties.slice(-2).map(p=>p.boneIndex),[9,5]);
});
test('off, zero, weighted underflow and invalid angles do not create a torso property',()=>{
 const left=applyBodyPoseTweak(base,offsets,.5);
 for(const v of [torso(5,false),torso(5,true,0),torso(0),torso(Number.MIN_VALUE),torso(-Number.MIN_VALUE)])assert.equal(applyBodyTorsoTweak(left,v,.5).properties.some(p=>p.boneIndex===5),false);
 for(const n of [-10,10])assert.equal(applyBodyTorsoTweak(left,torso(n,true,1),.5).properties.at(-1)?.currentTorsoDelta,true);
 assert.throws(()=>applyBodyTorsoTweak({...left,targetModelSha:'0'.repeat(64)},torso(5),.5));
});
test('current-base torso preserves animated breath, does not accumulate, and rejects invalid base and parent',()=>{
 const bones=Array.from({length:10},()=>new Bone());bones[2].name='グルーブ';bones[5].name='上半身';bones[9].name='頭';
 const geometry=new BufferGeometry(),material=new MeshBasicMaterial(),mesh=new SkinnedMesh(geometry,material);mesh.add(bones[0]);bones[0].add(bones[2],bones[9]);bones[2].add(bones[5]);mesh.bind(new Skeleton(bones));
 const rest=bones.map(bone=>({bone,quaternion:bone.quaternion.clone()})),property=applyBodyTorsoTweak(applyBodyPoseTweak(base,offsets,0),torso(10,true,.5),0).properties;
 try{
  const overlay=new PersonalizeStaticPose(mesh,property,rest),qBase=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3).multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),.2));
  const delta=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),5*Math.PI/180),expected=qBase.clone().multiply(delta).normalize();const other=bones[9].quaternion.clone();
  for(let i=0;i<3;i++){bones[5].quaternion.copy(qBase);assert.equal(overlay.apply(0),1);assert.ok(bones[5].quaternion.angleTo(expected)<1e-7);assert.ok(bones[9].quaternion.equals(other));overlay.restore();assert.ok(bones[5].quaternion.angleTo(qBase)<1e-7);}
  const headBinding=applyBodyHeadTweak(applyBodyPoseTweak(base,offsets,0),{enabled:true,strength:.5,offsetDegrees:5},0);
  const both=new PersonalizeStaticPose(mesh,applyBodyTorsoTweak(headBinding,torso(10,true,.5),0).properties,rest);
  assert.equal(both.apply(0,bones[9],true),1);assert.ok(bones[9].quaternion.equals(other));assert.ok(bones[5].quaternion.angleTo(expected)<1e-7);both.restore();
  assert.equal(both.apply(0,null,false),1);assert.ok(bones[9].quaternion.angleTo(other)>.01);assert.ok(bones[5].quaternion.angleTo(qBase)<1e-7);both.restore();
  assert.equal(overlay.apply(0,null,false),0);overlay.restore();assert.ok(bones[5].quaternion.angleTo(qBase)<1e-7);
  bones[5].quaternion.set(0,0,0,0);assert.equal(overlay.apply(0),0);overlay.restore();assert.deepEqual(bones[5].quaternion.toArray(),[0,0,0,0]);
  bones[5].quaternion.set(NaN,0,0,1);assert.equal(overlay.apply(0),0);overlay.restore();assert.ok(Number.isNaN(bones[5].quaternion.x));
  for(const magnitude of [1e300,1e-300]){bones[5].quaternion.set(magnitude,0,0,magnitude);assert.equal(overlay.apply(0),1);assert.ok(bones[5].quaternion.toArray().every(Number.isFinite));assert.ok(Math.abs(bones[5].quaternion.lengthSq()-1)<1e-12);overlay.restore();assert.deepEqual(bones[5].quaternion.toArray(),[magnitude,0,0,magnitude]);}
  const unrested=[...rest];unrested[5]={bone:bones[5],quaternion:new Quaternion(0,0,0,0)};assert.doesNotThrow(()=>new PersonalizeStaticPose(mesh,property,unrested));
  bones[0].add(bones[5]);const unsupported=new PersonalizeStaticPose(mesh,property,rest);assert.equal(unsupported.apply(0),0);unsupported.restore();
  const remaining=new PersonalizeStaticPose(mesh,applyBodyTorsoTweak(headBinding,torso(10,true,.5),0).properties,rest);assert.equal(remaining.apply(0),1);assert.ok(bones[9].quaternion.angleTo(other)>.01);remaining.restore();
 }finally{mesh.skeleton.dispose();geometry.dispose();material.dispose();}
});
test('actual transition and actual contact fallback block only torso eligibility',()=>{
 const bones=Array.from({length:6},()=>new Bone()),stage=Object.assign(Object.create(MmdStage.prototype),{mesh:{skeleton:{bones}},chest:bones[5],center:null,moodContact:{pinch:{pinching:false}},cheekMotion:null,motionTransition:{ownsProperty:(name:string)=>name==='.bones[上半身].quaternion'}}) as any;
 assert.equal(stage.torsoContributionAllowed(),false);stage.motionTransition.ownsProperty=()=>false;assert.equal(stage.torsoContributionAllowed(),true);
 stage.moodContact.pinch.pinching=true;assert.equal(stage.torsoContributionAllowed(),false);stage.center=new Bone();assert.equal(stage.torsoContributionAllowed(),true);
});
test('torso advice strict optional data never weakens legacy and uncertain references become null',()=>{
 const old={observations:[],inferences:[],questions:[],insufficient:''},v={offsetDegrees:4,sufficiency:'sufficient',referenceSufficiency:'uncertain',reason:'r',unknowns:'u'};
 assert.equal(Object.hasOwn(parseBodyVisualStudy(JSON.stringify(old)),'torsoAdvice'),false);
 assert.equal(parseBodyVisualStudy(JSON.stringify({...old,torsoAdvice:v})).torsoAdvice?.offsetDegrees,null);
 assert.equal(parseBodyVisualStudy(JSON.stringify({...old,torsoAdvice:{...v,referenceSufficiency:'sufficient'}})).torsoAdvice?.offsetDegrees,4);
 assert.equal(parseBodyVisualStudy(JSON.stringify({...old,torsoAdvice:{...v,offsetDegrees:11}})).torsoAdvice,null);
});
