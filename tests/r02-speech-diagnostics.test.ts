import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_TTS_CONFIG, type ApprovedReplySpeechSegment, type TtsConfig, type TtsStreamEvent } from '../shared/tts';
import { validateSpeechDiagnosticRecord, type SpeechDiagnosticRecord } from '../shared/speech-diagnostics';
import { SpeechDiagnosticsLog, SPEECH_DIAGNOSTICS_PER_MINUTE } from '../electron/speech-diagnostics';
import { StreamingVoicePlayer, formatSpeechStages } from '../src/ui/EmotionalVoice';
import { VoiceOutput, type VoiceOutputEvent, type VoiceOutputPlaybackState } from '../src/ui/VoiceOutput';
import { SharedAudioOutput } from '../src/ui/audio-output';
import { SpeechOutput } from '../src/ui/speech';
import { CompletedReplySpeechQueue } from '../src/ui/completed-reply-speech-queue';
import { flush, pcm, world } from './helpers/r02-audio-world';
import { engine } from './helpers/r02-speech-engine';

/*
 * R02 goal 4 (and the Codex X-032 review of goal 1): per-stage timings of one
 * playback on ONE renderer clock, host durations carried as durations, and a
 * developer-mode JSONL record without any text.
 */
const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
const piece = (index: number, text: string): ApprovedReplySpeechSegment =>
  Object.freeze({ replyId: 'r', index, text, visibleText: text, context: Object.freeze({ replyId: 'r', segmentIndex: index }) });

function cloud(t: TestContext, options: { deviceStartMs?: number } = {}) {
  const w = world(t, options);
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  const requests: string[] = [], records: SpeechDiagnosticRecord[] = [], speaking: { value: boolean; at: number }[] = [];
  const states: VoiceOutputPlaybackState[] = [];
  const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://synthetic.invalid', region: 'x', apiKey: 'k' };
  const audio = new SharedAudioOutput({ createContext: w.createContext, now: w.now, timers: w.timers });
  let ids = 0;
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id) { requests.push(id); }, async cancelSpeech() {}, async releaseSpeech() {},
      onSpeechEvent(callback) { listener = callback; return () => { listener = null; }; },
      async recordSpeechDiagnostic(record) { records.push(record); },
    },
    onSpeaking: value => speaking.push({ value, at: w.now() }), onError: message => assert.fail(message), onState: state => states.push(state),
    createId: () => `id-${++ids}`, audio, now: w.now,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, now: w.now, timers: w.timers }),
  });
  t.after(() => { output.dispose(); audio.dispose(); });
  const emit = (index: number, event: TtsStreamEvent) => listener?.({ id: requests[index], ...event } as VoiceOutputEvent);
  return { w, output, requests, records, speaking, states, emit,
    synthesize(index: number, chunks = 3, hostFirstAudioMs = 300, frames = 4800) {
      for (let i = 0; i < chunks; i++) emit(index, { type: 'audio', data: pcm(frames), format: 'pcm_s16le', sampleRate: 24000, channels: 1, ...(i === 0 ? { firstAudioMs: hostFirstAudioMs } : {}) });
      emit(index, { type: 'done', firstAudioMs: hostFirstAudioMs, audioBytes: chunks * frames * 2 });
    } };
}

