import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import type { FeedCueKind } from '../shared/feed-cue';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent, type VoiceOutputPlaybackState } from '../src/ui/VoiceOutput';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { FeedCuePlayer } from '../src/ui/feed-cue-player';
import { FeedCuePrefetch, feedCueVoiceKey } from '../src/ui/feed-cue-prefetch';
import { flush, pcm } from './helpers/r02-audio-world';
import { pauseAudioWorld } from './helpers/feed-pause-audio';

/*
 * B06 (Track V follow-up): the first "啊" was usually skipped because the cue is
 * fetched only when a snack is picked up and Bailian's first audio takes ~1.2 s.
 * Once a reply plays aloud in the Bailian voice, both cues are fetched ahead.
 */
const bailian: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
const playing = (replyId?: string, provider: TtsConfig['provider'] = 'bailian') => ({ phase: 'playing', provider, ...(replyId ? { replyId } : {}) });

function gate(initial: TtsConfig = bailian) {
  const state = { config: initial, voiceOn: true, prefetches: 0 };
  const prefetch = new FeedCuePrefetch({ prefetch: () => { state.prefetches++; }, getTtsConfig: () => state.config, voiceOn: () => state.voiceOn });
  return { state, prefetch };
}

test('B06 prefetch: armed only by a reply playing aloud in the Bailian voice with read-aloud on', () => {
  const g = gate();
  g.prefetch.voiceContextChanged();
  g.prefetch.playback({ phase: 'loading', provider: 'bailian', replyId: 'r1' });
  g.prefetch.playback(playing()); // a voice preview has no reply
  g.prefetch.playback(playing('r1', 'system'));
  g.prefetch.playback(null);
  assert.equal(g.state.prefetches, 0); assert.equal(g.prefetch.active, false);
  g.state.voiceOn = false;
  g.prefetch.playback(playing('r1'));
  assert.equal(g.state.prefetches, 0, 'read-aloud off: never a paid call');
  g.state.voiceOn = true; g.state.config = { ...bailian, provider: 'system' };
  g.prefetch.playback(playing('r1'));
  assert.equal(g.state.prefetches, 0, 'the provider is no longer Bailian');
  g.state.config = bailian;
  g.prefetch.playback(playing('r1'));
  assert.equal(g.state.prefetches, 1); assert.equal(g.prefetch.active, true);
  g.prefetch.playback(playing('r1')); g.prefetch.playback(playing('r1'));
  assert.equal(g.state.prefetches, 1, 'once per reply, not per playback state');
  g.prefetch.playback(playing('r2'));
  assert.equal(g.state.prefetches, 2, 'a later reply asks again; the player cache and back-off decide');
});

test('B06 prefetch: after the first reply, a new voice (voice, model, rate) is warmed while read-aloud is on', () => {
  const g = gate();
  g.prefetch.playback(playing('r1'));
  assert.equal(g.state.prefetches, 1);
  g.prefetch.voiceContextChanged();
  assert.equal(g.state.prefetches, 1, 'an unrelated settings change asks nothing');
  for (const change of [{ voice: 'another' }, { model: 'another-model' }, { rate: 1.2 }] as Partial<TtsConfig>[]) {
    g.state.config = { ...g.state.config, ...change };
    g.prefetch.voiceContextChanged();
  }
  assert.equal(g.state.prefetches, 4);
  g.state.voiceOn = false; g.state.config = { ...g.state.config, voice: 'while-off' };
  g.prefetch.voiceContextChanged();
  assert.equal(g.state.prefetches, 4, 'read-aloud off: nothing');
  g.state.voiceOn = true;
  g.prefetch.voiceContextChanged();
  assert.equal(g.state.prefetches, 5, 'read-aloud back on with a new voice: warmed');
  g.state.config = { ...g.state.config, provider: 'system' };
  g.prefetch.voiceContextChanged();
  assert.equal(g.state.prefetches, 5, 'system voice: nothing');
  assert.notEqual(feedCueVoiceKey(bailian), feedCueVoiceKey({ ...bailian, rate: 1.1 }));
  assert.equal(feedCueVoiceKey(bailian), feedCueVoiceKey({ ...bailian, apiKey: 'other', instruction: 'x' }), 'the key and reply style are not part of the cue voice');
});

