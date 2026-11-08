import test from 'node:test';import assert from 'node:assert/strict';
import {Bone,Quaternion,Vector3,type SkinnedMesh} from 'three';
import {MmdStage} from '../src/stage/MmdStage';import {SurpriseOverlay,surpriseSample} from '../src/stage/surprise-preview-overlay';
import {SURPRISE_CLIP_ID,SHY_CLIP_ID,SURPRISE_MODEL_SHA,SURPRISE_REVISION} from '../shared/surprise-preview';
import {SurprisePreviewHost} from '../electron/surprise-preview-host';
import {MotionPreviewSession} from '../src/ui/motion-preview';import {DEFAULT_SETTINGS} from '../shared/defaults';

const view={id:'test-host-lease',clipId:SURPRISE_CLIP_ID,revision:SURPRISE_REVISION,targetModelSha:SURPRISE_MODEL_SHA,modelUrl:'asset://gene',expiresAt:Date.now()+100000};
function setup(){
 const bones=Array.from({length:10},()=>new Bone());bones[2].name='グルーブ';bones[5].name='上半身';bones[2].add(bones[5]);bones[8].name='首';bones[9].name='頭';bones[8].add(bones[9]);bones[5].add(bones[8]);
 const influences=Array.from({length:184},()=>0);const mesh={skeleton:{bones},morphTargetInfluences:influences,morphTargetDictionary:{'上':84,'びっくり':94}} as unknown as SkinnedMesh;
 const calls:string[]=[],block=new Set<string>();const stage=Object.assign(Object.create(MmdStage.prototype),{
  surprisePending:null,surprisePreview:null,bodyPreviewGeneration:0,bodyPreview:null,bodyPreviewPending:null,bodyPersonalize:null,visualPreview:null,modelGeneration:7,modelUrl:view.modelUrl,mesh,
  bodyTargetSupported:true,hostVisible:true,disposed:false,options:{transparent:false,onSurprisePreviewState:()=>{}},settings:{model:{url:view.modelUrl}},pendingModel:Promise.resolve(),
  bodyManualPose:false,bodyManualGesture:true,finalEyeClosure:0,naturalBlink:0,bodyMotion:null,chatGesturePlayer:null,
  animation:{hasLayerProperty:(channel:string,p:string)=>channel==='gesture'&&block.has(p)},
  motionTransition:{restore:()=>calls.push('transition-restore'),frame:()=>calls.push('transition-frame'),ownsProperty:(p:string)=>block.has(`transition:${p}`)},
  localPhysics:{restore:()=>calls.push('physics-restore'),frame:()=>calls.push('physics-frame')},
  bodyGates:()=>({visible:true,cameraOrWindow:false,inputBlocked:false,directContact:false}),
 }) as any;
 return {stage,mesh,bones,influences,calls,block};
}
function globals(desktop:Record<string,unknown>){const oldDocument=globalThis.document,oldWindow=globalThis.window;
 Object.assign(globalThis,{document:{hidden:false},window:{desktop}});return()=>{Object.assign(globalThis,{document:oldDocument,window:oldWindow});};}

test('actual stage method respects exact torso owner, keeps head and face, restores outer-to-inner',()=>{
 const h=setup(),restore=globals({stopSurprisePreview:async()=>{}});
 try{
  const overlay=new SurpriseOverlay(h.mesh,true,true);h.stage.surprisePreview={view,model:7,overlay,start:0,status:'playing'};
  h.block.add('.bones[上半身].quaternion');h.block.add('transition:.morphTargetInfluences[94]');
  const baseHead=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),0.2);h.bones[9].quaternion.copy(baseHead);
  h.stage.frameSurprisePreview(500);
  assert.equal(h.bones[5].quaternion.angleTo(new Quaternion()),0);assert.ok(h.bones[9].quaternion.angleTo(baseHead)>0.01);
  assert.equal(h.influences[84],0.48);assert.equal(h.influences[94],0);assert.equal(h.stage.surprisePreview.status,'partial');
  h.stage.cancelSurprisePreview(view.id);assert.deepEqual(h.calls,['physics-restore','transition-restore','transition-frame','physics-frame']);
  assert.ok(h.bones[9].quaternion.angleTo(baseHead)<1e-7);assert.equal(h.influences[84],0);assert.equal(h.stage.surprisePreview,null);
 }finally{restore();}
});

