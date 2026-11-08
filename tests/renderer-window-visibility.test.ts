import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PetVisibilityIntent, WindowVisibilityTracker } from '../src/ui/window-visibility';

test('window revisions protect native and desired state from old query and conflicting same revision', () => {
  const state = new WindowVisibilityTracker(); assert.equal(state.visible,false); assert.equal(state.petVisible,null);
  assert.equal(state.accept({windowId:3,revision:5,visible:true,petVisible:true}),true);
  assert.equal(state.accept({windowId:3,revision:4,visible:false,petVisible:false}),false);
  assert.equal(state.accept({windowId:9,revision:6,visible:false,petVisible:false}),false);
  assert.equal(state.accept({windowId:3,revision:5,visible:true,petVisible:false}),false);
  assert.equal(state.accept({windowId:3,revision:5,visible:true,petVisible:true}),false);
  assert.equal(state.accept({windowId:3,revision:6,visible:true,petVisible:false}),true);
  assert.equal(state.visible,true); assert.equal(state.petVisible,false);
});
test('serialized intents do not project old return over a newer recovery state', async () => {
  const state = new WindowVisibilityTracker(); state.accept({windowId:3,revision:1,visible:true,petVisible:false});
  const pending: Array<{value:boolean; resolve:()=>void; reject:(e:Error)=>void}> = [], errors: unknown[] = [];
  const intents = new PetVisibilityIntent(value => new Promise((resolve,reject) => pending.push({value,resolve,reject})), async error => { errors.push(error); });
  const first = intents.request(true), second = intents.request(false);
  await Promise.resolve(); assert.equal(pending.length,1); assert.equal(pending[0].value,true);
  state.accept({windowId:3,revision:3,visible:true,petVisible:true});
  pending[0].resolve(); await first; await Promise.resolve(); assert.equal(pending[1].value,false);
  state.accept({windowId:3,revision:4,visible:true,petVisible:false});
  state.accept({windowId:3,revision:5,visible:true,petVisible:true});
  pending[1].resolve(); await second;
  assert.equal(state.petVisible,true); assert.equal(errors.length,0);
  const third=intents.request(false); await Promise.resolve(); pending[2].reject(Error('fixture')); await third;
  assert.equal(state.petVisible,true); assert.equal(errors.length,1);
});
