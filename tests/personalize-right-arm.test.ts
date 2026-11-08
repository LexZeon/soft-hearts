import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {Bone,BufferGeometry,MeshBasicMaterial,Quaternion,Skeleton,SkinnedMesh,Vector3} from 'three';
import {BODY_TWEAK_BASE,BODY_TWEAK_BINDING,BODY_TWEAK_TARGET,BODY_VISUAL_PURPOSE,makeBodyRightTweak,parseBodyVisualStudy,validateBodyPoseProfile,validateBodyPoseSelection} from '../shared/personalize-body';
import {bodyPoseBinding} from '../shared/personalize-body-bindings';import {applyBodyPoseTweak,applyBodyRightTweak,bodyBindingForProfile} from '../electron/personalize-body-tweak';
import {PersonalizeStaticPose} from '../src/stage/personalize-static-pose';import {PersonalizeBodyAuthoring} from '../electron/personalize-body-authoring';
import {PersonalizeBodyStore} from '../electron/personalize-body-store';import type {SelectedVisualImage} from '../electron/selected-visual-image';
import {selectBodyPosePresentation} from '../shared/personalize-body-presentation';
const base=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!;const offsets={shoulderOffsetDegrees:0,upperArmOffsetDegrees:0,elbowOffsetDegrees:0};
const right={enabled:true,strength:.8,shoulderOffsetDegrees:0,upperArmOffsetDegrees:10,elbowOffsetDegrees:-10};
const fixed={enabled:true,bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'固定',strength:.5,targetModelSha:BODY_TWEAK_TARGET,sourceSha:BODY_TWEAK_BASE} as const;
const selection={bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'组合',strength:.4,offsets,right} as const;
test('closed right class leaves disabled, zero-strength and individual identity joints unclaimed',()=>{
 const left=applyBodyPoseTweak(base,offsets,.4);
 for(const input of [{...right,enabled:false},{...right,strength:0},{...right,upperArmOffsetDegrees:0,elbowOffsetDegrees:0}])
  assert.deepEqual(applyBodyRightTweak(left,input,.4).properties.map(p=>p.boneIndex),[17,18,21]);
 const underflow={...right,shoulderOffsetDegrees:Number.MIN_VALUE,upperArmOffsetDegrees:-Number.MIN_VALUE,elbowOffsetDegrees:Number.MIN_VALUE};
 assert.deepEqual(applyBodyRightTweak(left,underflow,.4).properties.map(p=>p.boneIndex),[17,18,21]);
 const combined=applyBodyRightTweak(left,right,.4);assert.deepEqual(combined.properties.map(p=>p.boneIndex),[17,18,21,27,30]);
 assert.deepEqual(combined.properties.slice(3).map(p=>p.weight),[.8,.8]);
 assert.throws(()=>applyBodyRightTweak(left,{...right,elbowOffsetDegrees:10.01},.4));
 assert.throws(()=>applyBodyRightTweak({...left,targetModelSha:'0'.repeat(64)},right,.4));
 assert.throws(()=>validateBodyPoseSelection({...selection,right:{...right,boneIndex:30}}));
 assert.deepEqual(validateBodyPoseProfile(fixed),fixed);
 const profile={...fixed,strength:.4,tweak:{version:1 as const,classId:'gene-left-arm-tweak-v1' as const,baseSha256:BODY_TWEAK_BASE,...offsets},right:makeBodyRightTweak(right)};
 assert.deepEqual(bodyBindingForProfile(base,profile),combined);
 const onlyRight={...profile,strength:0},onlyRightBinding=bodyBindingForProfile(base,onlyRight)!;
 assert.deepEqual(onlyRightBinding.properties.map(p=>p.boneIndex),[27,30]);
 const plan={state:{id:'cue',kind:'state' as const,bindingId:'face.happy' as const,semantic:'mood.happy' as const,at:1,expiresAt:10,strength:1,stateKey:'s'},reaction:null};
 assert.equal(selectBodyPosePresentation(onlyRight,onlyRightBinding,BODY_TWEAK_TARGET,'mmd-asset://model',plan,2)?.strength,0);
 const none=bodyBindingForProfile(base,{...onlyRight,right:makeBodyRightTweak({...right,strength:0})})!;
 assert.equal(none.properties.length,0);assert.equal(selectBodyPosePresentation({...onlyRight,right:makeBodyRightTweak({...right,strength:0})},none,BODY_TWEAK_TARGET,'mmd-asset://model',plan,2),null);
});
test('one applier uses independent strengths, never captures identity right and restores the advancing base',()=>{
 const bones=Array.from({length:31},()=>new Bone());for(const [i,n] of [[17,'左肩'],[18,'左腕'],[21,'左ひじ'],[26,'右肩'],[27,'右腕'],[30,'右ひじ']] as const)bones[i].name=n;
 const geometry=new BufferGeometry(),material=new MeshBasicMaterial(),mesh=new SkinnedMesh(geometry,material);mesh.add(bones[0]);for(let i=1;i<bones.length;i++)bones[0].add(bones[i]);mesh.bind(new Skeleton(bones));
 try{const rest=bones.map(bone=>({bone,quaternion:bone.quaternion.clone()})),current=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3);
  for(const i of [4,17,18,21,26,27,30])bones[i].quaternion.copy(current);
  const binding=applyBodyRightTweak(applyBodyPoseTweak(base,offsets,.4),right,.4),overlay=new PersonalizeStaticPose(mesh,binding.properties,rest);
  let untouchedWrites=0;const original=bones[26].quaternion.slerp.bind(bones[26].quaternion);bones[26].quaternion.slerp=(q,t)=>{untouchedWrites++;return original(q,t);};
  overlay.apply(.4);assert.equal(untouchedWrites,0);assert.ok(bones[26].quaternion.equals(current));assert.ok(bones[4].quaternion.equals(current));
  const leftTarget=new Quaternion(...binding.properties[0].quaternion),rightTarget=new Quaternion(...binding.properties[3].quaternion);
  assert.ok(bones[17].quaternion.angleTo(current.clone().slerp(leftTarget,.4))<1e-7);assert.ok(bones[27].quaternion.angleTo(current.clone().slerp(rightTarget,.8))<1e-7);
  overlay.restore();for(const i of [4,17,18,21,26,27,30])assert.ok(bones[i].quaternion.equals(current));
  const advanced=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.5);bones[17].quaternion.copy(advanced);bones[27].quaternion.copy(advanced);
  overlay.apply(.4);overlay.restore();assert.ok(bones[17].quaternion.equals(advanced));assert.ok(bones[27].quaternion.equals(advanced));
  assert.throws(()=>new PersonalizeStaticPose(mesh,[...binding.properties,binding.properties[0]],rest));
 }finally{geometry.dispose();material.dispose();}
});
const core={observations:[],inferences:[],questions:[],insufficient:'未知'};const joint=(offsetDegrees:number|null,sufficiency='sufficient')=>({offsetDegrees,sufficiency});
const leftAdvice={subjectLeft:'unambiguous',shoulder:joint(1),upperArm:joint(null,'uncertain'),elbow:joint(2),reason:'左',unknowns:'未知'};
const rightAdvice={subjectRight:'unambiguous',shoulder:joint(3),upperArm:joint(null,'uncertain'),elbow:joint(-4),reason:'右',unknowns:'未知'};
test('right advice is independently gated without weakening legacy or left advice',()=>{
 assert.deepEqual(parseBodyVisualStudy(JSON.stringify(core)),core);
 const mixed=parseBodyVisualStudy(JSON.stringify({...core,advice:leftAdvice,rightAdvice}));assert.deepEqual(mixed.advice,leftAdvice);assert.deepEqual(mixed.rightAdvice,rightAdvice);
 const ambiguous=parseBodyVisualStudy(JSON.stringify({...core,advice:leftAdvice,rightAdvice:{...rightAdvice,subjectRight:'ambiguous'}}));
 assert.equal(ambiguous.rightAdvice?.shoulder.offsetDegrees,null);assert.deepEqual(ambiguous.advice,leftAdvice);
 const gated=parseBodyVisualStudy(JSON.stringify({...core,rightAdvice:{...rightAdvice,shoulder:joint(3,'insufficient')}}));assert.equal(gated.rightAdvice?.shoulder.offsetDegrees,null);
 const invalid=parseBodyVisualStudy(JSON.stringify({...core,advice:leftAdvice,rightAdvice:{...rightAdvice,elbow:joint(11)}}));assert.equal(invalid.rightAdvice,null);assert.deepEqual(invalid.advice,leftAdvice);
 const invalidLeft=parseBodyVisualStudy(JSON.stringify({...core,advice:{...leftAdvice,unexpected:true},rightAdvice}));assert.equal(invalidLeft.advice,null);assert.deepEqual(invalidLeft.rightAdvice,rightAdvice);
 const rightOnly=parseBodyVisualStudy(JSON.stringify({...core,rightAdvice}));assert.equal(rightOnly.advice,undefined);assert.deepEqual(rightOnly.rightAdvice,rightAdvice);
 assert.throws(()=>parseBodyVisualStudy(JSON.stringify({...core,rightAdvice,other:true})));
});
test('one candidate consumes selected side once; right remains independent in saved and legacy records',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'soft-right-arm-')),card=randomUUID(),store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();await store.save(card,fixed,0);
 const file=path.join(dir,'personalize-body.json'),before=await readFile(file,'utf8');let calls=0,defer=false,raw=JSON.stringify({...core,rightAdvice}),finishVerify:((value:string|null)=>void)|undefined;
 const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:'ctx',codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://model'}),
  verifyTarget:async()=>defer?new Promise(resolve=>{finishVerify=resolve;}):BODY_TWEAK_TARGET,choices:()=>[base],binding:bodyPoseBinding,
  chooseImage:async()=>({dataUrl:'data:image/jpeg;base64,AA==',previewDataUrl:'data:image/jpeg;base64,AA==',sha256:'c'.repeat(64),width:1,height:1,release:()=>{}} as SelectedVisualImage),
  reserve:()=>()=>{},stream:async(_p,_i,_s,append)=>{calls++;append(raw);},previewCancelled:()=>{},changed:()=>{}});
 try{let s=await service.get(7,card);assert.deepEqual(s.saved.profile,fixed);assert.equal(await readFile(file,'utf8'),before);
  const {right:_ignored,...leftOnly}=selection;const first=await service.previewFixed(7,s.id,s.revision,leftOnly);
  service.receipt(7,{phase:'bind',id:first.id,token:first.token,stageGeneration:3});await service.resolve(7,first.id,first.token,3);
  service.receipt(7,{phase:'ready',id:first.id,token:first.token,stageGeneration:3});s=await service.save(7,{sessionId:s.id,revision:first.revision,savedRevision:s.savedRevision,previewId:first.id,previewToken:first.token});
  assert.equal(s.saved.profile?.right,undefined);assert.equal(Object.hasOwn(JSON.parse(await readFile(file,'utf8')).entries[0].profile,'right'),false);
  s=await service.choose(7,s.id,s.revision);s=await service.research(7,{sessionId:s.id,revision:s.revision,materialId:s.material!.id,submitNonce:s.submitNonce!,purpose:BODY_VISUAL_PURPOSE,refinement:''});
  assert.ok(s.advice?.id);assert.equal(s.advice?.suggestion,null);const id=s.advice!.id!;const fill=await service.consumeAdvice(7,s.id,s.revision,id,'right');
  assert.deepEqual(fill.right,{shoulderOffsetDegrees:3,upperArmOffsetDegrees:null,elbowOffsetDegrees:-4});assert.equal(fill.shoulderOffsetDegrees,null);assert.equal(calls,1);
  await assert.rejects(service.consumeAdvice(7,s.id,fill.revision,id,'left'));s=await service.get(7,card);
  raw=JSON.stringify({...core,advice:leftAdvice,rightAdvice});s=await service.research(7,{sessionId:s.id,revision:s.revision,materialId:s.material!.id,submitNonce:s.submitNonce!,purpose:BODY_VISUAL_PURPOSE,refinement:''});
  defer=true;const late=service.consumeAdvice(7,s.id,s.revision,s.advice!.id!,'right');service.discardAdvice(7,s.id,s.revision);finishVerify!(BODY_TWEAK_TARGET);await assert.rejects(late);defer=false;s=await service.get(7,card);
  const p=await service.previewFixed(7,s.id,s.revision,selection);service.receipt(7,{phase:'bind',id:p.id,token:p.token,stageGeneration:3});
  const binding=await service.resolve(7,p.id,p.token,3);assert.deepEqual(binding.properties.map(x=>x.boneIndex),[17,18,21,27,30]);
  service.receipt(7,{phase:'ready',id:p.id,token:p.token,stageGeneration:3});s=await service.save(7,{sessionId:s.id,revision:p.revision,savedRevision:s.savedRevision,previewId:p.id,previewToken:p.token});
  assert.deepEqual(s.saved.profile?.right,makeBodyRightTweak(right));assert.deepEqual(bodyBindingForProfile(base,s.saved.profile!),binding);
  const reload=new PersonalizeBodyStore(dir,()=>[card]);await reload.load();assert.deepEqual(reload.get(card),s.saved);
  const leftEdit=await service.previewFixed(7,s.id,s.revision,{...leftOnly,label:'只改左臂'});
  service.receipt(7,{phase:'bind',id:leftEdit.id,token:leftEdit.token,stageGeneration:3});
  assert.deepEqual((await service.resolve(7,leftEdit.id,leftEdit.token,3)).properties.map(x=>x.boneIndex),[17,18,21,27,30]);
  service.receipt(7,{phase:'ready',id:leftEdit.id,token:leftEdit.token,stageGeneration:3});
  s=await service.save(7,{sessionId:s.id,revision:leftEdit.revision,savedRevision:s.savedRevision,previewId:leftEdit.id,previewToken:leftEdit.token});
  assert.deepEqual(s.saved.profile?.right,makeBodyRightTweak(right));
  s=await service.change(7,{sessionId:s.id,revision:s.revision,kind:'disable'});assert.equal(s.saved.profile?.right?.enabled,true);assert.equal(s.saved.profile?.enabled,false);
  s=await service.change(7,{sessionId:s.id,revision:s.revision,kind:'undo'});assert.equal(s.saved.profile?.right?.enabled,true);assert.equal(s.saved.profile?.enabled,true);
 }finally{service.invalidate();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-right-arm-'));await rm(dir,{recursive:true,force:true});}
});
