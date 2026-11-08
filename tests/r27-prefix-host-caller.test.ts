import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import { ReplyRhythmHost } from '../electron/reply-rhythm-host';
import {CompletedReplySpeech} from '../electron/completed-reply-speech';import {CompletedPrefixProof} from '../electron/completed-prefix-proof';import {ReplyPresentation} from '../electron/reply-presentation';import {ReplySpeechStyles} from '../electron/speech-emotion';import {SpeechRuntime} from '../electron/speech-runtime';import {SpeechPlaybackActivity} from '../electron/speech-playback-activity';import {DEFAULT_TTS_CONFIG} from '../shared/tts';
const raw=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('main.ts',raw,ts.ScriptTarget.Latest,true);
const declaration=(name:string)=>{const found=ast.statements.filter((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.equal(found.length,1,name);return found[0].getText(ast);};
const callback=(name:string)=>{const found:ts.Node[]=[];function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='scopedHost'&&ts.isStringLiteral(n.arguments[0])&&n.arguments[0].text===name)found.push(n.arguments[1]);ts.forEachChild(n,visit);}visit(ast);assert.equal(found.length,1,name);return found[0].getText(ast);};
const compiled=ts.transpileModule(['withCompletedPrefixProof','canBeginSpeechPlaybackActivity','cancelCompletedReply','cancelReplyStyle'].map(declaration).join('\n')+'\nreturn {'+Object.entries({next:'nextReplySpeechSegment',ready:'acknowledgeReplySpeechReady',synth:'synthesizeSpeech',begin:'beginSpeechPlaybackActivity',end:'endSpeechPlaybackActivity'}).map(([key,name])=>key+':('+callback(name)+')').join(',')+',cancel:cancelCompletedReply};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
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
function fixture(){
 const plans=new CompletedReplySpeech(),styles=new ReplySpeechStyles(),surface=new Surface(),activity=new SpeechPlaybackActivity();activity.setScope('scope');
 let scope='scope';const effects:any[]=[],requests:any[]=[],transport=deferred<void>();
 const runtime=new SpeechRuntime((owner,context)=>({...DEFAULT_TTS_CONFIG,...styles.resolveStyle(owner,context!.replyId,scope)}),(_owner,event)=>effects.push(event),async(config,text)=>{requests.push({config,text});await transport.promise;});
 const controls={webContents:{id:8,send:(_c:string,_v:unknown)=>{}},isDestroyed:()=>false,isVisible:()=>false,isMinimized:()=>true};
 const pet={webContents:{id:7,send:(_c:string,_v:unknown)=>{}},isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false};
 const env={completedReplySpeech:plans,replySpeechStyles:styles,replyRhythm:new ReplyRhythmHost(),speechRuntime:runtime,speechPlaybackActivity:activity,petReply:surface,pet,controls,windows:()=>[pet,controls],speechScope:()=>scope,
   store:{current:{voice:{enabled:true}}},textMemorialHost:null,broadcast:(channel:string,value:unknown)=>effects.push({channel,value}),syncFatigueActivity:()=>{},suspendAmbientSpeech:()=>{}};
 const host=new Function(...Object.keys(env),compiled)(...Object.values(env)) as {next:(owner:number,id:string,prior?:number)=>Promise<any>;ready:(owner:number,id:string)=>Promise<boolean>;synth:(owner:number,id:string,text:string,context:unknown)=>Promise<void>;begin:(owner:number,id:string)=>Promise<string|null>;end:(owner:number,id:string,lease:string)=>void;cancel:(id?:string)=>void};
 const id='reply',body='第一句。第二句。';let fence=plans.beginCommit(8,id,scope);styles.begin(8,id,scope);
 const commit=()=>{assert.equal(styles.complete(8,id,scope,{primary:'calm',context:'neutral'},{instruction:'frozen character feeling',emotion:'calm'}),true);assert.equal(plans.record(8,id,scope,body,{prefix:true,fence}),true);};
 return{plans,styles,surface,activity,runtime,requests,effects,host,id,body,commit,finishTransport:()=>transport.resolve(),renewSameId(){host.cancel(id);fence=plans.beginCommit(8,id,scope);styles.begin(8,id,scope);},close(){host.cancel();transport.resolve();runtime.stop();activity.dispose();surface.close();}};
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
