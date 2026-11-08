import test from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS} from '../shared/defaults';import {MotionPreviewSession} from '../src/ui/motion-preview';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function setup(){const settings=structuredClone(DEFAULT_SETTINGS);settings.model={path:'/gene',url:'mmd-asset://gene',name:'Gene'};let applied=0,cancelled=0;
 const session=new MotionPreviewSession({getSettings:()=>settings,load:async()=>{throw Error('unexpected VMD load');},apply:async()=>{applied++;},onState:()=>{}});
 return {settings,session,get applied(){return applied;},get cancelled(){return cancelled;},cancel:()=>{cancelled++;}};}
test('one existing preview owner starts and ends local clip without touching base motion or settings',async()=>{
 const h=setup(),before=structuredClone(h.settings);assert.equal(await h.session.startLocal(async()=>true,h.cancel),true);
 assert.equal(h.session.state.local,'surprise');assert.deepEqual(h.session.view(h.settings),before);assert.equal(h.applied,0);
 h.session.finishLocal();assert.equal(h.cancelled,1);assert.equal(h.applied,0);assert.equal(h.session.state.phase,'idle');assert.deepEqual(h.settings,before);
});
test('cancel or model change fences late local completion',async()=>{
 const h=setup(),pending=deferred<boolean>();const start=h.session.startLocal(()=>pending.promise,h.cancel);
 await h.session.stop();pending.resolve(true);assert.equal(await start,false);assert.equal(h.cancelled,1);assert.equal(h.session.state.phase,'idle');
 const next=deferred<boolean>(),start2=h.session.startLocal(()=>next.promise,h.cancel);h.settings.model!.path='/different';h.session.view(h.settings);
 next.resolve(true);assert.equal(await start2,false);assert.equal(h.cancelled,2);assert.equal(h.applied,0);
});
