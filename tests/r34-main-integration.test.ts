import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import {transformSync} from 'esbuild';
import {FatigueActivityBridge,verifiedFatigueBackground} from '../electron/fatigue-activity';
import {SpeechPlaybackActivity} from '../electron/speech-playback-activity';
import {CompletedReplySpeech} from '../electron/completed-reply-speech';

const asset=(name:string)=>({path:path.resolve(name),url:`mmd-asset://owned/${name}`,name});
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
test('new manual selection closes immediately; late neutral success and disposal never reopen it',async()=>{
  const changes:unknown[]=[],checks:{resolve:(v:boolean)=>void}[]=[];
  const bridge=new FatigueActivityBridge(value=>changes.push(value),()=>new Promise(resolve=>checks.push({resolve})));
  bridge.setSelection({motion:null});
  assert.deepEqual(bridge.current(),{chat:true,tts:true,manualMotion:true},'unknown startup stays closed');
  bridge.setActivity({initialized:true,chat:false,tts:false});
  assert.equal(bridge.current().manualMotion,false);
  bridge.setSelection({motion:asset('old-stand.vmd')});await flush();
  assert.equal(bridge.current().manualMotion,true,'no provisional exception');
  bridge.setSelection({motion:asset('dance.vmd'),motionLayers:{gesture:asset('manual.vmd'),expression:null}});
  checks[0].resolve(true);await flush();assert.equal(bridge.current().manualMotion,true,'old success cannot release new manual owner');
  bridge.setSelection({motion:asset('new-stand.vmd')});await flush();
  checks[1].resolve(true);await flush();assert.equal(bridge.current().manualMotion,false);
  const count=changes.length;bridge.setSelection({motion:asset('new-stand.vmd')});bridge.setActivity({initialized:true,chat:false,tts:false});
  assert.equal(changes.length,count,'unchanged ownership does not publish recursively');
  bridge.setSelection({motion:asset('pending.vmd')});await flush();bridge.dispose();checks[2].resolve(true);await flush();
  assert.deepEqual(bridge.current(),{chat:true,tts:true,manualMotion:true});
});

