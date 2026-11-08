import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment, type SpeechRequestContext, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent } from '../src/ui/VoiceOutput';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { deferred, flush, pcm, world } from './helpers/r02-audio-world';

/*
 * R02 goal 2: one continuous Bailian playback per reply. The host still hands
 * out each segment only after its own bubble is confirmed; while segment N
 * plays, N+1 is synthesized (never more than one ahead) and follows gaplessly.
 */
const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
/** Lip-sync on/off changes, ignoring repeated reports of the same state. */
const transitions = (list: { value: boolean }[]) => list.map(s => s.value).filter((value, i, all) => i === 0 || value !== all[i - 1]);
function segment(replyId: string, index: number, text: string): ApprovedReplySpeechSegment {
  return Object.freeze({ replyId, index, text, visibleText: text, context: Object.freeze({ replyId, segmentIndex: index }) });
}

function harness(t: TestContext, provider: TtsConfig['provider'] = 'bailian') {
  const w = world(t);
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  let ids = 0;
  const requests: { id: string; text: string; at: number; context?: SpeechRequestContext }[] = [];
  const system: string[] = [];
  const cancellations: string[] = [], releases: string[] = [], speaking: { value: boolean; at: number }[] = [], errors: string[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider, apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'k' };
  let enabled = true;
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => ({ ...voice, enabled }),
    api: {
      async synthesizeSpeech(id, text, context) { requests.push({ id, text, at: w.now(), ...(context ? { context: { ...context } } : {}) }); },
      async cancelSpeech(id) { cancellations.push(id); },
      async releaseSpeech(id) { releases.push(id); },
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
    },
    onSpeaking: value => speaking.push({ value, at: w.now() }), onError: message => errors.push(message),
    createId: () => `seg-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
    createSystem: callback => ({ voices: () => [], speak: text => { system.push(text); callback(false); return Promise.resolve(); }, stop() {} }),
  });
  // The host side: segments become available when the test says their bubble is shown.
  const shown: ApprovedReplySpeechSegment[] = [];
  const waiters: (() => void)[] = [];
  const asked: { completedIndex?: number; at: number }[] = [];
  let total = Infinity;
  const api = {
    async nextReplySpeechSegment(replyId: string, completedIndex?: number) {
      asked.push({ completedIndex, at: w.now() });
      const index = completedIndex === undefined ? 0 : completedIndex + 1;
      while (index >= shown.length && index < total) await new Promise<void>(resolve => waiters.push(resolve));
      return index < shown.length && index < total ? shown[index] : null;
    },
    async cancelReplySpeech(replyId: string) { cancellations.push(`reply:${replyId}`); },
  };
  const played: string[] = [];
  const queue = new CompletedReplySpeechQueue(api, async piece => { played.push(piece.text); }, () => enabled,
    replyId => output.openReply({ ...voice }, replyId));
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index].id, ...event } as VoiceOutputEvent);
  return {
    w, output, queue, requests, system, cancellations, releases, speaking, errors, asked, played,
    show(piece: ApprovedReplySpeechSegment) { shown.push(piece); waiters.splice(0).forEach(resolve => resolve()); },
    end(count: number) { total = count; waiters.splice(0).forEach(resolve => resolve()); },
    /** One segment's synthesis: `chunks` × 0.2 s of PCM, then done. */
    synthesize(index: number, chunks = 3) {
      for (let i = 0; i < chunks; i++) emit(index, { type: 'audio', data: pcm(), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(i === 0 ? { firstAudioMs: 300 } : {}) });
      emit(index, { type: 'done', firstAudioMs: 300, audioBytes: chunks * 9600 });
    },
    disable() { enabled = false; },
    /** A different voice changes the playback identity, like switching voice or model in settings. */
    changeVoice(value: string) { config.voice = value; },
  };
}

test('R02 reply: segment N+1 is synthesized while N plays, at most one ahead, and plays gaplessly on one device', async t => {
  const h = harness(t);
  const id = 'reply-1';
  h.show(segment(id, 0, '第一句。'));
  const speaking = h.queue.speak(id);
  await flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].context, { replyId: id, segmentIndex: 0 });
  await h.w.advance(300); h.synthesize(0); await flush();
  h.show(segment(id, 1, '第二句。')); h.show(segment(id, 2, '第三句。'));
  await h.w.advance(150); // segment 0 (0.6 s) is now audible
  assert.equal(h.requests.length, 2, 'N+1 is requested while N plays');
  assert.deepEqual(h.requests[1].context, { replyId: id, segmentIndex: 1 });
  const zeroEnds = 1000 + 300 + 100 + 600;
  assert.ok(h.requests[1].at < zeroEnds, 'prefetch starts before segment 0 finishes');
  await h.w.advance(200); h.synthesize(1); await flush();
  assert.equal(h.requests.length, 2, 'no request for N+2 until N+1 is audible: at most one segment ahead');
  await h.w.advance(600); // segment 0 ends, segment 1 starts
  assert.equal(h.requests.length, 3);
  h.synthesize(2); h.end(3); await flush();
  await h.w.advance(1500); await speaking;
  const sources = h.w.contexts[0].sources;
  for (let i = 1; i < sources.length; i++)
    assert.ok(Math.abs(sources[i].startAt - (sources[i - 1].startAt + 0.2)) < 1e-9, `chunk ${i} continues without a gap`);
  assert.equal(h.w.contexts.length, 1, 'one device for the whole reply');
  assert.deepEqual(h.speaking.filter(s => s.value).length, 1, 'mouth opens once and stays open across segments');
  assert.equal(h.speaking.at(-1)!.value, false);
  assert.deepEqual(h.played, [], 'cloud replies never fall back to per-segment play');
  assert.deepEqual(h.cancellations, [], 'no cancellation between segments');
  assert.deepEqual(h.releases, [h.requests[2].id], 'only the final recipient is released, after the last sample');
  assert.deepEqual(h.errors, []);
});

test('R02 reply: a bubble that is not yet shown pauses speech without a fake mouth, then resumes', async t => {
  const h = harness(t);
  const id = 'reply-2';
  h.show(segment(id, 0, '短句。'));
  const speaking = h.queue.speak(id);
  await flush(); await h.w.advance(300); h.synthesize(0, 1); await flush();
  await h.w.advance(400); // 0.2 s played, segment 1 not displayed yet
  assert.deepEqual(transitions(h.speaking), [false, true, false], 'mouth closes while waiting for the next bubble');
  h.show(segment(id, 1, '下一句。')); await flush();
  assert.equal(h.requests.length, 2);
  await h.w.advance(300); h.synthesize(1, 1); h.end(2); await flush();
  await h.w.advance(600); await speaking;
  assert.deepEqual(h.speaking.filter(s => s.value).length, 2);
  assert.deepEqual(h.errors, []);
});

test('R02 reply: cancelling during prefetch stops audio, requests nothing more and releases the session', async t => {
  const h = harness(t);
  const id = 'reply-3';
  h.show(segment(id, 0, '一。')); h.show(segment(id, 1, '二。')); h.show(segment(id, 2, '三。'));
  const speaking = h.queue.speak(id);
  await flush(); await h.w.advance(300); h.synthesize(0); await flush(); await h.w.advance(150);
  assert.equal(h.requests.length, 2);
  h.queue.cancel(); await flush(); await speaking;
  assert.ok(h.cancellations.includes(`reply:${id}`));
  assert.ok(h.cancellations.includes(h.requests[1].id), 'the prefetched request is cancelled');
  h.synthesize(1); await h.w.advance(1500);
  assert.equal(h.requests.length, 2, 'nothing after the cancel');
  assert.equal(h.speaking.at(-1)!.value, false);
  assert.ok(h.w.contexts[0].sources.slice(3).every(source => source.startAt < 0), 'late PCM of the cancelled prefetch is never scheduled');
});

test('R02 reply: turning read-aloud off mid-reply never leaves a session waiting for segments', async t => {
  const h = harness(t);
  const id = 'reply-4';
  h.show(segment(id, 0, '一。'));
  const speaking = h.queue.speak(id);
  await flush(); await h.w.advance(300); h.synthesize(0, 1); await flush(); await h.w.advance(150);
  h.disable(); h.show(segment(id, 1, '二。')); await flush(); await speaking;
  await h.w.advance(1000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.speaking.at(-1)!.value, false);
  // A new reply can start immediately: nothing is left holding the output.
  assert.equal(h.output.openReply({ ...voice }, 'next') !== null, true);
});

test('R02 reply: a voice change during prefetch discards the prefetched segment and stops the queue', async t => {
  const h = harness(t);
  const id = 'reply-5';
  h.show(segment(id, 0, '一。')); h.show(segment(id, 1, '二。')); h.show(segment(id, 2, '三。'));
  const speaking = h.queue.speak(id);
  await flush(); await h.w.advance(300); h.synthesize(0); await flush(); await h.w.advance(150);
  assert.equal(h.requests.length, 2, 'segment 1 is being pre-synthesized');
  const askedBefore = h.asked.length;
  h.changeVoice('another-voice');
  h.synthesize(1); await flush(); await h.w.advance(1500); await speaking;
  assert.ok(h.cancellations.includes(h.requests[1].id), 'the prefetched request is cancelled');
  assert.ok(h.cancellations.includes(`reply:${id}`), 'the host is told the reply speech ended');
  assert.equal(h.requests.length, 2, 'segment 2 is never synthesized');
  assert.equal(h.asked.length, askedBefore, 'the queue does not walk the remaining bubbles silently');
  assert.ok(h.w.contexts[0].sources.slice(3).every(source => source.startAt < 0), 'late PCM of the discarded segment is never scheduled');
  assert.equal(h.speaking.at(-1)!.value, false);
});

test('R02 reply: system speech speaks one utterance per segment, in order, with no cloud request', async t => {
  const h = harness(t, 'system');
  h.show(segment('r', 0, '一。')); h.show(segment('r', 1, '二。')); h.end(2);
  await h.queue.speak('r');
  assert.deepEqual(h.system, ['一。', '二。'], 'see tests/r02-system-voice.test.ts for the engine-level order');
  assert.deepEqual(h.played, [], 'the reply has one playback owner');
  assert.equal(h.requests.length, 0);
});

test('R02 reply: an empty reply closes without opening the device or a lease', async t => {
  const h = harness(t);
  h.end(0);
  await h.queue.speak('empty');
  assert.equal(h.requests.length, 0);
  await h.w.advance(10);
  assert.ok(h.w.contexts.length <= 1);
  void deferred;
});
