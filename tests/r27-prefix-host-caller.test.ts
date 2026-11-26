import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import { ReplyRhythmHost } from '../electron/brain/reply-rhythm-host';
import { WIRING_PRELUDE, wiringFunction, wiringHandler } from './helpers/wiring-source';
// Reads as text (test-affected selects this test when they change): 'electron/main.ts', 'electron/wiring/voice-wiring.ts'.
import {CompletedReplySpeech} from '../electron/voice/completed-reply-speech';import {CompletedPrefixProof} from '../electron/voice/completed-prefix-proof';import {ReplyPresentation} from '../electron/brain/reply-presentation';import {ReplySpeechStyles} from '../electron/mood/speech-emotion';import {SpeechRuntime} from '../electron/voice/speech-runtime';import {SpeechPlaybackActivity} from '../electron/voice/speech-playback-activity';import {DEFAULT_TTS_CONFIG} from '../shared/voice/tts';import {UnboundBubbleProof} from '../electron/unbound/read-aloud';
// Wiring rewrite step 4: the reading-aloud functions and handlers are 声音's (electron/wiring/voice-wiring.ts); each is still exactly one
// in the wiring (main.ts and electron/wiring/*.ts), and what the moved lines read through the part's needs comes from env (WIRING_PRELUDE).
const declaration=(name:string)=>wiringFunction(name);
const callback=(name:string)=>wiringHandler(name);
const compiled=ts.transpileModule(WIRING_PRELUDE+'\n'+['withCompletedPrefixProof','canBeginSpeechPlaybackActivity','cancelCompletedReply','cancelReplyStyle','replySurface','herOnScreen','heldLineSpeakable'].map(declaration).join('\n')+'\nreturn {'+Object.entries({next:'nextReplySpeechSegment',ready:'acknowledgeReplySpeechReady',synth:'synthesizeSpeech',begin:'beginSpeechPlaybackActivity',end:'endSpeechPlaybackActivity'}).map(([key,name])=>key+':('+callback(name)+')').join(',')+',cancel:cancelCompletedReply};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
class Surface {
 text='';revision=0;ownerCurrent=true;paint:{text:string;token:string}|null=null;waits=0;readonly recipient={};token:string|null=null;private serial=0;
 readonly native=new ReplyPresentation({createToken:()=> 'native-token-'+(++this.serial).toString().padStart(8,'0')});
 readonly prefix=new CompletedPrefixProof({snapshot:()=>({text:this.text,revision:this.revision,ownerCurrent:this.ownerCurrent,ready:!!this.text}),current:text=>this.isCompletedPrefixCurrent(text),waitExact:async(text,signal)=>{this.waits++;const token=this.token,ok=await this.native.waitForPresentation(text,signal);if(ok&&token&&this.native.isCurrent(token,this.recipient))this.paint={text,token};return ok&&this.isCompletedPrefixCurrent(text);}});
 publish(text:string){this.text=text;this.revision++;this.token=this.native.begin(text,this.recipient);this.prefix.changed();}
 ack(){assert.ok(this.token);assert.equal(this.native.acknowledge(this.token,this.recipient,true),true);this.prefix.changed();}
 waitForCompletedPrefix(full:string,end:number,signal:AbortSignal,remaining:number,commit:(text:string)=>boolean){return this.prefix.wait(full,end,signal,remaining,commit);}
 isCompletedPrefixCurrent(text:string){return !!this.paint&&this.paint.text===text&&this.text===text&&this.native.isCurrent(this.paint.token,this.recipient)&&this.ownerCurrent;}
 isPresentationCurrent(text:string){return this.isCompletedPrefixCurrent(text);}
 close(){this.prefix.cancel();this.native.dispose();}
}
function fixture(out=false,reader=8){
 const plans=new CompletedReplySpeech(),styles=new ReplySpeechStyles(),surface=new Surface(),activity=new SpeechPlaybackActivity();activity.setScope('scope');
 let scope='scope';const effects:any[]=[],requests:any[]=[],transport=deferred<void>();
 const runtime=new SpeechRuntime((owner,context)=>({...DEFAULT_TTS_CONFIG,...styles.resolveStyle(owner,context!.replyId,scope)}),(_owner,event)=>effects.push(event),async(config,text)=>{requests.push({config,text});await transport.promise;});
 const controls={webContents:{id:8,send:(_c:string,_v:unknown)=>{}},isDestroyed:()=>false,isVisible:()=>false,isMinimized:()=>true};
 // Read-aloud while she is out (docs/claude/2026-11-15-unbound-read-aloud.md): her companion window is hidden and the proof is her Unbound bubble.
 const place={petShown:!out,bubbleSeen:out},sent={text:'',at:new Map<number,string>()};const proof=new UnboundBubbleProof({active:()=>place.bubbleSeen});const away={state:out?'unbound':'normal',readAloud:proof};
 /** Her own line the hidden companion window reads (electron/main.ts lastVisionSpeech; its guard is the line's display proof). */
 const line={owner:7,id:'line-1',shown:false,guard:{canSpeak:(id:string)=>id==='line-1'&&line.shown}};
 const pet={webContents:{id:7,send:(_c:string,_v:unknown)=>{}},isDestroyed:()=>false,isVisible:()=>place.petShown,isMinimized:()=>false};
 const env={completedReplySpeech:plans,replySpeechStyles:styles,replyRhythm:new ReplyRhythmHost(),speechRuntime:runtime,speechPlaybackActivity:activity,petReply:surface,pet,controls,windows:()=>[pet,controls],speechScope:()=>scope,
   store:{current:{voice:{enabled:true}}},textMemorialHost:null,unbound:away,lastVisionSpeech:line,lastAmbientSpeech:null,visionPresentation:null,broadcast:(channel:string,value:unknown)=>effects.push({channel,value}),syncFatigueActivity:()=>{},suspendAmbientSpeech:()=>{}};
 const host=new Function(...Object.keys(env),compiled)(...Object.values(env)) as {next:(owner:number,id:string,prior?:number)=>Promise<any>;ready:(owner:number,id:string)=>Promise<boolean>;synth:(owner:number,id:string,text:string,context:unknown)=>Promise<void>;begin:(owner:number,id:string)=>Promise<string|null>;end:(owner:number,id:string,lease:string)=>void;cancel:(id?:string)=>void};
 const id='reply',body='第一句。第二句。';let fence=plans.beginCommit(reader,id,scope);styles.begin(reader,id,scope);
 const commit=()=>{assert.equal(styles.complete(reader,id,scope,{primary:'calm',context:'neutral'},{instruction:'frozen character feeling',emotion:'calm'}),true);assert.equal(plans.record(reader,id,scope,body,{prefix:true,fence}),true);};
 return{plans,styles,surface,activity,runtime,requests,effects,host,id,body,commit,proof,away,place,line,
   /** The Unbound page: the host sent `text` to the bubble; `paint` reports it painted (what src/unbound/shown-reporter.ts sends). */
   /** One streamed delta, as electron/main.ts gives it to the reply plan and (through electron/unbound/host.ts stream) to her bubble. */
   say(text:string){if(!sent.text)styles.complete(reader,id,scope,{primary:'calm',context:'neutral'},{instruction:'frozen character feeling',emotion:'calm'}); // the turn's voice is frozen at acceptance
     plans.append(fence,text);sent.text+=text;const rev=proof.sent(id,text);sent.at.set(rev,sent.text);return rev;},
   /** A delta that reaches the plan only (her bubble is gone: she is home). */
   more(text:string){plans.append(fence,text);},paint(rev:number,visible=true){return proof.report({id,rev,text:sent.at.get(rev)??'',visible});},
   /** She comes home (electron/main.ts modeChanged, wired to electron/unbound/host.ts stateChanged). */
   home(cancel=true){away.state='normal';place.bubbleSeen=false;place.petShown=true;proof.invalidate();if(cancel)host.cancel();},finishTransport:()=>transport.resolve(),renewSameId(){host.cancel(id);fence=plans.beginCommit(reader,id,scope);styles.begin(reader,id,scope);},close(){host.cancel();transport.resolve();runtime.stop();activity.dispose();surface.close();}};
}
test('actual host commit fence and current prefix release first lease before whole body, then all3 proof consumers stay aligned',{timeout:4000},async t=>{
 const f=fixture();t.after(()=>f.close());let settled=false;
 const ready=f.host.ready(7,f.id),next=f.host.next(8,f.id).then(x=>{settled=true;return x;});await flush();assert.equal(settled,false);assert.equal(f.requests.length,0);
 f.surface.publish('第一');f.commit();assert.equal(await ready,true);await flush();assert.equal(settled,false);assert.equal(f.surface.waits,0);assert.equal(f.plans.busy,true);
 f.surface.publish('第一句。');await flush();f.surface.ack();const piece=await next;assert.equal(piece.index,0);assert.equal(f.surface.text,f.body.slice(0,4));assert.notEqual(f.surface.text,f.body);
 const waits=f.surface.waits;const blocker=await f.host.begin(8,'playback');assert.ok(blocker,'hidden controls uses same genuine pet prefix');assert.equal(f.surface.waits,waits,'consumed current proof reused');
 f.surface.publish('第一句。第');const speaking=f.host.synth(8,'transport',piece.text,piece.context);await flush();assert.equal(f.requests.length,0,'changed candidate is pending, no stale synthesis');
 f.surface.ack();await flush();assert.equal(f.requests.length,1);assert.equal(f.requests[0].config.instruction,'frozen character feeling');assert.equal(f.runtime.busy,true);assert.equal(f.plans.busy,true);
 f.finishTransport();await speaking;assert.equal(f.runtime.busy,true,'physical renderer drain still owns routing');assert.equal(f.runtime.release(8,'transport'),true);f.host.end(8,'playback',blocker!);
 const second=f.host.next(8,f.id,0);await flush();assert.equal(f.plans.busy,true);f.surface.publish(f.body);await flush();f.surface.ack();assert.equal((await second).index,1,'same plan full-body fallback');
 assert.equal(await f.host.next(8,f.id,1),null);assert.equal(f.plans.busy,false);assert.equal(f.requests.length,1);
});
test('actual ready/next cannot use a cancelled same-ID completion or a foreign owner',{timeout:4000},async t=>{
 const f=fixture();t.after(()=>f.close());const oldReady=f.host.ready(7,f.id),oldNext=f.host.next(8,f.id);await flush();f.renewSameId();
 assert.equal(await oldReady,false);assert.equal(await oldNext,null);f.commit();await assert.rejects(f.host.next(99,f.id));assert.equal(f.plans.busy,true);assert.equal(f.plans.approvedCurrentSegment(8,'scope'),null);assert.equal(f.requests.length,0);
});
test('actual waiting prefix and late native ACK cannot revive a cancelled lease or start synthesis',{timeout:4000},async t=>{
 const f=fixture();t.after(()=>f.close());f.commit();assert.equal(await f.host.ready(7,f.id),true);f.surface.publish('第一句。');const next=f.host.next(8,f.id);await flush();f.host.cancel(f.id);assert.equal(f.surface.native.acknowledge(f.surface.token,f.surface.recipient,true),false);assert.equal(await next,null);assert.equal(f.requests.length,0);assert.equal(f.plans.busy,false);
});

// ---- read-aloud while she is out in Unbound: the same real handlers, her bubble as the one proof -----------------------------------
test('out in Unbound: a sentence is read only after her bubble reported it painted; a forged or partial report reads nothing',{timeout:4000},async t=>{
 const f=fixture(true);t.after(()=>f.close());let settled=false;
 const first=f.say('第一');const next=f.host.next(8,f.id).then(x=>{settled=true;return x;});await flush();assert.equal(settled,false,'nothing shown yet');
 assert.equal(f.paint(first),true);await flush();assert.equal(settled,false,'half a sentence shown: not yet');
 const whole=f.say('句。');await flush();assert.equal(settled,false,'sent but not painted: not yet');
 assert.equal(f.proof.report({id:f.id,rev:whole,text:'第一句！',visible:true}),false,'a forged text is refused');
 assert.equal(f.proof.report({id:'another',rev:whole,text:'第一句。',visible:true}),false,'another bubble is refused');
 f.surface.publish('第一句。');f.surface.ack();await flush();assert.equal(settled,false,'the hidden pet bubble is not the proof while she is out');
 assert.equal(f.requests.length,0);
 assert.equal(f.paint(whole),true);const piece=await next;assert.equal(piece.index,0);assert.equal(piece.text,'第一句。');
 const lease=await f.host.begin(8,'playback');assert.equal(typeof lease,'string','hidden controls may play what her bubble showed');
 const speaking=f.host.synth(8,'transport',piece.text,piece.context);await flush();assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'第一句。');
 f.finishTransport();await speaking;f.runtime.release(8,'transport');f.host.end(8,'playback',lease!);
});
test('out in Unbound: her bubble leaving the screen while a sentence waits cancels the readout; a late report never revives it',{timeout:4000},async t=>{
 const f=fixture(true);t.after(()=>f.close());const rev=f.say('第一句。');
 const next=f.host.next(8,f.id);await flush();
 f.place.bubbleSeen=false;f.proof.invalidate(); // her bubble left the screen (she went home; electron/unbound/host.ts stateChanged)
 await assert.rejects(next,/尚未确认显示/);assert.equal(f.plans.busy,false);
 f.place.bubbleSeen=true;assert.equal(f.paint(rev),true,'painted again later');
 assert.equal(await f.host.next(8,f.id).catch(()=>null),null,'the cancelled reply is not read (refused or nothing)');assert.equal(f.requests.length,0);
});
test('out in Unbound: a hidden-away bubble (not out, or her window not shown) gives no playback lease',{timeout:4000},async t=>{
 const f=fixture(true);t.after(()=>f.close());const rev=f.say('第一句。');assert.equal(f.paint(rev),true);
 const piece=await f.host.next(8,f.id);assert.equal(piece.index,0);
 f.place.bubbleSeen=false;f.proof.invalidate();
 assert.equal(await f.host.begin(8,'playback'),null,'nothing on screen: the hidden controls window may not start playing');
});
test('out in Unbound: her coming home mid-reply ends the readout; no sentence is ever read twice, none unshown',{timeout:4000},async t=>{
 for(const cancel of [true,false]){
  const f=fixture(true);t.after(()=>f.close());const rev=f.say('第一句。');assert.equal(f.paint(rev),true);
  const piece=await f.host.next(8,f.id);assert.equal(piece.index,0);
  const speaking=f.host.synth(8,'transport',piece.text,piece.context);await flush();f.finishTransport();await speaking;f.runtime.release(8,'transport');
  assert.equal(f.requests.length,1);
  f.home(cancel);
  const after=f.host.next(8,f.id,0).catch(()=>null);await flush();
  if(cancel){assert.equal(await after,null,'the switch ended it (what electron/main.ts does): refused or nothing');}
  else{
   assert.equal(f.paint(rev),false,'her old bubble proves nothing at home');
   f.more('第二句。');f.surface.publish(f.body);await flush();f.surface.ack();
   const second=(await after)!;assert.equal(second.index,1,'even without the switch cancelling, the plan never goes back to the first sentence');
   assert.equal(second.text,'第二句。');
  }
  assert.equal(f.requests.filter((r:any)=>r.text==='第一句。').length,1,'the first sentence was read once');
 }
});
test('out in Unbound: the hidden pet window may start playing her own line only while that line is proven in her bubble',{timeout:4000},async t=>{
 const f=fixture(true);t.after(()=>f.close());
 assert.equal(await f.host.begin(7,'line-play'),null,'her line is not on screen yet');
 f.line.shown=true;const lease=await f.host.begin(7,'line-play');assert.equal(typeof lease,'string');f.host.end(7,'line-play',lease!);
 f.away.state='normal';f.place.bubbleSeen=false;
 assert.equal(await f.host.begin(7,'line-play'),null,'home with her pet window hidden: as before, nothing plays');
});
// Unbound v1 step 3 (docs/claude/2026-11-17-unbound-step3.md): a call from her companion window goes on while she is out; that hidden window
// reads its replies, under exactly the proof the control window reads a typed reply under (her bubble), and nothing without it.
test('out in Unbound: the hidden pet window reads its call reply only after her bubble proved it',{timeout:4000},async t=>{
 const f=fixture(true,7);t.after(()=>f.close());const rev=f.say('第一句。');
 const next=f.host.next(7,f.id);await flush();
 assert.equal(await f.host.begin(7,'call-play'),null,'not painted yet: no playback');
 assert.equal(f.paint(rev),true);const piece=await next;assert.equal(piece.index,0);assert.equal(piece.text,'第一句。');
 const lease=await f.host.begin(7,'call-play');assert.equal(typeof lease,'string','the hidden pet window may play what her bubble showed');
 const speaking=f.host.synth(7,'transport',piece.text,piece.context);await flush();assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'第一句。');
 f.finishTransport();await speaking;f.runtime.release(7,'transport');f.host.end(7,'call-play',lease!);
});
test('out in Unbound: the hidden pet window gets no playback for a call reply her bubble no longer shows, nor at home',{timeout:4000},async t=>{
 const f=fixture(true,7);t.after(()=>f.close());const rev=f.say('第一句。');assert.equal(f.paint(rev),true);
 const piece=await f.host.next(7,f.id);assert.equal(piece.index,0);
 f.place.bubbleSeen=false;f.proof.invalidate();
 assert.equal(await f.host.begin(7,'call-play'),null,'her bubble gone: nothing plays');
 const g=fixture(true,7);t.after(()=>g.close());g.away.state='normal';
 assert.equal(await g.host.begin(7,'call-play'),null,'home with her pet window hidden: as before, nothing plays');
});
