import assert from 'node:assert/strict';
import test from 'node:test';
import { AmbientAudioRuntime, type AmbientRuntimeState, type AmbientRuntimeSubmission } from '../electron/ambient-audio-runtime';
import type { AmbientLanguage, AmbientScope, AmbientTranscript, AmbientTranscriptInput } from '../shared/ambient-audio';
import type { VoiceInputConfig } from '../shared/contracts';
import { encodeWav } from '../src/ui/MediaInput';

const language: AmbientLanguage = { status: 'detected', language: 'ja', source: 'provider' };
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options: { drainTimeoutSignal?: (milliseconds: number) => AbortSignal } = {}) {
  let now = 10_000, visible = true, available = true, dispatchAllowed = true, speaking = false, context = 'character-a:provider-a:conversation-a:model-a', id = 0;
  let scope: AmbientScope = { characterId: 'character-a', providerScope: 'provider-a' };
  const config: VoiceInputConfig = { baseUrl: 'https://private.example/v1', model: 'verified-test-asr', language: '', apiKey: 'fake-private-key' };
  const calls: { config: VoiceInputConfig; wav: ArrayBuffer; signal: AbortSignal }[] = [];
  const writes: { scope: AmbientScope; input: AmbientTranscriptInput }[] = [];
  const records = new Map<string, AmbientTranscript>(), published: AmbientTranscript[] = [], states: AmbientRuntimeState[] = [];
  const cleared: Array<AmbientScope | undefined> = [];
  const invalidated: AmbientScope[] = [];
  let transcribe = async (_config: VoiceInputConfig, _wav: ArrayBuffer, _signal: AbortSignal): Promise<{ text: string; language: AmbientLanguage }> => ({ text: 'これは映画の台詞です。', language });
  let append = async (scope: AmbientScope, input: AmbientTranscriptInput) => {
    writes.push({ scope, input });
    const existing = records.get(input.id);
    if (existing) return { record: existing, inserted: false };
    const record: AmbientTranscript = { ...structuredClone(input), title: input.title ?? '映画の台詞', tags: input.tags ?? ['system-audio', input.mode], source: 'system-audio', createdAt: now };
    records.set(input.id, record); return { record, inserted: true };
  };
  const runtime = new AmbientAudioRuntime({
    getScope: () => scope, getContextIdentity: () => context, getVoiceConfig: () => config,
    canStart: owner => owner === 7 && visible, canTranscribe: () => available, canDispatch: () => dispatchAllowed, isSpeaking: () => speaking,
    transcribe: (input, wav, signal) => { calls.push({ config: input, wav, signal }); return transcribe(input, wav, signal); },
    store: { append: (scope, input) => append(scope, input), clearTransient: value => { cleared.push(value); },
      invalidatePendingTransient: value => { invalidated.push(value); } },
    onTranscript: record => published.push(record), onState: state => states.push(state), now: () => now, createId: () => `session-${++id}`,
    drainTimeoutSignal: options.drainTimeoutSignal,
  });
  const begin = (mode: 'music' | 'movie' = 'movie') => runtime.begin(7, mode);
  const packet = (sequence = 1, startOffsetMs = 0, endOffsetMs = 1000, sessionId = runtime.getState().sessionId!): AmbientRuntimeSubmission => ({
    sessionId, sequence, startOffsetMs, endOffsetMs, wav: encodeWav(new Float32Array((endOffsetMs - startOffsetMs) * 16).fill(0.1)),
  });
  return { runtime, calls, writes, records, published, states, cleared, invalidated, config, begin, packet,
    setNow: (value: number) => { now = value; }, setVisible: (value: boolean) => { visible = value; },
    setAvailable: (value: boolean) => { available = value; }, setSpeaking: (value: boolean) => { speaking = value; },
    setDispatchAllowed: (value: boolean) => { dispatchAllowed = value; },
    setContext: (value: string) => { context = value; }, setScope: (value: AmbientScope) => { scope = value; },
    setTranscribe: (value: typeof transcribe) => { transcribe = value; }, setAppend: (value: typeof append) => { append = value; },
  };
}

