import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompanionService } from '../electron/companion';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';

function deferred() { let resolve!: () => void; const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve}; }

test('actual Companion archive waits do not delay the first readable delta, while completion archives and rewards only once',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'soft-incremental-host-'));
  const service=new CompanionService(directory,()=>{}), producerGate=deferred(),archiveGate=deferred();
  const plans=new CompletedReplySpeech(),events:string[]=[],frames:string[]=[],timers=new Map<number,{at:number,run:()=>void}>();
  let now=0,timer=0,raw='',producerDone=false,finished=false,ready=false,requests=0,pending:Promise<void>|undefined;
  const presentation=new ReplyPresentationState({now:()=>now,set:(run,delay)=>{const id=++timer;timers.set(id,{at:now+delay,run});return id as unknown as ReturnType<typeof setTimeout>;},clear:id=>{timers.delete(id as unknown as number);}});
  const advance=(ms:number)=>{const target=now+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].run();}now=target;};
  try {
    await service.load();await service.context('fixture-character',{kind:'claude',baseUrl:'https://fixture.invalid/v1',model:'synthetic'},'Synthetic character');
    const originalEvent=service.mood.event.bind(service.mood);
    service.mood.event=(event,character,...rest)=>{events.push(event.type);originalEvent(event,character,...rest);};
    const append=service.memory.appendAssistant.bind(service.memory);
    service.memory.appendAssistant=async(...args)=>{await archiveGate.promise;return append(...args);};
    presentation.begin('incremental');presentation.startReadout('incremental',(prefix,full)=>{frames.push(prefix);assert.equal(full,raw);});
    const turn=await service.begin('incremental','请解释两句。','Synthetic character',(type,text)=>{
      if(type==='delta'){raw+=text;presentation.content('incremental',raw);presentation.readoutContent('incremental',raw);}
    });
    const opening=turn.persona.match(/<sh-state-[a-f0-9]+>/)?.[0];assert.ok(opening);
    pending=(async()=>{
      requests++;turn.push('delta','第一句。');await producerGate.promise;
      turn.push('delta','第二句。第三句。\n'+opening+JSON.stringify({context:'support',delta:{O:3},confidence:0.9,reason:'synthetic support'})+opening.replace('<','</'));
      producerDone=true;
      const first=turn.finish('complete');assert.equal(turn.finish('complete'),first);await first;finished=true;
      plans.record(7,turn.id,'scope',raw);
      presentation.finishReadout(turn.id,()=>{ready=plans.markPresentationReady(turn.id,'scope');});
    })();
    await Promise.resolve();
    assert.equal(producerDone,false);assert.equal(finished,false);assert.equal(plans.busy,false);assert.equal(turn.speechMood(),null);
    assert.deepEqual(frames,['第一句。']);assert.equal(raw,'第一句。');
    producerGate.resolve();await new Promise(setImmediate);
    assert.equal(producerDone,true);assert.equal(finished,false,'archive is deliberately unresolved');
    assert.equal(raw,'第一句。第二句。第三句。');assert.deepEqual(frames,['第一句。'],'a provider burst does not flash the complete raw body');
    archiveGate.resolve();await pending;
    assert.equal(finished,true);assert.equal(ready,false);assert.equal(requests,1);assert.ok(turn.speechMood());
    advance(649);assert.deepEqual(frames,['第一句。']);advance(1);assert.equal(frames.at(-1),'第一句。第二句。');
    assert.equal(ready,false);advance(650);assert.equal(frames.at(-1),raw);assert.equal(ready,true);
    const record=service.memory.read(turn.scope,turn.recordId)!;
    assert.deepEqual(record.messages.map(message=>[message.role,message.content,message.status]),[['user','请解释两句。','complete'],['assistant',raw,'complete']]);
    assert.equal(service.memory.list(turn.scope).total,1);
    assert.equal(events.filter(type=>type==='chat').length,1);assert.equal(events.filter(type=>type==='appraisal').length,1);
    turn.push('delta','late');assert.equal(raw,'第一句。第二句。第三句。');
  } finally {
    producerGate.resolve();archiveGate.resolve();await pending?.catch(()=>{});presentation.cancelReadout();plans.clear();await service.flush();
    const actual=await realpath(directory),temp=await realpath(os.tmpdir());
    assert.equal(path.dirname(actual),temp);assert.ok(path.basename(actual).startsWith('soft-incremental-host-'));
    await rm(actual,{recursive:true,force:true});
  }
});
