// 2026-11-24 每一句话都停 / 有一句话没读出来 (docs/claude/2026-11-24-voice-gaps.md), item 1: a Drama 3 request that never connected gets one more
// try; the speech row names the error kind, whether it was tried twice, and which reply and sentence it was; the reply's reading row says it
// failed after a retry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fishVoiceSynthesizer, retryingFishSynthesizer, worthRetrying } from '../electron/voice/fish-retry';
import { FishBudget, type FishSynthesizer } from '../electron/voice/fish-voice-host';
import { ReadNotes } from '../electron/voice/read-notes';
import { SpeechRuntime } from '../electron/voice/speech-runtime';
import { failureInfo, speechErrorKind, speechFailureEntry } from '../electron/voice/speech-failure-record';
import { TtsError } from '../electron/voice/tts';
import { ReadingJournal } from '../electron/memory/journal/extras';
import { buildJournalEntry, describeJournalEntry, type JournalEntry, type JournalInput } from '../shared/memory/journal';
import { DEFAULT_TTS_CONFIG, type SpeechWireEvent, type TtsConfig } from '../shared/voice/tts';

const config: TtsConfig = { ...DEFAULT_TTS_CONFIG, provider: 'fish', fishApiKey: 'k', fishVoiceId: 'v' } as TtsConfig;
const network = () => new TtsError('连不上 Fish Audio，请检查网络和代理设置。', 'network', 'network');
const noWait = { pauseMs: () => 0, wait: async () => true };

function scripted(steps: Array<'network' | 'ok' | 'http' | 'audio-then-network'>) {
  const calls: number[] = []; let n = 0;
  const synth: FishSynthesizer = async (_c, _t, _s, emit) => {
    calls.push(++n);
    const step = steps[n - 1] ?? 'ok';
    if (step === 'network') throw network();
    if (step === 'http') throw new TtsError('x', 'service', 'http-5xx');
    if (step === 'audio-then-network') { await emit({ type: 'audio', data: 'AAAA', format: 'pcm_s16le', sampleRate: 24000, channels: 1 }); throw network(); }
    await emit({ type: 'audio', data: 'AAAA', format: 'pcm_s16le', sampleRate: 24000, channels: 1, firstAudioMs: 100 });
    return { firstAudioMs: 100, audioBytes: 2 };
  };
  return { synth, calls };
}

test('a network failure is tried once more, after a pause, and the second try can succeed', async () => {
  const { synth, calls } = scripted(['network', 'ok']);
  const waits: number[] = [];
  const events: string[] = [];
  const result = await retryingFishSynthesizer(synth, { pauseMs: () => 512, wait: async ms => { waits.push(ms); return true; } })(config, 'text', new AbortController().signal, e => { events.push(e.type); });
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(waits, [512], 'one short pause between the tries');
  assert.deepEqual(events, ['audio'], 'only the second try handed audio on');
  assert.equal(result.audioBytes, 2);
});

test('a second network failure ends with the second error, marked retried, after exactly two tries', async () => {
  const { synth, calls } = scripted(['network', 'network', 'ok']);
  await assert.rejects(retryingFishSynthesizer(synth, noWait)(config, 'text', new AbortController().signal, () => {}),
    (error: unknown) => error instanceof TtsError && error.retried === true && error.kind === 'network');
  assert.deepEqual(calls, [1, 2], 'never a third try');
});

test('nothing is retried after audio was handed on, for a refusal or an error that is not a network failure, or after a stop', async () => {
  const half = scripted(['audio-then-network', 'ok']);
  await assert.rejects(retryingFishSynthesizer(half.synth, noWait)(config, 't', new AbortController().signal, () => {}), (e: unknown) => e instanceof TtsError && e.retried === false);
  assert.deepEqual(half.calls, [1], 'a second try would say the same words twice');
  const refused = scripted(['http', 'ok']);
  await assert.rejects(retryingFishSynthesizer(refused.synth, noWait)(config, 't', new AbortController().signal, () => {}));
  assert.deepEqual(refused.calls, [1]);
  const stopped = scripted(['network', 'ok']); const controller = new AbortController();
  await assert.rejects(retryingFishSynthesizer(stopped.synth, { pauseMs: () => 1, wait: async () => { controller.abort(); return false; } })(config, 't', controller.signal, () => {}));
  assert.deepEqual(stopped.calls, [1], 'a stop during the pause ends it');
  assert.equal(worthRetrying(network()), true); assert.equal(worthRetrying(new TtsError('t', 'timeout', 'timeout')), false); assert.equal(worthRetrying(new Error('x')), false);
});

