import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceOutput, type VoiceOutputEvent, type VoiceOutputPlaybackState } from '../src/ui/VoiceOutput';
import { StreamingVoicePlayer } from '../src/ui/EmotionalVoice';
import { SpeechRuntime } from '../electron/speech-runtime';
import { ReplySpeechStyles } from '../electron/speech-emotion';
import { DEFAULT_TTS_CONFIG } from '../shared/tts';

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const voice = { enabled: true, voiceURI: 'synthetic-zh', rate: 1, volume: 0.6 };
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

class SyntheticUtterance {
  voice: unknown = null; lang = ''; rate = 1; volume = 1;
  onstart: (() => void) | null = null; onend: (() => void) | null = null;
  onerror: ((event?: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}

function systemHarness() {
  const originals = new Map(['speechSynthesis', 'SpeechSynthesisUtterance'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const utterances: SyntheticUtterance[] = [], speaking: boolean[] = [], errors: string[] = [];
  let throwNext = false;
  let nextAction: ((utterance: SyntheticUtterance) => void) | undefined;
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', { configurable: true, value: SyntheticUtterance });
  Object.defineProperty(globalThis, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => [{ voiceURI: 'synthetic-zh', lang: 'zh-CN' }],
    speak(u: SyntheticUtterance) { utterances.push(u); if (throwNext) { throwNext = false; throw Error('synthetic backend failure'); } const action = nextAction; nextAction = undefined; action?.(u); },
    cancel() { /* Explicit stop invalidates the real SpeechOutput owner before engine callbacks. */ },
  } });
  const output = new VoiceOutput({ getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG }), getVoiceConfig: () => voice,
    api: { synthesizeSpeech: async () => { throw Error('cloud must not be used'); }, cancelSpeech: async () => {}, onSpeechEvent: () => () => {} },
    onSpeaking: active => speaking.push(active), onError: message => errors.push(message), createId: (() => { let i = 0; return () => `system-${++i}`; })(),
  });
  return { output, utterances, speaking, errors, throwNext() { throwNext = true; }, nextSpeak(action: (utterance: SyntheticUtterance) => void) { nextAction = action; }, restore() { output.dispose(); for (const [name, original] of originals) { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); } } };
}

test('real system output waits for start/end in each of three unchanged-config turns', async () => {
  const h = systemHarness();
  try {
    for (let turn = 0; turn < 3; turn++) {
      let finished = false;
      const completion = h.output.speak(`public turn ${turn}`, voice).then(() => { finished = true; });
      await flush(); assert.equal(finished, false);
      const u = h.utterances[turn]; assert.equal(u.volume, 0.6); assert.equal(u.rate, 1);
      u.onstart?.(); await flush(); assert.equal(finished, false); assert.equal(h.speaking.at(-1), true);
      u.onend?.(); await completion; assert.equal(h.speaking.at(-1), false);
    }
    assert.equal(h.utterances.length, 3); assert.deepEqual(h.errors, []);
  } finally { h.restore(); }
});

test('second system engine error is observable as failure and does not prevent third-turn playback', async () => {
  const h = systemHarness();
  try {
    const first = h.output.speak('first successful turn', voice);
    h.utterances[0].onstart?.(); h.utterances[0].onend?.(); await first;
    const second = h.output.speak('second failed turn', voice);
    const rejected = assert.rejects(second, /系统语音/);
    h.utterances[1].onerror?.({ error: 'audio-busy' });
    await rejected; assert.equal(h.errors.length, 1); assert.equal(h.speaking.at(-1), false);
    const third = h.output.speak('third recovered turn', voice);
    const current = h.utterances[2]; current.onstart?.();
    h.utterances[1].onstart?.(); h.utterances[1].onend?.();
    assert.equal(h.speaking.at(-1), true, 'late old events cannot finish the new utterance');
    current.onend?.(); await third;
    assert.equal(h.errors.length, 1); assert.equal(h.speaking.at(-1), false);
  } finally { h.restore(); }
});

