import test from 'node:test';import assert from 'node:assert/strict';
import { Bone,BufferGeometry,MeshBasicMaterial,Quaternion,Skeleton,SkinnedMesh,Vector3 } from 'three';
import { MmdStage } from '../src/stage/MmdStage';
import { VISUAL_GENE_SHA } from '../shared/personalize-visual';
import type { BodyPoseBinding,BodyPosePreview } from '../shared/personalize-body';
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
async function fixture(run:(f:ReturnType<typeof make>)=>Promise<void>){const f=make();try{await run(f);}finally{f.dispose();}}
function make(){
 const previous={window:Object.getOwnPropertyDescriptor(globalThis,'window'),document:Object.getOwnPropertyDescriptor(globalThis,'document'),date:Date.now};
 let now=100000,wait:Promise<void>|null=null;const receipts:any[]=[],order:string[]=[];
 const geometry=new BufferGeometry(),material=new MeshBasicMaterial(),mesh=new SkinnedMesh(geometry,material),root=new Bone(),arm=new Bone(),face=new Bone();
 root.name='root';arm.name='arm';face.name='face';mesh.add(root);root.add(arm,face);mesh.bind(new Skeleton([root,arm,face]));
 const rest=mesh.skeleton.bones.map(bone=>({bone,quaternion:bone.quaternion.clone()}));
 const binding:BodyPoseBinding={id:'body.test',label:'test',targetModelSha:VISUAL_GENE_SHA,sourceSha:'a'.repeat(64),mask:'arm-rotation',qualifiedStrength:.5,
  properties:[{boneIndex:1,boneName:'arm',quaternion:[0,0,Math.sin(.2),Math.cos(.2)]}]};
 const gate={visible:true,enabled:true,manualPose:false,manualGesture:false,dynamicPose:false,cameraOrWindow:false,inputBlocked:false,directContact:false,music:false,chatGesture:false};
 const stage=Object.assign(Object.create(MmdStage.prototype),{mesh,restPose:rest,bodyTargetSupported:true,bodyPreview:null,bodyPreviewPending:null,bodyPreviewGeneration:0,
  bodyPersonalize:null,bodyPersonalizeConsumed:new Set(),bodyMotion:null,animation:{},modelGeneration:4,modelUrl:'mmd-asset://model',
  settings:{model:{url:'mmd-asset://model'}},pendingModel:Promise.resolve(),options:{transparent:false},disposed:false,hostVisible:true,
  bodyGates:()=>gate,localPhysics:{restore:()=>order.push('physics-restore'),frame:(dt:number)=>order.push('physics-frame:'+dt)},
  motionTransition:{restore:()=>order.push('outer-restore'),frame:(dt:number)=>order.push('outer-frame:'+dt)}}) as any;
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
 const desktop={bodyPreviewReceipt:async(value:any)=>{receipts.push(value);if(value.phase==='bind'&&wait)await wait;},
  resolveBodyPreview:async()=>structuredClone(binding)};
 Object.assign(globalThis,{window:{desktop},document:{hidden:false}});Date.now=()=>now;
 const view=(id='test'):BodyPosePreview=>({id,token:'token-'+id,sessionId:'session',revision:1,materialId:'material',sourceKind:'selected-image',characterId:'card',
  targetModelSha:VISUAL_GENE_SHA,modelUrl:'mmd-asset://model',bindingId:binding.id,sourceSha:binding.sourceSha,mask:binding.mask,strength:.5,expiresAt:now+11500});
 let elapsed=0;const step=()=>{stage.localPhysics.restore();stage.motionTransition.restore();stage.restorePersonalizeBody();elapsed+=.1;
  arm.quaternion.setFromAxisAngle(new Vector3(1,0,0),elapsed);stage.frameBodyPreview();stage.framePersonalizeBody();stage.motionTransition.frame(.1);stage.acknowledgeBodyFrame();};
 return {stage,mesh,arm,face,rest,binding,gate,receipts,order,view,step,get elapsed(){return elapsed;},waitBind:(p:Promise<void>|null)=>{wait=p;},
  dispose:()=>{stage.cancelBodyPreview();stage.cancelPersonalizeBody();mesh.skeleton.dispose();geometry.dispose();material.dispose();Date.now=previous.date;
   for(const key of ['window','document'] as const){const old=previous[key];if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);}}};
}
test('preview uses actual host-resolved binding and acknowledges only after a frame; cancellation restores without advancing base',async()=>fixture(async f=>{
 const face=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),.3);f.face.quaternion.copy(face);
 const v=f.view(),pending=f.stage.previewBody(v);await flush();assert.deepEqual(f.receipts.map(v=>v.phase),['bind']);
 f.step();await flush();assert.equal(await pending,true);assert.deepEqual(f.receipts.map(v=>v.phase),['bind','ready']);
 assert.ok(f.face.quaternion.angleTo(face)<1e-7);const elapsed=f.elapsed;f.order.length=0;f.stage.cancelBodyPreview(v.id,v.token);
 assert.deepEqual(f.order.slice(0,2),['physics-restore','outer-restore']);assert.equal(f.elapsed,elapsed);
 assert.ok(f.arm.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),elapsed))<1e-7);
}));
test('exact cancellation fences late binding; foreign cancellation cannot retire a new preview',async()=>fixture(async f=>{
 let done!:()=>void;f.waitBind(new Promise<void>(resolve=>{done=resolve;}));const old=f.view('old'),pending=f.stage.previewBody(old);await flush();
 f.stage.cancelBodyPreview(old.id,old.token);done();assert.equal(await pending,false);f.waitBind(null);
 const next=f.view('next'),nextPending=f.stage.previewBody(next);await flush();f.stage.cancelBodyPreview(old.id,old.token);f.step();await flush();
 assert.equal(await nextPending,true);assert.equal(f.stage.bodyPreview.value.id,next.id);
}));
test('manual pose gate prevents preview acceptance and a consumed live cue cannot replay after the gate clears',async()=>fixture(async f=>{
 f.gate.manualPose=true;const v=f.view(),pending=f.stage.previewBody(v);await flush();f.step();f.stage.cancelBodyPreview();assert.equal(await pending,false);
 f.stage.options.transparent=true;const cue={cueId:'accepted',expiresAt:110000,strength:.5,modelUrl:v.modelUrl,binding:f.binding};
 const view={token:'scope',expressions:true,bodyPose:cue};f.stage.updatePersonalizeBody(view);assert.equal(f.stage.bodyPersonalize,null);
 f.gate.manualPose=false;f.stage.updatePersonalizeBody(view);assert.equal(f.stage.bodyPersonalize,null);
}));
test('saved cue uses the same bind-relative properties and strength as preview and yields without replay',async()=>fixture(async f=>{
 const p=f.view(),pending=f.stage.previewBody(p);await flush();f.step();await flush();assert.equal(await pending,true);
 const offset=new Quaternion().fromArray([...f.binding.properties[0].quaternion]),expectedPreview=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),f.elapsed).slerp(offset,p.strength);
 assert.ok(f.arm.quaternion.angleTo(expectedPreview)<1e-7);f.stage.cancelBodyPreview(p.id,p.token);
 f.stage.options.transparent=true;const cue={cueId:'new-cue',expiresAt:110000,strength:p.strength,modelUrl:p.modelUrl,binding:f.binding};
 const view={token:'scope',expressions:true,bodyPose:cue};f.stage.updatePersonalizeBody(view);assert.ok(f.stage.bodyPersonalize);
 f.step();const expectedLive=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),f.elapsed).slerp(offset,p.strength);
 assert.ok(f.arm.quaternion.angleTo(expectedLive)<1e-7);f.gate.manualPose=true;f.step();assert.equal(f.stage.bodyPersonalize,null);
 f.gate.manualPose=false;f.stage.updatePersonalizeBody(view);assert.equal(f.stage.bodyPersonalize,null);
}));