test('runtime starts off; only a visible pet owner can explicitly choose music or movie', () => {
  const f = fixture(); assert.equal(f.runtime.getState().active, false);
  assert.equal(f.runtime.currentSession(), null); assert.equal(f.calls.length, 0);
  assert.throws(() => f.runtime.begin(8, 'movie'), /可见桌宠/);
  assert.throws(() => f.runtime.begin(7, 'other'), /听音乐或陪看电影/);
  f.setVisible(false); assert.throws(() => f.begin(), /可见桌宠/);
  f.setVisible(true); const state = f.begin('music');
  assert.equal(state.active, true); assert.equal(state.mode, 'music'); assert.equal(state.startedAt, 10_000);
  assert.equal(state.origin, 'system-audio'); assert.equal(f.calls.length, 0);
  assert.ok(!('owner' in state) && !('scope' in state) && !('contextIdentity' in state));
  const host = f.runtime.currentSession()!; assert.equal(host.owner, 7); host.scope.characterId = 'modified';
  assert.equal(f.runtime.currentSession()!.scope.characterId, 'character-a');
  assert.ok(!JSON.stringify([state, host]).includes('fake-private-key'));
});

test('capture readiness starts its own host clock once, after delayed capture; stale or foreign acknowledgements cannot reset it', () => {
  const f = fixture(), initial = f.begin();
  assert.equal(f.runtime.currentSession()!.captureReadyAt, null);
  f.setNow(45_000);
  assert.throws(() => f.runtime.confirmCapture(8, initial.sessionId), /失效/);
  assert.throws(() => f.runtime.confirmCapture(7, 'old-session'), /失效/);
  f.runtime.confirmCapture(7, initial.sessionId);
  assert.equal(f.runtime.currentSession()!.captureReadyAt, 45_000);
  assert.equal(f.runtime.currentSession()!.startedAt, 10_000, 'the WAV timeline keeps the original host session clock');
  assert.ok(!('captureReadyAt' in f.runtime.getState()), 'readiness is host-only');
  f.setNow(55_000); f.runtime.confirmCapture(7, initial.sessionId);
  assert.equal(f.runtime.currentSession()!.captureReadyAt, 45_000, 'repeated acknowledgements cannot renew or advance grace');
  const next = f.begin();
  assert.throws(() => f.runtime.confirmCapture(7, initial.sessionId), /失效/);
  assert.equal(f.runtime.currentSession()!.captureReadyAt, null);
  f.setVisible(false); assert.throws(() => f.runtime.confirmCapture(7, next.sessionId), /失效/);
});

test('submit derives identity, scope and absolute times in the host, preserving exact final text and detected metadata', async () => {
  const f = fixture(); const state = f.begin('movie'); f.setNow(11_100);
  const result = await f.runtime.submit(7, f.packet());
  assert.deepEqual(result, { status: 'accepted', sessionId: state.sessionId, sequence: 1, recordId: `${state.sessionId}:1`, inserted: true });
  assert.equal(f.writes.length, 1); assert.equal(f.published.length, 1);
  assert.deepEqual(f.writes[0].scope, { characterId: 'character-a', providerScope: 'provider-a' });
  assert.deepEqual(f.writes[0].input, { id: `${state.sessionId}:1`, sessionId: state.sessionId, mode: 'movie', startedAt: 10_000, endedAt: 11_000,
    text: 'これは映画の台詞です。', language });
  assert.equal(f.calls[0].config.language, ''); assert.notEqual(f.calls[0].config, f.config);
  f.calls[0].config.apiKey = 'changed-only-dispatch'; assert.equal(f.config.apiKey, 'fake-private-key');
  assert.equal(f.runtime.getState().reason, 'listening');
});

