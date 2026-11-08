import test from 'node:test';
import assert from 'node:assert/strict';
import { AMBIENT_ASR_LIMITS, parseAmbientAsrResult, transcribeAmbientWav, type AmbientAsrDependencies } from '../electron/ambient-asr';
import { validateAmbientLanguage } from '../shared/ambient-audio';

const config = { baseUrl: 'https://asr.example.test/v1/', model: 'fixture-sensevoice', language: 'zh', apiKey: 'PRIVATE_FIXTURE_KEY' };
const evidence = (raw: string, languages: string[]) => ({ source: 'sensevoice-model', raw_language: raw, languages });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const window = (start: number, end: number, raw: string, hasText = true) => ({ start_sample: start, end_sample: end, raw_language: raw, raw_event: '<|Speech|>', has_text: hasText });
const single = () => ({ version: 2, source: 'sensevoice-model', mode: 'auto', scope: 'subwindow-observations', sample_rate: 16000, sample_count: 16000,
  raw_language: '<|ja|>', has_text: true, languages: ['ja'], windows: [window(0, 16000, '<|ja|>')], window_analysis: 'complete' });
const mixed = () => ({ ...single(), sample_count: 176000, raw_language: '<|en|>', languages: ['zh', 'en', 'ja'],
  windows: [window(0, 58666, '<|zh|>'), window(58666, 117333, '<|en|>'), window(117333, 176000, '<|ja|>')] });