test('actual stage generation rejects a delayed host grant after cancellation',async()=>{
 const h=setup();let deliver!:(value:typeof view)=>void;const pending=new Promise<typeof view>(done=>{deliver=done;});const stopped:(string|undefined)[]=[];
 const restore=globals({beginSurprisePreview:()=>pending,stopSurprisePreview:async(id?:string)=>{stopped.push(id);},resolveSurprisePreview:async()=>{throw Error('should not resolve');}});
 try{
  const task=h.stage.previewSurprise();h.stage.cancelSurprisePreview();deliver(view);assert.equal(await task,false);
  assert.equal(h.stage.surprisePreview,null);assert.ok(stopped.includes(view.id));
 }finally{restore();}
});

test('blink attenuation is shared and a stale cancellation cannot remove a newer owner',()=>{
 const h=setup(),restore=globals({stopSurprisePreview:async()=>{}});
 try{
  h.stage.head=h.bones[9];h.stage.finalEyeClosure=0.5;
  h.stage.surprisePreview={view,model:7,overlay:new SurpriseOverlay(h.mesh,true,true),start:0,status:'playing'};
  assert.equal(h.stage.currentHeadClaim(),null,'new additive preview does not suppress automatic head input');
  h.stage.frameSurprisePreview(500);assert.equal(h.influences[94],0.275);
  h.stage.cancelSurprisePreview('older-lease');assert.equal(h.stage.surprisePreview.view.id,view.id);
  h.stage.cancelSurprisePreview(view.id);assert.equal(h.influences[94],0);
 }finally{restore();}
});

test('actual session and stage consume a host lease once and keep current base on timed end',async()=>{
 const h=setup(),settings=structuredClone(DEFAULT_SETTINGS);settings.model={path:'/synthetic-gene',url:view.modelUrl,name:'Gene'};
 const events:string[]=[];let session!:MotionPreviewSession;
 h.stage.options.onSurprisePreviewState=(state:string)=>{events.push(state);if(state==='idle')session.finishLocal();};
 const host=new SurprisePreviewHost({context:()=>({modelKey:'synthetic-context',modelUrl:view.modelUrl,visible:true}),verifyTarget:async()=>true,cancelled:(_owner,id)=>h.stage.cancelSurprisePreview(id)});
 const restore=globals({beginSurprisePreview:()=>host.begin(1),resolveSurprisePreview:(id:string,generation:number)=>host.resolve(1,id,generation),stopSurprisePreview:async(id?:string)=>host.stop(1,id)});
 session=new MotionPreviewSession({getSettings:()=>settings,load:async()=>{throw Error('must not load VMD');},apply:async()=>{throw Error('must not change base settings');},onState:()=>{}});
 try{
  assert.equal(await session.startLocal(()=>h.stage.previewSurprise(),()=>h.stage.cancelSurprisePreview()),true);
  h.stage.frameSurprisePreview(1000);h.stage.restorePersonalizeBody();
  const base=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),0.23);h.bones[9].quaternion.copy(base);
  h.stage.frameSurprisePreview(1500);assert.ok(h.bones[9].quaternion.angleTo(base)>0.01);
  h.stage.restorePersonalizeBody();h.stage.frameSurprisePreview(2800);
  assert.equal(session.state.phase,'idle');assert.equal(h.stage.surprisePreview,null);assert.ok(h.bones[9].quaternion.angleTo(base)<1e-7);
  assert.equal(settings.model!.path,'/synthetic-gene');assert.ok(events.includes('playing'));assert.ok(events.includes('idle'));
 }finally{session.dispose();restore();}
});

