import test from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import { PersonalizeLanguageControls } from '../src/ui/PersonalizeLanguageControls';
import { PersonalizeLanguageStore } from '../electron/personalize-language';import { atomicWriteFile } from '../electron/atomic-file';
import { emptyLanguageRules, type LanguageProfile, type LanguageState } from '../shared/personalize-language';

class Element {
 children:Element[]=[];textContent='';value='';disabled=false;className='';dataset:Record<string,string>={};
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;
 constructor(readonly tagName:string){} append(...nodes:Element[]){this.children.push(...nodes);}setAttribute(){}
}
const all=(n:Element):Element[]=>[n,...n.children.flatMap(all)];
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
const tick=async()=>{for(let n=0;n<6;n++)await Promise.resolve();};
async function fixture(run:(f:Awaited<ReturnType<typeof make>>)=>Promise<void>){const f=await make();try{await run(f);}finally{await f.close();}}
async function make(){
 const directory=await mkdtemp(path.join(os.tmpdir(),'soft-personalize-ui-')),a=randomUUID(),b=randomUUID(),errors:string[]=[],confirms:string[]=[],pending:Promise<unknown>[]=[];
 let fail=false,listener:((state:LanguageState)=>void)|null=null,unsubscribed=0,readOverride:((id:string)=>Promise<LanguageState>)|null=null,gate:Promise<void>|null=null;
 const store=new PersonalizeLanguageStore(directory,()=>[a,b],async(file,data)=>{if(fail)throw Error('synthetic write failure');await atomicWriteFile(file,data);});await store.load();
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new Element(tag)}});
 const track=<T>(promise:Promise<T>)=>{pending.push(promise);return promise;};
 const root=new Element('div');const ui=new PersonalizeLanguageControls(root as unknown as HTMLElement,{confirm:value=>{confirms.push(value);return true;},onError:value=>errors.push(value),api:{
  getPersonalizeLanguage:id=>track(readOverride?readOverride(id):Promise.resolve(store.get(id))),
  savePersonalizeLanguage:(id,profile,revision)=>track((async()=>{if(gate)await gate;const state=await store.save(id,profile,revision);listener?.(state);return state;})()),
  undoPersonalizeLanguage:(id,revision)=>track((async()=>{const state=await store.undo(id,revision);listener?.(state);return state;})()),
  onPersonalizeLanguage:callback=>{listener=callback;return()=>{listener=null;unsubscribed++;};},
  openLanguageAuthoring:async()=>{throw Error('Legacy rule fixture must not open research');},
  researchLanguage:async()=>{throw Error('Legacy rule fixture must not research');},
  cancelLanguageAuthoring:async()=>{},closeLanguageAuthoring:async()=>{},
 }});
 const input=(field:string)=>{const n=all(root).find(n=>n.dataset.languageField===field);assert.ok(n);return n;};
 const button=(action:string)=>{const n=all(root).find(n=>n.dataset.languageAction===action);assert.ok(n);return n;};
 const settle=async()=>{await Promise.allSettled([...pending]);await tick();};
 const f={a,b,root,ui,store,directory,errors,confirms,input,button,settle,
  select:(id=a)=>ui.select({id,name:id===a?'合成角色A':'合成角色B'}),
  type:(field:string,value:string)=>{const n=input(field);assert.equal(n.disabled,false);n.value=value;n.oninput?.();},
  click:(action:string)=>{const n=button(action);assert.equal(n.disabled,false,action);n.onclick?.();},
  emit:(state:LanguageState)=>listener?.(state),fail:(value:boolean)=>{fail=value;},reads:(value:typeof readOverride)=>{readOverride=value;},gate:(value:Promise<void>|null)=>{gate=value;},get unsubscribed(){return unsubscribed;},
  close:async()=>{ui.dispose();if(original)Object.defineProperty(globalThis,'document',original);else Reflect.deleteProperty(globalThis,'document');assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('soft-personalize-ui-'));await rm(directory,{recursive:true,force:true});},
 };
 f.select();await settle();return f;
}
const profile=(tone:string):LanguageProfile=>({enabled:true,rules:{...emptyLanguageRules(),tone}});

