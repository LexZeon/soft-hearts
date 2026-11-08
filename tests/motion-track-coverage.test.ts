import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {MotionTrackCoverageHost,motionTrackFacts,bindMotionTrackStructure,parseMotionTrackCoverageRequest} from '../electron/motion-track-coverage';
import {matchesMotionTrackFilter,type MotionTrackCoverage} from '../shared/motion-track-coverage';
import type {MotionCatalog,CatalogMotion} from '../shared/motion-library';
import {stripDefaultVmdTracks,type VmdTrackData} from '../src/stage/vmd-tracks';
import gene from '../shared/motion-track-gene-structure.json';

const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fixture(parse?: (bytes:Uint8Array)=>ReturnType<typeof parsed>){
  const bytes=new Uint8Array([1,2,3]),catalog:MotionCatalog={schemaVersion:1,packs:[{id:'gene',name:'Synthetic',source:'synthetic',sourceUrl:'',revision:'f'.repeat(40),license:{id:'synthetic',url:'',attribution:''},documents:[],motions:['first','second'].map(id=>({id,name:id,category:'gesture',tags:['right-arm'],relativePath:id+'.vmd',originalPath:id,downloadUrl:'',sha256:sha(bytes),bytes:3,durationFrames:60,boneFrames:1,morphFrames:1}))}]};
  let context:string|null='current',model:string|null=gene.modelSha256,body=bytes,reads=0,parses=0,resolves=0;
  const host=new MotionTrackCoverageHost({catalog,context:sender=>sender===7?context:null,modelIdentity:async()=>model,
    resolve:async()=>{resolves++;return'host-owned-local-only';},read:async()=>{reads++;return body;},parse:data=>{parses++;return(parse??parsed)(data);}});
  return{host,catalog,bytes,request:{assets:[{packId:'gene' as const,motionId:'first'}]},
    context:(next:string|null)=>{context=next;},model:(next:string|null)=>{model=next;},tamper:()=>{body=new Uint8Array([4,5,6]);},counts:()=>({reads,parses,resolves})};
}
function data():VmdTrackData{return{metadata:{motionCount:5,morphCount:3},motions:[
  {boneName:'default',frameNum:0,position:[0,0,0],rotation:[0,0,0,1]},
  {boneName:'右腕',frameNum:0,position:[0,0,0],rotation:[0,0,0.2,Math.sqrt(.96)]},
  {boneName:'右腕',frameNum:60,position:[0,0,0],rotation:[0,0,0.2,Math.sqrt(.96)]},
  {boneName:'頭',frameNum:0,position:[0,1,0],rotation:[0,0,0,1]},
  {boneName:'頭',frameNum:60,position:[0,2,0],rotation:[0,0,0,1]}],morphs:[
  {morphName:'zero',frameNum:0,weight:0},{morphName:'あ',frameNum:0,weight:.4},{morphName:'あ',frameNum:60,weight:.4}]};}
function parsed(_bytes?:Uint8Array){const result=stripDefaultVmdTracks(data());return{data:result.vmd,report:result.report};}

test('request schema accepts only one or two fixed catalog IDs without getters/proxies/paths/model authority',async()=>{
  const f=fixture();assert.deepEqual(parseMotionTrackCoverageRequest(f.request),f.request);
  for(const input of [{assets:[]},{assets:[...f.request.assets,...f.request.assets,...f.request.assets]},
    {assets:[{packId:'gene',motionId:'first',path:'private.pmx'}]}, {assets:f.request.assets,modelSha256:gene.modelSha256},
    {get assets(){throw Error('getter invoked');}},new Proxy(f.request,{get(){throw Error('proxy invoked');}})])assert.throws(()=>parseMotionTrackCoverageRequest(input));
  await assert.rejects(f.host.read(8,f.request));assert.equal(f.counts().reads,0);
  await assert.rejects(f.host.read(7,{assets:[{packId:'gene',motionId:'not-installed'}]}));assert.equal(f.counts().reads,0);
});

test('actual cleanup retains nondefault static occupancy, both property channels and original duration; raw facts never infer anatomy',()=>{
  const original=data(),before=structuredClone(original),result=stripDefaultVmdTracks(original),rows=motionTrackFacts(result.vmd);
  assert.deepEqual(original,before);assert.equal(result.report.durationFrames,60);assert.equal(result.report.removedBoneNames.length,1);assert.equal(result.report.removedMorphNames.length,1);
  assert.equal(rows.find(r=>r.target==='右腕'&&r.kind==='quaternion')?.state,'static-nondefault');assert.equal(rows.find(r=>r.target==='右腕'&&r.kind==='position')?.state,'static-default');
  assert.equal(rows.find(r=>r.target==='頭'&&r.kind==='position')?.state,'dynamic');assert.equal(rows.find(r=>r.target==='あ')?.state,'static-nondefault');assert.ok(rows.every(r=>r.part===null&&r.modelIndex===null));
});