test('R02 diagnostics: a Bailian reply records each segment on one clock, with the host network as a duration and no text', async t => {
  const h = cloud(t, { deviceStartMs: 50 });
  h.output.prewarm(); // chat sent
  const sentAt = h.w.now();
  await h.w.advance(1000); // the reply is being generated
  const pieces = [piece(0, '第一句。'), piece(1, '第二句。')];
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completed) { return pieces[completed === undefined ? 0 : completed + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async () => assert.fail('one playback owner'), () => true, id => h.output.openReply(voice, id));
  const done = queue.speak('r');
  await flush(); await h.w.advance(300); h.synthesize(0, 3, 280); await flush();
  await h.w.advance(150); // segment 0 audible; segment 1 requested
  await h.w.advance(100); h.synthesize(1, 2, 90); await flush();
  await h.w.advance(1500); await done;
  assert.equal(h.records.length, 2);
  for (const record of h.records) assert.deepEqual(validateSpeechDiagnosticRecord(JSON.parse(JSON.stringify(record))), record, 'the host accepts the record unchanged');
  assert.ok(!JSON.stringify(h.records).includes('句'), 'no text');
  const [first, second] = h.records;
  assert.equal(first.provider, 'bailian'); assert.equal(first.voice, DEFAULT_TTS_CONFIG.voice);
  assert.equal(first.kind, 'reply'); assert.equal(first.segmentIndex, 0); assert.equal(first.textLength, 4); assert.equal(first.outcome, 'ended');
  const order = ['queued', 'request', 'firstPacket', 'scheduled', 'playbackStart', 'ended'] as const;
  for (let i = 1; i < order.length; i++) assert.ok(first.t[order[i]]! >= first.t[order[i - 1]]!, `${order[i]} after ${order[i - 1]}`);
  assert.equal(first.t.firstPacket! - first.t.request!, 300, 'renderer invoke → first PCM arrival, on the renderer clock');
  assert.equal(first.hostFirstAudioMs, 280, 'the host network time stays a host duration, not an absolute time');
  assert.equal(first.deviceColdStartMs, 50, 'the device start at chat send is measured');
  assert.equal(first.t.scheduled! - first.t.firstPacket!, 0);
  assert.equal(first.startLeadMs, 100, 'bounded first-chunk lead');
  assert.equal(first.t.playbackStart! - first.t.scheduled!, 100);
  assert.ok(first.t.lipSyncStart! >= first.t.playbackStart!, 'the mouth never opens before the first sample is reached');
  assert.equal(first.sendToFirstAudioMs, 1000 + 300 + 100, 'send → audible');
  assert.equal(first.baseLatencyMs, 0); assert.equal(first.outputLatencyMs, 0);
  assert.equal(second.segmentIndex, 1); assert.equal(second.hostFirstAudioMs, 90);
  assert.equal(second.sendToFirstAudioMs, null, 'only the reply’s first audio is measured from the send');
  assert.equal(second.interSegmentGapMs, 0, 'pre-synthesized segment 1 follows segment 0 without a gap');
  assert.ok(sentAt < h.w.now());
  const stages = h.states.at(-1)!.stages!;
  assert.equal(stages.requestToPacketMs, 300); assert.equal(stages.hostFirstAudioMs, 280); assert.equal(stages.scheduledToAudibleMs, 100);
  assert.match(formatSpeechStages(stages), /请求→首包 300（主进程网络 280）.*排程→出声 100/);
});

test('X-088: a segment whose audio drains before its network "done" ends at the drain, so the real gap to the next segment is recorded', async t => {
  const h = cloud(t);
  const pieces = [piece(0, '第一句。'), piece(1, '第二句。')];
  const queue = new CompletedReplySpeechQueue({
    async nextReplySpeechSegment(_id, completed) { return pieces[completed === undefined ? 0 : completed + 1] ?? null; },
    async cancelReplySpeech() {},
  }, async () => assert.fail('one playback owner'), () => true, id => h.output.openReply(voice, id));
  const done = queue.speak('r');
  await flush(); await h.w.advance(300);
  const audio = { type: 'audio', format: 'pcm_s16le', sampleRate: 24000, channels: 1 } as const;
  for (let i = 0; i < 3; i++) h.emit(0, { ...audio, data: pcm(4800), ...(i === 0 ? { firstAudioMs: 200 } : {}) });
  await flush();
  await h.w.advance(1150); // 0.6 s of audio: audible after the 100 ms lead, drained ~700 ms in; the stream has not said "done" yet
  h.emit(0, { type: 'done', firstAudioMs: 200, audioBytes: 3 * 4800 * 2 });
  await flush(); await h.w.advance(100); h.synthesize(1, 2, 90); await flush();
  await h.w.advance(1500); await done;
  const first = h.records.find(record => record.segmentIndex === 0)!, second = h.records.find(record => record.segmentIndex === 1)!;
  assert.equal(first.outcome, 'ended');
  assert.equal(first.stalls, 0, 'the drain was the end of the segment, not an underrun');
  const heard = first.t.ended! - first.t.playbackStart!;
  assert.ok(heard >= 595 && heard <= 610, `ended at the drain (0.6 s after it became audible), not when the whole reply finished (${heard})`);
  assert.ok(second.interSegmentGapMs !== null && second.interSegmentGapMs >= 500, `a real gap is reported (${second.interSegmentGapMs})`);
});

test('R02 diagnostics: a bogus multi-second reported output latency is recorded raw but does not hold the mouth closed', async t => {
  const h = cloud(t);
  h.output.prewarm(); await h.w.advance(9000);
  const context = h.w.contexts[0] as unknown as { outputLatency: number; currentTime: number; getOutputTimestamp?: () => AudioTimestamp };
  context.outputLatency = 8;
  context.getOutputTimestamp = () => ({ contextTime: context.currentTime - 8, performanceTime: h.w.now() - 8000 });
  const spoken = h.output.speak('你好。', voice, { replyId: 'x' });
  // One long 3 s chunk, so no early buffer end can prove the clock passed the first sample.
  await flush(); await h.w.advance(300); h.synthesize(0, 1, 300, 72000); await flush();
  const firstPacketAt = h.w.now();
  await h.w.advance(700);
  const opened = h.speaking.find(item => item.value);
  assert.ok(opened && opened.at - firstPacketAt <= 100 + 500 + 50, 'the mouth opens within the 0.5 s latency cap, not 8 s later');
  await h.w.advance(3000); await spoken;
  const record = h.records.at(-1)!;
  assert.equal(record.outputLatencyMs, 8000, 'the raw report is kept for the user’s next real run');
  assert.equal(record.clockLagMs, 8000);
  assert.equal(record.kind, 'reply'); assert.equal(record.segmentIndex, null);
});

