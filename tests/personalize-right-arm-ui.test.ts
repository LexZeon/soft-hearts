import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {PersonalizeBodyControls} from '../src/ui/PersonalizeBodyControls';import {PersonalizeBodyAuthoring} from '../electron/personalize-body-authoring';import {PersonalizeBodyStore} from '../electron/personalize-body-store';
import {BODY_TWEAK_BINDING,BODY_TWEAK_TARGET} from '../shared/personalize-body';import {bodyPoseBinding} from '../shared/personalize-body-bindings';import type {SelectedVisualImage} from '../electron/selected-visual-image';
class Element {children:Element[]=[];textContent='';value='';checked=false;disabled=false;hidden=false;open=false;className='';src='';dataset:Record<string,string>={};
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;ontoggle:(()=>void)|null=null;constructor(readonly tagName:string){}
 append(...nodes:Element[]){this.children.push(...nodes);}replaceChildren(...nodes:Element[]){this.children=[...nodes];}setAttribute(_name:string,_value:string){} }
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];
async function fixture(run:(f:Awaited<ReturnType<typeof make>>)=>Promise<void>){const f=await make();try{await run(f);}finally{await f.close();}}
async function make(){
 const dir=await mkdtemp(path.join(os.tmpdir(),'soft-right-arm-ui-')),card=randomUUID(),owner=7,base=bodyPoseBinding(BODY_TWEAK_BINDING,BODY_TWEAK_TARGET)!;
 const store=new PersonalizeBodyStore(dir,()=>[card]);await store.load();let calls=0,previews=0,saves=0,lastIndices:number[]=[],listener:((v:{id:string;token:string})=>void)|undefined;
 const pending:Promise<unknown>[]=[],track=<T>(p:Promise<T>)=>{pending.push(p);void p.catch(()=>{});return p;};
 const joint=(offsetDegrees:number|null,sufficiency='sufficient')=>({offsetDegrees,sufficiency});
 const service=new PersonalizeBodyAuthoring(store,{context:()=>({characterId:card,identity:'ctx',codex:true,imageSupported:true,connectionLabel:'synthetic',modelUrl:'mmd-asset://synthetic'}),
  verifyTarget:async()=>BODY_TWEAK_TARGET,choices:()=>[base],binding:bodyPoseBinding,
  chooseImage:async()=>({dataUrl:'data:image/jpeg;base64,AA==',previewDataUrl:'data:image/jpeg;base64,AA==',sha256:'c'.repeat(64),width:1,height:1,release:()=>{}} as SelectedVisualImage),
  reserve:()=>()=>{},stream:async(_p,_i,_s,append)=>{calls++;append(JSON.stringify({observations:[],inferences:[],questions:[],insufficient:'未知',
   advice:{subjectLeft:'unambiguous',shoulder:joint(1),upperArm:joint(null,'uncertain'),elbow:joint(-2),reason:'左',unknowns:'未知'},
   rightAdvice:{subjectRight:'unambiguous',shoulder:joint(3),upperArm:joint(null,'uncertain'),elbow:joint(-4),reason:'右',unknowns:'未知'},headAdvice:{offsetDegrees:6,sufficiency:'sufficient',referenceSufficiency:'sufficient',reason:'头',unknowns:'未知'},torsoAdvice:{offsetDegrees:-3,sufficiency:'sufficient',referenceSufficiency:'sufficient',reason:'躯干',unknowns:'未知'}}));},
  previewCancelled:(_owner,id,token)=>listener?.({id,token}),changed:()=>{}});
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const root=new Element('div'),ui=new PersonalizeBodyControls(root as unknown as HTMLElement,{confirm:()=>true,api:{getBodyAuthoring:id=>track(service.get(owner,id)),
  chooseBodyMaterial:(id,r)=>track(service.choose(owner,id,r)),researchBody:r=>track(service.research(owner,r)),discardBodyAdvice:(id,r)=>track(Promise.resolve().then(()=>service.discardAdvice(owner,id,r))),
  consumeBodyAdvice:(id,r,c,side)=>track(service.consumeAdvice(owner,id,r,c,side)),previewBodyBinding:(id,r,v)=>track(service.preview(owner,id,r,v)),previewFixedBodyBinding:(id,r,v)=>track(service.previewFixed(owner,id,r,v)),
  bodyPreviewReceipt:r=>track(Promise.resolve().then(()=>service.receipt(owner,r))),saveBodyBehavior:r=>{saves++;return track(service.save(owner,r));},changeBodyBehavior:r=>track(service.change(owner,r)),
  cancelBodyAuthoring:id=>track(Promise.resolve().then(()=>service.close(owner,id))),onBodyPreviewCancelled:callback=>{listener=callback;return()=>{listener=undefined;};}},
  preview:value=>track((async()=>{previews++;service.receipt(owner,{phase:'bind',id:value.id,token:value.token,stageGeneration:3});
   const b=await service.resolve(owner,value.id,value.token,3);lastIndices=b.properties.map(x=>x.boneIndex);
   service.receipt(owner,{phase:'ready',id:value.id,token:value.token,stageGeneration:3});return true;})())});
 const settle=async()=>{for(let i=0;i<12;i++){const n=pending.length;await Promise.allSettled([...pending]);await new Promise(resolve=>setImmediate(resolve));if(n===pending.length)return;}throw Error('not settled');};
 const field=(id:string)=>{const n=all(root).find(x=>x.dataset.bodyField===id);assert.ok(n);return n;};const button=(id:string)=>{const n=all(root).find(x=>x.dataset.bodyAction===id);assert.ok(n);return n;};
 const click=async(id:string)=>{const b=button(id);assert.equal(b.disabled,false,id);b.onclick?.();await settle();};const edit=(id:string,value:string)=>{const f=field(id);f.value=value;f.oninput?.();};
 const toggle=(value:boolean)=>{const f=field('right-enabled');f.checked=value;f.oninput?.();};
 const open=async()=>{ui.select({id:card,name:'合成角色'});const details=all(root).find(n=>n.tagName==='details')!;details.open=true;details.ontoggle?.();await settle();
  edit('binding',BODY_TWEAK_BINDING);edit('semantic','mood.happy');edit('label','组合');};
 return {dir,card,store,ui,field,button,click,edit,toggle,open,settle,get calls(){return calls;},get previews(){return previews;},get saves(){return saves;},get indices(){return lastIndices;},
  close:async()=>{ui.dispose();service.invalidate();await settle();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');
   assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('soft-right-arm-ui-'));await rm(dir,{recursive:true,force:true});}};
}
test('left-only save omits right; explicit right survives left edits and can be cleared/undone',async()=>fixture(async f=>{
 await f.open();assert.equal(f.field('right-enabled').checked,false);await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21]);await f.click('save');
 assert.equal(f.store.get(f.card).profile?.right,undefined);const old=JSON.parse(await readFile(path.join(f.dir,'personalize-body.json'),'utf8'));assert.equal(Object.hasOwn(old.entries[0].profile,'right'),false);
 f.toggle(true);f.edit('right-upper-arm','8');f.edit('right-elbow','-4');f.edit('right-strength','0.8');await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21,27,30]);await f.click('save');
 const savedRight=f.store.get(f.card).profile!.right;assert.equal(savedRight?.enabled,true);assert.equal(savedRight?.strength,.8);
 f.edit('shoulder','3');await f.click('preview-fixed');await f.click('save');assert.deepEqual(f.store.get(f.card).profile?.right,savedRight);
 await f.click('clear-right');await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21]);await f.click('save');assert.equal(f.store.get(f.card).profile?.right?.enabled,false);
 await f.click('undo');assert.deepEqual(f.store.get(f.card).profile?.right,savedRight);assert.equal(f.field('right-enabled').checked,true);
}));
test('one explicit both-side fill preserves null fields, both strengths and right participation',async()=>fixture(async f=>{
 await f.open();f.edit('shoulder','4');f.edit('upper-arm','-5');f.edit('elbow','6');f.edit('strength','0.7');
 f.edit('right-shoulder','7');f.edit('right-upper-arm','8');f.edit('right-elbow','9');f.edit('right-strength','0.3');
 assert.equal(f.field('right-enabled').checked,false);await f.click('choose');await f.click('research');assert.equal(f.calls,1);assert.equal(f.previews,0);assert.equal(f.saves,0);
 await f.click('fill-both');assert.equal(f.field('shoulder').value,'1');assert.equal(f.field('upper-arm').value,'-5');assert.equal(f.field('elbow').value,'-2');
 assert.equal(f.field('right-shoulder').value,'3');assert.equal(f.field('right-upper-arm').value,'8');assert.equal(f.field('right-elbow').value,'-4');
 assert.equal(f.field('strength').value,'0.7');assert.equal(f.field('right-strength').value,'0.3');assert.equal(f.field('right-enabled').checked,false);
 assert.equal(f.previews,0);assert.equal(f.saves,0);assert.equal(f.store.get(f.card).profile,null);assert.equal(f.button('fill-both').disabled,true);
}));
test('head advice only fills a draft, does not enable or persist head until explicitly enabled',async()=>fixture(async f=>{
 await f.open();await f.click('choose');await f.click('research');await f.click('fill-head');
 assert.equal(f.field('head-offset').value,'6');assert.equal(f.field('head-enabled').checked,false);assert.equal(f.previews,0);assert.equal(f.saves,0);
 await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21]);await f.click('save');assert.equal(f.store.get(f.card).profile?.head,undefined);
 f.field('head-enabled').checked=true;f.field('head-enabled').oninput?.();await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21,9]);await f.click('save');
 assert.equal(f.store.get(f.card).profile?.head?.enabled,true);assert.equal(f.store.get(f.card).profile?.head?.offsetDegrees,6);
 await f.click('clear-head');await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21]);await f.click('save');assert.equal(f.store.get(f.card).profile?.head?.enabled,false);
}));
test('torso advice only fills draft and explicit enable saves it while head and arms remain',async()=>fixture(async f=>{
 await f.open();await f.click('choose');await f.click('research');await f.click('fill-torso');
 assert.equal(f.field('torso-offset').value,'-3');assert.equal(f.field('torso-enabled').checked,false);assert.equal(f.previews,0);assert.equal(f.saves,0);
 await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21]);await f.click('save');assert.equal(f.store.get(f.card).profile?.torso,undefined);
 f.field('torso-enabled').checked=true;f.field('torso-enabled').oninput?.();await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21,5]);await f.click('save');
 const prior=f.store.get(f.card).profile!.torso;assert.equal(prior?.enabled,true);assert.equal(prior?.offsetDegrees,-3);
 f.edit('shoulder','2');await f.click('preview-fixed');await f.click('save');assert.deepEqual(f.store.get(f.card).profile?.torso,prior);
 await f.click('clear-torso');await f.click('preview-fixed');assert.deepEqual(f.indices,[17,18,21]);await f.click('save');assert.equal(f.store.get(f.card).profile?.torso?.enabled,false);
}));
