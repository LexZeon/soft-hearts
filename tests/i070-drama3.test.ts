// I-070: Fish Audio's Drama 3 as a third reading voice. Everything here runs on fakes:
// a fake fetch (no request ever leaves this machine), a fake secret store, temporary profile folders.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_TTS_CONFIG, type TtsConfig, type TtsStreamEvent, type SpeechWireEvent } from '../shared/voice/tts';
import { DEFAULT_SETTINGS } from '../shared/foundation/defaults';
import type { AppSettings } from '../shared/foundation/settings';
import {
  FISH_MOODS, FISH_NEUTRAL_DIRECTION, FISH_BUDGET_NOTICE, fishBudgetExhausted, fishCostMicroUsd, fishDirection, fishMonthKey,
  fishRequestText, fishUsdPerMillionBytes, validFishMonthlyCap,
} from '../shared/voice/fish-voice';
import { FISH_TTS_MODEL, FISH_TTS_URL, resolveTtsKey, synthesizeFishSpeech, TtsError, validateTtsConfig } from '../electron/voice/tts';
import {
  budgetedFishSynthesizer, FISH_API_KEYS_URL, FISH_BILLING_URL, FISH_USAGE_FILE, FISH_VOICE_METHODS, FishBudget, openFishPage, registerFishVoiceIpc,
} from '../electron/voice/fish-voice-host';
import { SpeechRuntime, speechSynthesizer } from '../electron/voice/speech-runtime';
import { composeSpeechConfig, fishMoodFor, ReplySpeechStyles } from '../electron/mood/speech-emotion';
import { KEY_SENTINEL, publicSettings, SettingsStore, type SecretStorage } from '../electron/settings/settings';
import { AssetRegistry } from '../electron/foundation/assets';
import { FishVoiceFallback } from '../src/voice/fish-voice-fallback';
import { AGENT_TOOLS } from '../shared/safety/agent-channel';
import { TAKE_ME_THERE, TAKE_ME_THERE_IDS } from '../shared/initiative/take-me-there';
import { AgentToolRegistry } from '../electron/safety/agent-channel/registry';
import { createAppTools, voiceStyleArgs } from '../electron/safety/agent-channel/app-tools';
import { createHostBridge, type IpcHandler } from '../electron/safety/agent-channel/bridge';

const KEY = 'fish-key-marker-0123456789';
const fishConfig = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: 'fish', fishApiKey: KEY, fishVoiceId: 'v2abc', rate: 0.9, ...patch });

