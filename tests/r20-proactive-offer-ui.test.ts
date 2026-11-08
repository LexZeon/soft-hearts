import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import ts from 'typescript';
import {ProactiveAgentOffer,type ProactiveAgentOfferAPI} from '../src/ui/ProactiveAgentOffer';
import {CodexTasks,type CodexTaskBridge} from '../src/ui/CodexTasks';
import {R20ProactiveOffers} from '../electron/r20-proactive-offer';import {ProactiveSpeechGate} from '../electron/proactive-speech-gate';
import {R20_OFFER_CAPABILITIES,type R20ProactiveOfferEvent,type R20ProactiveOfferView,type R20ProactiveOfferState,type R20ProactiveOfferResponse} from '../shared/r20-proactive-offer';
import {validateCodexTaskPrompt} from '../shared/codex-tasks';import {DEFAULT_SETTINGS} from '../shared/defaults';
import {registerUiMessages,setUiLanguage} from '../shared/ui-language';import {ENGLISH_TASKS_UI_COPY} from '../shared/ui-copy.tasks.en';

class Element {
 children:Element[]=[];className='';textContent='';value='';hidden=false;disabled=false;type='';id='';maxLength=0;scrollTop=0;scrollHeight=0;
 onclick:(()=>void)|null=null;oninput:(()=>void)|null=null;onchange:(()=>void)|null=null;onsubmit:((event:{preventDefault():void})=>void)|null=null;
 attrs:Record<string,string>={};ownerDocument=doc;
 constructor(public tagName:string){} append(...xs:Element[]){this.children.push(...xs);}replaceChildren(...xs:Element[]){this.children=xs;}setAttribute(k:string,v:string){this.attrs[k]=v;}
}
const doc={createElement:(tag:string)=>new Element(tag)};
const all=(n:Element):Element[]=>[n,...n.children.flatMap(all)];
function find(root:Element,p:(n:Element)=>boolean){const n=all(root).find(p);assert.ok(n);return n;}
function click(root:Element,label:string){const n=find(root,n=>n.tagName==='button'&&n.textContent===label);assert.equal(n.disabled,false);n.onclick?.();}
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const offer=(id='offer',revision=1,presented=false):R20ProactiveOfferView=>({id,revision,presented,stage:'offered',expiresAt:200000,question:'需要先看看整理计划吗？',goal:'整理项目',plan:'先列步骤。',scopeHint:'请自己填写范围',capabilities:{...R20_OFFER_CAPABILITIES}});
function deferred<T>(){let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}

test('English proactive plan controls keep host question and human scope text private and do not execute a task',async()=>{
 registerUiMessages({en:ENGLISH_TASKS_UI_COPY,'zh-CN':{}});setUiLanguage('en');
 const root=new Element('div'),requests:R20ProactiveOfferResponse[]=[],privateQuestion='查看方案';
 const initial={...offer('english',1,true),stage:'scope' as const,question:privateQuestion,goal:'允许范围与限制',scopeHint:'回复建议'};
 const api:ProactiveAgentOfferAPI={r20ProactiveOfferEvents:()=>()=>{},r20ProactiveOfferGet:async()=>({revision:1,offer:initial}),r20ProactiveOfferAcknowledge:async()=>null,r20ProactiveOfferRespond:async request=>{requests.push(request);return{status:'updated',state:{revision:1,offer:initial}} as any;}};
 const errors:string[]=[];const ui=new ProactiveAgentOffer(root as unknown as HTMLElement,api,{isPet:false,publish:async()=>{},retract:()=>{},error:message=>errors.push(message)});
 try{
  await ui.init();assert.ok(all(root).some(n=>n.textContent==='Suggested plan · Not executed'));
  assert.ok(all(root).some(n=>n.tagName==='p'&&n.textContent===privateQuestion));
  const fields=all(root).filter(n=>n.tagName==='textarea');assert.equal(fields[1].value,'允许范围与限制');assert.equal(fields[2].value,'');
  assert.equal(fields[2].attrs['aria-label'],'Allowed scope and limits for this task');
  const form=find(root,n=>n.tagName==='form');form.onsubmit?.({preventDefault(){}});assert.equal(requests.length,0);assert.deepEqual(errors,['Describe the goal, allowed scope and limits for this task.']);
  assert.ok(all(root).some(n=>n.tagName==='button'&&n.textContent==='Open task confirmation'));
 }finally{ui.dispose();setUiLanguage('zh-CN');}
});

