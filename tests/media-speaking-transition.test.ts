import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaInput } from '../src/ui/MediaInput';
import { MicrophoneInput } from '../src/ui/MicrophoneInput';
import { AudioCaptureHost } from '../electron/audio-capture-host';
import { MediaRuntime } from '../electron/runtime';
import type { VoicePcmReceipt } from '../shared/voice-segments';

interface Ports { media: MediaInput; feed(value: number): void; at(ms: number): void; waves: ArrayBuffer[]; signals: string[]; ownership(): { acquisitions: number; stops: number; owner: string | null }; }
async function fixture(run: (ports: Ports) => Promise<void>): Promise<void> {
  const names = ['window','navigator','AudioContext','setTimeout','clearTimeout','performance'] as const;
  const original = new Map(names.map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const waves: ArrayBuffer[] = [], signals: string[] = [], errors: string[] = [], timers = new Map<number,() => void>();
  let now = 0, timer = 0, acquisitions = 0, stops = 0;
  let processor!: { onaudioprocess: ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null };
  let media!: MediaInput, microphone!: MicrophoneInput, runtime!: MediaRuntime, work = Promise.resolve();
  const node = () => ({ connect() {}, disconnect() {} });
  const track = { stop() { stops++; }, addEventListener() {}, removeEventListener() {} };
  const disable = () => { if (runtime.state.voiceInput) void media.applyRuntime(runtime.update({voiceInput:false},'controls')); };
  const host = new AudioCaptureHost({ available: owner => owner === 'controls', publish: state => { work = microphone.apply(state.slots.microphone); }, lost: disable });
  runtime = new MediaRuntime(state => { host.setChat(state.voiceInput ? state.voiceOwner : null); });
  class AudioFixture {
    sampleRate = 16000; state = 'running'; destination = {};
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { processor = {...node(),onaudioprocess:null}; return processor; }
    createGain() { return {...node(),gain:{value:0}}; }
    async resume() {} async close() { this.state = 'closed'; }
  }
  const install = (name: string,value: unknown) => Object.defineProperty(globalThis,name,{configurable:true,value});
  install('performance',{now:() => now});
  install('window',{desktop:{
    openVoiceCapture:async () => { signals.push('open'); runtime.update({voiceInput:true},'controls',owner=>host.selectChatOwner(owner)); return {captureSessionId:'capture',epoch:'epoch'}; },
    signalVoiceCapture:async (_id: string,signal: string) => { signals.push(signal); if(signal==='cancel')disable(); return true; },
    submitVoicePcm:async (value: {captureSeq:number;wav:ArrayBuffer}):Promise<VoicePcmReceipt> => {
      assert.ok(value.wav.byteLength<=480044);waves.push(value.wav.slice(0));signals.push('submit-'+value.captureSeq);
      return {state:'queued',groupId:'group',segmentId:'segment-'+value.captureSeq,captureSeq:value.captureSeq};
    },
  }});
  install('navigator',{mediaDevices:{getUserMedia:async (options:unknown) => {
    assert.deepEqual(options,{audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    acquisitions++;return {getTracks:()=>[track]};
  }}});
  install('AudioContext',AudioFixture);
  install('setTimeout',(fn:()=>void,ms:number) => { assert.equal(ms,1500);const id=++timer;timers.set(id,fn);return id; });
  install('clearTimeout',(id:number)=>{timers.delete(id);});
  media = new MediaInput({windowKind:'controls',onTranscript:()=>{throw Error('Legacy path forbidden');},onError:message=>{errors.push(message);disable();}});
  microphone = new MicrophoneInput({owner:'controls',acknowledge:async value=>host.ack('controls',value),onPcm:(samples,rate)=>media.pushVoicePcm(samples,rate),onReady:ready=>media.microphoneReady(ready),onError:message=>{errors.push(message);disable();}});
  try {
    await media.applyRuntime({voiceInput:true,voiceOwner:'controls',cameraSharing:false,cameraOwner:null,screenSharing:false});await work;
    await run({media,waves,signals,at:ms=>{assert.ok(ms>=now);now=ms;},feed:value=>processor.onaudioprocess!({inputBuffer:{getChannelData:()=>new Float32Array(4096).fill(value)}}),ownership:()=>({acquisitions,stops,owner:host.getState().slots.microphone?.owner??null})});
    assert.deepEqual(errors,[]);assert.deepEqual({acquisitions,stops,owner:host.getState().slots.microphone?.owner??null},{acquisitions:1,stops:0,owner:'controls'});
  } finally {
    media.dispose();runtime.reset();host.clear();await microphone.dispose();
    for(const name of names){const descriptor=original.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
  }
}
const frames=(wav:ArrayBuffer)=>new DataView(wav).getUint32(40,true)/2;
const sample=(wav:ArrayBuffer,index:number)=>new DataView(wav).getInt16(44+index*2,true);
const encoded=(value:number)=>Math.round(Math.fround(value)*32767);

test('idle repeated false notifications accept immediate PCM without changing the actual capture owner',async()=>{
  await fixture(async({media,feed,waves,ownership})=>{
    media.setSpeaking(false);media.setSpeaking(false);feed(.1);await media.finishSpeaking();
    assert.equal(waves.length,1);assert.equal(frames(waves[0]),4096);assert.equal(sample(waves[0],0),encoded(.1));
    assert.deepEqual(ownership(),{acquisitions:1,stops:0,owner:'controls'});
  });
});
test('repeated passive false preserves an already voiced prefix and suffix',async()=>{
  await fixture(async({media,feed,waves})=>{
    feed(.1);media.setSpeaking(false);media.setSpeaking(false);feed(.2);await media.finishSpeaking();
    assert.equal(waves.length,1);assert.equal(frames(waves[0]),8192);assert.equal(sample(waves[0],0),encoded(.1));assert.equal(sample(waves[0],4096),encoded(.2));
  });
});
test('real TTS transitions keep exactly the existing 200ms protection without duplicate extension',async()=>{
  await fixture(async({media,feed,at,waves})=>{
    media.setSpeaking(true);feed(.5);at(40);media.setSpeaking(true);feed(.5);
    at(100);media.setSpeaking(false);at(250);media.setSpeaking(false);at(299);feed(.5);
    at(300);feed(.1);at(350);media.setSpeaking(false);feed(.2);await media.finishSpeaking();
    assert.equal(waves.length,1);assert.equal(frames(waves[0]),8192);assert.equal(sample(waves[0],0),encoded(.1));assert.equal(sample(waves[0],4096),encoded(.2));
  });
});
test('a second explicit start while already false still clears the old unfinished segment',async()=>{
  await fixture(async({media,feed,waves,signals})=>{
    await media.startSpeaking();feed(.1);await media.startSpeaking();feed(.2);await media.finishSpeaking();
    assert.equal(waves.length,1);assert.equal(frames(waves[0]),4096);assert.equal(sample(waves[0],0),encoded(.2));
    assert.equal(signals.filter(value=>value==='open').length,1);assert.equal(signals.at(-1),'finish-speaking');
  });
});
