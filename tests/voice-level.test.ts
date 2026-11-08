import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SPEECH_LEVEL, SilenceWatch, SpeechLevelGate, chunkRms } from '../src/ui/voice-level';
import { VoiceSegmenter } from '../src/ui/MediaInput';

// a quiet laptop array microphone never crossed the one fixed level (0.01, about -40 dBFS),
// so nothing was ever sent to recognition and nothing was said. The level a voice must pass now follows the room.
const chunk = (rms: number, length = 4096) => new Float32Array(length).fill(rms);

test('the speech level starts where it always was and only comes down for a quiet room', () => {
  const gate = new SpeechLevelGate();
  assert.equal(gate.threshold, DEFAULT_SPEECH_LEVEL);
  for (let index = 0; index < 40; index++) gate.observe(0.0008, false);
  assert.ok(gate.threshold < 0.005 && gate.threshold >= 0.003, `threshold ${gate.threshold}`);
  assert.ok(0.006 >= gate.threshold, 'a quiet voice at -44 dBFS now counts as speech');
  const noisy = new SpeechLevelGate();
  for (let index = 0; index < 40; index++) noisy.observe(0.02, false);
  assert.equal(noisy.threshold, DEFAULT_SPEECH_LEVEL, 'a noisy room is never treated more leniently than before');
});

test('speaking does not teach the gate that the room got louder', () => {
  const gate = new SpeechLevelGate();
  for (let index = 0; index < 40; index++) gate.observe(0.0008, false);
  const before = gate.threshold;
  for (let index = 0; index < 60; index++) gate.observe(0.06, true);
  assert.equal(gate.threshold, before);
});

test('chunkRms is the root mean square', () => {
  assert.ok(Math.abs(chunkRms(chunk(0.1)) - 0.1) < 1e-6);
  assert.equal(chunkRms(new Float32Array(0)), 0);
});

test('the segmenter takes the level it is given; the default is unchanged', () => {
  const quiet = chunk(0.006, 8000), silence = new Float32Array(11200);
  const old = new VoiceSegmenter();
  old.push(quiet, 16000); assert.equal(old.active, false, 'the old fixed level ignores it');
  const adapted = new VoiceSegmenter();
  assert.equal(adapted.push(quiet, 16000, 0.003), null);
  assert.equal(adapted.active, true);
  const utterance = adapted.push(silence, 16000, 0.003);
  assert.ok(utterance && utterance.length >= 8000);
});

test('a microphone that delivers only digital silence is noticed once, a quiet room is not', () => {
  const dead = new SilenceWatch();
  let fired = 0;
  for (let index = 0; index < 200; index++) if (dead.feed(0, 4096 / 16000)) fired++;
  assert.equal(fired, 1);
  const room = new SilenceWatch();
  for (let index = 0; index < 400; index++) assert.equal(room.feed(0.001, 4096 / 16000), false, 'room noise is a working microphone');
  const late = new SilenceWatch();
  for (let index = 0; index < 20; index++) late.feed(0, 4096 / 16000);
  late.feed(0.02, 4096 / 16000);
  for (let index = 0; index < 400; index++) assert.equal(late.feed(0, 4096 / 16000), false, 'one real sound clears the doubt for this capture');
});
