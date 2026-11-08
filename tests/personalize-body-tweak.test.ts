import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BODY_TWEAK_BASE, BODY_TWEAK_TARGET, BODY_TWEAK_BINDING, makeBodyPoseTweak, validateBodyPoseProfile, validateBodyPoseSelection } from '../shared/personalize-body';
import { bodyPoseBinding } from '../shared/personalize-body-bindings';
import { applyBodyPoseTweak, bodyBindingForProfile } from '../electron/personalize-body-tweak';
import { PersonalizeBodyAuthoring } from '../electron/personalize-body-authoring';
import { PersonalizeBodyStore } from '../electron/personalize-body-store';
import { selectBodyPosePresentation } from '../shared/personalize-body-presentation';
import { Bone,BufferGeometry,MeshBasicMaterial,Quaternion,Skeleton,SkinnedMesh,Vector3 } from 'three';
import { PersonalizeStaticPose } from '../src/stage/personalize-static-pose';

const base=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!;
const zero={shoulderOffsetDegrees:0,upperArmOffsetDegrees:0,elbowOffsetDegrees:0};
const selection={bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'微调',strength:.5,offsets:zero} as const;
const fixed={enabled:true,bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'固定',strength:.5,targetModelSha:BODY_TWEAK_TARGET,sourceSha:BODY_TWEAK_BASE} as const;

test('closed host class preserves fixed default, validates endpoints, and rejects renderer authority',()=>{
  const baseline=applyBodyPoseTweak(base,zero,.5);
  for(let i=0;i<3;i++)for(let j=0;j<4;j++)assert.ok(Math.abs(baseline.properties[i].quaternion[j]-base.properties[i].quaternion[j])<1e-14);
  assert.deepEqual(baseline.properties.map(p=>[p.boneIndex,p.boneName]),[[17,'左肩'],[18,'左腕'],[21,'左ひじ']]);
  for(const n of [-10,10])for(const strength of [0,1]){
    const edit={shoulderOffsetDegrees:n,upperArmOffsetDegrees:n,elbowOffsetDegrees:n};
    assert.equal(applyBodyPoseTweak(base,edit,strength).qualifiedStrength,strength);
    assert.deepEqual(validateBodyPoseSelection({...selection,strength,offsets:edit}).offsets,edit);
  }
  for(const bad of [NaN,Infinity,-10.01,10.01])assert.throws(()=>validateBodyPoseSelection({...selection,offsets:{...zero,elbowOffsetDegrees:bad}}));
  for(const strength of [-.01,1.01,NaN])assert.throws(()=>validateBodyPoseSelection({...selection,strength}));
  assert.throws(()=>validateBodyPoseSelection({...selection,offsets:{...zero,boneIndex:17}}));
  assert.throws(()=>validateBodyPoseSelection({...selection,quaternion:[0,0,0,1]}));
  assert.throws(()=>applyBodyPoseTweak({...base,targetModelSha:'0'.repeat(64)},zero,.5));
  assert.deepEqual(validateBodyPoseProfile(fixed),fixed);
  assert.throws(()=>validateBodyPoseProfile({...fixed,tweak:{...makeBodyPoseTweak(zero),baseSha256:'0'.repeat(64)}}));
});

test('zero strength preserves the live base and a nonzero synthetic overlay restores only owned rotations',()=>{
  const bones=Array.from({length:22},()=>new Bone());bones[17].name='左肩';bones[18].name='左腕';bones[21].name='左ひじ';
  const geometry=new BufferGeometry(),material=new MeshBasicMaterial(),mesh=new SkinnedMesh(geometry,material);
  mesh.add(bones[0]);for(let i=1;i<bones.length;i++)bones[0].add(bones[i]);mesh.bind(new Skeleton(bones));
  const rest=bones.map(bone=>({bone,quaternion:bone.quaternion.clone()}));
  const current=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3);bones[17].quaternion.copy(current);bones[4].quaternion.copy(current);
  const overlay=new PersonalizeStaticPose(mesh,applyBodyPoseTweak(base,{...zero,shoulderOffsetDegrees:10},1).properties,rest);
  overlay.apply(0);assert.ok(bones[17].quaternion.equals(current));assert.ok(bones[4].quaternion.equals(current));overlay.restore();
  overlay.apply(1);assert.ok(!bones[17].quaternion.equals(current));assert.ok(bones[4].quaternion.equals(current));overlay.restore();
  assert.ok(bones[17].quaternion.equals(current));assert.ok(bones[4].quaternion.equals(current));geometry.dispose();material.dispose();
});

