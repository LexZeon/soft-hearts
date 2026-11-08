import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {ReplyPresentationState, type ReadoutClock} from '../src/ui/reply-presentation';
import {PetUI} from '../src/ui/PetUI';
import {ReplySpeechState} from '../src/ui/reply-speech';

function fakeClock() {
  let now=0,next=0;const timers=new Map<number,{at:number;fn:()=>void}>();
  const clock:ReadoutClock={now:()=>now,set:(fn,delay)=>{const id=++next;timers.set(id,{at:now+delay,fn});return id as unknown as ReturnType<typeof setTimeout>;},clear:id=>{timers.delete(id as unknown as number);}};
  return {clock,advance(ms:number){const end=now+ms;for(;;){const due=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].fn();}now=end;}};
}
test('partial first sentence grows immediately and complete queued sentences wait',()=>{
  const time=fakeClock(),s=new ReplyPresentationState(time.clock),paint:string[]=[];s.begin('a');s.startReadout('a',p=>paint.push(p));
  s.readoutContent('a','第一');s.readoutContent('a','第一句。');s.readoutContent('a','第一句。第二句。');
  assert.deepEqual(paint,['第一','第一句。']);time.advance(649);assert.equal(paint.length,2);time.advance(1);assert.equal(paint.at(-1),'第一句。第二句。');
});
test('long reply preserves every character beyond speech bounds and drains in order',()=>{
  const time=fakeClock(),s=new ReplyPresentationState(time.clock),paint:string[]=[];let drained=0;const raw=Array.from({length:145},(_,i)=>`第${i}句${'字'.repeat(45)}。`).join('');
  s.begin('a');s.startReadout('a',p=>paint.push(p));s.readoutContent('a',raw);s.finishReadout('a',()=>drained++);
  assert.equal(paint.length,1);assert.notEqual(paint[0],raw);time.advance(145*2*4000);
  assert.equal(paint.at(-1),raw);assert.equal(drained,1);assert.ok(paint.every((p,i)=>i===0||p.startsWith(paint[i-1])));
});
test('scope replacement cancels a pending timer and cannot emit its old completion',()=>{
  const time=fakeClock(),s=new ReplyPresentationState(time.clock),paint:string[]=[];let drained=0;s.begin('a');s.startReadout('a',p=>paint.push(p));
  s.readoutContent('a','旧第一句。旧第二句。');s.finishReadout('a',()=>drained++);s.begin('b');s.startReadout('b',p=>paint.push(p));s.readoutContent('b','新句。');
  time.advance(10000);assert.deepEqual(paint,['旧第一句。','新句。']);assert.equal(drained,0);
});
test('bounded long sentence never splits a surrogate pair',()=>{
 // R27: the first sentence is never paged, so the bounded page applies to a later sentence.
 const time=fakeClock(),s=new ReplyPresentationState(time.clock),paint:string[]=[];const lead='首句。',raw=lead+'字'.repeat(47)+'😀'+'尾'.repeat(4);
 s.begin('a');s.startReadout('a',p=>paint.push(p));s.readoutContent('a',raw);s.finishReadout('a',()=>{});
 assert.equal(paint[0],lead);time.advance(4000);assert.equal(paint[1],lead+'字'.repeat(47));time.advance(8000);assert.equal(paint.at(-1),raw);
 assert.ok(paint.every(p=>!/[\uD800-\uDBFF]$/u.test(p)));
});
test('fast burst of more than 128 short sentences does not collapse unseen sentences',()=>{
 const time=fakeClock(),s=new ReplyPresentationState(time.clock),paint:string[]=[];const raw='句。'.repeat(145);let drained=0;
 s.begin('a');s.startReadout('a',p=>paint.push(p));s.readoutContent('a',raw);s.finishReadout('a',()=>drained++);
 time.advance(145*4000);assert.equal(paint.at(-1),raw);assert.equal(drained,1);
 assert.ok(paint.length>=145,`only ${paint.length} visible steps for 145 short sentences`);
});
test('splitter overflow falls back to complete raw text without losing later deltas',()=>{
 const time=fakeClock(),s=new ReplyPresentationState(time.clock),paint:string[]=[];let drained=0;const raw='字'.repeat(100001);
 s.begin('a');s.startReadout('a',p=>paint.push(p));s.readoutContent('a',raw);s.readoutContent('a',raw+'尾');s.finishReadout('a',()=>drained++);
 assert.equal(paint.at(-1),raw+'尾');assert.equal(drained,1);
});
test('raw native preview follows the tail after 32000 units while the reader keeps every character',()=>{
 const previousDocument=globalThis.document,previousWindow=globalThis.window,body={textContent:'',classList:{remove(){}}},updates:{text?:string}[]=[];let reader='';
 globalThis.document={getElementById:(id:string)=>id==='pet-answer-body'?body:null} as unknown as Document;
 globalThis.window={desktop:{updatePetReply:async(patch:{text?:string})=>{updates.push(patch);}}} as unknown as Window & typeof globalThis;
 const ui=Object.create(PetUI.prototype) as PetUI;
 Object.assign(ui,{replySpeech:new ReplySpeechState(),replyReader:{clear(){reader='';},update(text:string){reader=text;}},anchor:{x:1,y:1,visible:true},interactionProgress:0,actions:{error(message:string){assert.fail(message);}}});
 try {const raw='文字'.repeat(18000)+'尾句。';ui.beginAnswer('r');ui.showAnswer(raw,true,'r',false);
  assert.equal(body.textContent,raw);assert.equal(reader,raw);assert.ok(updates.at(-1)!.text!.length<=32000);assert.ok(updates.at(-1)!.text!.endsWith('尾句。'));
 } finally {globalThis.document=previousDocument;globalThis.window=previousWindow;}
});