test('pet publishes and acknowledges exact offer once; stale snapshot and late ACK cannot revive a cancelled offer',async()=>{
 const snapshot=deferred<R20ProactiveOfferState>(),ack=deferred<R20ProactiveOfferView|null>();let emit!:(e:R20ProactiveOfferEvent)=>void;const calls:string[]=[];
 const root=new Element('div');const api:ProactiveAgentOfferAPI={r20ProactiveOfferEvents:f=>{emit=f;return()=>calls.push('unsubscribe');},r20ProactiveOfferGet:()=>snapshot.promise,r20ProactiveOfferAcknowledge:async x=>{calls.push('ack:'+x.id);return ack.promise;},r20ProactiveOfferRespond:async()=>{throw Error('Unexpected response');}};
 const ui=new ProactiveAgentOffer(root as unknown as HTMLElement,api,{isPet:true,publish:async x=>{calls.push('publish:'+x.id);},retract:id=>calls.push('retract:'+id),presented:x=>calls.push('presented:'+x.id),error:m=>calls.push(m)});
 const init=ui.init();emit({type:'offer',revision:2,offer:offer('a',2)});emit({type:'offer',revision:2,offer:offer('a',2)});await flush();
 snapshot.resolve({revision:0,offer:null});await init;assert.deepEqual(calls,['publish:a','ack:a']);
 emit({type:'cancel',revision:3,id:'a'});ack.resolve(offer('a',4,true));await flush();assert.equal(root.hidden,true);assert.deepEqual(calls,['publish:a','ack:a','retract:a']);ui.dispose();
});

test('scope UI keeps scope blank, preserves human drafts, and refuses an empty scope',async()=>{
 let emit!:(e:R20ProactiveOfferEvent)=>void;let current=offer('a',1,true);const responses:unknown[]=[],errors:string[]=[];const root=new Element('div');
 const api:ProactiveAgentOfferAPI={r20ProactiveOfferEvents:f=>{emit=f;return()=>{};},r20ProactiveOfferGet:async()=>({revision:1,offer:current}),r20ProactiveOfferAcknowledge:async()=>null,r20ProactiveOfferRespond:async input=>{responses.push(input);current={...current,revision:current.revision+1,stage:'scope'};return{status:'needs-scope',state:{revision:current.revision,offer:current}};}};
 const ui=new ProactiveAgentOffer(root as unknown as HTMLElement,api,{isPet:false,publish:async()=>{throw Error('Controls cannot publish');},retract:()=>{},error:m=>errors.push(m)});await ui.init();
 click(root,'补充范围');await flush();let scope=find(root,n=>n.attrs['aria-label']==='这次允许的范围与限制');assert.equal(scope.value,'');
 find(root,n=>n.tagName==='form').onsubmit?.({preventDefault(){}});await flush();assert.equal(responses.length,1);assert.equal(errors.length,1);
 scope.value='只整理建议，不写文件';scope.oninput?.();const goal=find(root,n=>n.attrs['aria-label']==='这次任务的具体目标');goal.value='我的具体目标';goal.oninput?.();
 current={...current,revision:3};emit({type:'presented',revision:3,offer:current});scope=find(root,n=>n.attrs['aria-label']==='这次允许的范围与限制');assert.equal(scope.value,'只整理建议，不写文件');
 assert.equal(find(root,n=>n.attrs['aria-label']==='这次任务的具体目标').value,'我的具体目标');ui.dispose();
});