test('system synchronous engine throw and an end-before-start are failures, while explicit stop still settles quietly', async () => {
  const h = systemHarness();
  try {
    h.throwNext(); await assert.rejects(h.output.speak('throw', voice), /系统语音/);
    const noStart = h.output.speak('never started', voice);
    const noStartRejected = assert.rejects(noStart, /系统语音/);
    h.utterances[1].onend?.(); await noStartRejected;
    const cancelled = h.output.speak('explicitly stopped', voice);
    h.output.stop(); h.utterances[2].onerror?.({ error: 'canceled' }); await cancelled;
    assert.equal(h.errors.length, 2);
  } finally { h.restore(); }
});

class SyntheticSource {
  buffer: { duration: number; samples: Float32Array } | null = null;
  onended: (() => void) | null = null; started = false; stopped = 0; disconnected = 0;
  connect() {} disconnect() { this.disconnected++; }
  start(_at: number) { this.started = true; }
  stop() { this.stopped++; }
  end() { this.onended?.(); }
}
class SyntheticAudioContext {
  state = 'suspended'; currentTime = 1; baseLatency = 0; outputLatency = 0; destination = {};
  sources: SyntheticSource[] = []; closed = 0; resumes = 0; gainDisconnected = 0;
  constructor(private readonly failResume: boolean) {}
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect: () => { this.gainDisconnected++; } }; }
  createBuffer(_channels: number, frames: number, rate: number) {
    const samples = new Float32Array(frames); return { duration: frames / rate, samples, getChannelData: () => samples };
  }
  createBufferSource() { const source = new SyntheticSource(); this.sources.push(source); return source; }
  async resume() { this.resumes++; if (this.failResume) throw Error('synthetic resume rejected'); this.state = 'running'; }
  async close() { this.state = 'closed'; this.closed++; }
}

function cloudHarness(options: { styles?: ReplySpeechStyles } = {}) {
  let listener: ((event: VoiceOutputEvent) => void) | undefined, ids = 0;
  const contexts: SyntheticAudioContext[] = [], errors: string[] = [], speaking: boolean[] = [];
  const states: VoiceOutputPlaybackState[] = [], releases: string[] = [], cancellations: string[] = [];
  const resolvedContexts: unknown[] = [], releaseResults: boolean[] = [], releaseGates: ReturnType<typeof deferred>[] = [];
  const calls: { emit: (event: any) => void | Promise<void>; transport: ReturnType<typeof deferred>; signal: AbortSignal }[] = [];
  let failNextResume = false;
  const config = { ...DEFAULT_TTS_CONFIG, provider: 'bailian' as const, apiHost: 'https://synthetic.invalid', region: 'synthetic', apiKey: 'public-test-key' };
  const runtime = new SpeechRuntime((owner, context) => {
    resolvedContexts.push(context && { ...context });
    return options.styles && context ? { ...config, ...options.styles.resolveStyle(owner, context.replyId, 'public-scope') } : config;
  }, (_owner, event) => listener?.(event), (_config, _text, signal, emit) => {
    const transport = deferred(); calls.push({ emit, transport, signal }); return transport.promise;
  });
  const output = new VoiceOutput({ getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: { synthesizeSpeech: (id, text, context) => runtime.speak(17, id, text, context),
      cancelSpeech: async id => { cancellations.push(id); const reply = runtime.recipientReply(17, id); if (runtime.cancel(17, id) && reply) options.styles?.cancel(reply); },
      releaseSpeech: async id => { releases.push(id); await releaseGates.shift()?.promise; releaseResults.push(runtime.release(17, id)); },
      onSpeechEvent(callback) { listener = callback; return () => { listener = undefined; }; } },
    onSpeaking: active => speaking.push(active), onState: state => states.push(state), onError: message => errors.push(message), createId: () => `cloud-${++ids}`,
    createPlayer: callbacks => new StreamingVoicePlayer({ ...callbacks, createContext() {
      const context = new SyntheticAudioContext(failNextResume); failNextResume = false; contexts.push(context); return context as unknown as AudioContext;
    } }),
  });
  const audio = async (index: number) => { await calls[index].emit({ type: 'audio', data: Buffer.from([0, 64, 0, 192]).toString('base64'), format: 'pcm_s16le', sampleRate: 24000, channels: 1, firstAudioMs: 3 }); await flush(); };
  const done = async (index: number) => { await calls[index].emit({ type: 'done', firstAudioMs: 3, audioBytes: 4 }); calls[index].transport.resolve(); await flush(); };
  return { runtime, output, contexts, calls, errors, speaking, states, releases, cancellations, releaseResults, releaseGates, resolvedContexts, audio, done, failResume() { failNextResume = true; }, dispose() { output.dispose(); for (const call of calls) call.transport.resolve(); runtime.stop(); } };
}