interface FakeCall { url: string; init: RequestInit; body: any; headers: Record<string, string> }
/** A fake fetch that streams `chunks` (or answers `status`), and errors its body when the request is aborted, like real fetch. */
function fakeFetch(options: { chunks?: number[][]; status?: number; contentType?: string; hold?: boolean; fail?: boolean } = {}) {
  const calls: FakeCall[] = [];
  let cancelled = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    if (options.fail) throw new TypeError('fetch failed');
    const chunks = [...(options.chunks ?? [[0, 0, 1, 0]])];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener('abort', () => { try { controller.error(init.signal!.reason); } catch { /* closed */ } });
      },
      pull(controller) {
        const next = chunks.shift();
        if (next) { controller.enqueue(new Uint8Array(next)); return; }
        if (options.hold) return new Promise<void>(() => {}); // never ends by itself
        controller.close();
      },
      cancel() { cancelled++; },
    });
    return new Response(stream, { status: options.status ?? 200, headers: { 'content-type': options.contentType ?? 'audio/pcm' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls, cancelled: () => cancelled };
}
const decode = (events: TtsStreamEvent[]) => Buffer.concat(events.filter(e => e.type === 'audio').map(e => Buffer.from((e as any).data, 'base64')));

// --- 1. The adapter ------------------------------------------------------------------------------------------------------

test('Drama 3 request: fixed endpoint, model header, Bearer key, and exactly the agreed body (balanced, pcm 24 kHz)', async () => {
  const fake = fakeFetch();
  const events: TtsStreamEvent[] = [];
  let clock = 1000;
  const result = await synthesizeFishSpeech(fishConfig(), '你好呀', new AbortController().signal, e => { events.push(e); clock += 5; },
    { mood: 'happy' }, { fetch: fake.fetch, now: () => (clock += 37) });
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.url, FISH_TTS_URL);
  assert.equal(call.url, 'https://api.fish.audio/v1/tts');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual(call.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', model: 'drama-3' });
  assert.equal(FISH_TTS_MODEL, 'drama-3');
  assert.deepEqual(call.body, {
    text: '[happy, a small smile, natural, like everyday chatting] 你好呀', reference_id: 'v2abc', format: 'pcm', sample_rate: 24000,
    latency: 'balanced', temperature: 0.6, top_p: 0.7, prosody: { speed: 0.9 },
  });
  assert.deepEqual(result, { firstAudioMs: 37, audioBytes: 4 });
  assert.deepEqual(events.map(e => e.type), ['audio', 'done']);
  assert.equal((events[0] as any).firstAudioMs, 37);
  assert.equal((events[0] as any).format, 'pcm_s16le');
  assert.equal((events[0] as any).sampleRate, 24000);
  // No fixed voice: no reference_id at all (Drama 3's own default voice).
  const plain = fakeFetch();
  await synthesizeFishSpeech(fishConfig({ fishVoiceId: '' }), '嗯', new AbortController().signal, () => {}, {}, { fetch: plain.fetch });
  assert.equal(Object.hasOwn(plain.calls[0].body, 'reference_id'), false);
  assert.equal(plain.calls[0].body.text, `${FISH_NEUTRAL_DIRECTION} 嗯`, 'an unknown mood speaks naturally');
});

test('odd-sized network chunks: the half sample waits for the next chunk; PCM arrives whole and in order', async () => {
  const bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const fake = fakeFetch({ chunks: [[1], [2, 3, 4], [5, 6, 7], [8], [9, 10, 11, 12]] });
  const events: TtsStreamEvent[] = [];
  const result = await synthesizeFishSpeech(fishConfig(), '一句话', new AbortController().signal, e => { events.push(e); }, {}, { fetch: fake.fetch });
  const audio = events.filter(e => e.type === 'audio');
  for (const e of audio) assert.equal(Buffer.from((e as any).data, 'base64').length % 2, 0, 'every emitted chunk is whole 16-bit samples');
  assert.deepEqual([...decode(events)], bytes);
  assert.equal(result.audioBytes, 12);
  assert.equal(audio.filter(e => (e as any).firstAudioMs !== undefined).length, 1, 'first-audio time only on the first chunk');
  // A lone trailing byte (half a sample) is dropped, the sentence still completes.
  const tail = fakeFetch({ chunks: [[1, 2, 3]] });
  const tailEvents: TtsStreamEvent[] = [];
  const tailResult = await synthesizeFishSpeech(fishConfig(), '一句话', new AbortController().signal, e => { tailEvents.push(e); }, {}, { fetch: tail.fetch });
  assert.deepEqual([...decode(tailEvents)], [1, 2]);
  assert.equal(tailResult.audioBytes, 2);
});

test('cancelling mid-stream stops at once: no done event, the body is released, the abort surfaces', async () => {
  const fake = fakeFetch({ chunks: [[0, 0, 1, 0]], hold: true });
  const controller = new AbortController();
  const events: TtsStreamEvent[] = [];
  const running = synthesizeFishSpeech(fishConfig(), '长长的一句', controller.signal, e => { events.push(e); if (e.type === 'audio') controller.abort(); }, {}, { fetch: fake.fetch });
  await assert.rejects(running, (error: unknown) => (error as Error).name === 'AbortError');
  assert.deepEqual(events.map(e => e.type), ['audio']);
  // Aborted before anything: no request at all.
  const before = fakeFetch(); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(synthesizeFishSpeech(fishConfig(), '嗯', aborted.signal, () => {}, {}, { fetch: before.fetch }));
  assert.equal(before.calls.length, 0);
});

test('failures are plain Chinese with a closed category: wrong key, no balance (402), too many requests (429), network, not audio', async () => {
  const cases: [number, RegExp, string][] = [
    [401, /API Key 不对或已经失效.*API 密钥/, 'auth'], [403, /API Key/, 'auth'], [402, /余额不够.*API 账单/, 'quota'],
    [429, /同时收到的请求太多/, 'quota'], [500, /暂时出错了（HTTP 500）/, 'service'],
  ];
  for (const [status, message, failure] of cases) {
    const fake = fakeFetch({ status });
    const accepted: number[] = [];
    await assert.rejects(synthesizeFishSpeech(fishConfig(), '嗯', new AbortController().signal, () => {}, { accepted: b => accepted.push(b) }, { fetch: fake.fetch }),
      (error: unknown) => error instanceof TtsError && message.test(error.publicMessage) && error.failure === failure && !error.publicMessage.includes(KEY));
    assert.deepEqual(accepted, [], `HTTP ${status} is not billed`);
  }
  const offline = fakeFetch({ fail: true });
  await assert.rejects(synthesizeFishSpeech(fishConfig(), '嗯', new AbortController().signal, () => {}, {}, { fetch: offline.fetch }),
    (error: unknown) => error instanceof TtsError && /连不上 Fish Audio/.test(error.publicMessage) && error.failure === 'network');
  const json = fakeFetch({ contentType: 'application/json' });
  await assert.rejects(synthesizeFishSpeech(fishConfig(), '嗯', new AbortController().signal, () => {}, {}, { fetch: json.fetch }),
    (error: unknown) => error instanceof TtsError && error.failure === 'service');
  const noKey = fakeFetch();
  await assert.rejects(synthesizeFishSpeech(fishConfig({ fishApiKey: '' }), '嗯', new AbortController().signal, () => {}, {}, { fetch: noKey.fetch }),
    (error: unknown) => error instanceof TtsError && /API Key/.test(error.publicMessage));
  assert.equal(noKey.calls.length, 0, 'no key: nothing is sent');
});

test('the direction lives only in the request: words in the reply cannot start a direction, and the window never sees it', async () => {
  assert.equal(fishRequestText('sad', '我[laughs]才没有<whisper>呢'), '[a little sad, natural, like everyday chatting] 我(laughs)才没有‹whisper›呢');
  const fake = fakeFetch();
  const wire: SpeechWireEvent[] = [];
  const styles = new ReplySpeechStyles(() => 0);
  styles.begin(7, 'reply-1', 'scope');
  const config = fishConfig();
  styles.complete(7, 'reply-1', 'scope', { context: 'positive', primary: 'happy' }, composeSpeechConfig(config, { context: 'positive', primary: 'happy' }));
  const runtime = new SpeechRuntime(
    (owner, context) => context ? { ...config, ...styles.resolveStyle(owner, context.replyId, 'scope') } : config,
    (_owner, event) => { wire.push(event); },
    speechSynthesizer((c, t, s, e, ctx) => synthesizeFishSpeech(c, t, s, e, { mood: ctx?.mood }, { fetch: fake.fetch })),
  );
  await runtime.speak(7, 'seg-1', '今天好开心（笑）', { replyId: 'reply-1', segmentIndex: 0 });
  assert.equal(fake.calls[0].body.text, '[happy, a small smile, natural, like everyday chatting] 今天好开心', 'the frozen mood became the direction; the stage direction is not read');
  assert.ok(wire.some(e => e.type === 'done'), JSON.stringify(wire));
  assert.equal(JSON.stringify(wire).includes('natural'), false, 'nothing of the direction reaches the window');
});

// --- 2. Mood → direction ---------------------------------------------------------------------------------------------

test('mood map: every direction is natural, none uses the words that made her affected or too quiet; unknown is everyday', () => {
  for (const mood of FISH_MOODS) {
    const direction = fishDirection(mood);
    assert.match(direction, /^\[[^\]]+\]$/u);
    assert.match(direction, /natural/u, mood);
    assert.doesNotMatch(direction, /whisper|breath|coy|flirt|seduct|sexy|耳语|气声|撒娇|妩媚/iu, mood);
  }
  assert.equal(new Set(FISH_MOODS.map(fishDirection)).size, FISH_MOODS.length, 'each mood its own direction');
  assert.equal(fishDirection('calm'), FISH_NEUTRAL_DIRECTION, 'calm is the everyday direction itself');
  for (const unknown of [undefined, null, 'angry', 3, {}]) assert.equal(fishDirection(unknown), '[natural, like everyday chatting]');
  assert.equal(fishMoodFor({ context: 'neutral', primary: 'calm' }), 'calm');
  assert.equal(fishMoodFor({ context: 'support', primary: 'happy' }), 'comfort');
  assert.equal(fishMoodFor({ context: 'offense', primary: 'calm' }), 'firm');
  assert.equal(fishMoodFor({ context: 'neutral', primary: 'happy' }, { phase: 'drowsy' }), 'sleepy');
  assert.equal(fishMoodFor({ context: 'neutral', primary: 'happy' }, { phase: 'light-drowsy' }), 'happy');
  // Only a Drama 3 config carries the mood; Bailian's composed style is unchanged.
  assert.equal(composeSpeechConfig(fishConfig(), { context: 'disappointment', primary: 'sad' }).speechMood, 'sad');
  assert.equal(Object.hasOwn(composeSpeechConfig({ ...DEFAULT_TTS_CONFIG, provider: 'bailian' }, { context: 'neutral', primary: 'sad' }), 'speechMood'), false);
  // Never stored: validation drops it.
  assert.equal(Object.hasOwn(validateTtsConfig({ ...fishConfig(), speechMood: 'happy' }), 'speechMood'), false);
});

