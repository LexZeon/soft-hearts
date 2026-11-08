import test from 'node:test';
import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Euler, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { BODY_TWEAK_BASE, BODY_TWEAK_BINDING, BODY_TWEAK_TARGET, makeBodyHeadTweak, parseBodyVisualStudy, validateBodyPoseProfile, type BodyPoseBinding } from '../shared/personalize-body';
import { applyBodyHeadTweak, bodyBindingForProfile } from '../electron/personalize-body-tweak';
import { PersonalizeStaticPose } from '../src/stage/personalize-static-pose';
import { MmdStage } from '../src/stage/MmdStage';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import { BODY_VISUAL_PURPOSE } from '../shared/personalize-body';
import { bodyPoseBinding } from '../shared/personalize-body-bindings';
import { PersonalizeBodyStore } from '../electron/personalize-body-store';
import { PersonalizeBodyAuthoring } from '../electron/personalize-body-authoring';
import type { SelectedVisualImage } from '../electron/selected-visual-image';

const base:BodyPoseBinding={id:BODY_TWEAK_BINDING,label:'test',targetModelSha:BODY_TWEAK_TARGET,sourceSha:BODY_TWEAK_BASE,mask:'gene-left-shoulder-arm-elbow-quaternion-v1',qualifiedStrength:.5,
  properties:[{boneIndex:17,boneName:'左肩',quaternion:[0,0,0,1]}]};
const head=(offsetDegrees:number,enabled=true,strength=.5)=>({offsetDegrees,enabled,strength});
const profile={bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'test',strength:.5,enabled:true,targetModelSha:BODY_TWEAK_TARGET,sourceSha:BODY_TWEAK_BASE} as const;

