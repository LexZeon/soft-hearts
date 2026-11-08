import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ts from 'typescript';
import {AnimationClip,Bone,BufferGeometry,MeshBasicMaterial,NumberKeyframeTrack,QuaternionKeyframeTrack,Skeleton,SkinnedMesh} from 'three';
import {MmdStage} from '../src/stage/MmdStage';import {BehaviorMotionPlayer} from '../src/stage/behavior-motion';import {withKeyframeInterpolation} from '../src/stage/keyframe-interpolation';
import {LayeredMmdAnimation} from '../src/stage/motion-layers';import {MotionTransition,captureMotionPose} from '../src/stage/motion-transition';
import {createMoodState,getMoodSnapshot} from '../shared/mood';import {expressionStrength,type BehaviorMotionCue} from '../shared/behavior-motion';
import {BEHAVIOR_RECIPES} from '../shared/behavior-recipes';import {VISUAL_MASK,VISUAL_GENE_SHA,type VisualPreview} from '../shared/personalize-visual';
const flush=async()=>{for(let i=0;i<14;i++)await Promise.resolve();};
const raw=await readFile(new URL('../src/stage/MmdStage.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('stage.ts',raw,ts.ScriptTarget.Latest,true);
const constructors:ts.NewExpression[]=[];function visit(n:ts.Node){if(ts.isNewExpression(n)&&n.expression.getText(tree)==='BehaviorMotionPlayer')constructors.push(n);ts.forEachChild(n,visit);}visit(tree);assert.equal(constructors.length,1);
const dependencies=constructors[0].arguments![1].getText(tree);
const compiled=ts.transpileModule('return '+dependencies+';',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
// Actual Stage methods and dependency closures, real sampler/layered body mixer; synthetic mesh/clip and no WebGL/model I/O.
async function fixture(run:(f:Awaited<ReturnType<typeof make>>)=>Promise<void>){const f=await make();try{await run(f);}finally{f.dispose();}}
async function make(){
 let now=100_000;const previous={window:Object.getOwnPropertyDescriptor(globalThis,'window'),document:Object.getOwnPropertyDescriptor(globalThis,'document'),date:Date.now};
 const calls:any[][]=[],loads:any[][]=[],receipts:any[]=[];let bindWait:Promise<void>|null=null,loadWait:Promise<void>|null=null;
 const stage=Object.create(MmdStage.prototype) as any,geometry=new BufferGeometry(),material=new MeshBasicMaterial(),mesh=new SkinnedMesh(geometry,material),arm=new Bone();
  Object.assign(stage,{surprisePending:null,surprisePreview:null}); // Real constructor defaults for the inactive preview owner.
 geometry.userData.MMD={iks:[],grants:[]};arm.name='左腕';mesh.add(arm);mesh.bind(new Skeleton([arm]));
 mesh.morphTargetDictionary={'にこり':0,'笑い':1,'まばたき':2,'あ':3,'赤み':4};mesh.morphTargetInfluences=[.23,.17,.05,.11,.07];
 const animation=new LayeredMmdAnimation(mesh);animation.setClips({pose:new AnimationClip('advancing body',8,[new QuaternionKeyframeTrack('.bones[左腕].quaternion',[0,8],[0,0,0,1,0,0,Math.sin(.3),Math.cos(.3)])]),gesture:null,expression:null});
 const mixer=animation.helper.objects.get(mesh)!.mixer! as any,action=mixer._actions[0];
 const snapshot=getMoodSnapshot(createMoodState(now),now);snapshot.primary='content';snapshot.intensity.expression=50;
 Object.assign(stage,{mesh,animation,modelGeneration:4,modelUrl:'mmd-asset://synthetic-gene',settings:{model:{url:'mmd-asset://synthetic-gene'}},pendingModel:Promise.resolve(),options:{transparent:false},
  disposed:false,hostVisible:true,container:{clientWidth:400,clientHeight:560},controls:{interacting:false},visualPreview:null,moodContact:{contact:false,feeding:false,hover:0},
  moodFaceBlocked:false,behaviorBlocked:false,blinkIndex:2,mouthIndex:3,blushChannel:{index:4},finalEyeClosure:0,naturalBlink:0,
  moodView:{token:'live-token',expressions:true,snapshot,behavior:{state:null,reaction:null}},localPhysics:null,motionTransition:null});
 const resource=(id:string,binding:'face.smile'='face.smile')=>({cueId:id,bindingId:binding,packId:'gene',motionId:BEHAVIOR_RECIPES[binding].motionId,sha256:BEHAVIOR_RECIPES[binding].sha256,durationMs:BEHAVIOR_RECIPES[binding].durationMs,recipe:'emotion-face',url:'mmd-asset://synthetic-face'});
 const desktop={visualPreviewReceipt:async(r:any)=>{receipts.push(r);if(r.phase==='bind'&&bindWait)await bindWait;},
  resolveVisualPreview:async(id:string,token:string,generation:number)=>{calls.push(['visual',id,token,generation]);return resource(id);},
  resolveBehaviorMotion:async(id:string,token:string)=>{calls.push(['live',id,token]);return resource(id);}};
 Object.assign(globalThis,{window:{desktop},document:{hidden:false}});Date.now=()=>now;
 const clip=new AnimationClip('synthetic restricted + forbidden tracks',10,[0,1,2,3,4].map(i=>new NumberKeyframeTrack('.morphTargetInfluences['+i+']',[0,10],[.85,.85])).concat([new QuaternionKeyframeTrack('.bones[左腕].quaternion',[0,10],[0,0,0,1,0,0,0,1])] as any));
 class Loader{parser:unknown;loadAnimation(url:string,target:any,done:(clip:AnimationClip)=>void){loads.push([url,target]);if(loadWait)void loadWait.then(()=>done(clip));else done(clip);}}
 const deps=new Function('targetSupported','MMDLoader','createVmdParser','withKeyframeInterpolation',compiled).call(stage,true,Loader,()=>({}),withKeyframeInterpolation);
 const player=new BehaviorMotionPlayer(mesh,{...deps,now:()=>now});stage.behaviorMotion=player;
 let steps=0;const step=(delta=.1)=>{stage.motionTransition?.restore();player.restore();animation.helper.update(delta);stage.updateBehaviorMotion(true);player.frame(delta);stage.motionTransition?.frame(delta);steps++;stage.acknowledgeVisualFrame();};
 const view=(id='preview-one'):VisualPreview=>({id,token:'token-'+id,scope:'personalize-visual-controls',sessionId:'session',revision:1,materialId:'material',characterId:'card',targetModelSha:VISUAL_GENE_SHA,modelUrl:stage.modelUrl,mask:VISUAL_MASK,
  selection:{semantic:'mood.content',bindingId:'face.smile',label:'合成预览',strength:.7},cue:{id,kind:'state',bindingId:'face.smile',semantic:'mood.content',at:now,expiresAt:now+11500,strength:.7,stateKey:'preview:'+id}});
 const live=(id='accepted-live'):BehaviorMotionCue=>({id,kind:'state',bindingId:'face.smile',semantic:'mood.content',at:now,expiresAt:now+11500,strength:.34,stateKey:'live:'+id});
 const ready=async(v=view())=>{const pending=stage.previewVisual(v);await flush();step();await flush();assert.equal(await pending,true);return v;};
 return{stage,player,mesh,animation,action,mixer,resource,calls,loads,receipts,view,live,step,ready,get steps(){return steps;},advance:(ms:number)=>{now+=ms;},waitBind:(p:Promise<void>|null)=>{bindWait=p;},waitLoad:(p:Promise<void>|null)=>{loadWait=p;},
  dispose(){stage.cancelVisualPreview();player.dispose();animation.dispose();mesh.skeleton.dispose();geometry.dispose();material.dispose();Date.now=previous.date;for(const name of ['window','document'] as const){const old=previous[name];if(old)Object.defineProperty(globalThis,name,old);else Reflect.deleteProperty(globalThis,name);}}};
}
test('dedicated preview binds actual loaded generation, uses the actual controls resolver and original restricted sampler',async()=>fixture(async f=>{
 const v=await f.ready();assert.deepEqual(f.calls,[['visual',v.id,v.token,4]]);assert.deepEqual(f.receipts.map(v=>v.phase),['bind','ready']);assert.equal(f.loads[0][1],f.mesh);
 for(let i=0;i<4;i++)f.step();const state=f.player.getState().state;
 assert.deepEqual(state.propertyIndices,[0,1]);assert.ok(Math.abs(state.weight-expressionStrength(f.stage.moodView.snapshot))<1e-10);
 assert.deepEqual(f.mesh.morphTargetInfluences!.slice(2),[.05,.11,.07]);assert.equal(f.mixer._actions[0],f.action);assert.ok(Math.abs(f.action.time-f.steps*.1)<1e-8);
 f.stage.finalEyeClosure=1;f.step();assert.equal(f.mesh.morphTargetInfluences![1],.17);assert.ok(f.mesh.morphTargetInfluences![0]>.23);
}));
test('preview cancellation restores outer then inner layers between ticks, recomposes dt0, never resets body progress',async()=>fixture(async f=>{
 const v=await f.ready();for(let i=0;i<3;i++)f.step();const target=f.mesh.morphTargetInfluences![0];f.mesh.morphTargetInfluences![0]=.94;
 const from=captureMotionPose(f.mesh);f.mesh.morphTargetInfluences![0]=target;const bridge=new MotionTransition(f.mesh);bridge.start(from,['.morphTargetInfluences[0]']);f.stage.motionTransition=bridge;bridge.frame(0);f.step();
 const order:string[]=[],originalRestore=bridge.restore.bind(bridge),originalFrame=bridge.frame.bind(bridge),originalStop=f.player.stop.bind(f.player);
 bridge.restore=()=>{order.push('outer-restore');originalRestore();};bridge.frame=(dt:number)=>{order.push('outer-frame:'+dt);return originalFrame(dt);};f.player.stop=()=>{order.push('inner-stop');originalStop();};
 f.stage.localPhysics={restore:()=>order.push('physics-restore'),frame:(dt:number)=>order.push('physics-frame:'+dt)};
 const progress=bridge.getState().elapsedMs,time=f.action.time;f.stage.cancelVisualPreview(v.id,v.token);assert.deepEqual(order.slice(0,4),['physics-restore','outer-restore','inner-stop','outer-frame:0']);
 assert.equal(bridge.getState().elapsedMs,progress);assert.equal(f.action.time,time);for(let i=0;i<20;i++)f.step();assert.equal(f.mesh.morphTargetInfluences![0],.23);assert.equal(f.player.getState().active,false);
 assert.ok(Math.abs(f.action.time-f.steps*.1)<1e-8);assert.equal(f.receipts.filter(r=>r.phase==='stop').length,1);
}));
test('live cues received during preview are consumed; ending or stopping cannot replay them',async()=>fixture(async f=>{
 const v=await f.ready();f.stage.moodView.behavior={state:f.live(),reaction:{...f.live('accepted-reaction'),kind:'reaction',semantic:'cue.satisfied'}};
 f.step();f.stage.cancelVisualPreview(v.id,v.token);f.stage.updateBehaviorMotion();await flush();for(let i=0;i<6;i++)f.step();
 assert.equal(f.player.getState().active,false);assert.equal(f.calls.filter(v=>v[0]==='live').length,0);
 f.stage.moodView.behavior={state:f.live('genuinely-new'),reaction:null};f.stage.updateBehaviorMotion();await flush();f.step();assert.equal(f.calls.filter(v=>v[0]==='live').length,1);assert.equal(f.player.getState().state.id,'genuinely-new');
}));
test('natural one-shot expiry retains only host ready proof and cannot replay or reload its resource',async()=>fixture(async f=>{
 await f.ready();f.advance(11501);f.stage.updateBehaviorMotion();await flush();assert.equal(f.stage.visualPreview,null);assert.equal(f.player.getState().active,false);assert.equal(f.calls.length,1);
 assert.deepEqual(f.receipts.map(r=>r.phase),['bind','ready']);for(let i=0;i<6;i++)f.step();assert.equal(f.calls.length,1);
}));
test('wrong target, pet window, hidden scope, expression/manual/input gates cannot approve a preview',async()=>fixture(async f=>{
 for(const patch of [{scope:'foreign'},{mask:'full-expression'},{targetModelSha:'0'.repeat(64)},{modelUrl:'mmd-asset://other'}])assert.equal(await f.stage.previewVisual({...f.view(),...patch}),false);
 f.stage.options.transparent=true;assert.equal(await f.stage.previewVisual(f.view()),false);f.stage.options.transparent=false;
 f.stage.hostVisible=false;assert.equal(await f.stage.previewVisual(f.view()),false);f.stage.hostVisible=true;
 for(const key of ['moodFaceBlocked','behaviorBlocked'] as const){f.stage[key]=true;const p=f.stage.previewVisual(f.view(key));await flush();f.step();f.stage.cancelVisualPreview();assert.equal(await p,false);f.stage[key]=false;}
 f.stage.controls.interacting=true;const pending=f.stage.previewVisual(f.view('camera'));await flush();f.step();f.stage.cancelVisualPreview();assert.equal(await pending,false);f.stage.controls.interacting=false;
 f.stage.moodView.snapshot.intensity.expression=0;const zero=f.stage.previewVisual(f.view('zero'));await flush();f.step();f.stage.cancelVisualPreview();assert.equal(await zero,false);
 assert.equal(f.receipts.some(r=>r.phase==='ready'),false);
}));
test('model change, hide and exact cancellation fence a late bind/load and cannot stop a newer token',async()=>fixture(async f=>{
 let done!:()=>void;f.waitBind(new Promise<void>(r=>{done=r;}));const old=f.view('late-bind'),pending=f.stage.previewVisual(old);await flush();f.stage.cancelVisualPreview(old.id,old.token);done();assert.equal(await pending,false);f.waitBind(null);
 let loaded!:()=>void;f.waitLoad(new Promise<void>(r=>{loaded=r;}));const loading=f.view('late-load'),p=f.stage.previewVisual(loading);await flush();f.stage.modelGeneration++;f.stage.updateBehaviorMotion();loaded();await flush();assert.equal(await p,false);assert.equal(f.player.getState().active,false);f.waitLoad(null);
 const next=await f.ready(f.view('newer'));f.stage.cancelVisualPreview(old.id,old.token);assert.equal(f.stage.visualPreview.value.id,next.id);
 f.stage.hostVisible=false;f.stage.updateBehaviorMotion();assert.equal(f.player.getState().active,false);f.stage.cancelVisualPreview();assert.equal(f.receipts.filter(r=>r.id===next.id&&r.phase==='stop').length,1);
}));
