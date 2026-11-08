// D: a failed Bailian reading leaves one journal line with a closed category —
// network / auth / quota / service / timeout / other — and nothing else: no system-voice fallback, no retry, never the reply text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechRuntime, type SpeechSynthesizer } from '../electron/speech-runtime';
import { synthesizeBailianSpeech, TtsError } from '../electron/tts';
import { DEFAULT_TTS_CONFIG, type SpeechWireEvent, type TtsConfig } from '../shared/tts';
import { bailianCodeFailure, httpFailure, type SpeechFailure } from '../shared/speech-failure';
import { buildJournalEntry, describeJournalEntry } from '../shared/journal';

const config = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: 'bailian', apiHost: 'https://real-console-host.example',
  region: 'user-region', apiKey: 'fixture-key', ...patch });
const sse = (body: string) => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }),
  { headers: { 'content-type': 'text/event-stream' } });
async function failureOf(run: () => Promise<unknown>): Promise<SpeechFailure> {
  try { await run(); } catch (error) { assert.ok(error instanceof TtsError, String(error)); return error.failure; }
  assert.fail('expected a failure');
}
const never = new AbortController().signal;

test('every way a Bailian reading fails maps to one closed category', async () => {
  const speak = (fetch: typeof globalThis.fetch, patch: Partial<TtsConfig> = {}, timeoutMs?: number) =>
    () => synthesizeBailianSpeech(config(patch), '你好。', never, () => {}, { fetch, ...(timeoutMs ? { timeoutMs } : {}) });
  assert.equal(await failureOf(speak(async () => { throw new TypeError('fetch failed'); })), 'network');
  assert.equal(await failureOf(speak(async () => new Response('', { status: 401 }))), 'auth');
  assert.equal(await failureOf(speak(async () => new Response('', { status: 403 }))), 'auth');
  assert.equal(await failureOf(speak(async () => new Response('', { status: 429 }))), 'quota');
  assert.equal(await failureOf(speak(async () => new Response('', { status: 500 }))), 'service');
  assert.equal(await failureOf(speak(async () => sse(`data: ${JSON.stringify({ code: 'InvalidApiKey' })}\n\n`))), 'auth');
  assert.equal(await failureOf(speak(async () => sse(`data: ${JSON.stringify({ code: 'Arrearage' })}\n\n`))), 'quota');
  assert.equal(await failureOf(speak(async () => sse(`data: ${JSON.stringify({ code: 'InternalError' })}\n\n`))), 'service');
  assert.equal(await failureOf(speak(async () => sse('data: {not json\n\n'))), 'service');
  assert.equal(await failureOf(speak(async () => sse(''))), 'network'); // the stream ended before "stop"
  assert.equal(await failureOf(speak(async () => new Response('', { status: 200 }), { apiKey: '' })), 'auth');
  // A request that never answers ends as a timeout.
  const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(await failureOf(speak(hanging, {}, 20)), 'timeout');
});

test('the closed category tables', () => {
  assert.deepEqual([401, 403, 402, 429, 400, 404, 500, 503].map(httpFailure), ['auth', 'auth', 'quota', 'quota', 'service', 'service', 'service', 'service']);
  assert.deepEqual(['InvalidApiKey', 'Throttling.RateQuota', 'Arrearage', 'DataInspectionFailed'].map(bailianCodeFailure), ['auth', 'quota', 'quota', 'service']);
});

test('the runtime reports a failed synthesis once and never a stopped or superseded one', async () => {
  const failures: SpeechFailure[] = [], events: SpeechWireEvent[] = [];
  let reject: (error: unknown) => void = () => {};
  const synthesize: SpeechSynthesizer = () => new Promise((_resolve, fail) => { reject = fail; });
  const runtime = new SpeechRuntime(() => config(), (_owner, event) => events.push(event), synthesize, failure => failures.push(failure));
  // Failed by itself: one category, and the window still gets its ordinary error event (muted there in normal mode).
  const first = runtime.speak(11, 'one', '第一句。');
  reject(new TtsError('百炼语音返回 HTTP 429', 'quota')); await first;
  assert.deepEqual(failures, ['quota']);
  assert.equal(events.at(-1)?.type, 'error');
  // Stopped by the user or replaced by a newer reading: nothing is recorded.
  const second = runtime.speak(11, 'two', '第二句。');
  const failSecond = reject;
  runtime.stop(); failSecond(new TtsError('x', 'network')); await second;
  const third = runtime.speak(11, 'three', '第三句。');
  const failThird = reject;
  const fourth = runtime.speak(22, 'four', '第四句。');
  failThird(new TtsError('x', 'network')); await third;
  // A non-TtsError failure is "other".
  reject(new Error('boom')); await fourth;
  assert.deepEqual(failures, ['quota', 'other']);
  // A broken journal never changes the reading.
  const throwing = new SpeechRuntime(() => config(), () => {}, () => Promise.reject(new TtsError('x', 'service')), () => { throw new Error('disk full'); });
  await throwing.speak(11, 'five', '第五句。');
});

test('the journal line holds only the category: no reply text, address or key', () => {
  const entry = buildJournalEntry({ type: 'speech', characterId: 'gene', provider: 'bailian', failure: 'auth',
    text: '小满你好', apiHost: 'https://real-console-host.example', apiKey: 'fixture-key' }, Date.UTC(2026, 10, 3, 19, 42, 5))!;
  assert.ok(entry);
  const line = JSON.stringify(entry);
  for (const word of ['小满', 'real-console-host', 'fixture-key', 'apiKey', 'text']) assert.ok(!line.includes(word), word);
  assert.equal(entry.reason, '这次朗读没读出来');
  const tr = (source: string, ...values: readonly unknown[]) => source.replace(/\{(\d)\}/g, (_, i) => String(values[Number(i)]));
  assert.equal(describeJournalEntry(entry, tr).slice(6), '这次朗读没读出来（鉴权）');
  assert.equal(buildJournalEntry({ type: 'speech', characterId: 'gene', provider: 'bailian', failure: '服务器说：余额不足' }, 1), null);
  assert.equal(buildJournalEntry({ type: 'speech', characterId: 'gene', provider: 'system', failure: 'auth' }, 1), null);
});
