import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechRuntime } from '../electron/speech-runtime';
import { ReplySpeechStyles } from '../electron/speech-emotion';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { cancelReplySpeechTransport } from '../electron/reply-speech-transport';

function harness() {
 const styles=new ReplySpeechStyles(),plans=new CompletedReplySpeech(),events:unknown[]=[];
 const runtime=new SpeechRuntime((owner,context)=>({...DEFAULT_TTS_CONFIG,...(context?styles.resolveStyle(owner,context.replyId,'scope'):{})}),(_owner,e)=>events.push(e),async()=>{});
 const complete=(id:string,style:string)=>{styles.begin(7,id,'scope');styles.complete(7,id,'scope',{context:'neutral',primary:'calm'},{emotion:'custom',instruction:style});plans.record(7,id,'scope','第一句。第二句。');};
 const cancel=(id:string)=>{styles.cancel(id);plans.cancel(7,id);};return{runtime,styles,plans,events,complete,cancel};
}
test('cancelling old transport after next reply completes preserves new frozen style and plan',async()=>{
 const h=harness();h.complete('old','old frozen');await h.runtime.speak(7,'transport_old','旧句。',{replyId:'old',segmentIndex:0});
 h.complete('new','new frozen');
 assert.deepEqual(cancelReplySpeechTransport(h.runtime,7,'transport_old',h.cancel),{cancelled:true,replyId:'old'});
 assert.equal(h.styles.resolveStyle(7,'new','scope').instruction,'new frozen');assert.equal(h.plans.next(7,'new','scope')?.index,0);
 assert.equal(cancelReplySpeechTransport(h.runtime,7,'transport_old',h.cancel).cancelled,false);
 assert.equal(h.styles.resolveStyle(7,'new','scope').instruction,'new frozen');
});
test('normal drain release keeps same reply style across pieces and wrong-owner/late cancellation is inert',async()=>{
 const h=harness();h.complete('reply','same frozen');
 for(let index=0;index<2;index++){
  const id=`transport_${index}`;await h.runtime.speak(7,id,'句子。',{replyId:'reply',segmentIndex:index});
  const before=h.events.length;assert.equal(h.runtime.release(8,id),false);assert.equal(h.runtime.release(7,id),true);assert.equal(h.events.length,before);
  assert.equal(cancelReplySpeechTransport(h.runtime,7,id,h.cancel).cancelled,false);assert.equal(h.styles.resolveStyle(7,'reply','scope').instruction,'same frozen');
 }
});
