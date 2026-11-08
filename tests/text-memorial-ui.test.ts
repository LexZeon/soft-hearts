import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextMemorialOfferController, TextMemorialDeliveredHistory } from '../src/ui/TextMemorialOffer';
import { TextMemorialPanel } from '../src/ui/TextMemorialPanel';
import { ProfileViewGate } from '../src/ui/ProfileViewGate';
import { trimReplyHistory } from '../src/ui/reply-history';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import type { TextMemorialEvent, TextMemorialOfferState, TextMemorialPresented, TextMemorialView } from '../shared/text-memorials';

function deferred<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
const tick=async()=>{for(let i=0;i<6;i++) await Promise.resolve();};
const offer=(id:string)=>({id,invite:'留下这句话 用于回忆',quote:'这句话',purpose:'回忆'});
const origin=(id:string)=>({kind:'proactive' as const,id,at:12345,sources:['text'] as ['text'],labels:['本次文字纪念邀请'] as ['本次文字纪念邀请']});
test('newer offer beats late null snapshot; presented broadcast before receipt commits once', async()=>{
  const snap=deferred<TextMemorialOfferState>(), ack=deferred<TextMemorialPresented|null>(); let cb!:(e:TextMemorialEvent)=>void; const calls:string[]=[];
  const ctrl=new TextMemorialOfferController({onTextMemorialEvent:f=>{cb=f;return()=>calls.push('unsub');},getCurrentTextMemorialOffer:()=>snap.promise,acknowledgeTextMemorial:async v=>{calls.push(`ack:${v.id}:${v.revision}`);return ack.promise;}},{current:()=>true,publish:async o=>{calls.push(`publish:${o.id}`);},retract:id=>calls.push(`retract:${id}`),commit:r=>calls.push(`commit:${r.offer.id}`)});
  cb({type:'offer',revision:2,offer:offer('a')}); snap.resolve({revision:1,offer:null}); await tick(); assert.deepEqual(calls,['publish:a','ack:a:2']);
  cb({type:'presented',revision:3,id:'a',offer:offer('a'),origin:origin('a')}); ack.resolve({revision:3,offer:offer('a'),context:{replyId:'a'},origin:origin('a')}); await tick(); assert.deepEqual(calls,['publish:a','ack:a:2','commit:a']); ctrl.dispose();
});
test('cancelled and superseded receipts cannot revive or retract a newer offer',async()=>{
  const a=deferred<TextMemorialPresented|null>(),b=deferred<TextMemorialPresented|null>(); let cb!:(e:TextMemorialEvent)=>void; const calls:string[]=[];
  const ctrl=new TextMemorialOfferController({onTextMemorialEvent:f=>{cb=f;return()=>{};},getCurrentTextMemorialOffer:async()=>({revision:0,offer:null}),acknowledgeTextMemorial:v=>v.id==='a'?a.promise:b.promise},{current:()=>true,publish:async o=>{calls.push(`publish:${o.id}`);},retract:id=>calls.push(`retract:${id}`),commit:r=>calls.push(`commit:${r.offer.id}`)});
  cb({type:'offer',revision:1,offer:offer('a')}); await tick(); cb({type:'cancel',revision:2,id:'a'}); cb({type:'offer',revision:3,offer:offer('b')}); await tick();
  a.resolve({revision:4,offer:offer('a'),context:{replyId:'a'},origin:origin('a')}); await tick(); assert.deepEqual(calls,['publish:a','retract:a','publish:b']);
  b.resolve({revision:4,offer:offer('b'),context:{replyId:'b'},origin:origin('b')}); await tick(); assert.deepEqual(calls,['publish:a','retract:a','publish:b','commit:b']); ctrl.dispose();
});
test('controls append only the host-presented exact invitation and origin once',()=>{
  const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8');
  const match=source.match(/const delivered = new TextMemorialDeliveredHistory\(event => \{([\s\S]*?)\n    \}\);/); assert.ok(match);
  const bodies:{textContent:string;parentElement:{querySelector:()=>{textContent:string}}}[]=[];
  const create=new Function('uiText','uiHtml','uiMarkup','uiTemplate','TextMemorialDeliveredHistory', 'addMessage', 'trimReplyHistory', `let history=[]; const characterName='Gene'; const delivered=new TextMemorialDeliveredHistory(event=>{${match[1]}});return {delivered,history:()=>history};`).bind(null, uiText, uiHtml, uiMarkup, uiTemplate);
  const flow=create(TextMemorialDeliveredHistory,()=>{const label={textContent:''}, body={textContent:'formatted',parentElement:{querySelector:()=>label}};bodies.push(body);return body;},trimReplyHistory);
  const delivered:TextMemorialDeliveredHistory=flow.delivered;
  delivered.event({type:'offer',revision:1,offer:offer('a')});
  const event={type:'presented' as const,revision:2,id:'a',offer:offer('a'),origin:origin('a')};
  delivered.event(event);delivered.event(event);delivered.event({...event,revision:3});
  delivered.event({type:'presented',revision:4,id:'wrong',offer:offer('b'),origin:origin('b')});
  assert.equal(bodies.length,1);assert.equal(bodies[0].textContent,offer('a').invite);
  assert.deepEqual(flow.history(),[{role:'assistant',content:offer('a').invite,origin:origin('a')}]);
});
class Element { children:Element[]=[]; textContent='';value='';disabled=false;hidden=false;className='';type='';maxLength=0;onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;attrs:Record<string,string>={};constructor(public tagName:string,public ownerDocument:any){} append(...xs:Element[]){this.children.push(...xs);}replaceChildren(...xs:Element[]){this.children=xs;}setAttribute(k:string,v:string){this.attrs[k]=v;}addEventListener(){}removeEventListener(){}focus(){} }
const doc={createElement:(tag:string)=>new Element(tag,doc)};
const find=(r:Element,p:(v:Element)=>boolean):Element|undefined=>p(r)?r:r.children.map(c=>find(c,p)).find(Boolean);
const button=(r:Element,label:string)=>{const x=find(r,n=>n.tagName==='button'&&n.textContent===label);assert.ok(x,label);return x;};
const view=(scopeId:string,generation:number,revision=0,text='原文'):TextMemorialView=>({scopeId,generation,revision,entries:[{id:'one',text,purpose:'回忆',createdAt:1,updatedAt:1}]});
test('management preserves draft across rerender and rejects stale scope read/write',async()=>{
  const load=deferred<TextMemorialView|null>(), edit=deferred<TextMemorialView>(); let cb!:(v:TextMemorialView|null)=>void, calls=0, req:unknown;
  const panel=new TextMemorialPanel({onTextMemorialsChanged:f=>{cb=f;return()=>{};},getTextMemorials:()=>{calls++;return load.promise;},editTextMemorial:r=>{req=r;return edit.promise;},deleteTextMemorial:async()=>{throw Error('unexpected');}},()=>{});
  panel.open(); cb(view('A',1)); load.resolve(view('old',0)); await tick();
  let root=panel.render(doc as unknown as Document) as unknown as Element;
  const text=find(root,n=>n.attrs['aria-label']==='纪念文字')!; text.value='我的草稿'; text.oninput?.();
  cb(view('A',1,1,'他处更新')); root=panel.render(doc as unknown as Document) as unknown as Element;
  assert.equal(find(root,n=>n.attrs['aria-label']==='纪念文字')?.value,'我的草稿'); button(root,'保存纪念修改').onclick?.();
  assert.deepEqual(req,{scopeId:'A',generation:1,revision:0,id:'one',text:'我的草稿',purpose:'回忆'});
  cb(null); cb(view('B',2)); edit.resolve(view('A',1,2,'我的草稿')); await tick(); root=panel.render(doc as unknown as Document) as unknown as Element;
  assert.equal(find(root,n=>n.attrs['aria-label']==='纪念文字')?.value,'原文'); assert.equal(calls,1); panel.dispose();
});
test('real profile rerender remounts memorial section without losing its draft',async()=>{
  const raw=readFileSync(new URL('../src/ui/UserProfilePanel.ts',import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'').replace('export class UserProfilePanel','class UserProfilePanel');
  const js=transformSync(raw,{loader:'ts',target:'es2022'}).code;
  const Panel=new Function('uiText','uiHtml','uiMarkup','uiTemplate','ProfileViewGate', `${js};return UserProfilePanel`).bind(null, uiText, uiHtml, uiMarkup, uiTemplate)(ProfileViewGate);
  let profileEvent!:(v:any)=>void, memorialEvent!:(v:TextMemorialView|null)=>void;
  const root=new Element('section',doc), trigger=new Element('button',doc);root.hidden=true;
  const profile=new Panel(root,trigger,{onUserProfileChanged:(f:any)=>{profileEvent=f;return()=>{};},getUserProfile:async()=>null},()=>{});
  const memorial=new TextMemorialPanel({onTextMemorialsChanged:f=>{memorialEvent=f;return()=>{};},getTextMemorials:async()=>view('A',1),editTextMemorial:async()=>{throw Error('unused');},deleteTextMemorial:async()=>{throw Error('unused');}},()=>profile.refreshMemorials());
  profile.setMemorials(memorial);profile.open(); await tick();
  let input=find(root,n=>n.attrs['aria-label']==='纪念文字')!; input.value='保留我的草稿';input.oninput?.();
  profileEvent({scopeId:'A',generation:1,revision:0,enabled:false,entries:[]});
  input=find(root,n=>n.attrs['aria-label']==='纪念文字')!;assert.equal(input.value,'保留我的草稿');
  memorialEvent(view('A',1,1,'另处'));assert.equal(find(root,n=>n.attrs['aria-label']==='纪念文字')?.value,'保留我的草稿'); profile.dispose();
});
