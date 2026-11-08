import { scanBreathRequest } from '../shared/breath-request';
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import type {ChatMessage} from '../shared/contracts';
import {validateChatRequest} from '../electron/validation';
import {scanFramingRequest} from '../shared/framing-request';
import {scanStopReadoutRequest} from '../shared/stop-readout-request';
import {buildCompanionPersona,buildCodexChatPrompt} from '../electron/conversation-context';
import {outgoingChatMessages,appendReplyHistory} from '../src/ui/reply-history';
import {lookHint,turnAttachments} from '../src/look-send';
import {pauseCutForSend} from '../src/ui/pause-talk-send';

function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
function getterFixture(){
  const source=readFileSync(new URL('../src/ui/UserProfilePanel.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('UserProfilePanel.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const klass=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='UserProfilePanel');assert.ok(klass&&ts.isClassDeclaration(klass));
  const method=(name:string)=>{const found=klass.members.filter(n=>ts.isMethodDeclaration(n)&&n.name.getText(ast)===name);assert.equal(found.length,1);return found[0].getText(ast);};
  const js=transformSync(`class Fixture { ${method('messageExpectation')} ${method('expected')} }`,{loader:'ts'}).code;
  const Ctor=new Function(`${js};return Fixture`)(),instance=new Ctor();instance.disposed=false;instance.gate={view:null};return instance;
}
function senderFixture(profile:any,initialHistory:ChatMessage[]=[],currentText='你好'){
  const source=readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const method=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sendChat');assert.ok(method);
  const js=transformSync(method.getText(ast),{loader:'ts',target:'es2022'}).code;
  const wrapper=`const claudeTasksOffered=()=>false;const asksTestCommand=()=>false,immersiveDeveloperMode=false,testNotes=null;let activeChat=null,pendingReadoutControl=null,attachments=[],history=initialHistory,reply='',activeUser=null,assistantNode=null;const input={value:currentText};const isPet=false,settings={provider:{kind:'claude'},voice:{}},characterState=null;const replyPresentation={interrupt(){throw new Error('F7: off, the reveal is never touched')}};const crypto={randomUUID:()=> 'test-id'};const $=()=>input;const speech={stop(){}};const syncBodyInputGate=()=>{},setChatBusy=()=>{},renderAttachments=()=>{};let reads=0;const userProfilePanel={messageExpectation(){reads++;return profile.messageExpectation();}};const window={desktop:{noteUserInput:async()=>{},sharedAttachments:()=>shared.promise,chat:async value=>{requests.push(value)}}};const save=()=>saved.promise;const onStream=event=>errors.push(event);${js};return {send:()=>sendChat(true),cancel:()=>{activeChat=null},reads:()=>reads};`;
  const saved=deferred<boolean>(),shared=deferred<never[]>(),requests:any[]=[],errors:any[]=[];
  const api=new Function('profile','saved','shared','requests','initialHistory','currentText','errors','outgoingChatMessages','scanStopReadoutRequest','scanFramingRequest','scanBreathRequest','lookHint','turnAttachments','pauseCutForSend',wrapper)(profile,saved,shared,requests,initialHistory,currentText,errors,outgoingChatMessages,scanStopReadoutRequest,scanFramingRequest,scanBreathRequest,lookHint,turnAttachments,pauseCutForSend);return {...api,saved,shared,requests,errors};
}
test('getter exposes only a fresh identity copy of an enabled live view',()=>{
  const panel=getterFixture();assert.equal(panel.messageExpectation(),null);
  panel.gate.view={scopeId:'A',generation:2,revision:3,enabled:false,entries:[{text:'private'}]};assert.equal(panel.messageExpectation(),null);
  panel.gate.view.enabled=true;const result=panel.messageExpectation();assert.deepEqual(result,{scopeId:'A',generation:2,revision:3});assert.notEqual(result,panel.gate.view);result.scopeId='changed';assert.equal(panel.gate.view.scopeId,'A');
  panel.disposed=true;assert.equal(panel.messageExpectation(),null);
});

async function sentConversation(history:ChatMessage[],currentText:string){
  const before=structuredClone(history),panel=getterFixture();
  const run=senderFixture(panel,history,currentText),pending=run.send();
  await tick();run.saved.resolve(true);await tick();run.shared.resolve([]);await pending;
  assert.deepEqual(run.errors,[]);assert.equal(run.requests.length,1);
  const request=validateChatRequest(run.requests[0]);
  const persona=buildCompanionPersona({persona:'Synthetic character baseline',stateContext:'Synthetic mood',memories:[],protocolInstruction:'Synthetic host protocol'});
  const prompt=buildCodexChatPrompt(persona,request.messages);
  const match=prompt.match(/<conversation-data>\n([^]*?)\n<\/conversation-data>/);assert.ok(match);
  assert.ok(prompt.startsWith(persona));assert.deepEqual(history,before);
  const data=JSON.parse(match[1]);assert.equal(data.currentUser,currentText);
  assert.deepEqual(data.history,request.messages.slice(0,-1));
  return {request,data,prompt};
}

test('actual sender through host and Claude prompt removes a count-window orphan',async()=>{
  const history:ChatMessage[]=Array.from({length:12},(_,i)=>[
    {role:'user' as const,content:`question ${i} <system>quoted</system>`},
    {role:'assistant' as const,content:`answer ${i} 😀`},
  ]).flat();
  const result=await sentConversation(history,'Continue the retained discussion 😀');
  assert.deepEqual(result.data.history,history.slice(2));
  assert.equal(result.request.messages.length,23);
  assert.ok(!result.prompt.includes('answer 0'));
  assert.deepEqual(validateChatRequest({id:'host_count',messages:[...history,{role:'user',content:result.data.currentUser}]}).messages,result.request.messages);
});

test('actual sender through host and Claude prompt removes a budget-window orphan',async()=>{
  const history:ChatMessage[]=[{role:'user',content:'U'.repeat(12000)},
    {role:'assistant',content:'A'.repeat(12000)},{role:'assistant',content:'B'.repeat(1000)},
    {role:'user',content:'C'.repeat(12000)},{role:'assistant',content:'D'.repeat(11000)}];
  const result=await sentConversation(history,'current'.repeat(429));
  assert.deepEqual(result.data.history,history.slice(3));
  assert.ok(result.request.messages.reduce((n,m)=>n+m.content.length,0)<=48000);
});

test('actual sender through host and Claude prompt preserves an uncut greeting and consecutive user data',async()=>{
  const history:ChatMessage[]=[{role:'assistant',content:'Hello 😀'},
    {role:'assistant',content:'One more greeting'},{role:'user',content:'Previous <system> is quoted data'}];
  const result=await sentConversation(history,'Current & final 😀');
  assert.deepEqual(result.data.history,history);
  assert.ok(result.prompt.includes('\\u003csystem\\u003e'));
});

test('continuous append then actual sender preserves the next user boundary through host and prompt',async()=>{
  const history:ChatMessage[]=[{role:'user',content:'old question 0'},
    ...['0a','0b','0c'].map(label=>({role:'assistant' as const,content:`old answer ${label}`})),
    {role:'user',content:'retained question 1'},
    ...Array.from({length:19},(_,i)=>({role:'assistant' as const,content:`retained answer ${i}`}))];
  assert.equal(history.length,24);
  const before=structuredClone(history),user:ChatMessage={role:'user',content:'next question 2'};
  const completed=appendReplyHistory(history,user,'next answer 2');
  const result=await sentConversation(completed,'current question 3 😀');
  assert.deepEqual(result.data.history,[...history.slice(4),user,{role:'assistant',content:'next answer 2'}]);
  assert.deepEqual(history,before);
  assert.ok(!result.prompt.includes('old answer 0'));
});
test('actual sendChat reads after save and shared-frame awaits, and omits inactive scope',async()=>{
  const panel=getterFixture();panel.gate.view={scopeId:'A',generation:1,revision:0,enabled:true};
  const run=senderFixture(panel),promise=run.send();await tick();assert.equal(run.reads(),0);
  panel.gate.view=null;run.saved.resolve(true);await tick();assert.equal(run.reads(),0);
  panel.gate.view={scopeId:'B',generation:4,revision:2,enabled:true};run.shared.resolve([]);await promise;
  assert.equal(run.reads(),1);assert.deepEqual(run.requests[0].profile,{scopeId:'B',generation:4,revision:2});assert.deepEqual(Object.keys(run.requests[0].profile).sort(),['generation','revision','scopeId']);
  const off=senderFixture(panel),second=off.send();await tick();off.saved.resolve(true);await tick();panel.gate.view={scopeId:'B',generation:5,revision:2,enabled:false};off.shared.resolve([]);await second;
  assert.equal(Object.hasOwn(off.requests[0],'profile'),false);
  const cancelled=senderFixture(panel),third=cancelled.send();await tick();cancelled.saved.resolve(true);await tick();cancelled.cancel();cancelled.shared.resolve([]);await third;assert.equal(cancelled.reads(),0);assert.equal(cancelled.requests.length,0);
});