test('real runtime/output/PCM player drains all sources and releases owner after each of three replies', async () => {
  const h = cloudHarness();
  try {
    for (let turn = 0; turn < 3; turn++) {
      let completed = false;
      const completion = h.output.speak(`public cloud turn ${turn}`, voice, { replyId: `reply-${turn}` }).then(() => { completed = true; });
      await flush(); assert.equal(h.calls.length, turn + 1);
      await h.audio(turn); assert.equal(h.contexts[turn].resumes, 1);
      const source = h.contexts[turn].sources[0]; assert.equal(source.started, true);
      assert.deepEqual([...source.buffer!.samples], [0.5, -0.5]);
      await h.done(turn); assert.equal(completed, false, 'host completion does not count as playback drain');
      assert.equal(h.runtime.busy, true); assert.equal(h.contexts[turn].closed, 0);
      source.end(); await completion; await flush();
      assert.equal(h.runtime.busy, false); assert.equal(h.contexts[turn].closed, 1);
      assert.equal(source.stopped, 0, 'natural end is not a cancellation');
      assert.equal(h.speaking.at(-1), false);
    }
    assert.deepEqual(h.errors, []); assert.equal(h.contexts.length, 3);
  } finally { h.dispose(); }
});

test('a failed second PCM resume is reported and its in-flight synthesis aborted, then a fresh third session can drain', async () => {
  const h = cloudHarness();
  try {
    const first = h.output.speak('first', voice); await flush(); await h.audio(0); await h.done(0); h.contexts[0].sources[0].end(); await first; await flush();
    h.failResume(); await assert.rejects(h.output.speak('failed resume', voice), /resume/); await flush();
    // R02: synthesis starts in parallel with the device; a device failure aborts it.
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].signal.aborted, true);
    assert.equal(h.contexts[1].closed, 1); assert.equal(h.runtime.busy, false);
    const third = h.output.speak('recovered', voice); await flush(); await h.audio(2); await h.done(2);
    h.contexts[2].sources[0].end(); await third; await flush();
    assert.equal(h.runtime.busy, false); assert.equal(h.contexts[2].closed, 1);
    assert.equal(h.errors.length, 1);
  } finally { h.dispose(); }
});