// --- 3. Money: price, the monthly limit, the month -----------------------------------------------------------------

test('price per UTF-8 byte at the moment of the request: launch price until Dec 1 00:00 Pacific, list price after', () => {
  assert.equal(fishUsdPerMillionBytes(new Date('2026-11-30T23:59:00-08:00')), 10);
  assert.equal(fishUsdPerMillionBytes(new Date('2026-12-01T00:00:00-08:00')), 50);
  assert.equal(fishCostMicroUsd(1_000_000, new Date('2026-11-10T12:00:00Z')), 10_000_000, '$10 per million bytes');
  assert.equal(fishCostMicroUsd(3, new Date('2026-12-02T12:00:00Z')), 150, 'one Chinese character at list price');
  assert.equal(fishCostMicroUsd(0, new Date()), 0);
  // 11-24: 0 = no limit, and it is the default; a set limit is still clamped to 1..500.
  assert.equal(validFishMonthlyCap(undefined), 0, 'default: no limit');
  assert.equal(validFishMonthlyCap(0), 0); assert.equal(validFishMonthlyCap(0.4), 1); assert.equal(validFishMonthlyCap(1e9), 500); assert.equal(validFishMonthlyCap(Number.NaN), 0);
  assert.equal(validFishMonthlyCap(12.345), 12.35);
});

