import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings } from "../shared/contracts";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { DEFAULT_TTS_CONFIG, type SpeechRequestContext, type TtsConfig } from "../shared/tts";
import type { EmotionalVoicePlaybackState, VoicePlaybackEvent } from "../src/ui/EmotionalVoice";
import { VoiceOutput, splitSpeechText, type VoiceOutputEvent } from "../src/ui/VoiceOutput";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
type Callbacks = { onSpeaking(value: boolean): void; onState(state: EmotionalVoicePlaybackState): void; onError(message: string): void };

function environment(initial: Partial<TtsConfig> = {}) {
  let config = { ...DEFAULT_TTS_CONFIG, ...initial } as TtsConfig;
  let voice = structuredClone(DEFAULT_SETTINGS.voice);
  let listener: ((event: VoiceOutputEvent) => void) | null = null;
  let previousListener: ((event: VoiceOutputEvent) => void) | null = null;
  let systemSpeaking!: (active: boolean) => void;
  let ids = 0, unsubscriptions = 0, systemStops = 0, systemDisposes = 0;
  const requests: { id: string; text: string; context?: SpeechRequestContext }[] = [], cancellations: string[] = [];
  const requestResults: Promise<void>[] = [], beginResults: Promise<void>[] = [], systemResults: Promise<void>[] = [];
  const systemSpeeches: { text: string; config: AppSettings["voice"] }[] = [];
  const states: EmotionalVoicePlaybackState[] = [], speaking: boolean[] = [], errors: string[] = [];
  const voices = [{ voiceURI: "test-voice", lang: "zh-CN" }] as SpeechSynthesisVoice[];
  const players: PlayerMock[] = [];
  class PlayerMock {
    readonly complete = deferred();
    readonly events: VoicePlaybackEvent[] = [];
    readonly begins: { id: string; volume?: number }[] = [];
    disposed = 0;
    stopped = 0;
    constructor(readonly callbacks: Callbacks) { void this.complete.promise.catch(() => {}); players.push(this); }
    get finished(): Promise<void> { return this.complete.promise; }
    async begin(id: string, volume?: number): Promise<void> {
      this.begins.push({ id, volume });
      this.callbacks.onSpeaking(false); this.callbacks.onState({ phase: "loading" });
      await beginResults.shift();
    }
    async accept(event: VoicePlaybackEvent): Promise<void> {
      this.events.push(structuredClone(event));
      if (event.type === "audio") { this.callbacks.onSpeaking(true); this.callbacks.onState({ phase: "playing", firstAudioMs: event.firstAudioMs }); }
    }
    end(): void { this.callbacks.onSpeaking(false); this.callbacks.onState({ phase: "idle" }); this.complete.resolve(); }
    stop(): void { this.stopped++; this.callbacks.onSpeaking(false); this.complete.resolve(); }
    dispose(): void { this.disposed++; this.stop(); }
    fail(message: string): void { this.callbacks.onState({ phase: "error", message }); this.callbacks.onError(message); this.complete.reject(new Error(message)); }
  }
  const output = new VoiceOutput({
    getTtsConfig: () => config, getVoiceConfig: () => voice,
    api: {
      async synthesizeSpeech(id, text, context) { requests.push({ id, text, ...(context ? { context: { ...context } } : {}) }); await requestResults.shift(); },
      async cancelSpeech(id) { cancellations.push(id); },
      onSpeechEvent(callback) { listener = previousListener = callback; return () => { listener = null; unsubscriptions++; }; },
    },
    onSpeaking: value => speaking.push(value), onState: value => states.push(value), onError: value => errors.push(value),
    createId: () => `voice-${++ids}`,
    createSystem(callback) {
      systemSpeaking = callback;
      return {
        voices: () => voices,
        speak(text, config) { callback(false); systemSpeeches.push({ text, config: { ...config } }); return systemResults.shift(); },
        stop() { systemStops++; callback(false); }, dispose() { systemDisposes++; },
      };
    },
    createPlayer: callbacks => new PlayerMock(callbacks),
  });
  const emit = (event: VoiceOutputEvent) => listener?.(event);
  const audio = (request: number, firstAudioMs = 35) => emit({ id: requests[request].id, type: "audio", data: "AAAAAA==", format: "pcm_s16le", sampleRate: 24000, channels: 1, firstAudioMs });
  const done = (request: number, firstAudioMs = 35) => emit({ id: requests[request].id, type: "done", audioBytes: 4, firstAudioMs });
  return {
    output, requests, cancellations, requestResults, beginResults, systemResults, players, systemSpeeches, states, speaking, errors, voices,
    emit, audio, done, systemSpeaking: (value: boolean) => systemSpeaking(value),
    emitAfterUnsubscribe: (event: VoiceOutputEvent) => previousListener?.(event),
    setConfig(patch: Partial<TtsConfig>) { config = { ...config, ...patch }; },
    setVoice(patch: Partial<AppSettings["voice"]>) { voice = { ...voice, ...patch }; },
    get config() { return config; }, get voice() { return voice; },
    get unsubscriptions() { return unsubscriptions; }, get systemStops() { return systemStops; }, get systemDisposes() { return systemDisposes; },
  };
}