test('same session previews and saves explicit parameters; legacy read and zero-strength preservation remain separate',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'soft-body-tweak-')), card=randomUUID(), owner=7;
  const store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();await store.save(card,fixed,0);
  const filename=path.join(dir,'personalize-body.json'), original=await readFile(filename,'utf8');
  let context='context',model:string|null=BODY_TWEAK_TARGET,streams=0;const cancelled:string[]=[];
  const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:context,codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://synthetic'}),
    verifyTarget:async()=>model,choices:sha=>sha===BODY_TWEAK_TARGET?[base]:[],binding:(id,sha)=>bodyPoseBinding(id,sha),chooseImage:async()=>null,
    reserve:()=>()=>{},stream:async()=>{streams++;},previewCancelled:(_owner,id)=>cancelled.push(id),changed:()=>{}});
  try {
    let state=await service.get(owner,card);assert.deepEqual(state.saved.profile,fixed);assert.equal(await readFile(filename,'utf8'),original);
    await assert.rejects(service.preview(owner,state.id,state.revision,selection));assert.equal(streams,0);
    const offsets={shoulderOffsetDegrees:-10,upperArmOffsetDegrees:8,elbowOffsetDegrees:10};
    const view=await service.previewFixed(owner,state.id,state.revision,{...selection,offsets,strength:1});
    assert.equal(view.materialId,null);assert.equal(view.sourceKind,'fixed-preset');
    await assert.rejects(service.resolve(owner,view.id,view.token,3));
    service.receipt(owner,{phase:'bind',id:view.id,token:view.token,stageGeneration:3});
    const resolved=await service.resolve(owner,view.id,view.token,3);assert.deepEqual(resolved,applyBodyPoseTweak(base,offsets,1));
    service.receipt(owner,{phase:'ready',id:view.id,token:view.token,stageGeneration:3});
    const save={sessionId:state.id,revision:view.revision,savedRevision:state.savedRevision,previewId:view.id,previewToken:view.token};
    model=null;await assert.rejects(service.save(owner,save));model=BODY_TWEAK_TARGET;
    state=await service.save(owner,save);assert.deepEqual(state.saved.profile?.tweak,makeBodyPoseTweak(offsets));
    assert.deepEqual(state.saved.previous?.profile,fixed);assert.equal(streams,0);
    const readback=new PersonalizeBodyStore(dir,()=>[card]);await readback.load();assert.deepEqual(readback.get(card),state.saved);
    const profile=state.saved.profile!,binding=bodyBindingForProfile(base,profile);
    assert.deepEqual(binding,resolved);
    const plan={state:{id:'cue',kind:'state' as const,bindingId:'face.happy' as const,semantic:'mood.happy' as const,at:1,expiresAt:10,strength:1,stateKey:'s'},reaction:null};
    assert.equal(selectBodyPosePresentation(profile,binding,BODY_TWEAK_TARGET,'mmd-asset://synthetic',plan,2)?.strength,1);
    const muted={...profile,strength:0},mutedBinding=bodyBindingForProfile(base,muted);
    assert.equal(selectBodyPosePresentation(muted,mutedBinding,BODY_TWEAK_TARGET,'mmd-asset://synthetic',plan,2),null);
    state=await service.change(owner,{sessionId:state.id,revision:state.revision,kind:'disable'});assert.equal(state.saved.profile?.enabled,false);
    state=await service.change(owner,{sessionId:state.id,revision:state.revision,kind:'undo'});assert.equal(state.saved.profile?.enabled,true);
    const next=await service.previewFixed(owner,state.id,state.revision,{...selection,strength:0,offsets});
    service.receipt(owner,{phase:'stop',id:next.id,token:next.token,stageGeneration:0});
    await assert.rejects(service.resolve(owner,next.id,next.token,3));assert.ok(cancelled.includes(next.id));
    const again=await service.get(owner,card);const late=await service.previewFixed(owner,again.id,again.revision,selection);context='replaced';
    await assert.rejects(service.resolve(owner,late.id,late.token,3));
  } finally {service.invalidate();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-body-tweak-'));await rm(dir,{recursive:true,force:true});}
});