async function tempProfile(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-i070-'));
  t.after(async () => {
    assert.ok(path.basename(directory).startsWith('soft-hearts-i070-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('monthly limit: under it every request goes; the crossing reply finishes; then refused; one notice; a new month starts clean', async t => {
  const directory = await tempProfile(t);
  let now = new Date('2026-11-10T10:00:00');
  const pushes: any[] = [];
  const budget = new FishBudget({ directory: () => directory, now: () => now, publish: view => pushes.push(view) });
  const cap = 1; // $1 = 100,000 bytes at the launch price
  assert.equal(budget.admit(cap, 'r1'), true);
  budget.record(60_000, cap, 'r1');
  assert.equal(budget.admit(cap, 'r1'), true);
  budget.record(50_000, cap, 'r1'); // crosses $1 during reply r1
  assert.deepEqual(budget.view(), { month: '2026-11', bytes: 110_000, spentMicroUsd: 1_100_000 });
  assert.equal(pushes.filter(p => p.notice).length, 1, 'the crossing push carries the notice once');
  assert.equal(budget.admit(cap, 'r1'), true, 'the reply that crossed finishes in Drama 3 (no words lost mid-reply)');
  assert.equal(budget.admit(cap, 'r2'), false, 'a new reply is refused');
  assert.equal(budget.admit(cap), false, 'a preview is refused');
  assert.equal(budget.admit(2, 'r2'), true, 'raising the limit lets her speak again');
  budget.record(10, cap, 'r1');
  assert.equal(pushes.filter(p => p.notice).length, 1, 'no second notice in the same month');
  await budget.flush();
  const disk = JSON.parse(await readFile(path.join(directory, FISH_USAGE_FILE), 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['bytes', 'month', 'noticedMonth', 'spentMicroUsd', 'version'], 'numbers only, no words, no key');
  // Read back by a fresh host (restart): the month's spending is still there.
  const again = new FishBudget({ directory: () => directory, now: () => now });
  assert.equal(again.view().spentMicroUsd, 1_100_100);
  assert.equal(again.admit(cap, 'r3'), false);
  // Next month: from zero, Drama 3 again.
  now = new Date('2026-12-01T09:00:00');
  assert.deepEqual(again.view(), { month: '2026-12', bytes: 0, spentMicroUsd: 0 });
  assert.equal(again.admit(cap, 'r4'), true);
  // Before settings are loaded nothing is admitted.
  assert.equal(new FishBudget({ directory: () => null }).admit(cap, 'x'), false);
});

test('the budgeted synthesizer refuses plainly once the month is used up, and bills only requests the service accepted', async t => {
  const directory = await tempProfile(t);
  const budget = new FishBudget({ directory: () => directory, now: () => new Date('2026-11-10T10:00:00') });
  const fake = fakeFetch();
  const synth = budgetedFishSynthesizer(budget, (c, t2, s, e, o) => synthesizeFishSpeech(c, t2, s, e, o, { fetch: fake.fetch }));
  await synth(fishConfig({ fishMonthlyCapUsd: 1 }), '你好', new AbortController().signal, () => {}, { replyId: 'a' });
  const sent = fake.calls[0].body.text as string;
  assert.equal(budget.view().bytes, Buffer.byteLength(sent, 'utf8'), 'the direction is billed too');
  // A refused request (401) is not billed.
  const denied = fakeFetch({ status: 401 });
  const deniedSynth = budgetedFishSynthesizer(budget, (c, t2, s, e, o) => synthesizeFishSpeech(c, t2, s, e, o, { fetch: denied.fetch }));
  await assert.rejects(deniedSynth(fishConfig({ fishMonthlyCapUsd: 1 }), '你好', new AbortController().signal, () => {}, { replyId: 'a' }));
  assert.equal(budget.view().bytes, Buffer.byteLength(sent, 'utf8'));
  // Used up: refused without a request.
  budget.record(200_000, 1, 'a');
  const before = fake.calls.length;
  await assert.rejects(synth(fishConfig({ fishMonthlyCapUsd: 1 }), '你好', new AbortController().signal, () => {}, { replyId: 'b' }),
    (error: unknown) => error instanceof TtsError && error.publicMessage === `${FISH_BUDGET_NOTICE}。` && error.failure === 'quota');
  assert.equal(fake.calls.length, before, 'no request once the month is used up');
  // Without a budgeted synthesizer, a Drama 3 request is refused rather than spent unmetered.
  await assert.rejects(speechSynthesizer()(fishConfig(), '你好', new AbortController().signal, () => {}), /用量记账/);
  await budget.flush();
});

test('the window switches to the system voice between readings only, and back when the month or the limit allows', () => {
  let now = new Date('2026-11-20T10:00:00');
  const fallback = new FishVoiceFallback(() => now);
  const config = fishConfig({ fishMonthlyCapUsd: 10 });
  assert.equal(fallback.speaking(config).provider, 'fish', 'unknown spending: Drama 3');
  fallback.playback('playing'); // a Drama 3 reply is being read
  assert.ok(fallback.update({ month: '2026-11', bytes: 1, spentMicroUsd: 10_000_000, notice: true }));
  assert.equal(fallback.speaking(config).provider, 'fish', 'the reply being read finishes in Drama 3');
  fallback.playback('idle');
  assert.equal(fallback.speaking(config).provider, 'system', 'next reading: system voice');
  assert.equal(config.provider, 'fish', 'the user’s own choice is untouched');
  fallback.playback('loading');
  assert.equal(fallback.speaking({ ...config, fishMonthlyCapUsd: 20 }).provider, 'system', 'a system reading in progress stays system');
  fallback.playback('idle');
  assert.equal(fallback.speaking({ ...config, fishMonthlyCapUsd: 20 }).provider, 'fish', 'limit raised: Drama 3 again');
  assert.equal(fallback.speaking(config).provider, 'system');
  now = new Date('2026-12-01T00:00:01');
  assert.equal(fallback.speaking(config).provider, 'fish', 'a new month: Drama 3 again');
  assert.equal(fallback.update({ month: 'x', bytes: -1 }), null, 'malformed pushes are ignored');
  assert.equal(fishBudgetExhausted(null, 10, now), false);
  assert.equal(fishMonthKey(new Date('2026-01-05T00:00:00')), '2026-01');
  const bailian = { ...DEFAULT_TTS_CONFIG, provider: 'bailian' as const };
  now = new Date('2026-11-20T10:00:00');
  assert.equal(fallback.speaking(bailian).provider, 'bailian', 'other voices are never touched');
});

// --- 4. Settings and the key -----------------------------------------------------------------------------------------

const secrets: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: bytes => { if (!bytes.toString().startsWith('encrypted:')) throw new Error('bad'); return bytes.toString().slice(10); },
};

test('config validation: fish is only a choice, voice id and limit are bounded, an absent key means "keep"', () => {
  assert.equal(validateTtsConfig({ provider: 'fish' }).provider, 'fish');
  assert.equal(validateTtsConfig({ provider: 'elevenlabs' }).provider, 'system');
  assert.equal(validateTtsConfig({}).provider, 'system', 'off unless chosen');
  assert.equal(DEFAULT_TTS_CONFIG.provider, 'system');
  assert.equal(validateTtsConfig({ fishVoiceId: 'abc_DEF-123' }).fishVoiceId, 'abc_DEF-123');
  for (const bad of ['has space', 'a/b', '../x', 'x'.repeat(129), 'a\u0000b'])
    assert.throws(() => validateTtsConfig({ fishVoiceId: bad }), TtsError, bad);
  assert.equal(validateTtsConfig({ fishMonthlyCapUsd: 25 }).fishMonthlyCapUsd, 25);
  assert.equal(validateTtsConfig({ fishMonthlyCapUsd: -5 }).fishMonthlyCapUsd, 0);
  assert.equal(validateTtsConfig({ fishMonthlyCapUsd: 'lots' }).fishMonthlyCapUsd, 0);
  assert.equal(validateTtsConfig({ fishMonthlyCapUsd: 10 }).fishMonthlyCapUsd, 10, 'a limit already saved stays');
  assert.equal(validateTtsConfig({}).fishApiKey, KEY_SENTINEL, 'absent: resolved to the saved key, never "clear"');
  assert.equal(validateTtsConfig({ fishApiKey: '' }).fishApiKey, '');
  const previous = fishConfig();
  assert.equal(resolveTtsKey({ ...fishConfig(), fishApiKey: KEY_SENTINEL }, previous).fishApiKey, KEY, 'the empty box (redacted) keeps the key');
  assert.equal(resolveTtsKey({ ...fishConfig(), fishApiKey: undefined }, previous).fishApiKey, KEY, 'a save without the field keeps it');
  assert.equal(resolveTtsKey({ ...fishConfig(), fishApiKey: 'new-key' }, previous).fishApiKey, 'new-key');
  assert.equal(resolveTtsKey({ ...fishConfig(), fishApiKey: '' }, previous).fishApiKey, '', 'only an explicit empty string clears');
  assert.equal(resolveTtsKey({ ...fishConfig(), fishApiKey: KEY_SENTINEL }, undefined).fishApiKey, '');
  // Bailian's key is still bound to its host and region; the Drama 3 key is independent of both.
  const both = { ...fishConfig(), apiKey: 'bailian-key', apiHost: 'https://a.example', region: 'r' };
  const moved = resolveTtsKey({ ...both, apiKey: KEY_SENTINEL, fishApiKey: KEY_SENTINEL, apiHost: 'https://b.example' }, both);
  assert.deepEqual([moved.apiKey, moved.fishApiKey], ['', KEY]);
});

test('settings store: the Drama 3 key is encrypted on its own, redacted for windows, kept by an empty box, never read from plaintext', async t => {
  const directory = await tempProfile(t);
  const file = path.join(directory, 'settings.json');
  const store = new SettingsStore(directory, secrets, new AssetRegistry());
  const accepted = await store.save({ ...structuredClone(DEFAULT_SETTINGS), tts: { ...fishConfig(), apiKey: 'bailian-secret', apiHost: 'https://h.example', region: 'r' } });
  const raw = await readFile(file, 'utf8'), disk = JSON.parse(raw);
  assert.equal(raw.includes(KEY), false, 'no plaintext key on disk');
  assert.equal(disk.tts.fishApiKey, undefined);
  assert.equal(Buffer.from(disk.ttsFishApiKeyEncrypted, 'base64').toString(), `encrypted:${KEY}`);
  assert.equal(Buffer.from(disk.ttsApiKeyEncrypted, 'base64').toString(), 'encrypted:bailian-secret', 'Bailian keeps its own ciphertext');
  assert.equal(accepted.tts?.fishApiKey, KEY_SENTINEL);
  assert.equal(JSON.stringify(publicSettings(store.current)).includes(KEY), false);
  // A window saves what it was given (redacted) with an empty key box: the key stays.
  await store.save({ ...accepted, tts: { ...accepted.tts!, fishVoiceId: 'other' } });
  assert.equal(store.current.tts?.fishApiKey, KEY);
  assert.equal(store.current.tts?.fishVoiceId, 'other');
  // Reload on this machine: decrypted again.
  const reloaded = new SettingsStore(directory, secrets, new AssetRegistry());
  await reloaded.load();
  assert.equal(reloaded.current.tts?.fishApiKey, KEY);
  assert.equal(reloaded.current.tts?.provider, 'fish');
  // A plaintext field typed into the file by hand is never used as a key.
  const edited = JSON.parse(await readFile(file, 'utf8'));
  edited.tts.fishApiKey = 'typed-plaintext'; delete edited.ttsFishApiKeyEncrypted;
  await writeFile(file, JSON.stringify(edited));
  const handEdited = new SettingsStore(directory, secrets, new AssetRegistry());
  await handEdited.load();
  assert.equal(handEdited.current.tts?.fishApiKey, '');
  // 「清除已存 Key」 sends an explicit empty string.
  await store.save({ ...publicSettings(store.current), tts: { ...publicSettings(store.current).tts!, fishApiKey: '' } });
  assert.equal(store.current.tts?.fishApiKey, '');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).ttsFishApiKeyEncrypted, undefined);
  // No encryption on this machine: refused, never stored in plaintext.
  const plain = new SettingsStore(directory, { ...secrets, isEncryptionAvailable: () => false }, new AssetRegistry());
  await assert.rejects(plain.save({ ...structuredClone(DEFAULT_SETTINGS), tts: fishConfig() }), /Drama 3/);
});

// --- 5. Internal channel: never the key --------------------------------------------------------------------------------

const CARD = '0f8fad5b-d9cb-469f-a165-70867728950e';
function channel(tts: Partial<TtsConfig>) {
  let settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), model: { path: 'C:\\m\\aoi.pmx', url: 'local://aoi', name: 'aoi.pmx' } as any,
    tts: { ...structuredClone(DEFAULT_TTS_CONFIG), ...tts } as any };
  const cards = { activeId: CARD, cards: [{ id: CARD, name: '小桃', modelName: 'aoi.pmx' } as any] };
  const calls: string[] = [];
  const handlers: Record<string, (...args: any[]) => unknown> = {
    getSettings: () => structuredClone(settings),
    saveSettings: next => { calls.push('saveSettings'); settings = structuredClone(next); return settings; },
    getCharacterCards: () => structuredClone(cards),
    openControls: (page: unknown) => { calls.push(`openControls:${String(page)}`); },
  };
  const operations = new Map<string, IpcHandler>(Object.entries(handlers).map(([name, run]) => [name, (_event: any, ...args: unknown[]) => run(...args)]));
  const window = (id: number) => ({ isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { id, isDestroyed: () => false, send() {} } });
  const bridge = createHostBridge({ version: () => '0', controls: () => window(11), pet: () => window(12), operations,
    admit: (guard, run) => { guard(); return run(); }, importCharacterCard: async () => { throw new Error('x'); },
    loadModel: async () => { throw new Error('x'); }, commitPetBoolean: async () => { throw new Error('x'); },
    commitReadoutVolume: async () => { throw new Error('x'); }, commitBreath: async () => { throw new Error('x'); },
    replyLatency: () => [], broadcast: () => {}, interconnected: () => true });
  const registry = new AgentToolRegistry(createAppTools(bridge), { enabled: () => true, interconnect: () => true,
    confirm: async () => true, notice: () => {}, called: () => {} });
  return { call: (name: string, args: unknown): Promise<any> => registry.call(name, args), settings: () => settings, calls };
}

