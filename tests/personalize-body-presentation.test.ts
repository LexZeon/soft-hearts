import test from 'node:test';import assert from 'node:assert/strict';
import { selectBodyPosePresentation } from '../shared/personalize-body-presentation';
import type { BodyPoseBinding,BodyPoseProfile } from '../shared/personalize-body';
import type { BehaviorMotionPlan } from '../shared/behavior-motion';
const sha='a'.repeat(64),source='b'.repeat(64),binding:BodyPoseBinding={id:'body.test',label:'test',targetModelSha:sha,sourceSha:source,mask:'test',qualifiedStrength:.3,properties:[{boneIndex:1,boneName:'bone',quaternion:[0,0,0,1]}]};
const profile:BodyPoseProfile={enabled:true,targetModelSha:sha,sourceSha:source,bindingId:binding.id,semantic:'mood.happy',label:'happy',strength:0.3};
const plan:BehaviorMotionPlan={state:{id:'cue1',kind:'state',bindingId:'face.happy',semantic:'mood.happy',at:100,expiresAt:300,strength:0.4,stateKey:'x'},reaction:null};
test('body presentation borrows exact host cue, binding and capped strength without creating a cue',()=>{
  const result=selectBodyPosePresentation(profile,binding,sha,'mmd-asset://model',plan,200);
  assert.equal(result?.cueId,'cue1');assert.equal(result?.expiresAt,300);assert.equal(result?.strength,0.3);
  assert.notEqual(result?.binding,binding);assert.equal(selectBodyPosePresentation(profile,binding,sha,'mmd-asset://model',plan,300),null);
  assert.equal(selectBodyPosePresentation(profile,binding,'c'.repeat(64),'mmd-asset://model',plan,200),null);
  assert.equal(selectBodyPosePresentation({...profile,sourceSha:'d'.repeat(64)},binding,sha,'mmd-asset://model',plan,200),null);
  assert.equal(selectBodyPosePresentation({...profile,semantic:'mood.sad'},binding,sha,'mmd-asset://model',plan,200),null);
  assert.equal(selectBodyPosePresentation({...profile,enabled:false},binding,sha,'mmd-asset://model',plan,200),null);
  assert.equal(selectBodyPosePresentation({...profile,strength:.4},binding,sha,'mmd-asset://model',plan,200),null);
});
