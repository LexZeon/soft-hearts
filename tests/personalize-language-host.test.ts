import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';
import { readFile, mkdtemp, rm } from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import { randomUUID } from 'node:crypto';
import { PersonalizeLanguageStore } from '../electron/personalize-language';
import { emptyLanguageRules, emptyLanguageProfile, personalizeLanguageContext, type LanguageState } from '../shared/personalize-language';
import { buildCodexChatPrompt } from '../electron/conversation-context';
import { PersistentClaudeChat } from '../electron/claude-session';
import { CompanionService } from '../electron/companion';
import { VoiceChatHost } from '../electron/voice-chat-host';
import { encodeWav } from '../src/ui/MediaInput';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { VoiceConversationEvent } from '../shared/voice-conversation';
import { MutationQueue } from '../electron/mutation-queue';
import { TurnFrames } from '../electron/look-attachments';

const source=await readFile(new URL('../electron/main.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function find<T extends ts.Node>(predicate:(n:ts.Node)=>n is T,root:ts.Node=tree):T[]{const rows:T[]=[];function visit(n:ts.Node){if(predicate(n))rows.push(n);ts.forEachChild(n,visit);}visit(root);return rows;}
function variable(name:string,root:ts.Node=tree):string{const rows=find((n):n is ts.VariableStatement=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(tree)===name),root);assert.equal(rows.length,1,name);return rows[0].getText(tree);}
function fn(name:string):string{const rows=tree.statements.filter((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(rows.length,1,name);return rows[0].getText(tree);}
function compiled(code:string){return ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;}
function evaluate<T>(code:string,env:Record<string,unknown>):T{return new Function(...Object.keys(env),compiled(code))(...Object.values(env)) as T;}
async function fixture(run:(f:{directory:string;a:string;b:string;store:PersonalizeLanguageStore})=>Promise<void>){const directory=await mkdtemp(path.join(os.tmpdir(),'soft-personalize-host-')),a=randomUUID(),b=randomUUID();try{const store=new PersonalizeLanguageStore(directory,()=>[a,b]);await store.load();await run({directory,a,b,store});}finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('soft-personalize-host-'));await rm(directory,{recursive:true,force:true});}}
const profile=(tone:string)=>({enabled:true,rules:{...emptyLanguageRules(),tone}});

test('actual controls-only host handlers validate card/revision, save and undo through the real optional store',async()=>fixture(async f=>{
 const handlers=new Map<string,(event:any,...args:unknown[])=>unknown>(),events:{channel:string;state:LanguageState}[]=[];
 const controls={webContents:{id:1,send:(channel:string,state:LanguageState)=>events.push({channel,state:structuredClone(state)})}},pet={webContents:{id:2}};
 const calls=['getPersonalizeLanguage','savePersonalizeLanguage','undoPersonalizeLanguage'].map(name=>{
  const rows=find((n):n is ts.CallExpression=>ts.isCallExpression(n)&&n.expression.getText(tree)==='host'&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text===name);assert.equal(rows.length,1,name);return rows[0].getText(tree)+';';
 }).join('\n');
 evaluate(`${fn('host')}\n${fn('scopedHost')}\n${variable('mutations')}\n${variable('mutate')}\n${variable('publishLanguage')}\n${calls}`,{
  MutationQueue,controls,windows:()=>[controls,pet],ipcMain:{handle:(key:string,handler:(event:any,...args:unknown[])=>unknown)=>handlers.set(key,handler)},personalizeLanguage:f.store,languageAuthoring:undefined,
 });
 const frame={},sender={id:1,mainFrame:frame},event={sender,senderFrame:frame};
 const invoke=(name:string,...args:unknown[])=>handlers.get(`desk:${name}`)!(event,...args);
 assert.throws(()=>handlers.get('desk:getPersonalizeLanguage')!({sender:{id:2,mainFrame:frame},senderFrame:frame},f.a),/未授权/);
 assert.throws(()=>handlers.get('desk:getPersonalizeLanguage')!({sender,senderFrame:{}},f.a),/未授权/);
 assert.throws(()=>invoke('getPersonalizeLanguage','../outside'));
 const saved=await invoke('savePersonalizeLanguage',f.a,profile('仅A'),0) as LanguageState;assert.equal(saved.revision,1);assert.equal(events.length,1);assert.equal(events[0].channel,'desk:personalize-language');assert.equal(events[0].state.characterId,f.a);
 await assert.rejects(invoke('savePersonalizeLanguage',f.a,profile('旧请求'),0) as Promise<unknown>,/新修改/);
 await assert.rejects(invoke('savePersonalizeLanguage',f.b,{...profile('bad'),provider:'codex'},0) as Promise<unknown>);
 assert.equal(f.store.get(f.b).revision,0);const undone=await invoke('undoPersonalizeLanguage',f.a,1) as LanguageState;
 assert.deepEqual(undone.profile,emptyLanguageProfile());assert.equal(undone.revision,2);assert.equal(events.length,2);
}));

test('actual preload exposes only fixed language IPC routes and the exact unsubscribable host event',async()=>{
 const text=await readFile(new URL('../electron/preload.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('preload.ts',text,ts.ScriptTarget.Latest,true);
 const vars=(name:string)=>{const rows=ast.statements.filter((n):n is ts.VariableStatement=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));assert.equal(rows.length,1);return rows[0].getText(ast);};
 const sub=ast.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text==='subscribe');assert.ok(sub);
 const invocations:unknown[][]=[],listeners=new Map<string,(event:unknown,state:LanguageState)=>void>();
 const api=evaluate<any>(`${vars('invoke')}\n${sub.getText(ast)}\n${vars('api')}\nreturn api;`,{ipcRenderer:{invoke:(...args:unknown[])=>{invocations.push(args);return Promise.resolve(null);},on:(key:string,fn:(event:unknown,state:LanguageState)=>void)=>listeners.set(key,fn),removeListener:(key:string,fn:unknown)=>{assert.equal(listeners.get(key),fn);listeners.delete(key);}}});
 const id=randomUUID();await api.getPersonalizeLanguage(id);await api.savePersonalizeLanguage(id,profile('plain'),3);await api.undoPersonalizeLanguage(id,4);
 assert.deepEqual(invocations.map(row=>row[0]),['desk:getPersonalizeLanguage','desk:savePersonalizeLanguage','desk:undoPersonalizeLanguage']);assert.deepEqual(invocations[2].slice(1),[id,4]);
 let received:LanguageState|null=null;const unsubscribe=api.onPersonalizeLanguage((state:LanguageState)=>{received=state;});const state={characterId:id,revision:0,profile:emptyLanguageProfile()};listeners.get('desk:personalize-language')!({},state);assert.equal(received,state);unsubscribe();assert.equal(listeners.size,0);
});

test('actual ordinary Claude branch freezes only confirmed selected-card rules while keeping persona/user data and late profile lookup',async()=>fixture(async f=>{
 await f.store.save(f.a,profile('A规则'),0);const candidates=find((n):n is ts.IfStatement=>ts.isIfStatement(n)&&n.expression.getText(tree)==='settings.provider.kind === "claude"'&&n.thenStatement.getText(tree).includes('const languageProfile ='));
 assert.equal(candidates.length,1);let active=f.a,lookups=0,codexCalls=0,otherCalls=0;const prompts:string[]=[];
 const settings={persona:'原persona和原协议',provider:{kind:'claude',model:'synthetic'}},request={messages:[{role:'user' as const,content:'保留原问题，不执行任何任务。'}],attachments:[]};
 const streamClaude=async(task:{readonly prompt:string;writable:boolean})=>{codexCalls++;assert.equal(task.writable,false);prompts.push(task.prompt);if(codexCalls===1){await f.store.save(f.a,profile('保存后的下一轮规则'),1);prompts.push(task.prompt);}};
 const run=evaluate<()=>Promise<void>>(`return async function actual(){${candidates[0].getText(tree)}};`,{
  settings,request,store:{directory:f.directory},path,app:{getPath:()=>f.directory},PROFILE_FOLDER:'soft-hearts-claude',signal:new AbortController().signal,
  // withCurrentRecall: the late recall check (Codex T-222 E04, tests/recall-late-window.test.ts); nothing was recalled here.
  turn:{push:()=>{},withCurrentRecall:(persona:string)=>persona},profileContextLease:null,visualSelfLease:null,
  // listenAsk.current: the same check for 一起听 (tests/listen-late-window.test.ts); no 一起听 block here.
  listenAsk:{block:'',current:(persona:string)=>persona},
  personalizeLanguage:{effectiveProfile:(id:string)=>{lookups++;return f.store.effectiveProfile(id);}},characterCards:{getActive:()=>({id:active})},buildCodexChatPrompt,
  chatContextData:()=>undefined,
  // The prompt getter recomposes the perception line for this turn's frames (Codex T-205 round 4); no frames here.
  turnFrames:new TurnFrames([]),sightAgain:()=>{throw new Error('no frame was dropped');},
  // The branch now goes through the conversation-scoped manager; here it is the
  // real manager with the persistent process off, i.e. the per-message path.
  streamClaude,claudeChat:new PersistentClaudeChat({enabled:false,perMessage:streamClaude}),basePersona:settings.persona,acceptedSpeechScope:'synthetic-scope',
 });
 await run();assert.equal(lookups,1);assert.equal(prompts[0],prompts[1]);assert.ok(prompts[0].startsWith(settings.persona));assert.ok(prompts[0].includes('A规则'));assert.ok(!prompts[0].includes('保存后的下一轮规则'));
 const json=prompts[0].split('<conversation-data>\n')[1].split('\n</conversation-data>')[0];assert.equal(JSON.parse(json).currentUser,request.messages[0].content);
 active=f.b;await run();assert.equal(prompts.at(-1),buildCodexChatPrompt(settings.persona,request.messages));
 assert.equal(otherCalls,0);assert.equal(codexCalls,2);
}));

test('actual voice and proactive Claude text branches consume confirmed rules without a second speech lifecycle',async()=>fixture(async f=>{
 await f.store.save(f.a,profile('共享文字习惯'),0);const settings={persona:'原角色和心情',provider:{kind:'claude',model:'synthetic'}},request={messages:[{role:'user' as const,content:'原始当前问题'}],attachments:[]};const prompts:string[]=[];
 const voiceChunks:string[]=[],visionChunks:string[]=[],languages:unknown[]=[];
 // Voice: the actual host module (electron/voice-chat-host.ts), imported rather than cut out of main.ts. Its one
 // Claude turn gets the confirmed rules both in the per-message prompt and as the conversation session's language.
 const companion=new CompanionService(path.join(f.directory,'companion'),()=>{});await companion.load();
 const appSettings=structuredClone(DEFAULT_SETTINGS);appSettings.persona=settings.persona;appSettings.provider.model='synthetic';
 await companion.context(f.a,appSettings.provider,settings.persona);
 const events:VoiceConversationEvent[]=[];
 const voice=new VoiceChatHost({broadcast:event=>{events.push(event);if(event.type==='delta')voiceChunks.push(event.text);},memoryChanged(){},windowVisible:()=>true,
  media:()=>({voiceInput:true,voiceOwner:'controls'}),turnOffVoiceInput(){},speechScope:()=>'current-voice-scope',settings:()=>appSettings,companion:()=>companion,ambient:()=>null,
  reserveChat:()=>true,releaseChat(){},userTurn(){},activityChanged(){},cancelProactive(){},
  claude:{stream:async(task,_signal,emit)=>{assert.equal(task.writable,false);prompts.push(task.prompt);languages.push(task.session?.language);emit('delta','合成正文');return{superseded:false,output:'合成正文'};}},
  languageProfile:()=>f.store.effectiveProfile(f.a),chatDirectory:()=>f.directory,tempDirectory:()=>f.directory,
  transcribe:async()=>request.messages[0].content,stopReading(){},prepareSpeech(){}});
 const binding=voice.open(5,'controls');
 assert.equal(voice.pipeline.submit(5,{captureSessionId:binding.captureSessionId,captureSeq:1,wav:encodeWav(new Float32Array(4096).fill(0.1))}).state,'queued');
 const deadline=Date.now()+3000;while(!events.some(event=>event.type==='terminal')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 voice.dispose();await voice.drain();await companion.flush();
 assert.equal(prompts.length,1);assert.deepEqual(voiceChunks,['合成正文']);assert.deepEqual(languages,[f.store.effectiveProfile(f.a)]);
 const common={settings,request,personalizeLanguage:f.store,characterCards:{getActive:()=>({id:f.a})},buildCodexChatPrompt,personalizeLanguageContext,store:{directory:f.directory},path,app:{getPath:()=>f.directory},PROFILE_FOLDER:'soft-hearts-claude',signal:new AbortController().signal,
  streamClaude:async(task:{readonly prompt:string;writable:boolean},_signal:AbortSignal,emit:(type:string,text:string)=>void)=>{assert.equal(task.writable,false);prompts.push(task.prompt);emit('delta','合成正文');}};
 const vision=find((n):n is ts.IfStatement=>ts.isIfStatement(n)&&n.thenStatement.getText(tree).includes('personalizeLanguageContext(languageProfile)'));
 assert.equal(vision.length,1);const vars=find((n):n is ts.VariableStatement=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(tree)==='languageProfile'&&d.initializer?.getText(tree).startsWith("settings.provider.kind === 'claude'")));assert.equal(vars.length,1);
 await evaluate<()=>Promise<void>>(`return async function actual(){${vars[0].getText(tree)}\n${vision[0].getText(tree)}};`,{...common,visualSelfData:()=>undefined,visualLease:null,attachments:[],append:(value:string)=>visionChunks.push(value)})();
 assert.deepEqual(voiceChunks,['合成正文']);assert.deepEqual(visionChunks,['合成正文']);
 assert.equal(prompts.length,2);for(const prompt of prompts){assert.ok(prompt.startsWith(settings.persona));assert.ok(prompt.includes('共享文字习惯'));assert.ok(prompt.includes(request.messages[0].content));}
 assert.deepEqual(f.store.get(f.b).profile,emptyLanguageProfile());
}));