test('pinned public Gene structural binding enables actual right-arm filtering; wrong content and unknown morph anatomy stay unknown',async()=>{
  const f=fixture(),view=await f.host.read(7,f.request),fact=view.assets[0];assert.equal(fact.modelMapping,'verified-public-gene');
  const arm=fact.properties.find(p=>p.target==='右腕'&&p.kind==='quaternion')!;assert.equal(arm.part,'right-arm');assert.equal(arm.modelIndex,27);
  assert.equal(matchesMotionTrackFilter(fact,{kind:'part',part:'right-arm'}),true);assert.equal(matchesMotionTrackFilter(fact,{kind:'part',part:'mouth'}),false);
  assert.equal(fact.properties.find(p=>p.target==='あ')?.part,null);
  const unbound=bindMotionTrackStructure(fact,'a'.repeat(64));assert.equal(unbound.modelMapping,'unknown');assert.ok(unbound.properties.every(p=>p.modelIndex===null&&p.part===null));
  assert.equal(matchesMotionTrackFilter(unbound,{kind:'part',part:'right-arm'}),false);assert.equal(matchesMotionTrackFilter(unbound,{kind:'target',channel:'bone',target:'右腕'}),true);
  assert.ok(gene.bones.find(b=>b.index===27)!.directWeightedVertices>0);assert.equal(gene.bones.find(b=>b.index===27)!.parentIndex,26);assert.ok(gene.bones.some(b=>b.grant));assert.ok(gene.bones.some(b=>b.ik));
});

test('host rechecks installed bytes on cache hit; changing model changes binding without reparsing or downloading',async()=>{
  const f=fixture();const first=await f.host.read(7,f.request);f.model(null);const unknown=await f.host.read(7,f.request);assert.equal(unknown.assets[0].modelMapping,'unknown');assert.notEqual(unknown.contextId,first.contextId,'Actual content-verifier result participates in opaque binding context');
  assert.deepEqual(f.counts(),{reads:2,parses:1,resolves:2});f.tamper();await assert.rejects(f.host.read(7,f.request));assert.equal(f.counts().parses,1);
});

test('two-source overlap is exact-property evidence; no direct overlap never becomes hierarchy/IK or combination approval',async()=>{
  const f=fixture();const view=await f.host.read(7,{assets:[{packId:'gene',motionId:'first'},{packId:'gene',motionId:'second'}]});
  assert.equal(view.directOverlap.length,5);assert.ok(view.modelOverlap.some(p=>p.modelIndex===27));assert.equal(view.hierarchy,'unknown');assert.equal(view.ik,'unknown');assert.equal(view.combination,'not-validated');assert.equal(view.recordedRelations.status,'recorded-public-gene');
  assert.ok(view.recordedRelations.unresolvedProperties.every(count=>count>0),'Unmapped targets/morphs are not silently covered by bone relations');
  const no=fixture(()=>({data:{metadata:{motionCount:0,morphCount:0},motions:[],morphs:[]},report:parsed().report}));
  const empty=await no.host.read(7,{assets:[{packId:'gene',motionId:'first'},{packId:'gene',motionId:'second'}]});assert.deepEqual(empty.directOverlap,[]);assert.equal(empty.combination,'not-validated');
});

test('context loss during async model verification or asset resolution cancels response; concurrent work stays bounded',async()=>{
  let release!:()=>void;const gate=new Promise<void>(yes=>release=yes),f=fixture();const catalog=f.catalog;
  let context:string|null='before';const host=new MotionTrackCoverageHost({catalog,context:()=>context,modelIdentity:async()=>{await gate;return gene.modelSha256;},resolve:async()=>'',read:async()=>f.bytes,parse:parsed});
  const a=host.read(7,f.request),b=host.read(7,f.request);await assert.rejects(host.read(7,f.request),/仍在进行/);context='after';release();await assert.rejects(a,/变化/);await assert.rejects(b,/变化/);
  let resume!:()=>void;const wait=new Promise<void>(yes=>resume=yes);context='same';const next=new MotionTrackCoverageHost({catalog,context:()=>context,resolve:async()=>{await wait;return'';},read:async()=>f.bytes,parse:parsed});
  const read=next.read(7,f.request);await Promise.resolve();context=null;resume();await assert.rejects(read,/变化/);
});