test('actual host ticket and under-chat form reach actual original confirmation caller, without any execution port',async()=>{
 const original=globalThis.document;globalThis.document=doc as unknown as Document;
 const root=new Element('div'),taskRoot=new Element('div');const errors:string[]=[];let taskStarts=0,opened=0,shown='',archiveCount=0;let emit:(e:R20ProactiveOfferEvent)=>void=()=>{};
 const denied=async()=>{taskStarts++;throw Error('Unexpected task operation');};
 const settings=structuredClone(DEFAULT_SETTINGS);settings.agent.workingDirectory='';
 const bridge:CodexTaskBridge={listCodexTasks:async()=>[],readCodexTask:denied,startCodexTask:denied,continueCodexTask:denied,interruptCodexTask:denied,respondCodexApproval:denied,onCodexTaskEvent:()=>()=>{},codexTaskCapabilities:denied,selectDirectory:async()=>null};
 const panel=new CodexTasks(taskRoot as unknown as HTMLElement,{api:bridge,getSettings:()=>settings,beforeStart:async()=>false,onDirectorySelected:()=>{},onError:m=>errors.push(m),onOpen:()=>{opened++;}});
 const renderer=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),rendererAst=ts.createSourceFile('renderer.ts',renderer,ts.ScriptTarget.Latest,true);
 let proposal:ts.Node|undefined;function scan(n:ts.Node){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='onCodexTaskProposal')proposal=n.arguments[0];ts.forEachChild(n,scan);}scan(rendererAst);assert.ok(proposal);
 const js=(s:string)=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const receive=new Function('codexTasks','openCodexTaskPanel',js('return ('+proposal.getText(rendererAst)+');'))(panel,()=>{opened++;}) as (prompt:string)=>void;
 const main=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
 const helper=ast.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text==='openCodexTaskConfirmation');assert.ok(helper);
 const controls={isDestroyed:()=>false,webContents:{send:(channel:string,prompt:string)=>{assert.equal(channel,'desk:codex-task-proposal');receive(prompt);}}};
 const open=new Function('validateCodexTaskPrompt','showControls','controls',js(helper.getText(ast)+'\nreturn openCodexTaskConfirmation;'))(validateCodexTaskPrompt,()=>{},controls) as (prompt:string,current:()=>boolean)=>void;
 const gate=new ProactiveSpeechGate(()=>10000);gate.setScope('scope');
 const surface={waitForPresentation:async(text:string)=>text===shown,isPresentationCurrent:(text:string)=>text===shown};
 const host=new R20ProactiveOffers({gate,context:()=>({identity:'identity',gateScope:'scope',persona:'温和',mood:'平静'}),eligible:()=>true,presentable:()=>true,owner:()=>7,humanSender:s=>s===7,surface:()=>surface,generate:async()=>JSON.stringify({question:'需要先看看整理计划吗？',goal:'整理项目',plan:'先列步骤。',scopeHint:'请自己填写范围'}),event:e=>emit(e),archive:async(_o,_at,current)=>{if(current())archiveCount++;},openTaskConfirmation:open,now:()=>10000,createId:()=> 'actual'});
 const ui=new ProactiveAgentOffer(root as unknown as HTMLElement,{r20ProactiveOfferEvents:f=>{emit=f;return()=>{};},r20ProactiveOfferGet:async()=>host.get(),r20ProactiveOfferAcknowledge:async x=>host.acknowledge(7,x),r20ProactiveOfferRespond:async x=>host.respond(7,x)}, {isPet:true,publish:async x=>{shown=x.question;},retract:()=>{shown='';},error:m=>errors.push(m)});
 try{await ui.init();host.noteCompleted('completed','请帮我考虑计划','可以先梳理步骤。');assert.equal(host.offerOpportunity({id:'opportunity',kind:'speech',until:11000}),true);await flush();assert.equal(archiveCount,1);assert.equal(taskStarts,0);
  click(root,'查看方案');await flush();assert.equal(opened,0);click(root,'补充范围');await flush();assert.equal(opened,0);
  const goal=find(root,n=>n.attrs['aria-label']==='这次任务的具体目标'),scope=find(root,n=>n.attrs['aria-label']==='这次允许的范围与限制');goal.value='整理项目文档';scope.value='只给计划，不修改文件';
  find(root,n=>n.tagName==='form').onsubmit?.({preventDefault(){}});await flush();assert.equal(opened,1);assert.equal(taskStarts,0);assert.equal(archiveCount,1);
  assert.equal(find(taskRoot,n=>n.className==='codex-task-mode').value,'read-only');assert.match(find(taskRoot,n=>n.className==='codex-task-prompt').value,/整理项目文档[\s\S]*只给计划，不修改文件/u);
  assert.equal(find(taskRoot,n=>n.textContent==='同意并新建任务').disabled,true);assert.deepEqual(errors,[]);
 }finally{ui.dispose();host.dispose();gate.dispose();panel.dispose();globalThis.document=original;}
});
