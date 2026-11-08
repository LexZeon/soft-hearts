import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {TextMemorialHost} from '../electron/text-memorial-host';
import {ProactiveSpeechGate} from '../electron/proactive-speech-gate';
import {MemoryStore} from '../electron/memory';
import type {TextMemorialScope} from '../electron/text-memorial-store';
import type {TextMemorialEvent,TextMemorialView} from '../shared/text-memorials';
const quote='我终于学会了弹这首曲子。',purpose='留作一起走过的文字纪念';
const invite=`你愿意把“${quote}”${purpose}吗？`;
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{await f.close();}}
async function setup(){
 const root=path.resolve('.local/r39-text-memorial-source-v1/owned-host-temp');await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,'case-'));
 let selected:TextMemorialScope|null={characterId:'synthetic-role',providerScope:'synthetic-provider'},identity='context-a',shown='',native=true,count=0,freezes=0,failNotifications=false;
 const gate=new ProactiveSpeechGate();gate.setScope('gate-a');const memory=new MemoryStore(path.join(directory,'ordinary'),'text-invitations');await memory.load();
 const events:TextMemorialEvent[]=[],views:Array<TextMemorialView|null>=[];const readiness=new Set<()=>void>();
 const surface={waitForPresentation:async(body:string)=>native&&shown===body,isPresentationCurrent:(body:string)=>native&&shown===body};
 const host=new TextMemorialHost({directory:path.join(directory,'memorials'),gate,scope:()=>selected,identity:()=>identity,gateScope:()=> 'gate-a',owner:()=>7,surface:()=>surface,
  eligible:()=>!!selected,event:event=>events.push(event),changed:view=>{if(failNotifications)throw Error('synthetic view failure');views.push(view);if(view){for(const resolve of readiness)resolve();readiness.clear();}},
  archive:async(offer,at,current)=>{assert.ok(selected);await memory.appendInitiative(selected,{id:offer.id,text:offer.invite,at,origin:{kind:'proactive',id:offer.id,at,sources:['text'],labels:['本次文字纪念邀请']}},current);},
  freezeSpeech:()=>{freezes++;},cancelSpeech:()=>{},
 });
 const ready=async()=>{if(!host.get())await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{readiness.delete(done);reject(Error('Synthetic sidecar ready event missing'));},2000);const done=()=>{clearTimeout(timer);resolve();};readiness.add(done);});assert.ok(host.get());};host.sync();await ready();
 const accept=(body:string,expected=identity)=>{const id=`human-${++count}`;return host.accept({requestId:id,messageId:id,text:body,acceptedAt:Date.now(),source:'text'},expected);};
 const offer=async()=>{const turn=accept(quote);assert.ok(turn);await turn.result;turn.complete(true,JSON.stringify({quote,purpose,invite}));const cue={id:`accepted-cue-${++count}`,kind:'speech',until:Date.now()+5000};assert.equal(host.offerOpportunity(cue),true);await drain();const state=host.getOffer();assert.ok(state.offer);shown=state.offer.invite;return {state,cue};};
 return {host,memory,events,views,accept,offer,ready,stats:()=>({freezes}),setNative:(value:boolean)=>{native=value;},failNotifications:()=>{failNotifications=true;},
  unavailable:()=>{selected=null;identity='';host.sync();},restore:()=>{selected={characterId:'synthetic-role',providerScope:'synthetic-provider'};identity='context-a';host.sync();},
  selected:()=>selected!,close:async()=>{host.dispose();gate.dispose();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}};
}

test('actual host adapter orders offer/receipt, suppresses repeated cue and archives one genuine text initiative',async()=>{
 await fixture(async f=>{
  const {state,cue}=await f.offer(),offer=state.offer!;
  assert.equal(f.host.offerOpportunity(cue),true,'same already claimed cue stays suppressed without another request');
  assert.equal(f.events.filter(event=>event.type==='offer').length,1);
  assert.equal(await f.host.acknowledge(8,{id:offer.id,revision:state.revision}),null);
  assert.equal(await f.host.acknowledge(7,{id:offer.id,revision:state.revision-1}),null);
  assert.equal(f.host.accept({requestId:'stale',messageId:'stale',text:'同意',acceptedAt:Date.now(),source:'text'},'old-context'),null);
  assert.equal(f.host.getOffer().offer!.id,offer.id,'old identity cannot cancel the new offer');
  const result=await f.host.acknowledge(7,{id:offer.id,revision:state.revision});assert.ok(result);
  assert.ok(result.revision>state.revision);assert.deepEqual(f.host.getOffer(),{revision:result.revision,offer:null});
  assert.equal(f.host.get()!.entries.length,0,'display is not consent');
  assert.equal(f.host.authorizeSpeech(7,offer.id,offer.invite),true);assert.equal(f.host.authorizeSpeech(7,offer.id,'another body'),false);
  const handle=f.memory.findInitiative(f.selected(),offer.id);assert.ok(handle);
  const archived=f.memory.read(f.selected(),handle.recordId);assert.ok(archived);
  assert.equal(archived.messages.length,1);assert.equal(archived.messages[0].role,'assistant');assert.equal(archived.messages[0].content,invite);
  const confirmed=f.accept('好的');assert.ok(confirmed);assert.equal((await confirmed.result).kind,'saved');
  assert.equal(f.host.get()!.entries.length,1);assert.deepEqual(f.events.map(event=>event.type),['offer','presented']);
  assert.deepEqual(f.stats(),{freezes:1});
  for(const sources of [['text','screen'],['made-up']])assert.throws(()=>f.memory.appendInitiative(f.selected(),{id:'forged',text:invite,at:Date.now(),origin:{kind:'proactive',id:'forged',at:Date.now(),sources:sources as never,labels:sources.map(()=> '资料')}}));
 });
});

test('unavailable then same scope restoration has a greater generation and old views cannot edit',async()=>{
 await fixture(async f=>{
  const old=f.host.get()!;f.unavailable();assert.equal(f.host.get(),null);assert.equal(f.views.at(-1),null);
  f.restore();await f.ready();assert.ok(f.host.get()!.generation>old.generation);
  await assert.rejects(f.host.edit({scopeId:old.scopeId,generation:old.generation,revision:old.revision,id:'missing',text:'旧范围',purpose:'旧用途'}));
  const {state}=await f.offer();f.setNative(false);
  assert.equal(await f.host.acknowledge(7,{id:state.offer!.id,revision:state.revision}),null);
  assert.equal(f.host.getOffer().offer,null);assert.equal(f.host.get()!.entries.length,0);
 });
});

test('view notification failures do not turn an actual confirmed commit into a false failure',async()=>{
 await fixture(async f=>{
  const {state}=await f.offer();await f.host.acknowledge(7,{id:state.offer!.id,revision:state.revision});f.failNotifications();
  const turn=f.accept('可以记下来');assert.ok(turn);assert.equal((await turn.result).kind,'saved');
  const view=f.host.get()!;assert.equal(view.entries.length,1);
  const changed=await f.host.edit({scopeId:view.scopeId,generation:view.generation,revision:view.revision,id:view.entries[0].id,text:'  保留原样\n的文字  ',purpose:'  个人纪念  '});
  assert.equal(changed.entries[0].text,'  保留原样\n的文字  ');assert.equal(changed.entries[0].purpose,'  个人纪念  ');
 });
});