/** A pet window's reply voice and cue player, wired as src/main.ts does. */
function petWindow(t: TestContext, options: { cueFails?: boolean } = {}) {
  const w = pauseAudioWorld(t);
  // The cue player's own clock (failure back-off); the audio world keeps the reply's.
  const clock = { now: 0 };
  const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
  let config: TtsConfig = bailian, listener: ((event: VoiceOutputEvent) => void) | null = null, ids = 0;
  const log: string[] = [], requests: string[] = [];
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const cueAudio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const cues = new FeedCuePlayer({
    api: { async synthesizeFeedCue(kind: FeedCueKind) { log.push(`cue:${kind}@${w.now()}`); return options.cueFails ? null : { pcm: Buffer.alloc(24 * 400 * 2).toString('base64') }; } },
    getTtsConfig: () => config, getVoiceConfig: () => voice, audio: cueAudio, timers: w.timers, now: () => clock.now });
  const prefetch = new FeedCuePrefetch({ prefetch: () => cues.prefetch(), getTtsConfig: () => config, voiceOn: () => voice.enabled });
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id) { requests.push(id); log.push(`speech@${w.now()}`); },
      async cancelSpeech() {}, async releaseSpeech() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
    },
    onSpeaking: value => log.push(`speaking:${value}@${w.now()}`), onError: message => log.push(`error:${message}`),
    onState: (state: VoiceOutputPlaybackState) => { log.push(`state:${state.phase}${state.replyId ? `:${state.replyId}` : ''}@${w.now()}`); prefetch.playback(state); },
    createId: () => `req-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
    createSystem: () => ({ voices: () => [], speak: () => Promise.resolve(), stop() {} }),
  });
  const shown: ApprovedReplySpeechSegment[] = [];
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_replyId: string, completedIndex?: number) {
      const index = completedIndex === undefined ? 0 : completedIndex + 1;
      return shown[index] ?? null;
    },
    async cancelReplySpeech() {},
  }, async () => assert.fail('one playback owner'), () => voice.enabled, replyId => output.openReply({ ...voice }, replyId));
  t.after(() => { output.dispose(); cues.dispose(); audio.dispose(); cueAudio.dispose(); });
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index], ...event } as VoiceOutputEvent);
  return { w, clock, log, cues, prefetch, output, queue, voice, cueContexts: () => w.contexts.length,
    setConfig(next: TtsConfig) { config = next; prefetch.voiceContextChanged(); },
    reply(replyId: string, text: string) {
      shown.length = 0;
      shown.push(Object.freeze({ replyId, index: 0, text, visibleText: text, context: Object.freeze({ replyId, segmentIndex: 0 }) }));
      return queue.speak(replyId);
    },
    synthesize(index: number) {
      for (let i = 0; i < 3; i++) emit(index, { type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(i === 0 ? { firstAudioMs: 300 } : {}) });
      emit(index, { type: 'done', firstAudioMs: 300, audioBytes: 3 * 9600 });
    } };
}

test('B06 prefetch on the real reply voice: both cues are fetched once the reply is playing, and the first "啊" then starts at once', async t => {
  const p = petWindow(t);
  const done = p.reply('r1', '第一句。');
  await flush(); await p.w.advance(300);
  assert.ok(!p.log.some(entry => entry.startsWith('cue:')), 'nothing is fetched while the reply still waits for its first audio');
  p.synthesize(0); await flush(); await p.w.advance(5);
  const firstPlaying = p.log.findIndex(entry => entry.startsWith('state:playing:r1')), firstCue = p.log.findIndex(entry => entry.startsWith('cue:'));
  assert.ok(firstPlaying >= 0 && firstCue > firstPlaying, `cues are fetched after the reply is already playing (${p.log.join(' ')})`);
  assert.deepEqual(p.log.filter(entry => entry.startsWith('cue:')).map(entry => entry.split('@')[0]).sort(), ['cue:ah', 'cue:mm']);
  assert.equal(p.prefetch.active, true);
  const started = await p.cues.play('ah', 250);
  assert.ok(started, 'warm: the first "啊" at her mouth starts at once instead of being skipped');
  await p.w.advance(2000); await done;
  p.setConfig({ ...bailian, voice: 'next-character' });
  await flush(); await p.w.advance(5);
  assert.equal(p.log.filter(entry => entry.startsWith('cue:')).length, 4, 'a new voice is warmed right away');
  assert.ok(await p.cues.play('mm', 350), 'and its "嗯" is ready too');
});

test('B06 cue player without prefetch (control): the first "啊" is skipped because the clip is fetched only then', async t => {
  const p = petWindow(t);
  assert.equal(await p.cues.play('ah', 250), null);
});

test('B06 prefetch on the real reply voice: fetching never opens the cue audio device, and a failed fetch keeps its back-off', async t => {
  const p = petWindow(t, { cueFails: true });
  const before = p.cueContexts();
  p.cues.prefetch(); await flush(); await p.w.advance(5);
  assert.equal(p.cueContexts(), before, 'prefetch is a fetch only; no AudioContext is created for the cues');
  assert.equal(p.log.filter(entry => entry.startsWith('cue:')).length, 2);
  p.prefetch.playback(playing('r9')); await flush(); await p.w.advance(5);
  assert.equal(p.log.filter(entry => entry.startsWith('cue:')).length, 2, 'within the back-off nothing is asked again');
  p.clock.now += 60_000;
  p.prefetch.playback(playing('r10')); await flush(); await p.w.advance(5);
  assert.equal(p.log.filter(entry => entry.startsWith('cue:')).length, 4, 'after the back-off the next reply asks again');
  p.voice.enabled = false;
  p.prefetch.playback(playing('r11')); p.cues.prefetch(); await flush(); p.clock.now += 61_000;
  p.prefetch.playback(playing('r12')); await flush(); await p.w.advance(5);
  assert.equal(p.log.filter(entry => entry.startsWith('cue:')).length, 4, 'read-aloud off: never a paid call');
});
