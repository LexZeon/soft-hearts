import test from 'node:test';import assert from 'node:assert/strict';
import {CompanionCommandHost} from '../electron/companion-command-host';
import {classifyCompanionCommand,formatCompanionCommandReceipt} from '../electron/companion-command-intent';
import {createCommandDialogueTurn} from '../electron/companion-command-dialogue';
import type {CompanionCommandActionId,CompanionCommandIntentInput,CompanionCommandView} from '../shared/companion-commands';

test('frozen Main host with actual Voice classifier/dialogue binds one human domain and reports only its actual receipt',async()=>{
 for(const mode of ['show-hidden','hide-controls','restore-intent','clarify-cancel','clarify-stale','clarify-manual','legacy-topmost']as const){
  let visible=mode==='show-hidden'?false:true,native=mode!=='show-hidden'&&mode!=='restore-intent',top=true,visibleRevision=0,topRevision=0,context='context',choices=0,commits=0,finished=0;
  const chunks:string[]=[],published:CompanionCommandView[]=[],domains:CompanionCommandActionId[]=[];
  const host=new CompanionCommandHost({now:()=>0,id:()=>`choice_${++choices}`,target:(owner,actionId)=>{
   if(owner!==1)return null;
   if(actionId==='pet.set-always-on-top')return native?{contextId:context,value:top,revision:topRevision}:null;
   return{contextId:context,value:visible,revision:visibleRevision};
  },classify:classifyCompanionCommand,format:formatCompanionCommandReceipt,enqueue:async operation=>operation(),publish:view=>{published.push(view);},commit:async(value,actionId)=>{
   commits++;domains.push(actionId);
   if(actionId==='pet.set-always-on-top'){const persistence=top===value?'unchanged':'saved';top=value;topRevision++;return{persistence,presentation:'applied',value};}
   const persistence=visible===value?'unchanged':'saved';visible=value;visibleRevision++;native=value;
   host.refresh(); // The pet's expected own hide must not revoke the current controls sender.
   return{persistence,presentation:'applied',value,nativeValue:native};
  }});
  const body=mode==='show-hidden'?'显示桌宠':mode==='hide-controls'?'隐藏桌宠':mode==='legacy-topmost'?'取消桌宠置顶':'我看不到桌宠了';
  for(const source of ['model','screen','quoted','history']as const)assert.equal(host.admit({requestId:'untrusted_'+source,owner:1,window:'controls',text:'隐藏桌宠',source}),null);
  assert.equal(host.admit({requestId:'quoted',owner:1,window:'controls',text:'他说“隐藏桌宠”',source:'current-human'}),null);
  const requestId='human_'+mode,ticket=host.admit({requestId,owner:1,window:'controls',text:body,source:'current-human'});assert.ok(ticket);
  const input:CompanionCommandIntentInput={requestId,contextId:context,text:body,currentValue:top,currentVisible:visible};
  const dialogue=createCommandDialogueTurn({classify:classifyCompanionCommand,formatReceipt:formatCompanionCommandReceipt,signal:new AbortController().signal,isCurrent:()=>context==='context',host:async()=>{
   const view=await host.run(ticket);assert.ok(view);return view.receipt??view;
  },turn:{push:(_kind,text)=>{chunks.push(text);},finish:async()=>{finished++;}}});
  assert.equal(await dialogue.handle(input),'handled');assert.equal(finished,1);assert.equal(chunks.length,1);assert.equal(host.admit({requestId,owner:1,window:'controls',text:body,source:'current-human'}),null);await assert.rejects(dialogue.handle(input),/CONSUMED/);
  if(mode==='show-hidden'||mode==='hide-controls'){
   assert.equal(commits,1);assert.deepEqual(domains,['pet.set-visible']);assert.equal(native,mode==='show-hidden');assert.match(chunks[0],mode==='show-hidden'?/窗口已显示/:/窗口已隐藏/);assert.equal(published.at(-1)!.receipt!.nativeValue,native);assert.equal(await host.run(ticket),null);
  }else if(mode==='legacy-topmost'){
   assert.equal(commits,1);assert.deepEqual(domains,['pet.set-always-on-top']);assert.equal(published.at(-1)!.receipt!.actionId,undefined);assert.equal(chunks[0],'已取消桌宠置顶。');
  }else{
   assert.equal(commits,0);assert.ok(!chunks[0].includes('窗口已显示'));const view=published.at(-1)!;assert.equal(view.choices.length,3);
   if(mode==='clarify-cancel'){
    const cancel=view.choices.find(choice=>choice.label==='取消')!;const cancelled=await host.choose(1,{requestId,choiceId:cancel.choiceId});assert.equal(cancelled!.receipt!.actionId,'pet.set-visible');assert.equal(cancelled!.receipt!.status,'cancelled');assert.equal(commits,0);assert.equal(await host.choose(1,{requestId,choiceId:view.choices[0].choiceId}),null);
   }else if(mode==='clarify-stale'){
    context='new-context';host.refresh();assert.equal(await host.choose(1,{requestId,choiceId:view.choices[0].choiceId}),null);assert.equal(commits,0);
   }else if(mode==='clarify-manual'){
    visible=false;visibleRevision++;const conflict=await host.choose(1,{requestId,choiceId:view.choices[0].choiceId});assert.equal(conflict!.receipt!.status,'conflict');assert.equal(commits,0);
   }else{
    const shown=await host.choose(1,{requestId,choiceId:view.choices[0].choiceId});assert.equal(shown!.receipt!.persistence,'unchanged');assert.equal(shown!.receipt!.presentation,'applied');assert.equal(shown!.receipt!.nativeValue,true);assert.equal(shown!.receipt!.message,'桌宠窗口已显示。');assert.equal(commits,1);assert.equal(await host.choose(1,{requestId,choiceId:view.choices[0].choiceId}),null);assert.equal(commits,1);
   }
   assert.equal(finished,1,'choice publication never creates a second ordinary turn/archive');
  }
 }
});
