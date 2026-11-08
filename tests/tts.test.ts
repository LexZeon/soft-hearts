import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TTS_CONFIG, DEFAULT_TTS_INSTRUCTION, effectiveTtsConfig, TTS_EMOTIONS, type TtsConfig, type TtsStreamEvent } from "../shared/tts";
import { BAILIAN_TTS_PATH, resolveTtsKey, synthesizeBailianSpeech, ttsInstruction, validateTtsConfig } from "../electron/tts";

const config = (patch: Partial<TtsConfig> = {}): TtsConfig => ({ ...DEFAULT_TTS_CONFIG, provider: "bailian", apiHost: "https://real-console-host.example", region: "user-region", apiKey: "fixture-key", ...patch });
const audio = (data: Uint8Array | number[] = [0, 0, 5, 0], finish: unknown = null) => ({ output: { type: "sentence-synthesis", audio: { data: Buffer.from(data).toString("base64") }, finish_reason: finish } });
const stop = { output: { type: "sentence-end", audio: { url: "https://untrusted-audio.example/private.wav" }, finish_reason: "stop" }, request_id: "fixture-request" };
const wire = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
function response(body: string, chunkBytes = 0): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (!chunkBytes) controller.enqueue(bytes);
      else for (let at = 0; at < bytes.length; at += chunkBytes) controller.enqueue(bytes.slice(at, at + chunkBytes));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
function fetchReturning(value: Response): typeof fetch { return async () => value; }

test("optional emotional TTS defaults preserve the system provider and exact requested model, voice and instruction", () => {
  assert.equal(DEFAULT_TTS_CONFIG.provider, "system");
  assert.equal(DEFAULT_TTS_CONFIG.apiHost, "");
  assert.equal(DEFAULT_TTS_CONFIG.apiKey, "");
  assert.equal(DEFAULT_TTS_CONFIG.model, "qwen-audio-3.1-tts-flash");
  assert.equal(DEFAULT_TTS_CONFIG.voice, "longanlingxin_v3.1");
  assert.equal(DEFAULT_TTS_CONFIG.instruction, DEFAULT_TTS_INSTRUCTION);
  assert.equal(DEFAULT_TTS_CONFIG.instruction, "");
  assert.equal(validateTtsConfig({}).introduced, false);
});

test("TTS validates the console HTTPS origin without inventing a host from a region or retaining unsafe URLs", () => {
  for (const apiHost of ["http://host.example", "https://user:secret@host.example", "https://host.example/path", "https://host.example?key=secret", "https://host.example/#hash", "host.example", "file:///secret", "javascript:alert(1)"])
    assert.throws(() => validateTtsConfig(config({ apiHost })), /API Host/);
  assert.equal(validateTtsConfig(config({ apiHost: "https://real-console-host.example/" })).apiHost, "https://real-console-host.example");
  assert.equal(validateTtsConfig(config({ apiHost: "https://real-console-host.example" + BAILIAN_TTS_PATH })).apiHost, "https://real-console-host.example");
  assert.equal(validateTtsConfig({ region: "Singapore" }).apiHost, "");
  assert.equal(validateTtsConfig(config({ rate: 99 })).rate, 2);
  assert.equal(validateTtsConfig(config({ rate: -1 })).rate, 0.5);
  assert.throws(() => validateTtsConfig(config({ voice: "voice/../secret" })), /ID/);
});

test("redacted TTS keys are reused only for the same explicit host and region", () => {
  const previous = config();
  assert.equal(resolveTtsKey(config({ apiKey: "••••••••" }), previous).apiKey, "fixture-key");
  assert.equal(resolveTtsKey(config({ apiHost: "https://another-console-host.example", apiKey: "••••••••" }), previous).apiKey, "");
  assert.equal(resolveTtsKey(config({ region: "another-region", apiKey: "••••••••" }), previous).apiKey, "");
  assert.equal(resolveTtsKey(config({ apiKey: "new-key" }), previous).apiKey, "new-key");
});

test("emotion choices are expressed through instruction, and custom keeps the user's exact text", () => {
  assert.equal(ttsInstruction(config()), DEFAULT_TTS_INSTRUCTION);
  assert.equal(ttsInstruction(config({ emotion: "custom", instruction: "安静说话。" })), "安静说话。");
  for (const emotion of TTS_EMOTIONS.filter(item => item.id !== "custom"))
    assert.equal(ttsInstruction(config({ emotion: emotion.id })), emotion.instruction);
});

