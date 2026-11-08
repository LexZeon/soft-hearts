import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { AudioCaptureHost } from '../electron/audio-capture-host';
import { parseAudioDanceFrame, parseAudioDanceIntent, type AudioDanceFrame } from '../shared/audio-dance';
import { AudioDanceFusion } from '../src/ui/audio-dance-fusion';
import { audioEnergy } from '../src/ui/audio-energy';
import { MicrophoneInput } from '../src/ui/MicrophoneInput';

const energy = (time = 1, rms = 0.2) => ({ time, rms, low: rms / 2, mid: rms / 3, high: 0 });
function hostFixture() {
  let clock = 1000, serial = 0;
  const last: Partial<Record<'microphone' | 'system-audio', any>> = {};
  const available = new Set(['pet', 'controls']);
  const host = new AudioCaptureHost({ available: owner => available.has(owner), publish(state) {
    for (const source of ['microphone', 'system-audio'] as const) if (state.slots[source]) last[source] = structuredClone(state.slots[source]);
  }, lost() {},
    now: () => clock, id: () => `capture-${++serial}` });
  const descriptor = (source: 'microphone' | 'system-audio') => host.getState().slots[source]!;
  const ready = (source: 'microphone' | 'system-audio') => {
    const value = descriptor(source); assert.equal(host.ack(value.owner, { id: value.id, source, revision: value.revision, phase: 'ready' }), true);
    return value;
  };
  const frame = (source: 'microphone' | 'system-audio', time = clock) => {
    const value = descriptor(source); return { id: value.id, source, revision: value.revision, sample: energy(time) };
  };
  return { host, available, descriptor, ready, frame, last, advance: (delta = 40) => { clock += delta; } };
}

test('microphone dance shares controls chat/ambient and never releases another consumer', async () => {
  const f = hostFixture();
  assert.deepEqual(f.host.getState().slots, { microphone: null, 'system-audio': null });
  f.host.setChat('controls'); const original = f.descriptor('microphone');
  f.host.setDance(true, 'microphone');
  const leasePromise = f.host.acquire({ source: 'microphone', scopeId: 'scope', epoch: 1, signal: new AbortController().signal });
  f.ready('microphone'); const lease = await leasePromise;
  f.host.setDance(true); f.ready('system-audio');
  assert.equal(f.descriptor('microphone').id, original.id);
  assert.equal(f.descriptor('microphone').owner, 'controls');
  f.host.setDance(false, 'microphone');
  assert.equal(f.descriptor('microphone').chat, true);
  assert.ok(f.descriptor('microphone').ambient);
  assert.equal(f.descriptor('system-audio').dance, true);
  await lease.release(); f.host.setChat(null);
  assert.equal(f.descriptor('microphone'), null);
  assert.throws(() => f.host.setDance(true, 'microphone'), /release/);
  assert.equal(f.host.ack('controls', { id: original.id, source: 'microphone', revision: f.last.microphone.revision, phase: 'released' }), true);
  f.host.setDance(true, 'microphone'); assert.notEqual(f.descriptor('microphone').id, original.id);
});

test('energy ingress rejects foreign/unready/stale/unconsented frames; analysis fault withdraws only dance', () => {
  const f = hostFixture(); f.host.setChat('controls'); f.host.setDance(true, 'microphone');
  assert.equal(f.host.acceptDanceSample('controls', f.frame('microphone')), null);
  f.ready('microphone');
  assert.equal(f.host.acceptDanceSample('pet', f.frame('microphone')), null);
  const first = f.frame('microphone'); assert.ok(f.host.acceptDanceSample('controls', first));
  f.advance(); assert.equal(f.host.acceptDanceSample('controls', first), null);
  f.host.touch('microphone'); f.advance(); assert.equal(f.host.acceptDanceSample('controls', { ...first, sample: energy(2000) }), null);
  f.available.delete('pet'); assert.equal(f.host.acceptDanceSample('controls', f.frame('microphone')), null);
  f.available.add('pet');
  assert.ok(f.host.acceptDanceSample('controls', { ...f.frame('microphone'), sample: null }));
  assert.equal(f.descriptor('microphone').dance, false); assert.equal(f.descriptor('microphone').chat, true);
  f.advance(); assert.equal(f.host.acceptDanceSample('controls', f.frame('microphone')), null);
});

test('finite parser rejects PCM, arbitrary sources, accessors and non-finite energy', () => {
  assert.equal(parseAudioDanceIntent({ source: 'camera', enabled: true }), null);
  assert.equal(parseAudioDanceIntent({ source: 'microphone', enabled: true, deviceId: 'x' }), null);
  const good: AudioDanceFrame = { id: 'capture', source: 'microphone', revision: 1, sample: energy() };
  assert.ok(parseAudioDanceFrame(good));
  assert.equal(parseAudioDanceFrame({ ...good, pcm: new ArrayBuffer(2) }), null);
  assert.equal(parseAudioDanceFrame({ ...good, sample: { ...energy(), rms: NaN } }), null);
  assert.equal(parseAudioDanceFrame({ ...good, sample: { ...energy(), low: 2 } }), null);
  assert.equal(parseAudioDanceFrame({ ...good, sample: Object.defineProperty(energy(), 'rms', { get() { throw Error('must not run'); } }) }), null);
});