test('stopping or replacing a character preview while its host identity is pending cannot start late audio', async () => {
  const env = environment({ provider: 'bailian' });
  const prepared = deferred<SpeechRequestContext>();
  const preview = env.output.previewCharacter('一段当前角色试听。', () => prepared.promise);
  env.output.stop(); prepared.resolve({ replyId: 'old-preview' });
  await preview; await flush();
  assert.equal(env.requests.length, 0);
  assert.equal(env.players.length, 0);
  env.output.dispose();
});

test("speech splitting respects sentences, the product text bound and complete Unicode code points", () => {
  const text = `${"甲".repeat(1500)}。${"乙".repeat(1300)}！${"丙".repeat(2600)}`;
  const parts = splitSpeechText(`  ${text}  `);
  assert.equal(parts.join(""), text); assert.equal(parts[0], `${"甲".repeat(1500)}。`);
  assert.ok(parts.every(part => part.length <= 2000 && part.trim()));
  assert.equal(splitSpeechText("x".repeat(7000)).join("").length, 6000);
  const unicode = `a${"😀".repeat(4000)}`;
  const unicodeParts = splitSpeechText(unicode);
  assert.ok(unicodeParts.every(part => part.length <= 2000 && !/[\ud800-\udbff]$/.test(part)));
  assert.equal(unicodeParts.join(""), unicode.slice(0, 5999));
  assert.deepEqual(splitSpeechText(" \n\t "), []);
});

test('reply emotion authority is frozen across every cloud segment and still waits for final PCM playback', async () => {
  const env = environment({ provider: 'bailian' }); env.setVoice({ enabled: true });
  const context = { replyId: 'accepted-chat' }; let finished = false;
  const task = env.output.speak('语'.repeat(4100), env.voice, context).then(() => { finished = true; });
  context.replyId = 'later-chat'; await flush();
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(env.requests[index].context, { replyId: 'accepted-chat' });
    env.audio(index); env.done(index); await flush();
  }
  assert.equal(env.requests.length, 3); assert.equal(new Set(env.requests.map(value => value.id)).size, 3);
  assert.equal(finished, false);
  env.players[0].end(); await task; assert.equal(finished, true); env.output.dispose();
});

test('preview has no chat emotion authority and a stopped old segment cannot request another', async () => {
  const env = environment({ provider: 'bailian' }); env.setVoice({ enabled: true });
  const old = env.output.speak('语'.repeat(4100), env.voice, { replyId: 'old-chat' }); await flush();
  env.output.stop(); await old;
  const preview = env.output.preview('只用保存的面板风格'); await flush();
  assert.equal(env.requests[1].context, undefined);
  env.audio(0); env.done(0); await flush(); assert.equal(env.requests.length, 2);
  env.audio(1); env.done(1); await flush(); env.players[1].end(); await preview; env.output.dispose();
});