test("native Bailian streaming sends the documented input fields and host-only key, measures first audio and never fetches audio URLs", async () => {
  const events: TtsStreamEvent[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  let clock = 100;
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    clock = 137;
    return response(wire({ output: { type: "sentence-begin", text: "轻声" } }, audio(), audio([7, 0, 9, 0], "null"), stop), 3);
  };
  const result = await synthesizeBailianSpeech(config({ rate: 0.85 }), "  测试文字。  ", new AbortController().signal, event => { events.push(event); }, { fetch: fetcher, now: () => clock });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://real-console-host.example" + BAILIAN_TTS_PATH);
  assert.equal(requests[0].init?.redirect, "error");
  assert.deepEqual(requests[0].init?.headers, { Authorization: "Bearer fixture-key", "Content-Type": "application/json", "X-DashScope-SSE": "enable" });
  const payload = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(payload, { model: "qwen-audio-3.1-tts-flash", input: { text: "测试文字。", voice: "longanlingxin_v3.1", format: "pcm", sample_rate: 24000, rate: 0.85 } });
  assert.equal(JSON.stringify(payload).includes("fixture-key"), false);
  assert.deepEqual(events.filter(event => event.type === "audio").map(event => event.data), ["AAAFAA==", "BwAJAA=="]);
  assert.deepEqual(result, { firstAudioMs: 37, audioBytes: 8, requestId: "fixture-request" });
  assert.deepEqual(events.at(-1), { type: "done", ...result });
  assert.equal(events[0].type === "audio" && events[0].firstAudioMs, 37);
  assert.equal(events[1].type === "audio" && events[1].firstAudioMs, undefined);
});

test("missing key, host, wrong provider, blank or excessive text cannot dispatch a request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("should not dispatch"); };
  for (const [value, text] of [[config({ apiKey: "" }), "text"], [config({ apiKey: "••••••••" }), "text"], [config({ apiHost: "" }), "text"], [config({ provider: "system" }), "text"], [config(), " "], [config(), "a".repeat(2001)]] as const)
    await assert.rejects(synthesizeBailianSpeech(value, text, new AbortController().signal, () => {}, { fetch: fetcher }));
  assert.equal(calls, 0);
});

test("pre-aborted and mid-stream cancelled speech produce no later audio or done event", async () => {
  const before = new AbortController(); before.abort();
  let calls = 0;
  await assert.rejects(synthesizeBailianSpeech(config(), "text", before.signal, () => {}, { fetch: async () => { calls++; return response(""); } }));
  assert.equal(calls, 0);
  const controller = new AbortController(), events: TtsStreamEvent[] = [];
  await assert.rejects(synthesizeBailianSpeech(config(), "text", controller.signal, event => {
    events.push(event); controller.abort();
  }, { fetch: fetchReturning(response(wire(audio(), audio(), stop))) }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "audio");
});

test("transport and server errors never expose raw messages, credentials or text", async () => {
  for (const fetcher of [
    async () => { throw new Error("secret fixture-key https://private/?credential=hidden test-text"); },
    async () => new Response("fixture-key secret test-text", { status: 401 }),
    async () => response(wire({ code: "InvalidApiKey", message: "fixture-key secret test-text" })),
  ] as typeof fetch[]) {
    await assert.rejects(synthesizeBailianSpeech(config(), "test-text", new AbortController().signal, () => {}, { fetch: fetcher }), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fixture-key|secret|test-text|credential/);
      return true;
    });
  }
});

test("invalid content types, malformed SSE, bad base64, missing or truncated PCM reject without a done event", async () => {
  const invalid = [
    new Response("{}", { headers: { "content-type": "application/json" } }),
    response("data: not JSON\n\n"),
    response(wire(audio([0, 0]), { output: { finish_reason: "length" } })),
    response(wire({ output: { audio: { data: "not-base64!" } } }, stop)),
    response(wire({ output: { audio: { data: "AB==" } } }, stop)),
    response(wire(audio([0]), stop)),
    response(wire(audio(), { output: { finish_reason: null } })),
    response(wire(stop)),
    response(wire(audio(Buffer.from("RIFFwave")), stop)),
  ];
  for (const value of invalid) {
    const events: TtsStreamEvent[] = [];
    await assert.rejects(synthesizeBailianSpeech(config(), "text", new AbortController().signal, event => { events.push(event); }, { fetch: fetchReturning(value) }));
    assert.equal(events.some(event => event.type === "done"), false);
  }
});

