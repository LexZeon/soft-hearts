import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {PersonalizeBodyControls} from '../src/ui/PersonalizeBodyControls';import {PersonalizeBodyAuthoring} from '../electron/personalize-body-authoring';
import {PersonalizeBodyStore} from '../electron/personalize-body-store';import {BODY_AUTHORING_PURPOSE,BODY_TWEAK_BINDING,BODY_TWEAK_TARGET,type BodyAdviceFill,type BodyVisualState} from '../shared/personalize-body';
import {bodyPoseBinding} from '../shared/personalize-body-bindings';import type {SelectedVisualImage} from '../electron/selected-visual-image';
class Element {children:Element[]=[];textContent='';value='';disabled=false;hidden=false;open=false;className='';src='';dataset:Record<string,string>={};
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;ontoggle:(()=>void)|null=null;constructor(readonly tagName:string){}
 append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(...nodes:Element[]){this.children=[...nodes];}setAttribute(_name:string,_value:string){} }
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];
test('explicit suggestion fill merges only known offsets; preview and save remain separate user actions',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'soft-body-advice-ui-')),card=randomUUID(),owner=7,base=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!;
 const store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();let sends=0,previews=0,saves=0,listener:((v:{id:string;token:string})=>void)|undefined;
 const pending:Promise<unknown>[]=[],track=<T>(p:Promise<T>)=>{pending.push(p);void p.catch(()=>{});return p;};
 const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:'ctx',codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://synthetic'}),
  verifyTarget:async()=>BODY_TWEAK_TARGET,choices:()=>[base],binding:bodyPoseBinding,
  chooseImage:async()=>({dataUrl:'data:image/jpeg;base64,AA==',previewDataUrl:'data:image/jpeg;base64,AA==',sha256:'c'.repeat(64),width:1,height:1,release:()=>{}} as SelectedVisualImage),
  reserve:()=>()=>{},stream:async(_prompt,_image,_signal,append)=>{sends++;append(JSON.stringify({observations:[],inferences:[],questions:[],insufficient:'深度未知',advice:{subjectLeft:'unambiguous',
   shoulder:{offsetDegrees:5,sufficiency:'sufficient'},upperArm:{offsetDegrees:null,sufficiency:'uncertain'},elbow:{offsetDegrees:-3,sufficiency:'sufficient'},reason:'近似',unknowns:'遮挡'}}));},
  previewCancelled:(_owner,id,token)=>listener?.({id,token}),changed:()=>{}});
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const root=new Element('div'),ui=new PersonalizeBodyControls(root as unknown as HTMLElement,{confirm:()=>true,api:{getBodyAuthoring:id=>track(service.get(owner,id)),
  chooseBodyMaterial:(id,r)=>track(service.choose(owner,id,r)),researchBody:r=>track(service.research(owner,r)),
  discardBodyAdvice:(id,r)=>track(Promise.resolve().then(()=>service.discardAdvice(owner,id,r))),consumeBodyAdvice:(id,r,c)=>track(service.consumeAdvice(owner,id,r,c)),
  previewBodyBinding:(id,r,v)=>track(service.preview(owner,id,r,v)),previewFixedBodyBinding:(id,r,v)=>track(service.previewFixed(owner,id,r,v)),
  bodyPreviewReceipt:r=>track(Promise.resolve().then(()=>service.receipt(owner,r))),saveBodyBehavior:r=>{saves++;return track(service.save(owner,r));},
  changeBodyBehavior:r=>track(service.change(owner,r)),cancelBodyAuthoring:id=>track(Promise.resolve().then(()=>service.close(owner,id))),
  onBodyPreviewCancelled:callback=>{listener=callback;return()=>{listener=undefined;};}},preview:value=>track((async()=>{previews++;
   service.receipt(owner,{phase:'bind',id:value.id,token:value.token,stageGeneration:3});await service.resolve(owner,value.id,value.token,3);
   service.receipt(owner,{phase:'ready',id:value.id,token:value.token,stageGeneration:3});return true;})())});
 const settle=async()=>{for(let i=0;i<12;i++){const n=pending.length;await Promise.allSettled([...pending]);await new Promise(resolve=>setImmediate(resolve));if(n===pending.length)return;}throw Error('not settled');};
 const field=(id:string)=>{const n=all(root).find(x=>x.dataset.bodyField===id);assert.ok(n);return n;};const button=(id:string)=>{const n=all(root).find(x=>x.dataset.bodyAction===id);assert.ok(n);return n;};
 const click=async(id:string)=>{const b=button(id);assert.equal(b.disabled,false,id);b.onclick?.();await settle();};const edit=(id:string,value:string)=>{const f=field(id);f.value=value;f.oninput?.();};
 try{ui.select({id:card,name:'合成角色'});const details=all(root).find(n=>n.tagName==='details')!;details.open=true;details.ontoggle?.();await settle();
  edit('binding',BODY_TWEAK_BINDING);edit('semantic','mood.happy');edit('label','候选');edit('shoulder','1');edit('upper-arm','-4');edit('elbow','2');edit('strength','0.7');
  await click('choose');await click('research');assert.equal(sends,1);assert.equal(field('shoulder').value,'1');assert.equal(previews,0);assert.equal(saves,0);
  assert.ok(all(root).some(n=>n.textContent.includes('模型自述')));await click('discard-advice');assert.equal(field('shoulder').value,'1');assert.equal(field('strength').value,'0.7');
  await click('research');assert.equal(sends,2);await click('fill-advice');
  assert.equal(field('shoulder').value,'5');assert.equal(field('upper-arm').value,'-4');assert.equal(field('elbow').value,'-3');assert.equal(field('strength').value,'0.7');
  assert.equal(button('fill-advice').disabled,true);assert.equal(previews,0);assert.equal(saves,0);assert.equal(store.get(card).profile,null);
  await click('preview-fixed');assert.equal(previews,1);await click('save');assert.equal(saves,1);assert.equal(store.get(card).profile?.strength,.7);
 }finally{ui.dispose();service.invalidate();await settle();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-body-advice-ui-'));await rm(dir,{recursive:true,force:true});}
});