test("system output keeps original voices and settings and never requests cloud audio", async () => {
  const env = environment(); env.setVoice({ enabled: true, rate: 1.25, volume: 0.3 });
  assert.deepEqual(env.output.voices(), env.voices);
  env.output.speak("x".repeat(7000), env.voice);
  assert.equal(env.systemSpeeches[0].text.length, 6000);
  assert.deepEqual(env.systemSpeeches[0].config, env.voice);
  assert.deepEqual(env.requests, []); assert.equal(env.players.length, 0);
  assert.equal(env.states.at(-1)?.phase, "loading");
  env.systemSpeaking(true); assert.equal(env.states.at(-1)?.phase, "playing");
  env.systemSpeaking(false); assert.equal(env.states.at(-1)?.phase, "idle");
  assert.deepEqual(env.errors, []); env.output.dispose();
});

test("disabled automatic speech stays silent while system preview waits for the utterance without changing config", async () => {
  const env = environment(); env.setVoice({ enabled: false });
  env.output.speak("自动回复", env.voice);
  assert.equal(env.systemSpeeches.length, 0);
  const before = structuredClone({ voice: env.voice, tts: env.config });
  let finished = false;
  const preview = env.output.preview("试听").then(() => { finished = true; });
  await flush();
  assert.equal(env.systemSpeeches[0].config.enabled, true);
  assert.equal(finished, false, "the system adapter's initial stop does not complete the preview");
  env.systemSpeaking(true); await flush(); assert.equal(finished, false);
  env.systemSpeaking(false); await preview; assert.equal(finished, true);
  assert.deepEqual({ voice: env.voice, tts: env.config }, before);
  assert.deepEqual(env.requests, []); env.output.dispose();
});

test("automatic system speech returns a completion that waits for the utterance and resolves silent requests immediately", async () => {
  const env = environment(); env.setVoice({ enabled: true });
  let completed = false;
  const completion = env.output.speak("自动朗读完成前保持气泡", env.voice).then(() => { completed = true; });
  await flush(); assert.equal(completed, false);
  env.systemSpeaking(true); await flush(); assert.equal(completed, false);
  env.systemSpeaking(false); await completion; assert.equal(completed, true);
  await env.output.speak("   ", env.voice);
  env.setVoice({ enabled: false }); await env.output.speak("已关闭朗读", env.voice);
  assert.equal(env.systemSpeeches.length, 1); env.output.dispose();
});

test("automatic cloud speech resolves after playback drains rather than when synthesis finishes", async () => {
  const env = environment({ provider: "bailian" }); env.setVoice({ enabled: true });
  let completed = false;
  const completion = env.output.speak("等待扬声器队列播完", env.voice).then(() => { completed = true; });
  await flush(); env.audio(0); env.done(0); await flush();
  assert.equal(completed, false); assert.equal(env.players[0].disposed, 0);
  env.players[0].end(); await completion; await flush();
  assert.equal(completed, true); assert.equal(env.players[0].disposed, 1);
  assert.deepEqual(env.cancellations, [env.requests[0].id]); env.output.dispose();
});

test("system engine completion can settle without a start event and an older completion cannot finish newer speech", async () => {
  const env = environment(); env.setVoice({ enabled: true });
  env.systemResults.push(Promise.resolve());
  await env.output.preview("引擎没有发出start");
  assert.equal(env.states.at(-1)?.phase, "idle");
  const older = deferred(), newer = deferred();
  env.systemResults.push(older.promise);
  const previous = env.output.speak("旧语音", env.voice); await flush();
  env.systemResults.push(newer.promise);
  let completed = false;
  const current = env.output.preview("新语音").then(() => { completed = true; });
  await previous; await flush(); assert.equal(completed, false);
  older.resolve(); await flush(); assert.equal(completed, false);
  assert.equal(env.states.at(-1)?.phase, "loading");
  newer.resolve(); await current; assert.equal(completed, true);
  assert.equal(env.states.at(-1)?.phase, "idle"); assert.deepEqual(env.errors, []); env.output.dispose();
});

