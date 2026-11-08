import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,realpath,rm,rmdir,mkdir,rename} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import ts from 'typescript';
import {MemoryStore,TEXT_INVITATION_ID_PREFIX} from '../electron/memory';
import {MemoryStore as LegacyMemoryStore} from './fixtures/r39-legacy/electron/memory';
import {TextMemorialHost} from '../electron/text-memorial-host';import {ProactiveSpeechGate} from '../electron/proactive-speech-gate';

const raw=await readFile(new URL('../electron/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',raw,ts.ScriptTarget.Latest,true);
function declaration(name:string){const found=ast.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.equal(found.length,1);return found[0].getText(ast);}
function callback(name:string){const found:string[]=[];function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(ast)==='host'&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text===name)found.push(node.arguments[1].getText(ast));ts.forEachChild(node,visit);}visit(ast);assert.equal(found.length,1);return found[0];}
const compile=ts.transpileModule(`let textMemorialHost=null,textInvitationMemory=null,textInvitationMemoryError='';
${['textMemorialEligible','initTextMemorials','managedMemory'].map(declaration).join('\n')}
return {init:initTextMemorials,getHost:()=>textMemorialHost,getArchive:()=>textInvitationMemory,
list:(${callback('listMemories')}),read:(${callback('readMemory')}),edit:(${callback('editMemory')}),remove:(${callback('deleteMemory')})};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;

const scope={characterId:'role',providerScope:'provider'},at=1_800_000_000_000;
const text='你愿意把“无霜星河QZ77这件小事”留作文字纪念吗？';
const input={id:'invitation_one',text,at,origin:{kind:'proactive' as const,id:'invitation_one',at,sources:['text' as const],labels:['本次文字纪念邀请']}};
async function owned(run:(directory:string)=>Promise<void>){const directory=await mkdtemp(path.join(os.tmpdir(),'soft-r39-invitations-'));try{await run(directory);}finally{const actual=await realpath(directory),temp=await realpath(os.tmpdir());assert.equal(path.dirname(actual),temp);assert.ok(path.basename(actual).startsWith('soft-r39-invitations-'));await rm(actual,{recursive:true,force:true});}}
async function oldOrdinary(directory:string){const store=new LegacyMemoryStore(directory);await store.load();const original=await store.beginTurn(scope,{id:'ordinary',userText:'完整普通原文😀',at:at-20});await store.appendAssistant(scope,'ordinary','普通回复保持。',at-19);await store.finishTurn(scope,'ordinary','complete',at-18);const disposable=await store.beginTurn(scope,{id:'cleanup',userText:'临时清理轮次',at:at-10,newTopic:true});await store.finishTurn(scope,'cleanup','complete',at-9);await store.flush();return{store,original,disposable};}

test('fixed invitation journal leaves actual old shared reader/compactor/recall isolated and preserves true scoped once-only records',async()=>owned(async directory=>{
 const old=await oldOrdinary(directory),shared=new MemoryStore(directory),invitations=new MemoryStore(directory,'text-invitations');await shared.load();await invitations.load();
 const sharedBefore=await readFile(path.join(directory,'memories.jsonl'),'utf8');
 assert.throws(()=>shared.appendInitiative(scope,input));assert.throws(()=>invitations.beginTurn(scope,{id:'bad',userText:'not a chat store',at}));
 const handle=await invitations.appendInitiative(scope,input,()=>true);assert.deepEqual(await invitations.appendInitiative(scope,input,()=>true),handle);
 assert.equal(await readFile(path.join(directory,'memories.jsonl'),'utf8'),sharedBefore,'new invitation never enters shared journal');
 const sideBefore=await readFile(path.join(directory,'text-invitations.jsonl'),'utf8');
 const fallback=new LegacyMemoryStore(directory);await fallback.load();assert.deepEqual(fallback.read(scope,old.original.recordId)!.messages.map(m=>m.content),['完整普通原文😀','普通回复保持。']);
 assert.equal(fallback.findInitiative(scope,input.id),null);assert.equal(fallback.read(scope,handle.recordId),undefined);
 assert.deepEqual(fallback.retrieve(scope,'无霜星河QZ77'),[]);assert.deepEqual(fallback.detectExplicitRecall(scope,'记得无霜星河QZ77吗'),[]);
 assert.equal(await fallback.reinforce(scope,handle.recordId,{eventId:'no-target',episodeId:'no-target',at}),undefined);
 assert.deepEqual(await fallback.noteUserRecall(scope,'记得无霜星河QZ77吗',{eventId:'no-target',at,confirmedRecordId:handle.recordId}),[]);
 await fallback.delete(scope,old.disposable.recordId);await fallback.flush();
 assert.equal(await readFile(path.join(directory,'text-invitations.jsonl'),'utf8'),sideBefore,'old compactor ignores the dedicated file');
 assert.ok(!(await readFile(path.join(directory,'memories.jsonl'),'utf8')).includes(input.id));
 const reloaded=new MemoryStore(directory,'text-invitations');await reloaded.load();assert.deepEqual(await reloaded.appendInitiative(scope,input),handle);
 const record=reloaded.read(scope,handle.recordId,{},at)!;assert.deepEqual(record.origin,input.origin);assert.equal(record.weight,0);assert.equal(record.messages[0].content,text);assert.equal(record.turnCount,0);
 assert.equal(reloaded.read({...scope,characterId:'other'},handle.recordId),undefined);assert.deepEqual(reloaded.retrieve(scope,'无霜星河QZ77'),[]);assert.deepEqual(reloaded.detectExplicitRecall(scope,'记得无霜星河QZ77吗'),[]);
 assert.equal(await reloaded.reinforce(scope,handle.recordId,{eventId:'blocked',episodeId:'blocked',at}),0);
 assert.deepEqual(await reloaded.noteUserRecall(scope,'记得无霜星河QZ77吗',{eventId:'blocked',at,confirmedRecordId:handle.recordId}),[]);
 const merged=new MemoryStore(directory);await merged.load();const page=merged.list(scope,{query:'无霜星河QZ77',limit:1},at,reloaded);assert.equal(page.total,1);assert.equal(page.records[0].id,TEXT_INVITATION_ID_PREFIX+handle.recordId);assert.deepEqual(page.records[0].origin,input.origin);
 assert.equal(merged.list(scope,{offset:1,limit:1},at,reloaded).records.length,1);assert.ok(page.tags.includes('角色主动'));
 await reloaded.flush();await merged.flush();
}));

async function hostFixture(directory:string){
 const shared=new MemoryStore(directory);await shared.load();let currentScope={...scope},identity='context',shown='',generation=0,ready!:()=>void;const readyView=new Promise<void>(resolve=>{ready=resolve;});
 const gate=new ProactiveSpeechGate();gate.setScope('context:token');const pending=new Map();let cancels=0;
 const env={MemoryStore,TEXT_INVITATION_ID_PREFIX,TextMemorialHost,path,store:{directory,current:{provider:{},tts:{},model:undefined}},companion:{memory:shared,currentScope:()=>currentScope,mood:{get:()=>({token:'token',snapshot:{phase:'idle',primary:'neutral',context:'neutral'}})},removeMemory:()=>{throw Error('Sidecar must not delete ordinary memory');}},characterCards:{getActive:()=>({id:currentScope.characterId})},memoryProviderScope:()=>currentScope.providerScope,
  speechScope:()=>identity,proactiveSpeechGate:gate,pet:{webContents:{id:7},isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false},petWindowDrag:null,userInputUntil:0,pending,petReply:{waitForPresentation:async(body:string)=>shown===body,isPresentationCurrent:(body:string)=>shown===body},
  broadcast:(channel:string,value?:unknown)=>{if(channel==='desk:text-memorials-changed'&&value)ready();},exiting:false,
  replySpeechStyles:{begin:()=>{},complete:()=>{}},effectiveTtsConfig:()=>({}),DEFAULT_TTS_CONFIG:{},composeSpeechConfig:()=>({}),characterSpeechPersona:()=>'',completedFatigueFeeling:()=>undefined,windows:()=>[],speechRuntime:{cancelReply:()=>{},stop:()=>{}},cancelReplyStyle:()=>{},mutate:(operation:()=>Promise<unknown>)=>operation(),stopSystemAudio:()=>{},clearVisionContext:()=>{},clearReplySpeech:()=>{cancels++;},refreshVisionContext:()=>{},ambientStore:{deleteComment:()=>{throw Error('No ambient archive');}}};
 const api=new Function(...Object.keys(env),compile)(...Object.values(env))as{init():Promise<void>;getHost():TextMemorialHost;getArchive():MemoryStore|null;list(query?:unknown):ReturnType<MemoryStore['list']>;read(id:string,query?:unknown):ReturnType<MemoryStore['read']>;edit(id:string,patch:unknown):Promise<void>;remove(id:string):Promise<unknown>};
 await api.init();await readyView;let serial=0;
 async function offer(body:string){const host=api.getHost(),id='human_'+(++serial),turn=host.accept({requestId:id,messageId:id,text:body,acceptedAt:Date.now(),source:'text'},identity);assert.ok(turn);await turn.result;const invite=`你愿意把“${body}”留作文字纪念吗？`;turn.complete(true,JSON.stringify({quote:body,purpose:'留作文字纪念',invite}));assert.equal(host.offerOpportunity({id:'cue_'+serial,kind:'speech',until:Date.now()+5000}),true);const state=host.getOffer();assert.ok(state.offer);return{host,state,invite};}
 return{api,shared,offer,show:(value:string)=>{shown=value;},scope:async(value:typeof scope)=>{currentScope=value;identity='context_'+(++generation);gate.setScope(identity+':token');const next=new Promise<void>(resolve=>{ready=resolve;});api.getHost().sync();await next;},cancels:()=>cancels,close:async()=>{api.getHost().dispose();gate.dispose();await api.getArchive()?.flush();await shared.flush();}};
}

test('actual host display and existing manual routes keep once-only archive/edit/delete, reject foreign selectors and revoke late writes',async()=>owned(async directory=>{
 const f=await hostFixture(directory);let release=()=>{};
 try{
  const ordinaryBefore=await readFile(path.join(directory,'memories.jsonl'),'utf8');
  const first=await f.offer('第一件确实发生的小事');assert.equal(await first.host.acknowledge(7,{id:first.state.offer!.id,revision:first.state.revision}),null,'no native display is no archive');assert.equal(f.api.list().total,0);
  const next=await f.offer('第二件确实发生的小事');f.show(next.invite);const receipt=await next.host.acknowledge(7,{id:next.state.offer!.id,revision:next.state.revision});assert.ok(receipt);assert.equal(next.host.get()!.entries.length,0,'unconfirmed invitation is not a consented memorial');
  assert.equal(await next.host.acknowledge(7,{id:next.state.offer!.id,revision:next.state.revision}),null);
  const page=f.api.list({query:'第二件'});assert.equal(page.total,1);const id=page.records[0].id;assert.ok(id.startsWith(TEXT_INVITATION_ID_PREFIX));assert.equal(f.api.read(id)!.messages[0].content,next.invite);assert.deepEqual(f.shared.list(scope).records,[]);
  assert.throws(()=>f.api.read(TEXT_INVITATION_ID_PREFIX+'../../file'));await f.api.edit(id,{title:'手动邀请标题',tags:['手动邀请标签']});assert.equal(f.api.list({tag:'手动邀请标签'}).records[0].title,'手动邀请标题');
  const archive=f.api.getArchive()!,edit=archive.edit.bind(archive);let edited!:()=>void,releaseEdit!:()=>void;const editStarted=new Promise<void>(resolve=>{edited=resolve;}),editHold=new Promise<void>(resolve=>{releaseEdit=resolve;});archive.edit=async(...args)=>{edited();await editHold;return edit(...args);};
  const delayedEdit=f.api.edit(id,{title:'旧视图不得跨范围改写'});const rejectedEdit=assert.rejects(delayedEdit,/改变/);await editStarted;await f.scope({...scope,providerScope:'foreign'});releaseEdit();await rejectedEdit;await f.scope(scope);archive.edit=edit;assert.equal(f.api.read(id)!.title,'手动邀请标题');
  const append=archive.appendInitiative.bind(archive);let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});archive.appendInitiative=async(...args)=>{entered();await hold;return append(...args);};
  const late=await f.offer('第三件尚未归档的小事');f.show(late.invite);const pending=late.host.acknowledge(7,{id:late.state.offer!.id,revision:late.state.revision});await started;
  await f.api.remove(id);release();assert.equal(await pending,null,'management cancellation rejects a late real writer');assert.equal(f.cancels(),0,'sidecar management does not stop ordinary speech/chat');assert.equal(f.api.list().total,0);assert.equal(late.host.get()!.entries.length,0);
  const reloaded=new MemoryStore(directory,'text-invitations');await reloaded.load();assert.equal(reloaded.list(scope).total,0);await assert.rejects(reloaded.appendInitiative(scope,{id:receipt.offer.id,text:receipt.offer.invite,at:receipt.origin.at,origin:receipt.origin}),/删除/);
  assert.equal(reloaded.findInitiative(scope,late.state.offer!.id),null);await f.scope({...scope,providerScope:'foreign'});assert.throws(()=>f.api.read(id));assert.equal(f.api.list().total,0);assert.equal(await readFile(path.join(directory,'memories.jsonl'),'utf8'),ordinaryBefore,'sidecar write/edit/delete never touch old shared bytes');await reloaded.flush();
 }finally{release();await f.close();}
 const conflictDirectory=path.join(directory,'collision'),old=await oldOrdinary(conflictDirectory),sharedFile=path.join(conflictDirectory,'memories.jsonl');
 const reserved=TEXT_INVITATION_ID_PREFIX+old.original.recordId;await writeFile(sharedFile,(await readFile(sharedFile,'utf8')).replaceAll(old.original.recordId,reserved));
 const conflict=await hostFixture(conflictDirectory);try{const before=await readFile(sharedFile,'utf8');assert.ok(conflict.shared.read(scope,reserved));assert.throws(()=>conflict.api.read(reserved),/编号/);await assert.rejects(conflict.api.edit(reserved,{title:'不得误路由'}),/编号/);await assert.rejects(conflict.api.remove(reserved),/编号/);assert.equal(await readFile(sharedFile,'utf8'),before);}finally{await conflict.close();}
}));

test('unknown invitation bytes and archive write failure preserve files without a successful presentation or retry',async()=>owned(async directory=>{
 const bad=path.join(directory,'unknown');await mkdir(bad);const file=path.join(bad,'text-invitations.jsonl'),unknown='unrecognized existing bytes';await writeFile(file,unknown);
 const store=new MemoryStore(bad,'text-invitations');await assert.rejects(store.load(),/格式/);assert.equal(await readFile(file,'utf8'),unknown);await assert.rejects(store.appendInitiative(scope,input),/尚未载入/);assert.equal(await readFile(file,'utf8'),unknown);
 const unavailable=await hostFixture(bad);try{assert.equal(unavailable.api.getArchive(),null);assert.match(unavailable.api.list().notice!,/无法读取/);assert.throws(()=>unavailable.api.read(TEXT_INVITATION_ID_PREFIX+'00000000-0000-0000-0000-000000000000'),/无法读取/);assert.equal(await readFile(file,'utf8'),unknown);}finally{await unavailable.close();}
 const f=await hostFixture(path.join(directory,'writer'));try{
  const archiveFile=path.join(directory,'writer','text-invitations.jsonl'),saved=archiveFile+'.saved';const before=await readFile(archiveFile,'utf8');await rename(archiveFile,saved);await mkdir(archiveFile);
  try{const offer=await f.offer('文件错误时不能假装完成');f.show(offer.invite);assert.equal(await offer.host.acknowledge(7,{id:offer.state.offer!.id,revision:offer.state.revision}),null);assert.equal(offer.host.get()!.entries.length,0);assert.equal(f.api.list().total,0);assert.equal(offer.host.offerOpportunity({id:'cue_1',kind:'speech',until:Date.now()+5000}),true,'consumed cue is suppressed without retry');assert.equal(await readFile(saved,'utf8'),before);}
  finally{await rmdir(archiveFile);await rename(saved,archiveFile);}
 }finally{await f.close();}
}));