test('the speech row carries the kind, the retry and the reply and sentence numbers, and the reply row says it failed after a retry', async () => {
  const notes = new ReadNotes();
  const failures: Array<ReturnType<typeof speechFailureEntry>> = [];
  const events: SpeechWireEvent[] = [];
  const runtime = new SpeechRuntime(() => config, (_owner, event) => { events.push(event); }, retryingFishSynthesizer(async () => { throw network(); }, noWait) as never,
    (failure, provider, info) => { failures.push(speechFailureEntry('c1', provider, failure, info, notes)); }, {}, replyId => { notes.numberOf(replyId); });
  await runtime.speak(1, 'seg-1', '这一句要读出来。', { replyId: 'reply-a', segmentIndex: 2 });
  assert.equal(failures.length, 1);
  assert.deepEqual({ ...failures[0] }, { type: 'speech', characterId: 'c1', provider: 'fish', failure: 'network', kind: 'network', retried: true, reply: 1, segment: 2 });
  assert.equal(events.at(-1)?.type, 'error');
  // The reading row of that reply, written when its segment records come in.
  const written: JournalEntry[] = [];
  const sink = { record: (input: JournalInput) => { const e = buildJournalEntry(input, 1); if (e) written.push(e); return e; }, accepting: () => true };
  const reading = new ReadingJournal(sink as never, () => 'c1', { set: () => 0, clear: () => {} }, undefined, undefined, notes);
  reading.segment({ kind: 'reply', provider: 'fish', segmentIndex: 0, textLength: 8, outcome: 'error', t: {} });
  reading.flush();
  const row = written.find(e => e.type === 'reading-time') as Extract<JournalEntry, { type: 'reading-time' }>;
  assert.deepEqual([row.result, row.why, row.afterRetry, row.reply], ['unread', 'failed', true, 1]);
  const speechRow = buildJournalEntry(failures[0] as JournalInput, 1)!;
  assert.match(describeJournalEntry(speechRow, (s, ...v) => s.replace(/\{(\d+)\}/g, (_m, i) => String(v[Number(i)]))), /连不上服务.*重试了一次还是不行.*第 1 条回复的第 3 句/);
  assert.doesNotMatch(JSON.stringify(written) + JSON.stringify(speechRow), /要读出来|Fish Audio|reply-a|seg-1/, 'no words, no ids');
});

test('a failure with no retry says so by leaving the field out; a retried one is matched by the reply number', () => {
  const notes = new ReadNotes();
  const plain = speechFailureEntry('c', 'bailian', 'quota', failureInfo(new TtsError('q', 'quota')), notes);
  assert.deepEqual({ ...plain }, { type: 'speech', characterId: 'c', provider: 'bailian', failure: 'quota', kind: 'other' });
  notes.noteRetriedFailure(4);
  assert.equal(notes.takeRetriedFailure(5), false, 'another reply does not take it');
  assert.equal(notes.takeRetriedFailure(4), true); assert.equal(notes.takeRetriedFailure(4), false, 'taken once');
  assert.equal(speechErrorKind(new TtsError('t', 'timeout')), 'timeout');
  assert.equal(speechErrorKind(new Error('x')), 'other');
});

test('the host\'s Drama 3 synthesizer is the budgeted one with the retry: a request that never connected is not billed, the second try is, once', async () => {
  let accepted = 0, tries = 0;
  const budget = new FishBudget({ directory: () => null });
  const fake = (async (_c: TtsConfig, _t: string, _s: AbortSignal, emit: (e: never) => unknown, options: { accepted?: (bytes: number) => void } = {}) => {
    if (++tries === 1) throw network();
    options.accepted?.(10); accepted++;
    await emit({ type: 'done', firstAudioMs: 1, audioBytes: 2 } as never);
    return { firstAudioMs: 1, audioBytes: 2 };
  }) as never;
  // No directory: the budget admits nothing, so the first call is refused as a quota and never reaches the service.
  await assert.rejects(fishVoiceSynthesizer(budget, fake, noWait)(config, 't', new AbortController().signal, () => {}), (e: unknown) => e instanceof TtsError && e.failure === 'quota');
  assert.equal(tries, 0, 'a refused request is not tried at all, and not retried');
  const open = new FishBudget({ directory: () => 'C:/nowhere-for-test', write: async () => {}, read: () => { throw new Error('none'); } });
  const result = await fishVoiceSynthesizer(open, fake, noWait)({ ...config, fishMonthlyCapUsd: 5 }, 't', new AbortController().signal, () => {});
  assert.deepEqual([tries, accepted, result.audioBytes], [2, 1, 2]);
});