test('actual personalize editor previews plain rules without activation; explicit save names the target card',async()=>fixture(async f=>{
 f.type('tone','温和 <img src=x onerror=alert(1)>');assert.equal(f.store.get(f.a).profile.enabled,false);
 await assert.rejects(stat(path.join(f.directory,'personalize-language.json')),/ENOENT/);
 assert.ok(all(f.root).find(n=>n.dataset.languagePreview==='rules')!.textContent.includes('<img'));
 assert.equal(all(f.root).some(n=>n.tagName==='img'),false);
 f.click('save');await f.settle();assert.equal(f.store.get(f.a).profile.enabled,true);assert.ok(f.confirms[0].includes(f.a));assert.ok(f.confirms[0].includes('合成角色A'));
 assert.equal(f.errors.length,0);
}));
test('late A read never changes B or overwrites A edits made while the read was pending',async()=>fixture(async f=>{
 const old=deferred<LanguageState>();f.reads(id=>id===f.a?old.promise:Promise.resolve(f.store.get(id)));
 f.click('reload');f.type('tone','A的新草稿');f.select(f.b);await tick();f.type('tone','B的草稿');
 old.resolve(f.store.get(f.a));await f.settle();assert.equal(f.input('tone').value,'B的草稿');
 f.select(f.a);assert.equal(f.input('tone').value,'A的新草稿');assert.equal(f.store.get(f.a).profile.enabled,false);
}));
test('external new revision and late older state preserve the draft; stale save fails until explicit reload',async()=>fixture(async f=>{
 f.type('tone','未保存的草稿');const external=await f.store.save(f.a,profile('外部新版本'),0);f.emit(external);
 f.emit({characterId:f.a,revision:0,profile:{enabled:false,rules:emptyLanguageRules()}});
 assert.equal(f.input('tone').value,'未保存的草稿');f.click('save');await f.settle();assert.equal(f.store.get(f.a).profile.rules.tone,'外部新版本');assert.equal(f.input('tone').value,'未保存的草稿');assert.equal(f.errors.length,1);
 f.click('reload');await f.settle();assert.equal(f.input('tone').value,'外部新版本');f.type('tone','重新确认');f.click('save');await f.settle();assert.equal(f.store.get(f.a).profile.rules.tone,'重新确认');
}));
test('failed actual store save retains same-card draft and allows a successful same-ID retry',async()=>fixture(async f=>{
 f.fail(true);f.type('tone','需要重试的草稿');f.click('save');await f.settle();assert.equal(f.input('tone').value,'需要重试的草稿');assert.equal(f.store.get(f.a).revision,0);assert.equal(f.errors.length,1);
 f.fail(false);f.click('save');await f.settle();assert.equal(f.store.get(f.a).revision,1);assert.equal(f.store.get(f.a).profile.rules.tone,'需要重试的草稿');
}));
test('edits and a card switch during save retain newer drafts while confirming only the captured version',async()=>fixture(async f=>{
 const gate=deferred<void>();f.gate(gate.promise);f.type('tone','已点保存的版本');f.click('save');f.type('tone','保存中继续修改');
 f.select(f.b);await tick();f.type('tone','B不能被覆盖');gate.resolve();await f.settle();assert.equal(f.input('tone').value,'B不能被覆盖');assert.equal(f.store.get(f.a).profile.rules.tone,'已点保存的版本');
 f.select(f.a);assert.equal(f.input('tone').value,'保存中继续修改');f.gate(null);f.click('save');await f.settle();assert.equal(f.store.get(f.a).profile.rules.tone,'保存中继续修改');
}));
test('disable does not silently save the draft; explicit undo restores the prior confirmed profile',async()=>fixture(async f=>{
 f.type('tone','已确认规则');f.click('save');await f.settle();f.type('tone','尚未确认规则');f.click('disable');await f.settle();
 assert.equal(f.store.get(f.a).profile.enabled,false);assert.equal(f.store.get(f.a).profile.rules.tone,'已确认规则');assert.equal(f.input('tone').value,'尚未确认规则');
 f.click('undo');await f.settle();assert.equal(f.store.get(f.a).profile.enabled,true);assert.equal(f.input('tone').value,'已确认规则');assert.equal(f.button('undo').disabled,true);assert.equal(f.store.get(f.b).revision,0);
}));
test('disposal detaches the listener and ignores a late read without writing rules',async()=>fixture(async f=>{
 const read=deferred<LanguageState>();f.reads(()=>read.promise);f.click('reload');const before=f.input('tone').value;f.ui.dispose();read.resolve(f.store.get(f.a));await f.settle();
 assert.equal(f.unsubscribed,1);assert.equal(f.input('tone').value,before);assert.equal(f.store.get(f.a).revision,0);
}));
test('newer confirmed event during a pending clean read populates the latest profile instead of an empty stale draft',async()=>fixture(async f=>{
 const before=f.store.get(f.a),read=deferred<LanguageState>();f.reads(()=>read.promise);f.click('reload');
 const newer=await f.store.save(f.a,profile('读取中到达的新确认版本'),0);f.emit(newer);read.resolve(before);await f.settle();
 assert.equal(f.input('tone').value,'读取中到达的新确认版本');assert.equal(f.errors.length,0);
 f.type('tone','在新版本上继续修改');f.click('save');await f.settle();assert.equal(f.store.get(f.a).revision,2);assert.equal(f.store.get(f.a).profile.rules.tone,'在新版本上继续修改');
}));
