import test from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { PersonalizeBodyControls } from '../src/ui/PersonalizeBodyControls';
import { PersonalizeBodyAuthoring } from '../electron/personalize-body-authoring';import { PersonalizeBodyStore } from '../electron/personalize-body-store';
import type { BodyPoseBinding } from '../shared/personalize-body';import type { SelectedVisualImage } from '../electron/selected-visual-image';
import { bodyPoseBinding } from '../shared/personalize-body-bindings';import { BODY_TWEAK_TARGET } from '../shared/personalize-body';
class Element {children:Element[]=[];textContent='';value='';disabled=false;hidden=false;open=false;className='';src='';dataset:Record<string,string>={};
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;ontoggle:(()=>void)|null=null;constructor(readonly tagName:string){}
 append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(...nodes:Element[]){this.children=[...nodes];}setAttribute(_name:string,_value:string){} }
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];
test('actual controls require image consent and the same resolved pose preview before save',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'soft-body-ui-')),card=randomUUID(),owner=7,sha=BODY_TWEAK_TARGET;
 const binding:BodyPoseBinding=bodyPoseBinding('body.gene-left-arm-soft-bend',sha)!;
 const store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();let sends=0,confirmed=false,listener:((value:{id:string;token:string})=>void)|undefined;
 const pending:Promise<unknown>[]=[],track=<T>(p:Promise<T>)=>{pending.push(p);void p.catch(()=>{});return p;};
 const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:'context',codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://model'}),
  verifyTarget:async()=>sha,choices:()=>[binding],binding:(id,s)=>id===binding.id&&s===sha?binding:null,
  chooseImage:async()=>({dataUrl:'data:image/jpeg;base64,AA==',previewDataUrl:'data:image/jpeg;base64,AA==',width:1,height:1,sha256:'c'.repeat(64),release:()=>{}} as SelectedVisualImage),
  reserve:()=>()=>{},stream:async(_prompt,_image,_signal,append)=>{sends++;append(JSON.stringify({observations:[{region:'left-arm',visibility:'occluded',description:'遮挡'}],inferences:[],questions:['手臂？'],insufficient:'深度未知'}));},
  previewCancelled:(_owner,id,token)=>listener?.({id,token}),changed:()=>{}});
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const root=new Element('div'),ui=new PersonalizeBodyControls(root as unknown as HTMLElement,{confirm:()=>confirmed,api:{
  getBodyAuthoring:id=>track(service.get(owner,id)),chooseBodyMaterial:(id,revision)=>track(service.choose(owner,id,revision)),
  researchBody:request=>track(service.research(owner,request)),discardBodyAdvice:(id,revision)=>track(Promise.resolve().then(()=>service.discardAdvice(owner,id,revision))),
  consumeBodyAdvice:(id,revision,candidate)=>track(service.consumeAdvice(owner,id,revision,candidate)),previewBodyBinding:(id,revision,selection)=>track(service.preview(owner,id,revision,selection)),
  previewFixedBodyBinding:(id,revision,selection)=>track(service.previewFixed(owner,id,revision,selection)),
  bodyPreviewReceipt:receipt=>track(Promise.resolve().then(()=>service.receipt(owner,receipt))),
  saveBodyBehavior:request=>track(service.save(owner,request)),changeBodyBehavior:request=>track(service.change(owner,request)),
  cancelBodyAuthoring:id=>track(Promise.resolve().then(()=>service.close(owner,id))),onBodyPreviewCancelled:callback=>{listener=callback;return()=>{listener=undefined;};}},
  preview:value=>track((async()=>{assert.equal(value.mask,binding.mask);service.receipt(owner,{phase:'bind',id:value.id,token:value.token,stageGeneration:3});
   assert.deepEqual(await service.resolve(owner,value.id,value.token,3),binding);service.receipt(owner,{phase:'ready',id:value.id,token:value.token,stageGeneration:3});return true;})())});
 const settle=async()=>{for(let i=0;i<12;i++){const n=pending.length;await Promise.allSettled([...pending]);await new Promise(resolve=>setImmediate(resolve));if(n===pending.length)return;}throw Error('not settled');};
 const field=(id:string)=>{const value=all(root).find(n=>n.dataset.bodyField===id);assert.ok(value);return value;};
 const button=(id:string)=>{const value=all(root).find(n=>n.dataset.bodyAction===id);assert.ok(value);return value;};
 const click=async(id:string)=>{const value=button(id);assert.equal(value.disabled,false,id);value.onclick?.();await settle();};
 const type=(id:string,value:string)=>{const input=field(id);input.value=value;input.oninput?.();};
 try{ui.select({id:card,name:'合成角色'});const details=all(root).find(n=>n.tagName==='details')!;details.open=true;details.ontoggle?.();await settle();
  type('binding',binding.id);type('semantic','mood.happy');type('label','固定姿势');
  assert.equal(button('preview').disabled,true);await click('preview-fixed');assert.equal(sends,0);
  confirmed=true;await click('save');assert.equal(store.get(card).profile?.bindingId,binding.id);assert.equal(sends,0);confirmed=false;
  await click('choose');assert.equal(sends,0);await click('research');assert.equal(sends,0);
  confirmed=true;await click('research');assert.equal(sends,1);assert.ok(all(root).some(n=>n.textContent.includes('遮挡')));
  type('binding',binding.id);type('semantic','mood.happy');type('label','用户确认');await click('preview');await click('save');
  assert.equal(store.get(card).profile?.bindingId,binding.id);assert.equal(store.get(card).profile?.enabled,true);
 }finally{ui.dispose();service.invalidate();await settle();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-body-ui-'));await rm(dir,{recursive:true,force:true});}
});
