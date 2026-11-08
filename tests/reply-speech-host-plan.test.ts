import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';

test('three completed replies keep ordered exact source pieces, one cloud claim each and no replay', () => {
 const plans = new CompletedReplySpeech();
 for (let turn = 0; turn < 3; turn++) {
  const id = `reply_${turn}`;plans.record(7,id,'character/provider/model','第一句话。第二句话。');
  const first = plans.next(7,id,'character/provider/model')!;
  assert.equal(first.text,'第一句话。');assert.equal(first.visibleText,'第一句话。');assert.deepEqual(first.context,{replyId:id,segmentIndex:0});
  assert.throws(()=>plans.authorizeCloud(7,id,'character/provider/model',0,'任意替换文字'));
  assert.throws(()=>plans.authorizeCloud(7,id,'character/provider/model',0,first.text),'unconfirmed exact text must also be denied');
  assert.equal(plans.markPresentationReady(id,'character/provider/model'),true);
  assert.throws(()=>plans.authorizeCloud(7,id,'character/provider/model',0,first.text),'local readiness is not a native receipt');
  assert.equal(plans.approvePresentation(7,id,'character/provider/model',first),true);
  assert.throws(()=>plans.authorizeCloud(7,id,'character/provider/model',0,'任意替换文字'),'approved receipt does not authorize different text');
  plans.authorizeCloud(7,id,'character/provider/model',0,first.text);
  assert.throws(()=>plans.authorizeCloud(7,id,'character/provider/model',0,first.text));
  const second = plans.next(7,id,'character/provider/model',0)!;
  assert.equal(second.text,'第二句话。');assert.equal(second.visibleText,'第一句话。第二句话。');
  assert.throws(()=>plans.authorizeCloud(7,id,'character/provider/model',1,second.text),'each new segment needs its own receipt');
  assert.equal(plans.approvePresentation(7,id,'character/provider/model',second),true);
  plans.authorizeCloud(7,id,'character/provider/model',1,second.text);
  assert.equal(plans.next(7,id,'character/provider/model',1),null);
  assert.equal(plans.next(7,id,'character/provider/model'),null);
  assert.throws(()=>plans.authorizeCloud(7,id,'character/provider/model',1,second.text));
 }
});

test('owner, scope, index, old cancellation and expiry cannot affect a newer completed reply', () => {
 let now=0;const plans=new CompletedReplySpeech(()=>now);
 plans.record(7,'old','scopeA','旧的句子。');plans.next(7,'old','scopeA');
 plans.record(7,'new','scopeB','新的句子。还有一句。');
 assert.equal(plans.cancel(7,'old'),false);assert.equal(plans.next(8,'new','scopeB'),null);assert.equal(plans.next(7,'new','scopeA'),null);
 assert.throws(()=>plans.next(7,'new','scopeB',0));
 const first=plans.next(7,'new','scopeB')!;assert.equal(first.index,0);
 assert.throws(()=>plans.authorizeCloud(8,'new','scopeB',0,first.text));assert.throws(()=>plans.authorizeCloud(7,'new','scopeA',0,first.text));
 now=15*60000;assert.equal(plans.next(7,'new','scopeB',0),null);assert.equal(plans.identity(),null);
});

test('full plan fails before any audio for over-limit text and preserves raw whitespace offsets', () => {
 const plans=new CompletedReplySpeech();plans.record(1,'long','scope','a'.repeat(6001));assert.throws(()=>plans.next(1,'long','scope'),/6000/);
 plans.record(1,'bounded','scope','  第一句。\n第二句。  ');
 const a=plans.next(1,'bounded','scope')!;assert.equal(a.text,'第一句。');assert.ok(a.visibleText.startsWith('  '));
 const b=plans.next(1,'bounded','scope',0)!;assert.equal(b.text,'第二句。');assert.equal(b.visibleText,'  第一句。\n第二句。  ');
});

test('logical reply busy holds across drain and clears only after final acknowledgement, cancellation or expiry',()=>{
 let now=0;const plans=new CompletedReplySpeech(()=>now);
 plans.record(7,'reply','scope','第一句。第二句。');assert.equal(plans.busy,true);
 const first=plans.next(7,'reply','scope')!;assert.equal(plans.busy,true);
 assert.throws(()=>plans.authorizeCloud(7,'reply','scope',0,'第一句。'));
 assert.equal(plans.markPresentationReady('reply','scope'),true);assert.equal(plans.approvePresentation(7,'reply','scope',first),true);
 plans.authorizeCloud(7,'reply','scope',0,'第一句。');assert.equal(plans.busy,true);
 plans.next(7,'reply','scope',0);assert.equal(plans.busy,true);plans.next(7,'reply','scope',1);assert.equal(plans.busy,false);
 plans.record(7,'new','scope','新句。');assert.equal(plans.busy,true);plans.cancel(7,'new');assert.equal(plans.busy,false);
 plans.record(7,'expired','scope','过期句。');now=15*60000;assert.equal(plans.busy,false);
});
