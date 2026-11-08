import { registerUiMessages, setUiLanguage } from '../shared/ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../shared/ui-copy.settings.en';
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DEFAULT_TTS_CONFIG, type TtsConfig } from "../shared/tts";
import { EmotionalVoiceControls, StreamingVoicePlayer, emotionalVoiceIssue, type EmotionalVoicePlaybackState, type VoicePlaybackEvent } from "../src/ui/EmotionalVoice";

const flush = async () => { for (let index = 0; index < 18; index++) await Promise.resolve(); };
const base64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const chunk = (bytes: number[], id = "a", firstAudioMs = 35): VoicePlaybackEvent => ({ id, type: "audio", data: base64(bytes), format: "pcm_s16le", sampleRate: 24000, channels: 1, firstAudioMs });

function audioEnvironment(options: { suspended?: boolean; resume?: () => Promise<void> } = {}) {
  const states: EmotionalVoicePlaybackState[] = [], errors: string[] = [], speaking: boolean[] = [];
  const contexts: AudioMock[] = [];
  let clock = 100;
  class SourceMock {
    buffer: { duration: number; samples: Float32Array } | null = null;
    onended: (() => void) | null = null;
    startAt = -1; stops = 0; disconnects = 0; destination: unknown;
    connect(value: unknown) { this.destination = value; }
    disconnect() { this.disconnects++; }
    start(at: number) { this.startAt = at; }
    stop() { this.stops++; }
    end() { this.onended?.(); }
  }
  class AudioMock {
    state = options.suspended ? "suspended" : "running";
    currentTime = 2; baseLatency = 0.01; outputLatency = 0.02;
    destination = { speaker: true }; closes = 0; gainDisconnects = 0;
    sources: SourceMock[] = [];
    gains: { gain: { value: number }; destination: unknown }[] = [];
    constructor() { contexts.push(this); }
    createGain() {
      const gain = { gain: { value: 1 }, destination: undefined as unknown, connect(value: unknown) { gain.destination = value; }, disconnect: () => { this.gainDisconnects++; } };
      this.gains.push(gain); return gain;
    }
    createBuffer(channels: number, frames: number, rate: number) {
      assert.equal(channels, 1); assert.equal(rate, 24000);
      const samples = new Float32Array(frames);
      return { duration: frames / rate, samples, getChannelData: () => samples };
    }
    createBufferSource() { const source = new SourceMock(); this.sources.push(source); return source; }
    async resume() { await options.resume?.(); if (this.state !== "closed") this.state = "running"; }
    async close() { this.state = "closed"; this.closes++; }
  }
  const player = new StreamingVoicePlayer({ onSpeaking: value => speaking.push(value), onState: value => states.push(value), onError: value => errors.push(value), createContext: () => new AudioMock() as unknown as AudioContext, now: () => clock });
  return { player, contexts, states, errors, speaking, setClock(value: number) { clock = value; } };
}

test("PCM chunks play in order with correct signed samples and separate network/playback latency", async () => {
  const env = audioEnvironment();
  await env.player.begin("a", 0.4);
  env.setClock(150);
  await env.player.accept(chunk([0, 0, 255, 127]));
  await env.player.accept(chunk([0, 128, 255, 255]));
  const context = env.contexts[0];
  assert.deepEqual(context.sources.flatMap(source => [...source.buffer!.samples]), [0, 32767 / 32768, -1, -1 / 32768]);
  assert.equal(context.gains[0].gain.value, 0.4);
  assert.ok(context.sources[1].startAt >= context.sources[0].startAt + context.sources[0].buffer!.duration);
  // R02: scheduling is not sound. This mock clock never advances, so lip-sync waits.
  assert.deepEqual(env.speaking, [false]);
  assert.equal(env.states.at(-1)?.firstAudioMs, 35);
  // Scheduling estimate: 50 ms elapsed + 100 ms bounded start lead + 30 ms reported latency.
  assert.ok(Math.abs(env.states.at(-1)!.firstPlaybackMs! - 180) < 1e-8);
  assert.equal(env.states.at(-1)?.playbackStartMs, undefined, "nothing was measured as audible yet");
  await env.player.accept({ id: "a", type: "done", firstAudioMs: 35, audioBytes: 8 });
  context.sources[0].end(); assert.equal(context.closes, 0);
  assert.deepEqual(env.speaking, [false, true], "an ended first buffer proves the output reached it");
  context.sources[1].end();
  assert.equal(context.closes, 1); assert.equal(context.gainDisconnects, 1);
  assert.equal(env.states.at(-1)?.phase, "idle");
  assert.equal(env.states.at(-1)?.firstAudioMs, 35);
  assert.deepEqual(env.errors, []);
});