test('whole-only language fallback stays labelled in durable tags without archiving raw decoder data', async () => {
  const f = fixture(); f.begin(); f.setNow(11_100);
  f.setTranscribe(async () => ({ text: 'whole original', language,
    languageDetection: { version: 2, scope: 'whole-result', windowAnalysis: 'failed' } as const }));
  await f.runtime.submit(7, f.packet());
  assert.deepEqual(f.writes[0].input.tags, ['language-scope:whole-result', 'window-analysis:failed']);
  assert.equal(f.writes[0].input.text, 'whole original');
  assert.ok(!('languageDetection' in f.writes[0].input));
});

test('same-sequence retries share one request and commit; changed content cannot reuse the receipt', async () => {
  const f = fixture(), response = deferred<{ text: string; language: AmbientLanguage }>();
  f.setTranscribe(() => response.promise); f.begin(); f.setNow(11_000);
  const packet = f.packet(), first = f.runtime.submit(7, packet), duplicate = f.runtime.submit(7, packet);
  assert.equal(first, duplicate); assert.equal(f.calls.length, 1);
  const changed = { ...packet, wav: encodeWav(new Float32Array(16000).fill(0.3)) };
  assert.throws(() => f.runtime.submit(7, changed), /不能更换内容/);
  response.resolve({ text: 'same original text', language });
  const accepted = await first; assert.deepEqual(await duplicate, accepted);
  assert.deepEqual(await f.runtime.submit(7, packet), accepted);
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.published.length, 1);
});

test('foreign windows and tokens cannot transcribe or cancel the active pet session', async () => {
  const f = fixture(); f.begin(); f.setNow(11_000);
  assert.throws(() => f.runtime.submit(8, f.packet()), /没有当前/);
  assert.throws(() => f.runtime.submit(7, { ...f.packet(), sessionId: 'forged-session' }), /不属于/);
  assert.throws(() => f.runtime.stop(8), /未开启/);
  f.runtime.dropOwner(8); assert.equal(f.runtime.getState().active, true);
  f.runtime.dropOwner(7); assert.equal(f.runtime.getState().active, false);
  assert.equal(f.calls.length, 0);
});

test('single global in-flight slot prevents competing ASR requests without consuming the rejected sequence', async () => {
  const f = fixture(), response = deferred<{ text: string; language: AmbientLanguage }>();
  f.setTranscribe(() => response.promise); f.begin(); f.setNow(12_000);
  const first = f.runtime.submit(7, f.packet());
  assert.throws(() => f.runtime.submit(7, f.packet(2, 1000, 2000)), /上一段/);
  assert.equal(f.calls.length, 1);
  response.resolve({ text: 'first', language }); await first;
  f.setTranscribe(async () => ({ text: 'second', language }));
  assert.equal((await f.runtime.submit(7, f.packet(2, 1000, 2000))).status, 'accepted');
  assert.equal(f.calls.length, 2);
});

test('sequence gaps from renderer backpressure are allowed, reverse sequence or overlapping offsets are not', async () => {
  const f = fixture(); f.begin(); f.setNow(15_000);
  await f.runtime.submit(7, f.packet(1)); await f.runtime.submit(7, f.packet(4, 3000, 4000));
  assert.throws(() => f.runtime.submit(7, f.packet(3, 2000, 3000)), /顺序/);
  assert.throws(() => f.runtime.submit(7, f.packet(5, 3500, 4500)), /顺序/);
  assert.equal(f.calls.length, 2); assert.equal(f.writes.length, 2);
});

