// I-099/I-100: Smart Turn v3.2 measured with the REAL model and ONNX Runtime (opt-in: SOFT_HEARTS_ORT_ENTRY = the component's
// onnxruntime-node entry, e.g. from the pose runtime pack). Synthetic audio only (a glottal-pulse vowel babble, not a person), so
// this does NOT assert what the model "should" say about it; it makes sure the whole chain runs on the bundled file, that every
// answer is a probability in [0, 1], and it prints what the model said and how long one look takes on this machine.
// docs/claude/2026-11-12-smart-turn.md has the numbers from the last run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import smartTurn from '../shared/voice/smart-turn.json';
import { SmartTurn } from '../electron/senses/asr/smart-turn';
import { smartTurnFeatures } from '../electron/senses/asr/smart-turn-features';
import type { VadOrtLike } from '../electron/senses/asr/vad';
import { syntheticSpeech } from './helpers/synthetic-speech';

const SKIP = !process.env.SOFT_HEARTS_ORT_ENTRY && 'set SOFT_HEARTS_ORT_ENTRY to the onnxruntime-node entry to run';
const RATE = 16_000;

function fade(audio: Float32Array, seconds: number): Float32Array {
  const out = audio.slice(), n = Math.round(seconds * RATE);
  for (let i = 0; i < n; i++) out[out.length - 1 - i] *= i / n;
  return out;
}
function withTail(audio: Float32Array, seconds: number): Float32Array {
  const out = new Float32Array(audio.length + Math.round(seconds * RATE)); out.set(audio); return out;
}

test('real model: runs on the bundled file, answers a probability in [0, 1] for every scene, and how long one look takes', { skip: SKIP }, async () => {
  const ort = createRequire(import.meta.url)(path.resolve(process.env.SOFT_HEARTS_ORT_ENTRY!)) as VadOrtLike;
  const model = new Uint8Array(readFileSync(path.join('assets/bundled', smartTurn.model.relativePath)));
  const turn = await SmartTurn.open(ort, model);
  try {
    let x = 3; const noise = Float32Array.from({ length: RATE * 3 }, () => { x = (x * 9301 + 49297) % 233280; return (x / 233280 - 0.5) * 0.4; });
    const speech3 = syntheticSpeech(RATE * 3, 1), speech6 = syntheticSpeech(RATE * 6, 2), speech10 = syntheticSpeech(RATE * 10, 4);
    const scenes: Record<string, Float32Array> = {
      'vowel babble 3 s, cut abruptly': speech3,
      'vowel babble 3 s, fading out over 0.6 s': fade(speech3, 0.6),
      'vowel babble 3 s, fading out + 0.25 s of quiet (what the call sends)': withTail(fade(speech3, 0.6), 0.25),
      'vowel babble 3 s, cut abruptly + 0.25 s of quiet': withTail(speech3, 0.25),
      'vowel babble 3 s + 1 s of quiet': withTail(speech3, 1),
      'vowel babble 6 s + 0.25 s of quiet': withTail(speech6, 0.25),
      'vowel babble 10 s + 0.25 s of quiet (the call sends only the last 8 s)': withTail(speech10, 0.25).subarray(-8 * RATE),
      'vowel babble 0.5 s': syntheticSpeech(RATE / 2, 5),
      'white noise 3 s': noise,
      '440 Hz tone 3 s': Float32Array.from({ length: RATE * 3 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * 440 * i / RATE)),
      'silence 1 s': new Float32Array(RATE),
    };
    const lines: string[] = [];
    for (const [name, audio] of Object.entries(scenes)) {
      const p = await turn.complete(audio);
      assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `${name}: ${p}`);
      lines.push(`  ${p.toFixed(3)}  ${name}`);
    }
    console.log(`Smart Turn probability that the turn is complete (synthetic audio, not people):\n${lines.join('\n')}`);
    // timing: one look = features (8 s window) + the model, one process, this machine
    const audio = withTail(speech6, 0.25);
    for (let i = 0; i < 3; i++) await turn.complete(audio); // warm
    const runs = 15;
    let started = performance.now();
    for (let i = 0; i < runs; i++) smartTurnFeatures(audio);
    const featureMs = (performance.now() - started) / runs;
    started = performance.now();
    for (let i = 0; i < runs; i++) await turn.complete(audio);
    const totalMs = (performance.now() - started) / runs;
    started = performance.now();
    await turn.complete(audio.subarray(0, RATE)); // a short turn costs the same: the window is always 8 s
    const shortMs = performance.now() - started;
    console.log(`one look on this machine: features ${featureMs.toFixed(1)} ms, features + model ${totalMs.toFixed(1)} ms (a 1 s turn: ${shortMs.toFixed(1)} ms; 2 model threads, ${runs} runs)`);
    assert.ok(totalMs > 0);
  } finally { await turn.release(); }
});
