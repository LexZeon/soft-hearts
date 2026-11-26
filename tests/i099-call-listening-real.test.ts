// I-099 measured with the REAL Silero model (opt-in: SOFT_HEARTS_ORT_ENTRY = the component's onnxruntime-node entry, e.g. from
// the pose runtime pack). The window's real MediaInput in a call, 48 kHz / 4096-sample chunks (85 ms) like the microphone,
// the real resampler and model in-process (no IPC), synthetic audio only. Loudness (the old way) next to the VAD.
// Prints one line per scene; asserts the differences the VAD is for. docs/claude/2026-11-12-call-listening.md has the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import silero from '../shared/voice/silero-vad.json';
import { SileroVad, type VadOrtLike } from '../electron/senses/asr/vad';
import { VOICE_CALL_KNOBS } from '../shared/behaviors/voice-call/knobs';
import { CallVadStream } from '../src/voice/voice-call/vad';
import { MediaInput, type CallInputEvent } from '../src/senses/MediaInput';
import { syntheticSpeech } from './helpers/synthetic-speech';

const RATE = 48_000, CHUNK = 4096, CHUNK_MS = CHUNK / RATE * 1000;
const SKIP = !process.env.SOFT_HEARTS_ORT_ENTRY && 'set SOFT_HEARTS_ORT_ENTRY to the onnxruntime-node entry to run';

const add = (a: Float32Array, b: Float32Array) => a.map((value, i) => value + (b[i] ?? 0));
const at = (seconds: number) => Math.round(seconds * RATE);
function music(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => { const t = i / RATE; return 0.05 * (Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 392 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 2 * t)); });
}
function claps(n: number): Float32Array {
  let x = 7;
  return Float32Array.from({ length: n }, (_, i) => { x = (x * 9301 + 49297) % 233280; return (i / RATE) % 0.3 < 0.1 ? (x / 233280 * 2 - 1) * 0.4 : 0; });
}
/** Her own reading coming back through the speakers (quiet, speech-like). */
const echo = (n: number) => syntheticSpeech(n, 3, RATE).map(v => v * 0.08);
const room = (n: number) => Float32Array.from({ length: n }, (_, i) => ((i * 7919) % 13 - 6) * 0.0002);
function place(base: Float32Array, part: Float32Array, from: number): Float32Array { const out = base.slice(); out.set(add(out.subarray(from, from + part.length), part), from); return out; }

interface Scene { reading: boolean; audio: Float32Array }
/** Runs one scene through MediaInput in a call; returns what happened with times in ms from the start of the audio. */
async function hear(scene: Scene, vad: SileroVad | null): Promise<{ start: number | null; cut: number | null; bargeIn: number | null; clip: number | null }> {
  const names = ['window', 'performance', 'setTimeout', 'clearTimeout'] as const;
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
  let now = 0;
  const result = { start: null as number | null, cut: null as number | null, bargeIn: null as number | null, clip: null as number | null };
  const install = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  install('performance', { now: () => now });
  install('setTimeout', (fn: () => void) => { queueMicrotask(fn); return 1; });
  install('clearTimeout', () => {});
  install('window', { desktop: {
    openVoiceCapture: async () => ({ captureSessionId: 'c', epoch: 'e' }),
    signalVoiceCapture: async (_id: string, signal: string) => { if (signal === 'speech-start') result.start ??= Math.round(now); return true; },
    submitVoicePcm: async (value: { wav: ArrayBuffer; captureSeq: number }) => { result.clip ??= new DataView(value.wav).getUint32(40, true) / 32_000; return { state: 'queued', groupId: 'g', segmentId: 's', captureSeq: value.captureSeq }; },
    noteJournalFact: async () => true,
  } });
  const stream = vad && new CallVadStream(() => ({ voiceCallVad: async (pcm, reset) => { if (reset) vad.reset(); return vad.push(pcm); } }), VOICE_CALL_KNOBS.vad,
    { set: (callback, ms) => realSetTimeout(callback, ms), clear: handle => realClearTimeout(handle as never) });
  const media = new MediaInput({ windowKind: 'controls', pushToTalk: true, onTranscript() {}, onError: message => { throw Error(message); },
    onCallEvent: (event: CallInputEvent) => { if (event.type === 'barge-in') result.bargeIn ??= Math.round(now); if (event.type === 'endpoint') result.cut ??= Math.round(now); },
    ...(stream ? { callVad: stream } : {}) });
  const tick = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));
  try {
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', cameraSharing: false, cameraOwner: null, screenSharing: false });
    media.microphoneReady(true);
    media.setCall(VOICE_CALL_KNOBS);
    for (let i = 0; i < 10; i++) await tick();
    if (vad) assert.equal(stream!.ready, true, 'the model warmed up');
    if (scene.reading) media.setSpeaking(true);
    for (let from = 0; from + CHUNK <= scene.audio.length; from += CHUNK) {
      now += CHUNK_MS; // the chunk is delivered when its last sample has been recorded
      media.pushVoicePcm(scene.audio.slice(from, from + CHUNK), RATE);
      for (let i = 0; i < 3; i++) await tick();
    }
    for (let i = 0; i < 20; i++) await tick();
  } finally {
    media.dispose();
    for (const name of names) { const descriptor = original.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  }
  return result;
}

