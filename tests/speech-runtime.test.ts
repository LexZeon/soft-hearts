import test from "node:test";
import assert from "node:assert/strict";
import { SpeechRuntime, type SpeechSynthesizer } from "../electron/speech-runtime";
import { TtsError } from "../electron/tts";
import { DEFAULT_TTS_CONFIG, type SpeechWireEvent, type TtsConfig, type TtsStreamEvent } from "../shared/tts";

const audio: TtsStreamEvent = { type: "audio", data: "AAAFAA==", format: "pcm_s16le", sampleRate: 24000, channels: 1, firstAudioMs: 20 };
const done: TtsStreamEvent = { type: "done", firstAudioMs: 20, audioBytes: 4 };
const config = (): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: "bailian", apiHost: "https://console-host.example", region: "private-region", apiKey: "host-only-fixture-key" });
interface Call {
  config: TtsConfig;
  text: string;
  signal: AbortSignal;
  emit(event: TtsStreamEvent): void | Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
function harness() {
  const current = config(), calls: Call[] = [], events: { owner: number; event: SpeechWireEvent }[] = [];
  const synthesize: SpeechSynthesizer = (settings, text, signal, emit) => new Promise<void>((resolve, reject) => {
    calls.push({ config: settings, text, signal, emit, resolve, reject });
  });
  const runtime = new SpeechRuntime(() => current, (owner, event) => events.push({ owner, event }), synthesize);
  return { current, calls, events, runtime };
}

test("speech accepts only bounded IDs, text and a valid window owner without interrupting a valid active request", async () => {
  const env = harness();
  const active = env.runtime.speak(11, "valid-id", "当前语音。");
  for (const id of ["", "x".repeat(101), "../asset", "https://host", "空格 id", null, {}])
    await assert.rejects(env.runtime.speak(11, id as string, "text"), /编号/);
  for (const text of ["", "  ", "x".repeat(2001), null, {}])
    await assert.rejects(env.runtime.speak(11, "invalid-text", text as string), /文字/);
  for (const owner of [0, -1, Number.NaN, Infinity, 0.5])
    await assert.rejects(env.runtime.speak(owner, "invalid-owner", "text"), /窗口/);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].signal.aborted, false);
  assert.deepEqual(env.events, []);
  env.runtime.stop(); env.calls[0].resolve(); await active;
});

test("only the owner receives events, and completion clears transport while retaining only a cancellable playback recipient", async () => {
  const env = harness();
  const task = env.runtime.speak(11, "request-1", "  试听。  ");
  assert.equal(env.calls[0].text, "试听。");
  await env.calls[0].emit(audio); await env.calls[0].emit(done);
  env.calls[0].resolve(); await task;
  assert.deepEqual(env.events, [{ owner: 11, event: { id: "request-1", ...audio } }, { owner: 11, event: { id: "request-1", ...done } }]);
  await env.calls[0].emit(audio);
  assert.equal(env.events.length, 2);
  assert.equal(env.runtime.cancel(11, "request-1"), true);
  assert.equal(env.runtime.cancel(11, "request-1"), false);
  assert.deepEqual(env.events[2], { owner: 11, event: { id: "request-1", type: "error", cancelled: true, message: "语音已停止。" } });
});

test("a new global request cancels the former owner and late audio, errors and finally cannot affect the new owner", async () => {
  const env = harness();
  const first = env.runtime.speak(11, "first", "原语音。");
  await env.calls[0].emit(audio);
  const second = env.runtime.speak(22, "second", "新语音。");
  assert.equal(env.calls[0].signal.aborted, true);
  assert.deepEqual(env.events[1], { owner: 11, event: { id: "first", type: "error", cancelled: true, message: "语音已停止。" } });
  await env.calls[0].emit(audio); await env.calls[0].emit(done);
  env.calls[0].reject(new Error("late host-only-fixture-key private-url")); await first;
  await env.calls[1].emit(audio);
  assert.equal(env.calls[1].signal.aborted, false);
  assert.equal(env.events.length, 3);
  assert.equal(env.events[2].owner, 22);
  assert.equal(env.events[2].event.id, "second");
  assert.equal(env.runtime.cancel(22, "second"), true);
  env.calls[1].resolve(); await second;
  assert.equal(env.events.length, 4);
  assert.equal(JSON.stringify(env.events).includes("host-only-fixture-key"), false);
});

test("cancel requires both current owner and ID, while repeated cancel is a harmless no-op", async () => {
  const env = harness();
  const task = env.runtime.speak(11, "owned", "测试。");
  assert.equal(env.runtime.cancel(22, "owned"), false);
  assert.equal(env.runtime.cancel(11, "other"), false);
  assert.equal(env.calls[0].signal.aborted, false);
  assert.equal(env.runtime.cancel(11, "owned"), true);
  assert.equal(env.runtime.cancel(11, "owned"), false);
  assert.equal(env.calls[0].signal.aborted, true);
  env.calls[0].resolve(); await task;
  assert.deepEqual(env.events, [{ owner: 11, event: { id: "owned", type: "error", cancelled: true, message: "语音已停止。" } }]);
});

test("owner teardown and global stop revoke only their current request and emit one quiet cancellation", async () => {
  const env = harness();
  const first = env.runtime.speak(11, "first", "一。");
  env.runtime.dropOwner(22);
  assert.equal(env.calls[0].signal.aborted, false);
  env.runtime.dropOwner(11);
  env.runtime.dropOwner(11); env.runtime.stop();
  env.calls[0].resolve(); await first;
  const second = env.runtime.speak(22, "second", "二。");
  env.runtime.stop(); env.calls[1].resolve(); await second;
  assert.equal(env.events.length, 2);
  for (const { event } of env.events) assert.equal(event.type === "error" && event.cancelled, true);
});