test('invalid metadata, future times, mismatched duration and noncanonical/overlong WAV never reach ASR', () => {
  const f = fixture(); f.begin(); f.setNow(30_000);
  const base = f.packet();
  for (const extra of [{ language: 'ja' }, { path: 'private.wav' }, { role: 'system' }, { instruction: 'override' }])
    assert.throws(() => f.runtime.submit(7, { ...base, ...extra }), /不能携带/);
  assert.throws(() => f.runtime.submit(7, { ...base, sequence: 0 }), /不属于/);
  assert.throws(() => f.runtime.submit(7, { ...base, endOffsetMs: 21_000 }), /时间/);
  assert.throws(() => f.runtime.submit(7, { ...base, endOffsetMs: 2000 }), /长度不一致/);
  const broken = base.wav.slice(0); new DataView(broken).setUint32(24, 48000, true);
  assert.throws(() => f.runtime.submit(7, { ...base, wav: broken }), /16 kHz/);
  assert.throws(() => f.runtime.submit(7, { ...base, wav: new ArrayBuffer(44 + 13 * 32000), endOffsetMs: 13_000 }), /时间|十二秒/);
  assert.equal(f.calls.length, 0);
});

test('WAV is snapshotted before async dispatch and no private config/audio appears in public state', async () => {
  const f = fixture(), response = deferred<{ text: string; language: AmbientLanguage }>();
  f.setTranscribe(() => response.promise); f.begin(); f.setNow(11_000);
  const packet = f.packet(), firstSample = new DataView(packet.wav).getInt16(44, true);
  const task = f.runtime.submit(7, packet); new Uint8Array(packet.wav).fill(0);
  assert.notEqual(f.calls[0].wav, packet.wav); assert.equal(new DataView(f.calls[0].wav).getInt16(44, true), firstSample);
  const publicSource = JSON.stringify(f.runtime.getState());
  assert.ok(!publicSource.includes('private.example') && !publicSource.includes('apiKey') && !publicSource.includes('wav'));
  response.resolve({ text: 'snapshot', language }); await task;
});

test('stop invalidates late ASR success and new session cannot overlap an abort-ignoring old dependency', async () => {
  const f = fixture(), response = deferred<{ text: string; language: AmbientLanguage }>();
  f.setTranscribe(() => response.promise); const old = f.begin(); f.setNow(11_000);
  const task = f.runtime.submit(7, f.packet()); f.runtime.stop(7);
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.runtime.getState().active, false);
  f.begin('music'); f.setNow(12_000);
  assert.throws(() => f.runtime.submit(7, f.packet()), /上一段/);
  response.resolve({ text: 'stale', language }); assert.equal((await task).status, 'cancelled');
  assert.equal(f.writes.length, 0); assert.equal(f.published.length, 0);
  f.setTranscribe(async () => ({ text: 'new current', language }));
  assert.equal((await f.runtime.submit(7, f.packet())).status, 'accepted');
  assert.equal(f.writes[0].input.sessionId, f.runtime.getState().sessionId);
  assert.notEqual(f.writes[0].input.sessionId, old.sessionId);
});

test('context/scope/visibility changes fresh-invalidate state and cannot submit old audio', () => {
  for (const change of ['context', 'scope', 'visibility'] as const) {
    const f = fixture(); f.begin(); f.setNow(11_000); const packet = f.packet();
    if (change === 'context') f.setContext('new-conversation');
    if (change === 'scope') f.setScope({ characterId: 'different', providerScope: 'provider-a' });
    if (change === 'visibility') f.setVisible(false);
    assert.equal(f.runtime.currentSession(), null); assert.equal(f.runtime.getState().active, false);
    assert.throws(() => f.runtime.submit(7, packet), /没有当前/); assert.equal(f.calls.length, 0);
    assert.equal(f.cleared.length, 1);
  }
});

test('scope changes while ASR awaits discard final text before archive and clear old transient context', async () => {
  const f = fixture(), response = deferred<{ text: string; language: AmbientLanguage }>();
  f.setTranscribe(() => response.promise); f.begin(); f.setNow(11_000);
  const task = f.runtime.submit(7, f.packet()); f.setContext('new-model');
  response.resolve({ text: 'old model result', language }); assert.equal((await task).status, 'cancelled');
  assert.equal(f.writes.length, 0); assert.equal(f.published.length, 0); assert.equal(f.runtime.getState().active, false);
});

