import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('next bubble/segment waits for the previous playback promise, then completes three text replies',async()=>{
 const host=new CompletedReplySpeech(),calls:string[]=[],held:(()=>void)[]=[];
 const api={async nextReplySpeechSegment(id:string,index?:number){calls.push(`next:${id}:${index??'start'}`);return host.next(1,id,'scope',index);},async cancelReplySpeech(id:string){host.cancel(1,id);}};
 const queue=new CompletedReplySpeechQueue(api,piece=>{calls.push(`play:${piece.replyId}:${piece.index}`);return new Promise<void>(r=>held.push(r));},()=>true);
 for(let n=0;n<3;n++){
  const id=`turn_${n}`;host.record(1,id,'scope','第一句话。第二句话。');const done=queue.speak(id);await tick();
  assert.equal(calls.filter(x=>x===`next:${id}:0`).length,0);assert.equal(held.length,1);
  held.shift()!();await tick();assert.equal(calls.filter(x=>x===`play:${id}:1`).length,1);assert.equal(held.length,1);
  held.shift()!();await done;assert.equal(queue.replyId,null);assert.equal(calls.filter(x=>x.startsWith(`play:${id}:`)).length,2);
 }
});

test('cancelled or late approvals/playback never start another piece or clobber a new reply',async()=>{
 const host=new CompletedReplySpeech(),played:string[]=[],held:(()=>void)[]=[];
 const api={async nextReplySpeechSegment(id:string,index?:number){return host.next(1,id,'scope',index);},async cancelReplySpeech(id:string){host.cancel(1,id);}};
 const queue=new CompletedReplySpeechQueue(api,p=>{played.push(p.replyId+':'+p.index);return new Promise<void>(r=>held.push(r));},()=>true);
 host.record(1,'old','scope','旧句。下一句。');const old=queue.speak('old');await tick();queue.cancel();
 host.record(1,'new','scope','新句。下一句。');const next=queue.speak('new');await tick();held.shift()!();await old;assert.deepEqual(played,['old:0','new:0']);
 held.shift()!();await tick();assert.deepEqual(played,['old:0','new:0','new:1']);held.shift()!();await next;
});

test('disabled speech makes no host call, and failed playback stops the sequence',async()=>{
 let requests=0,cancelled=0;
 const api={async nextReplySpeechSegment(id:string){requests++;return{replyId:id,index:0,text:'句子。',visibleText:'句子。',context:{replyId:id,segmentIndex:0}};},async cancelReplySpeech(){cancelled++;}};
 await new CompletedReplySpeechQueue(api,async()=>{},()=>false).speak('off');assert.equal(requests,0);
 const failed=new CompletedReplySpeechQueue(api,async()=>{throw Error('actual playback failed');},()=>true);
 await assert.rejects(failed.speak('fail'),/actual playback failed/);assert.equal(requests,1);assert.equal(cancelled,1);assert.equal(failed.replyId,null);
});
