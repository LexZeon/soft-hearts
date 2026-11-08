import test from 'node:test';
import { DEFAULT_TTS_CONFIG, type TtsConfig } from '../shared/tts';
import assert from 'node:assert/strict';
import { SpeechRuntime, SPEECH_ROUTE_LEASE_MS } from '../electron/speech-runtime';
import { SpeakingOwners, SPEAKING_OWNER_LEASE_MS } from '../electron/speaking-owners';
import { AudioReadingHostBroker } from '../electron/audio-reading-host-broker';
import { AmbientAudioSegments } from '../src/ui/ambient-audio-segments';
import { MediaInput, SPEAKING_MAX_MS } from '../src/ui/MediaInput';
import { PauseGuard } from '../electron/pause-guard';
import { ListenTally } from '../electron/listen-tally';
import { buildJournalEntry } from '../shared/journal';

// Everything that pauses listening while she speaks must let go again, however the reading ended.

class FakeTimers {
  now = 0; private next = 1; readonly pending = new Map<number, { at: number; run(): void }>();
  set = (run: () => void, ms: number) => { const id = this.next++; this.pending.set(id, { at: this.now + ms, run }); return id; };
  clear = (id: unknown) => { this.pending.delete(id as number); };
  advance(ms: number) {
    this.now += ms;
    for (const [id, item] of [...this.pending]) if (item.at <= this.now) { this.pending.delete(id); item.run(); }
  }
}
const tts: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'r', apiKey: 'k' };

test('a finished synthesis whose reading is never released lets go by itself (it paused listening for good)', async () => {
  const timers = new FakeTimers(), expired: string[] = [];
  const runtime = new SpeechRuntime(() => tts, () => {}, async (_c, _t, _s, emit) => { await emit({ type: 'done', firstAudioMs: 1, audioBytes: 1 } as never); },
    undefined, { expired: recipient => { expired.push(recipient.id); }, setTimer: timers.set, clearTimer: timers.clear });
  await speakWithFakeConfig(runtime, 'a1');
  assert.equal(runtime.busy, true, 'the renderer may still be playing the last audio');
  timers.advance(SPEECH_ROUTE_LEASE_MS - 1);
  assert.equal(runtime.busy, true);
  timers.advance(2);
  assert.equal(runtime.busy, false);
  assert.deepEqual(expired, ['a1']);
});

test('a normal release before the deadline cancels the deadline', async () => {
  const timers = new FakeTimers(), expired: string[] = [];
  const runtime = new SpeechRuntime(() => tts, () => {}, async (_c, _t, _s, emit) => { await emit({ type: 'done', firstAudioMs: 1, audioBytes: 1 } as never); },
    undefined, { expired: recipient => { expired.push(recipient.id); }, setTimer: timers.set, clearTimer: timers.clear });
  await speakWithFakeConfig(runtime, 'a2');
  assert.equal(runtime.release(5, 'a2'), true);
  timers.advance(SPEECH_ROUTE_LEASE_MS * 2);
  assert.deepEqual(expired, []);
  assert.equal(timers.pending.size, 0);
});

test('a newer reading replaces the old deadline, a cancelled one clears it', async () => {
  const timers = new FakeTimers(), expired: string[] = [];
  const runtime = new SpeechRuntime(() => tts, () => {}, async (_c, _t, _s, emit) => { await emit({ type: 'done', firstAudioMs: 1, audioBytes: 1 } as never); },
    undefined, { expired: recipient => { expired.push(recipient.id); }, setTimer: timers.set, clearTimer: timers.clear });
  await speakWithFakeConfig(runtime, 'b1');
  timers.advance(SPEECH_ROUTE_LEASE_MS - 1000);
  await speakWithFakeConfig(runtime, 'b2');
  timers.advance(5000);
  assert.deepEqual(expired, [], 'the first reading no longer owns a deadline');
  runtime.cancel(5, 'b2');
  assert.equal(runtime.busy, false);
  timers.advance(SPEECH_ROUTE_LEASE_MS * 2);
  assert.deepEqual(expired, []);
});

test('the window-side flag "she is speaking" expires without a refresh, and says so once', () => {
  const timers = new FakeTimers(), expired: number[] = [];
  const owners = new SpeakingOwners({ expired: owner => { expired.push(owner); }, setTimer: timers.set, clearTimer: timers.clear });
  owners.add(7);
  assert.equal(owners.size, 1);
  timers.advance(SPEAKING_OWNER_LEASE_MS - 1000);
  owners.add(7); // the window refreshes it with each sentence
  timers.advance(SPEAKING_OWNER_LEASE_MS - 1000);
  assert.equal(owners.size, 1);
  timers.advance(2000);
  assert.equal(owners.size, 0);
  assert.deepEqual(expired, [7]);
  owners.add(8); owners.delete(8);
  timers.advance(SPEAKING_OWNER_LEASE_MS * 2);
  assert.deepEqual(expired, [7]);
});

