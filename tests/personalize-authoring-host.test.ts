import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';
import { readFile } from 'node:fs/promises';import { createHash,randomUUID } from 'node:crypto';import path from 'node:path';
import { PersonalizeAuthoring } from '../electron/personalize-authoring';import { emptyLanguageRules } from '../shared/personalize-language';
const source=await readFile(new URL('../electron/main.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
function find<T extends ts.Node>(predicate:(n:ts.Node)=>n is T,root:ts.Node=tree):T[]{const rows:T[]=[];function visit(n:ts.Node){if(predicate(n))rows.push(n);ts.forEachChild(n,visit);}visit(root);return rows;}
const compiled=(code:string)=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const evaluate=<T>(code:string,env:Record<string,unknown>)=>new Function(...Object.keys(env),compiled(code))(...Object.values(env)) as T;
const fn=(name:string)=>{const rows=tree.statements.filter((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(rows.length,1);return rows[0].getText(tree);};
test('actual Main authoring constructor reuses pending chat gate, exact plain Claude adapter and no ordinary lifecycle',async()=>{
 const rows=find((n):n is ts.NewExpression=>ts.isNewExpression(n)&&n.expression.getText(tree)==='PersonalizeAuthoring');assert.equal(rows.length,1);
 const id=randomUUID(),pending=new Map(),requests:any[]=[],store={directory:'synthetic-no-files',current:{provider:{kind:'claude',model:'synthetic-model'}}};let syncs=0;
 const state={currentScope:'one',asrTask:null};const env={PersonalizeAuthoring,createHash,path,store,characterCards:{getActive:()=>({id})},personalizeLanguage:{get:()=>({revision:0})},speechScope:()=>state.currentScope,compileCharacterPersona:()=> 'synthetic-card',
  exiting:false,pending,asrTask:state.asrTask,foregroundAsr:{foregroundBusy:false},readingInputSpeech:false,voiceHost:{busy:false},proactiveVision:{pendingId:null},replySpeechBusy:()=>false,ambientSpeakingOwners:new Set(),syncFatigueActivity:()=>{syncs++;},
  streamClaude:async(task:any,signal:AbortSignal,emit:(type:string,text:string)=>void)=>{assert.equal(signal.aborted,false);requests.push(task);emit('status','不得成为研究候选');emit('delta',JSON.stringify({observations:[],inferences:[],questions:[],insufficient:'合成材料不足',rules:emptyLanguageRules()}));},
 };
 const service=evaluate<PersonalizeAuthoring>(`${fn('reserveCompanionAuthoring')}\nreturn ${rows[0].getText(tree)};`,env),session=service.open(1,id,0);
 const request={sessionId:session.id,revision:0,materials:'合成材料',refinement:'',rules:emptyLanguageRules()};
 pending.set('ordinary',{kind:'chat'});await assert.rejects(service.research(1,request),/不会打断或排队/);assert.equal(requests.length,0);assert.equal(pending.size,1);pending.clear();
 const result=await service.research(1,request);assert.equal(result.study.insufficient,'合成材料不足');assert.equal(pending.size,0);assert.equal(syncs,2);
 assert.equal(requests.length,1);assert.equal(requests[0].kind,'chat');assert.equal(requests[0].writable,false);assert.deepEqual(requests[0].imageDataUrls,[]);assert.equal(requests[0].workingDirectory,path.join(store.directory,'chat'));
 assert.ok(requests[0].prompt.includes('<language-authoring-data>'));assert.equal(Object.hasOwn(requests[0],'persona'),false);
});
test('actual Main controls-only authoring IPC owns sender, denies pet/foreign frame, closes exact session',async()=>{
 const handlers=new Map<string,(event:any,...args:any[])=>any>(),calls:any[]=[],controls={webContents:{id:1}},pet={webContents:{id:2}};
 const ports=['openLanguageAuthoring','researchLanguage','cancelLanguageAuthoring','closeLanguageAuthoring'];
 const code=ports.map(name=>{const rows=find((n):n is ts.CallExpression=>ts.isCallExpression(n)&&n.expression.getText(tree)==='scopedHost'&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text===name);assert.equal(rows.length,1);return rows[0].getText(tree)+';';}).join('\n');
 evaluate(`${fn('scopedHost')}\n${code}`,{controls,windows:()=>[controls,pet],ipcMain:{handle:(key:string,cb:any)=>handlers.set(key,cb)},languageAuthoring:{open:(...v:any[])=>calls.push(['open',...v]),research:(...v:any[])=>calls.push(['research',...v]),close:(...v:any[])=>calls.push(['close',...v])}});
 const frame={},event={sender:{id:1,mainFrame:frame},senderFrame:frame};
 for(const name of ports){const handler=handlers.get(`desk:${name}`)!;assert.throws(()=>handler({sender:{id:2,mainFrame:frame},senderFrame:frame},'bad'),/未授权/);assert.throws(()=>handler({...event,senderFrame:{}},'bad'),/未授权/);}
 handlers.get('desk:openLanguageAuthoring')!(event,'card',0);handlers.get('desk:researchLanguage')!(event,{data:'synthetic'});handlers.get('desk:cancelLanguageAuthoring')!(event,'session');handlers.get('desk:closeLanguageAuthoring')!(event,'session');
 assert.deepEqual(calls,[['open',1,'card',0],['research',1,{data:'synthetic'}],['close',1,'session'],['close',1,'session']]);
});
test('actual preload fixed authoring ports forward data only; shared context and window destruction revoke sessions',async()=>{
 const raw=await readFile(new URL('../electron/preload.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('preload.ts',raw,ts.ScriptTarget.Latest,true);
 const vars=(name:string)=>{const rows=ast.statements.filter((n):n is ts.VariableStatement=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name));assert.equal(rows.length,1);return rows[0].getText(ast);};
 const sub=ast.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text==='subscribe');assert.ok(sub);
 const calls:any[][]=[];const api=evaluate<any>(`${vars('invoke')}\n${sub.getText(ast)}\n${vars('api')}\nreturn api;`,{ipcRenderer:{invoke:(...args:any[])=>{calls.push(args);return Promise.resolve(null);}}});
 const data={sessionId:randomUUID(),revision:0,materials:'合成',refinement:'',rules:emptyLanguageRules()};
 await api.openLanguageAuthoring('card',0);await api.researchLanguage(data);await api.cancelLanguageAuthoring('session');await api.closeLanguageAuthoring('session');
 assert.deepEqual(calls.map(v=>v[0]),['desk:openLanguageAuthoring','desk:researchLanguage','desk:cancelLanguageAuthoring','desk:closeLanguageAuthoring']);assert.equal(calls[1][1],data);
 let invalidations=0;const clear=fn('clearVisionContext');assert.ok(clear.includes('languageAuthoring?.invalidate()'));
 // Execute the actual added invalidation statement, keeping old unrelated vision gates outside this scope.
 const body=tree.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text==='clearVisionContext')!.body!;
 const language=body.statements.find(statement=>statement.getText(tree)==='languageAuthoring?.invalidate();');assert.ok(language);
 evaluate(language.getText(tree),{languageAuthoring:{invalidate:()=>{invalidations++;}}});assert.equal(invalidations,1);
 const destroyed=find((n):n is ts.CallExpression=>ts.isCallExpression(n)&&n.expression.getText(tree)==='win.webContents.on'&&n.arguments[0]?.getText(tree)==='"destroyed"');assert.equal(destroyed.length,1);assert.ok(destroyed[0].getText(tree).includes('languageAuthoring?.close(windowId)'));
});
