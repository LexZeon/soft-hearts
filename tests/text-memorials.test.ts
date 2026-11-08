import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {TextMemorials,textMemorialReplyContext,type TextMemorialContext} from '../electron/text-memorials';
import {TextMemorialStore} from '../electron/text-memorial-store';
import {ProactiveSpeechGate} from '../electron/proactive-speech-gate';
import type {TextMemorialOffer} from '../shared/text-memorials';
import type {AtomicFileDependencies} from '../electron/atomic-file';

const original='今天我完成了第一幅自己的画。';
const purpose='留作我们一起见证的纪念';
const raw=JSON.stringify({quote:original,purpose,invite:`你愿意把“${original}”${purpose}吗？`});
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(run:(f:Awaited<ReturnType<typeof createFixture>>)=>Promise<void>,atomic?:AtomicFileDependencies){
  const f=await createFixture(atomic);try{await run(f);}finally{await f.close();}
}
async function createFixture(atomic?:AtomicFileDependencies){
  const root=path.resolve('.local/r39-text-memorial-source-v1/owned-temp');await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'case-'));let now=1_000,counter=0,shown=true,eligible=true,archives=0,changes=0;
  let context:TextMemorialContext={characterId:'synthetic-role',providerScope:'synthetic-provider',identity:'conversation-a',gateScope:'gate-a'};
  const offers:TextMemorialOffer[]=[],cancelled:string[]=[];const gate=new ProactiveSpeechGate(()=>now);gate.setScope(context.gateScope);
  let runtime:TextMemorials;
  const store=new TextMemorialStore(directory,{now:()=>now,atomic,invalidated:()=>runtime?.cancel()});await store.activate({characterId:context.characterId,providerScope:context.providerScope});
  runtime=new TextMemorials({gate,store,context:()=>context,eligible:()=>eligible,offer:offer=>{offers.push(offer);},cancelOffer:id=>cancelled.push(id),present:async()=>shown,presentationCurrent:()=>shown,
    archiveInvitation:async()=>{archives++;},changed:()=>{changes++;},now:()=>now,createId:()=>`offer-${++counter}`});
  const accepted=(body=original,id=`user-${++counter}`)=>{const turn=runtime.acceptUserTurn({requestId:id,messageId:id,text:body,acceptedAt:now,source:'text'},context.identity);assert.ok(turn);return turn;};
  const offer=async()=>{const turn=accepted();await turn.result;turn.complete(true,raw);const cue={id:`cue-${++counter}`,kind:'speech',until:now+5000};assert.equal(runtime.offerOpportunity(cue),true);await drain();assert.equal(offers.length>0,true);return {cue,offer:offers.at(-1)!};};
  return {runtime,store,gate,directory,offers,cancelled,accepted,offer,stats:()=>({archives,changes}),setNow:(value:number)=>{now=value;},
    setShown:(value:boolean)=>{shown=value;},setEligible:(value:boolean)=>{eligible=value;},
    changeContext:()=>{context={...context,identity:'conversation-b',gateScope:'gate-b'};gate.setScope(context.gateScope);},
    close:async()=>{runtime.dispose();store.dispose();gate.dispose();assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});}};
}

test('one existing opportunity, exact presentation and one human affirmation persist only the disclosed text',async()=>{
 await fixture(async f=>{
  const {cue,offer}=await f.offer();
  assert.equal(f.runtime.offerOpportunity(cue),false);
  assert.equal(f.gate.tryAcquire({scope:'gate-a',opportunityId:cue.id,expiresAt:10_000},'vision'),null);
  assert.equal(f.store.view()!.entries.length,0);assert.deepEqual(f.stats(),{archives:0,changes:0});
  assert.deepEqual(await f.runtime.acknowledge(offer.id),offer);
  assert.equal(f.store.view()!.entries.length,0,'presentation ACK is not storage consent');
  assert.equal(await f.runtime.acknowledge(offer.id),null);
  const result=await f.accepted('可以记下来','affirmation').result;
  assert.equal(result.kind,'saved');assert.equal(f.store.view()!.entries.length,1);
  assert.deepEqual(f.store.view()!.entries.map(entry=>[entry.text,entry.purpose]),[[original,purpose]]);
  assert.match(textMemorialReplyContext(result),/status.*saved/u);
  assert.equal((await f.accepted('可以记下来','duplicate-response').result).kind,'none');
  assert.deepEqual(f.stats(),{archives:1,changes:1});
 });
});