test("odd chunk boundaries retain every PCM byte, including the first single-byte packet", async () => {
  const env = audioEnvironment(); await env.player.begin("a");
  await env.player.accept(chunk([0])); assert.equal(env.contexts[0].sources.length, 0);
  await env.player.accept(chunk([0, 255, 127, 0]));
  await env.player.accept(chunk([128, 255, 255]));
  assert.deepEqual(env.contexts[0].sources.flatMap(source => [...source.buffer!.samples]), [0, 32767 / 32768, -1, -1 / 32768]);
  await env.player.accept({ id: "a", type: "done", firstAudioMs: 35, audioBytes: 8 });
  assert.deepEqual(env.errors, []); env.player.dispose();
});

test("a short valid sample flushes on done, while an incomplete final sample fails safely", async () => {
  const env = audioEnvironment(); await env.player.begin("a");
  await env.player.accept(chunk([0, 64]));
  await env.player.accept({ id: "a", type: "done", firstAudioMs: 35, audioBytes: 2 });
  assert.deepEqual([...env.contexts[0].sources[0].buffer!.samples], [0.5]);
  env.player.stop(); await env.player.begin("b");
  await env.player.accept(chunk([0, 0, 0, 0, 1], "b"));
  await env.player.accept({ id: "b", type: "done", firstAudioMs: 35, audioBytes: 5 });
  assert.match(env.errors.at(-1)!, /末尾字节不完整/);
  assert.ok(env.contexts[1].sources.every(source => source.stops === 1));
});

test("wrong request IDs and late chunks after cancellation cannot resume an old voice", async () => {
  const env = audioEnvironment(); await env.player.begin("a");
  await env.player.accept(chunk([0, 0, 0, 0], "other"));
  assert.equal(env.contexts[0].sources.length, 0);
  await env.player.accept(chunk([0, 0, 0, 0]));
  const old = env.contexts[0].sources[0]; env.player.stop();
  assert.equal(old.stops, 1); assert.equal(old.onended, null); assert.equal(env.contexts[0].closes, 1);
  await env.player.begin("b");
  await env.player.accept(chunk([0, 0, 0, 0]));
  assert.equal(env.contexts[1].sources.length, 0);
  await env.player.accept(chunk([0, 0, 0, 0], "b"));
  assert.equal(env.contexts[1].sources.length, 1); env.player.dispose();
});

test("a WAV header split across chunks is rejected before scheduling noise", async () => {
  const env = audioEnvironment(); await env.player.begin("a");
  await env.player.accept(chunk([82]));
  await env.player.accept(chunk([73, 70, 70, 0, 0, 0, 0]));
  assert.match(env.errors.at(-1)!, /WAV/);
  assert.equal(env.contexts[0].sources.length, 0); assert.equal(env.contexts[0].closes, 1);
});

test("malformed base64, unsupported formats and empty audio complete without unsafe playback", async () => {
  for (const event of [
    { ...chunk([0, 0, 0, 0]), data: "%%%=" },
    { ...chunk([0, 0, 0, 0]), format: "wav" },
    { id: "a", type: "done", firstAudioMs: 0, audioBytes: 0 },
  ] as VoicePlaybackEvent[]) {
    const env = audioEnvironment(); await env.player.begin("a"); await env.player.accept(event);
    assert.equal(env.contexts[0].sources.length, 0); assert.equal(env.contexts[0].closes, 1);
    assert.equal(env.states.at(-1)?.phase, "error"); assert.equal(env.errors.length, 1);
  }
});