test("cloud preview dispatches synthesis while the output starts and preserves the disabled auto-speech preference", async () => {
  const env = environment({ provider: "bailian" }); env.setVoice({ enabled: false, volume: 0.4 });
  const ready = deferred(); env.beginResults.push(ready.promise);
  const before = structuredClone({ voice: env.voice, tts: env.config });
  const preview = env.output.preview("边启动设备，边发送");
  // R02: a slow device start no longer adds to the network time.
  await flush(); assert.equal(env.requests.length, 1);
  ready.resolve(); await flush(); assert.equal(env.requests.length, 1);
  assert.equal(env.players[0].begins[0].volume, 0.4);
  env.audio(0); env.done(0); await flush(); env.players[0].end(); await preview;
  assert.deepEqual({ voice: env.voice, tts: env.config }, before); env.output.dispose();
});

test("three cloud requests form one continuous player and only the final done ends playback with the first latency", async () => {
  const env = environment({ provider: "bailian" });
  let finished = false;
  const preview = env.output.preview("甲".repeat(6000)).then(() => { finished = true; });
  await flush();
  const player = env.players[0], playbackId = player.begins[0].id;
  for (let index = 0; index < 3; index++) {
    assert.equal(env.requests.length, index + 1); assert.equal(env.requests[index].text.length, 2000);
    if (index) {
      // Starting the next segment releases the host's preceding recipient.
      env.emit({ id: env.requests[index - 1].id, type: "error", message: "前段已替换", cancelled: true });
      await flush(); assert.equal(player.disposed, 0);
    }
    env.audio(index, 35 + index * 100); env.done(index, 35 + index * 100); await flush();
    if (index < 2) assert.equal(player.events.filter(event => event.type === "done").length, 0);
  }
  assert.equal(env.players.length, 1); assert.equal(player.begins.length, 1);
  assert.equal(new Set(env.requests.map(request => request.id)).size, 3);
  assert.ok(player.events.every(event => event.id === playbackId));
  assert.deepEqual(player.events.filter(event => event.type === "audio").map(event => event.firstAudioMs), [35, undefined, undefined]);
  assert.deepEqual(player.events.at(-1), { id: playbackId, type: "done", firstAudioMs: 35, audioBytes: 12 });
  assert.equal(finished, false, "network completion cannot finish a preview while buffers remain queued");
  player.end(); await preview; assert.equal(finished, true);
  await flush(); assert.deepEqual(env.cancellations, [env.requests[2].id]);
  assert.equal(player.disposed, 1); assert.deepEqual(env.errors, []); env.output.dispose();
});

test("the next segment waits for the previous host acknowledgement as well as its done event", async () => {
  const env = environment({ provider: "bailian" });
  const acknowledged = deferred(); env.requestResults.push(acknowledged.promise);
  const preview = env.output.preview("甲".repeat(2100)); await flush();
  env.audio(0); env.done(0); await flush();
  assert.equal(env.requests.length, 1);
  acknowledged.resolve(); await flush(); assert.equal(env.requests.length, 2);
  env.output.stop(); await preview; env.output.dispose();
});