test('refusal, ambiguous reply and silence do not save or ask again for the same event',async()=>{
 for(const response of ['不要记下来','如果可以就记下来吧',null])await fixture(async f=>{
  const {offer}=await f.offer();await f.runtime.acknowledge(offer.id);
  if(response!==null){const turn=f.accepted(response);const result=await turn.result;assert.notEqual(result.kind,'saved');turn.complete(true,raw);}
  else f.setNow(400_000);
  assert.equal(f.store.view()!.entries.length,0);
  const repeated=f.accepted(original,'same-event-again');await repeated.result;repeated.complete(true,raw);
  assert.equal(f.runtime.offerOpportunity({id:'repeat-cue',kind:'speech',until:405_000}),false);
  assert.equal(f.offers.length,1);
 });
});

test('uncompleted turns, failed native presentation and wrong-context affirmations cannot save',async()=>{
 await fixture(async f=>{
  const failed=f.accepted();failed.complete(false);
  assert.equal(f.runtime.offerOpportunity({id:'failed',kind:'speech',until:5000}),false);
  const {offer}=await f.offer();f.setShown(false);assert.equal(await f.runtime.acknowledge(offer.id),null);
  assert.equal((await f.accepted('好的').result).kind,'none');assert.equal(f.store.view()!.entries.length,0);
 });
 await fixture(async f=>{
  const {offer}=await f.offer();await f.runtime.acknowledge(offer.id);f.changeContext();
  assert.equal((await f.accepted('好的').result).kind,'unconfirmed');assert.equal(f.store.view()!.entries.length,0);
 });
});

test('a cancelled unpresented invitation cannot later acknowledge, archive or save',async()=>{
 await fixture(async f=>{
  const turn=f.accepted();turn.complete(true,raw);assert.equal(f.runtime.offerOpportunity({id:'late',kind:'speech',until:5000}),true);
  const offer=f.offers.at(-1)!;f.runtime.cancel();await drain();
  assert.equal(await f.runtime.acknowledge(offer.id),null);assert.equal(f.stats().archives,0);assert.equal(f.store.view()!.entries.length,0);
  assert.equal((await f.accepted('好的').result).kind,'none');
 });
});

test('scope cancellation before atomic rename blocks a previously affirmative late write',async()=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
 const atomic:AtomicFileDependencies={writeFile:async(file,data,options)=>{await writeFile(file,data,options);entered();await held;}};
 await fixture(async f=>{
  const {offer}=await f.offer();await f.runtime.acknowledge(offer.id);
  const saving=f.accepted('同意').result;await started;f.runtime.cancel();release();
  assert.equal((await saving).kind,'not-saved');assert.equal(f.store.view()!.entries.length,0);
  assert.deepEqual(await readdir(f.directory),[],'the owned temporary is cleaned and no archive was committed');
 },atomic);
});

test('saved text management keeps scope/version checks, private source metadata and deletion tombstones',async()=>{
 await fixture(async f=>{
  const {offer}=await f.offer();await f.runtime.acknowledge(offer.id);await f.accepted('好的').result;
  const before=f.store.view()!,entry=before.entries[0];assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(),['createdAt','id','purpose','text','updatedAt']);
  assert.throws(()=>f.store.edit({...before,entries:undefined,id:entry.id,text:'更正的文字',purpose:'纪念'}));
  const expected={scopeId:before.scopeId,generation:before.generation,revision:before.revision};
  await assert.rejects(f.store.edit({...expected,scopeId:'a'.repeat(64),id:entry.id,text:'更正',purpose:'纪念'}));
  const edited=await f.store.edit({...expected,id:entry.id,text:'我完成了自己的第一幅画。',purpose:'留作纪念'});
  assert.equal(edited.entries[0].text,'我完成了自己的第一幅画。');
  await assert.rejects(f.store.delete({...expected,id:entry.id}));
  const current={scopeId:edited.scopeId,generation:edited.generation,revision:edited.revision};
  assert.equal((await f.store.delete({...current,id:entry.id})).entries.length,0);
  await f.store.activate({characterId:'other-synthetic-role',providerScope:'synthetic-provider'});
  assert.equal(f.store.view()!.entries.length,0);
  await f.store.activate({characterId:'synthetic-role',providerScope:'synthetic-provider'});
  assert.equal(f.store.view()!.entries.length,0);
  const repeated=f.accepted(original);repeated.complete(true,raw);
  assert.equal(f.runtime.offerOpportunity({id:'deleted-event',kind:'speech',until:5000}),false);
 });
});