test('real model: loudness vs the VAD on synthetic scenes (music, claps, echo, talking over her)', { skip: SKIP }, async () => {
  const ort = createRequire(import.meta.url)(path.resolve(process.env.SOFT_HEARTS_ORT_ENTRY!)) as VadOrtLike;
  const vad = await SileroVad.open(ort, new Uint8Array(readFileSync(path.join('assets/bundled', silero.model.relativePath))));
  try {
    const started = performance.now();
    for (let i = 0; i < 200; i++) await vad.push(new Float32Array(1365).fill(0.01));
    const perChunk = (performance.now() - started) / 200;
    const speech = syntheticSpeech(at(1.5), 1, RATE); // the user, 1.0–2.5 s
    const scenes: Record<string, Scene> = {
      'A quiet room, you speak 1.0–2.5 s': { reading: false, audio: place(room(at(4)), speech, at(1)) },
      'B music the whole time, you speak 1.0–2.5 s': { reading: false, audio: place(music(at(4)), speech, at(1)) },
      'C she reads, music starts at 1.0 s': { reading: true, audio: place(echo(at(3)), music(at(2)), at(1)) },
      'D she reads, claps from 1.0 s': { reading: true, audio: place(echo(at(3)), claps(at(2)), at(1)) },
      'E she reads, you talk over her at 2.5 s': { reading: true, audio: place(echo(at(4)), syntheticSpeech(at(1), 1, RATE), at(2.5)) },
    };
    const results: Record<string, { rms: Awaited<ReturnType<typeof hear>>; vad: Awaited<ReturnType<typeof hear>> }> = {};
    for (const [name, scene] of Object.entries(scenes)) results[name] = { rms: await hear(scene, null), vad: await hear(scene, vad) };
    const show = (r: Awaited<ReturnType<typeof hear>>) => `start ${r.start ?? '—'}  cut ${r.cut ?? '—'}  barge-in ${r.bargeIn ?? '—'}  clip ${r.clip?.toFixed(2) ?? '—'} s`;
    console.log(`VAD cost: ${perChunk.toFixed(2)} ms per 85 ms chunk (one thread, this machine)`);
    for (const [name, r] of Object.entries(results)) console.log(`${name}\n  loudness: ${show(r.rms)}\n  VAD:      ${show(r.vad)}`);
    const A = results['A quiet room, you speak 1.0–2.5 s'], B = results['B music the whole time, you speak 1.0–2.5 s'];
    const C = results['C she reads, music starts at 1.0 s'], D = results['D she reads, claps from 1.0 s'], E = results['E she reads, you talk over her at 2.5 s'];
    assert.ok(A.vad.cut !== null && A.vad.cut - 2500 < 1000, 'quiet room: the VAD cuts within a second of the end of speech');
    assert.ok(B.rms.start !== null && B.rms.start < 1000 && B.rms.cut === null, 'music: loudness starts on the music and never cuts');
    assert.ok(B.vad.start !== null && B.vad.start >= 1000 && B.vad.cut !== null && B.vad.cut - 2500 < 1000, 'music: the VAD hears only the user');
    assert.ok(C.rms.bargeIn !== null && C.vad.bargeIn === null, 'music while she reads: loudness stops her, the VAD does not');
    assert.ok(D.rms.bargeIn !== null && D.vad.bargeIn === null, 'claps while she reads: loudness stops her, the VAD does not');
    assert.ok(E.vad.bargeIn !== null && E.vad.bargeIn - 2500 < 500, 'the user talking over her still stops her');
  } finally { await vad.release(); }
});
