import { uiText, uiTemplate } from '../src/ui/ui-language';
import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {ProfileViewGate} from '../src/ui/ProfileViewGate';

const sample=(scopeId:string,generation:number,revision=0,text='原始信息')=>({scopeId,generation,revision,enabled:false,entries:[{id:'one',kind:'pending_inference' as const,text,manual:false,source:{requestId:'r',messageId:'m',quote:'<script>原文</script>'},createdAt:1,updatedAt:1}],diary:[]});
function deferred<T>() { let resolve!:(v:T)=>void,reject!:(v:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}; }
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
class Element {
  children:Element[]=[];textContent='';hidden=false;disabled=false;value='';checked=false;dataset:Record<string,string>={};attrs:Record<string,string>={};onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;onchange:(()=>void)|null=null;
  constructor(public tagName:string,public ownerDocument:any){}
  append(...nodes:Element[]){this.children.push(...nodes)} replaceChildren(...nodes:Element[]){this.children=nodes} setAttribute(k:string,v:string){this.attrs[k]=v} addEventListener(){} removeEventListener(){} focus(){}
}
const doc={createElement:(tag:string)=>new Element(tag,doc)};
const find=(root:Element,p:(e:Element)=>boolean):Element|undefined=>p(root)?root:root.children.map(c=>find(c,p)).find(Boolean);
const texts=(root:Element):string=>[root.textContent,...root.children.map(texts)].join('|');
const button=(root:Element,label:string)=>{const b=find(root,n=>n.tagName==='button'&&n.textContent===label);assert.ok(b,label);return b;};
function PanelCtor(){
  const source=readFileSync(new URL('../src/ui/UserProfilePanel.ts',import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'').replace('export class UserProfilePanel','class UserProfilePanel');
  const js=transformSync(source,{loader:'ts',target:'es2022'}).code;
  return new Function('ProfileViewGate','uiText','uiTemplate',`${js};return UserProfilePanel`)(ProfileViewGate,uiText,uiTemplate);
}
test('snapshot and late scope updates cannot restore invalidated data',()=>{
  const gate=new ProfileViewGate(),initial=gate.sequence;
  assert.ok(gate.event(sample('A',1)));assert.equal(gate.snapshot(initial,sample('B',0)),false);
  assert.ok(gate.event(null));assert.equal(gate.view,null);assert.equal(gate.event(sample('A',1)),false);
  assert.ok(gate.event(sample('B',2)));assert.equal(gate.response('A',sample('A',3)),false);assert.equal((gate.view as ReturnType<typeof sample> | null)?.scopeId,'B');
  assert.equal(gate.event(sample('B',1)),false);
});
test('panel preserves scope-local drafts and uses the original observed write identity',async()=>{
  const load=deferred<ReturnType<typeof sample>|null>(),write=deferred<ReturnType<typeof sample>>();let callback!:(v:any)=>void,unsub=0,request:any;
  const api={onUserProfileChanged:(fn:any)=>{callback=fn;return()=>{unsub++;}},getUserProfile:()=>load.promise,editUserProfile:(v:any)=>{request=v;return write.promise;},setUserProfileEnabled:()=>{throw Error('unexpected');},deleteUserProfile:()=>{throw Error('unexpected');}};
  const panel=new Element('section',doc),trigger=new Element('button',doc);panel.hidden=true;const errors:string[]=[];
  const Panel=PanelCtor(),p=new Panel(panel,trigger,api,(e:string)=>errors.push(e));p.open();
  callback(sample('A',1));load.resolve(sample('B',0));await tick();assert.ok(texts(panel).includes('原始信息')===false); // text is in a textarea, never injected as markup
  const input=find(panel,n=>n.tagName==='textarea')!;assert.equal(input.value,'原始信息');input.value='我的草稿';input.oninput?.();
  callback(sample('A',2,1,'别处的新内容'));assert.ok(texts(panel).includes('未保存修改仍保留'));assert.equal(find(panel,n=>n.tagName==='textarea')?.value,'我的草稿');
  button(panel,'保存修改').onclick?.();assert.equal(request.scopeId,'A');assert.equal(request.generation,1);assert.equal(request.revision,0);assert.equal(request.edit.text,'我的草稿');
  callback(null);assert.equal(texts(panel).includes('别处的新内容'),false);callback(sample('B',3,0,'另一角色'));write.resolve(sample('A',4,2,'我的草稿'));await tick();assert.equal(find(panel,n=>n.tagName==='textarea')?.value,'另一角色');
  callback(null);callback(sample('A',5,1,'别处的新内容'));assert.equal(find(panel,n=>n.tagName==='textarea')?.value,'我的草稿');
  assert.ok(texts(panel).includes('<script>原文</script>'));assert.equal(find(panel,n=>n.tagName==='script'),undefined);
  p.dispose();assert.equal(unsub,1);assert.equal(panel.children.length,0);assert.equal(errors.length,0);
});
test('opening is read-only, confirmation and deletion require explicit actions',async()=>{
  let callback!:(v:any)=>void,enableCalls=0,edit:any,remove:any;
  const view=sample('A',1),api={onUserProfileChanged:(fn:any)=>{callback=fn;return()=>{};},getUserProfile:async()=>view,
    setUserProfileEnabled:async(v:any)=>{enableCalls++;return {...view,generation:2,enabled:v.enabled};},
    editUserProfile:async(v:any)=>{edit=v;return {...view,generation:3,revision:1,entries:[{...view.entries[0],kind:v.edit.kind,text:v.edit.text}]};},
    deleteUserProfile:async(v:any)=>{remove=v;return {...view,generation:4,revision:2,entries:[]};}};
  const panel=new Element('section',doc),trigger=new Element('button',doc);panel.hidden=true;const Panel=PanelCtor(),p=new Panel(panel,trigger,api,()=>{});
  await tick();p.open();assert.equal(enableCalls,0);assert.equal(find(panel,n=>n.tagName==='input')?.checked,false);
  const select=find(panel,n=>n.tagName==='select')!;assert.equal(select.value,'pending_inference');select.value='fact';select.onchange?.();button(panel,'保存修改').onclick?.();await tick();
  assert.equal(edit.edit.kind,'fact');assert.equal(edit.generation,1);assert.equal(edit.revision,0);assert.equal(enableCalls,0);
  button(panel,'删除').onclick?.();assert.equal(remove,undefined);button(panel,'确认删除').onclick?.();await tick();assert.equal((remove as any).id,'one');assert.equal((remove as any).revision,1);
  callback(null);p.dispose();
});
test('the recording switch changes only on an explicit request and follows host response',async()=>{
  const view=sample('A',1);let request:any;
  const api={onUserProfileChanged:()=>()=>{},getUserProfile:async()=>view,setUserProfileEnabled:async(v:any)=>{request=v;return {...view,enabled:true,generation:2};},editUserProfile:()=>{throw Error('unexpected');},deleteUserProfile:()=>{throw Error('unexpected');}};
  const panel=new Element('section',doc),trigger=new Element('button',doc);panel.hidden=true;const Panel=PanelCtor(),p=new Panel(panel,trigger,api,()=>{});await tick();p.open();
  const checkbox=find(panel,n=>n.tagName==='input')!;assert.equal(checkbox.checked,false);checkbox.checked=true;checkbox.onchange?.();await tick();
  assert.deepEqual(request,{scopeId:'A',generation:1,revision:0,enabled:true});assert.equal(find(panel,n=>n.tagName==='input')?.checked,true);p.dispose();
});

test('English profile panel preserves private text that matches an interface key and keeps recording off',async()=>{
 registerUiMessages({en:ENGLISH_SETTINGS_UI_COPY,'zh-CN':{}});setUiLanguage('en');
 let callback!:(v:any)=>void;const privateText='保存修改'.repeat(50);let writes=0;
 const api={onUserProfileChanged:(fn:any)=>{callback=fn;return()=>{};},getUserProfile:async()=>sample('A',1,0,privateText),editUserProfile:async()=>{writes++;return sample('A',1);},setUserProfileEnabled:async()=>{writes++;return sample('A',1);},deleteUserProfile:async()=>{writes++;return sample('A',1);}};
 const panel=new Element('section',doc),trigger=new Element('button',doc),Panel=PanelCtor(),p=new Panel(panel,trigger,api,()=>{});
 try{await tick();p.open();assert.ok(texts(panel).includes('About you'));assert.ok(texts(panel).includes('Profile recording: off'));
 assert.equal(find(panel,n=>n.tagName==='textarea')!.value,privateText);assert.equal(writes,0);
 assert.ok(find(panel,n=>n.tagName==='option'&&n.value==='pending_inference'&&n.textContent==='Unconfirmed inference'));
 }finally{p.dispose();setUiLanguage('zh-CN');}
});
