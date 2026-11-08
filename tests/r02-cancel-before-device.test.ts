import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent, type VoiceOutputPlaybackState } from '../src/ui/VoiceOutput';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { flush, pcm, world } from './helpers/r02-audio-world';

/*
 * Codex retest of main a60c567 (bridge X-321, T-215 retest report): while the output device was still starting, the
 * host's "cancelled" for the current request was queued behind the PCM already received (VoiceOutput.receive ran it in
 * session.queue, after `await player.accept`, which waits for the device). When the device ran, that PCM was scheduled:
 * trace seq4 cancel -> seq5 source.start -> seq7 stop. A reading the host has stopped must never start. The exact cancel
 * now stops the playback when it arrives; nothing waits for it, and nothing new waits before the first sound.
 * Fake clock, fake device (it starts 2 s after it is asked), real VoiceOutput and StreamingVoicePlayer; no audio.
 */
const LIMIT = { timeout: 30_000 };
const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };

function harness(t: TestContext) {
  const w = world(t, { deviceStartMs: 2000 });
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers, visibility: null });
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  let ids = 0;
  const requests: string[] = [], cancels: string[] = [], speaking: boolean[] = [], states: VoiceOutputPlaybackState[] = [], errors: string[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id) { requests.push(id); },
      async cancelSpeech(id) { cancels.push(id); },
      async releaseSpeech() {},
      async beginSpeechPlaybackActivity() { return 'lease'; },
      async endSpeechPlaybackActivity() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
    },
    onSpeaking: value => speaking.push(value), onState: state => states.push(state), onError: message => errors.push(message),
    createId: () => `cancel-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (id: string, event: TtsStreamEvent | { type: 'error'; message: string; cancelled?: boolean }) => listener?.({ id, ...event } as VoiceOutputEvent);
  const audioChunk = (first = false): TtsStreamEvent => ({ type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(first ? { firstAudioMs: 300 } : {}) });
  /** Every source.start the fake device saw. */
  const starts = () => w.contexts.flatMap(device => device.sources).filter(source => source.startAt >= 0).length;
  return { w, output, requests, cancels, speaking, states, errors, emit, audioChunk, starts };
}

test('cancel while the device starts: PCM already queued for a cancelled reading never starts (Codex X-321)', LIMIT, async t => {
  const h = harness(t);
  const finished = h.output.speak('你好。', voice);
  await flush();
  assert.equal(h.requests.length, 1, 'synthesis is dispatched while the device starts (R02), no new wait');
  const id = h.requests[0];
  await h.w.advance(300);
  h.emit(id, h.audioChunk(true)); h.emit(id, h.audioChunk()); h.emit(id, h.audioChunk());
  await h.w.advance(100);
  assert.equal(h.w.contexts[0].state, 'suspended', 'the device is still starting');
  h.emit(id, { type: 'error', message: '语音已停止。', cancelled: true }); // the host stopped this reading
  await flush();
  const phaseAtCancel = h.states.at(-1)?.phase;
  await h.w.advance(3000); // the device runs at 2 s; nothing of the cancelled reading may reach it
  assert.equal(h.w.contexts[0].state, 'running');
  assert.equal(h.starts(), 0, 'zero source.start after the cancel (was one: seq4 cancel -> seq5 start -> seq7 stop)');
  assert.equal(phaseAtCancel, 'idle', 'stopped as soon as the cancel arrived, not after the queued PCM');
  await finished;
  assert.equal(h.speaking.some(Boolean), false, 'the mouth never moved');
  assert.deepEqual(h.errors, [], 'a cancel is not an error');
});

test('cancel while the device starts: the same holds for a whole reply on the R02 path', LIMIT, async t => {
  const h = harness(t);
  const playback = h.output.openReply(voice, 'reply-1')!;
  void playback.append('第一句。', { replyId: 'reply-1', segmentIndex: 0 }).catch(() => false);
  const finished = playback.close();
  await flush();
  const id = h.requests[0];
  assert.ok(id);
  await h.w.advance(300);
  h.emit(id, h.audioChunk(true)); h.emit(id, h.audioChunk());
  h.emit(id, { type: 'error', message: '语音已停止。', cancelled: true });
  await flush();
  await h.w.advance(3000);
  assert.equal(h.starts(), 0);
  await finished;
  assert.equal(h.speaking.some(Boolean), false);
});

test('cancel (guarded): a stale cancel for an older request changes nothing, and an uncancelled reading plays at once', LIMIT, async t => {
  const h = harness(t);
  const finished = h.output.speak('你好。', voice);
  await flush();
  const id = h.requests[0];
  h.emit('cancel-old', { type: 'error', message: '语音已停止。', cancelled: true });
  await h.w.advance(300);
  h.emit(id, h.audioChunk(true)); h.emit(id, h.audioChunk()); h.emit(id, h.audioChunk());
  h.emit(id, { type: 'done', firstAudioMs: 300, audioBytes: 3 * 9600 });
  await h.w.advance(1800);
  assert.equal(h.starts() > 0, true, 'scheduled once the device runs');
  await h.w.advance(1500);
  await finished;
  assert.equal(h.speaking.includes(true), true, 'heard');
  assert.deepEqual(h.errors, []);
});