test("stop while a completed segment awaits acknowledgement prevents the later segment from being sent", async () => {
  const env = environment({ provider: "bailian" }), acknowledged = deferred();
  env.requestResults.push(acknowledged.promise);
  const preview = env.output.preview("甲".repeat(2100)); await flush();
  env.audio(0); env.done(0); await flush();
  env.output.stop(); await preview;
  acknowledged.resolve(); await flush();
  assert.equal(env.requests.length, 1); assert.equal(env.players[0].disposed, 1);
  assert.deepEqual(env.cancellations, [env.requests[0].id]); assert.deepEqual(env.errors, []); env.output.dispose();
});

test("stopping during audio startup cancels the in-flight request and prevents a late second one", async () => {
  const env = environment({ provider: "bailian" }), ready = deferred();
  env.beginResults.push(ready.promise);
  const preview = env.output.preview("等待音频设备"); await flush();
  assert.equal(env.requests.length, 1);
  env.output.stop(); await preview;
  ready.resolve(); await flush();
  assert.equal(env.requests.length, 1); assert.equal(env.players[0].disposed, 1);
  assert.deepEqual(env.cancellations, [env.requests[0].id]); assert.deepEqual(env.errors, []); env.output.dispose();
});

test("cancelled and late packets cannot restart an old player or stop a newer request", async () => {
  const env = environment({ provider: "bailian" }), oldResponse = deferred();
  env.requestResults.push(oldResponse.promise);
  const previous = env.output.preview("旧内容"); await flush(); env.audio(0); await flush();
  env.output.stop(); await previous;
  assert.deepEqual(env.cancellations, [env.requests[0].id]);
  const current = env.output.preview("新内容"); await flush();
  const oldCount = env.players[0].events.length;
  env.audio(0); env.done(0); env.emit({ id: env.requests[0].id, type: "error", message: "旧任务结束", cancelled: true });
  oldResponse.reject(new Error("old transport failed")); env.players[0].callbacks.onError("late player error"); await flush();
  assert.equal(env.players[0].events.length, oldCount); assert.equal(env.players[1].disposed, 0);
  assert.deepEqual(env.errors, []);
  env.audio(1); env.done(1); await flush(); env.players[1].end(); await current;
  await flush(); assert.deepEqual(env.cancellations, env.requests.map(request => request.id)); env.output.dispose();
});

test("a provider or effective style change cancels the current stream before accepting its next packet", async () => {
  for (const change of [{ provider: "system" as const }, { voice: "different-voice" }, { apiHost: "https://changed.example.test" }]) {
    const env = environment({ provider: "bailian" });
    const preview = env.output.preview("保持这次音色"); await flush();
    env.setConfig(change); env.audio(0); await flush(); await preview;
    assert.equal(env.players[0].events.length, 0); assert.equal(env.players[0].disposed, 1);
    assert.deepEqual(env.cancellations, [env.requests[0].id]); assert.deepEqual(env.errors, []); env.output.dispose();
  }
});

test("provider switching or auto-speech disabling during startup cancels the old request and plays nothing", async () => {
  for (const mode of ["provider", "enabled"] as const) {
    const env = environment({ provider: "bailian" }), ready = deferred(); env.setVoice({ enabled: true });
    env.beginResults.push(ready.promise); env.output.speak("旧请求", env.voice); await flush();
    // Dispatched under the settings that were current when speech started.
    assert.equal(env.requests.length, 1);
    if (mode === "provider") env.setConfig({ provider: "system" }); else env.setVoice({ enabled: false });
    env.audio(0); ready.resolve(); await flush();
    assert.equal(env.requests.length, 1); assert.equal(env.players[0].disposed, 1);
    assert.equal(env.players[0].events.length, 0, "no PCM from the old request is accepted");
    assert.deepEqual(env.cancellations, [env.requests[0].id]);
    assert.deepEqual(env.errors, []); env.output.dispose();
  }
});

test("a host cancellation is quiet and does not echo a cancellation command back to the host", async () => {
  const env = environment({ provider: "bailian" }); const preview = env.output.preview("已由主进程停止"); await flush();
  env.emit({ id: env.requests[0].id, type: "error", message: "语音已停止。", cancelled: true });
  await flush(); await preview;
  assert.deepEqual(env.cancellations, []); assert.deepEqual(env.errors, []);
  assert.equal(env.states.at(-1)?.phase, "idle"); env.output.dispose();
});

