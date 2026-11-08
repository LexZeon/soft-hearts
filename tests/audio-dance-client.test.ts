import * as uiCopy from '../src/ui/ui-language';
const { uiText, uiHtml, uiMarkup, uiTemplate } = uiCopy;
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { AudioDanceFusion } from '../src/ui/audio-dance-fusion';
import { parseAudioDanceFrame } from '../shared/audio-dance';
import { audioReadingSources, audioReadingPurposes } from '../shared/audio-reading-toggles';
import { AmbientAudioSegments } from '../src/ui/ambient-audio-segments';
import { AudioCaptureHost } from '../electron/audio-capture-host';

// Entire actual client class and constructor; only physical capture and IPC/RAF
// boundaries are synthetic. No CSS loader, DOM, App, device or provider starts.
const source = readFileSync(new URL('../src/ui/AudioReadingClient.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AudioReadingClient.ts', source, ts.ScriptTarget.Latest, true);
const klass = ast.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'AudioReadingClient')!;
const create = new Function('uiText','uiHtml','uiMarkup','uiTemplate','deps', `const {AudioDanceFusion,parseAudioDanceFrame,audioReadingSources,audioReadingPurposes,AmbientAudioSegments,MicrophoneInput,performance,requestAnimationFrame,cancelAnimationFrame}=deps;
${ts.transpile(klass.getText(ast).replace(/^export /, ''), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })};return AudioReadingClient;`).bind(null, uiText, uiHtml, uiMarkup, uiTemplate);
function fixture() {
  let now = 100, serial = 0, captureEvent: Function = () => {}, frameEvent: Function = () => {};
  const frames = new Map<number, Function>(), active: boolean[] = [], samples: any[] = [], intents: any[] = [], errors: string[] = [], pcm: any[] = [], readings: any[] = [];
  class CapturePort { async apply(_descriptor: unknown) {} async dispose() {} }
  const Client = create({ AudioDanceFusion, parseAudioDanceFrame, audioReadingSources, audioReadingPurposes, AmbientAudioSegments,
    MicrophoneInput: CapturePort, performance: { now: () => now },
    requestAnimationFrame: (callback: Function) => { frames.set(++serial, callback); return serial; }, cancelAnimationFrame: (id: number) => frames.delete(id) });
  const host = new AudioCaptureHost({ available: () => true, lost() {}, publish: state => captureEvent(state) });
  const api = {
    onAudioReadingView: () => () => {}, onAmbientAudioState: () => () => {},
    onAudioCaptureState: (cb: Function) => { captureEvent = cb; return () => {}; },
    onAudioDanceSample: (cb: Function) => { frameEvent = cb; return () => {}; },
    setAudioDanceSourceIntent: async (intent: any) => { intents.push(intent); return host.setDance(intent.enabled, intent.source); },
    ackAudioCapture: async () => true,
    submitAudioReadingPcm: () => { assert.fail('dance must not submit ASR PCM'); },
    setAudioReadingIntent: async (intent: any) => { readings.push(intent); return null; },
  };
  const system = { active: true, async setEnabled() {}, async releaseOwned() {}, setPcmListener(listener: unknown) { pcm.push(listener); } };
  const client = new Client(null, { api, owner: 'pet', system, media: {},
    onMusicEnabled: (value: boolean) => active.push(value), onMusicSample: (sample: any) => samples.push(sample), onError: (error: string) => errors.push(error) });
  captureEvent(host.getState());
  const receive = (source: 'system-audio' | 'microphone', rms = 0.4) => {
    const d = host.getState().slots[source]!;
    frameEvent({ id: d.id, source, revision: d.revision, sample: { time: 500, rms, low: rms / 2, mid: 0, high: 0 } });
  };
  return { client, host, receive, frameEvent, active, samples, intents, errors, pcm, readings,
    advance(ms: number) { now += ms; const waiting = [...frames.values()]; frames.clear(); waiting.forEach(fn => fn(now)); } };
}

test('actual client fuses controls-owned microphone and loopback into one Stage route, rejects stale late frames', async () => {
  const f = fixture(); f.host.setChat('controls'); f.host.setDance(true, 'microphone'); f.host.setDance(true);
  assert.deepEqual(f.active, [], 'intent and physical-ready never prove a received energy frame');
  f.receive('system-audio'); f.receive('microphone');
  assert.deepEqual(f.active, [true]); assert.equal(f.samples.length, 1); assert.equal(f.samples[0].rms, 0.4);
  assert.ok(f.pcm.every(value => value === null), 'local-only loopback does not create a PCM listener');
  f.host.setDance(false); f.advance(40);
  assert.equal(f.active.at(-1), true, 'system off cannot disable a current microphone frame');
  const old = f.host.getState().slots.microphone!;
  f.host.setDance(false, 'microphone'); assert.equal(f.active.at(-1), false);
  const count = f.samples.length;
  f.frameEvent({ id: old.id, source: 'microphone', revision: old.revision, sample: { time: 500, rms: 1, low: 1, mid: 1, high: 1 } });
  f.advance(300); assert.equal(f.samples.length, count); assert.equal(f.active.at(-1), false);
  f.client.dispose(); await Promise.resolve(); assert.deepEqual(f.errors, []);
});

// I-016: the rhythm button and its source checkboxes were merged into the one switch 「和她一起听」. The client
// asks only for the computer's sound (the host turns its rhythm on and off with it); it never selects a dance source itself.
test('actual one switch asks for the computer\'s sound only; off clears both of its purposes; no dance source from the client', async () => {
  const f = fixture();
  await f.client.setListen(true);
  await f.client.setListen(false);
  assert.deepEqual(f.readings, [{ source: 'system-audio', purpose: 'music', enabled: true },
    { source: 'system-audio', purpose: 'music', enabled: false }, { source: 'system-audio', purpose: 'movie', enabled: false }]);
  assert.deepEqual(f.intents, [], 'the client sends no dance source intent');
  assert.ok(f.readings.every(r => r.source !== 'microphone'));
  f.client.dispose();
});