test('channel: set_voice_style sets the Drama 3 voice id and nothing secret; no argument can read or write a key or the limit', async () => {
  const h = channel({ provider: 'fish', fishApiKey: KEY, fishVoiceId: 'old', fishMonthlyCapUsd: 10 });
  const result = await h.call('set_voice_style', { voiceId: 'v2abc' });
  assert.ok(result.ok, JSON.stringify(result));
  // Step 2: the voice id belongs to this character + model (the global one stays as the fallback).
  const own = () => h.settings().tts?.styleBindings?.find(binding => binding.characterId === CARD)?.fishVoiceId;
  assert.equal(own(), 'v2abc');
  assert.equal(h.settings().tts?.fishVoiceId, 'old');
  assert.deepEqual([h.settings().tts?.fishApiKey, h.settings().tts?.fishMonthlyCapUsd, h.settings().tts?.provider], [KEY, 10, 'fish']);
  assert.equal(JSON.stringify(result).includes(KEY), false, 'the answer never carries the key');
  assert.ok((await h.call('set_voice_style', { voiceId: '' })).ok, 'empty: Drama 3 default voice');
  assert.equal(own(), '');
  const saves = h.calls.length;
  for (const bad of [{ fishApiKey: 'x' }, { apiKey: 'x' }, { key: 'x' }, { fishMonthlyCapUsd: 500 }, { cap: 500 }, { provider: 'fish' },
    { voiceId: 'has space' }, { voiceId: 'x'.repeat(129) }, { voiceId: 5 }]) {
    const refused = await h.call('set_voice_style', bad);
    assert.equal(refused.ok, false, JSON.stringify(bad));
  }
  assert.equal(h.calls.length, saves, 'nothing saved for refused input');
  // The tool's own check, apart from the catalog schema the registry also enforces.
  for (const bad of [{ fishApiKey: 'x' }, { voiceId: 'abc', fishApiKey: 'x' }, { apiKey: 'x' }, { rate: 1, apiKey: 'x' }, { fishMonthlyCapUsd: 5 }, { voiceId: 'abc', fishMonthlyCapUsd: 5 }, { provider: 'fish' }]) assert.throws(() => voiceStyleArgs(bad), JSON.stringify(bad));
  assert.deepEqual(voiceStyleArgs({ voiceId: 'abc' }), { voiceId: 'abc' });
  // Nothing in the whole catalog names a key-like property.
  for (const tool of AGENT_TOOLS) {
    const props = Object.keys((tool.inputSchema as any)?.properties ?? {});
    assert.equal(props.some(name => /key|secret|token|password|cap/iu.test(name)), false, `${tool.name}: ${props.join(',')}`);
  }
});

