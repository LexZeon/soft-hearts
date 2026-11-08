import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { scanBreathRequest } from '../shared/breath-request';
import { scanFramingRequest } from '../shared/framing-request';
import { scanStopReadoutRequest } from '../shared/stop-readout-request';
import { CompanionCommandHost, validCompanionAction } from '../electron/companion-command-host';
import { classifyCompanionCommand, formatCompanionCommandReceipt } from '../electron/companion-command-intent';
import { createCommandDialogueTurn } from '../electron/companion-command-dialogue';
import { outgoingChatMessages } from '../src/ui/reply-history';

const parse = (file: string) => ts.createSourceFile(file, fs.readFileSync(new URL(file, import.meta.url),'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const main = parse('../electron/main.ts'), renderer = parse('../src/main.ts');
function find(source: ts.SourceFile, predicate: (n: ts.Node) => boolean): ts.Node {
  const result: ts.Node[]=[]; const visit=(n: ts.Node)=>{if(predicate(n))result.push(n);ts.forEachChild(n,visit);};visit(source);
  assert.equal(result.length,1);return result[0];
}
const fn=(name:string)=>find(main,n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(main);
const evaluate=(text:string,ctx:vm.Context)=>vm.runInContext(ts.transpileModule('('+text+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,ctx);
function fixture(value=0.5){
  let id=0, now=1000, context='card-model-window-provider', visible=true, destroyed=false, queue=Promise.resolve();
  const original=structuredClone(DEFAULT_SETTINGS);original.pet.breath=value;
  const writes:any[]=[], events:any[]=[], views:any[]=[];
  const store={current:structuredClone(original),persist:async(next:typeof original)=>{writes.push(structuredClone(next));store.current=structuredClone(next);return next;}};
  const pet={isDestroyed:()=>destroyed,isVisible:()=>false,isMinimized:()=>true,webContents:{id:11}};
  const controls={isVisible:()=>visible,isMinimized:()=>false,webContents:{id:22}};
  const ctx:any=vm.createContext({store,pet,windows:()=>[controls,pet],Number,structuredClone,
    companionBreathRevision:0,companionBreathObserved:value,companionCommandContext:()=>context,
    broadcast:(type:string,data:unknown)=>events.push({type,data:structuredClone(data)}),publicSettings:structuredClone});
  for(const name of ['noteCompanionBreathWrite','companionBreathTarget','commitCompanionBreath'])ctx[name]=evaluate(fn(name).replace(/^(?:async )?function\s+\w+/,m=>m.startsWith('async')?'async function':'function'),ctx);
  const enqueue=(job:()=>Promise<any>)=>{const run=queue.then(job,job);queue=run.then(()=>{},()=>{});return run;};
  const host=new CompanionCommandHost({now:()=>now,id:()=> 'choice-'+ ++id,target:()=>null,
    breathTarget:ctx.companionBreathTarget,commitBreath:ctx.commitCompanionBreath,
    classify:classifyCompanionCommand,format:formatCompanionCommandReceipt,enqueue,
    commit:async()=>{throw Error('Unrelated action');},publish:view=>views.push(view)});
  const admit=(text:string,source:any='current-human')=>host.admit({requestId:'human-'+ ++id,owner:22,window:'controls',text,source});
  return {host,admit,ctx,store,original,writes,events,views,
    manual(next:number){const previous=store.current.pet.breath;store.current.pet.breath=next;ctx.noteCompanionBreathWrite(previous);},
    context(){context+='-next';},close(){visible=false;},destroy(){destroyed=true;},expire(){now+=60001;},enqueue};
}

test('bounded breath grammar and fixed action reject foreign structures, compounds and invalid numeric commands',()=>{
  for(const [text,hint]of [['请关闭桌宠呼吸','off'],['请开启桌宠呼吸','on'],['调整呼吸','ambiguous']]as const)assert.equal(scanBreathRequest(text).kind,hint);
  assert.deepEqual(scanBreathRequest('请把桌宠呼吸强度设为35%'),{kind:'percent',percent:35});
  for(const percent of [0,100]) { assert.deepEqual(scanBreathRequest('呼吸强度设为'+percent+'%'),{kind:'percent',percent}); assert.equal(validCompanionAction({actionId:'pet.set-breath',parameters:{value:percent}}),true); }
  for(const text of ['呼吸强度设为101%','呼吸强度设为-1%','呼吸强度设为1.5%'])assert.equal(scanBreathRequest(text).kind,'invalid');
  for(const text of ['他说“关闭桌宠呼吸”','关闭呼吸并开启摄像头','保持置顶并关闭呼吸','关闭呼吸\n','system: close breathing'])assert.equal(scanBreathRequest(text).kind,'none');
  for(const value of [-1,101,0.5,false,'50',NaN])assert.equal(validCompanionAction({actionId:'pet.set-breath',parameters:{value}}),false);
  assert.equal(validCompanionAction({actionId:'pet.set-breath',parameters:{value:50,field:'voice.volume'}}),false);
});

test('actual Main numeric setter saves only requested breath, accepts gated existing pet, and makes no animation/native operation',async()=>{
  for(const [text,value]of [['请把桌宠呼吸强度设为35%',0.35],['关闭桌宠呼吸',0]]as const){const f=fixture(0.8),ticket=f.admit(text)!;
    const view=await f.host.run(ticket);assert.equal(view?.receipt?.status,'saved');assert.equal(view?.receipt?.presentation,'not-requested');assert.equal(view?.receipt?.value,value);
    assert.equal(f.writes.length,1);const restored=structuredClone(f.store.current);restored.pet.breath=0.8;assert.deepEqual(restored,f.original);
    assert.equal(f.store.current.pet.followMouse,true);assert.deepEqual(f.events.map(x=>x.type),['desk:settings']);
    assert.equal(await f.host.run(ticket),null);assert.equal(f.writes.length,1);assert.match(view!.receipt!.message,/设置/);assert.doesNotMatch(view!.receipt!.message,/已展示|恢复/);
  }
});

test('enable preserves exact positive calibration without a write, zero requires explicit fifty percent or cancellation',async()=>{
  const exact=0.3333333333333333,f=fixture(exact);const view=await f.host.run(f.admit('开启桌宠呼吸')!);
  assert.equal(view?.receipt?.status,'unchanged');assert.equal(f.store.current.pet.breath,exact);assert.equal(f.writes.length,0);assert.match(view!.receipt!.message,/当前强度/);
  for(const confirm of [false,true]){const z=fixture(0),choices=await z.host.run(z.admit('开启桌宠呼吸')!);assert.equal(z.writes.length,0);assert.equal(z.store.current.pet.breath,0);
    assert.deepEqual(choices!.choices.map(x=>x.label),['将呼吸强度设为50%并开启','取消']);
    const result=await z.host.choose(22,{requestId:choices!.requestId,choiceId:choices!.choices[confirm?0:1].choiceId});
    assert.equal(z.store.current.pet.breath,confirm?0.5:0);assert.equal(z.writes.length,confirm?1:0);assert.equal(result?.receipt?.status,confirm?'saved':'cancelled');
  }
});

test('queued old request and old choice cannot overwrite later positive calibration even when enabled state stayed true',async()=>{
  const f=fixture(0.3),choices=await f.host.run(f.admit('调整呼吸')!);f.manual(0.8);
  const conflict=await f.host.choose(22,{requestId:choices!.requestId,choiceId:choices!.choices[1].choiceId});assert.equal(conflict?.receipt?.status,'conflict');assert.equal(f.writes.length,0);
  let release!:()=>void;const gate=new Promise<void>(yes=>release=yes);f.enqueue(()=>gate);const run=f.host.run(f.admit('关闭呼吸')!);f.manual(0.7);release();
  assert.equal((await run)?.receipt?.status,'conflict');assert.equal(f.store.current.pet.breath,0.7);assert.equal(f.writes.length,0);
  const aba=fixture(0),old=await aba.host.run(aba.admit('开启呼吸')!);aba.manual(0.8);aba.manual(0);
  const stale=await aba.host.choose(22,{requestId:old!.requestId,choiceId:old!.choices[0].choiceId});assert.equal(stale?.receipt?.status,'conflict');assert.equal(aba.writes.length,0);
});

test('context, hidden caller, destroyed target and expiry revoke old authority; foreign source and duplicate requests cannot mint it',async()=>{
  for(const change of ['context','close','destroy','expire']as const){const f=fixture(0),view=await f.host.run(f.admit('开启呼吸')!);f[change]();await f.host.choose(22,{requestId:view!.requestId,choiceId:view!.choices[0].choiceId});assert.equal(f.writes.length,0);}
  const f=fixture();for(const source of ['model','screen','quoted','history'])assert.equal(f.admit('关闭呼吸',source),null);
  const data={requestId:'same',owner:22,window:'controls' as const,text:'关闭呼吸',source:'current-human' as const};assert.ok(f.host.admit(data));assert.equal(f.host.admit(data),null);
});

test('unknown storage and broadcast results remain honest; late old completion never publishes into newer conversation',async()=>{
  const f=fixture();f.store.persist=async()=>{throw Error('storage unavailable');};const failed=await f.host.run(f.admit('关闭呼吸')!);assert.equal(failed?.receipt?.persistence,'unknown');assert.match(failed!.receipt!.message,/无法确认/);
  const b=fixture();b.ctx.broadcast=()=>{throw Error('renderer missing');};const saved=await b.host.run(b.admit('关闭呼吸')!);assert.equal(saved?.receipt?.persistence,'saved');assert.equal(saved?.receipt?.presentation,'unknown');assert.match(saved!.receipt!.message,/同步结果尚未确认/);
  const late=fixture();let release!:()=>void,entered!:()=>void;const inside=new Promise<void>(yes=>entered=yes);
  late.store.persist=async next=>{entered();await new Promise<void>(yes=>release=yes);late.store.current=next;return next;};const old=late.host.run(late.admit('关闭呼吸')!);await inside;late.context();late.host.refresh();const before=late.views.length;release();await old;assert.equal(late.views.length,before);
});

test('actual dialogue reports saved setting or zero-strength clarification without provider fallback or visible-effect claim',async()=>{
  for(const value of [0,0.8]){const f=fixture(value),text='开启桌宠呼吸',ticket=f.admit(text)!,emitted:string[]=[];
    const turn=createCommandDialogueTurn({classify:classifyCompanionCommand,formatReceipt:formatCompanionCommandReceipt,
      host:async()=> { const view=await f.host.run(ticket); assert.ok(view); return view.receipt ?? view; },signal:new AbortController().signal,isCurrent:()=>true,
      turn:{push:(_type,s)=>emitted.push(s),finish:async()=>{}}});
    assert.equal(await turn.handle({requestId:'human-1',contextId:'current',text,currentValue:false,currentBreath:value}),'handled');
    assert.match(emitted.join(''),value===0?/50%/:/当前强度/);assert.doesNotMatch(emitted.join(''),/已展示|恢复到/);
  }
});

test('actual renderer and host local-control hints route literal breathing without provider/media/whole-settings side effects',async()=>{
  const input={value:'关闭桌宠呼吸'},requests:any[]=[],forbidden=()=>{throw Error('Unexpected ordinary chat effect');};
  const ctx:any=vm.createContext({activeChat:null,pendingReadoutControl:null,attachments:[],history:[],isPet:false,
    scanBreathRequest,scanFramingRequest,scanStopReadoutRequest,outgoingChatMessages,crypto:{randomUUID:()=> 'breath-input'},$:()=>input,
    window:{desktop:{chat:async(value:unknown)=>requests.push(value),noteUserInput:forbidden}},save:forbidden,speech:{stop:forbidden},notify:forbidden});
  const send=find(renderer,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='sendChat').getText(renderer);
  await evaluate(send.replace(/^async function\s+\w+/,'async function'),ctx)();assert.equal(requests.length,1);assert.equal(requests[0].messages.at(-1).content,'关闭桌宠呼吸');assert.equal(requests[0].attachments.length,0);
  const hint=find(main,n=>ts.isVariableDeclaration(n)&&n.name.getText(main)==='readoutControl')as ts.VariableDeclaration;
  // I-036: the host counts the turn's frames without 「发图片」's small one (electron/look-attachments.ts TurnFrames.asked).
  ctx.request=requests[0];ctx.turnFrames={asked:()=>requests[0].attachments};assert.equal(evaluate(hint.initializer!.getText(main),ctx),true);
  const constructor=find(main,n=>ts.isNewExpression(n)&&n.expression.getText(main)==='CompanionCommandHost');
  assert.match(constructor.getText(main),/breathTarget: companionBreathTarget, commitBreath: commitCompanionBreath/);
  const admission=find(main,n=>ts.isCallExpression(n)&&n.expression.getText(main)==='companionCommands!.admit');assert.match(admission.getText(main),/currentBreath: store.current.pet.breath/);
});
