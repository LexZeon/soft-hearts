import test from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,readFile } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { PersonalizeLanguageControls } from '../src/ui/PersonalizeLanguageControls';
import { PersonalizeLanguageStore } from '../electron/personalize-language';import { PersonalizeAuthoring } from '../electron/personalize-authoring';
import { emptyLanguageRules } from '../shared/personalize-language';import { atomicWriteFile } from '../electron/atomic-file';
class Element {
 children:Element[]=[];textContent='';value='';disabled=false;dataset:Record<string,string>={};open=true;
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;ontoggle:(()=>void)|null=null;
 constructor(readonly tagName:string){}append(...n:Element[]){this.children.push(...n);}setAttribute(){}
}
const all=(n:Element):Element[]=>[n,...n.children.flatMap(all)];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
async function fixture(run:(f:Awaited<ReturnType<typeof make>>)=>Promise<void>){const f=await make();try{await run(f);}finally{await f.close();}}
async function make(){
 const directory=await mkdtemp(path.join(os.tmpdir(),'soft-authoring-ui-')),a=randomUUID(),b=randomUUID(),root=new Element('div');
 let active=a,gate:Promise<void>|null=null,fail=false,runs=0,answer='合成候选：日常短句',listener:((v:any)=>void)|null=null;
 const store=new PersonalizeLanguageStore(directory,()=>[a,b],async(file,data)=>{if(fail)throw Error('synthetic save failure');await atomicWriteFile(file,data);});await store.load();
 let lease:AbortController|null=null;const prompts:string[]=[],pending:Promise<unknown>[]=[];
 const service=new PersonalizeAuthoring({context:()=>({characterId:active,identity:active,codex:true}),savedRevision:id=>store.get(id).revision,
  reserve:(_owner,_id,controller)=>{if(lease)throw Error('synthetic chat busy');lease=controller;return()=>{lease=null;};},
  stream:async(prompt,_signal,append)=>{runs++;prompts.push(prompt);if(gate)await gate;append(JSON.stringify({observations:[{quote:'你好呀',finding:'亲切句尾'}],inferences:['可能使用短句'],questions:['日常还是特殊场景？'],insufficient:'仅合成接口验证',rules:{...emptyLanguageRules(),tone:answer}}));},
 });
 const track=<T>(p:Promise<T>)=>{pending.push(p);return p;};const errors:string[]=[],confirmations:string[]=[];
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const ui=new PersonalizeLanguageControls(root as unknown as HTMLElement,{confirm:text=>{confirmations.push(text);return true;},onError:text=>errors.push(text),api:{
  getPersonalizeLanguage:async id=>store.get(id),onPersonalizeLanguage:fn=>{listener=fn;return()=>{listener=null;};},
  savePersonalizeLanguage:(id,profile,revision)=>track((async()=>{const value=await store.save(id,profile,revision);service.invalidate();listener?.(value);return value;})()),
  undoPersonalizeLanguage:(id,revision)=>track((async()=>{const value=await store.undo(id,revision);service.invalidate();listener?.(value);return value;})()),
  openLanguageAuthoring:async(id,revision)=>service.open(7,id,revision),researchLanguage:value=>track(service.research(7,value)),
  cancelLanguageAuthoring:async id=>service.close(7,id),closeLanguageAuthoring:async id=>service.close(7,id),
 }});
 const find=(key:string,value:string)=>{const n=all(root).find(n=>n.dataset[key]===value);assert.ok(n,`${key}:${value}`);return n;};
 const settle=async()=>{for(let n=0;n<3;n++){await Promise.allSettled([...pending]);for(let k=0;k<10;k++)await Promise.resolve();}};
 const select=(id=a)=>{active=id;ui.select({id,name:id===a?'合成A':'合成B'});};
 const type=(key:string,field:string,value:string)=>{const n=find(key,field);assert.equal(n.disabled,false);n.value=value;n.oninput?.();};
 const click=(key:string,action:string)=>{const n=find(key,action);assert.equal(n.disabled,false);n.onclick?.();};
 const f={a,b,root,ui,store,directory,errors,confirmations,prompts,select,settle,find,type,click,
  gate:(v:Promise<void>|null)=>{gate=v;},fail:(v:boolean)=>{fail=v;},answer:(v:string)=>{answer=v;},get runs(){return runs;},get lease(){return lease;},
  close:async()=>{ui.dispose();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('soft-authoring-ui-'));await rm(directory,{recursive:true,force:true});},
 };select();await settle();return f;
}
test('actual editor study→question→answer→refine→edit→confirm/save→disable/undo keeps materials outside the sidecar',async()=>fixture(async f=>{
 f.type('authoringField','materials','你好呀，合成角色台词');f.click('authoringAction','research');await f.settle();
 assert.equal(f.find('languageField','tone').value,'合成候选：日常短句');assert.equal(f.store.get(f.a).revision,0);
 assert.ok(all(f.root).some(n=>n.tagName==='pre'&&n.textContent.includes('日常还是特殊场景')));
 f.type('authoringField','feedback','这是日常习惯，不是特殊场景');f.answer('用户解释后：短句，不加拖长尾音');f.click('authoringAction','research');await f.settle();
 assert.equal(f.runs,2);assert.ok(f.prompts[1].includes('这是日常习惯'));assert.ok(f.prompts[1].includes('previousStudy'));
 f.type('languageField','tone','用户最终确认的短句习惯');f.click('languageAction','save');await f.settle();
 assert.equal(f.store.get(f.a).profile.rules.tone,'用户最终确认的短句习惯');assert.ok(f.confirmations[0].includes(f.a));
 const bytes=await readFile(path.join(f.directory,'personalize-language.json'),'utf8');assert.equal(bytes.includes('合成角色台词'),false);assert.equal(bytes.includes('特殊场景'),false);
 f.click('languageAction','disable');await f.settle();assert.equal(f.store.get(f.a).profile.enabled,false);
 f.click('languageAction','undo');await f.settle();assert.equal(f.store.get(f.a).profile.enabled,true);assert.equal(f.store.get(f.b).revision,0);
}));
test('editing rules during delayed study cancels and retains newer unsaved edits even if mock ignores abort',async()=>fixture(async f=>{
 const gate=deferred();f.gate(gate.promise);f.type('authoringField','materials','你好呀');f.click('authoringAction','research');for(let n=0;n<10;n++)await Promise.resolve();assert.equal(f.runs,1);
 f.type('languageField','tone','正在输入的新草稿');assert.equal(f.lease?.signal.aborted,true);gate.resolve();await f.settle();
 assert.equal(f.find('languageField','tone').value,'正在输入的新草稿');assert.equal(f.store.get(f.a).revision,0);
}));
test('card switch, explicit cancel and details close reject stale candidate without changing another card',async()=>fixture(async f=>{
 for(const kind of ['switch','cancel','close']){const gate=deferred();f.gate(gate.promise);f.select(f.a);await f.settle();f.type('authoringField','materials','你好呀');f.click('authoringAction','research');for(let n=0;n<10;n++)await Promise.resolve();
  if(kind==='switch'){f.select(f.b);for(let n=0;n<10;n++)await Promise.resolve();f.type('languageField','tone','B的草稿');}
  if(kind==='cancel')f.click('authoringAction','cancel');if(kind==='close'){const details=all(f.root).find(n=>n.tagName==='details')!;details.open=false;details.ontoggle?.();}
  gate.resolve();await f.settle();assert.equal(f.store.get(f.a).revision,0);assert.equal(f.store.get(f.b).revision,0);
  if(kind==='switch')assert.equal(f.find('languageField','tone').value,'B的草稿');
 }
}));
test('failed save preserves researched editable draft for same-card explicit retry',async()=>fixture(async f=>{
 f.type('authoringField','materials','你好呀');f.click('authoringAction','research');await f.settle();f.fail(true);f.click('languageAction','save');await f.settle();
 assert.equal(f.store.get(f.a).revision,0);assert.equal(f.find('languageField','tone').value,'合成候选：日常短句');assert.equal(f.errors.length,1);
 f.fail(false);f.click('languageAction','save');await f.settle();assert.equal(f.store.get(f.a).revision,1);
}));