test('channel: switching to Drama 3 needs the user’s words and their own saved key; status shows the choice, never the key', async () => {
  const noKey = channel({ provider: 'system', fishApiKey: '' });
  const unasked = await noKey.call('set_setting', { id: 'voice_provider', value: 'fish' });
  assert.equal(!unasked.ok && unasked.error.code, 'needs_user_words', JSON.stringify(unasked));
  const refused = await noKey.call('set_setting', { id: 'voice_provider', value: 'fish', userWords: '换成 Drama 3 吧' });
  assert.equal(!refused.ok && refused.error.code, 'unavailable');
  assert.match(!refused.ok ? refused.error.message : '', /Key 不经过内部通道/);
  assert.equal(noKey.settings().tts?.provider, 'system');
  // The window/channel only ever sees the redacted key.
  const keyed = channel({ provider: 'system', fishApiKey: KEY_SENTINEL });
  const switched = await keyed.call('set_setting', { id: 'voice_provider', value: 'fish', userWords: '换成 Drama 3 吧' });
  assert.ok(switched.ok, JSON.stringify(switched));
  assert.equal(keyed.settings().tts?.provider, 'fish');
  const status = await keyed.call('get_status', {});
  assert.equal(status.result.voice.provider, 'fish');
  assert.match(status.result.voice.providerLabel, /Drama 3/);
  const real = channel({ provider: 'fish', fishApiKey: KEY });
  assert.equal(JSON.stringify(await real.call('get_status', {})).includes(KEY), false);
  // 带我去: the Drama 3 page is one more navigation target, nothing else.
  assert.ok(TAKE_ME_THERE_IDS.includes('fish-key'));
  assert.equal(TAKE_ME_THERE['fish-key'].leafId, 'voice-emotional');
  const opened = await real.call('open_control_page', { page: 'fish-key' });
  assert.ok(opened.ok, JSON.stringify(opened));
  assert.deepEqual(real.calls, ['openControls:fish-key']);
});

