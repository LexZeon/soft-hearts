import test from 'node:test';import assert from 'node:assert/strict';
import {Bone,BufferGeometry,MeshBasicMaterial,Quaternion,Skeleton,SkinnedMesh,Vector3} from 'three';
import {MmdStage} from '../src/stage/MmdStage';import {PersonalizeStaticPose} from '../src/stage/personalize-static-pose';
import {applyBodyPoseTweak,applyBodyTorsoTweak} from '../electron/personalize-body-tweak';import {bodyPoseBinding} from '../shared/personalize-body-bindings';
import {BODY_TWEAK_BINDING,BODY_TWEAK_TARGET} from '../shared/personalize-body';

function fixture(){
 const bones=Array.from({length:22},()=>new Bone());bones[2].name='グルーブ';bones[5].name='上半身';bones[9].name='頭';bones[17].name='左肩';
 const geometry=new BufferGeometry(),material=new MeshBasicMaterial(),mesh=new SkinnedMesh(geometry,material);mesh.add(bones[0]);bones[0].add(bones[2],bones[9],bones[17]);bones[2].add(bones[5]);mesh.bind(new Skeleton(bones));
 const rest=bones.map(bone=>({bone,quaternion:bone.quaternion.clone()})),offsets={shoulderOffsetDegrees:0,upperArmOffsetDegrees:0,elbowOffsetDegrees:0};
 const base=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!,torso=applyBodyTorsoTweak(applyBodyPoseTweak(base,offsets,0),{enabled:true,strength:.5,offsetDegrees:8},0).properties;
 const overlay=new PersonalizeStaticPose(mesh,[{boneIndex:9,boneName:'頭',quaternion:[0,0,Math.sin(.1),Math.cos(.1)]},{boneIndex:17,boneName:'左肩',quaternion:[0,Math.sin(.2),0,Math.cos(.2)]},...torso],rest);
 const torsoBase=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3),headBase=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.15),armBase=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),.2);
 bones[5].quaternion.copy(torsoBase);bones[9].quaternion.copy(headBase);bones[17].quaternion.copy(armBase);overlay.apply(.5);
 const headDisplay=bones[9].quaternion.clone(),armDisplay=bones[17].quaternion.clone();let captured:Map<string,readonly number[]>|null=null;const order:string[]=[],errors:string[]=[];
 const transition={restore:()=>order.push('transition.restore'),start:(snapshot:{values:ReadonlyMap<string,readonly number[]>})=>{captured=new Map(snapshot.values);order.push('transition.start');return true;},frame:()=>order.push('transition.frame')};
 const clip={tracks:[],duration:1},url='app-asset://test/synthetic.vmd';
 const stage=Object.assign(Object.create(MmdStage.prototype),{mesh,restPose:rest,head:bones[9],hasRenderedModel:true,disposed:false,motionGeneration:0,modelGeneration:1,bodyPreview:{overlay},bodyPersonalize:null,
  localPhysics:{restore:()=>order.push('physics.restore'),frame:()=>order.push('physics.frame')},motionTransition:transition,
  animation:{setClips:()=>['.bones[上半身].quaternion','.bones[頭].quaternion','.bones[左肩].quaternion']},motionClips:new Map([[url,Promise.resolve(clip)]]),defaultPoseChecks:new Map(),
  cancelBodyMotion:()=>{},stopTears:()=>{},syncMusicSuppression:()=>{},cancelChatGesture:()=>{},updateBodyMotion:()=>{},restoreLayers:()=>{},
  behaviorMotion:{restore:()=>{}},chatGesturePlayer:{restore:()=>{}},options:{onError:(value:string)=>errors.push(value)}}) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
 const assertCapture=()=>{assert.ok(captured);const q=(name:string)=>new Quaternion().fromArray([...(captured as Map<string,readonly number[]>).get(name)!]);
  assert.ok(q('.bones[上半身].quaternion').angleTo(torsoBase)<1e-7);assert.ok(q('.bones[頭].quaternion').angleTo(headDisplay)<1e-7);assert.ok(q('.bones[左肩].quaternion').angleTo(armDisplay)<1e-7);
  assert.equal(errors.length,0);assert.ok(order.indexOf('physics.restore')<order.indexOf('transition.restore'));assert.ok(order.indexOf('transition.restore')<order.indexOf('transition.start'));};
 return {stage,url,assertCapture,dispose:()=>{mesh.skeleton.dispose();geometry.dispose();material.dispose();}};
}
test('clear motion bridge captures advancing torso base while preserving displayed static head and arm',()=>{
 const f=fixture();try{f.stage.clearMotionSmooth();f.assertCapture();}finally{f.dispose();}
});
test('load motion bridge captures advancing torso base while preserving displayed static head and arm',async()=>{
 const f=fixture();try{await f.stage.loadMotions({pose:{url:f.url,name:'synthetic.vmd'},gesture:null,expression:null},false);f.assertCapture();}finally{f.dispose();}
});
