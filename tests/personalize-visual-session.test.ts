import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {PersonalizeVisualAuthoring} from '../electron/personalize-visual-authoring';
import {VisualBehaviorStore} from '../electron/visual-behavior-store';import {atomicWriteFile} from '../electron/atomic-file';
import {withCodexImages} from '../electron/codex-images';import {BEHAVIOR_RECIPES} from '../shared/behavior-recipes';
import {VISUAL_PURPOSE,VISUAL_GENE_SHA,VISUAL_MATERIAL_TTL,emptyVisualBehavior,type VisualAuthoringState} from '../shared/personalize-visual';
import type {SelectedVisualImage} from '../electron/selected-visual-image';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
const study=()=>({observations:[{region:'eyebrow',visibility:'visible',description:'合成参考眉毛略向上'}],inferences:[{label:'可能是好奇',rationale:'仅合成接口样例',unknown:'不能推断真实情绪'}],questions:['这是好奇还是惊讶？'],insufficient:'单张静图不含动态过程'});
const selection={semantic:'mood.content',bindingId:'face.smile',label:'用户自选的合成眉眼',strength:0.34} as const;
async function fixture(run:(f:Awaited<ReturnType<typeof make>>)=>Promise<void>){const f=await make();try{await run(f);}finally{await f.close();}}
async function make(){
 const directory=await mkdtemp(path.join(os.tmpdir(),'soft-visual-session-')),a=randomUUID(),b=randomUUID();
 let card:string=a,context='one',codex=true,support=true,target=true,time=10_000,fail=false,busy=false,gate:ReturnType<typeof deferred>|null=null;
 let answer=JSON.stringify(study()),verifyGate:ReturnType<typeof deferred>|null=null,copies=false,lease:AbortController|null=null;
 const gates:ReturnType<typeof deferred>[]=[],start=deferred(),images:SelectedVisualImage[]=[],released:SelectedVisualImage[]=[],changed:string[]=[],cancelled:{owner:number;id:string;token:string}[]=[];
 const calls:{prompt:string;image:string;signal:AbortSignal}[]=[],files:string[]=[];
 const store=new VisualBehaviorStore(directory,()=>[a,b],async(file,data)=>{if(fail)throw Error('SYNTHETIC_PRIVATE_DISK_DETAIL');await atomicWriteFile(file,data);});await store.load();
 const jpeg=Buffer.alloc(32);jpeg.set([255,216,255,192,0,17,8,0,16,0,16]);jpeg[30]=255;jpeg[31]=217;
 const data='data:image/jpeg;base64,'+jpeg.toString('base64'),sha=createHash('sha256').update(jpeg).digest('hex');
 const service=new PersonalizeVisualAuthoring(store,{
  context:()=>({characterId:card,identity:context,codex,imageSupported:support,connectionLabel:'Claude · synthetic-no-discovery',modelUrl:'mmd-asset://synthetic-model'}),
  verifyTarget:async()=>{const current=verifyGate;if(current)await current.promise;return target;},now:()=>time,
  chooseImage:async signal=>{signal.throwIfAborted();const image:SelectedVisualImage={dataUrl:data,sha256:sha,width:16,height:16,previewDataUrl:data,
    release:()=>{released.push(image);image.dataUrl='';image.previewDataUrl='';image.sha256='';}};images.push(image);return image;},
  reserve:(_owner,_id,controller)=>{if(busy||lease)throw Error('合成已有对话正忙');lease=controller;return()=>{assert.equal(lease,controller);lease=null;};},
  stream:async(prompt,image,signal,append)=>{calls.push({prompt,image,signal});const wait=gate,output=answer;
    const operation=async(paths:string[])=>{files.push(...paths);start.resolve();if(wait)await wait.promise;append(output);};
    if(copies)await withCodexImages([image],path.join(directory,'selected-image-authoring'),signal,operation);else await operation([]);
  },
  resolvePreview:async view=>{const recipe=BEHAVIOR_RECIPES[view.selection.bindingId];return{cueId:view.id,bindingId:view.selection.bindingId,packId:'gene',
    motionId:recipe.motionId as any,sha256:recipe.sha256,durationMs:recipe.durationMs,url:'mmd-asset://synthetic-reviewed-face',recipe:'emotion-face'};},
  previewCancelled:(owner,id,token)=>cancelled.push({owner,id,token}),changed:id=>changed.push(id),
 });
 const open=(owner=7)=>service.get(owner,card);
 const choose=async(owner=7)=>{const state=await open(owner);return service.choose(owner,state.id,state.revision);};
 const request=(s:VisualAuthoringState,extra:Record<string,unknown>={})=>({sessionId:s.id,revision:s.revision,materialId:s.material!.id,submitNonce:s.submitNonce!,purpose:VISUAL_PURPOSE,refinement:'',...extra});
 const ready=async(s:VisualAuthoringState,owner=7)=>{const view=await service.preview(owner,s.id,s.revision,selection);
  service.receipt(owner,{phase:'bind',id:view.id,token:view.token,stageGeneration:2});
  await service.resolvePreview(owner,view.id,view.token,2);service.receipt(owner,{phase:'ready',id:view.id,token:view.token,stageGeneration:2});return view;};
 const f={directory,a,b,store,service,open,choose,request,ready,images,released,calls,files,changed,cancelled,data,sha,started:start.promise,
  context:(value:string)=>{context=value;},card:(value:string)=>{card=value;context=value;},provider:(value:boolean)=>{codex=value;},support:(value:boolean)=>{support=value;},target:(value:boolean)=>{target=value;},
  busy:(value:boolean)=>{busy=value;},fail:(value:boolean)=>{fail=value;},answer:(value:string)=>{answer=value;},copies:(value:boolean)=>{copies=value;},
  gate:()=>{gate=deferred();gates.push(gate);return gate;},verifyGate:(value:ReturnType<typeof deferred>|null)=>{verifyGate=value;},advance:(value:number)=>{time+=value;},get lease(){return lease;},
  close:async()=>{service.invalidate();for(const g of gates)g.resolve();if(verifyGate)verifyGate.resolve();await Promise.resolve();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('soft-visual-session-'));await rm(directory,{recursive:true,force:true});},
 };return f;
}
test('choose is local only; each explicit exact image consent is consumed once and refinement gets a fresh nonce',async()=>fixture(async f=>{
 let state=await f.choose();assert.equal(f.calls.length,0);assert.equal(f.changed.length,0);assert.equal(state.material?.source,'selected-image');assert.ok(!Object.hasOwn(state.material!,'sha256'));
 assert.ok(!Object.hasOwn(state.material!,'dataUrl'));assert.equal(state.choices.some(c=>c.semantic==='mood.content'&&c.bindingId==='face.convinced'),false);
 const before=state;state=await f.service.research(7,f.request(before));assert.equal(f.calls.length,1);assert.equal(f.calls[0].image,f.data);
 assert.ok(state.submitNonce&&state.submitNonce!==before.submitNonce);assert.equal(state.study?.questions.length,1);assert.equal(f.changed.length,0);
 await assert.rejects(f.service.research(7,f.request(before)));await assert.rejects(f.service.research(7,f.request(state,{submitNonce:before.submitNonce})));assert.equal(f.calls.length,1);
 state=await f.service.research(7,f.request(state,{refinement:'用户解释：这是好奇，不是惊讶'}));assert.equal(f.calls.length,2);assert.ok(f.calls[1].prompt.includes('用户解释'));assert.equal(f.changed.length,0);
 assert.deepEqual(f.store.get(f.a).profile,emptyVisualBehavior());assert.ok(!JSON.stringify(state.saved).includes(f.sha));
}));
test('purpose, owner, material, unsupported image connection and occupied chat deny before transport',async()=>fixture(async f=>{
 const s=await f.choose();await assert.rejects(f.service.research(8,f.request(s)));await assert.rejects(f.service.research(7,f.request(s,{purpose:'camera'})));
 await assert.rejects(f.service.research(7,f.request(s,{materialId:randomUUID()})));
 f.support(false);await assert.rejects(f.service.research(7,f.request(s)));f.support(true);f.provider(false);await assert.rejects(f.service.research(7,f.request(s)));f.provider(true);
 f.busy(true);await assert.rejects(f.service.research(7,f.request(s)),/正忙/);assert.equal(f.calls.length,0);assert.equal(f.lease,null);
 f.busy(false);await f.service.research(7,f.request(s));assert.equal(f.calls.length,1);
}));
test('exact provider copy survives cancellation only until its actual request settles; a newer material is not cleaned',async()=>fixture(async f=>{
 f.copies(true);const s=await f.choose(),gate=f.gate(),run=f.service.research(7,f.request(s));await f.started;
 assert.equal(f.files.length,1);assert.equal(createHash('sha256').update(await readFile(f.files[0])).digest('hex'),f.sha);
 f.service.close(7,s.id);assert.equal(f.calls[0].signal.aborted,true);assert.ok(f.lease);assert.equal(f.released.length,1);await stat(f.files[0]);
 const next=await f.choose();assert.notEqual(next.id,s.id);assert.ok(next.material);await assert.rejects(f.service.research(7,f.request(next)),/正忙/);
 gate.resolve();await assert.rejects(run);await assert.rejects(stat(f.files[0]),/ENOENT/);assert.equal(f.lease,null);
 const current=await f.open();assert.equal(current.material?.id,next.material?.id);assert.equal(f.released.length,1);
 f.service.close(7,s.id);assert.equal((await f.open()).material?.id,next.material?.id);
}));
test('card, model/provider context, explicit cancellation and TTL fence all late candidate data',async()=>fixture(async f=>{
 const s=await f.choose(),gate=f.gate(),run=f.service.research(7,f.request(s));await f.started;
 f.context('new-model-or-provider');gate.resolve();await assert.rejects(run);assert.equal(f.changed.length,0);assert.equal(f.lease,null);
 const next=await f.choose();f.service.close(8,next.id);assert.ok((await f.open()).material);f.advance(VISUAL_MATERIAL_TTL+1);
 const fresh=await f.open();assert.equal(fresh.material,null);assert.equal(fresh.study,null);assert.equal(fresh.submitNonce,null);
 f.card(f.b);const b=await f.open();assert.equal(b.characterId,f.b);assert.equal(b.material,null);assert.deepEqual(f.store.get(f.b).profile,emptyVisualBehavior());
}));
test('malformed, oversized, executable/capability output is rejected without logging provider payload',async()=>fixture(async f=>{
 for(const raw of ['bad',JSON.stringify({...study(),bindingId:'face.smile'}),JSON.stringify({...study(),questions:Array(4).fill('too many')}),JSON.stringify({...study(),insufficient:'<script>run()</script>'}),JSON.stringify({...study(),insufficient:'https://not-authorized.invalid'}),'x'.repeat(10_001)]){
  const s=await f.choose();f.answer(raw);await assert.rejects(f.service.research(7,f.request(s)),error=>{assert.ok(error instanceof Error);assert.ok(!error.message.includes(raw));return true;});
  assert.equal(f.lease,null);assert.equal(f.changed.length,0);assert.equal(f.store.get(f.a).revision,0);
 }
}));
test('unknown target remains study-only; no forced smile or fake preview/enable',async()=>fixture(async f=>{
 f.target(false);let s=await f.choose();assert.equal(s.targetSupported,false);assert.deepEqual(s.choices,[]);
 s=await f.service.research(7,f.request(s));assert.ok(s.study);await assert.rejects(f.service.preview(7,s.id,s.revision,selection));
 assert.equal(f.store.get(f.a).profile.enabled,false);assert.equal(f.changed.length,0);
}));
test('same mask selection requires exact owner, stage bind, resource and ready receipt before explicit save',async()=>fixture(async f=>{
 const s=await f.choose(),p=await f.service.preview(7,s.id,s.revision,selection);
 const save={sessionId:s.id,revision:p.revision,savedRevision:s.savedRevision,previewId:p.id,previewToken:p.token};
 await assert.rejects(f.service.save(7,save));await assert.rejects(f.service.resolvePreview(8,p.id,p.token,2));await assert.rejects(f.service.resolvePreview(7,p.id,p.token,2));
 assert.throws(()=>f.service.receipt(7,{phase:'ready',id:p.id,token:p.token,stageGeneration:2}));
 f.service.receipt(7,{phase:'bind',id:p.id,token:p.token,stageGeneration:2});await assert.rejects(f.service.resolvePreview(7,p.id,p.token,3));
 const resource=await f.service.resolvePreview(7,p.id,p.token,2);assert.equal(resource.sha256,BEHAVIOR_RECIPES['face.smile'].sha256);
 f.service.receipt(7,{phase:'ready',id:p.id,token:p.token,stageGeneration:2});f.advance(12_000);
 await assert.rejects(f.service.resolvePreview(7,p.id,p.token,2)); // No expired cue replay.
 const saved=await f.service.save(7,save);assert.equal(saved.saved.profile.enabled,true);assert.equal(saved.saved.profile.targetModelSha,VISUAL_GENE_SHA);
 const bytes=await readFile(path.join(f.directory,'personalize-visual.json'),'utf8');assert.ok(!bytes.includes('base64'));assert.ok(!bytes.includes(f.sha));assert.ok(!bytes.includes('observations'));assert.deepEqual(f.changed,[f.a]);
 const disabled=await f.service.change(7,{sessionId:saved.id,revision:saved.revision,kind:'disable'});assert.equal(disabled.saved.profile.enabled,false);
 const undo=await f.service.change(7,{sessionId:disabled.id,revision:disabled.revision,kind:'undo'});assert.equal(undo.saved.profile.enabled,true);assert.equal(undo.saved.previous,undefined);
}));
test('stopped, foreign, edited or context-replaced preview proof cannot save or cancel a newer preview',async()=>fixture(async f=>{
 const s=await f.choose(),old=await f.ready(s);f.service.receipt(7,{phase:'stop',id:old.id,token:old.token,stageGeneration:0});
 await assert.rejects(f.service.save(7,{sessionId:s.id,revision:old.revision,savedRevision:s.savedRevision,previewId:old.id,previewToken:old.token}));
 const current=await f.open(),next=await f.ready(current);f.service.receipt(7,{phase:'stop',id:old.id,token:old.token,stageGeneration:0});
 assert.ok(f.cancelled.every(row=>row.id!==next.id));f.context('changed-before-save');
 await assert.rejects(f.service.save(7,{sessionId:s.id,revision:next.revision,savedRevision:0,previewId:next.id,previewToken:next.token}));assert.equal(f.store.get(f.a).revision,0);
}));
test('failed atomic confirmation retains same-card recipe and proof for explicit same-ID retry; no disk error leak',async()=>fixture(async f=>{
 const s=await f.choose(),p=await f.ready(s),request={sessionId:s.id,revision:p.revision,savedRevision:0,previewId:p.id,previewToken:p.token};
 f.fail(true);await assert.rejects(f.service.save(7,request),error=>{assert.ok(error instanceof Error);assert.ok(!error.message.includes('SYNTHETIC_PRIVATE_DISK_DETAIL'));return true;});
 assert.equal(f.store.get(f.a).revision,0);f.fail(false);const saved=await f.service.save(7,request);assert.equal(saved.saved.revision,1);assert.equal(saved.saved.profile.label,selection.label);
 assert.equal(f.store.get(f.b).revision,0);assert.equal(f.changed.length,1);
}));