test("stop during suspended context startup invalidates the late resume and stream", async () => {
  let resume!: () => void;
  const pending = new Promise<void>(resolve => { resume = resolve; });
  const env = audioEnvironment({ suspended: true, resume: () => pending });
  const begin = env.player.begin("a"); env.player.stop(); resume(); await begin;
  await env.player.accept(chunk([0, 0, 0, 0]));
  assert.equal(env.contexts[0].state, "closed"); assert.equal(env.contexts[0].sources.length, 0);
  assert.ok(env.speaking.every(value => value === false)); assert.deepEqual(env.errors, []);
});

test("voice setup never invents a host and keeps the system scheme usable without credentials", () => {
  assert.equal(DEFAULT_TTS_CONFIG.apiHost, ""); assert.equal(DEFAULT_TTS_CONFIG.instruction, "");
  assert.equal(emotionalVoiceIssue({ ...DEFAULT_TTS_CONFIG }), null);
  const config = { ...DEFAULT_TTS_CONFIG, provider: "bailian" as const };
  assert.match(emotionalVoiceIssue(config)!, /真实/);
  assert.match(emotionalVoiceIssue({ ...config, apiHost: "https://console.example.test/", region: "cn-beijing" })!, /API Key/);
  assert.equal(emotionalVoiceIssue({ ...config, apiHost: "https://console.example.test/api/v1/services/audio/tts/SpeechSynthesizer", region: "cn-beijing", apiKey: "test-key" }), null);
  for (const host of ["http://console.example.test", "https://u:p@console.example.test", "https://console.example.test/wrong", "https://console.example.test?key=bad"])
    assert.match(emotionalVoiceIssue({ ...config, apiHost: host, region: "cn-beijing", apiKey: "test-key" })!, /Host/);
});

class ElementMock {
  id = ""; textContent = ""; className = ""; value = ""; type = ""; placeholder = "";
  hidden = false; disabled = false; autocomplete = ""; spellcheck = true; maxLength = 0; rows = 0;
  min = ""; max = ""; step = ""; dataset: Record<string, string> = {};
  children: ElementMock[] = []; attributes = new Map<string, string>();
  onclick: (() => void) | null = null; onchange: (() => void) | null = null; oninput: (() => void) | null = null;
  append(...children: ElementMock[]) { this.children.push(...children); }
  replaceChildren(...children: ElementMock[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  focus() {}
}
function uiEnvironment(t: TestContext, initial: Partial<TtsConfig> = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new ElementMock() } });
  const container = new ElementMock();
  let config: TtsConfig = { ...DEFAULT_TTS_CONFIG, ...initial }, context = "card-a:model-a";
  const changes: TtsConfig[] = [], previews: string[] = [], errors: string[] = [], intros: string[] = [];
  const previewResults: Promise<void>[] = [];
  let stops = 0, consoles = 0, guides = 0;
  const controls = new EmotionalVoiceControls(container as unknown as HTMLElement, {
    getConfig: () => structuredClone(config), getContextKey: () => context, getContextLabel: () => context,
    async onChange(value) { changes.push(structuredClone(value)); config = { ...value, apiKey: value.apiKey ? "••••••••" : "" }; },
    async onPreview(text) { previews.push(text); await previewResults.shift(); }, onStop() { stops++; }, onError: value => errors.push(value), onFirstUse: value => intros.push(value),
    onOpenConsole() { consoles++; }, onOpenGuide() { guides++; },
  });
  const byId = (id: string): ElementMock => {
    const find = (node: ElementMock): ElementMock | undefined => node.id === id ? node : node.children.map(find).find(Boolean);
    const element = find(container); assert.ok(element, id); return element;
  };
  t.after(() => { controls.dispose(); if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); });
  return { controls, changes, previews, previewResults, errors, intros, byId, config: () => config, stops: () => stops, consoles: () => consoles, guides: () => guides,
    setConfig(value: TtsConfig) { config = value; }, setContext(value: string) { context = value; },
    edit(id: string, value: string) { const input = byId(id); input.value = value; input.oninput?.(); },
    choose(id: string, value: string) { const input = byId(id); input.value = value; input.onchange?.(); },
  };
}