const hostText=await readFile(new URL('../electron/main.ts',import.meta.url),'utf8');
const hostAst=ts.createSourceFile('main.ts',hostText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function declarations(ast:ts.SourceFile,names:string[]):string{
  return names.map(name=>{const matches=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
    assert.equal(matches.length,1,name);return matches[0].getText(ast);}).join('\n');
}
function install(source:string,context:Record<string,unknown>):Record<string,any>{
  vm.createContext(context);vm.runInContext(transformSync(source,{loader:'ts',target:'es2022'}).code,context);return context;
}
test('actual host aggregation retains segment queue and final renderer playback ownership independently',()=>{
  let current:any;const owners=new Set<number>(),pending=new Map<string,any>();let logical=false,wall=100;
  const leases=new SpeechPlaybackActivity();
  const ctx=install(declarations(hostAst,['syncFatigueActivity']),{
    fatigueActivityReady:true,exiting:false,userInputUntil:0,pending,asrTask:null,readingInputSpeech:false,
    foregroundAsr:{foregroundBusy:false},ambientSpeakingOwners:owners,replySpeechBusy:()=>logical,
    fatigueActivity:{setActivity:(v:any)=>current=v},Date:{now:()=>wall},
    companion:{},store:{},speechScope:()=> 'scope-a',speechPlaybackActivity:leases,
  });
  ctx.syncFatigueActivity();assert.equal(current.chat,false);assert.equal(current.tts,false);
  pending.set('agent',{kind:'agent'});ctx.syncFatigueActivity();assert.equal(current.chat,false);
  pending.set('chat',{kind:'chat'});ctx.syncFatigueActivity();assert.equal(current.chat,true);pending.delete('chat');
  logical=true;ctx.syncFatigueActivity();assert.equal(current.tts,true,'logical queue owns gaps');
  owners.add(7);logical=false;ctx.syncFatigueActivity();assert.equal(current.tts,true,'network/queue completion is not final PCM');
  owners.clear();ctx.syncFatigueActivity();assert.equal(current.tts,false,'only final playback release opens it');
  ctx.userInputUntil=101;ctx.syncFatigueActivity();assert.equal(current.chat,true);wall=102;ctx.syncFatigueActivity();assert.equal(current.chat,false);
  ctx.readingInputSpeech=true;ctx.syncFatigueActivity();assert.equal(current.chat,true);
  const lease=leases.begin(7,'pre-dispatch');ctx.syncFatigueActivity();assert.equal(current.tts,true,'pre-dispatch lease is part of the same host aggregate');
  leases.end(7,'pre-dispatch',lease);ctx.syncFatigueActivity();assert.equal(current.tts,false);
});
test('actual completion sampler freezes only same-card same-scope known phase',()=>{
  let phase='drowsy',id='card-a',reads=0;
  const ctx=install(declarations(hostAst,['completedFatigueFeeling']),{speechScope:()=> 'scope-a',
    characterCards:{getActive:()=>({id:'card-a'})},companion:{mood:{get:()=>{reads++;return {characterId:id,fatigue:{phase,A:.9,W:.1}};}}}});
  const feeling=ctx.completedFatigueFeeling('scope-a','card-a');assert.equal(feeling.phase,'drowsy');
  assert.deepEqual(Object.keys(feeling),['phase']);assert.equal(Object.isFrozen(feeling),true);assert.equal(reads,1);
  phase='asleep';assert.equal(feeling.phase,'drowsy','later mood does not mutate frozen feeling');
  assert.equal(ctx.completedFatigueFeeling('old-scope','card-a'),undefined);assert.equal(reads,1);
  id='old-card';assert.equal(ctx.completedFatigueFeeling('scope-a','card-a'),undefined);
  id='card-a';phase='unknown';assert.equal(ctx.completedFatigueFeeling('scope-a','card-a'),undefined);
});
test('actual synthesis starts block sleep before the first audio event and retain playback tail',async()=>{
  let callback:ts.Node|undefined;function visit(n:ts.Node):void{
    if(ts.isCallExpression(n)&&n.expression.getText(hostAst)==='scopedHost'&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text==='synthesizeSpeech')callback=n.arguments[1];
    ts.forEachChild(n,visit);
  }visit(hostAst);assert.ok(callback);
  let current:any,active=false,finish!:()=>void;
  const owners=new Set<number>();
  const ctx=install(declarations(hostAst,['syncFatigueActivity'])+`\nvar synthesize=${callback.getText(hostAst)};`,{
    fatigueActivityReady:true,exiting:false,userInputUntil:0,pending:new Map(),asrTask:null,readingInputSpeech:false,
    foregroundAsr:{foregroundBusy:false},ambientSpeakingOwners:owners,replySpeechBusy:()=>active,
    fatigueActivity:{setActivity:(v:any)=>current=v},Date:{now:()=>100},
    textMemorialHost:null,companion:{},store:{},speechScope:()=> 'scope-a',speechPlaybackActivity:new SpeechPlaybackActivity(),
    speechRuntime:{speak:()=>{active=true;return new Promise<void>(resolve=>finish=resolve);}},
  });
  ctx.syncFatigueActivity();assert.equal(current.tts,false);
  const operation=ctx.synthesize(7,'preview','text');assert.equal(current.tts,true,'must close synchronously before any audio callback');
  owners.add(7);active=false;finish();await operation;assert.equal(current.tts,true,'synthesis settling is not final PCM');
  owners.clear();ctx.syncFatigueActivity();assert.equal(current.tts,false);
});
test('actual activity IPC denies hidden owners and releases only the exact owner lease',async()=>{
  const callbacks:Record<string,string>={};function visit(n:ts.Node):void{
    if(ts.isCallExpression(n)&&n.expression.getText(hostAst)==='scopedHost'&&ts.isStringLiteral(n.arguments[0])
      &&['beginSpeechPlaybackActivity','endSpeechPlaybackActivity'].includes(n.arguments[0].text))callbacks[n.arguments[0].text]=n.arguments[1].getText(hostAst);
    ts.forEachChild(n,visit);
  }visit(hostAst);assert.equal(Object.keys(callbacks).length,2);
  const leases=new SpeechPlaybackActivity();leases.setScope('scope-a');let visible=false,minimized=false;
  const ctx=install(declarations(hostAst,['canBeginSpeechPlaybackActivity'])+`\nvar begin=${callbacks.beginSpeechPlaybackActivity};var end=${callbacks.endSpeechPlaybackActivity};`,{
    syncFatigueActivity:()=>{},speechPlaybackActivity:leases,controls:null,speechScope:()=> 'scope-a',completedReplySpeech:new CompletedReplySpeech(),
    windows:()=>[{webContents:{id:7},isVisible:()=>visible,isMinimized:()=>minimized}],
  });
  assert.equal(await ctx.begin(7,'a'),null);assert.equal(leases.busy,false);
  visible=true;minimized=true;assert.equal(await ctx.begin(7,'a'),null);
  minimized=false;assert.equal(await ctx.begin(9,'a'),null,'another managed identity is not borrowed');
  const lease=await ctx.begin(7,'a');assert.equal(typeof lease,'string');assert.equal(leases.busy,true);
  ctx.end(9,'a',lease);assert.equal(leases.busy,true);
  visible=false;ctx.end(7,'a',lease);assert.equal(leases.busy,false,'hidden owner can still release its exact lease');
});
test('background exception verifies approved path and original pinned bytes, not a Stand filename',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const approved=path.join(root,'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/motions/pose/stand.vmd');
  const library={resolvePreview:async(pack:unknown,id:unknown)=>{assert.equal(pack,'gene');assert.equal(id,'stand');return approved;}};
  assert.equal(await verifiedFatigueBackground({...asset('irrelevant-name.vmd'),path:approved},library),true);
  assert.equal(await verifiedFatigueBackground(asset('stand.vmd'),library),false,'foreign familiar name cannot qualify');
  const directory=await mkdtemp(path.join(tmpdir(),'soft-hearts-r34-stand-')),file=path.join(directory,'stand.vmd');
  try{const bytes=Buffer.alloc(56611);bytes.write('Vocaloid Motion Data 0002');await writeFile(file,bytes,{flag:'wx'});
    assert.equal(await verifiedFatigueBackground({...asset('stand.vmd'),path:file},{resolvePreview:async()=>file}),false,'same header and length still require hash');
  }finally{await unlink(file);await rmdir(directory);}
});
test('actual renderer binds accepted card and invalidates first identity as well as switches',async()=>{
  const text=await readFile(new URL('../src/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('renderer.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const options:Record<string,string>={};function visit(n:ts.Node):void{
    if(ts.isNewExpression(n)&&n.expression.getText(ast)==='MoodCompanion')for(const p of (n.arguments?.[0] as ts.ObjectLiteralExpression).properties)
      if(ts.isPropertyAssignment(p)&&['getCharacterId','onScopeInvalidated'].includes(p.name.getText(ast)))options[p.name.getText(ast)]=p.initializer.getText(ast);
    ts.forEachChild(n,visit);
  }visit(ast);assert.equal(Object.keys(options).length,2);
  const resets:string[]=[],clears:string[]=[],refills:boolean[]=[];let stageInvalidations=0,voiceChecks=0;
  const ctx=install(declarations(ast,['applyCharacterCards'])+`\nvar getAccepted=${options.getCharacterId};var invalidate=${options.onScopeInvalidated};`,{
    petFramingController:null,characterState:null,characterName:'',characterControls:null,characterPage:null,emotionalVoiceControls:null,ambientTranscriptHistory:null,memoryPanel:null,
    feedCuePrefetch:{voiceContextChanged:()=>{voiceChecks++;}},
    moodCompanion:{reset:(reason:string)=>resets.push(reason)},stage:{invalidateMoodScope:()=>stageInvalidations++},
    compileCharacterPersona:()=>'',clearChat:()=>clears.push('clear'),refillChat:(greeting:boolean)=>refills.push(greeting),showCharacterGreeting:()=>{},notify:()=>{},$:()=>null,history:[],activeChat:null,
  });
  const card=(id:string)=>({id,name:id,greeting:'hello'});
  ctx.applyCharacterCards({revision:1,activeId:'a',cards:[card('a')]});assert.equal(ctx.getAccepted(),'a');assert.deepEqual(resets,['character']);
  ctx.applyCharacterCards({revision:2,activeId:'a',cards:[card('a')]});assert.equal(resets.length,1,'metadata alone is not a scope change');
  ctx.applyCharacterCards({revision:3,activeId:'b',cards:[card('b')]});assert.equal(ctx.getAccepted(),'b');assert.equal(resets.length,2);assert.equal(clears.length,1);
  assert.deepEqual(refills,[true],'C2: a switch refills the window with her conversation (greeting only when she has none)');
  assert.equal(voiceChecks,3,'B06: every accepted card state lets the cue prefetch check for a new character voice');
  ctx.applyCharacterCards({revision:1,activeId:'a',cards:[card('a')]});assert.equal(ctx.getAccepted(),'b','late old card state is ignored');
  ctx.invalidate();assert.equal(stageInvalidations,1);
});
