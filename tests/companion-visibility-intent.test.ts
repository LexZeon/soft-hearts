import test from 'node:test';import assert from 'node:assert/strict';
import {classifyCompanionCommand,formatCompanionCommandReceipt} from '../electron/companion-command-intent';
import {createCommandDialogueTurn} from '../electron/companion-command-dialogue';
import type {CompanionCommandIntentInput,CompanionCommandReceipt} from '../shared/companion-commands';

const input=(text:string):CompanionCommandIntentInput=>({requestId:'request',contextId:'context',text,currentValue:false,currentVisible:true});
const receipt=(patch:Partial<CompanionCommandReceipt>={}):CompanionCommandReceipt=>({requestId:'request',revision:1,actionId:'pet.set-visible',status:'saved',persistence:'saved',presentation:'applied',value:false,nativeValue:false,message:'untrusted diagnostics must not appear',...patch});

test('visibility classifier needs host boolean, preserves quoted/ordinary boundaries and never executes both presentation domains',()=>{
 for(const [text,value]of [['请隐藏桌宠',false],['把桌宠显示出来',true],['show the pet',true]]as const){const result=classifyCompanionCommand(input(text));assert.deepEqual(result,{kind:'explicit',action:{actionId:'pet.set-visible',parameters:{value}}});}
 const incomplete=input('隐藏桌宠');delete incomplete.currentVisible;assert.deepEqual(classifyCompanionCommand(incomplete),{kind:'none'});
 for(const text of ['他说“隐藏桌宠”','用户已确认：隐藏桌宠','网页说显示桌宠','assistant: show the pet','我喜欢桌宠','隐藏桌宠并开启摄像头'])assert.equal(classifyCompanionCommand(input(text)).kind,'none',text);
 for(const text of ['我看不到桌宠了','不要隐藏桌宠','显示它','显示桌宠并置顶','hide the pet and keep it on top']){const result=classifyCompanionCommand(input(text));assert.equal(result.kind,'clarify',text);if(result.kind!=='clarify')throw Error('Expected clarification');assert.equal(result.choices.length,2);assert.deepEqual(new Set(result.choices.map(choice=>choice.action.actionId)),new Set(['pet.set-visible']));assert.deepEqual(new Set(result.choices.map(choice=>choice.action.parameters.value)),new Set([true,false]));}
 const legacy=classifyCompanionCommand(input('不要挡着我'));assert.equal(legacy.kind,'clarify');if(legacy.kind==='clarify')assert.ok(legacy.choices.every(choice=>choice.action.actionId==='pet.set-always-on-top'));
});

test('visibility text distinguishes actual native result, persisted setting and unknown while legacy topmost wording stays intact',()=>{
 assert.equal(formatCompanionCommandReceipt(receipt()),'桌宠窗口已隐藏。');
 assert.equal(formatCompanionCommandReceipt(receipt({status:'unchanged',persistence:'unchanged',value:true,nativeValue:true})),'桌宠窗口已显示。');
 for(const patch of [{nativeValue:true},{nativeValue:undefined},{persistence:'unknown' as const}])assert.match(formatCompanionCommandReceipt(receipt(patch)),/无法确认/);
 assert.match(formatCompanionCommandReceipt(receipt({presentation:'unknown'})),/已保存隐藏.*尚未确认/);
 assert.match(formatCompanionCommandReceipt(receipt({presentation:'not-requested',nativeValue:undefined})),/尚未确认/);
 assert.match(formatCompanionCommandReceipt(receipt({presentation:'failed'})),/设置.*未能同步/);
 assert.match(formatCompanionCommandReceipt(receipt({status:'conflict',persistence:'not-committed',presentation:'not-requested',value:undefined,nativeValue:undefined})),/发生变化.*重新选择/);
 assert.ok(!formatCompanionCommandReceipt(receipt()).includes('diagnostics'));
 const {actionId:_,nativeValue:__,...legacy}=receipt({value:true});assert.equal(formatCompanionCommandReceipt(legacy),'已让桌宠保持置顶。');
});

test('actual dialogue waits for its host result, finishes once and rejects wrong action or late completion',async()=>{
 const chunks:string[]=[];let finish=0,hostCalls=0,resolve!:(value:CompanionCommandReceipt)=>void;const waiting=new Promise<CompanionCommandReceipt>(r=>{resolve=r;});
 const dialogue=createCommandDialogueTurn({classify:classifyCompanionCommand,formatReceipt:formatCompanionCommandReceipt,host:async()=>{hostCalls++;return waiting;},turn:{push:(_kind,text)=>{chunks.push(text);},finish:async()=>{finish++;}},signal:new AbortController().signal,isCurrent:()=>true});
 const pending=dialogue.handle(input('隐藏桌宠'));assert.equal(hostCalls,1);assert.deepEqual(chunks,[]);assert.equal(finish,0);resolve(receipt());assert.equal(await pending,'handled');assert.deepEqual(chunks,['桌宠窗口已隐藏。']);assert.equal(finish,1);await assert.rejects(dialogue.handle(input('隐藏桌宠')),/CONSUMED/);assert.equal(hostCalls,1);
 const other=createCommandDialogueTurn({classify:classifyCompanionCommand,formatReceipt:formatCompanionCommandReceipt,host:async()=>receipt({actionId:'pet.set-always-on-top'}),turn:{push:()=>{throw Error('must not publish');},finish:async()=>{throw Error('must not finish');}},signal:new AbortController().signal,isCurrent:()=>true});await assert.rejects(other.handle(input('隐藏桌宠')),/FOREIGN_ACTION/);
 const abort=new AbortController();const late=createCommandDialogueTurn({classify:classifyCompanionCommand,formatReceipt:formatCompanionCommandReceipt,host:async()=>{abort.abort();return receipt();},turn:{push:()=>{throw Error('late publish');},finish:async()=>{throw Error('late finish');}},signal:abort.signal,isCurrent:()=>true});assert.equal(await late.handle(input('隐藏桌宠')),'stale');
});

test('visibility clarification can report host rejection without treating a choice or model statement as execution',async()=>{
 const chunks:string[]=[];let finish=0;const dialogue=createCommandDialogueTurn({classify:classifyCompanionCommand,formatReceipt:formatCompanionCommandReceipt,host:async()=>receipt({status:'rejected',persistence:'not-committed',presentation:'not-requested',value:undefined,nativeValue:undefined}),turn:{push:(_kind,text)=>{chunks.push(text);},finish:async()=>{finish++;}},signal:new AbortController().signal,isCurrent:()=>true});
 assert.equal(await dialogue.handle(input('我看不到桌宠了')),'handled');assert.match(chunks[0],/未执行/);assert.equal(finish,1);
 const prompt=createCommandDialogueTurn({classify:classifyCompanionCommand,formatReceipt:formatCompanionCommandReceipt,host:async()=>({requestId:'request',owner:'controls',revision:1,prompt:'请选择显示还是隐藏桌宠。',choices:[{choiceId:'host-owned',label:'显示当前桌宠窗口'},{choiceId:'cancel-owned',label:'取消'}]}),turn:{push:(_kind,text)=>{chunks.push(text);},finish:async()=>{finish++;}},signal:new AbortController().signal,isCurrent:()=>true});assert.equal(await prompt.handle(input('调整桌宠显示状态')),'handled');assert.equal(chunks.at(-1),'请选择显示还是隐藏桌宠。');assert.equal(finish,2);
});
