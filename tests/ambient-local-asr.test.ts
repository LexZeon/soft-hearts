// 陪听歌、看剧的转写改用本机识别 (electron/asr/ambient-route.ts). With a fake store, fake
// utilityProcess and fake fetch: only the local recognizer transcribes played sound (I-016 "声音只在本机", Codex T-207: with
// 识别方式 = compatible the switch hears only the rhythm and no clip is sent), a missing component refuses with a reason and
// raises the download question, voice input stays ahead of transcription on the one recognizer, the model's language tag goes
// through the old rules, the event / emotion tags come back from a whitelist, failures keep only their category, and a
// session can start only when the local component is ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AmbientAsrRoute, AmbientNotLocalError, AMBIENT_FAILURE_NOTE_MS, ambientFailureOf, localAmbientResult, refusedReadingAck } from '../electron/asr/ambient-route';
import { IDLE_STOP_MS, LocalAsrError, LocalAsrHost, type AsrWorkerHandle } from '../electron/asr/host';
import { ASR_EMOTION_TAGS, ASR_EVENT_TAGS, tokensToUtterance } from '../electron/asr/decode';
import { parseAsrHostMessage, parseAsrWorkerMessage } from '../electron/asr/protocol';
import { startAsrWorker } from '../electron/asr/worker';
import type { AsrOrtLike, AsrOrtSession } from '../electron/asr/engine';
import { AmbientAsrError, transcribeAmbientWav } from '../electron/ambient-asr';
import { ForegroundAsr } from '../electron/foreground-asr';
import { createAudioReadingView, parseAudioReadingAck } from '../shared/audio-reading-toggles';
import { buildJournalEntry, type JournalInput } from '../shared/journal';
import { setUiLanguage } from '../shared/ui-language';
import type { VoiceInputConfig } from '../shared/contracts';
import { NOTICE_ACTIONS, readingRefusalAction, type NoticeAction } from '../src/notice-policy';
import { uiText } from '../src/ui/ui-language';
import { encodeWav } from '../src/ui/MediaInput';
import { onnxWithMetadata, senseVoiceMetadata } from './helpers/onnx-proto';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function clock() {
  let now = 0, id = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => { due.set(++id, { at: now + ms, run }); return id; },
    clearTimer: (handle: unknown) => { due.delete(handle as number); },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]); now = next[1].at; next[1].run(); await flush();
      }
      now = end;
    },
  };
}

function fakeStore(installed = true) {
  return {
    get installed() { return installed; }, working: false, downloadBytes: 270_161_561, officialDownloadBytes: 355_013_368, get installedBytes() { return installed ? 313_698_939 : 0; },
    installedDir: () => installed ? 'C:\\components\\asr\\asr-v1\\win32-arm64' : null,
    installedFile: (to: string) => installed ? `C:\\components\\asr\\asr-v1\\win32-arm64\\${to.replaceAll('/', '\\')}` : null,
    refresh: async () => installed, install: async () => { installed = true; }, importFiles: async () => ({ accepted: 0, rejected: 0, complete: false }),
    remove: async () => { installed = false; },
  };
}

interface FakeWorker { sent: Record<string, unknown>[]; message?: (m: unknown) => void; exit?: (code: number) => void; killed: number; exited: boolean }
function fakeWorkers() {
  const made: FakeWorker[] = [];
  const fork = (): AsrWorkerHandle => {
    const worker: FakeWorker = { sent: [], killed: 0, exited: false };
    made.push(worker);
    return { postMessage: message => { worker.sent.push(message as unknown as Record<string, unknown>); }, onMessage: listener => { worker.message = listener; },
      onExit: listener => { worker.exit = listener; }, kill: () => { worker.killed++; worker.exited = true; worker.exit?.(1); } };
  };
  return { made, fork };
}