test('preload: the Drama 3 operations forward only their fixed channel and drop every argument', async () => {
  const { readFile: read } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const ts = (await import('typescript')).default;
  const source = await read(new URL('../electron/safety/preload.ts', import.meta.url), 'utf8');
  let api: any; const invokes: unknown[][] = [], subscriptions: unknown[][] = [];
  const context = { process: { platform: 'win32' }, require: () => ({
    contextBridge: { exposeInMainWorld: (_key: string, value: unknown) => { api = value; } },
    ipcRenderer: { invoke: (...args: unknown[]) => { invokes.push(args); return Promise.resolve(); },
      on: (...args: unknown[]) => { subscriptions.push(args); }, removeListener: () => {} } }), exports: {} };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  await api.getTtsBudget('x'); await api.openFishApiKeys('https://evil.example'); await api.openFishBilling({ url: 'x' });
  assert.deepEqual(invokes, [['desk:getTtsBudget'], ['desk:openFishApiKeys'], ['desk:openFishBilling']]);
  api.onTtsBudget(() => {});
  assert.equal(subscriptions[0][0], 'desk:tts-budget');
  const fishish = Object.keys(api).filter(name => /fish|ttsbudget/iu.test(name)).sort();
  assert.deepEqual(fishish, ['getTtsBudget', 'onTtsBudget', 'openFishApiKeys', 'openFishBilling'], 'no key getter or setter in the window API');
});