test('legacy stays absent, closed head is validated and unrelated arms remain unchanged',()=>{
  assert.equal(Object.hasOwn(validateBodyPoseProfile(profile)!,'head'),false);
  const prior=validateBodyPoseProfile({...profile,head:makeBodyHeadTweak(head(4))})!;
  assert.deepEqual(prior.head,makeBodyHeadTweak(head(4)));
  assert.throws(()=>validateBodyPoseProfile({...profile,head:{...prior.head,unknown:true}}));
  assert.throws(()=>validateBodyPoseProfile({...profile,targetModelSha:'f'.repeat(64),head:prior.head}));
  assert.throws(()=>makeBodyHeadTweak(head(Infinity)));assert.throws(()=>makeBodyHeadTweak(head(10.01)));
  const binding=bodyBindingForProfile(base,prior)!;assert.deepEqual(binding.properties[0],base.properties[0]);
  assert.equal(binding.properties.at(-1)?.boneIndex,9);assert.equal(binding.properties.at(-1)?.weight,.5);
});
test('disabled, zero strength, zero and numerically underflowing head never contribute',()=>{
  for(const v of [head(5,false),head(5,true,0),head(0),head(Number.MIN_VALUE),head(-Number.MIN_VALUE)])
    assert.deepEqual(applyBodyHeadTweak(base,v,.5).properties,base.properties);
  for(const degrees of [-10,10])assert.equal(applyBodyHeadTweak(base,head(degrees,true,1),.5).properties.at(-1)?.boneIndex,9);
});
test('head advice requires declared head and reference sufficiency; invalid optional value leaves old observations',()=>{
  const old={observations:[],inferences:[],questions:[],insufficient:''};
  assert.equal(Object.hasOwn(parseBodyVisualStudy(JSON.stringify(old)),'headAdvice'),false);
  const advice={offsetDegrees:3,sufficiency:'sufficient',referenceSufficiency:'uncertain',reason:'r',unknowns:'u'};
  assert.equal(parseBodyVisualStudy(JSON.stringify({...old,headAdvice:advice})).headAdvice?.offsetDegrees,null);
  assert.equal(parseBodyVisualStudy(JSON.stringify({...old,headAdvice:{...advice,referenceSufficiency:'sufficient'}})).headAdvice?.offsetDegrees,3);
  const invalid=parseBodyVisualStudy(JSON.stringify({...old,headAdvice:{...advice,offsetDegrees:11}}));assert.equal(invalid.headAdvice,null);assert.deepEqual(invalid.observations,[]);
});
test('one head candidate is explicit and single use; legacy open and arm-only save preserve head absence and existing head',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'soft-head-tilt-')),card=randomUUID(),store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();await store.save(card,profile,0);
  const file=path.join(dir,'personalize-body.json'),before=await readFile(file,'utf8'),binding=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!;
  const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:'ctx',codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://model'}),verifyTarget:async()=>BODY_TWEAK_TARGET,choices:()=>[binding],binding:bodyPoseBinding,
    chooseImage:async()=>({dataUrl:'data:image/jpeg;base64,AA==',previewDataUrl:'data:image/jpeg;base64,AA==',sha256:'c'.repeat(64),width:1,height:1,release:()=>{}} as SelectedVisualImage),reserve:()=>()=>{},
    stream:async(_p,_i,_s,append)=>append(JSON.stringify({observations:[],inferences:[],questions:[],insufficient:'',headAdvice:{offsetDegrees:4,sufficiency:'sufficient',referenceSufficiency:'sufficient',reason:'r',unknowns:'u'}})),previewCancelled:()=>{},changed:()=>{}});
  const left={bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'left',strength:.5,offsets:{shoulderOffsetDegrees:0,upperArmOffsetDegrees:0,elbowOffsetDegrees:0}};
  try{
    let s=await service.get(7,card);assert.equal(await readFile(file,'utf8'),before);assert.equal(s.saved.profile?.head,undefined);
    s=await service.choose(7,s.id,s.revision);s=await service.research(7,{sessionId:s.id,revision:s.revision,materialId:s.material!.id,submitNonce:s.submitNonce!,purpose:BODY_VISUAL_PURPOSE,refinement:''});
    const id=s.advice!.id!;const fill=await service.consumeAdvice(7,s.id,s.revision,id,'head');assert.equal(fill.headOffsetDegrees,4);assert.equal(fill.shoulderOffsetDegrees,null);
    await assert.rejects(service.consumeAdvice(7,s.id,fill.revision,id,'head'));s=await service.get(7,card);assert.equal(s.saved.profile?.head,undefined);
    let p=await service.previewFixed(7,s.id,s.revision,{...left,head:head(4)});service.receipt(7,{phase:'bind',id:p.id,token:p.token,stageGeneration:3});
    assert.equal((await service.resolve(7,p.id,p.token,3)).properties.at(-1)?.boneIndex,9);service.receipt(7,{phase:'ready',id:p.id,token:p.token,stageGeneration:3});
    s=await service.save(7,{sessionId:s.id,revision:p.revision,savedRevision:s.savedRevision,previewId:p.id,previewToken:p.token});assert.deepEqual(s.saved.profile?.head,makeBodyHeadTweak(head(4)));
    p=await service.previewFixed(7,s.id,s.revision,left);service.receipt(7,{phase:'bind',id:p.id,token:p.token,stageGeneration:3});await service.resolve(7,p.id,p.token,3);service.receipt(7,{phase:'ready',id:p.id,token:p.token,stageGeneration:3});
    s=await service.save(7,{sessionId:s.id,revision:p.revision,savedRevision:s.savedRevision,previewId:p.id,previewToken:p.token});assert.deepEqual(s.saved.profile?.head,makeBodyHeadTweak(head(4)));
  }finally{service.invalidate();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-head-tilt-'));await rm(dir,{recursive:true,force:true});}
});
test('current effective claim follows preview, higher gates, expiry and transition; restore advances base',()=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.assign(globalThis,{document:{hidden:false}});
  const geometry=new BufferGeometry(),material=new MeshBasicMaterial(),mesh=new SkinnedMesh(geometry,material),bones=Array.from({length:10},()=>new Bone());
  bones[9].name='頭';mesh.add(bones[0]);for(let i=1;i<bones.length;i++)bones[0].add(bones[i]);mesh.bind(new Skeleton(bones));
  const rest=bones.map(bone=>({bone,quaternion:bone.quaternion.clone()})),binding=applyBodyHeadTweak(base,head(5,true,1),.5);
  const overlay=new PersonalizeStaticPose(mesh,binding.properties.filter(p=>p.boneIndex===9),rest),gates={visible:true,enabled:true,manualPose:false,manualGesture:false,dynamicPose:false,cameraOrWindow:false,inputBlocked:false,directContact:false,music:false,chatGesture:false};
  let transition=false;const active={overlay,model:1,ready:true,timer:undefined,resolve:()=>{},value:{expiresAt:Date.now()+10000,strength:.5}};
  const stage=Object.assign(Object.create(MmdStage.prototype),{head:bones[9],hostVisible:true,disposed:false,modelGeneration:1,bodyPreview:active,bodyPersonalize:null,bodyMotion:null,headFrameClaim:null,deferredAutoHead:[],boneLayers:[],morphLayers:[],rotation:new Euler(),offset:new Quaternion(),motionTransition:{ownsProperty:()=>transition},bodyGates:()=>gates}) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
  try{
    assert.equal(stage.currentHeadClaim(),overlay);gates.manualPose=true;assert.equal(stage.currentHeadClaim(),null);gates.manualPose=false;
    gates.music=true;assert.equal(stage.currentHeadClaim(),null);gates.music=false;transition=true;assert.equal(stage.currentHeadClaim(),null);transition=false;
    const advanced=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.4);bones[9].quaternion.copy(advanced);overlay.apply(.5);assert.ok(bones[9].quaternion.angleTo(advanced)>.1);overlay.restore();assert.ok(bones[9].quaternion.angleTo(advanced)<1e-7);
    stage.headFrameClaim=stage.currentHeadClaim();stage.rotateAutomaticHead(.2,0,0);assert.ok(bones[9].quaternion.equals(advanced));assert.deepEqual(stage.deferredAutoHead,[[.2,0,0]]);
    const untouched=bones[8].quaternion.clone();const liveApplied=stage.frameBodyPreview();assert.equal(liveApplied,true);stage.settleHeadFrameClaim(liveApplied);assert.deepEqual(stage.deferredAutoHead,[]);assert.ok(bones[9].quaternion.angleTo(advanced)>.1);assert.ok(bones[8].quaternion.equals(untouched));overlay.restore();
    stage.headFrameClaim=stage.currentHeadClaim();stage.deferredAutoHead=[];stage.rotateAutomaticHead(.2,0,0);gates.manualPose=true;stage.settleHeadFrameClaim(false);
    assert.equal(stage.headFrameClaim,null);assert.deepEqual(stage.deferredAutoHead,[]);assert.ok(bones[9].quaternion.angleTo(advanced)>.1);stage.restoreLayers();gates.manualPose=false;
    active.value.expiresAt=Date.now()-1;assert.equal(stage.currentHeadClaim(),null);
    // Cross the exact deadline after the first claim but before the actual frame method.
    const realNow=Date.now;let now=100;Date.now=()=>now;
    try{
      active.value.expiresAt=101;stage.bodyPreview=active;stage.headFrameClaim=stage.currentHeadClaim();stage.deferredAutoHead=[];stage.rotateAutomaticHead(.2,0,0);
      now=101;const applied=stage.frameBodyPreview();assert.equal(applied,false);stage.settleHeadFrameClaim(applied);
      assert.equal(stage.headFrameClaim,null);assert.ok(bones[9].quaternion.angleTo(advanced)>.1);stage.restoreLayers();
      // Even if the preview gate is live, a later same-call descriptor check can expire.
      now=300;active.value.expiresAt=301;stage.bodyPreview=active;stage.headFrameClaim=stage.currentHeadClaim();stage.deferredAutoHead=[];stage.rotateAutomaticHead(.2,0,0);
      let checks=0;Date.now=()=>++checks===1?300:301;const late=stage.frameBodyPreview();assert.equal(late,false);stage.settleHeadFrameClaim(late);
      assert.ok(bones[9].quaternion.angleTo(advanced)>.1);overlay.restore();stage.restoreLayers();Date.now=()=>now;
      now=200;stage.bodyPreview=null;stage.moodView={token:'scope'};stage.bodyPersonalize={overlay,model:1,token:'scope',cue:{expiresAt:201,strength:.5}};
      stage.headFrameClaim=stage.currentHeadClaim();stage.deferredAutoHead=[];stage.rotateAutomaticHead(.2,0,0);
      now=201;const savedApplied=stage.framePersonalizeBody();assert.equal(savedApplied,false);stage.settleHeadFrameClaim(savedApplied);
      assert.equal(stage.headFrameClaim,null);assert.ok(bones[9].quaternion.angleTo(advanced)>.1);stage.restoreLayers();
    }finally{Date.now=realNow;}
  }finally{mesh.skeleton.dispose();geometry.dispose();material.dispose();if(old)Object.defineProperty(globalThis,'document',old);else Reflect.deleteProperty(globalThis,'document');}
});