const VOICE: VoiceInputConfig = { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1', language: 'zh', apiKey: '', engine: 'local' };

function setup(options: { installed?: boolean; engine?: 'local' | 'compatible'; config?: Partial<VoiceInputConfig>; local?: boolean } = {}) {
  const time = clock(), workers = fakeWorkers(), prompts: string[] = [], lines: JournalInput[] = [];
  const store = fakeStore(options.installed ?? true);
  const local = new LocalAsrHost({ store: store as never, fork: workers.fork, publish() {}, promptRaised: owner => prompts.push(owner),
    setTimer: time.setTimer, clearTimer: time.clearTimer, sharedRuntime: () => false });
  let config: VoiceInputConfig = { ...VOICE, ...(options.engine ? { engine: options.engine } : {}), ...options.config };
  const route = new AmbientAsrRoute({
    config: () => config, local: () => options.local === false ? null : local,
    journal: input => lines.push(input), characterId: () => 'gene', now: time.now,
  });
  return { route, local, time, workers, prompts, lines, store, setConfig(next: Partial<VoiceInputConfig>) { config = { ...config, ...next }; } };
}
/** Starts the recognition process and reports it ready. */
async function ready(s: ReturnType<typeof setup>, index = 0): Promise<FakeWorker> {
  await flush();
  const worker = s.workers.made[index]!;
  worker.message!({ type: 'ready', loadMs: 1 }); await flush();
  return worker;
}
const clip = (seconds = 12) => encodeWav(new Float32Array(Math.round(16000 * seconds)).fill(0.05));

test('识别方式 local (also the default with no engine): the clip goes to the local recognizer with language detection and tags', async () => {
  for (const engine of ['local', undefined] as const) {
    const s = setup({ config: { engine } });
    const pending = s.route.transcribe(clip(), new AbortController().signal);
    const worker = await ready(s);
    const request = worker.sent[1]!;
    assert.equal(request.type, 'recognize');
    assert.equal(request.language, 'auto', 'never the voice-input language: the model detects it');
    assert.equal(request.tags, true);
    worker.message!({ type: 'result', id: request.id, text: ' 我们一起看海 ', ms: 240, tags: { language: 'zh', event: 'bgm', emotion: 'happy' } });
    assert.deepEqual(await pending, { text: '我们一起看海', language: { status: 'detected', language: 'zh', source: 'provider' },
      languageDetection: { version: 2, scope: 'whole-result', windowAnalysis: 'not-requested' }, sound: { event: 'bgm', emotion: 'happy' } });
  }
});

test('识别方式 compatible: a played clip is not transcribed at all (I-016: the sound never leaves the computer), nothing starts, nothing is noted', async () => {
  const s = setup({ engine: 'compatible' });
  await assert.rejects(s.route.transcribe(clip(2), new AbortController().signal), AmbientNotLocalError);
  assert.equal(s.workers.made.length, 0, 'the local recognizer is not started either: rhythm only');
  assert.deepEqual(s.lines, [], 'not a recognition failure');
});

test('component missing: the switch is refused with a reason, the download question shows and the control window is raised', () => {
  const s = setup({ installed: false });
  assert.equal(s.route.blocked('pet'), 'needs-component');
  assert.deepEqual(s.prompts, ['pet'], 'promptRaised(pet) brings the control window to the download line');
  const view = s.local.view();
  assert.equal(view.prompt, true); assert.equal(view.asked, 1);
  assert.equal(s.route.blocked('pet'), 'needs-component');
  assert.equal(s.local.view().asked, 2, 'every refused try brings the question into view again');
  assert.equal(s.workers.made.length, 0, 'nothing starts');
  assert.deepEqual(s.lines.map(line => [line.type, (line as { failure: string }).failure, (line as { refused: boolean }).refused]),
    [['audio-reading', 'needs-component', true], ['audio-reading', 'needs-component', true]]);
  // No local recognizer for this computer at all.
  const none = setup({ local: false });
  assert.equal(none.route.blocked('pet'), 'unavailable');
  assert.equal((none.lines[0] as { failure: string }).failure, 'local-failed');
  // Installed: nothing refused, nothing noted.
  const ok = setup();
  assert.equal(ok.route.blocked('pet'), null); assert.equal(ok.lines.length, 0);
  // 识别方式 = compatible: the words are refused whatever is filled in ('not-local', rhythm only), never the local question.
  const compatible = setup({ engine: 'compatible', installed: false, config: { model: ' ' } });
  assert.equal(compatible.route.blocked('pet'), 'not-local'); assert.equal(compatible.prompts.length, 0);
  compatible.setConfig({ model: 'sensevoice' });
  assert.equal(compatible.route.blocked('pet'), 'not-local');
  assert.equal(compatible.prompts.length, 0); assert.deepEqual(compatible.lines, []);
});

test('a refused switch replies with the cell unchanged and not accepted (the toggle keeps its own state), and she says why', () => {
  const view = createAudioReadingView('scope-0123456789');
  const ack = refusedReadingAck(view, 'system-audio', 'movie');
  assert.deepEqual(parseAudioReadingAck(ack), ack, 'the strict ack parser accepts it');
  assert.equal(ack.accepted, false); assert.equal(ack.cell.intent, false);
  assert.deepEqual(ack.cell, view.sources['system-audio'].movie); assert.notEqual(ack.cell, view.sources['system-audio'].movie, 'a copy');
  for (const reason of ['needs-component', 'preparing', 'unavailable', 'not-local'] as const) assert.equal(readingRefusalAction(reason), `reading-${reason}`);
  for (const odd of ['unconfigured', '', null, '<b>x</b>', { reason: 'needs-component' }]) assert.equal(readingRefusalAction(odd), null);
  const reading = Object.keys(NOTICE_ACTIONS).filter(key => key.startsWith('reading-')) as NoticeAction[];
  assert.equal(reading.length, 4);
  // None of them offers the compatible address for listening any more (I-016: played sound is transcribed only here).
  for (const action of reading) assert.ok(!/改用兼容接口地址/u.test(NOTICE_ACTIONS[action]), action);
  try {
    for (const language of ['zh-CN', 'en'] as const) {
      setUiLanguage(language);
      for (const action of reading) {
        const text = uiText(NOTICE_ACTIONS[action]);
        assert.ok(text.length > 10 && text.length <= 160, `${language} ${action}: fits the toast (${text.length})`);
        assert.ok(!/onnx|DLL|error|utility|SenseVoice/i.test(text), 'no technical words');
        if (language === 'en') assert.ok(!/[一-鿿]/.test(text), `${action} has English copy`);
      }
    }
    setUiLanguage('zh-CN');
    assert.match(uiText(NOTICE_ACTIONS['reading-needs-component']), /下载/);
    assert.match(uiText(NOTICE_ACTIONS['reading-needs-component']), /声音不会离开电脑/);
  } finally { setUiLanguage('zh-CN'); }
});

test('canStart: the local component ready (not while downloading); never on the compatible address', async () => {
  const s = setup({ installed: false });
  assert.equal(s.route.ready(), false);
  assert.equal(setup().route.ready(), true);
  const fresh = setup({ installed: false });
  const job = fresh.local.download();
  assert.equal(fresh.route.ready(), false, 'not while the component is being installed');
  await job;
  assert.equal(fresh.route.ready(), true, 'ready once installed');
  assert.equal(setup({ local: false }).route.ready(), false);
  const compatible = setup({ engine: 'compatible' });
  assert.equal(compatible.route.ready(), false, 'played sound is never transcribed through the compatible address, even with the component installed');
  compatible.setConfig({ baseUrl: '' });
  assert.equal(compatible.route.ready(), false);
});

test('one recognizer, voice input first: it cancels the clip in hand, goes next, and no new clip starts while it is admitted', async () => {
  const s = setup();
  const voice = new ForegroundAsr({ pauseAndDrain: () => undefined, transcribe: (wav, signal) => s.local.transcribe(wav, 'zh', signal), entered() {}, exited() {} });
  const background = voice.runBackground(new AbortController().signal, () => true, active => s.route.transcribe(clip(), active));
  const worker = await ready(s);
  const clipRequest = worker.sent[1]!;
  assert.equal(clipRequest.tags, true);
  const spoken = voice.run('pet', encodeWav(new Float32Array(16000).fill(0.1)), new AbortController().signal, () => true);
  await assert.rejects(background, 'the clip in hand is cancelled');
  await flush();
  const voiceRequest = worker.sent[2]!;
  assert.equal(voiceRequest.type, 'recognize'); assert.equal(voiceRequest.language, 'zh');
  assert.equal('tags' in voiceRequest, false, 'voice input never asks for tags');
  await assert.rejects(voice.runBackground(new AbortController().signal, () => true, active => s.route.transcribe(clip(), active)), /正忙/,
    'no transcription while voice input is admitted');
  // The process finishes the cancelled clip first (its answer is dropped), then the user's words.
  worker.message!({ type: 'result', id: clipRequest.id, text: '迟到的歌词', ms: 300, tags: { language: 'zh', event: 'sing', emotion: 'neutral' } });
  worker.message!({ type: 'result', id: voiceRequest.id, text: '你好呀', ms: 90 });
  assert.equal(await spoken, '你好呀');
  assert.equal(s.lines.length, 0, 'a cancelled clip is not a failure');
  // Afterwards transcription goes on.
  const next = voice.runBackground(new AbortController().signal, () => true, active => s.route.transcribe(clip(), active));
  await flush();
  const nextRequest = worker.sent[3]!;
  worker.message!({ type: 'result', id: nextRequest.id, text: 'la la', ms: 200, tags: { language: 'en', event: 'sing', emotion: 'happy' } });
  assert.equal((await next).text, 'la la');
});

test('the process stays warm between clips without voice input, stops a little after the last clip, and ends by itself', async () => {
  const s = setup();
  const answer = (worker: FakeWorker) => { const request = worker.sent.at(-1)!; worker.message!({ type: 'result', id: request.id, text: 'x', ms: 1, tags: { language: 'en', event: 'speech', emotion: null } }); };
  const first = s.route.transcribe(clip(), new AbortController().signal);
  const worker = await ready(s);
  answer(worker); await first;
  await s.time.advance(IDLE_STOP_MS - 1000);
  const second = s.route.transcribe(clip(), new AbortController().signal); await flush();
  answer(worker); await second;
  await s.time.advance(IDLE_STOP_MS - 1);
  assert.equal(worker.sent.some(m => m.type === 'stop'), false, 'each clip restarts the countdown');
  await s.time.advance(1);
  assert.deepEqual(worker.sent.at(-1), { type: 'stop' }, 'asked to stop after the last clip');
  worker.exited = true; worker.exit!(0); await s.time.advance(10_000);
  assert.equal(worker.killed, 0, 'it ended by itself, never killed');
  assert.equal(s.workers.made.length, 1, 'one process for all the clips');
  // Voice input on keeps it; voice input off then waits for the clips too.
  const t = setup();
  t.local.setWanted(true);
  const w = await ready(t);
  const clipDone = t.route.transcribe(clip(), new AbortController().signal); await flush();
  t.local.setWanted(false);
  answer(w); await clipDone;
  await t.time.advance(IDLE_STOP_MS - 1);
  assert.equal(w.sent.some(m => m.type === 'stop'), false);
  await t.time.advance(1);
  assert.deepEqual(w.sent.at(-1), { type: 'stop' });
});

test('language: the model tag goes through the old rules — zh / ja / en supported, yue / ko unsupported, nothing said → unknown', () => {
  const tags = (language: string | null) => ({ language: language as never, event: 'speech' as const, emotion: 'neutral' as const });
  assert.deepEqual(localAmbientResult({ text: '你好', tags: tags('zh') }).language, { status: 'detected', language: 'zh', source: 'provider' });
  assert.deepEqual(localAmbientResult({ text: 'こんにちは', tags: tags('ja') }).language, { status: 'detected', language: 'ja', source: 'provider' });
  assert.deepEqual(localAmbientResult({ text: 'hello', tags: tags('en') }).language, { status: 'detected', language: 'en', source: 'provider' });
  assert.deepEqual(localAmbientResult({ text: '你好呀', tags: tags('yue') }).language, { status: 'unsupported', language: 'yue', source: 'provider' });
  assert.deepEqual(localAmbientResult({ text: '안녕', tags: tags('ko') }).language, { status: 'unsupported', language: 'ko', source: 'provider' });
  assert.deepEqual(localAmbientResult({ text: 'hm', tags: tags(null) }).language, { status: 'unknown', source: 'provider' });
  assert.deepEqual(localAmbientResult({ text: 'hm' }).language, { status: 'unknown', source: 'provider' }, 'no tags: unknown');
  const silent = localAmbientResult({ text: '  ', tags: tags('zh') });
  assert.deepEqual(silent, { text: '', language: { status: 'unknown', source: 'provider' },
    languageDetection: { version: 2, scope: 'whole-result', windowAnalysis: 'skipped-empty' }, sound: { event: 'speech', emotion: 'neutral' } },
  'a tag without words proves no language');
  // Measured on the real model: music without singing comes back as "." with a guessed language (ja / yue).
  for (const dots of ['.', ' 。', '...', '，']) assert.deepEqual(localAmbientResult({ text: dots, tags: { language: 'ja', event: 'bgm', emotion: 'unknown' } }),
    { text: '', language: { status: 'unknown', source: 'provider' }, languageDetection: { version: 2, scope: 'whole-result', windowAnalysis: 'skipped-empty' },
      sound: { event: 'bgm', emotion: 'unknown' } }, `punctuation only is no words: ${JSON.stringify(dots)}`);
  assert.equal(localAmbientResult({ text: '8点半。', tags: tags('zh') }).text, '8点半。', 'digits are words');
});

test('decoding: language / event / emotion tags come back from closed lists, anything else is dropped, the words keep no tag', () => {
  const tokens = ['<unk>', '<s>', '</s>', '<|ja|>', '<|SAD|>', '<|BGM|>', '<|withitn|>', '君', 'の', '歌', '<|de|>', '<|nospeech|>', '<|Speech|>', '<|HAPPY|>',
    '<|zh/en|>', '<|SPECIAL_TOKEN_1|>', '<|Sing|>', '<|EMO_UNKNOWN|>', '<|Event_UNK|>', '<|yue|>'];
  assert.deepEqual(tokensToUtterance([3, 4, 5, 6, 7, 8, 9], tokens), { text: '君の歌', language: 'ja', event: 'bgm', emotion: 'sad' });
  // First tag of each kind wins; unknown languages, nospeech, ITN and spare tokens never leave.
  assert.deepEqual(tokensToUtterance([10, 11, 14, 15, 12, 13, 5, 7], tokens), { text: '君', language: null, event: 'speech', emotion: 'happy' });
  assert.deepEqual(tokensToUtterance([19, 17, 18], tokens), { text: '', language: 'yue', event: 'unknown', emotion: 'unknown' });
  assert.deepEqual(tokensToUtterance([16], tokens).event, 'sing');
  for (const result of [tokensToUtterance([3, 4, 5, 6, 7, 10, 11, 14, 15], tokens)]) assert.ok(!/<\||\|>/.test(result.text));
  assert.ok(ASR_EVENT_TAGS.includes('bgm') && ASR_EVENT_TAGS.includes('speech') && !ASR_EVENT_TAGS.includes('BGM' as never));
  assert.ok(ASR_EMOTION_TAGS.includes('neutral'));
});

test('protocol: tags only as asked, only whitelisted values, exactly three keys', () => {
  const tags = { language: 'zh', event: 'bgm', emotion: 'happy' };
  assert.deepEqual(parseAsrWorkerMessage({ type: 'result', id: 'a1', text: 't', ms: 5, tags }), { type: 'result', id: 'a1', text: 't', ms: 5, tags });
  assert.deepEqual(parseAsrWorkerMessage({ type: 'result', id: 'a1', text: 't', ms: 5, tags: { language: null, event: null, emotion: null } })?.type, 'result');
  for (const bad of [{ ...tags, language: 'de' }, { ...tags, event: 'BGM' }, { ...tags, emotion: '<b>' }, { ...tags, extra: 1 }, { language: 'zh' }, 'zh', null])
    assert.equal(parseAsrWorkerMessage({ type: 'result', id: 'a1', text: 't', ms: 5, tags: bad }), null, JSON.stringify(bad));
  const wav = new ArrayBuffer(50);
  assert.equal(parseAsrHostMessage({ type: 'recognize', id: 'a1', wav, language: 'auto', tags: true })?.type, 'recognize');
  assert.equal((parseAsrHostMessage({ type: 'recognize', id: 'a1', wav, language: 'auto', tags: true }) as { tags?: true }).tags, true);
  assert.equal('tags' in parseAsrHostMessage({ type: 'recognize', id: 'a1', wav, language: 'zh' })!, false);
  assert.equal(parseAsrHostMessage({ type: 'recognize', id: 'a1', wav, language: 'auto', tags: 'yes' }), null);
});

test('the inference process sends the tags back only when asked', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'asr-worker-tags-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const model = onnxWithMetadata(senseVoiceMetadata());
  const vocab = ['<unk>', '<s>', '</s>', '<|zh|>', '<|en|>', '<|NEUTRAL|>', '<|Speech|>', '<|withitn|>', '今天', '天气', '真', '好', '。', '▁hi', '<|woitn|>', '<|HAPPY|>', '<|BGM|>'];
  const tokens = vocab.map((piece, id) => `${piece} ${id}`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'model.onnx'), model); writeFileSync(path.join(dir, 'tokens.txt'), tokens);
  const sent: Record<string, unknown>[] = [];
  const session: AsrOrtSession = {
    inputNames: ['x', 'x_length', 'language', 'text_norm'], outputNames: ['logits'],
    run: async () => {
      const best = [3, 15, 16, 7, 8, 9, 10, 11, 12]; // <|zh|><|HAPPY|><|BGM|><|withitn|>今天天气真好。
      const data = new Float32Array(best.length * vocab.length);
      best.forEach((id, frame) => { data[frame * vocab.length + id] = 9; });
      return { logits: { data, dims: [1, best.length, vocab.length] } };
    },
    release: async () => {},
  };
  const ort: AsrOrtLike = { InferenceSession: { create: async () => session },
    Tensor: class { constructor(public type: string, public data: ArrayLike<number>, public dims: number[]) {} } as never };
  let listener: (event: { data: unknown }) => void = () => {};
  startAsrWorker({ on: (_e, l) => { listener = l; }, postMessage: m => sent.push(m as Record<string, unknown>) }, () => ort, () => {}, () => 0);
  const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
  const answered = async (count: number) => { for (const end = Date.now() + 3000; sent.length <= count && Date.now() < end; ) await new Promise(r => setTimeout(r, 5)); };
  listener({ data: { type: 'init', runtimeEntry: path.join(dir, 'ort'), model: path.join(dir, 'model.onnx'), modelSize: model.length, modelSha256: hash(model),
    tokens: path.join(dir, 'tokens.txt'), tokensSha256: hash(tokens), threads: 2 } });
  await answered(0);
  assert.equal(sent.at(-1)!.type, 'ready');
  const audio = encodeWav(new Float32Array(16000).fill(0.05));
  listener({ data: { type: 'recognize', id: 'r1', wav: audio, language: 'auto', tags: true } });
  await answered(1);
  assert.deepEqual(sent.at(-1), { type: 'result', id: 'r1', text: '今天天气真好。', ms: 0, tags: { language: 'zh', event: 'bgm', emotion: 'happy' } });
  assert.ok(parseAsrWorkerMessage(sent.at(-1)), 'the host accepts it');
  listener({ data: { type: 'recognize', id: 'r2', wav: audio, language: 'zh' } });
  await answered(2);
  assert.deepEqual(sent.at(-1), { type: 'result', id: 'r2', text: '今天天气真好。', ms: 0 }, 'voice input: words only');
});