test('shy and surprise share a single session and lease; stale cancellation cannot stop the replacement',async()=>{
 const h=setup(),settings=structuredClone(DEFAULT_SETTINGS);settings.model={path:'/synthetic-gene',url:view.modelUrl,name:'Gene'};
 let session!:MotionPreviewSession;
 h.stage.options.onSurprisePreviewState=(state:string)=>{if(state==='idle')session.finishLocal();};
 const host=new SurprisePreviewHost({context:()=>({modelKey:'synthetic-context',modelUrl:view.modelUrl,visible:true}),verifyTarget:async()=>true,cancelled:(_owner,id)=>h.stage.cancelSurprisePreview(id)});
 const restore=globals({beginSurprisePreview:(recipe?:'shy')=>host.begin(1,recipe),resolveSurprisePreview:(id:string,generation:number)=>host.resolve(1,id,generation),stopSurprisePreview:async(id?:string)=>host.stop(1,id)});
 session=new MotionPreviewSession({getSettings:()=>settings,load:async()=>{throw Error('must not load VMD');},apply:async()=>{throw Error('must not change settings');},onState:()=>{}});
 try{
  const before=structuredClone(settings);
  assert.equal(await session.startLocal(()=>h.stage.previewSurprise(),()=>h.stage.cancelSurprisePreview()),true);
  const old=h.stage.surprisePreview.view.id;
  assert.equal(await session.startLocal(()=>h.stage.previewSurprise('shy'),()=>h.stage.cancelSurprisePreview(),'原创害羞试作'),true);
  assert.equal(h.stage.surprisePreview.view.clipId,SHY_CLIP_ID);assert.equal(session.state.name,'原创害羞试作');
  h.stage.cancelSurprisePreview(old);assert.equal(h.stage.surprisePreview.view.clipId,SHY_CLIP_ID);
  h.stage.frameSurprisePreview(1000);h.stage.restorePersonalizeBody();
  const base=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),0.23);h.bones[9].quaternion.copy(base);
  h.stage.frameSurprisePreview(1720);assert.equal(surpriseSample(720,SHY_CLIP_ID)!.head_z_degrees,-2.2);assert.ok(h.bones[9].quaternion.angleTo(base)>0.01);
  h.stage.restorePersonalizeBody();h.stage.frameSurprisePreview(2800);
  assert.equal(session.state.phase,'idle');assert.equal(h.stage.surprisePreview,null);assert.ok(h.bones[9].quaternion.angleTo(base)<1e-7);assert.deepEqual(settings,before);
 }finally{session.dispose();restore();}
});

test('shy samples are distinct, bounded and reject foreign clip identities',()=>{
 assert.notDeepEqual(surpriseSample(500,SHY_CLIP_ID),surpriseSample(500));
 assert.equal(surpriseSample(850,SHY_CLIP_ID)!.eye_wide,0);
 assert.equal(surpriseSample(900,SHY_CLIP_ID)!.torso_z_degrees,1.1);
 assert.equal(surpriseSample(1800,SHY_CLIP_ID),null);assert.equal(surpriseSample(200,'foreign'),null);
});

test('shy request refuses a surprise identity and does not take its lease or draw',async()=>{
 const h=setup(),stopped:string[]=[];
 const restore=globals({beginSurprisePreview:async()=>view,stopSurprisePreview:async(id:string)=>{stopped.push(id);},resolveSurprisePreview:async()=>{throw Error('wrong identity must not resolve');}});
 try{assert.equal(await h.stage.previewSurprise('shy'),false);assert.equal(h.stage.surprisePreview,null);assert.deepEqual(stopped,[view.id]);}
 finally{restore();}
});

test('shy uses the existing per-property gates and restores current base',()=>{
 const h=setup(),restore=globals({stopSurprisePreview:async()=>{}});
 try{
  const shy={...view,clipId:SHY_CLIP_ID,revision:1};
  const base=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),0.2);h.bones[9].quaternion.copy(base);
  h.stage.surprisePreview={view:shy,model:7,overlay:new SurpriseOverlay(h.mesh,true,true,SHY_CLIP_ID),start:0,status:'playing'};
  h.block.add('.bones[上半身].quaternion');h.block.add('transition:.morphTargetInfluences[94]');h.stage.frameSurprisePreview(900);
  assert.equal(h.bones[5].quaternion.angleTo(new Quaternion()),0);assert.equal(h.influences[94],0);
  assert.ok(h.bones[9].quaternion.angleTo(base)>0.01);assert.equal(h.stage.surprisePreview.status,'partial');
  h.stage.cancelSurprisePreview(shy.id);assert.ok(h.bones[9].quaternion.angleTo(base)<1e-7);assert.equal(h.influences[84],0);
 }finally{restore();}
});
