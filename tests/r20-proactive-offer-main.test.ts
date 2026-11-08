import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {R20ProactiveOffers} from '../electron/r20-proactive-offer';import {ProactiveSpeechGate} from '../electron/proactive-speech-gate';import {buildR20OfferPrompt} from '../electron/r20-offer-dialogue';
import {bodyPoseBinding} from '../shared/personalize-body-bindings';import {selectBodyPosePresentation} from '../shared/personalize-body-presentation';import {VISUAL_GENE_SHA} from '../shared/personalize-visual';
import {SingleEmojiCues} from '../electron/single-emoji-cues';import {DEFAULT_EMOJI_SETTINGS,readEmojiSettings} from '../shared/single-emoji';
import {claimedView} from '../electron/inner-loop/claim';import {OpeningHost} from '../electron/inner-loop/opening-host';
const raw=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',raw,ts.ScriptTarget.Latest,true);
function declaration(name:string){const nodes=ast.statements.filter((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(nodes.length,1);return nodes[0].getText(ast);}
const js=(source:string)=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
test('actual host initializer and actual mood caller use the existing text-only adapter only after an accepted opportunity',async()=>{
 let callback:ts.Node|undefined;function visit(n:ts.Node){if(ts.isNewExpression(n)&&n.expression.getText(ast)==='CompanionService')callback=n.arguments?.[1];ts.forEachChild(n,visit);}visit(ast);assert.ok(callback);
 const gate=new ProactiveSpeechGate();gate.setScope('identity:token');const events:any[]=[],modelTasks:any[]=[],archives:any[]=[],moodViews:any[]=[];let memorialClaims=false,innerOffers=0;
 // This fixture has no native emoji surface. Exercise the real cue/context
 // lifetime, but fail closed if unavailable presentation ever reaches show.
 const emojiWindow={shown:0,hidden:0};
 // R20 round 1 keeps Claude-generated proactive offers off (PROACTIVE_TASK_OFFERS=false); exercise the offer logic as it runs once enabled.
 const env={PROACTIVE_TASK_OFFERS:true,PROFILE_FOLDER:'soft-hearts-claude',R20ProactiveOffers,buildR20OfferPrompt,proactiveSpeechGate:gate,exiting:false,SingleEmojiCues,
 emojiSettings:readEmojiSettings({...DEFAULT_EMOJI_SETTINGS,enabled:true,selected:['smile']}),
 emojiWindowPorts:{available:()=>false,show:()=>{emojiWindow.shown++;throw Error('No native emoji surface in this fixture');},hide:()=>{emojiWindow.hidden++;}},
 store:{current:{provider:{kind:'claude',model:'existing-model'},persona:'当前角色'},directory:'owned-synthetic-directory'},
 companion:{currentScope:()=>({characterId:'card',providerScope:'provider'}),mood:{get:()=>({expressions:true,token:'token',snapshot:{phase:'idle'}}),chatContext:()=> '当前心情'},memory:{appendInitiative:async(...args:unknown[])=>archives.push(args)}},
 pet:{isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,webContents:{id:7}},petReply:{waitForPresentation:async()=>true,isPresentationCurrent:()=>true},petWindowDrag:null,
 replySpeechBusy:()=>false,ambientSpeakingOwners:new Set(),ambientAudio:null,readingActive:()=>false,pending:new Map(),userInputUntil:0,
 characterCards:{getActive:()=>({id:'card'})},memoryProviderScope:()=> 'provider',speechScope:()=> 'identity',windows:()=>[],Date,
 path:{join:(...xs:string[])=>xs.join('/')},app:{getPath:()=> 'synthetic-temp'},
 streamClaude:async(task:unknown,_signal:AbortSignal,emit:(type:string,text:string)=>void)=>{modelTasks.push(task);emit('delta',JSON.stringify({question:'需要先看看计划吗？',goal:'整理项目',plan:'列出步骤。',scopeHint:'请填写范围'}));},
 broadcast:(channel:string,value:unknown)=>{if(channel==='desk:r20-proactive-offer')events.push(value);if(channel==='desk:mood')moodViews.push(value);},openCodexTaskConfirmation:()=>{throw Error('Not an execution/confirmation case');},
 textMemorialHost:{sync(){},offerOpportunity:()=>memorialClaims},noteVisionUserActivity:()=>{},ambientComments:null,
 // I-020 #10: the real opening choice; a cue taken by the memorial or R20 is never weighed and never reaches the inner loop
 // (not even its look-don't-take check). She is awake here (asleep: nobody, tests/quiet-when-asleep.test.ts); the rest of the
 // choice is tested by import in tests/opening-choice.test.ts.
 claimedView,visionEligible:()=>false,innerLoopHost:{opening:new OpeningHost({loop:{offerOpportunity:()=>{innerOffers++;return false;},canTake:()=>{innerOffers++;return false;},
  claims:()=>false,asleep:()=>false,silence:()=>false,restReminderDue:()=>false,quietNow:()=>({asleep:false,drowsy:false,night:false,quiet:false})},innerOn:()=>true,releaseSpeech:()=>{},developerMode:()=>false})},
 visualGeneReceipt:null,bodyBehaviors:null,bodyModelGeneration:0,bodyPoseBinding,selectBodyPosePresentation,VISUAL_GENE_SHA,bodyPosePublishingBlocked:false,retiredBodyPoseCues:new Set(),
 // I-027 心情调整员: the mood callback hands every view to it (it only watches; tests/i027-mood-judge.test.ts covers it).
 moodJudge:{watch:()=>{}},
 };
 const create=new Function(...Object.keys(env),js('let r20ProactiveOffers=null;let observedEmojiContext="";let moodCueOwner=null;\n'
  +declaration('singleEmojiContext')+'\n'+declaration('refreshSingleEmojiContext')+'\n'
  +'const singleEmojiCues=new SingleEmojiCues({context:singleEmojiContext,settings:()=>emojiSettings,...emojiWindowPorts});\n'
  +declaration('withBodyPose')+'\n'+declaration('r20OfferPresentable')+'\n'+declaration('initR20ProactiveOffers')
  +'\ninitR20ProactiveOffers();\nreturn {get:()=>r20ProactiveOffers,mood:('+callback.getText(ast)+'),emojiCues:singleEmojiCues,emojiContext:singleEmojiContext,refreshEmojiContext:refreshSingleEmojiContext,observedEmojiContext:()=>observedEmojiContext,advanceEmojiModel:()=>{bodyModelGeneration++;}};'));
 const flow=create(...Object.values(env)) as {get():R20ProactiveOffers;mood(view:unknown):void;emojiCues:SingleEmojiCues;emojiContext():string;refreshEmojiContext():void;observedEmojiContext():string;advanceEmojiModel():void};const host=flow.get();
 try{assert.equal(modelTasks.length,0);host.noteCompleted('turn','当前用户文字','已完成的助手文字');
  assert.deepEqual(JSON.parse(flow.emojiContext()),['identity',null,0,'token']);assert.equal(flow.observedEmojiContext(),'');
  memorialClaims=true;flow.mood({token:'token',snapshot:{phase:'idle',cue:{id:'memorial-first',kind:'speech',until:Date.now()+1000}}});assert.equal(modelTasks.length,0);assert.equal(moodViews.at(-1).snapshot.cue,null);assert.equal(moodViews.at(-1).bodyPose,null);
  assert.equal(flow.observedEmojiContext(),flow.emojiContext());assert.equal(emojiWindow.hidden,1);
  memorialClaims=false;flow.mood({token:'token',snapshot:{phase:'idle',cue:{id:'accepted',kind:'speech',until:Date.now()+1000}}});for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(modelTasks.length,1);assert.equal(moodViews.at(-1).snapshot.cue,null);assert.equal(events[0].type,'offer');assert.equal(archives.length,0);
  assert.equal(innerOffers,0,'cues claimed earlier in the chain never reach the inner loop');
  const task=modelTasks[0];assert.equal(task.kind,'chat');assert.equal(task.writable,false);assert.deepEqual(task.imageDataUrls,[]);assert.equal(Object.hasOwn(task,'id'),false);assert.match(task.prompt,/当前用户文字/u);assert.match(task.prompt,/"executionVerified":false/u);
  assert.equal(await host.acknowledge(99,{id:events[0].offer.id,revision:events[0].offer.revision}),null);assert.equal(archives.length,0);
  const oldEmojiContext=flow.emojiContext();assert.equal(flow.emojiCues.offerMood('unavailable-emoji','happy',oldEmojiContext),false);assert.equal(emojiWindow.shown,0);
  // The actual context function owns model generation as well as speech/token.
  // Its actual refresh cancels through the real cue service, not an empty hook.
  flow.advanceEmojiModel();flow.refreshEmojiContext();assert.notEqual(flow.emojiContext(),oldEmojiContext);assert.equal(flow.observedEmojiContext(),flow.emojiContext());assert.equal(emojiWindow.hidden,2);
  assert.equal(flow.emojiCues.offerMood('late-old-model','happy',oldEmojiContext),false);assert.equal(emojiWindow.shown,0);assert.equal(modelTasks.length,1);assert.equal(archives.length,0);
 }finally{flow.emojiCues.dispose();host.dispose();gate.dispose();}
});

test('R20 round 1: tasks are offered only on an explicit chat request; proactive task offers stay off', () => {
 assert.match(raw, /\nconst PROACTIVE_TASK_OFFERS = false;\r?\n/);
 assert.match(declaration('r20OfferPresentable'), /^function r20OfferPresentable\(\): boolean \{\r?\n  return PROACTIVE_TASK_OFFERS && /);
});
