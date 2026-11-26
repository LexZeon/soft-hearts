import assert from 'node:assert/strict';
import { MutationQueue } from '../electron/foundation/mutation-queue';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {DEFAULT_SETTINGS} from '../shared/foundation/defaults';
import {publicSettings, KEY_SENTINEL} from '../electron/settings/settings';
import { ipcGuardSource, registeredInRegisterIpc, saveSettingsStepsSource, wiringFunction, wiringNodes, wiringRegistration } from './helpers/wiring-source';

// Use the existing host-wiring fixture pattern: execute actual registrations,
// sender gate and mutation queue with memory-only persistence, never Electron.
const text=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',text,ts.ScriptTarget.ES2022,true);
const find=(name:string)=>{
  const items=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
  assert.equal(items.length,1,name);return items[0]!.getText(ast);
};
// Wiring rewrite step 4: the command revisions, noteCompanionTopmostWrite and saveSettings are the settings part's
// (electron/wiring/settings-wiring.ts; its register registers saveSettings); they are read across main.ts and electron/wiring/*.ts, still
// exactly one of each. saveSettings' steps are the list electron/main.ts gives (saveSettingsStepsSource: the actual steps, in order).
const variables=['mutations','mutate','companionCommandRevision','companionCommandObservedTop'].map(name=>{
  const items=wiringNodes((n):n is ts.VariableStatement=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name));
  assert.equal(items.length,1,name);return items[0]!.node.getText(items[0]!.ast);
});
// Wiring rewrite step 4g: setPetAlwaysOnTop is 舞台's ('electron/wiring/stage-wiring.ts'), registered by its register inside registerIPC (the recorder).
assert.ok(registeredInRegisterIpc('setPetAlwaysOnTop'),'setPetAlwaysOnTop is registered in registerIPC');
const statements=['setPetAlwaysOnTop','saveSettings'].map(name=>wiringRegistration(name));
// Wiring rewrite step 3: the IPC guard is electron/wiring/ipc-wiring.ts (ipcGuardSource: its actual host / scopedHost).
const code=ts.transpileModule([...variables,ipcGuardSource(),wiringFunction('noteCompanionTopmostWrite'),saveSettingsStepsSource(),...statements].join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
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
    characterCards:{getActive:()=>({id:'fixture'})},compileCharacterPersona:()=>current.persona,followSavedVoice:()=>{},
    noteClickThrough:()=>{},appJournal:{setting(){}},journalCharacterId:()=>null,
    motionAssetBaseline:()=>null,resolveVoiceInputKey:(v:unknown)=>v,
    memoryProviderScope:()=> 'fixture',fitSettingsScale:(v:unknown)=>v,
    companion:{context:async()=>{},contextChange:()=>'same'},publishVisionState:()=>{},activateUserProfile:async()=>{},
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
