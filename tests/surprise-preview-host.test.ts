import test from 'node:test';import assert from 'node:assert/strict';
import {SurprisePreviewHost} from '../electron/surprise-preview-host';

test('fixed clip and model identity are host-owned, scoped and generation bound',async()=>{
  let now=100;const context={modelKey:'m1',modelUrl:'asset://gene',visible:true};
  const host=new SurprisePreviewHost({context:owner=>owner===3?context:null,verifyTarget:async()=>true,now:()=>now});
  const grant=await host.begin(3);assert.equal(grant.clipId,'original-surprise-offline-001');assert.equal(grant.revision,2);
  assert.throws(()=>host.resolve(4,grant.id,1));assert.throws(()=>host.resolve(3,grant.id,0));
  assert.equal(host.resolve(3,grant.id,7).id,grant.id);assert.throws(()=>host.resolve(3,grant.id,8));
  context.modelKey='m2';assert.throws(()=>host.resolve(3,grant.id,7));context.modelKey='m1';now=grant.expiresAt;assert.throws(()=>host.resolve(3,grant.id,7));
});
test('late verification cannot revive a stopped, replaced or changed context',async()=>{
  const context={modelKey:'a',modelUrl:'asset://gene',visible:true};const waits:Array<(v:boolean)=>void>=[];
  const host=new SurprisePreviewHost({context:()=>context,verifyTarget:()=>new Promise(done=>waits.push(done))});
  const first=host.begin(1);host.stop(1);waits.shift()!(true);await assert.rejects(first);
  const old=host.begin(1),next=host.begin(1);waits.shift()!(true);await assert.rejects(old);waits.shift()!(true);const grant=await next;
  host.stop(1,'wrong-old-id');assert.equal(host.resolve(1,grant.id,2).id,grant.id);
  host.stop(1,grant.id);assert.throws(()=>host.resolve(1,grant.id,2));
  const changed=host.begin(1);context.visible=false;waits.shift()!(true);await assert.rejects(changed);
});
test('unverified target and hidden owner never receive a lease',async()=>{
  const hidden=new SurprisePreviewHost({context:()=>({modelKey:'x',modelUrl:'a',visible:false}),verifyTarget:async()=>true});await assert.rejects(hidden.begin(1));
  const other=new SurprisePreviewHost({context:()=>({modelKey:'x',modelUrl:'a',visible:true}),verifyTarget:async()=>false});await assert.rejects(other.begin(1));
});
test('context invalidation revokes the exact lease and notifies only its owner once',async()=>{
 const events:Array<[number,string]>=[];const host=new SurprisePreviewHost({context:()=>({modelKey:'a',modelUrl:'asset://gene',visible:true}),verifyTarget:async()=>true,cancelled:(owner,id)=>events.push([owner,id])});
 const one=await host.begin(9);host.resolve(9,one.id,4);host.invalidate();assert.deepEqual(events,[[9,one.id]]);assert.throws(()=>host.resolve(9,one.id,4));host.stop(9,one.id);assert.equal(events.length,1);
});

test('closed recipe selector issues one host identity, replaces the old owner and rejects arbitrary input',async()=>{
 const events:Array<[number,string]>=[];
 const host=new SurprisePreviewHost({context:()=>({modelKey:'a',modelUrl:'asset://gene',visible:true}),verifyTarget:async()=>true,cancelled:(owner,id)=>events.push([owner,id])});
 const old=await host.begin(9),shy=await host.begin(9,'shy');
 assert.equal(old.clipId,'original-surprise-offline-001');assert.equal(shy.clipId,'original-shy-offline-001');assert.equal(shy.revision,1);
 assert.deepEqual(events,[[9,old.id]]);assert.throws(()=>host.resolve(9,old.id,4));assert.equal(host.resolve(9,shy.id,4).id,shy.id);
 await assert.rejects(host.begin(9,'renderer-path' as never));assert.equal(host.resolve(9,shy.id,4).id,shy.id);
 host.stop(9,old.id);assert.equal(host.resolve(9,shy.id,4).id,shy.id);host.stop(9,shy.id);assert.throws(()=>host.resolve(9,shy.id,4));
});

test('late verification of the old surprise cannot replace a newer shy lease',async()=>{
 const waits:Array<(value:boolean)=>void>=[];
 const host=new SurprisePreviewHost({context:()=>({modelKey:'a',modelUrl:'asset://gene',visible:true}),verifyTarget:()=>new Promise(resolve=>waits.push(resolve))});
 const old=host.begin(2),next=host.begin(2,'shy');waits[1](true);const shy=await next;waits[0](true);await assert.rejects(old);
 assert.equal(host.resolve(2,shy.id,3).clipId,'original-shy-offline-001');
});
