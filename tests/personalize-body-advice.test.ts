import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {BODY_TWEAK_TARGET,BODY_VISUAL_PURPOSE,parseBodyVisualStudy} from '../shared/personalize-body';
import {bodyPoseBinding} from '../shared/personalize-body-bindings';import {PersonalizeBodyAuthoring} from '../electron/personalize-body-authoring';
import {PersonalizeBodyStore} from '../electron/personalize-body-store';import type {SelectedVisualImage} from '../electron/selected-visual-image';
const core={observations:[{region:'left-arm',visibility:'visible',description:'可见'}],inferences:[],questions:[],insufficient:'深度未知'};
const joint=(offsetDegrees:number|null,sufficiency='sufficient')=>({offsetDegrees,sufficiency});
const advice={subjectLeft:'unambiguous',shoulder:joint(5),upperArm:joint(null,'uncertain'),elbow:joint(-3),reason:'近似',unknowns:'深度未知'};
test('legacy strict core survives null, partial, gating and invalid untrusted candidates',()=>{
 assert.deepEqual(parseBodyVisualStudy(JSON.stringify(core)),core);
 assert.equal(parseBodyVisualStudy(JSON.stringify({...core,advice:null})).advice,null);
 assert.deepEqual(parseBodyVisualStudy(JSON.stringify({...core,advice})).advice,advice);
 const ambiguous=parseBodyVisualStudy(JSON.stringify({...core,advice:{...advice,subjectLeft:'ambiguous'}})).advice!;
 assert.deepEqual([ambiguous.shoulder.offsetDegrees,ambiguous.upperArm.offsetDegrees,ambiguous.elbow.offsetDegrees],[null,null,null]);
 const gated=parseBodyVisualStudy(JSON.stringify({...core,advice:{...advice,shoulder:joint(5,'insufficient')}})).advice!;assert.equal(gated.shoulder.offsetDegrees,null);
 for(const bad of [{...advice,extra:1},{...advice,shoulder:joint(10.01)},{...advice,elbow:{...joint(1),boneIndex:21}},
   {...advice,reason:'https://example.com'},{...advice,subjectLeft:'yes'}]){
  const result=parseBodyVisualStudy(JSON.stringify({...core,advice:bad}));assert.equal(result.advice,null);assert.equal(result.insufficient,core.insufficient);
 }
 assert.throws(()=>parseBodyVisualStudy(JSON.stringify({...core,unknownTop:true,advice})));
 assert.throws(()=>parseBodyVisualStudy(JSON.stringify({...core,observations:[{region:'left-arm',visibility:'bad',description:'x'}],advice})));
});

test('host binds one candidate to current session/material/target, consumes once, and fences late target checks',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'soft-body-advice-')),card=randomUUID(),store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();
 let context='ctx',sent=0,raw=JSON.stringify({...core,advice}),defer=false,model:string|null=BODY_TWEAK_TARGET,finishVerify:((v:string|null)=>void)|undefined;
 const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:context,codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://synthetic'}),
  verifyTarget:async()=>defer?new Promise(resolve=>{finishVerify=resolve;}):model,choices:sha=>{const b=bodyPoseBinding('body.gene-left-arm-soft-bend',sha);return b?[b]:[];},
  binding:bodyPoseBinding,chooseImage:async()=>({dataUrl:'data:image/jpeg;base64,AA==',previewDataUrl:'data:image/jpeg;base64,AA==',sha256:'c'.repeat(64),width:1,height:1,release:()=>{}} as SelectedVisualImage),
  reserve:()=>()=>{},stream:async(_prompt,_image,_signal,append)=>{sent++;append(raw);},previewCancelled:()=>{},changed:()=>{}});
 const research=async(s:Awaited<ReturnType<typeof service.get>>)=>service.research(7,{sessionId:s.id,revision:s.revision,materialId:s.material!.id,submitNonce:s.submitNonce!,purpose:BODY_VISUAL_PURPOSE,refinement:''});
 try{let s=await service.get(7,card);s=await service.choose(7,s.id,s.revision);s=await research(s);assert.equal(sent,1);assert.ok(s.advice?.id);assert.equal(s.study?.advice,undefined);
  const candidate=s.advice!.id!;await assert.rejects(service.consumeAdvice(8,s.id,s.revision,candidate));
  const fill=await service.consumeAdvice(7,s.id,s.revision,candidate);assert.deepEqual(fill,{revision:s.revision+1,shoulderOffsetDegrees:5,upperArmOffsetDegrees:null,elbowOffsetDegrees:-3});
  await assert.rejects(service.consumeAdvice(7,s.id,fill.revision,candidate));assert.equal(store.get(card).profile,null);
  await assert.rejects(readFile(path.join(dir,'personalize-body.json'),'utf8'));
  s=await service.get(7,card);s=await research(s);const next=s.advice!.id!;defer=true;const late=service.consumeAdvice(7,s.id,s.revision,next);
  service.discardAdvice(7,s.id,s.revision);finishVerify!(BODY_TWEAK_TARGET);await assert.rejects(late);defer=false;
  s=await service.get(7,card);raw=JSON.stringify({...core,advice:{...advice,subjectLeft:'unknown'}});s=await research(s);assert.equal(s.advice?.id,null);assert.equal(s.study?.insufficient,core.insufficient);
  await assert.rejects(service.consumeAdvice(7,s.id,s.revision,'nonexistent'));service.discardAdvice(7,s.id,s.revision);
  raw=JSON.stringify({...core,advice:{...advice,shoulder:joint(100)}});s=await research(s);assert.equal(s.advice,null);assert.equal(s.study?.insufficient,core.insufficient);
  raw=JSON.stringify({...core,advice});s=await research(s);const stale=s.advice!.id!;context='changed';await assert.rejects(service.consumeAdvice(7,s.id,s.revision,stale));
  service.invalidate();model='d'.repeat(64);s=await service.get(7,card);s=await service.choose(7,s.id,s.revision);s=await research(s);assert.equal(s.targetSupported,false);assert.equal(s.advice,null);assert.equal(s.study?.insufficient,core.insufficient);
 }finally{service.invalidate();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-body-advice-'));await rm(dir,{recursive:true,force:true});}
});