test('same Stage parser is exercised with a synthetic in-memory VMD and never mutates original bytes',async()=>{
  const frame=15+4+12+16+64,bytes=Buffer.alloc(30+20+4+frame+5*4);bytes.write('Vocaloid Motion Data 0002');bytes.writeUInt32LE(1,50);
  Buffer.from([0x83,0x5a,0x83,0x93,0x83,0x5e,0x81,0x5b]).copy(bytes,54);bytes.writeFloatLE(.25,54+15+4+4);bytes.writeFloatLE(1,54+15+4+12+12);
  const original=Buffer.from(bytes),f=fixture();const motion=f.catalog.packs[0].motions[0];motion.bytes=bytes.length;motion.sha256=sha(bytes);
  const host=new MotionTrackCoverageHost({catalog:f.catalog,context:()=> 'synthetic',resolve:async()=> 'owned-synthetic-only',read:async()=>bytes});
  const view=await host.read(7,f.request);assert.equal(view.assets[0].properties.find(p=>p.target==='センター'&&p.kind==='position')?.state,'static-nondefault');assert.ok(bytes.equals(original));
});

test('actual scoped Main and typed preload caller reject foreign owners/subframes/extra args and use only fixed coverage request',()=>{
  const source=fs.readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),nodes:ts.Node[]=[];
  const visit=(n:ts.Node)=>{nodes.push(n);ts.forEachChild(n,visit);};visit(ast);
  const helper=nodes.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='scopedHost')!;
  const call=nodes.find(n=>ts.isCallExpression(n)&&n.expression.getText(ast)==='scopedHost'&&n.arguments[0].getText(ast)==="'motionTrackCoverageRead'")!;
  const methods=new Map<string,Function>(),requests:unknown[][]=[],controls={webContents:{id:7}},pet={webContents:{id:8}};
  const ctx={controls,windows:()=>[controls,pet],ipcMain:{handle:(id:string,handler:Function)=>methods.set(id,handler)},motionTrackCoverage:{read:(...args:unknown[])=>{requests.push(args);return'read';}}};
  vm.runInNewContext(ts.transpileModule(helper.getText(ast)+'\n'+call.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  const frame={},event=(id:number,sub=false)=>({sender:{id,mainFrame:frame},senderFrame:sub?{}:frame}),request=fixture().request,read=methods.get('desk:motionTrackCoverageRead')!;
  assert.throws(()=>read(event(8),request));assert.throws(()=>read(event(7,true),request));assert.throws(()=>read(event(7),request,'extra'));assert.equal(requests.length,0);assert.equal(read(event(7),request),'read');assert.equal(requests[0][1],request);
  const preload=fs.readFileSync(new URL('../electron/preload.ts',import.meta.url),'utf8');let api:any;const calls:unknown[][]=[];
  vm.runInNewContext(ts.transpileModule(preload,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:{},process:{platform:'win32'},require:(name:string)=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(_name:string,value:unknown)=>{api=value;}},ipcRenderer:{invoke:(...args:unknown[])=>{calls.push(args);return Promise.resolve();}}};}});
  api.motionTrackCoverageRead(request);assert.equal(calls[0][0],'desk:motionTrackCoverageRead');assert.equal(calls[0][1],request);assert.equal(calls[0].length,2);
});

test('actual Main factory reuses existing host model verifier and invalidates after its async generation changes',async()=>{
  const source=fs.readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),found:ts.Node[]=[];
  const visit=(n:ts.Node)=>{if(ts.isNewExpression(n)&&n.expression.getText(ast)==='MotionTrackCoverageHost')found.push(n);ts.forEachChild(n,visit);};visit(ast);assert.equal(found.length,1);
  const f=fixture();let release!:(sha:string)=>void;const paths:string[]=[],controls={isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,webContents:{id:7}};
  class ActualHost extends MotionTrackCoverageHost{constructor(ports:any){super({...ports,read:async()=>f.bytes,parse:parsed});}}
  const ctx:any=vm.createContext({MotionTrackCoverageHost:ActualHost,motionTrackCoverageCatalog:f.catalog,controls,
    companionCommandContext:()=> 'actual-opaque-context',bodyModelGeneration:0,store:{current:{model:{path:'owned-synthetic-model'}}},
    blushCalibrations:{keyForModel:(path:string)=>{paths.push(path);return new Promise<string>(yes=>release=yes);}},motionLibrary:{resolvePreview:async()=> 'owned-synthetic-motion'}});
  const host=vm.runInContext(ts.transpileModule('('+found[0].getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx)as MotionTrackCoverageHost;
  const pending=host.read(7,f.request);assert.deepEqual(paths,['owned-synthetic-model']);ctx.bodyModelGeneration++;release(gene.modelSha256);await assert.rejects(pending,/变化/);
  const current=host.read(7,f.request);release(gene.modelSha256);const view=await current;assert.equal(view.assets[0].modelMapping,'verified-public-gene');
  await assert.rejects(host.read(8,f.request));assert.equal(paths.length,2);
});