test("each request snapshots the host configuration and bound style before asynchronous synthesis", async () => {
  const env = harness();
  env.current.instruction = "最初风格。";
  env.current.styleBindings = [{ characterId: "local", modelPath: "private.pmx", voice: "private_voice", instruction: "绑定风格。", emotion: "custom", rate: 0.8 }];
  const task = env.runtime.speak(11, "snapshot", "测试。");
  env.current.voice = "new_voice"; env.current.apiKey = "new-host-key"; env.current.instruction = "新的风格。";
  env.current.styleBindings[0].instruction = "新的绑定。";
  assert.equal(env.calls[0].config.voice, DEFAULT_TTS_CONFIG.voice);
  assert.equal(env.calls[0].config.apiKey, "host-only-fixture-key");
  assert.equal(env.calls[0].config.instruction, "最初风格。");
  assert.equal(env.calls[0].config.styleBindings?.[0].instruction, "绑定风格。");
  env.runtime.stop(); env.calls[0].resolve(); await task;
});

test("only branded adapter public messages cross IPC while unexpected errors and configuration failures stay generic", async () => {
  for (const failure of [new TtsError("百炼语音响应超时，请稍后重试。"), new Error("host-only-fixture-key https://private-url/?token=secret"), { message: "private detail" }]) {
    const events: SpeechWireEvent[] = [];
    const runtime = new SpeechRuntime(config, (_owner, event) => events.push(event), async () => { throw failure; });
    await runtime.speak(11, "error", "测试。");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { id: "error", type: "error", message: failure instanceof TtsError ? failure.publicMessage : "语音合成失败，请稍后重试。" });
    assert.doesNotMatch(JSON.stringify(events), /host-only|private-url|token=|private detail/);
  }
  const events: SpeechWireEvent[] = [];
  const runtime = new SpeechRuntime(() => { throw new Error("secret host config"); }, (_owner, event) => events.push(event));
  await runtime.speak(11, "config-error", "测试。");
  assert.deepEqual(events, [{ id: "config-error", type: "error", message: "语音合成失败，请稍后重试。" }]);
});

test("wire events select only approved fields instead of forwarding arbitrary adapter metadata", async () => {
  const env = harness();
  const task = env.runtime.speak(11, "bounded-wire", "测试。");
  await env.calls[0].emit({ ...audio, apiKey: "must-not-cross", apiHost: "https://private" } as TtsStreamEvent);
  assert.deepEqual(env.events, [{ owner: 11, event: { id: "bounded-wire", ...audio } }]);
  env.runtime.stop(); env.calls[0].resolve(); await task;
});

test("a closed recipient cannot leave synthesis active or leak an emitter exception", async () => {
  let call: Call | undefined;
  const runtime = new SpeechRuntime(config, () => { throw new Error("private destroyed window detail"); }, (settings, text, signal, emit) => new Promise<void>((resolve, reject) => {
    call = { config: settings, text, signal, emit, resolve, reject };
  }));
  const task = runtime.speak(11, "closed-window", "测试。");
  await call!.emit(audio);
  assert.equal(call!.signal.aborted, true);
  assert.equal(runtime.cancel(11, "closed-window"), false);
  call!.resolve(); await task;
});

test("a different owner starting after network completion stops the previous renderer's queued PCM", async () => {
  const env = harness();
  const first = env.runtime.speak(11, "completed-transport", "一。");
  await env.calls[0].emit(audio); await env.calls[0].emit(done);
  env.calls[0].resolve(); await first;
  assert.equal(env.calls[0].signal.aborted, false, "finished transport was released without keeping its controller");
  const second = env.runtime.speak(22, "next-owner", "二。");
  assert.deepEqual(env.events[2], { owner: 11, event: { id: "completed-transport", type: "error", cancelled: true, message: "语音已停止。" } });
  assert.equal(env.calls[0].signal.aborted, false, "only a routing identity remains after completion");
  assert.equal(env.runtime.cancel(11, "completed-transport"), false);
  assert.equal(env.calls[1].signal.aborted, false);
  env.runtime.stop(); env.calls[1].resolve(); await second;
});

test("cancel, owner teardown and stop can release a completed playback recipient without duplicating cancellation", async () => {
  for (const operation of ["cancel", "dropOwner", "stop"] as const) {
    const env = harness();
    const task = env.runtime.speak(11, "finished", "一。");
    await env.calls[0].emit(done); env.calls[0].resolve(); await task;
    env.runtime.dropOwner(22);
    assert.equal(env.runtime.cancel(22, "finished"), false);
    assert.equal(env.events.length, 1);
    if (operation === "cancel") assert.equal(env.runtime.cancel(11, "finished"), true);
    else if (operation === "dropOwner") env.runtime.dropOwner(11);
    else env.runtime.stop();
    env.runtime.stop();
    assert.equal(env.events.length, 2);
    assert.equal(env.events[1].event.type === "error" && env.events[1].event.cancelled, true);
    assert.equal(env.calls[0].signal.aborted, false);
  }
});

test("a same-owner next segment routes old-ID cancellation separately from the new segment", async () => {
  const env = harness();
  const first = env.runtime.speak(11, "segment-a", "一。");
  await env.calls[0].emit(done); env.calls[0].resolve(); await first;
  const second = env.runtime.speak(11, "segment-b", "二。");
  await env.calls[1].emit(audio);
  assert.deepEqual(env.events.map(entry => [entry.event.id, entry.event.type]), [["segment-a", "done"], ["segment-a", "error"], ["segment-b", "audio"]]);
  assert.equal(env.runtime.cancel(11, "segment-a"), false);
  assert.equal(env.calls[1].signal.aborted, false);
  assert.equal(env.runtime.cancel(11, "segment-b"), true);
  env.calls[1].resolve(); await second;
});
