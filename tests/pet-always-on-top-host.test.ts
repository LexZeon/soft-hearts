import assert from 'node:assert/strict';
import { MutationQueue } from '../electron/mutation-queue';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {DEFAULT_SETTINGS} from '../shared/defaults';
import {publicSettings, KEY_SENTINEL} from '../electron/settings';

// Use the existing host-wiring fixture pattern: execute actual registrations,
// sender gate and mutation queue with memory-only persistence, never Electron.
const text=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',text,ts.ScriptTarget.ES2022,true);
const find=(name:string)=>{
  const items=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert.equal(items.length,1,name);return items[0]!.getText(ast);
};
const variables=['mutations','mutate','companionCommandRevision','companionCommandObservedTop'].map(name=>{
  const items=ast.statements.filter(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name));
  assert.equal(items.length,1,name);return items[0]!.getText(ast);
});
const registration=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='registerIPC');
assert.ok(registration&&ts.isFunctionDeclaration(registration)&&registration.body);
const statements=['setPetAlwaysOnTop','saveSettings'].map(name=>{
  const items=registration.body!.statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)
    &&['host','scopedHost'].includes(n.expression.expression.getText(ast))&&ts.isStringLiteral(n.expression.arguments[0])&&n.expression.arguments[0].text===name);
  assert.equal(items.length,1,name);return items[0]!.getText(ast);
});
const code=ts.transpileModule([...variables,find('host'),find('scopedHost'),find('noteCompanionTopmostWrite'),...statements].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture(){
  const controls={webContents:{id:1}},pet={webContents:{id:2},isDestroyed:()=>false};
  let live=[controls,pet],gate:Promise<void>|null=null,fail=false;
  const handlers=new Map<string,(...args:any[])=>unknown>(),commits:boolean[]=[],synced:number[]=[];
  const current=structuredClone(DEFAULT_SETTINGS);current.voiceInput!.apiKey='synthetic-host-only';
  const store={current,async persist(next:typeof current){
    if(gate){const waiting=gate;gate=null;await waiting;}
    if(fail){fail=false;throw Error('synthetic persistence failure');}
    store.current=next;commits.push(next.pet.alwaysOnTop);return publicSettings(next);
  }};
  const sandbox={MutationQueue,controls,pet,store,publicSettings,windows:()=>live,
    ipcMain:{handle:(name:string,callback:(...args:any[])=>unknown)=>handlers.set(name,callback)},
    sync:(sender:number)=>synced.push(sender),validateSettings:(v:typeof current)=>structuredClone(v),
    characterCards:{getActive:()=>({id:'fixture'})},compileCharacterPersona:()=>current.persona,
    motionAssetBaseline:()=>null,resolveVoiceInputKey:(v:unknown)=>v,
    memoryProviderScope:()=> 'fixture',fitSettingsScale:(v:unknown)=>v,
    companion:{context:async()=>{}},publishVisionState:()=>{},activateUserProfile:async()=>{},
  };
  runInNewContext(code,sandbox);
  const invoke=(method:string,id:number,value:unknown,main=true)=>{
    const frame={};return handlers.get('desk:'+method)!({sender:{id,mainFrame:frame},senderFrame:main?frame:{}},value);
  };
  return {store,commits,synced,invoke,dropPet:()=>{live=[controls];},block:(p:Promise<void>)=>{gate=p;},fail:()=>{fail=true;}};
}

test('actual topmost sender gate and bool intent reject foreign, subframe and malformed requests before commit',async()=>{
  const h=fixture();
  assert.throws(()=>h.invoke('setPetAlwaysOnTop',3,false),/未授权/);
  for(const id of [1,2])assert.throws(()=>h.invoke('setPetAlwaysOnTop',id,false,false),/未授权/);
  for(const value of [null,undefined,'false',0,{},[]])await assert.rejects(h.invoke('setPetAlwaysOnTop',1,value) as Promise<unknown>,/不正确/);
  assert.deepEqual(h.commits,[]);assert.deepEqual(h.synced,[]);
});
test('actual queued topmost intent rechecks a sender removed before execution',async()=>{
  const h=fixture();const pending=h.invoke('setPetAlwaysOnTop',2,false) as Promise<unknown>;h.dropPet();
  await assert.rejects(pending,/未授权/);assert.deepEqual(h.commits,[]);
});
test('actual mutation queue preserves topness across an old whole-form save and retains the form edit',async()=>{
  const h=fixture();let release!:()=>void;h.block(new Promise<void>(r=>{release=r;}));
  const stale=structuredClone(h.store.current);stale.camera.yaw=12;
  const off=h.invoke('setPetAlwaysOnTop',1,false) as Promise<any>;
  const form=h.invoke('saveSettings',1,stale) as Promise<any>;
  const on=h.invoke('setPetAlwaysOnTop',2,true) as Promise<any>;
  release();const results=await Promise.all([off,form,on]);
  assert.deepEqual(h.commits,[false,false,true]);assert.deepEqual(h.synced,[1,1,2]);
  assert.equal(results[1].pet.alwaysOnTop,false);assert.equal(results[2].camera.yaw,12);
  assert.equal(h.store.current.pet.alwaysOnTop,true);assert.equal(h.store.current.camera.yaw,12);
  assert.equal(results[0].voiceInput.apiKey,KEY_SENTINEL);
});
test('actual failed topmost persistence neither syncs nor changes state, and later requests can commit',async()=>{
  const h=fixture();h.fail();await assert.rejects(h.invoke('setPetAlwaysOnTop',1,false) as Promise<unknown>,/persistence failure/);
  assert.equal(h.store.current.pet.alwaysOnTop,true);assert.deepEqual(h.synced,[]);
  await h.invoke('setPetAlwaysOnTop',2,false);assert.deepEqual(h.commits,[false]);assert.deepEqual(h.synced,[2]);
});
test('actual idempotent topmost response uses public settings without an extra persistence write',async()=>{
  const h=fixture();const accepted=await h.invoke('setPetAlwaysOnTop',2,true) as any;
  assert.deepEqual(h.commits,[]);assert.deepEqual(h.synced,[2]);assert.equal(accepted.voiceInput.apiKey,KEY_SENTINEL);
});