test('dual-source fusion selects one complete frame, bounds output rate and expires stale input', () => {
  const fusion = new AudioDanceFusion();
  fusion.push('system-audio', energy(100, 0.4), 0); fusion.push('microphone', energy(200, 0.41), 0);
  const first = fusion.read(0)!;
  assert.equal(first.sample.rms, 0.41); assert.equal(first.sample.low, 0.41 / 2);
  assert.equal(fusion.read(1), null, 'two callbacks cannot create two Stage beats');
  fusion.push('system-audio', energy(101, 0.42), 40); fusion.push('microphone', energy(201, 0.4), 40);
  assert.equal(fusion.read(40)?.source, 'microphone', 'near-equal copies do not flap');
  assert.equal(fusion.read(301), null, 'no held audio spectrum after freshness expires');
  fusion.push('system-audio', energy(102, 0.3), 340);
  assert.equal(fusion.read(340)?.source, 'system-audio', 'an already selected/authorized surviving source remains usable');
  fusion.clear(); assert.equal(fusion.read(400), null);
  const silence = audioEnergy(new Float32Array(2048), new Float32Array(1024).fill(-Infinity), 48000, 1);
  assert.deepEqual(silence, energy(1, 0));
});

test('real microphone class keeps dance-only graph local and shares its stream when chat joins', async t => {
  const keys = ['navigator', 'AudioContext', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  t.after(() => { for (const [key, value] of originals) if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key]; });
  let acquired = 0, stopped = 0, closed = 0, processors = 0, gains = 0, sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const node = () => ({ connect() {}, disconnect() {} });
  const track = { stop() { stopped++; }, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { async getUserMedia(constraints: any) {
    assert.equal(constraints.video, false); acquired++; return { getTracks: () => [track] };
  } } } });
  class AudioMock {
    state = 'running'; sampleRate = 48000;
    get destination() { assert.ok(processors > 0, 'dance alone never touches an output endpoint'); return {}; }
    createMediaStreamSource() { return node(); }
    createAnalyser() { return { ...node(), fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0,
      getFloatTimeDomainData(values: Float32Array) { values.fill(0.1); }, getFloatFrequencyData(values: Float32Array) { values.fill(-60); } }; }
    createScriptProcessor() { processors++; return { ...node(), onaudioprocess: null }; }
    createGain() { gains++; return { ...node(), gain: { value: 1 } }; }
    async close() { closed++; this.state = 'closed'; }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: AudioMock });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => frames.delete(id) });
  let samples = 0;
  const input = new MicrophoneInput({ owner: 'pet', acknowledge: async () => true, onError: message => assert.fail(message),
    onPcm: () => assert.fail('dance cannot make PCM'), onSample: value => { assert.ok(value); samples++; } });
  const descriptor = { id: 'owned', source: 'microphone' as const, owner: 'pet' as const, revision: 1, chat: false, dance: true, ambient: null };
  await input.apply(descriptor); assert.equal(acquired, 1); assert.equal(processors, 0); assert.equal(gains, 0);
  const callback = [...frames.values()][0]; frames.clear(); callback(100); assert.equal(samples, 1);
  await input.apply({ ...descriptor, revision: 2, chat: true }); assert.equal(acquired, 1); assert.equal(processors, 1);
  await input.apply({ ...descriptor, revision: 3, chat: true, dance: false });
  assert.equal(stopped, 0); assert.equal(closed, 0); assert.equal(frames.size, 0);
  callback(200); assert.equal(samples, 1, 'late RAF does not revive analyser after dance off');
  await input.dispose(); assert.equal(stopped, 1); assert.equal(closed, 1);
});

test('actual host dance IPC routes only finite current-owner energy and visible-pet intent', () => {
  const text = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
  const register = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'registerIPC')!;
  const names = ['setAudioDanceSourceIntent', 'submitAudioDanceSample'];
  const statements = names.map(name => register.body!.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)
    && n.expression.arguments[0]?.getText(ast) === `'${name}'`)!.getText(ast));
  const f = hostFixture(), callbacks: Record<string, Function> = {}, sent: unknown[] = [];
  const pet = { webContents: { id: 1, send: (_channel: string, frame: unknown) => sent.push(frame) }, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  const run = new Function('scopedHost', 'audioCapture', 'pet', 'ownerFor', 'parseAudioDanceIntent', ts.transpile(statements.join('\n'), { target: ts.ScriptTarget.ES2022 }));
  run((name: string, callback: Function) => { callbacks[name] = callback; }, f.host, pet, (id: number) => id === 1 ? 'pet' : 'controls', parseAudioDanceIntent);
  assert.throws(() => callbacks.setAudioDanceSourceIntent(2, { source: 'microphone', enabled: true }));
  callbacks.setAudioDanceSourceIntent(1, { source: 'microphone', enabled: true }); f.ready('microphone');
  assert.equal(callbacks.submitAudioDanceSample(2, f.frame('microphone')), false);
  assert.equal(callbacks.submitAudioDanceSample(1, f.frame('microphone')), true); assert.equal(sent.length, 1);
  f.host.setDance(false, 'microphone'); f.advance();
  assert.equal(callbacks.submitAudioDanceSample(1, sent[0]), false); assert.equal(sent.length, 1);
});