test("first-use prompt is opt-in and never enables cloud output or makes an automatic request", async t => {
  const env = uiEnvironment(t);
  assert.equal(env.intros.length, 1); assert.match(env.intros[0], /自己的百炼账号/);
  assert.equal(env.config().provider, "system"); assert.equal(env.previews.length, 0); assert.equal(env.changes.length, 0);
  assert.equal(env.byId("tts-api-key").value, "");
  env.byId("tts-open-console").onclick?.(); env.byId("tts-open-guide").onclick?.();
  await flush();
  assert.equal(env.consoles(), 1); assert.equal(env.guides(), 1);
});

test("saving an entered key submits it once, then removes it from the password field", async t => {
  const env = uiEnvironment(t);
  env.choose("tts-provider", "bailian"); env.edit("tts-api-host", "https://console.example.test");
  env.edit("tts-region", "cn-beijing"); env.edit("tts-api-key", "example-test-key");
  env.byId("tts-save").onclick?.(); await flush();
  assert.equal(env.changes.length, 1); assert.equal(env.changes[0].apiKey, "example-test-key");
  assert.equal(env.byId("tts-api-key").value, ""); assert.match(env.byId("tts-api-key").placeholder, /已加密保存/);
  assert.equal(env.config().apiKey, "••••••••"); assert.equal(env.byId("tts-introduction").hidden, true);
  assert.equal(env.previews.length, 0);
});

test("changed host or region cannot silently reuse the previous saved key", async t => {
  const env = uiEnvironment(t, { provider: "bailian", apiHost: "https://old.example.test", region: "cn-beijing", apiKey: "••••••••", introduced: true });
  env.edit("tts-api-host", "https://new.example.test");
  env.byId("tts-preview").onclick?.(); await flush();
  assert.equal(env.changes.length, 0); assert.equal(env.previews.length, 0);
  assert.match(env.byId("tts-playback-status").textContent, /API Key/);
  env.edit("tts-api-host", "https://old.example.test/api/v1/services/audio/tts/SpeechSynthesizer");
  env.byId("tts-preview").onclick?.(); await flush();
  assert.equal(env.previews.length, 1, "the exact official endpoint suffix still identifies the saved host");
});

test("custom style drafts stay local, preset instructions are read-only, and context changes clear old drafts", async t => {
  const env = uiEnvironment(t, { provider: "bailian", introduced: true });
  env.edit("tts-instruction", "style for A"); env.edit("tts-api-key", "unsaved-key");
  env.controls.refresh();
  assert.equal(env.byId("tts-instruction").value, "style for A"); assert.equal(env.byId("tts-api-key").value, "unsaved-key");
  env.choose("tts-emotion", "cheerful"); assert.equal(env.byId("tts-instruction").disabled, true);
  env.choose("tts-emotion", "custom"); assert.equal(env.byId("tts-instruction").value, "style for A");
  env.setContext("card-b:model-b"); env.setConfig({ ...DEFAULT_TTS_CONFIG, provider: "bailian", instruction: "saved style B", introduced: true });
  env.controls.refresh();
  assert.equal(env.byId("tts-instruction").value, "saved style B"); assert.equal(env.byId("tts-api-key").value, "");
  assert.equal(env.changes.length, 0);
});

