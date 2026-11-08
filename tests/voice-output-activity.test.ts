import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceOutput, type VoiceOutputEvent } from '../src/ui/VoiceOutput';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';

const flush = async () => { for (let i=0;i<60;i++) await Promise.resolve(); };
function deferred<T=void>() { let resolve!: (value:T)=>void,reject!: (error:Error)=>void; const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;}); void promise.catch(()=>{}); return {promise,resolve,reject}; }
const voice={enabled:true,voiceURI:'public-test',rate:1,volume:0.5};

function fixture(options:{cloud?:boolean;pair?:'both'|'none'|'begin'|'end';sameId?:boolean;holdPlayerBegin?:boolean}={}) {
  const config={...DEFAULT_TTS_CONFIG,provider:options.cloud?'bailian' as const:'system' as const};
  let listener:((event:VoiceOutputEvent)=>void)|undefined,systemSpeaking!:(active:boolean)=>void,ids=0;
  const begins:{id:string;result:ReturnType<typeof deferred<string|null>>}[]=[],ends:{id:string;lease:string}[]=[],host=new Map<string,string>();
  const systems:{text:string;result:ReturnType<typeof deferred<void>>}[]=[],requests:{id:string;text:string}[]=[],routes:string[]=[],cancelled:string[]=[],errors:string[]=[],speaking:boolean[]=[],order:string[]=[];
  let failEnd=false;
  const players:Player[]=[];
  class Player {
    complete=deferred();ready=deferred();events:unknown[]=[];disposed=0;
    constructor(readonly cb:any){players.push(this);}
    get finished(){return this.complete.promise;}
    async begin(id:string){order.push('player.begin:'+id);this.cb.onState({phase:'loading'});if(options.holdPlayerBegin)await this.ready.promise;}
    async accept(event:any){this.events.push(event);if(event.type==='audio')this.cb.onSpeaking(true);}
    end(){this.cb.onSpeaking(false);this.cb.onState({phase:'idle'});this.complete.resolve();}
    stop(){this.cb.onSpeaking(false);this.complete.resolve();}
    dispose(){this.disposed++;this.stop();}
  }
  const api:any={
    async synthesizeSpeech(id:string,text:string){requests.push({id,text});order.push('synthesize');},
    async cancelSpeech(id:string){cancelled.push(id);},
    async releaseSpeech(id:string){routes.push(id);order.push('routing-release');},
    onSpeechEvent(cb:(event:VoiceOutputEvent)=>void){listener=cb;return()=>{listener=undefined;};},
  };
  const pair=options.pair??'both';
  if(pair==='both'||pair==='begin')api.beginSpeechPlaybackActivity=(id:string)=>{const result=deferred<string|null>();begins.push({id,result});order.push('begin:'+id);return result.promise;};
  if(pair==='both'||pair==='end')api.endSpeechPlaybackActivity=async(id:string,lease:string)=>{ends.push({id,lease});order.push('activity-end');if(failEnd)throw Error('public activity end failure');if(host.get(id)===lease)host.delete(id);};
  const output=new VoiceOutput({getTtsConfig:()=>config,getVoiceConfig:()=>voice,api,
    createId:()=>options.sameId?'reused-id':`activity-${++ids}`,
    createSystem(cb){systemSpeaking=cb;return{voices:()=>[],stop(){cb(false);},speak(text){order.push('system.speak');const result=deferred();systems.push({text,result});return result.promise;}};},
    createPlayer:cb=>new Player(cb),onSpeaking:value=>speaking.push(value),onError:error=>errors.push(error),
  });
  const issue=(index:number,lease:string)=>host.set(begins[index].id,lease);
  const grant=(index:number,lease:string)=>{issue(index,lease);begins[index].result.resolve(lease);};
  const endSystem=(index:number)=>{systemSpeaking(false);systems[index].result.resolve();};
  const audio=async(index=0)=>{listener?.({id:requests[index].id,type:'audio',data:'AAAAAA==',format:'pcm_s16le',sampleRate:24000,channels:1});await flush();};
  const done=async(index=0)=>{listener?.({id:requests[index].id,type:'done',firstAudioMs:1,audioBytes:4});await flush();};
  return{output,begins,ends,host,systems,requests,routes,cancelled,errors,speaking,order,players,issue,grant,endSystem,audio,done,
    setFailEnd(){failEnd=true;},startSystem(){systemSpeaking(true);},
    async cleanup(){output.dispose();for(const b of begins)b.result.resolve(null);for(const s of systems)s.result.resolve();for(const p of players){p.ready.resolve();p.complete.resolve();}await flush();},
  };
}