test('already-started durable append may finish after stop but cannot publish or reactivate its session', async () => {
  const f = fixture(), commit = deferred<{ record: AmbientTranscript; inserted: boolean }>();
  let writing: AmbientTranscriptInput | null = null;
  f.setAppend(async (scope, input) => { f.writes.push({ scope, input }); writing = input; return commit.promise; });
  f.begin(); f.setNow(11_000); const task = f.runtime.submit(7, f.packet()); await tick();
  assert.ok(writing); assert.equal(f.writes.length, 1); f.runtime.stop(7);
  const record: AmbientTranscript = { ...f.writes[0].input, title: 'durable', tags: ['system-audio', 'movie'], createdAt: 11_000, source: 'system-audio' };
  commit.resolve({ record, inserted: true }); assert.equal((await task).status, 'cancelled');
  assert.equal(f.published.length, 0); assert.equal(f.runtime.getState().active, false); assert.equal(f.cleared.length, 1);
});

test('TTS suspension aborts only pending transient work while preserving accepted context and explicit session consent', async () => {
  const f = fixture(), response = deferred<{ text: string; language: AmbientLanguage }>();
  f.setTranscribe(() => response.promise); const initial = f.begin(); f.setNow(12_000);
  const first = f.runtime.submit(7, f.packet()); f.runtime.setSuspended(true);
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.runtime.getState().active, true);
  assert.equal(f.runtime.getState().reason, 'speaking'); assert.equal(f.runtime.getState().sessionId, initial.sessionId);
  response.resolve({ text: 'late before speech', language }); assert.equal((await first).status, 'cancelled');
  const paused = await f.runtime.submit(7, f.packet(2, 1000, 2000)); assert.equal(paused.status, 'paused');
  assert.equal(f.calls.length, 1); assert.equal(f.cleared.length, 0);
  assert.deepEqual(f.invalidated, [{ characterId: 'character-a', providerScope: 'provider-a' }]);
  f.runtime.setSuspended(true); assert.equal(f.invalidated.length, 1, 'repeated speaking state does not invalidate another generation');
  f.runtime.setSuspended(false); f.setNow(13_000); f.setTranscribe(async () => ({ text: 'external after speech', language }));
  assert.equal((await f.runtime.submit(7, f.packet(3, 2000, 3000))).status, 'accepted');
  assert.equal(f.calls.length, 2); assert.equal(f.published.length, 1);
  assert.equal(f.cleared.length, 0); assert.equal(f.invalidated.length, 1);
  f.runtime.stop(7); assert.equal(f.cleared.length, 1, 'a real stop still clears short context');
});

test('TTS invalidates an already-started append without clearing accepted history or publishing its late result', async () => {
  const f = fixture(), commit = deferred<{ record: AmbientTranscript; inserted: boolean }>();
  f.setAppend(async (scope, input) => { f.writes.push({ scope, input }); return commit.promise; });
  const initial = f.begin(); f.setNow(11_000);
  const task = f.runtime.submit(7, f.packet()); await tick();
  assert.equal(f.writes.length, 1); f.runtime.setSuspended(true);
  assert.equal(f.cleared.length, 0); assert.equal(f.invalidated.length, 1);
  assert.equal(f.calls[0].signal.aborted, true);
  const record: AmbientTranscript = { ...f.writes[0].input, title: 'durable while speaking', tags: ['system-audio', 'movie'], createdAt: 11_000, source: 'system-audio' };
  commit.resolve({ record, inserted: true }); assert.equal((await task).status, 'cancelled');
  assert.equal(f.published.length, 0); assert.equal(f.runtime.getState().sessionId, initial.sessionId);
  f.runtime.setSuspended(false); assert.equal(f.runtime.getState().reason, 'listening');
  f.runtime.stop(7); assert.equal(f.cleared.length, 1);
});