test('R02 diagnostics: system voice records engine start, first boundary, lip-sync, stalls, gaps and error codes', async t => {
  const e = engine(t);
  const records: SpeechDiagnosticRecord[] = [];
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG, provider: 'system' }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() {}, async cancelSpeech() {}, onSpeechEvent: () => () => {}, async recordSpeechDiagnostic(record) { records.push(record); } },
    onSpeaking: () => {}, onError: () => {}, now: e.now,
    createSystem: (callback, hooks) => new SpeechOutput(callback, { ...hooks, timers: e.timers, now: e.now }),
  });
  t.after(() => output.dispose());
  const reply = output.openReply({ ...voice, voiceURI: 'Microsoft Xiaoxiao' }, 'r')!;
  const first = reply.append('一段话。', { replyId: 'r', segmentIndex: 0 });
  await flush(); await e.advance(20);
  e.start(e.queued[0]); await first;
  await e.advance(30); e.queued[0].onboundary?.();
  e.synth.speaking = false; await e.advance(1000); // stall: the mouth closes
  e.synth.speaking = true; e.queued[0].onboundary?.();
  await e.advance(200);
  const second = reply.append('第二段。', { replyId: 'r', segmentIndex: 1 });
  e.end(e.queued[0]); await flush();
  await e.advance(40); e.start(e.queued[1]); await second;
  e.queued[1].onerror?.({ error: 'synthesis-failed' }); await flush();
  await reply.close();
  assert.equal(records.length, 2);
  const [a, b] = records;
  assert.equal(a.provider, 'system'); assert.equal(a.voice, 'Microsoft Xiaoxiao'); assert.equal(a.outcome, 'ended');
  assert.equal(a.t.playbackStart! - a.t.request!, 20, 'utterance handed to the engine → engine start');
  assert.equal(a.t.firstBoundary! - a.t.playbackStart!, 30);
  assert.equal(a.stalls, 1);
  assert.ok(a.t.lipSyncStart !== undefined && a.t.lipSyncStop! >= a.t.lipSyncStart!);
  assert.equal(b.interSegmentGapMs, 40, 'previous end → next engine start');
  assert.equal(b.outcome, 'error'); assert.equal(b.errorCode, 'synthesis-failed');
  for (const record of records) assert.deepEqual(validateSpeechDiagnosticRecord(JSON.parse(JSON.stringify(record))), record);
});

test('R02 diagnostics: the host writes only validated records, only in developer mode, bounded per minute', () => {
  let developer = false, now = 0;
  const lines: { file: string; line: string }[] = [];
  const log = new SpeechDiagnosticsLog({ enabled: () => developer, file: () => '/profile/soft-hearts-claude/dev/speech-events.jsonl',
    now: () => now, wallNow: () => Date.UTC(2026, 10, 2), write: async (file, line) => { lines.push({ file, line }); } });
  const record: SpeechDiagnosticRecord = { v: 1, provider: 'bailian', voice: 'longanlingxin_v3.1', kind: 'reply', segmentIndex: 0, textLength: 12,
    outcome: 'ended', errorCode: null, t: { queued: 0, request: 3, firstPacket: 1290, playbackStart: 1400, ended: 3000 }, hostFirstAudioMs: 1281,
    baseLatencyMs: 10, outputLatencyMs: 40, clockLagMs: 50, startLeadMs: 100, deviceColdStartMs: null, sendToFirstAudioMs: 5200,
    interSegmentGapMs: null, stalls: 0, quickEnd: false };
  assert.equal(log.record(record), false, 'developer mode off: nothing is written');
  developer = true;
  assert.equal(log.record(record), true);
  assert.equal(lines[0].file, '/profile/soft-hearts-claude/dev/speech-events.jsonl');
  assert.deepEqual(JSON.parse(lines[0].line), { at: '2026-11-02T00:00:00.000Z', ...record });
  assert.equal(log.record({ ...record, text: '你好' }), false, 'an extra (text) field rejects the record');
  assert.equal(log.record({ ...record, voice: 'a\nb' }), false);
  assert.equal(log.record({ ...record, t: { ...record.t, spoken: 1 } }), false);
  assert.equal(log.record({ ...record, textLength: 6001 }), false);
  assert.equal(log.record('not a record'), false);
  for (let i = 1; i < SPEECH_DIAGNOSTICS_PER_MINUTE; i++) log.record(record);
  assert.equal(log.record(record), false, 'at most a bounded number of records per minute');
  now += 60_000;
  assert.equal(log.record(record), true);
});