test("playback status reports distinct measured metrics and never invents a first-audio result", async t => {
  const env = uiEnvironment(t);
  assert.match(env.byId("tts-playback-status").textContent, /未实测/);
  env.controls.setPlaybackState({ phase: "playing", firstAudioMs: 312, firstPlaybackMs: 386 });
  assert.match(env.byId("tts-playback-status").textContent, /首个音频包 312 ms/);
  // R02: a scheduling estimate is never presented as playback.
  assert.match(env.byId("tts-playback-status").textContent, /播放延迟未实测/);
  env.controls.setPlaybackState({ phase: "playing", firstAudioMs: 312, firstPlaybackMs: 386, playbackStartMs: 401 });
  assert.match(env.byId("tts-playback-status").textContent, /开始出声 401 ms（实测）/);
  env.byId("tts-stop").onclick?.(); await flush(); assert.equal(env.stops(), 1);
  assert.equal(env.byId("tts-stop").disabled, true);
});

test("completion follows the last scheduled sample, resolves cancellation and rejects playback errors", async () => {
  const env = audioEnvironment(); await env.player.begin("a");
  let complete = false; const finished = env.player.finished.then(() => { complete = true; });
  await env.player.accept(chunk([0, 0, 0, 0]));
  await env.player.accept({ id: "a", type: "done", firstAudioMs: 35, audioBytes: 4 });
  await flush(); assert.equal(complete, false);
  env.contexts[0].sources[0].end(); await finished; assert.equal(complete, true);
  await env.player.begin("b"); const canceled = env.player.finished; env.player.stop(); await canceled;
  await env.player.begin("c"); const failed = env.player.finished;
  await env.player.accept({ id: "c", type: "error", message: "stream failed" });
  await assert.rejects(failed, /stream failed/);
});

test("a previous preview failure cannot overwrite a newer playback or a stopped state", async t => {
  const env = uiEnvironment(t, { provider: "bailian", apiHost: "https://console.example.test", region: "cn-beijing", apiKey: "••••••••", introduced: true });
  let reject!: (error: Error) => void;
  env.previewResults.push(new Promise<void>((_, fail) => { reject = fail; }));
  env.byId("tts-preview").onclick?.(); await flush();
  assert.equal(env.previews.length, 1);
  env.byId("tts-preview").onclick?.(); await flush();
  env.controls.setPlaybackState({ phase: "playing", firstAudioMs: 100, firstPlaybackMs: 160 });
  reject(new Error("late canceled request")); await flush();
  assert.equal(env.byId("tts-playback-status").dataset.phase, "playing"); assert.deepEqual(env.errors, []);
  env.byId("tts-stop").onclick?.();
  assert.equal(env.byId("tts-playback-status").dataset.phase, "idle");
});

test('English voice settings retain private instructions and never enable a provider on presentation', async t => {
 registerUiMessages({en:ENGLISH_SETTINGS_UI_COPY,'zh-CN':{}});setUiLanguage('en');t.after(()=>setUiLanguage('zh-CN'));
 const privateInstruction='保存语音配置'.repeat(12),env=uiEnvironment(t,{instruction:privateInstruction,emotion:'custom'});
 assert.equal(env.byId('tts-save').textContent,'Save voice settings');
 assert.equal(env.byId('tts-preview-panel').textContent,'Preview panel style only');
 assert.equal(env.byId('tts-instruction').value,privateInstruction);
 assert.equal(env.byId('tts-preview-text').value,'Hello. I’m here with you. Let’s take things one step at a time.');
 assert.equal(env.config().provider,'system');assert.equal(env.changes.length,0);assert.equal(env.previews.length,0);
 assert.match(emotionalVoiceIssue({...DEFAULT_TTS_CONFIG,provider:'bailian'})! ,/HTTPS API host/);
 const raw='synthetic provider detail E_CONN_123';
 env.previewResults.push(Promise.reject(new Error(raw)));env.byId('tts-preview').onclick?.();await flush();
 assert.ok(env.errors.some(value=>value.includes(raw)));
 assert.ok(!env.byId('tts-playback-status').textContent.includes(raw));
 assert.match(env.byId('tts-playback-status').textContent,/View issue details/);
});