test('microphone ASR occupancy and actual speaking guard pause instead of acquiring their connection', async () => {
  for (const cause of ['microphone', 'speaking'] as const) {
    const f = fixture(); f.begin(); f.setNow(12_000);
    if (cause === 'microphone') f.setAvailable(false); else f.setSpeaking(true);
    assert.equal((await f.runtime.submit(7, f.packet())).status, 'paused'); assert.equal(f.calls.length, 0);
    assert.equal(f.runtime.getState().reason, cause === 'microphone' ? 'asr-busy' : 'speaking');
    f.setAvailable(true); f.setSpeaking(false);
    assert.equal((await f.runtime.submit(7, f.packet(2, 1000, 2000))).status, 'accepted');
  }
});

test('ASR metadata is trusted only through host validation; unknown is explicit and silence invents no text', async () => {
  const f = fixture(); f.begin(); f.setNow(13_000);
  f.setTranscribe(async () => ({ text: 'uncertain final text', language: { status: 'unknown', source: 'unverified' } }));
  await f.runtime.submit(7, f.packet()); assert.deepEqual(f.writes[0].input.language, { status: 'unknown', source: 'unverified' });
  f.setTranscribe(async () => ({ text: '   ', language }));
  assert.equal((await f.runtime.submit(7, f.packet(2, 1000, 2000))).status, 'empty'); assert.equal(f.writes.length, 1);
  f.setTranscribe(async () => ({ text: 'fake metadata', language: { status: 'detected', language: 'ja', source: 'script-guess', confidence: 1 } as unknown as AmbientLanguage }));
  await assert.rejects(f.runtime.submit(7, f.packet(3, 2000, 3000)), /转写未完成/);
  assert.equal(f.writes.length, 1);
});

test('durable or provider failures expose only fixed messages and cannot retrigger the same segment', async () => {
  const f = fixture(); f.begin(); f.setNow(12_000);
  f.setAppend(async () => { throw new Error('private directory and credential must not escape'); });
  const packet = f.packet(); await assert.rejects(f.runtime.submit(7, packet), /文字未能保存/);
  assert.equal(f.runtime.getState().reason, 'archive-error'); assert.equal(f.published.length, 0);
  await assert.rejects(f.runtime.submit(7, packet), /文字未能保存/); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.runtime.getState()).includes('private directory'));
  f.setTranscribe(async () => { throw new Error('private transport credentials'); });
  await assert.rejects(f.runtime.submit(7, f.packet(2, 1000, 2000)), /转写未完成/);
  assert.equal(f.runtime.getState().reason, 'recognition-error');
});

test('expired duplicate receipts reject without replay and current-session identity never contains cached config', async () => {
  const f = fixture(); f.begin(); const first = f.packet();
  for (let index = 1; index <= 34; index++) { f.setNow(10_000 + index * 1000); await f.runtime.submit(7, f.packet(index, (index - 1) * 1000, index * 1000)); }
  assert.throws(() => f.runtime.submit(7, first), /顺序/); assert.equal(f.calls.length, 34);
  const host = f.runtime.currentSession()!; assert.ok(!('apiKey' in host) && !('config' in host));
  assert.equal(host.contextIdentity, 'character-a:provider-a:conversation-a:model-a');
});

test('microphone handoff aborts ambient ASR but waits for actual receipt settlement before release', async () => {
  const timeout = new AbortController(), response = deferred<{ text: string; language: AmbientLanguage }>();
  const deadlines: number[] = [];
  const f = fixture({ drainTimeoutSignal: milliseconds => { deadlines.push(milliseconds); return timeout.signal; } });
  f.setTranscribe(() => response.promise); const initial = f.begin(); f.setNow(11_000);
  const request = f.runtime.submit(7, f.packet());
  let microphoneMayStart = false;
  const draining = f.runtime.pauseAndDrain().then(() => { microphoneMayStart = true; });
  await tick();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(microphoneMayStart, false);
  assert.deepEqual(deadlines, [2000]); assert.equal(f.runtime.getState().suspended, true);
  response.reject(new Error('dependency reports abort after its own cleanup'));
  await draining; assert.equal(microphoneMayStart, true); assert.equal((await request).status, 'cancelled');
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0); assert.equal(f.published.length, 0);
  assert.equal(f.runtime.getState().sessionId, initial.sessionId); assert.equal(f.cleared.length, 0);
  assert.equal(f.invalidated.length, 1);
});

