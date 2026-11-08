import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {PersonalizeBodyControls} from '../src/ui/PersonalizeBodyControls';
import {PersonalizeBodyAuthoring} from '../electron/personalize-body-authoring';import {PersonalizeBodyStore} from '../electron/personalize-body-store';
import {BODY_TWEAK_BASE,BODY_TWEAK_BINDING,BODY_TWEAK_TARGET} from '../shared/personalize-body';import {bodyPoseBinding} from '../shared/personalize-body-bindings';
class Element {children:Element[]=[];textContent='';value='';disabled=false;hidden=false;open=false;className='';src='';dataset:Record<string,string>={};
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;ontoggle:(()=>void)|null=null;constructor(readonly tagName:string){}
 append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(...nodes:Element[]){this.children=[...nodes];}setAttribute(_name:string,_value:string){} }
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];
test('controls reopen fixed value without writing; user edits, previews, saves, reopens and resets draft only',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'soft-body-tweak-ui-')),card=randomUUID(),owner=7,base=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!;
 const fixed={enabled:true,bindingId:BODY_TWEAK_BINDING,semantic:'mood.happy',label:'固定',strength:.5,targetModelSha:BODY_TWEAK_TARGET,sourceSha:BODY_TWEAK_BASE} as const;
 const store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();await store.save(card,fixed,0);
 const file=path.join(dir,'personalize-body.json'),before=await readFile(file,'utf8');let sends=0,listener:((v:{id:string;token:string})=>void)|undefined;
 const pending:Promise<unknown>[]=[],track=<T>(p:Promise<T>)=>{pending.push(p);void p.catch(()=>{});return p;};
 const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:'ctx',codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://synthetic'}),
  verifyTarget:async()=>BODY_TWEAK_TARGET,choices:()=>[base],binding:(id,sha)=>bodyPoseBinding(id,sha),chooseImage:async()=>null,reserve:()=>()=>{},
  stream:async()=>{sends++;},previewCancelled:(_owner,id,token)=>listener?.({id,token}),changed:()=>{}});
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const root=new Element('div');let observedStrength=-1;
 const ui=new PersonalizeBodyControls(root as unknown as HTMLElement,{confirm:()=>true,api:{getBodyAuthoring:id=>track(service.get(owner,id)),
  chooseBodyMaterial:(id,revision)=>track(service.choose(owner,id,revision)),researchBody:r=>track(service.research(owner,r)),
  discardBodyAdvice:(id,revision)=>track(Promise.resolve().then(()=>service.discardAdvice(owner,id,revision))),consumeBodyAdvice:(id,revision,candidate)=>track(service.consumeAdvice(owner,id,revision,candidate)),
  previewBodyBinding:(id,revision,s)=>track(service.preview(owner,id,revision,s)),previewFixedBodyBinding:(id,revision,s)=>track(service.previewFixed(owner,id,revision,s)),
  bodyPreviewReceipt:r=>track(Promise.resolve().then(()=>service.receipt(owner,r))),saveBodyBehavior:r=>track(service.save(owner,r)),
  changeBodyBehavior:r=>track(service.change(owner,r)),cancelBodyAuthoring:id=>track(Promise.resolve().then(()=>service.close(owner,id))),
  onBodyPreviewCancelled:callback=>{listener=callback;return()=>{listener=undefined;};}},
  preview:value=>track((async()=>{service.receipt(owner,{phase:'bind',id:value.id,token:value.token,stageGeneration:3});
   const result=await service.resolve(owner,value.id,value.token,3);observedStrength=result.qualifiedStrength;
   service.receipt(owner,{phase:'ready',id:value.id,token:value.token,stageGeneration:3});return true;})())});
 const settle=async()=>{for(let i=0;i<12;i++){const n=pending.length;await Promise.allSettled([...pending]);await new Promise(resolve=>setImmediate(resolve));if(n===pending.length)return;}throw Error('not settled');};
 const field=(id:string)=>{const n=all(root).find(x=>x.dataset.bodyField===id);assert.ok(n);return n;};
 const button=(id:string)=>{const n=all(root).find(x=>x.dataset.bodyAction===id);assert.ok(n);return n;};
 const click=async(id:string)=>{const b=button(id);assert.equal(b.disabled,false,id);b.onclick?.();await settle();};
 const edit=(id:string,value:string)=>{const f=field(id);f.value=value;f.oninput?.();};
 try{ui.select({id:card,name:'合成角色'});const details=all(root).find(n=>n.tagName==='details')!;details.open=true;details.ontoggle?.();await settle();
  assert.equal(field('shoulder').value,'0');assert.equal(field('strength').value,'0.5');assert.equal(await readFile(file,'utf8'),before);
  edit('shoulder','10');edit('upper-arm','-10');edit('elbow','7');edit('strength','1');
  await click('preview-fixed');assert.equal(observedStrength,1);assert.equal(sends,0);await click('save');
  assert.equal(store.get(card).profile?.tweak?.shoulderOffsetDegrees,10);assert.equal(store.get(card).profile?.strength,1);
  await click('disable');assert.equal(store.get(card).profile?.enabled,false);await click('undo');assert.equal(store.get(card).profile?.enabled,true);
  assert.equal(field('shoulder').value,'10');assert.equal(field('strength').value,'1');
  details.open=false;details.ontoggle?.();await settle();details.open=true;details.ontoggle?.();await settle();
  assert.equal(field('shoulder').value,'10');assert.equal(field('upper-arm').value,'-10');assert.equal(field('elbow').value,'7');assert.equal(field('strength').value,'1');
  const saved=await readFile(file,'utf8');await click('reset');assert.equal(field('shoulder').value,'0');assert.equal(field('strength').value,'0.5');
  assert.equal(await readFile(file,'utf8'),saved);assert.equal(sends,0);
 }finally{ui.dispose();service.invalidate();await settle();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');
  assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-body-tweak-ui-'));await rm(dir,{recursive:true,force:true});}
});