test('three replies with two approved segments each preserve frozen styles through natural drain', async () => {
  const styles = new ReplySpeechStyles();
  const h = cloudHarness({ styles });
  try {
    for (let turn = 0; turn < 3; turn++) {
      const replyId = `public-reply-${turn}`;
      styles.begin(17, replyId, 'public-scope');
      styles.complete(17, replyId, 'public-scope', { context: 'neutral', primary: 'calm' }, { emotion: 'custom', instruction: `frozen public style ${turn}` });
      for (let segmentIndex = 0; segmentIndex < 2; segmentIndex++) {
        const inputContext = { replyId, segmentIndex };
        const completion = h.output.speak(`public segment ${segmentIndex}`, voice, inputContext);
        inputContext.segmentIndex = 127;
        await flush(); const call = turn * 2 + segmentIndex;
        assert.deepEqual(h.resolvedContexts[call], { replyId, segmentIndex });
        await h.audio(call); await h.done(call);
        assert.equal(h.releases.length, call, 'transport EOF must not release before the source ends');
        h.contexts[call].sources[0].end(); await completion; await flush();
        assert.equal(h.runtime.busy, false); assert.equal(h.releaseResults[call], true);
        assert.equal(styles.resolveStyle(17, replyId, 'public-scope').instruction, `frozen public style ${turn}`);
        const playing = h.states.filter(s => s.phase === 'playing').at(-1)!;
        assert.equal(playing.replyId, replyId); assert.equal(playing.segmentIndex, segmentIndex);
        assert.equal(playing.provider, 'bailian'); assert.ok(Number.isInteger(playing.generation));
      }
    }
    assert.equal(h.releases.length, 6); assert.deepEqual(h.cancellations, []); assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});

test('late release acknowledgement cannot finish or revoke a replacement reply', async () => {
  const styles = new ReplySpeechStyles(); const h = cloudHarness({ styles });
  try {
    styles.begin(17, 'old', 'public-scope'); styles.complete(17, 'old', 'public-scope', { context: 'neutral', primary: 'calm' }, { emotion: 'custom', instruction: 'old frozen' });
    const old = h.output.speak('old', voice, { replyId: 'old', segmentIndex: 0 });
    await flush(); await h.audio(0); await h.done(0);
    const gate = deferred(); h.releaseGates.push(gate); h.contexts[0].sources[0].end(); await flush();
    assert.equal(h.releases.length, 1); assert.equal(h.runtime.busy, true);
    styles.begin(17, 'new', 'public-scope'); styles.complete(17, 'new', 'public-scope', { context: 'positive', primary: 'happy' }, { emotion: 'custom', instruction: 'new frozen' });
    let newFinished = false;
    const next = h.output.speak('new', voice, { replyId: 'new', segmentIndex: 0 }).then(() => { newFinished = true; });
    await old; await flush(); gate.resolve(); await flush();
    assert.equal(newFinished, false); assert.equal(h.runtime.busy, true);
    assert.equal(styles.resolveStyle(17, 'new', 'public-scope').instruction, 'new frozen');
    await h.audio(1); await h.done(1); h.contexts[1].sources[0].end(); await next; await flush();
    assert.equal(h.runtime.busy, false); assert.equal(newFinished, true); assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});

test('runtime rejects malformed segment contexts without disturbing active routing and releases only ended exact recipients', async () => {
  const h = cloudHarness();
  try {
    const task = h.runtime.speak(17, 'active', 'public', { replyId: 'context', segmentIndex: 127 });
    assert.equal(h.runtime.recipientReply(17, 'active'), 'context');
    assert.equal(h.runtime.recipientReply(18, 'active'), null); assert.equal(h.runtime.recipientReply(17, 'other'), null);
    assert.equal(h.runtime.release(17, 'active'), false);
    for (const context of [
      { replyId: 'x', segmentIndex: -1 }, { replyId: 'x', segmentIndex: 128 }, { replyId: 'x', segmentIndex: 0.5 },
      { replyId: 'x', segmentIndex: undefined }, { replyId: 'x', segmentIndex: '0' },
      { replyId: 'x', segmentIndex: 0, extra: true }, { segmentIndex: 0 },
    ]) await assert.rejects(h.runtime.speak(17, 'bad', 'public', context as any), /回合|分段/);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, false);
    h.calls[0].transport.resolve(); await task;
    assert.equal(h.runtime.release(18, 'active'), false); assert.equal(h.runtime.release(17, 'other'), false);
    assert.equal(h.runtime.release(17, 'active'), true); assert.equal(h.runtime.release(17, 'active'), false);
    assert.equal(h.runtime.recipientReply(17, 'active'), null); assert.equal(h.runtime.busy, false);
  } finally { h.dispose(); }
});

test('promise system adapter false waits for terminal result, and an old rejection cannot affect a replacement', async () => {
  let callback!: (active: boolean) => void; const results = [deferred(), deferred(), deferred()];
  const errors: string[] = []; let nextResult = 0;
  const output = new VoiceOutput({ getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG }), getVoiceConfig: () => voice,
    api: { synthesizeSpeech: async () => {}, cancelSpeech: async () => {}, onSpeechEvent: () => () => {} },
    createSystem: cb => { callback = cb; return { voices: () => [], stop: () => cb(false), speak: () => results[nextResult++].promise }; },
    onSpeaking: () => {}, onError: error => errors.push(error), createId: () => 'system-adapter',
  });
  try {
    let firstFinished = false; const first = output.speak('one', voice).then(() => { firstFinished = true; });
    callback(true); callback(false); await flush(); assert.equal(firstFinished, false);
    results[0].resolve(); await first;
    const second = output.speak('two', voice); callback(true); callback(false);
    const rejected = assert.rejects(second, /public engine error/); results[1].reject(Error('public engine error')); await rejected;
    assert.equal(errors.length, 1);
    const third = output.speak('three', voice); output.stop(); await third;
    let replacementFinished = false;
    const fourthResult = deferred(); results.push(fourthResult);
    const fourth = output.speak('four', voice).then(() => { replacementFinished = true; });
    results[2].reject(Error('stale old error')); await flush(); assert.equal(replacementFinished, false); assert.equal(errors.length, 1);
    fourthResult.resolve(); await fourth;
  } finally { output.dispose(); }
});

