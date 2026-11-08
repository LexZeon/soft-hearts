import {
  DEFAULT_TTS_CONFIG,
  TTS_EMOTIONS,
  type TtsConfig,
  type TtsEmotion,
  type TtsStreamEvent,
  type TtsSynthesisResult,
} from "../shared/tts";
import { bailianCodeFailure, httpFailure, type SpeechFailure } from "../shared/speech-failure";

export const BAILIAN_TTS_PATH = "/api/v1/services/audio/tts/SpeechSynthesizer";
export const TTS_TEXT_LIMIT = 2000;
const MAX_EVENT_CHARS = 2_000_000;
const MAX_AUDIO_BYTES = 16_000_000;
const KEY_SENTINEL = "••••••••";

/** Deliberately sanitized adapter errors are the only messages safe for renderer IPC. */
export class TtsError extends Error {
  /** Closed category for the experience journal (never the message text itself). */
  constructor(readonly publicMessage: string, readonly failure: SpeechFailure = "other") {
    super(publicMessage);
    this.name = "TtsError";
  }
}

function bounded(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

export function validateTtsConfig(value: unknown): TtsConfig {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<TtsConfig> : {};
  let apiHost = bounded(input.apiHost, "", 2000);
  if (apiHost) {
    let url: URL;
    try { url = new URL(apiHost); }
    catch { throw new TtsError("请填写从百炼控制台复制的完整 HTTPS API Host。"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["/", BAILIAN_TTS_PATH].includes(url.pathname))
      throw new TtsError("百炼 API Host 必须为 HTTPS 地址或官方 SpeechSynthesizer 端点，不能包含其它路径、凭据或查询参数。");
    apiHost = url.origin;
  }
  const emotion: TtsEmotion = TTS_EMOTIONS.some(item => item.id === input.emotion)
    ? input.emotion! : DEFAULT_TTS_CONFIG.emotion;
  const identifier = (value: unknown, fallback: string) => {
    const result = bounded(value, fallback, 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(result))
      throw new TtsError("百炼模型或音色 ID 格式不正确。");
    return result;
  };
  const styleBindings: NonNullable<TtsConfig["styleBindings"]> = [];
  if (Array.isArray(input.styleBindings)) for (const raw of input.styleBindings.slice(0, 64)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const characterId = bounded(raw.characterId, "", 160), modelPath = bounded(raw.modelPath, "", 2000);
    if (!characterId || !modelPath) continue;
    styleBindings.push({
      characterId, modelPath,
      voice: identifier(raw.voice, DEFAULT_TTS_CONFIG.voice),
      instruction: bounded(raw.instruction, "", 1000),
      emotion: TTS_EMOTIONS.some(item => item.id === raw.emotion) ? raw.emotion : "custom",
      rate: typeof raw.rate === "number" && Number.isFinite(raw.rate) ? Math.min(2, Math.max(0.5, raw.rate)) : 1,
    });
  }
  return {
    provider: input.provider === "bailian" ? "bailian" : "system",
    apiHost,
    region: bounded(input.region, "", 80),
    model: identifier(input.model, DEFAULT_TTS_CONFIG.model),
    voice: identifier(input.voice, DEFAULT_TTS_CONFIG.voice),
    instruction: bounded(input.instruction, DEFAULT_TTS_CONFIG.instruction, 1000),
    emotion,
    rate: typeof input.rate === "number" && Number.isFinite(input.rate)
      ? Math.min(2, Math.max(0.5, input.rate)) : 1,
    apiKey: bounded(input.apiKey, "", 2000),
    introduced: input.introduced === true,
    styleBindings,
  };
}

/** A redacted key can be reused only with the same explicit API Host and region. */
export function resolveTtsKey(next: TtsConfig, previous?: TtsConfig): TtsConfig {
  if (next.apiKey !== KEY_SENTINEL) return next;
  return { ...next, apiKey: next.apiHost === previous?.apiHost && next.region === previous.region ? previous.apiKey : "" };
}

export function ttsInstruction(config: Pick<TtsConfig, "instruction" | "emotion">): string {
  if (config.emotion === "custom") return config.instruction;
  return TTS_EMOTIONS.find(item => item.id === config.emotion)?.instruction ?? config.instruction;
}

interface TtsDependencies {
  fetch?: typeof fetch;
  /** Monotonic milliseconds, injected only by tests. */
  now?: () => number;
  timeoutMs?: number;
}

/** Native HTTP SSE adapter. It never follows returned audio URLs, writes audio, or exposes a key. */
export async function synthesizeBailianSpeech(
  value: TtsConfig,
  text: string,
  signal: AbortSignal,
  emit: (event: TtsStreamEvent) => void | Promise<void>,
  dependencies: TtsDependencies = {},
): Promise<TtsSynthesisResult> {
  const config = validateTtsConfig(value);
  if (config.provider !== "bailian") throw new TtsError("当前未选择百炼情感语音。");
  if (!config.apiHost) throw new TtsError("请先填写同地域百炼控制台提供的真实 API Host。");
  if (!config.apiKey || config.apiKey === KEY_SENTINEL) throw new TtsError("请先填写该地域的百炼 API Key。", "auth");
  if (typeof text !== "string" || !text.trim() || text.length > TTS_TEXT_LIMIT)
    throw new TtsError(`语音文字须为 1–${TTS_TEXT_LIMIT} 个字符。`);
  signal.throwIfAborted();
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? 120000);
  const combined = AbortSignal.any([signal, timeout]);
  const failTransport = (): Error => {
    signal.throwIfAborted();
    return timeout.aborted ? new TtsError("百炼语音响应超时，请稍后重试。", "timeout")
      : new TtsError("无法连接百炼语音，请检查 API Host、地域、网络和代理设置。", "network");
  };
  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(config.apiHost + BAILIAN_TTS_PATH, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "X-DashScope-SSE": "enable" },
      body: JSON.stringify({ model: config.model, input: { text: text.trim(), voice: config.voice, format: "pcm", sample_rate: 24000, ...(ttsInstruction(config) ? { instruction: ttsInstruction(config) } : {}), rate: config.rate } }),
      redirect: "error",
      signal: combined,
    });
  } catch { throw failTransport(); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TtsError(`百炼语音返回 HTTP ${response.status}，请核对同地域 API Key、Host、模型与音色权限。`, httpFailure(response.status));
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new TtsError("百炼语音没有返回 SSE 音频流，请核对原生 SpeechSynthesizer API Host。", "service");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", dataLines: string[] = [], dataChars = 0;
  let audioBytes = 0, firstAudioMs: number | null = null, stopped = false;
  let requestId: string | undefined;
  const processData = async (data: string) => {
    combined.throwIfAborted();
    if (data === "[DONE]") { stopped = true; return; }
    let event: Record<string, unknown>;
    try { event = JSON.parse(data); }
    catch { throw new TtsError("百炼语音返回了无效 SSE 数据。", "service"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TtsError("百炼语音事件格式不正确。", "service");
    if (typeof event.code === "string" && event.code && event.code !== "200")
      throw new TtsError("百炼语音拒绝了请求，请检查地域、Key、模型和音色权限。", bailianCodeFailure(event.code));
    if (typeof event.request_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event.request_id)) requestId = event.request_id;
    const output = event.output as { audio?: { data?: unknown }; finish_reason?: unknown } | undefined;
    const dataValue = output?.audio?.data;
    if (dataValue !== undefined && dataValue !== null && dataValue !== "") {
      if (typeof dataValue !== "string" || dataValue.length > MAX_EVENT_CHARS
        || dataValue.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataValue))
        throw new TtsError("百炼语音返回了无效音频数据。", "service");
      const bytes = Buffer.from(dataValue, "base64");
      if (bytes.toString("base64") !== dataValue) throw new TtsError("百炼语音返回了无效音频数据。", "service");
      if (bytes.length) {
        if (audioBytes === 0 && bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "RIFF")
          throw new TtsError("百炼语音返回了 WAV，而当前请求需要原始 PCM。", "service");
        audioBytes += bytes.length;
        if (audioBytes > MAX_AUDIO_BYTES) throw new TtsError("百炼语音流超过本机播放大小限制。", "service");
        const first = firstAudioMs === null;
        if (first) firstAudioMs = Math.max(0, now() - started);
        await emit({ type: "audio", data: dataValue, format: "pcm_s16le", sampleRate: 24000, channels: 1, ...(first ? { firstAudioMs: firstAudioMs! } : {}) });
        combined.throwIfAborted();
      }
    }
    if (output?.finish_reason === "stop") stopped = true;
    else if (typeof output?.finish_reason === "string" && !["", "null"].includes(output.finish_reason))
      throw new TtsError("百炼语音未正常完成，请重试或缩短文字。", "service");
  };
  const line = async (value: string) => {
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (!value) {
      if (dataLines.length) await processData(dataLines.join("\n"));
      dataLines = []; dataChars = 0;
    } else if (value.startsWith("data:")) {
      const data = value.slice(5).replace(/^ /, "");
      dataChars += data.length;
      if (dataChars > MAX_EVENT_CHARS) throw new TtsError("百炼语音事件过大。", "service");
      dataLines.push(data);
    }
  };
  try {
    while (!stopped) {
      let value: ReadableStreamReadResult<Uint8Array>;
      try { value = await reader.read(); }
      catch { throw failTransport(); }
      combined.throwIfAborted();
      if (value.done) {
        buffer += decoder.decode();
        if (buffer) await line(buffer);
        await line("");
        break;
      }
      buffer += decoder.decode(value.value, { stream: true });
      if (buffer.length > MAX_EVENT_CHARS * 2) throw new TtsError("百炼语音事件过大。", "service");
      let end: number;
      while (!stopped && (end = buffer.indexOf("\n")) !== -1) {
        await line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    }
    combined.throwIfAborted();
    if (!stopped) throw new TtsError("百炼语音连接提前结束，请重试。", "network");
    if (firstAudioMs === null || audioBytes < 2 || audioBytes % 2)
      throw new TtsError("百炼语音未返回完整的 16-bit PCM 音频，请核对模型与音色。", "service");
    const result: TtsSynthesisResult = { firstAudioMs, audioBytes, ...(requestId ? { requestId } : {}) };
    await emit({ type: "done", ...result });
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