test('paired hooks guard system dispatch and hold queued/prestart activity without fake speaking',async()=>{
  const f=fixture();try{
    let finished=false;const task=f.output.speak('public speech',voice).then(()=>{finished=true;});
    assert.equal(f.begins.length,1);assert.equal(f.systems.length,0);assert.equal(f.speaking.includes(true),false);
    f.grant(0,'opaque-A');await flush();assert.equal(f.systems.length,1);assert.equal(f.host.size,1);assert.equal(finished,false);assert.equal(f.speaking.includes(true),false);
    f.startSystem();f.endSystem(0);await task;await flush();
    assert.deepEqual(f.ends,[{id:f.begins[0].id,lease:'opaque-A'}]);assert.equal(f.host.size,0);
  }finally{await f.cleanup();}
});

test('cloud preview keeps activity through network done until final controlled PCM drain and routing release',async()=>{
  const f=fixture({cloud:true});try{
    let finished=false;const task=f.output.preview('public preview').then(()=>{finished=true;});
    assert.equal(f.players.length,0);f.grant(0,'cloud-A');await flush();assert.equal(f.players.length,1);assert.equal(f.requests.length,1);
    await f.audio();await f.done();assert.equal(finished,false);assert.equal(f.ends.length,0);assert.equal(f.host.size,1);
    f.players[0].end();await task;await flush();
    assert.equal(f.ends.length,1);assert.equal(f.host.size,0);assert.ok(f.order.indexOf('routing-release')<f.order.indexOf('activity-end'));
  }finally{await f.cleanup();}
});

test('character preview admission precedes prepare and the same lease continues into its actual session',async()=>{
  const f=fixture();const prepared=deferred<{replyId:string}>();let prepareCalls=0;
  const task=f.output.previewCharacter('character preview',()=>{prepareCalls++;return prepared.promise;});
  try{
    assert.equal(prepareCalls,0);assert.equal(f.begins.length,1);
    f.grant(0,'prepare-A');await flush();assert.equal(prepareCalls,1);assert.equal(f.systems.length,0);assert.equal(f.host.size,1);
    prepared.resolve({replyId:'prepared'});await flush();assert.equal(f.systems.length,1);assert.equal(f.begins.length,1);
    f.startSystem();f.endSystem(0);await task;assert.deepEqual(f.ends,[{id:f.begins[0].id,lease:'prepare-A'}]);
  }finally{prepared.resolve({replyId:'prepared'});await f.cleanup();await task.catch(()=>{});}
});

test('stop or dispose before begin ACK settles locally and late lease is ended without an engine',async()=>{
  for(const dispose of [false,true]){const f=fixture();try{
    const task=f.output.speak('pending',voice);if(dispose)f.output.dispose();else f.output.stop();await task;
    f.grant(0,'late-A');await flush();assert.equal(f.systems.length,0);assert.equal(f.players.length,0);assert.equal(f.host.size,0);
    assert.deepEqual(f.ends,[{id:f.begins[0].id,lease:'late-A'}]);assert.deepEqual(f.errors,[]);
  }finally{await f.cleanup();}}
});

test('replacement with reused operation ID releases only the old opaque lease and preserves new playback',async()=>{
  const f=fixture({sameId:true});try{
    const old=f.output.speak('old',voice);f.issue(0,'old-lease');
    let newFinished=false;const next=f.output.speak('new',voice).then(()=>{newFinished=true;});await old;
    f.grant(1,'new-lease');await flush();assert.equal(f.systems.length,1);
    f.begins[0].result.resolve('old-lease');await flush();
    assert.equal(f.host.get('reused-id'),'new-lease');assert.equal(f.systems.length,1);assert.equal(newFinished,false);
    assert.deepEqual(f.ends,[{id:'reused-id',lease:'old-lease'}]);
    f.startSystem();f.endSystem(0);await next;assert.equal(f.host.size,0);assert.equal(f.ends[1].lease,'new-lease');
  }finally{await f.cleanup();}
});