test('a late suggestion-fill response cannot overwrite an edit made while it was pending',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const root=new Element('div');let opens=0,previews=0,resolveFill:((value:BodyAdviceFill)=>void)|undefined;const cancelled:string[]=[];
 const state=():BodyVisualState=>({id:`session-${++opens}`,characterId:'card1',revision:0,savedRevision:0,purpose:BODY_AUTHORING_PURPOSE,connectionLabel:'synthetic',imageSupported:true,
  targetSupported:true,targetModelSha:BODY_TWEAK_TARGET,material:null,submitNonce:null,study:null,saved:{characterId:'card1',revision:0,profile:null},choices:[],
  advice:opens===1?{id:'candidate',suggestion:{subjectLeft:'unambiguous',shoulder:{offsetDegrees:2,sufficiency:'sufficient'},upperArm:{offsetDegrees:null,sufficiency:'uncertain'},
   elbow:{offsetDegrees:-3,sufficiency:'sufficient'},reason:'近似',unknowns:'未知'}}:null});
 const ui=new PersonalizeBodyControls(root as unknown as HTMLElement,{api:{getBodyAuthoring:async()=>state(),chooseBodyMaterial:async()=>{throw Error('unused');},researchBody:async()=>{throw Error('unused');},
  discardBodyAdvice:async()=>{},consumeBodyAdvice:async()=>new Promise(resolve=>{resolveFill=resolve;}),previewBodyBinding:async()=>{throw Error('unused');},previewFixedBodyBinding:async()=>{throw Error('unused');},
  bodyPreviewReceipt:async()=>{},saveBodyBehavior:async()=>{throw Error('unused');},changeBodyBehavior:async()=>{throw Error('unused');},cancelBodyAuthoring:async id=>{cancelled.push(id);},
  onBodyPreviewCancelled:()=>()=>{}},preview:async()=>{previews++;return true;}});
 const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));const field=(id:string)=>{const n=all(root).find(x=>x.dataset.bodyField===id);assert.ok(n);return n;};
 try{ui.select({id:'card1',name:'一'});const details=all(root).find(n=>n.tagName==='details')!;details.open=true;details.ontoggle?.();await tick();
  const fill=all(root).find(n=>n.dataset.bodyAction==='fill-advice')!;assert.equal(fill.disabled,false);fill.onclick?.();await tick();assert.ok(resolveFill);
  field('elbow').value='8';field('elbow').oninput?.();await tick();await tick();assert.deepEqual(cancelled,['session-1']);
  resolveFill!({revision:1,shoulderOffsetDegrees:2,upperArmOffsetDegrees:null,elbowOffsetDegrees:-3});await tick();await tick();
  assert.equal(field('elbow').value,'8');assert.equal(field('shoulder').value,'0');assert.equal(previews,0);
 }finally{ui.dispose();await tick();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');}
});