test('two-second handoff deadline rejects without admitting a second request when ambient abort is ignored', async () => {
  const timeout = new AbortController(), response = deferred<{ text: string; language: AmbientLanguage }>();
  const deadlines: number[] = [];
  const f = fixture({ drainTimeoutSignal: milliseconds => { deadlines.push(milliseconds); return timeout.signal; } });
  f.setTranscribe(() => response.promise); f.begin(); f.setNow(12_000);
  const request = f.runtime.submit(7, f.packet());
  let microphoneMayStart = false;
  const draining = f.runtime.pauseAndDrain().then(() => { microphoneMayStart = true; });
  const rejected = assert.rejects(draining, error => error instanceof Error && error.message === '系统声音转写仍在结束，请稍后重试语音输入');
  await tick(); assert.deepEqual(deadlines, [2000]); timeout.abort(new Error('private timeout reason must not escape'));
  await rejected; assert.equal(microphoneMayStart, false); assert.equal(f.calls[0].signal.aborted, true);
  // The caller's finally may remove its suspension, but an ignored abort still owns the slot.
  f.runtime.setSuspended(false);
  assert.throws(() => f.runtime.submit(7, f.packet(2, 1000, 2000)), /上一段系统声音仍在结束/);
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 0);
  response.resolve({ text: 'too late', language }); assert.equal((await request).status, 'cancelled');
  assert.equal(f.published.length, 0); assert.equal(f.runtime.getState().active, true);
});

test('entry rate limiting closes during fast ASR without cancelling its accepted archive or replaying the next paused segment', async () => {
  const f = fixture(); f.begin(); f.setNow(12_000);
  f.setTranscribe(async () => { f.setDispatchAllowed(false); return { text: 'fast successful original', language }; });
  const packet = f.packet();
  const first = await f.runtime.submit(7, packet);
  assert.equal(first.status, 'accepted'); assert.equal(first.inserted, true);
  assert.equal(f.writes.length, 1); assert.equal(f.published.length, 1); assert.equal(f.calls.length, 1);
  assert.equal(f.writes[0].input.text, 'fast successful original'); assert.equal(f.runtime.getState().reason, 'asr-busy');
  assert.deepEqual(await f.runtime.submit(7, packet), first, 'a successful retry remains available during entry cooldown');
  assert.equal((await f.runtime.submit(7, f.packet(2, 1000, 2000))).status, 'paused');
  assert.equal(f.calls.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.published.length, 1);
});

test('entry failure backoff preserves the real error receipt and accepts a later new sequence when reopened', async () => {
  const f = fixture(); f.begin(); f.setNow(13_000);
  f.setTranscribe(async () => { f.setDispatchAllowed(false); throw new Error('provider error with private transport detail'); });
  const packet = f.packet();
  await assert.rejects(f.runtime.submit(7, packet), /系统声音转写未完成/);
  assert.equal(f.runtime.getState().reason, 'recognition-error'); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 1);
  await assert.rejects(f.runtime.submit(7, packet), /系统声音转写未完成/);
  assert.equal(f.calls.length, 1, 'same sequence may not retry the provider even during backoff');
  assert.equal((await f.runtime.submit(7, f.packet(2, 1000, 2000))).status, 'paused'); assert.equal(f.calls.length, 1);
  f.setDispatchAllowed(true); f.setTranscribe(async () => ({ text: 'new original after retry window', language }));
  const next = await f.runtime.submit(7, f.packet(3, 2000, 3000));
  assert.equal(next.status, 'accepted'); assert.equal(f.calls.length, 2); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].input.text, 'new original after retry window'); assert.equal(f.published.length, 1);
});