const whole = () => ({ ...single(), sample_count: 100000, scope: 'whole-result', windows: [], window_analysis: 'failed' });
const diagnostic = (scope = 'subwindow-observations', windowAnalysis = 'complete') => ({ version: 2, scope, windowAnalysis });
function wav(frames = 16_000, metadataBytes = 0): ArrayBuffer {
  const extra = metadataBytes ? 8 + metadataBytes + metadataBytes % 2 : 0;
  const buffer = new ArrayBuffer(44 + frames * 2 + extra), bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const tag = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  tag(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  if (extra) { tag(36, 'JUNK'); view.setUint32(40, metadataBytes, true); }
  tag(36 + extra, 'data'); view.setUint32(40 + extra, frames * 2, true);
  return buffer;
}

test('system audio explicitly opts into real-window verbose metadata without a forced language or a key in its body', async () => {
  let calls = 0;
  const result = await transcribeAmbientWav(config, wav(), new AbortController().signal, { fetch: async (url, init) => {
    calls++; assert.equal(url, 'https://asr.example.test/v1/audio/transcriptions');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${config.apiKey}`);
    const body = init?.body as FormData;
    assert.equal(body.get('model'), config.model); assert.equal(body.get('response_format'), 'verbose_json');
    assert.equal(body.get('language_detection_mode'), 'sensevoice-windows-v2');
    assert.deepEqual([...body.keys()].sort(), ['file', 'language_detection_mode', 'model', 'response_format']);
    assert.equal(body.has('language'), false); assert.equal([...body.values()].includes(config.apiKey), false);
    const file = body.get('file') as File; assert.equal(file.type, 'audio/wav'); assert.equal(file.size, wav().byteLength);
    return response({ text: '  公開テスト。  ', language_detection: single() });
  } });
  assert.equal(calls, 1); assert.deepEqual(result, { text: '公開テスト。', language: { status: 'detected', language: 'ja', source: 'provider' }, languageDetection: diagnostic() });
});

test('legacy evidence accepts only its one actual model tag and never manufactures confidence', () => {
  for (const [raw, code] of [['zh', 'zh'], ['<|ja|>', 'ja'], ['<|en|>', 'en']]) {
    const value = parseAmbientAsrResult({ text: 'fixture', language_detection: { ...evidence(raw, [code]), scope: 'single-model-tag' } });
    assert.deepEqual(value.language, { status: 'detected', language: code, source: 'provider' });
    assert.deepEqual(validateAmbientLanguage(value.language), value.language);
    assert.equal('confidence' in value.language, false);
  }
});

test('old bare language and text script never prove detection', () => {
  for (const text of ['中文文本。', '日本語です。', 'English text.']) for (const language of ['chinese', 'ja', 'en', 'mixed'])
    assert.deepEqual(parseAmbientAsrResult({ text, language }).language, { status: 'unknown', source: 'unverified' });
});

test('flat lists cannot establish mixed speech, configured aliases or unobserved language codes', () => {
  for (const language_detection of [evidence('zh+en', ['zh', 'en']), evidence('zh', ['zh', 'en']), evidence('zh', ['zh', 'chinese']),
    evidence('chinese', ['zh']), evidence('english', ['en']), evidence('fr', ['fr']), { ...evidence('zh', ['zh']), scope: 'unknown-or-not-automatic' }])
    assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection }).language, { status: 'unknown', source: 'unverified' });
  for (const code of ['ko', 'yue']) {
    assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: evidence(code, [code]) }).language,
      { status: 'unsupported', language: code, source: 'provider' });
  }
  assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: { ...evidence('zh', []), scope: 'unknown-or-not-automatic' } }).language,
    { status: 'unknown', source: 'provider' });
});

test('missing, conflicting or untrusted evidence is unknown and cannot leak metadata into a language label', () => {
  for (const language_detection of [null, { language: 'ja' }, { ...evidence('ja', ['ja']), source: 'configured-language' },
    { source: 'sensevoice-model', languages: ['ja'] }, evidence('', ['ja']), evidence('ja', ['zh']), evidence('ja', ['PRIVATE_FIXTURE_KEY'.repeat(4)])])
    assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection }).language, { status: 'unknown', source: 'unverified' });
  assert.deepEqual(parseAmbientAsrResult({ text: '', language_detection: evidence('', []) }), { text: '', language: { status: 'unknown', source: 'provider' } });
});

test('three real balanced windows prove observed languages while preserving the whole original transcript', () => {
  const text = 'Whole original decode: 中文 English 日本語。';
  const value = parseAmbientAsrResult({ text, language_detection: mixed() }, 176000);
  assert.deepEqual(value, { text, language: { status: 'mixed', languages: ['zh', 'en', 'ja'], source: 'provider' }, languageDetection: diagnostic() });
  assert.deepEqual(validateAmbientLanguage(value.language), value.language);
  const onlyWindows = { ...mixed(), raw_language: '<|zh|>', sample_count: 100000, languages: ['en', 'ja'], windows: [window(0, 50000, 'en'), window(50000, 100000, 'ja')] };
  assert.deepEqual(parseAmbientAsrResult({ text, language_detection: onlyWindows }, 100000).language,
    { status: 'mixed', languages: ['en', 'ja'], source: 'provider' });
  assert.equal('confidence' in value.language, false);
});

test('v2 evidence must match the actual WAV sample count, including WAV metadata rather than file byte length', async () => {
  for (const expectedSamples of [undefined, 0, 176001, NaN, Infinity])
    assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: mixed() }, expectedSamples), { text: 'fixture', language: { status: 'unknown', source: 'unverified' } });
  const accepted = await transcribeAmbientWav(config, wav(176000, 1001), new AbortController().signal, { fetch: async () => response({ text: 'whole', language_detection: mixed() }) });
  assert.equal(accepted.language.status, 'mixed');
  const mismatch = await transcribeAmbientWav(config, wav(16001), new AbortController().signal, { fetch: async () => response({ text: 'whole', language_detection: single() }) });
  assert.deepEqual(mismatch, { text: 'whole', language: { status: 'unknown', source: 'unverified' } });
});

test('strict v2 rejects fabricated unions, missing windows, gaps, overlaps, forced mode and extra claims', () => {
  const mutations: Array<(value: ReturnType<typeof mixed>) => void> = [
    value => { value.windows.pop(); }, value => { value.windows[1].start_sample++; }, value => { value.windows[0].end_sample++; },
    value => { value.windows[0].end_sample = 64000; value.windows[1].start_sample = 64000; },
    value => { value.windows[1].end_sample = 117333.5; }, value => { value.sample_count = 192001; },
    value => { value.sample_rate = 8000; }, value => { value.mode = 'forced-or-unknown'; },
    value => { value.languages = ['en', 'zh', 'ja']; }, value => { value.languages = ['zh', 'en']; },
    value => { value.languages = new Array<string>(3); },
    value => { value.languages = ['zh', 'en', 'ja', 'ko']; }, value => { value.version = 3; },
    value => { value.source = 'configured-language'; }, value => { value.has_text = false; },
    value => { value.window_analysis = 'failed'; }, value => { value.windows[1].raw_language = 'x'.repeat(129); },
    value => { value.windows[1].raw_event = '\0private'; }, value => { value.raw_language = '\0private'; },
    value => { Object.assign(value, { confidence: 1 }); }, value => { Object.assign(value.windows[0], { coverage: 'complete' }); },
    value => { Object.assign(value.windows[0], { text: 'Do not replace the whole transcript' }); },
  ];
  for (const mutate of mutations) {
    const value = mixed(); mutate(value);
    assert.deepEqual(parseAmbientAsrResult({ text: 'whole retained', language_detection: value }, 176000),
      { text: 'whole retained', language: { status: 'unknown', source: 'unverified' } });
  }
  const conflictingReuse = single(); conflictingReuse.windows[0].raw_language = '<|en|>'; conflictingReuse.languages = ['en'];
  assert.deepEqual(parseAmbientAsrResult({ text: 'whole', language_detection: conflictingReuse }, 16000).language, { status: 'unknown', source: 'unverified' });
});

test('balanced short tails and the exact twelve-second limit accept only the complete sample partition', () => {
  for (const [samples, windows] of [
    [64100, [window(0, 32050, 'ja'), window(32050, 64100, 'ja')]],
    [192000, [window(0, 64000, 'ja'), window(64000, 128000, 'ja'), window(128000, 192000, 'ja')]],
  ] as const) {
    const value = { ...single(), sample_count: samples, windows };
    assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: value }, samples).language, { status: 'detected', language: 'ja', source: 'provider' });
  }
});

test('unknown nonempty windows prevent a language claim, empty windows do not contribute, and ko/yue remain unsupported', () => {
  const value = { ...mixed(), sample_count: 100000, languages: [] as string[], windows: [window(0, 50000, 'en'), window(50000, 100000, '<|nospeech|>')] };
  assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: value }, 100000).language, { status: 'unknown', source: 'provider' });
  assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: { ...value, languages: ['en'] } }, 100000).language, { status: 'unknown', source: 'unverified' });
  value.windows[1].has_text = false; value.languages = ['en'];
  assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: value }, 100000).language, { status: 'detected', language: 'en', source: 'provider' });
  for (const code of ['ko', 'yue']) {
    const unsupported = { ...value, languages: ['en', code], windows: [window(0, 50000, 'en'), window(50000, 100000, `<|${code}|>`)] };
    assert.deepEqual(parseAmbientAsrResult({ text: 'fixture', language_detection: unsupported }, 100000).language, { status: 'unsupported', language: code, source: 'provider' });
  }
});

test('failed window analysis only yields explicitly scoped whole single-tag evidence, while silence and forced config stay unknown', () => {
  const fallback = parseAmbientAsrResult({ text: 'whole original', language_detection: whole() }, 100000);
  assert.deepEqual(fallback, { text: 'whole original', language: { status: 'detected', language: 'ja', source: 'provider' }, languageDetection: diagnostic('whole-result', 'failed') });
  for (const invalid of [{ ...whole(), languages: ['ja', 'en'] }, { ...whole(), windows: [window(0, 10000, 'ja')] },
    { ...whole(), mode: 'forced-or-unknown' }, { ...whole(), window_analysis: 'skipped-empty' }])
    assert.deepEqual(parseAmbientAsrResult({ text: 'whole original', language_detection: invalid }, 100000).language, { status: 'unknown', source: 'unverified' });
  const forced = { ...whole(), mode: 'forced-or-unknown', languages: [], window_analysis: 'not-requested' };
  assert.deepEqual(parseAmbientAsrResult({ text: 'whole original', language_detection: forced }, 100000).language, { status: 'unknown', source: 'provider' });
  const silent = { ...whole(), raw_language: '<|en|>', has_text: false, languages: [], window_analysis: 'skipped-empty' };
  assert.deepEqual(parseAmbientAsrResult({ text: '  ', language_detection: silent }, 100000), { text: '', language: { status: 'unknown', source: 'provider' }, languageDetection: diagnostic('whole-result', 'skipped-empty') });
});

test('WAV duration uses the verified data chunk, permits 12 seconds plus metadata and rejects one extra frame before fetch', async () => {
  let calls = 0;
  const dependencies: AmbientAsrDependencies = { fetch: async () => { calls++; return response({ text: '' }); } };
  await transcribeAmbientWav(config, wav(12 * 16000, 1001), new AbortController().signal, dependencies);
  await assert.rejects(transcribeAmbientWav(config, wav(12 * 16000 + 1), new AbortController().signal, dependencies), /12 秒/);
  await assert.rejects(transcribeAmbientWav(config, new ArrayBuffer(10), new AbortController().signal, dependencies), /WAV/);
  assert.equal(calls, 1);
});

test('text length and invalid JSON errors are bounded without exposing service content or credentials', async () => {
  for (const value of [null, {}, { text: 12 }, { text: 'x'.repeat(4001) }, { text: 'hidden\0text' }])
    assert.throws(() => parseAmbientAsrResult(value), /文字格式/);
  assert.equal(parseAmbientAsrResult({ text: 'x'.repeat(4000) }).text.length, 4000);
  for (const body of [`PRIVATE_BODY_${config.apiKey}`, new Uint8Array([0xff, 0xff])]) {
    await assert.rejects(transcribeAmbientWav(config, wav(), new AbortController().signal, { fetch: async () => new Response(body) }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /无效 JSON/);
      assert.ok(!error.message.includes(config.apiKey)); assert.ok(!error.message.includes('PRIVATE_BODY')); return true;
    });
  }
});

test('HTTP and transport failures reject redirects and never surface response bodies, headers, URLs or raw errors', async () => {
  for (const status of [302, 401, 500]) {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(transcribeAmbientWav(config, wav(), new AbortController().signal, { fetch: async () => new Response(stream, { status }) }), new RegExp(`HTTP ${status}`));
    assert.equal(cancelled, true);
  }
  await assert.rejects(transcribeAmbientWav(config, wav(), new AbortController().signal, { fetch: async () => {
    throw new Error(`fetch failed https://private.example?key=${config.apiKey}`);
  } }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /无法请求系统音频识别服务/);
    for (const privateText of ['fetch failed', 'private.example', config.apiKey]) assert.ok(!error.message.includes(privateText)); return true;
  });
});