test("host cancellation after network done stops queued PCM without reporting an error", async () => {
  const env = environment({ provider: "bailian" });
  let finished = false;
  const preview = env.output.preview("还有排队音频").then(() => { finished = true; }); await flush();
  env.audio(0); env.done(0); await flush();
  assert.equal(finished, false); assert.equal(env.players[0].disposed, 0);
  env.emit({ id: env.requests[0].id, type: "error", message: "另一窗口开始语音", cancelled: true });
  await flush(); await preview;
  assert.equal(finished, true); assert.equal(env.players[0].disposed, 1);
  assert.deepEqual(env.cancellations, []); assert.deepEqual(env.errors, []); env.output.dispose();
});

test("actual playback completion detaches before releasing the host recipient, so its cancellation cannot affect new speech", async () => {
  const env = environment({ provider: "bailian" });
  const previous = env.output.preview("自然结束"); await flush();
  env.audio(0); env.done(0); await flush();
  assert.deepEqual(env.cancellations, []);
  env.players[0].end(); await previous; await flush();
  assert.deepEqual(env.cancellations, [env.requests[0].id]);
  const next = env.output.preview("新的语音"); await flush();
  env.emit({ id: env.requests[0].id, type: "error", message: "旧recipient释放", cancelled: true }); await flush();
  assert.equal(env.players[1].disposed, 0); assert.deepEqual(env.errors, []);
  env.output.stop(); await next; env.output.dispose();
});

test("transport and host stream failures reject preview once and discard their remaining events", async () => {
  for (const mode of ["transport", "event"] as const) {
    const env = environment({ provider: "bailian" }), response = deferred();
    if (mode === "transport") env.requestResults.push(response.promise);
    const preview = env.output.preview("服务错误"); await flush();
    if (mode === "transport") response.reject(new Error("network unavailable"));
    else env.emit({ id: env.requests[0].id, type: "error", message: "network unavailable" });
    await assert.rejects(preview, /network unavailable/); await flush();
    assert.deepEqual(env.errors, ["network unavailable"]); assert.equal(env.states.at(-1)?.phase, "error");
    const events = env.players[0].events.length; env.audio(0); env.done(0); await flush();
    assert.equal(env.players[0].events.length, events); assert.equal(env.players[0].disposed, 1);
    assert.deepEqual(env.cancellations, [env.requests[0].id]); env.output.dispose();
  }
});

test("a player error cancels synthesis once even if both player failure callbacks fire", async () => {
  const env = environment({ provider: "bailian" }); const preview = env.output.preview("播放错误"); await flush();
  env.players[0].fail("unsupported audio");
  await assert.rejects(preview, /unsupported audio/); await flush();
  assert.deepEqual(env.errors, ["unsupported audio"]); assert.equal(env.players[0].disposed, 1);
  assert.deepEqual(env.cancellations, [env.requests[0].id]); env.output.dispose();
});

test("an empty segment cannot silently skip its text and continue into later content", async () => {
  const env = environment({ provider: "bailian" }); const preview = env.output.preview("甲".repeat(2100)); await flush();
  env.done(0); await assert.rejects(preview, /没有返回可播放音频/); await flush();
  assert.equal(env.requests.length, 1); assert.equal(env.errors.length, 1); env.output.dispose();
});