test('a clip longer than 12 s never reaches the recognizer', async () => {
  const s = setup();
  await assert.rejects(s.route.transcribe(clip(12.5), new AbortController().signal), (error: unknown) => error instanceof AmbientAsrError && /12 秒/.test(error.message));
  assert.equal(s.workers.made.length, 0);
  assert.equal((s.lines[0] as { failure: string }).failure, 'other');
});

test('failures keep only a category: one journal line per category a minute, a cancelled clip is none, never audio or words', async () => {
  const s = setup();
  const failOnce = async () => {
    const pending = s.route.transcribe(clip(), new AbortController().signal);
    await flush();
    const worker = s.workers.made.at(-1)!;
    if (!s.local.view().phase.startsWith('ready')) { worker.message!({ type: 'ready', loadMs: 1 }); await flush(); }
    worker.message!({ type: 'error', id: worker.sent.at(-1)!.id });
    await assert.rejects(pending, (error: unknown) => error instanceof LocalAsrError && error.failure === 'local-failed');
  };
  await failOnce(); await failOnce();
  assert.equal(s.lines.length, 1, 'the same category again within a minute is not written again');
  await s.time.advance(AMBIENT_FAILURE_NOTE_MS);
  await failOnce();
  assert.equal(s.lines.length, 2);
  // Not installed (removed while a session ran): its own category.
  const missing = setup({ installed: false });
  await assert.rejects(missing.route.transcribe(clip(), new AbortController().signal), (error: unknown) => error instanceof LocalAsrError && error.failure === 'needs-component');
  assert.equal((missing.lines[0] as { failure: string }).failure, 'needs-component');
  // Cancelled: nothing written.
  const cancel = setup();
  const controller = new AbortController();
  const pending = cancel.route.transcribe(clip(), controller.signal);
  await ready(cancel);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(cancel.lines.length, 0);
  // The lines: closed fields only.
  for (const input of [...s.lines, ...missing.lines]) {
    const entry = buildJournalEntry(input, Date.UTC(2026, 10, 3, 22))!;
    assert.ok(entry, 'a valid journal line');
    assert.deepEqual(Object.keys(input).sort(), ['characterId', 'engine', 'failure', 'refused', 'type']);
    assert.ok(!/歌词|wav|RIFF|\.onnx/i.test(JSON.stringify(entry)));
    assert.equal(entry.reason, '一段播放的声音没能转写');
  }
});