test("split PCM bytes and a final SSE event without a blank line preserve ordering", async () => {
  const events: TtsStreamEvent[] = [];
  const body = ": heartbeat\r\nevent:result\r\n" + wire(audio([1]), audio([2])) + `data: ${JSON.stringify(stop)}`;
  const result = await synthesizeBailianSpeech(config(), "text", new AbortController().signal, event => { events.push(event); }, { fetch: fetchReturning(response(body, 1)) });
  assert.equal(result.audioBytes, 2);
  assert.deepEqual(events.filter(event => event.type === "audio").map(event => event.data), ["AQ==", "Ag=="]);
});

test("oversized SSE frames are bounded and cancelled", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(2_000_001)}\n\n`)); }, cancel() { cancelled = true; } });
  await assert.rejects(synthesizeBailianSpeech(config(), "text", new AbortController().signal, () => {}, { fetch: fetchReturning(new Response(stream, { headers: { "content-type": "text/event-stream" } })) }), /过大/);
  assert.equal(cancelled, true);
});

test("an interrupted stream cancels its reader and reports a safe transport failure", async () => {
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("fixture-key private-network-url")); } });
  await assert.rejects(synthesizeBailianSpeech(config(), "text", new AbortController().signal, () => {}, { fetch: fetchReturning(new Response(stream, { headers: { "content-type": "text/event-stream" } })) }), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /fixture-key|private-network/); return true;
  });
});

test("character and model speech styles stay private to the exact pair and retain global connection identity", () => {
  const bound = validateTtsConfig(config({ styleBindings: [{ characterId: "character-a", modelPath: "private-model-a.pmx", voice: "custom_voice", instruction: "本机角色风格。", emotion: "custom", rate: 0.8 }] }));
  const own = effectiveTtsConfig(bound, "character-a", "private-model-a.pmx");
  assert.equal(own.instruction, "本机角色风格。");
  assert.equal(own.voice, "custom_voice");
  assert.equal(own.rate, 0.8);
  assert.equal(own.apiHost, bound.apiHost); assert.equal(own.apiKey, bound.apiKey);
  for (const [character, model] of [["character-b", "private-model-a.pmx"], ["character-a", "private-model-b.pmx"]]) {
    const other = effectiveTtsConfig(bound, character, model);
    assert.equal(other.instruction, ""); assert.equal(other.voice, DEFAULT_TTS_CONFIG.voice);
  }
  assert.equal(bound.instruction, "");
  const many = validateTtsConfig(config({ styleBindings: Array.from({ length: 80 }, (_, index) => ({ characterId: `character-${index}`, modelPath: "local.pmx", voice: "local_voice", instruction: "x".repeat(3000), emotion: "custom", rate: 9 })) }));
  assert.equal(many.styleBindings?.length, 64);
  assert.equal(many.styleBindings?.[0].instruction.length, 1000);
  assert.equal(many.styleBindings?.[0].rate, 2);
});

test("custom and preset emotions are sent only through the documented input.instruction field", async () => {
  for (const value of [config({ instruction: "自然说话，清晰表达。", emotion: "custom" }), config({ emotion: "cheerful" })]) {
    let payload: { input: { instruction?: string; emotion?: unknown }; parameters?: unknown } | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return response(wire(audio(), stop));
    };
    await synthesizeBailianSpeech(value, "试听文字。", new AbortController().signal, () => {}, { fetch: fetcher });
    assert.equal(payload?.input.instruction, ttsInstruction(value));
    assert.equal(payload?.input.emotion, undefined);
    assert.equal(payload?.parameters, undefined);
  }
});

test("many valid individual audio chunks cannot exceed the total stream bound", async () => {
  let packets = 0, cancelled = false;
  const chunk = new TextEncoder().encode(wire(audio(new Uint8Array(1_000_000))));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { if (packets++ < 17) controller.enqueue(chunk); else { controller.enqueue(new TextEncoder().encode(wire(stop))); controller.close(); } },
    cancel() { cancelled = true; },
  });
  const events: TtsStreamEvent[] = [];
  await assert.rejects(synthesizeBailianSpeech(config(), "text", new AbortController().signal, event => { events.push(event); }, { fetch: fetchReturning(new Response(stream, { headers: { "content-type": "text/event-stream" } })) }), /大小限制/);
  assert.equal(cancelled, true);
  assert.equal(events.filter(event => event.type === "audio").length, 16);
  assert.equal(events.some(event => event.type === "done"), false);
});
