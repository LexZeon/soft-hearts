import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_TWEAK_BASE, BODY_TWEAK_BINDING, BODY_TWEAK_TARGET, makeBodyHeadTweak, parseBodyVisualStudy, validateBodyPoseProfile, type BodyPoseBinding } from '../shared/stage/personalize-body';
import { applyBodyHeadTweak, bodyBindingForProfile } from '../electron/stage/personalize-body-tweak';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import { BODY_VISUAL_PURPOSE } from '../shared/stage/personalize-body';
import { bodyPoseBinding } from '../shared/stage/personalize-body-bindings';
import { PersonalizeBodyStore } from '../electron/stage/personalize-body-store';
import { PersonalizeBodyAuthoring } from '../electron/stage/personalize-body-authoring';
import type { SelectedVisualImage } from '../electron/senses/selected-visual-image';

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
