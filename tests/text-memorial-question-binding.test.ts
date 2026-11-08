import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { TextMemorialHost } from '../electron/text-memorial-host';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { validateReplyUpdate } from '../electron/reply-input';

const raw=fs.readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('main.ts',raw,ts.ScriptTarget.Latest,true);
let callback='';function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='scopedHost'&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text==='updatePetReply'){assert.equal(callback,'');callback=n.arguments[1].getText(tree);}ts.forEachChild(n,visit);}visit(tree);assert.ok(callback);
const compiled=ts.transpileModule('('+callback+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

test('actual native-update host route revokes A when B replaces it, while an already accepted A consent survives its own reply',async()=>{
 for(const mode of ['later-question-before-human','own-reply-after-human']as const){
  const directory=await mkdtemp(path.join(os.tmpdir(),'soft-r39-question-')),gate=new ProactiveSpeechGate();gate.setScope('gate');
  let shown='',accepting=false,ready!:()=>void;const loaded=new Promise<void>(resolve=>{ready=resolve;});
  const quote='今天我完成了一件珍贵的小事。',purpose='留作共同经历的文字纪念',invite=`你愿意把“${quote}”${purpose}吗？`;
  const surface={waitForPresentation:async(text:string)=>text===shown,isPresentationCurrent:(text:string)=>text===shown,
   update(value:unknown){const patch=validateReplyUpdate(value);if(patch.state==='waiting'||patch.state==='hidden')shown='';else if(patch.text!==undefined)shown=patch.text;}};
  const host=new TextMemorialHost({directory:path.join(directory,'memorials'),gate,scope:()=>({characterId:'role',providerScope:'provider'}),identity:()=> 'context',gateScope:()=> 'gate',owner:()=>7,surface:()=>surface,eligible:()=>!accepting,event:()=>{},changed:view=>{if(view)ready();},archive:async()=>{},freezeSpeech:()=>{},cancelSpeech:()=>{}});
  const context={pet:{webContents:{id:7}},petReply:surface,textMemorialHost:host,validateReplyUpdate};vm.createContext(context);const update=vm.runInContext(compiled,context)as(sender:number,value:unknown)=>void;
  try{
   host.sync();await loaded;const source=host.accept({requestId:'source',messageId:'source',text:quote,acceptedAt:Date.now(),source:'text'},'context');assert.ok(source);await source.result;source.complete(true,JSON.stringify({quote,purpose,invite}));
   assert.equal(host.offerOpportunity({id:'one-opportunity',kind:'speech',until:Date.now()+5000}),true);const state=host.getOffer();assert.ok(state.offer);
   update(7,{state:'streaming',text:invite});const presented=await host.acknowledge(7,{id:state.offer.id,revision:state.revision});assert.ok(presented);assert.equal(host.authorizeSpeech(7,state.offer.id,invite),true,'own invitation remains speakable');
   update(7,{state:'complete',text:invite});update(7,{anchor:{x:1,y:1,visible:true}});
   if(mode==='later-question-before-human')update(7,{state:'complete',text:'问题B：你现在想聊什么？'});
   update(7,{state:'waiting',text:''}); // Normal human-send waiting is not a later assistant question.
   accepting=true;const accepted=host.accept({requestId:'affirm',messageId:'affirm',text:'好的',acceptedAt:Date.now(),source:'text'},'context');assert.ok(accepted);
   if(mode==='own-reply-after-human')update(7,{state:'streaming',text:'这份文字已按你的同意处理。'});
   const result=await accepted.result;
   assert.equal(host.get()!.entries.length,mode==='later-question-before-human'?0:1,mode);
   assert.equal(result.kind==='saved',mode==='own-reply-after-human',mode);
  }finally{
   host.dispose();gate.dispose();const actual=await realpath(directory),temp=await realpath(os.tmpdir());assert.equal(path.dirname(actual),temp);assert.ok(path.basename(actual).startsWith('soft-r39-question-'));await rm(actual,{recursive:true,force:true});
  }
 }
});