test('the microphone window does not stay deaf: "speaking" without a refresh expires', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const signals: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { desktop: {
    openVoiceCapture: async () => ({ captureSessionId: 'capture', epoch: 'epoch' }),
    signalVoiceCapture: async (_id: string, signal: string) => { signals.push(signal); return true; },
    submitVoicePcm: async () => ({ state: 'queued', groupId: 'g', segmentId: 's', captureSeq: 1 }),
  } } });
  const statuses: string[] = [];
  const media = new MediaInput({ windowKind: 'controls', onTranscript() {}, onError() {}, onVoiceStatus: text => statuses.push(text) });
  const realNow = performance.now.bind(performance);
  let offset = 0;
  performance.now = () => realNow() + offset;
  try {
    await media.applyRuntime({ voiceInput: true, voiceOwner: 'controls', screenSharing: false, cameraSharing: false, cameraOwner: null });
    media.microphoneReady(true);
    media.setSpeaking(true);
    const chunk = new Float32Array(4096).fill(0.001);
    media.pushVoicePcm(chunk, 16000);
    assert.match(statuses.at(-1) ?? '', /朗读期间|paused during/);
    offset += SPEAKING_MAX_MS + 1000;
    media.pushVoicePcm(chunk, 16000);
    assert.doesNotMatch(statuses.at(-1) ?? '', /朗读期间|paused during/, 'listening again');
    assert.ok(signals.includes('pause-stuck'), 'and the host is told, for the journal');
  } finally {
    performance.now = realNow; media.dispose();
    if (saved) Object.defineProperty(globalThis, 'window', saved); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('the system-audio segmenter does not stay deaf either', () => {
  let now = 0;
  const seen: number[] = [];
  const segments = new AmbientAudioSegments<number>({ now: () => now, onSegment: async () => 1, onAccepted: value => seen.push(value) });
  segments.setSpeaking(true);
  assert.equal(segments.state.pausedForTts, true);
  now += 6 * 60_000;
  assert.equal(segments.state.pausedForTts, false, 'a "speaking" nobody refreshed for minutes is not speaking');
});

test('listen-together counts what happens to every clip, numbers only', async () => {
  const tally: string[] = [];
  const texts = ['歌词一句', '', '另一句'];
  const broker = new AudioReadingHostBroker('scope', { acquire: async () => ({ captureId: 'c', release: async () => {} }),
    transcribe: async () => ({ text: texts.shift() ?? '' }), publicationReady: ticket => { ticket.discard(); return undefined; },
    tally: kind => { tally.push(kind); } });
  await broker.setIntent('system-audio', 'music', true); await broker.settled();
  const token = broker.currentCapture('system-audio'); assert.ok(token);
  const clip = (sequence: number) => ({ sequence, startedAtMs: sequence * 2000, pcm16: new ArrayBuffer(32_000) });
  assert.equal(broker.submitSegment(token, clip(1)).accepted, true); await broker.settled();
  assert.equal(broker.submitSegment(token, clip(2)).accepted, true); await broker.settled();
  broker.setPaused('system-audio', true);
  assert.equal(broker.submitSegment(token, clip(3)).reason, 'paused');
  broker.setPaused('system-audio', false);
  assert.equal(broker.submitSegment(token, clip(4)).accepted, true); await broker.settled();
  const count = (kind: string) => tally.filter(value => value === kind).length;
  assert.deepEqual([count('received'), count('with-text'), count('empty'), count('skipped-paused'), count('failed')], [3, 2, 1, 1, 0], tally.join());
});

test('whatever the cause, a pause that outlasts speaking is let go, once, and trusted again after one real break', () => {
  let forced = 0;
  const guard = new PauseGuard(() => { forced++; }, 10 * 60_000);
  assert.equal(guard.observe(true, 0), true);
  assert.equal(guard.observe(true, 9 * 60_000), true);
  assert.equal(guard.observe(true, 10 * 60_000 + 1), false);
  assert.equal(guard.observe(true, 11 * 60_000), false, 'stays let go while the raw condition never changes');
  assert.equal(forced, 1);
  assert.equal(guard.observe(false, 12 * 60_000), false);
  assert.equal(guard.observe(true, 13 * 60_000), true, 'a new pause is a new pause');
  assert.equal(forced, 1);
});

test('the per-minute listen-together line is counts only and says nothing in a quiet minute', () => {
  const tally = new ListenTally();
  assert.equal(tally.take(), null);
  for (const kind of ['received', 'received', 'skipped-paused', 'with-text', 'empty'] as const) tally.add(kind);
  assert.deepEqual(tally.take(), { received: 2, skippedPaused: 1, withText: 1, empty: 1, failed: 0 });
  assert.equal(tally.take(), null);
});

test('the journal keeps the two new lines as numbers and a closed kind, and refuses anything else', () => {
  const ok = buildJournalEntry({ type: 'listen-tally', characterId: 'c', received: 3, skippedPaused: 2, withText: 0, empty: 1, failed: 0 } as never, 1_000);
  assert.ok(ok && ok.type === 'listen-tally');
  assert.equal(buildJournalEntry({ type: 'listen-tally', characterId: 'c', received: -1, skippedPaused: 0, withText: 0, empty: 0, failed: 0 } as never, 1_000), null);
  assert.ok(buildJournalEntry({ type: 'pause-stuck', characterId: 'c', what: 'speech-route' } as never, 1_000));
  assert.equal(buildJournalEntry({ type: 'pause-stuck', characterId: 'c', what: '她说的话' } as never, 1_000), null);
});

async function speakWithFakeConfig(runtime: SpeechRuntime, id: string) {
  await runtime.speak(5, id, '你好呀。');
}