// --- 6. The two fixed pages --------------------------------------------------------------------------------------------

test('only the two fixed fish.audio pages can be opened, by operations that take no argument', async () => {
  const registered = new Map<string, { run: (...args: unknown[]) => unknown; controlOnly?: boolean }>();
  const opened: string[] = [];
  const budget = new FishBudget({ directory: () => null, now: () => new Date('2026-11-10T00:00:00') });
  registerFishVoiceIpc((method, run, controlOnly) => registered.set(method, { run, controlOnly }), budget, url => { opened.push(url); });
  assert.deepEqual([...registered.keys()], [...FISH_VOICE_METHODS]);
  assert.equal(registered.get('getTtsBudget')!.controlOnly, false, 'both windows read the month');
  assert.equal(registered.get('openFishApiKeys')!.controlOnly, true);
  assert.equal(registered.get('openFishBilling')!.controlOnly, true);
  await registered.get('openFishApiKeys')!.run();
  await registered.get('openFishBilling')!.run();
  assert.deepEqual(opened, ['https://fish.audio/app/api-keys/', 'https://fish.audio/app/developers/billing/']);
  assert.deepEqual(opened, [FISH_API_KEYS_URL, FISH_BILLING_URL]);
  assert.throws(() => registered.get('openFishBilling')!.run('https://evil.example'), /不接受参数/);
  assert.throws(() => registered.get('getTtsBudget')!.run({ month: '2026-01' }), /不接受参数/);
  await assert.rejects(openFishPage('https://evil.example/', url => { opened.push(url); }), /不能打开/);
  assert.equal(opened.length, 2);
  assert.deepEqual(registered.get('getTtsBudget')!.run(), { month: '2026-11', bytes: 0, spentMicroUsd: 0 });
});


// With no limit (0) Drama 3 is never refused for the month and never shows the
// "limit reached" notice; only the prepaid Fish Audio balance bounds it.
test('no monthly limit: every request is admitted, no notice, never "exhausted"', async t => {
  const { fishBudgetExhausted, fishCapMicroUsd } = await import('../shared/voice/fish-voice');
  assert.equal(fishCapMicroUsd(0), Number.POSITIVE_INFINITY);
  assert.equal(fishCapMicroUsd(undefined), Number.POSITIVE_INFINITY, 'the default is no limit');
  assert.equal(fishCapMicroUsd(10), 10_000_000);
  const directory = await tempProfile(t);
  const now = new Date('2026-11-24T13:00:00');
  const pushes: any[] = [];
  const budget = new FishBudget({ directory: () => directory, now: () => now, publish: view => pushes.push(view) });
  for (let i = 0; i < 20; i++) { assert.equal(budget.admit(0, 'r' + i), true); budget.record(100_000, 0, 'r' + i); } // $20 at the launch price
  assert.equal(budget.admit(0), true, 'still admitted after $20 with no limit');
  assert.equal(pushes.some(view => view.notice), false, 'no "limit reached" notice');
  assert.equal(fishBudgetExhausted(budget.view(), 0, now), false);
  assert.equal(fishBudgetExhausted(budget.view(), 10, now), true, 'a $10 limit is still a limit');
  assert.equal(budget.admit(10, 'next'), false, 'and refuses a new reply once reached');
  await budget.flush();
});
