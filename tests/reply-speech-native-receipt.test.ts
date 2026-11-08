import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import test from 'node:test';
import { ReplyRhythmHost } from '../electron/reply-rhythm-host';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import { SpeechRuntime } from '../electron/speech-runtime';
import { ReplySpeechStyles } from '../electron/speech-emotion';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';
import { formatReplyBubbles } from '../shared/reply-segments';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { appendReplyHistory, trimReplyHistory } from '../src/ui/reply-history';
import { formatReplySegments } from '../src/ui/reply-segments';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';

const sourceFile=new URL('../electron/main.ts',import.meta.url),sourceText=fs.readFileSync(sourceFile,'utf8');
const ast=ts.createSourceFile(sourceFile.pathname,sourceText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function hostFunction(name:string):string {
 let found:string|undefined;
 function visit(n:ts.Node){
  if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(ast);
  if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='scopedHost'&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text===name)found=n.arguments[1].getText(ast);
  ts.forEachChild(n,visit);
 }visit(ast);assert.ok(found,name);return '(()=>{'+ts.transpileModule('const result = ('+found+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText+'\nreturn result;})()';
}

function harness(ready=true,owner=7){
 const plans=new CompletedReplySpeech(),styles=new ReplySpeechStyles(),events:string[]=[],broadcasts:any[]=[],cancelled:any[]=[],speechEvents:any[]=[];
 let providerCalls=0,scope='scope',paused=false,failStopNotification=false,proof:{text:string,signal:AbortSignal}|null=null,nativeText:string|null=null;
 const waiters:{expected:string,signal:AbortSignal,resolve:(shown:boolean)=>void,settled:boolean}[]=[];
 const runtime=new SpeechRuntime((owner,context)=>({...DEFAULT_TTS_CONFIG,...styles.resolveStyle(owner,context!.replyId,scope)}),(_owner,event)=>speechEvents.push(event),async()=>{providerCalls++;});
 const surface={
  waitForPresentation(expected:string,signal:AbortSignal){events.push('register');if(nativeText===expected&&!signal.aborted){proof={text:expected,signal};return Promise.resolve(true);}return new Promise<boolean>(resolve=>{
   const row={expected,signal,resolve:(shown:boolean)=>{if(row.settled)return;row.settled=true;if(shown&&!signal.aborted){nativeText=expected;proof={text:expected,signal};}resolve(shown&&!signal.aborted);},settled:false};waiters.push(row);
   signal.addEventListener('abort',()=>row.resolve(false),{once:true});if(signal.aborted)row.resolve(false);
  });},
  isPresentationCurrent(expected:string){return !!proof&&!proof.signal.aborted&&proof.text===expected&&nativeText===expected;},
 };
 const context:any={textMemorialHost:null,completedReplySpeech:plans,replySpeechStyles:styles,replyRhythm:new ReplyRhythmHost(),speechRuntime:runtime,store:{current:{voice:{enabled:true}}},pet:{webContents:{id:8},isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false},petReply:surface,
  speechScope:()=>scope,formatReplyBubbles,windows:()=>[1,2].map(window=>({webContents:{send:(channel:string,id:string)=>{if(failStopNotification)throw Error('owned notification unavailable');cancelled.push({window,channel,id});}}})),
  suspendAmbientSpeech:()=>{paused=runtime.busy||plans.busy;events.push('pause:'+paused);},
  // Fatigue observation is outside this native-receipt fixture's scope.
  syncFatigueActivity:()=>{},
  broadcast:(channel:string,segment:any)=>{events.push('broadcast');assert.ok(events.indexOf('register')<events.lastIndexOf('broadcast'));broadcasts.push({channel,segment});},
  Error,Promise,
 };
 vm.createContext(Object.assign(context, { uiText, uiHtml, uiMarkup, uiTemplate }));context.cancelCompletedReply=vm.runInContext(hostFunction('cancelCompletedReply'),context);context.cancelReplyStyle=vm.runInContext(hostFunction('cancelReplyStyle'),context);
 const next=vm.runInContext(hostFunction('nextReplySpeechSegment'),context),synthesize=vm.runInContext(hostFunction('synthesizeSpeech'),context),cancel=vm.runInContext(hostFunction('cancelReplySpeech'),context),acknowledge=vm.runInContext(hostFunction('acknowledgeReplySpeechReady'),context),stopReadout=vm.runInContext(hostFunction('stopCompanionReadout'),context);
 const record=async(id='reply',newScope=scope)=>{scope=newScope;styles.begin(owner,id,scope);styles.complete(owner,id,scope,{context:'neutral',primary:'calm'},{emotion:'custom',instruction:'frozen public style'});plans.record(owner,id,scope,'第一句。第二句。');if(ready)await acknowledge(8,id);};
 return{plans,styles,runtime,events,broadcasts,cancelled,waiters,next,synthesize,cancel,acknowledge,stopReadout,record,failStopNotification:()=>{failStopNotification=true;},loseProof:()=>{proof=null;nativeText=null;},get providerCalls(){return providerCalls;},get paused(){return paused;}};
}

test('fixed readout stop revokes actual preparing plan and pending native waiter with no synthesis',async()=>{
 const h=harness(false);await h.record();const captured=h.plans.captureReadout('scope');assert.ok(captured);
 const pending=h.next(7,'reply');await new Promise(setImmediate);
 assert.equal(h.stopReadout(captured),'stopped');assert.equal(await pending,null);
 assert.equal(h.plans.busy,false);assert.equal(h.runtime.busy,false);assert.equal(h.providerCalls,0);
 assert.equal(h.stopReadout(null),'no-current');assert.equal(h.cancelled.length,2);
 await assert.rejects(h.next(7,'reply'));assert.equal(await h.acknowledge(8,'reply'),false);
});

test('fixed readout stop cancels the real transport drain and between-segment plan without starting another piece',async()=>{
 for(const phase of ['draining','segment-gap']){
  const h=harness();await h.record();const captured=h.plans.captureReadout('scope');const pending=h.next(7,'reply');
  await new Promise(setImmediate);h.waiters[0].resolve(true);const piece=await pending;
  await h.synthesize(7,'old-transport',piece.text,piece.context);assert.equal(h.runtime.busy,true);
  if(phase==='segment-gap'){assert.equal(h.runtime.release(7,'old-transport'),true);assert.equal(h.runtime.busy,false);}
  assert.equal(h.plans.busy,true);assert.equal(h.stopReadout(captured),'stopped');
  assert.equal(h.runtime.busy,false);assert.equal(h.plans.busy,false);await assert.rejects(h.next(7,'reply',0));
  await assert.rejects(h.synthesize(7,'late-transport',piece.text,piece.context));assert.equal(h.providerCalls,1);
 }
});

test('old captured plan cannot stop a newer plan or its transport even with identical owner and reply ID',async()=>{
 const h=harness();await h.record();const old=h.plans.captureReadout('scope');await h.record();
 const fresh=h.plans.captureReadout('scope');assert.notEqual(old,fresh);
 const pending=h.next(7,'reply');await new Promise(setImmediate);h.waiters[0].resolve(true);const piece=await pending;
 await h.synthesize(7,'new-transport',piece.text,piece.context);
 assert.equal(h.stopReadout(old),'unknown');assert.equal(h.plans.captureReadout('scope'),fresh);
 assert.equal(h.runtime.busy,true);assert.equal(h.cancelled.length,0);
 assert.equal(h.stopReadout(fresh),'stopped');assert.equal(h.stopReadout(old),'unknown');assert.equal(h.cancelled.length,2);
});

test('a lost owned stop notification retains unknown output receipt while invalidating the exact old plan',async()=>{
 const h=harness();await h.record();const captured=h.plans.captureReadout('scope');h.failStopNotification();
 assert.equal(h.stopReadout(captured),'unknown');assert.equal(h.plans.busy,false);assert.equal(h.cancelled.length,0);
 assert.equal(h.providerCalls,0);
});

test('actual main handlers reject stolen broadcast context before delayed native receipt with zero provider calls',async()=>{
 const h=harness();await h.record();const pending=h.next(7,'reply');await new Promise(setImmediate);
 assert.equal(h.broadcasts.length,1);assert.equal(h.events[0],'pause:true');assert.equal(h.events[1],'register');assert.equal(h.events[2],'broadcast');
 const stolen=h.broadcasts[0].segment;
 await assert.rejects(h.synthesize(7,'transport_early',stolen.text,stolen.context),/尚未确认/);assert.equal(h.providerCalls,0);
 h.waiters[0].resolve(true);const approved=await pending;assert.equal(approved.index,0);
 await h.synthesize(7,'transport_first',approved.text,approved.context);assert.equal(h.providerCalls,1);h.runtime.release(7,'transport_first');
 await assert.rejects(h.synthesize(7,'transport_repeat',approved.text,approved.context));assert.equal(h.providerCalls,1);
 assert.equal(h.waiters[0].expected,'第一句。第二句。','the host requires the complete frozen raw body for every segment');
 const secondPending=h.next(7,'reply',0);const approvedSecond=await secondPending;
 assert.equal(h.waiters.length,1,'the same current full body is reused without demanding a new shorter-prefix frame');
 assert.equal(h.broadcasts[1].segment,approvedSecond);assert.equal(approvedSecond.index,1);
 await assert.rejects(h.synthesize(7,'transport_second_wrong','外来的文字。',approvedSecond.context));assert.equal(h.providerCalls,1);
 await h.synthesize(7,'transport_second',approvedSecond.text,approvedSecond.context);h.runtime.release(7,'transport_second');
 assert.equal(h.providerCalls,2);assert.equal(await h.next(7,'reply',1),null);assert.equal(h.paused,false);
});

test('actual main failed receipt cancels exact plan, notifies both windows and refreshes paused input',async()=>{
 const h=harness();await h.record();const pending=h.next(7,'reply');await new Promise(setImmediate);assert.equal(h.paused,true);const signal=h.waiters[0].signal;
 h.waiters[0].resolve(false);await assert.rejects(pending,/气泡尚未确认/);
 assert.equal(signal.aborted,true);assert.equal(h.plans.busy,false);assert.equal(h.paused,false);assert.equal(h.providerCalls,0);
 assert.deepEqual(h.cancelled,[{window:1,channel:'desk:reply-speech-cancelled',id:'reply'},{window:2,channel:'desk:reply-speech-cancelled',id:'reply'}]);
 assert.throws(()=>h.styles.resolveStyle(7,'reply','scope'));
});

test('old receipt object cannot approve or cancel a new record even with identical owner/reply/index/scope',async()=>{
 const h=harness();await h.record();const old=h.next(7,'reply');await new Promise(setImmediate);const oldLease=h.broadcasts[0].segment;
 await h.record('reply','scope');assert.equal(h.waiters[0].signal.aborted,true);assert.equal(await old,null);h.waiters[0].resolve(true);
 assert.equal(h.plans.approvePresentation(7,'reply','scope',oldLease),false);assert.equal(h.cancelled.length,0);assert.equal(h.plans.busy,true);
 const fresh=h.next(7,'reply');await new Promise(setImmediate);const newLease=h.broadcasts[1].segment;assert.notEqual(newLease,oldLease);
 await assert.rejects(h.synthesize(7,'transport_stale',oldLease.text,oldLease.context));assert.equal(h.providerCalls,0);
 h.waiters[1].resolve(true);const approved=await fresh;await h.synthesize(7,'transport_new',approved.text,approved.context);assert.equal(h.providerCalls,1);
});

test('actual provider boundary rechecks current native proof and explicit cancel revokes approval',async()=>{
 const h=harness();await h.record();const pending=h.next(7,'reply');await new Promise(setImmediate);h.waiters[0].resolve(true);const approved=await pending;
 h.loseProof();await assert.rejects(h.synthesize(7,'transport_hidden',approved.text,approved.context),/尚未确认/);assert.equal(h.providerCalls,0);
 h.cancel(7,'reply');assert.equal(h.waiters[0].signal.aborted,true);assert.equal(h.paused,false);assert.equal(h.plans.approvedSegment(7,'reply','scope',0),null);
 await assert.rejects(h.synthesize(7,'transport_late',approved.text,approved.context));assert.equal(h.providerCalls,0);
});

test('actual host waits for the pet completion barrier; another sender and cancelled late readiness cannot start display',async()=>{
 const h=harness(false);await h.record();const pending=h.next(7,'reply');await new Promise(setImmediate);
 assert.equal(h.waiters.length,0);assert.equal(h.broadcasts.length,0);assert.equal(h.providerCalls,0);
 await assert.rejects(h.acknowledge(7,'reply'),/准备身份/);await new Promise(setImmediate);assert.equal(h.waiters.length,0);
 h.cancel(7,'reply');await h.acknowledge(8,'reply');assert.equal(await pending,null);assert.equal(h.waiters.length,0);assert.equal(h.paused,false);
});

for (const owner of ['controls','pet']) test(`actual ${owner}-owned completion drains paced raw pet publication before the exact full-body receipt`,async()=>{
 const ownerId=owner==='pet'?8:7,h=harness(false,ownerId);
 const rendererFile=new URL('../src/main.ts',import.meta.url),rendererText=fs.readFileSync(rendererFile,'utf8');
 const tree=ts.createSourceFile(rendererFile.pathname,rendererText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 let stream='',segment='';const helpers:Record<string,string>={};
 function visit(n:ts.Node){
  if(ts.isFunctionDeclaration(n)&&n.name?.text==='onStream')stream=n.getText(tree);
  if(ts.isFunctionDeclaration(n)&&['renderReadout','kickCompletedReply','startStreamingReplySpeech','prepareReplySpeechPresentation','finishReplySpeechPresentation','receiveReadoutControl'].includes(n.name?.text??''))helpers[n.name!.text]=n.getText(tree);
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='onReplySpeechSegment')segment=n.arguments[0].getText(tree);
  ts.forEachChild(n,visit);
 }visit(tree);assert.ok(stream);assert.ok(segment);
 const nativePatches:any[]=[],readers:string[]=[],played:string[]=[],queueStarts:string[]=[];let pending:Promise<any>|undefined,resolveDrain!:()=>void;
 const drain=new Promise<void>(resolve=>{resolveDrain=resolve;});
 function renderer(isPet:boolean){
  let now=0,id=0;const timers=new Map<number,{at:number,callback:()=>void}>();
  const clock={now:()=>now,set:(callback:()=>void,delay:number)=>{const key=++id;timers.set(key,{at:now+delay,callback});return key as unknown as ReturnType<typeof setTimeout>;},clear:(key:ReturnType<typeof setTimeout>)=>{timers.delete(key as unknown as number);}};
  const presentation=new ReplyPresentationState(clock);
  const queue=new CompletedReplySpeechQueue({nextReplySpeechSegment:async(replyId:string,index?:number)=>h.next(ownerId,replyId,index),cancelReplySpeech:async(replyId:string)=>h.cancel(ownerId,replyId)},async piece=>{
   played.push(piece.text);await h.synthesize(ownerId,'coupled_'+piece.index,piece.text,piece.context);h.runtime.release(ownerId,'coupled_'+piece.index);
  },()=>true);
  const context:any={activeChat:'reply',activeUser:{role:'user',content:'text'},reply:'',chatOwner:owner,windowKind:isPet?'pet':'controls',isPet,settings:{provider:{kind:'openai'},voice:{enabled:true}},voiceReplyIds:new Set(),hostVisible:true,document:{hidden:false},history:[],assistantNode:{textContent:'',classList:{add(){}}},
   voiceSpeechReady:null,ordinaryReplyPresentation:null,ordinaryVoiceConfig:null,speechPlaybackErrorShown:false,releaseReplySpeech:null,readoutControlTurns:new Map(),
   replyPresentation:presentation,replySpeechContext:()=> 'scope',
   replySpeechQueue:{speak:(id:string)=>{queueStarts.push(id);pending=queue.speak(id);return pending;}},window:{desktop:{acknowledgeReplySpeechReady:async(id:string)=>h.acknowledge(8,id),cancelReplySpeech:async(id:string)=>h.cancel(ownerId,id)}},
   petUI:isPet?{flushReplyPublication:()=>drain,refreshAnswerReader:(text:string)=>readers.push(text),finishAnswer:(text:string,_id:string,_s:boolean,_p:boolean,segmented:boolean)=>nativePatches.push({text,segmented}),showAnswer:(text:string,_s:boolean,_id:string,segmented:boolean)=>nativePatches.push({text,segmented}),endAnswerSpeech(){}}:null,
   formatReplySegments,appendReplyHistory,trimReplyHistory,renderReplyWaiting(){},syncBodyInputGate(){},setChatBusy(){},text(){},$:()=>({scrollTop:0,scrollHeight:0}),endReplySpeech(){},reportReplySpeechError(error:unknown){throw error;},
  };
  vm.createContext(Object.assign(context, { uiText, uiHtml, uiMarkup, uiTemplate }));
  const compile=(raw:string)=>ts.transpileModule('('+raw+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  for(const [name,raw]of Object.entries(helpers))context[name]=vm.runInContext(compile(raw),context);
  presentation.begin('reply');presentation.startReadout('reply',(prefix,raw)=>context.renderReadout('reply',prefix,raw));
  const advance=(ms:number)=>{const target=now+ms;for(;;){const due=[...timers.entries()].filter(([,row])=>row.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;timers.delete(due[0]);now=due[1].at;due[1].callback();}now=target;};
  return {context,advance,onStream:vm.runInContext(compile(stream),context),onSegment:vm.runInContext(compile(segment),context)};
 }
 const controls=renderer(false),pet=renderer(true);
 for(const target of [controls,pet]){
  target.onStream({kind:'chat',id:'reply',type:'delta',text:'第一句。'});
  target.onStream({kind:'chat',id:'reply',type:'delta',text:'第二句。'});
 }
 assert.equal(h.plans.busy,false,'the first readable text is delivered before any completed speech plan exists');
 assert.deepEqual(nativePatches,[{text:'第一句。',segmented:false}]);assert.equal(readers.at(-1),'第一句。第二句。');
 await h.record(); // The controlled producer truly completes here; styles/plan stay completion-only.
 if(owner==='controls')controls.onStream({kind:'chat',id:'reply',type:'done'});
 pet.onStream({kind:'chat',id:'reply',type:'done'});await new Promise(setImmediate);
 assert.equal(nativePatches.length,1,'DONE must not flush unread text');assert.equal(queueStarts.length,0);assert.equal(h.waiters.length,0);
 if(owner==='controls'){controls.advance(650);await new Promise(setImmediate);assert.ok(pending);assert.equal(h.waiters.length,0,'the controls queue waits for the independently paced pet');}
 pet.advance(649);assert.equal(nativePatches.length,1);pet.advance(1);await new Promise(setImmediate);
 assert.equal(nativePatches.at(-1)!.text,'第一句。第二句。');assert.equal(nativePatches.at(-1)!.segmented,false);
 assert.equal(queueStarts.length,1);assert.ok(pending);assert.equal(h.waiters.length,0,'full raw is not ready until its native publication drains');
 resolveDrain();await new Promise(setImmediate);assert.equal(h.waiters.length,1);assert.equal(h.broadcasts.length,1);
 assert.equal(h.waiters[0].expected,'第一句。第二句。');
 assert.equal(pet.context.activeChat,null);assert.equal(pet.context.ordinaryReplyPresentation.index,-1);
 const before=nativePatches.length;pet.onStream({kind:'chat',id:'reply',type:'delta',text:'late old delta'});assert.equal(nativePatches.length,before);
 pet.onSegment(h.broadcasts[0].segment);assert.equal(nativePatches.at(-1)!.text,'第一句。第二句。','speech never rolls text back to its first prefix');assert.equal(readers.at(-1),'第一句。第二句。');
 assert.equal(h.providerCalls,0);h.waiters[0].resolve(true);await pending;
 pet.onSegment(h.broadcasts[1].segment);assert.equal(nativePatches.at(-1)!.text,'第一句。第二句。');
 assert.deepEqual(played,['第一句。','第二句。']);assert.equal(h.providerCalls,2);assert.equal(h.waiters.length,1);assert.equal(queueStarts.length,1);
 assert.equal(pet.context.history.filter((message:any)=>message.role==='assistant').length,1);
 assert.equal(h.plans.busy,false);assert.equal(h.runtime.busy,false);
});

function preparationHarness(ready:boolean){
 const rendererFile=new URL('../src/main.ts',import.meta.url),raw=fs.readFileSync(rendererFile,'utf8'),tree=ts.createSourceFile(rendererFile.pathname,raw,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const helpers:Record<string,string>={};function visit(n:ts.Node){if(ts.isFunctionDeclaration(n)&&['prepareReplySpeechPresentation','finishReplySpeechPresentation'].includes(n.name?.text??''))helpers[n.name!.text]=n.getText(tree);ts.forEachChild(n,visit);}visit(tree);
 let resolve!:()=>void,reject!:(reason:unknown)=>void,scope='scope';const drain=new Promise<void>((yes,no)=>{resolve=yes;reject=no;}),acks:string[]=[],cancels:string[]=[],fallbacks:any[]=[],errors:any[]=[];
 const accepted={id:'reply',text:'第一句。第二句。',context:'scope',index:-1};
 const context:any={ordinaryReplyPresentation:accepted,activeChat:null,settings:{voice:{enabled:true}},hostVisible:true,document:{hidden:false},replySpeechContext:()=>scope,
  petUI:{flushReplyPublication:()=>drain,finishAnswer:(...args:any[])=>fallbacks.push(args),endAnswerSpeech(){}},window:{desktop:{acknowledgeReplySpeechReady:async(id:string)=>{acks.push(id);return ready;},cancelReplySpeech:async(id:string)=>{cancels.push(id);}}},reportReplySpeechError:(error:unknown)=>errors.push(error),
 };vm.createContext(Object.assign(context, { uiText, uiHtml, uiMarkup, uiTemplate }));for(const [name,source]of Object.entries(helpers))context[name]=vm.runInContext(ts.transpileModule('('+source+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 return {context,accepted,resolve,reject,acks,cancels,fallbacks,errors,scope:(value:string)=>{scope=value;},start:()=>context.prepareReplySpeechPresentation(accepted)};
}

test('a drained old preparation cannot acknowledge or restore text after new reply, scope change, hide or voice-off',async()=>{
 for(const mutation of ['new-reply','new-scope','hidden','voice-off']){
  const h=preparationHarness(true),pending=h.start();assert.deepEqual(h.acks,[]);
  if(mutation==='new-reply')h.context.ordinaryReplyPresentation={id:'new',context:'scope',text:'new body',index:-1};
  if(mutation==='new-scope')h.scope('new-scope');
  if(mutation==='hidden')h.context.hostVisible=false;
  if(mutation==='voice-off')h.context.settings.voice.enabled=false;
  h.resolve();await pending;assert.deepEqual(h.acks,[]);assert.deepEqual(h.fallbacks,[]);assert.deepEqual(h.cancels,[]);
 }
});

test('missing completed plan or failed publication restores one non-speaking full answer without overwriting a later identity',async()=>{
 const noPlan=preparationHarness(false),pending=noPlan.start();noPlan.resolve();await pending;
 assert.deepEqual(noPlan.acks,['reply']);assert.equal(noPlan.fallbacks.length,1);assert.deepEqual(noPlan.fallbacks[0],['第一句。第二句。','reply',false,false,true]);assert.equal(noPlan.context.ordinaryReplyPresentation,null);
 const failed=preparationHarness(true),failure=new Error('publication rejected'),rejected=failed.start();failed.reject(failure);await rejected;
 assert.deepEqual(failed.acks,[]);assert.deepEqual(failed.cancels,['reply']);assert.deepEqual(failed.errors,[failure]);assert.equal(failed.fallbacks.length,1);
 const stale=preparationHarness(true),old=stale.start();stale.context.ordinaryReplyPresentation={id:'new',context:'scope',text:'new body',index:-1};stale.reject(failure);await old;
 assert.deepEqual(stale.acks,[]);assert.deepEqual(stale.cancels,[]);assert.deepEqual(stale.errors,[]);assert.deepEqual(stale.fallbacks,[]);assert.equal(stale.context.ordinaryReplyPresentation.id,'new');
});
