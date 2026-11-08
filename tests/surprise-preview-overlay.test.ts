import test from 'node:test';
import assert from 'node:assert/strict';
import {Bone,Quaternion,Vector3,type SkinnedMesh} from 'three';
import {SurpriseOverlay,surpriseSample} from '../src/stage/surprise-preview-overlay';

const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
function rig(){
  const bones=Array.from({length:10},()=>new Bone());
  bones[2].name='グルーブ';bones[5].name='上半身';bones[2].add(bones[5]);
  bones[8].name='首';bones[9].name='頭';bones[8].add(bones[9]);bones[5].add(bones[8]);
  const influences=Array.from({length:184},()=>0);influences[84]=0.12;influences[94]=0.18;influences[70]=0.33;
  const mesh={skeleton:{bones},morphTargetInfluences:influences,morphTargetDictionary:{'上':84,'びっくり':94}} as unknown as SkinnedMesh;
  return {mesh,bones,influences};
}
const gates={brow:true,eye:true,head:true,torso:true,naturalBlink:0};

test('closed 1800ms input has a shared plateau and ends without contribution',()=>{
  assert.equal(surpriseSample(-1),null);assert.equal(surpriseSample(1800),null);assert.equal(surpriseSample(NaN),null);
  const a=surpriseSample(400)!,b=surpriseSample(560)!;assert.deepEqual(a,b);
  assert.equal(a.brow_raise,0.48);assert.equal(a.eye_wide,0.55);assert.equal(a.head_z_degrees,6);assert.equal(a.torso_z_degrees,3.5);
});

test('each bone uses current base right multiplied once; restore and next advancing base do not feed back',()=>{
  const {mesh,bones}=rig(),overlay=new SurpriseOverlay(mesh,true,true);
  const baseHead=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),0.3),baseTorso=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),0.2);
  bones[9].quaternion.copy(baseHead);bones[5].quaternion.copy(baseTorso);
  const result=overlay.apply(500,gates);assert.deepEqual(result.bones,[5,9]);
  const z=(deg:number)=>new Quaternion(0,0,Math.sin(deg*Math.PI/360),Math.cos(deg*Math.PI/360));
  near(Math.abs(bones[9].quaternion.dot(baseHead.clone().multiply(z(6)).normalize())),1);
  near(Math.abs(bones[5].quaternion.dot(baseTorso.clone().multiply(z(3.5)).normalize())),1);
  // Parent 5 also moves world head; the head local delta does not cancel it.
  bones[2].updateMatrixWorld(true);const world=new Quaternion();bones[9].getWorldQuaternion(world);
  assert.ok(Math.abs(world.dot(bones[9].quaternion))<0.999999);
  assert.throws(()=>overlay.apply(500,gates));overlay.restore();near(Math.abs(bones[9].quaternion.dot(baseHead)),1);
  const next=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-0.35);bones[9].quaternion.copy(next);
  overlay.apply(500,gates);near(Math.abs(bones[9].quaternion.dot(next.clone().multiply(z(6)).normalize())),1);overlay.restore();near(Math.abs(bones[9].quaternion.dot(next)),1);
});

test('face uses target blend and blink gate, preserving unrelated channel and restoration',()=>{
  const {mesh,influences}=rig(),overlay=new SurpriseOverlay(mesh,true,true);
  overlay.apply(500,{...gates,naturalBlink:0.5});near(influences[84],0.48);near(influences[94],0.18+(0.55-0.18)*0.5);near(influences[70],0.33);
  overlay.restore();near(influences[84],0.12);near(influences[94],0.18);near(influences[70],0.33);
});

test('zero, expired, blocked, unqualified and invalid bases do not claim or overwrite',()=>{
  const {mesh,bones,influences}=rig(),overlay=new SurpriseOverlay(mesh,true,true);
  assert.deepEqual(overlay.apply(0,gates),{morphs:[],bones:[]});assert.deepEqual(overlay.apply(1800,gates),{morphs:[],bones:[]});
  assert.deepEqual(overlay.apply(500,{brow:false,eye:false,head:false,torso:false,naturalBlink:0}),{morphs:[],bones:[]});
  bones[9].quaternion.set(0,0,0,0);bones[5].quaternion.set(NaN,0,0,1);
  assert.deepEqual(overlay.apply(500,{...gates,brow:false,eye:false}),{morphs:[],bones:[]});assert.equal(bones[9].quaternion.lengthSq(),0);assert.ok(Number.isNaN(bones[5].quaternion.x));
  assert.throws(()=>new SurpriseOverlay(mesh,false,true));
  const noFace=new SurpriseOverlay(mesh,true,false);assert.deepEqual(noFace.apply(500,{brow:true,eye:true,head:false,torso:false,naturalBlink:0}),{morphs:[],bones:[]});near(influences[84],0.12);
  const changed=new SurpriseOverlay(mesh,true,true);mesh.morphTargetDictionary!['new-target']=1;
  assert.deepEqual(changed.apply(500,{brow:true,eye:true,head:false,torso:false,naturalBlink:0}),{morphs:[],bones:[]});
  bones[0].name='頭';const ambiguousBone=new SurpriseOverlay(mesh,true,false);bones[9].quaternion.identity();
  assert.deepEqual(ambiguousBone.apply(500,{brow:false,eye:false,head:true,torso:false,naturalBlink:0}),{morphs:[],bones:[]});
  mesh.morphTargetDictionary!['unexpected-alias']=84;
  const ambiguous=new SurpriseOverlay(mesh,true,true);assert.deepEqual(ambiguous.apply(500,{brow:true,eye:true,head:false,torso:false,naturalBlink:0}),{morphs:[],bones:[]});
});