test("disposal unsubscribes, stops the current request and invalidates all retained callbacks", async () => {
  const env = environment({ provider: "bailian" }); const preview = env.output.preview("正在退出"); await flush();
  env.output.dispose(); env.output.dispose(); await preview;
  assert.equal(env.unsubscriptions, 1); assert.equal(env.systemDisposes, 1); assert.equal(env.players[0].disposed, 1);
  assert.deepEqual(env.cancellations, [env.requests[0].id]);
  env.emitAfterUnsubscribe({ id: env.requests[0].id, type: "error", message: "late" });
  await env.output.preview("不再请求"); env.output.speak("不再朗读", { ...env.voice, enabled: true }); await flush();
  assert.equal(env.requests.length, 1); assert.deepEqual(env.errors, []);
});

test("the real system adapter keeps preview pending through its internal cancel until actual speech ends", async t => {
  class UtteranceMock {
    voice: SpeechSynthesisVoice | null = null;
    lang = ""; rate = 1; volume = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly text: string) {}
  }
  const saved = ["speechSynthesis", "SpeechSynthesisUtterance"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const utterances: UtteranceMock[] = [], states: EmotionalVoicePlaybackState[] = [], errors: string[] = [];
  const voice = { ...DEFAULT_SETTINGS.voice, enabled: false, rate: 1.1, volume: 0.4 };
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { configurable: true, value: UtteranceMock });
  Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, value: {
    cancel() {}, getVoices: () => [{ voiceURI: "real-adapter", lang: "zh-CN" }], speak: (utterance: UtteranceMock) => utterances.push(utterance),
  } });
  const output = new VoiceOutput({
    getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG }), getVoiceConfig: () => voice,
    api: { async synthesizeSpeech() { assert.fail("system preview cannot use cloud"); }, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
    onSpeaking() {}, onState: value => states.push(value), onError: value => errors.push(value),
  });
  let completed = false;
  const preview = output.preview("系统试听").then(() => { completed = true; });
  await flush();
  assert.equal(utterances.length, 1); assert.equal(completed, false); assert.equal(states.at(-1)?.phase, "loading");
  assert.equal(utterances[0].rate, 1.1); assert.equal(utterances[0].volume, 0.4);
  utterances[0].onstart!(); assert.equal(states.at(-1)?.phase, "playing");
  utterances[0].onend!(); await preview;
  assert.equal(completed, true); assert.equal(states.at(-1)?.phase, "idle"); assert.equal(voice.enabled, false);
  assert.deepEqual(errors, []); output.dispose();
});

test("real system adapter startup exceptions reject automatic speech and preview without a hanging loading session", async t => {
  const saved = ["speechSynthesis", "SpeechSynthesisUtterance"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  for (const mode of ["constructor", "voices", "speak"] as const) {
    class UtteranceMock {
      voice: SpeechSynthesisVoice | null = null;
      lang = ""; rate = 1; volume = 1;
      onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(readonly text: string) { if (mode === "constructor") throw new Error("engine unavailable"); }
    }
    const states: EmotionalVoicePlaybackState[] = [], errors: string[] = [];
    const voice = { ...DEFAULT_SETTINGS.voice, enabled: true };
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { configurable: true, value: UtteranceMock });
    Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, value: {
      cancel() {}, getVoices() { if (mode === "voices") throw new Error("engine unavailable"); return []; },
      speak() { throw new Error("engine unavailable"); },
    } });
    const output = new VoiceOutput({
      getTtsConfig: () => ({ ...DEFAULT_TTS_CONFIG }), getVoiceConfig: () => voice,
      api: { async synthesizeSpeech() { assert.fail("system startup cannot use cloud"); }, async cancelSpeech() {}, onSpeechEvent: () => () => {} },
      onSpeaking() {}, onState: value => states.push(value), onError: value => errors.push(value),
    });
    await assert.rejects(output.speak("自动朗读启动异常", voice), /系统语音/);
    assert.equal(states.at(-1)?.phase, "error", mode);
    await assert.rejects(output.preview("试听启动异常"), /系统语音/);
    assert.equal(states.at(-1)?.phase, "error", mode);
    assert.equal(errors.length, 2, "unavailable engines are observable failures rather than silent success");
    output.dispose();
  }
});
