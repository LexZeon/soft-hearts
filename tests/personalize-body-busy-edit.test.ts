import test from 'node:test';import assert from 'node:assert/strict';
import {PersonalizeBodyControls} from '../src/ui/PersonalizeBodyControls';
import {BODY_AUTHORING_PURPOSE,BODY_TWEAK_BINDING,BODY_TWEAK_TARGET,type BodyPosePreview,type BodyVisualState} from '../shared/personalize-body';
class Element {children:Element[]=[];textContent='';private v='';disabled=false;hidden=false;open=false;className='';src='';dataset:Record<string,string>={};
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;ontoggle:(()=>void)|null=null;constructor(readonly tagName:string){}
 get value(){return this.v;}set value(value:string){this.v=this.tagName==='select'&&!this.children.some(x=>x.value===value)?'':value;}
 append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(...nodes:Element[]){this.children=[...nodes];if(this.tagName==='select')this.v='';}setAttribute(_name:string,_value:string){} }
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('editing during a pending preview retains the full draft, cancels the old session and ignores its late result',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const root=new Element('div'),cancelled:string[]=[],stops:string[]=[];let session=0,previewCalls=0,first=true,releaseOld:(()=>void)|undefined;
 const state=(card:string):BodyVisualState=>({id:`session-${++session}`,characterId:card,revision:0,savedRevision:0,purpose:BODY_AUTHORING_PURPOSE,connectionLabel:'synthetic',imageSupported:true,
  targetSupported:true,targetModelSha:BODY_TWEAK_TARGET,material:null,submitNonce:null,study:null,saved:{characterId:card,revision:0,profile:null},
  choices:[{id:BODY_TWEAK_BINDING,label:'left arm',qualifiedStrength:.5}]});
 let lastSelection:unknown;const view=(id:string,sessionId:string):BodyPosePreview=>({id,token:`token-${id}`,sessionId,revision:1,materialId:null,sourceKind:'fixed-preset',characterId:'card1',
  targetModelSha:BODY_TWEAK_TARGET,modelUrl:'mmd-asset://synthetic',bindingId:BODY_TWEAK_BINDING,sourceSha:'a'.repeat(64),mask:'synthetic',strength:.5,expiresAt:Date.now()+1000});
 const ui=new PersonalizeBodyControls(root as unknown as HTMLElement,{confirm:()=>true,api:{getBodyAuthoring:async id=>state(id),chooseBodyMaterial:async()=>{throw Error('unexpected chooser');},
  researchBody:async()=>{throw Error('unexpected research');},discardBodyAdvice:async()=>{},consumeBodyAdvice:async()=>{throw Error('unexpected advice');},previewBodyBinding:async()=>{throw Error('unexpected image preview');},
  previewFixedBodyBinding:async(id,_revision,selection)=>{lastSelection=selection;if(first){first=false;return new Promise(resolve=>{releaseOld=()=>resolve(view('old',id));});}return view('new',id);},
  bodyPreviewReceipt:async r=>{if(r.phase==='stop')stops.push(r.id);},saveBodyBehavior:async()=>{throw Error('unexpected save');},changeBodyBehavior:async()=>{throw Error('unexpected change');},
  cancelBodyAuthoring:async id=>{cancelled.push(id);},onBodyPreviewCancelled:()=>()=>{}},preview:async()=>{previewCalls++;return true;}});
 const field=(id:string)=>{const x=all(root).find(n=>n.dataset.bodyField===id);assert.ok(x);return x;};
 const button=(id:string)=>{const x=all(root).find(n=>n.dataset.bodyAction===id);assert.ok(x);return x;};
 const edit=(id:string,value:string)=>{const x=field(id);x.value=value;x.oninput?.();};
 try{ui.select({id:'card1',name:'一'});const details=all(root).find(n=>n.tagName==='details')!;details.open=true;details.ontoggle?.();await tick();
  edit('binding',BODY_TWEAK_BINDING);edit('semantic','mood.happy');edit('label','保留草稿');edit('shoulder','3');edit('upper-arm','-4');edit('elbow','6');edit('strength','0.7');
  assert.equal(button('preview-fixed').disabled,false);button('preview-fixed').onclick?.();await tick();assert.ok(releaseOld);
  edit('elbow','9');await tick();await tick();assert.deepEqual(cancelled,['session-1']);
  assert.equal(field('binding').value,BODY_TWEAK_BINDING);assert.equal(field('semantic').value,'mood.happy');assert.equal(field('label').value,'保留草稿');
  assert.equal(field('shoulder').value,'3');assert.equal(field('upper-arm').value,'-4');assert.equal(field('elbow').value,'9');assert.equal(field('strength').value,'0.7');
  releaseOld!();await tick();await tick();assert.deepEqual(stops,['old']);assert.equal(previewCalls,0);
  assert.equal(button('preview-fixed').disabled,false);button('preview-fixed').onclick?.();await tick();await tick();assert.equal(previewCalls,1);
  assert.deepEqual((lastSelection as {offsets:unknown}).offsets,{shoulderOffsetDegrees:3,upperArmOffsetDegrees:-4,elbowOffsetDegrees:9});
  ui.select({id:'card2',name:'二'});await tick();assert.equal(field('label').value,'');assert.equal(field('shoulder').value,'0');
 }finally{ui.dispose();await tick();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');}
});

test('editing while the first session opens waits for its stale cancellation before opening a replacement',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const root=new Element('div'),events:string[]=[];let resolveOpening:((s:BodyVisualState)=>void)|undefined,calls=0;
 const state=(id:string):BodyVisualState=>({id,characterId:'card1',revision:0,savedRevision:0,purpose:BODY_AUTHORING_PURPOSE,connectionLabel:'synthetic',imageSupported:true,
  targetSupported:true,targetModelSha:BODY_TWEAK_TARGET,material:null,submitNonce:null,study:null,saved:{characterId:'card1',revision:0,profile:null},choices:[]});
 const ui=new PersonalizeBodyControls(root as unknown as HTMLElement,{api:{getBodyAuthoring:async()=>{calls++;events.push(`open-${calls}`);if(calls===1)return new Promise(resolve=>{resolveOpening=resolve;});return state('new');},
  chooseBodyMaterial:async()=>{throw Error('unused');},researchBody:async()=>{throw Error('unused');},discardBodyAdvice:async()=>{},consumeBodyAdvice:async()=>{throw Error('unused');},previewBodyBinding:async()=>{throw Error('unused');},previewFixedBodyBinding:async()=>{throw Error('unused');},
  bodyPreviewReceipt:async()=>{},saveBodyBehavior:async()=>{throw Error('unused');},changeBodyBehavior:async()=>{throw Error('unused');},cancelBodyAuthoring:async id=>{events.push(`cancel-${id}`);},
  onBodyPreviewCancelled:()=>()=>{}},preview:async()=>true});
 const field=(id:string)=>{const x=all(root).find(n=>n.dataset.bodyField===id);assert.ok(x);return x;};
 try{ui.select({id:'card1',name:'一'});const details=all(root).find(n=>n.tagName==='details')!;details.open=true;details.ontoggle?.();await tick();assert.ok(resolveOpening);
  field('label').value='打字中';field('label').oninput?.();field('elbow').value='8';field('elbow').oninput?.();await tick();assert.deepEqual(events,['open-1']);
  resolveOpening!(state('old'));for(let i=0;i<5;i++)await tick();assert.deepEqual(events,['open-1','cancel-old','open-2']);
  assert.equal(field('label').value,'打字中');assert.equal(field('elbow').value,'8');
 }finally{ui.dispose();await tick();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');}
});