test('null/rejected/empty leases and single-hook adapters fail closed before prepare or engines',async()=>{
  for(const outcome of ['null','reject','empty','begin-only','end-only']){
    const f=fixture({pair:outcome==='begin-only'?'begin':outcome==='end-only'?'end':'both'});let prepares=0;
    try{
      const task=f.output.previewCharacter('deny',async()=>{prepares++;return{replyId:'denied'};});
      const rejected=assert.rejects(task);
      if(outcome==='null')f.begins[0].result.resolve(null);
      if(outcome==='empty')f.begins[0].result.resolve('');
      if(outcome==='reject')f.begins[0].result.reject(Error('public begin rejection'));
      await rejected;await flush();assert.equal(prepares,0);assert.equal(f.systems.length,0);assert.equal(f.players.length,0);assert.equal(f.ends.length,0);
      if(outcome.endsWith('only'))assert.equal(f.begins.length,0);
    }finally{await f.cleanup();}
  }
});

test('legacy adapter with neither hook retains synchronous system dispatch without claiming activity coverage',async()=>{
  const f=fixture({pair:'none'});try{
    const task=f.output.speak('legacy',voice);assert.equal(f.systems.length,1);assert.equal(f.begins.length,0);
    f.startSystem();f.endSystem(0);await task;assert.equal(f.ends.length,0);
  }finally{await f.cleanup();}
});

test('late prepared context after replacement cannot create another session or release its new lease',async()=>{
  const f=fixture();const prepared=deferred<{replyId:string}>();try{
    const old=f.output.previewCharacter('old prepared',()=>prepared.promise);f.grant(0,'prepare-old');await flush();
    const next=f.output.speak('replacement',voice);await old;f.grant(1,'replacement-new');await flush();
    prepared.resolve({replyId:'late-old'});await flush();assert.equal(f.systems.length,1);assert.equal(f.systems[0].text,'replacement');assert.equal(f.host.get(f.begins[1].id),'replacement-new');
    f.startSystem();f.endSystem(0);await next;assert.equal(f.ends.filter(e=>e.lease==='prepare-old').length,1);assert.equal(f.host.size,0);
  }finally{prepared.resolve({replyId:'late-old'});await f.cleanup();}
});

test('preparation and system errors release the captured lease once and allow a subsequent operation',async()=>{
  const f=fixture();try{
    const preparation=f.output.previewCharacter('prepare error',async()=>{throw Error('public preparation error');});const failedPreparation=assert.rejects(preparation,/preparation/);
    f.grant(0,'prepare-error');await failedPreparation;await flush();assert.equal(f.systems.length,0);assert.equal(f.ends.length,1);
    const engine=f.output.speak('system error',voice);const failedEngine=assert.rejects(engine,/system/);f.grant(1,'system-error');await flush();
    f.systems[0].result.reject(Error('public system error'));await failedEngine;await flush();assert.equal(f.ends.length,2);assert.equal(f.host.size,0);
    const next=f.output.speak('recovered',voice);f.grant(2,'recovered');await flush();f.startSystem();f.endSystem(1);await next;
    assert.equal(f.ends.length,3);assert.equal(f.errors.length,2);assert.equal(f.host.size,0);
  }finally{await f.cleanup();}
});

test('cancellation while player begin/resume is pending releases once and a late resume cannot synthesize',async()=>{
  const f=fixture({cloud:true,holdPlayerBegin:true});try{
    // R02: synthesis is dispatched while the device starts; stop cancels that one request.
    const task=f.output.preview('pending resume');f.grant(0,'resume-A');await flush();assert.equal(f.players.length,1);assert.equal(f.requests.length,1);
    f.output.stop();await task;await flush();assert.equal(f.ends.length,1);assert.equal(f.host.size,0);assert.deepEqual(f.cancelled,[f.requests[0].id]);
    f.players[0].ready.resolve();await flush();assert.equal(f.requests.length,1,'a late resume cannot synthesize again');assert.equal(f.ends.length,1);
  }finally{await f.cleanup();}
});

test('activity end failure is a visible failure and does not retry or fabricate host release',async()=>{
  const f=fixture();try{
    f.setFailEnd();const task=f.output.speak('end fails',voice);const rejected=assert.rejects(task,/activity end/);
    f.grant(0,'held-on-failure');await flush();f.startSystem();f.endSystem(0);await rejected;await flush();
    assert.equal(f.ends.length,1);assert.equal(f.errors.length,1);assert.equal(f.host.size,1,'host disposition stays conservative, not a false release');
  }finally{await f.cleanup();}
});