test('the compatible address: its failures by category (unreachable, service, timeout)', async () => {
  const wav = clip(2);
  const config: VoiceInputConfig = { ...VOICE, engine: 'compatible', baseUrl: 'https://asr.example.test/v1', model: 'sensevoice' };
  const run = (fetch: typeof globalThis.fetch, timeoutSignal?: () => AbortSignal) =>
    transcribeAmbientWav(config, wav, new AbortController().signal, { fetch, ...(timeoutSignal ? { timeoutSignal } : {}) });
  const failure = async (pending: Promise<unknown>) => { try { await pending; } catch (error) { return ambientFailureOf(error); } return 'none'; };
  assert.equal(await failure(run(async () => { throw new TypeError('fetch failed'); })), 'unreachable');
  assert.equal(await failure(run(async () => new Response('nope', { status: 500 }))), 'service');
  assert.equal(await failure(run(async () => new Response('{', { status: 200 }))), 'service');
  assert.equal(await failure(run(async () => new Response('{}', { status: 200 }), () => AbortSignal.abort())), 'timeout');
  assert.equal(ambientFailureOf(new Error('anything else')), 'other');
  // The route no longer reaches this function (I-016, Codex T-207): with 识别方式 = compatible it refuses before any request.
  const s = setup({ engine: 'compatible' });
  await assert.rejects(s.route.transcribe(wav, new AbortController().signal), AmbientNotLocalError);
  assert.deepEqual(s.lines, []);
});