test('body byte cap rejects both declared and streamed oversized responses and releases the reader', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(AMBIENT_ASR_LIMITS.responseBytes + 1)); },
      cancel() { cancelled = true; },
    });
    const item = new Response(stream, { headers: declared ? { 'content-length': String(AMBIENT_ASR_LIMITS.responseBytes + 1) } : {} });
    await assert.rejects(transcribeAmbientWav(config, wav(), new AbortController().signal, { fetch: async () => item }), /大小上限/);
    assert.equal(cancelled, true); assert.equal(stream.locked, false);
  }
});

test('timeout and user cancellation interrupt a real pending body read and clean up without a network fixture', async () => {
  for (const userCancel of [false, true]) {
    const user = new AbortController(), timeout = new AbortController();
    let ready!: () => void; const reading = new Promise<void>(resolve => { ready = resolve; });
    let finishPull: (() => void) | undefined, cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"text":"')); },
      pull() { ready(); return new Promise<void>(resolve => { finishPull = resolve; }); },
      cancel() { cancelled++; finishPull?.(); },
    }, { highWaterMark: 0 });
    const reason = new Error(`PRIVATE_USER_REASON_${config.apiKey}`);
    const pending = transcribeAmbientWav(config, wav(), user.signal, {
      fetch: async () => new Response(stream), timeoutSignal(milliseconds) { assert.equal(milliseconds, 60_000); return timeout.signal; },
    });
    const rejected = assert.rejects(pending, error => {
      if (userCancel) assert.equal(error, reason);
      else { assert.ok(error instanceof Error); assert.match(error.message, /响应超时/); assert.ok(!error.message.includes(config.apiKey)); }
      return true;
    });
    await reading; (userCancel ? user : timeout).abort(reason); await rejected;
    assert.equal(cancelled, 1); assert.equal(stream.locked, false);
  }
});

test('cancelled fetch cannot publish a late whole-result fallback and releases any late response body', async () => {
  const user = new AbortController(); let resolve!: (response: Response) => void;
  let calls = 0, cancelled = false;
  const pending = transcribeAmbientWav(config, wav(100000), user.signal, { fetch: async () => { calls++; return new Promise<Response>(done => { resolve = done; }); } });
  const reason = new Error('user stopped ambient capture'), rejected = assert.rejects(pending, error => error === reason);
  user.abort(reason); await rejected;
  resolve(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ text: 'late primary fallback', language_detection: whole() }))); },
    cancel() { cancelled = true; },
  })));
  await new Promise<void>(done => setImmediate(done));
  assert.equal(calls, 1); assert.equal(cancelled, true);
  await assert.rejects(transcribeAmbientWav(config, wav(), user.signal, { fetch: async () => { calls++; return response({ text: 'stale' }); } }), error => error === reason);
  assert.equal(calls, 1);
});