test('void-only adapters preserve synchronous and asynchronous start/end compatibility over three turns', async () => {
  for (const synchronous of [true, false]) {
    let callback!: (active: boolean) => void;
    const output = new VoiceOutput({ getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG }), getVoiceConfig: () => voice,
      api: { synthesizeSpeech: async () => {}, cancelSpeech: async () => {}, onSpeechEvent: () => () => {} },
      createSystem: cb => { callback = cb; return { voices: () => [], stop: () => cb(false), speak() { cb(false); if (synchronous) { cb(true); cb(false); } } }; },
      onSpeaking: () => {}, onError: error => assert.fail(error), createId: () => 'void-adapter',
    });
    try {
      for (let turn = 0; turn < 3; turn++) { const task = output.speak('public', voice); if (!synchronous) { await flush(); callback(true); callback(false); } await task; }
    } finally { output.dispose(); }
  }
});

test('synchronous system start/end and start/error inside speak settle once and allow the third turn', async () => {
  const h = systemHarness();
  try {
    h.nextSpeak(u => { u.onstart?.(); u.onend?.(); }); await h.output.speak('sync success', voice);
    h.nextSpeak(u => { u.onstart?.(); u.onerror?.({ error: 'synthesis-failed' }); });
    await assert.rejects(h.output.speak('sync failure', voice), /系统语音/);
    h.nextSpeak(u => { u.onstart?.(); u.onend?.(); }); await h.output.speak('sync recovery', voice);
    assert.equal(h.errors.length, 1); assert.equal(h.speaking.at(-1), false);
  } finally { h.restore(); }
});

test('owned PCM cancellation stops all pending sources while late old transport and finally preserve the next turn', async () => {
  const h = cloudHarness();
  try {
    const first = h.output.speak('first', voice); await flush(); await h.audio(0); await h.done(0); h.contexts[0].sources[0].end(); await first; await flush();
    const second = h.output.speak('cancelled second', voice); await flush(); await h.audio(1); await h.audio(1);
    const oldSources = [...h.contexts[1].sources]; const oldEnded = oldSources[0].onended!;
    assert.equal(oldSources.length, 2); assert.equal(h.runtime.busy, true);
    h.output.stop(); await second; await flush();
    assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.contexts[1].closed, 1);
    assert.ok(oldSources.every(s => s.stopped === 1 && s.onended === null && s.disconnected > 0));
    let thirdFinished = false;
    const third = h.output.speak('third', voice).then(() => { thirdFinished = true; }); await flush();
    await h.calls[1].emit({ type: 'done', firstAudioMs: 3, audioBytes: 8 }); h.calls[1].transport.resolve(); oldEnded(); await flush();
    assert.equal(thirdFinished, false); assert.equal(h.calls[2].signal.aborted, false); assert.equal(h.runtime.busy, true);
    await h.audio(2); await h.done(2); h.contexts[2].sources[0].end(); await third; await flush();
    assert.equal(h.runtime.busy, false); assert.equal(h.contexts[2].closed, 1); assert.deepEqual(h.errors, []);
  } finally { h.dispose(); }
});

test('release acknowledgement failure rejects the ended session, cancels its routing, and allows recovery', async () => {
  const h = cloudHarness();
  try {
    const release = deferred(); h.releaseGates.push(release);
    const task = h.output.speak('release failure', voice); const rejected = assert.rejects(task, /release failure/);
    await flush(); await h.audio(0); await h.done(0); h.contexts[0].sources[0].end(); await flush();
    assert.equal(h.runtime.busy, true); release.reject(Error('public release failure')); await rejected; await flush();
    assert.equal(h.runtime.busy, false); assert.equal(h.errors.length, 1); assert.equal(h.cancellations.length, 1);
    const next = h.output.speak('recovery', voice); await flush(); await h.audio(1); await h.done(1); h.contexts[1].sources[0].end(); await next; await flush();
    assert.equal(h.runtime.busy, false); assert.equal(h.contexts[1].closed, 1); assert.equal(h.errors.length, 1);
  } finally { h.dispose(); }
});
