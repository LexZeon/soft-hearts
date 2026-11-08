import { uiText, uiTemplate } from './ui-language';
import { ENGLISH_SETTINGS_UI_COPY } from '../../shared/ui-copy.settings.en';
import { DEFAULT_TTS_CONFIG, TTS_EMOTIONS, type TtsConfig, type TtsStreamEvent } from "../../shared/tts";
import { SharedAudioOutput, defaultAudioTimers, type AudioOutputLease, type AudioOutputTimers } from "./audio-output";
import type { SpeechStageSummary } from "../../shared/speech-diagnostics";

/** Device starts at or above this are shown in the status line as the likely delay. */
export const SLOW_DEVICE_START_MS = 300;
/** Bounded jitter buffer: the first PCM chunk starts this far after the audio clock. */
export const PLAYBACK_START_LEAD_S = 0.1;
/** After a mid-stream underrun, resume with a shorter lead. */
const PLAYBACK_RESUME_LEAD_S = 0.03;
/**
 * Reported output latency is trusted up to this much (Bluetooth is ~0.2–0.3 s).
 * A bogus multi-second report must not hold the mouth closed while sound plays;
 * the raw values are recorded in the R02 diagnostics instead.
 */
export const MAX_OUTPUT_LAG_S = 0.5;
/** Poll interval while waiting for the audio clock to reach a scheduled sample. */
const AUDIBLE_POLL_MS = 40;
/** B06 feed pause: gain fade before the scheduled PCM is stopped (and after it restarts), so the cut never clicks. */
export const PAUSE_FADE_S = 0.04;

export const EMOTIONAL_VOICE_INTRO = "可选百炼情感语音：情感表达更丰富。需要你自己的百炼账号、同地域 API Key 与控制台真实 API Host，配置后可试听；系统语音仍可随时切换。";
export const EMOTIONAL_VOICE_PREVIEW = "你好，我会在这里陪你，先把手边的事情慢慢做好。";
export const BAILIAN_VOICE_CHOICES = [
  { id: "longanlingxin_v3.1", label: "龙安灵心 · 默认" },
  { id: "longanhuan_v3.1", label: "龙安欢" },
  { id: "longanfengyue_v3.1", label: "龙安风悦" },
  { id: "xunanchuan_v3.1", label: "许南川" },
] as const;

/** A blank host stays blank; the renderer never guesses an API region or endpoint. */
export function emotionalVoiceIssue(config: TtsConfig): string | null {
  if (config.provider === "system") return null;
  if (!config.apiHost.trim()) return uiText("请填写百炼控制台提供的真实 HTTPS API Host。");
  try {
    const host = new URL(config.apiHost.trim());
    if (host.protocol !== "https:" || host.username || host.password || !["/", "/api/v1/services/audio/tts/SpeechSynthesizer"].includes(host.pathname) || host.search || host.hash)
      return uiText("API Host 只填写 HTTPS 主机地址，不带接口路径、凭据或查询参数。");
  } catch { return uiText("API Host 格式不正确，请从百炼控制台复制。"); }
  if (!config.region.trim()) return uiText("请注明该 Host 与 API Key 所属的同一地域。");
  if (!config.apiKey?.trim()) return uiText("请填写该地域的 API Key；密钥由本机后端加密保存。");
  if (!config.model.trim() || !config.voice.trim()) return uiText("请填写模型与音色 ID。");
  return null;
}

function canonicalHost(value: string): string {
  try { const host = new URL(value.trim()); return host.origin; } catch { return value.trim(); }
}

export interface EmotionalVoicePlaybackState {
  phase: "idle" | "loading" | "playing" | "error";
  /** Host network: synthesis request dispatch to the first PCM bytes. */
  firstAudioMs?: number;
  /** Scheduling-time estimate kept for compatibility; never shown as "playback". */
  firstPlaybackMs?: number;
  /**
   * Speech request start to the audio clock reaching the first sample. Measured from the
   * device's output timestamp, unless `playbackStartEstimated` says it had to be inferred.
   */
  playbackStartMs?: number;
  /**
   * True when `playbackStartMs` is an estimate (X-088): no output timestamp, an output lag
   * capped at MAX_OUTPUT_LAG_S, or a first sample later than the timestamp (extrapolated,
   * e.g. released by a buffer's end). The status line then says "估计", never "实测".
   */
  playbackStartEstimated?: boolean;
  /** Measured: how long the audio output device took to start for this playback. */
  deviceStartMs?: number;
  /** R02: per-stage durations of this playback on the renderer clock (host network as a duration). */
  stages?: SpeechStageSummary;
  message?: string;
}

/** Compact "where did the time go" line; only measured stages appear. */
export function formatSpeechStages(stages: SpeechStageSummary | undefined): string {
  if (!stages) return "";
  const parts = [
    stages.leaseMs !== undefined ? uiTemplate`授权 ${stages.leaseMs}` : "",
    stages.prepareMs !== undefined ? uiTemplate`准备 ${stages.prepareMs}` : "",
    stages.deviceMs !== undefined ? uiTemplate`设备 ${stages.deviceMs}` : "",
    stages.requestToPacketMs !== undefined ? (stages.hostFirstAudioMs !== undefined
      ? uiTemplate`请求→首包 ${stages.requestToPacketMs}（主进程网络 ${stages.hostFirstAudioMs}）` : uiTemplate`请求→首包 ${stages.requestToPacketMs}`) : "",
    stages.packetToScheduledMs !== undefined ? uiTemplate`首包→排程 ${stages.packetToScheduledMs}` : "",
    stages.scheduledToAudibleMs !== undefined ? uiTemplate`排程→出声 ${stages.scheduledToAudibleMs}` : "",
    stages.outputLatencyMs !== undefined || stages.baseLatencyMs !== undefined
      ? uiTemplate`报告延迟 ${stages.baseLatencyMs ?? "-"}/${stages.outputLatencyMs ?? "-"}` : "",
  ].filter(Boolean);
  return parts.length ? uiTemplate`分段 ms：${parts.join(" · ")}` : "";
}
interface EmotionalVoiceOptions {
  getConfig(): TtsConfig;
  onChange(config: TtsConfig): Promise<void>;
  onPreview(text: string): Promise<void>;
  onCharacterPreview?(text: string): Promise<void>;
  onStop(): void | Promise<void>;
  onError(message: string): void;
  onFirstUse?(message: string): void;
  getContextLabel?(): string;
  getContextKey?(): string;
  onOpenConsole?(): void | Promise<void>;
  onOpenGuide?(): void | Promise<void>;
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag);
  if (text) result.textContent = text;
  if (className) result.className = className;
  return result;
};

/** Explicit save and preview keep draft secrets confined to the password field until submission. */
export class EmotionalVoiceControls {
  private readonly provider = node("select");
  private readonly host = node("input");
  private readonly region = node("input");
  private readonly model = node("input");
  private readonly voice = node("input");
  private readonly key = node("input");
  private readonly emotion = node("select");
  private readonly instruction = node("textarea");
  private readonly rate = node("input");
  private readonly rateValue = node("output");
  private readonly previewText = node("textarea");
  private readonly intro = node("div", "", "emotional-voice-intro");
  private readonly cloud = node("div", "", "emotional-voice-cloud");
  private readonly status = node("p", uiText("尚未试听 · 首音延迟未实测"), "emotional-voice-status");
  private readonly contextLabel = node("p", "", "emotional-voice-context");
  private readonly save = node("button", uiText("保存语音配置"), "subtle");
  private readonly preview = node("button", uiText("试听"), "primary");
  private readonly panelPreview = node('button', uiText('仅试听面板风格'), 'subtle');
  private readonly stop = node("button", uiText("停止试听"), "subtle");
  private readonly clearKey = node("button", uiText("清除已存 Key"), "subtle");
  private busy = false;
  private disposed = false;
  private previewGeneration = 0;
  private dirty = false;
  private contextKey = "";
  private customInstruction = DEFAULT_TTS_CONFIG.instruction;
  private playback: EmotionalVoicePlaybackState = { phase: "idle" };

  constructor(private readonly container: HTMLElement, private readonly options: EmotionalVoiceOptions) {
    this.render();
    this.refresh();
    if (!options.getConfig().introduced) options.onFirstUse?.(uiText(EMOTIONAL_VOICE_INTRO));
  }

  refresh(): void {
    if (this.disposed) return;
    const config = this.options.getConfig();
    const contextKey = this.options.getContextKey?.() ?? this.options.getContextLabel?.() ?? "";
    if (contextKey !== this.contextKey) { this.contextKey = contextKey; this.dirty = false; }
    this.contextLabel.textContent = this.options.getContextLabel?.() ?? uiText("当前角色 / 当前模型的语音风格");
    this.intro.hidden = config.introduced === true;
    if (this.dirty) { this.applyAvailability(); return; }
    this.provider.value = config.provider;
    this.host.value = config.apiHost;
    this.region.value = config.region;
    this.model.value = config.model;
    this.voice.value = config.voice;
    this.emotion.value = config.emotion;
    this.customInstruction = config.instruction;
    this.instruction.value = config.emotion === "custom" ? config.instruction
      : TTS_EMOTIONS.find(item => item.id === config.emotion)?.instruction ?? config.instruction;
    this.rate.value = String(config.rate);
    this.key.value = "";
    this.key.placeholder = config.apiKey ? uiText("已加密保存；留空保留，下面可清除") : uiText("填写此地域的 API Key");
    this.intro.hidden = config.introduced === true;
    this.applyAvailability();
  }

  setPlaybackState(state: EmotionalVoicePlaybackState): void {
    if (this.disposed) return;
    this.playback = { ...state };
    this.status.dataset.phase = state.phase;
    // Only measured values: the old "browser estimate" was computed when a buffer
    // was scheduled and could not see a stalled or slow-starting output device.
    const metrics = [
      Number.isFinite(state.firstAudioMs) ? uiTemplate`首个音频包 ${Math.round(state.firstAudioMs!)} ms` : uiText("首个音频包未实测"),
      !Number.isFinite(state.playbackStartMs) ? uiText("播放延迟未实测")
        : state.playbackStartEstimated ? uiTemplate`开始出声 ${Math.round(state.playbackStartMs!)} ms（估计）`
        : uiTemplate`开始出声 ${Math.round(state.playbackStartMs!)} ms（实测）`,
      ...(Number.isFinite(state.deviceStartMs) && state.deviceStartMs! >= SLOW_DEVICE_START_MS
        ? [uiTemplate`音频设备启动 ${Math.round(state.deviceStartMs!)} ms`] : []),
    ];
    const phase = { idle: uiText("就绪"), loading: uiText("正在合成…"), playing: uiText("流式播放中"), error: uiText("试听未完成") }[state.phase];
    const fixedMessage = state.message && (Object.hasOwn(ENGLISH_SETTINGS_UI_COPY, state.message)
      || Object.values(ENGLISH_SETTINGS_UI_COPY).includes(state.message));
    const message = state.message ? fixedMessage ? uiText(state.message) : uiText('语音输出未完成，请查看问题详情。') : phase;
    const stages = formatSpeechStages(state.stages);
    this.status.textContent = `${message} · ${metrics.join(" · ")}${stages ? ` · ${stages}` : ""}`;
    this.applyAvailability();
  }

  dispose(): void { this.previewGeneration++; this.disposed = true; this.container.replaceChildren(); }

  private render(): void {
    const section = node("section", "", "settings-section emotional-voice");
    section.setAttribute("aria-label", uiText("语音输出方案"));
    section.append(node("h3", uiText("语音输出方案")));
    section.append(node('p', uiText('支持的百炼模型会结合当前角色性格与心情。试听当前角色使用同一条后端风格链；仅试听面板风格可单独比较常态设置。系统语音不支持角色或情绪指令。'), 'muted'));
    const introText = node("p", uiText(EMOTIONAL_VOICE_INTRO));
    const configure = node("button", uiText("查看百炼配置"), "subtle");
    const dismiss = node("button", uiText("先用当前方案"), "subtle");
    configure.type = dismiss.type = "button";
    configure.onclick = () => { this.dirty = true; this.provider.value = "bailian"; this.applyAvailability(); this.host.focus(); };
    dismiss.onclick = () => void this.commit({ ...this.options.getConfig(), introduced: true });
    this.intro.id = "tts-introduction";
    this.intro.append(introText, configure, dismiss);
    section.append(this.intro);
    this.provider.id = "tts-provider";
    for (const [value, label] of [["system", uiText("系统语音 · 原方案")], ["bailian", uiText("阿里百炼 · 情感更丰富（需 API Key）")]]) {
      const option = node("option", label); option.value = value; this.provider.append(option);
    }
    this.provider.onchange = () => { this.dirty = true; this.applyAvailability(); };
    section.append(this.field(uiText("输出方案"), this.provider));
    const inputs = [[this.host, "tts-api-host", uiText("API Host（从同地域控制台复制）")],
      [this.region, "tts-region", uiText("地域（与 Key 和 Host 相同）")],
      [this.model, "tts-model", uiText("模型 ID")], [this.voice, "tts-voice", uiText("音色 ID")],
      [this.key, "tts-api-key", "API Key"]] as const;
    for (const [input, id, label] of inputs) {
      input.id = id; input.type = input === this.key ? "password" : "text";
      input.autocomplete = "off"; input.spellcheck = false; input.maxLength = input === this.key ? 2000 : 2000;
      input.oninput = () => { this.dirty = true; };
      this.cloud.append(this.field(label, input));
    }
    this.host.placeholder = uiText("只填控制台真实 HTTPS 主机，不填写接口路径");
    this.region.placeholder = uiText("例如 cn-beijing / ap-southeast-1");
    const voiceOptions = node("datalist"); voiceOptions.id = "tts-voice-options";
    for (const choice of BAILIAN_VOICE_CHOICES) {
      const option = node("option", uiText(choice.label)); option.value = choice.id; voiceOptions.append(option);
    }
    this.voice.setAttribute("list", voiceOptions.id);
    this.cloud.append(voiceOptions, node("p", uiText("内置音色候选适用北京 / 新加坡；其它音色需以所选地域控制台为准。"), "hint"));
    const links = node("div", "", "emotional-voice-actions");
    for (const [id, label, open] of [["tts-open-console", uiText("百炼控制台"), this.options.onOpenConsole], ["tts-open-guide", uiText("查看开通说明"), this.options.onOpenGuide]] as const) {
      const button = node("button", label, "subtle"); button.id = id; button.type = "button"; button.disabled = !open;
      button.onclick = () => { if (open) void Promise.resolve().then(() => open()).catch(error => this.options.onError(String(error))); };
      links.append(button);
    }
    this.cloud.append(links, node("p", uiText("Host、地域与 Key 属于本机连接；下面的音色、情绪和指令属于当前角色与模型。"), "hint"), this.contextLabel);
    this.clearKey.id = "tts-clear-key"; this.clearKey.type = "button";
    this.clearKey.onclick = () => void this.commit({ ...this.options.getConfig(), apiKey: "" });
    this.cloud.append(this.clearKey);
    this.emotion.id = "tts-emotion";
    for (const item of TTS_EMOTIONS) { const option = node("option", uiText(item.label)); option.value = item.id; this.emotion.append(option); }
    this.emotion.onchange = () => {
      this.dirty = true;
      this.instruction.value = this.emotion.value === "custom" ? this.customInstruction
        : TTS_EMOTIONS.find(item => item.id === this.emotion.value)?.instruction ?? "";
      this.applyAvailability();
    };
    this.instruction.id = "tts-instruction"; this.instruction.rows = 3; this.instruction.maxLength = 1000;
    this.instruction.placeholder = uiText("自然清晰；可为当前角色设置专属表达风格。");
    this.instruction.oninput = () => { this.dirty = true; if (this.emotion.value === "custom") this.customInstruction = this.instruction.value; };
    this.cloud.append(this.field(uiText("情绪"), this.emotion), this.field(uiText("情感与表达指令"), this.instruction));
    this.rate.id = "tts-rate"; this.rate.type = "range"; this.rate.min = "0.5"; this.rate.max = "2"; this.rate.step = "0.05";
    this.rate.oninput = () => { this.dirty = true; this.rateValue.value = `${Number(this.rate.value).toFixed(2)}×`; };
    const speed = this.field(uiText("语速"), this.rate); speed.append(this.rateValue); this.cloud.append(speed);
    this.cloud.append(node("p", uiText("选择预设情绪会使用对应表达指令；自定义可编辑。语速独立控制。密钥只由本机后端加密保存。"), "hint"));
    section.append(this.cloud);
    this.previewText.id = "tts-preview-text"; this.previewText.rows = 2; this.previewText.maxLength = 300; this.previewText.value = uiText(EMOTIONAL_VOICE_PREVIEW);
    section.append(this.field(uiText("试听文字"), this.previewText));
    const actions = node("div", "", "emotional-voice-actions");
    this.save.id = "tts-save"; this.preview.id = "tts-preview"; this.stop.id = "tts-stop";
    for (const button of [this.save, this.preview, this.stop]) button.type = "button";
    this.save.onclick = () => void this.commit(this.formConfig());
    this.preview.onclick = () => void this.previewCurrent(true);
    this.panelPreview.id = 'tts-preview-panel'; this.panelPreview.type = 'button';
    this.panelPreview.onclick = () => void this.previewCurrent(false);
    this.stop.onclick = () => {
      const generation = ++this.previewGeneration;
      void Promise.resolve().then(() => this.options.onStop()).catch(error => { if (!this.disposed && generation === this.previewGeneration) this.options.onError(String(error)); });
      this.setPlaybackState({ phase: "idle", message: uiText("已停止") });
    };
    actions.append(this.save, this.preview, this.panelPreview, this.stop); section.append(actions);
    this.status.id = "tts-playback-status"; this.status.setAttribute("role", "status");
    section.append(this.status, node("p", uiText("百炼试听及朗读会把当前文字发送给配置的百炼服务；系统语音保留可选。首音数据在实际请求后显示，不等同扬声器声学测量。"), "hint"));
    this.container.replaceChildren(section);
  }

  private field(label: string, input: HTMLElement): HTMLLabelElement {
    const result = node("label", "", "emotional-voice-field"); result.append(node("span", label), input); return result;
  }

  private formConfig(): TtsConfig {
    const current = this.options.getConfig();
    const sameEndpoint = canonicalHost(this.host.value) === canonicalHost(current.apiHost) && this.region.value.trim() === current.region;
    return { ...current, provider: this.provider.value === "bailian" ? "bailian" : "system", apiHost: this.host.value.trim(),
      region: this.region.value.trim(), model: this.model.value.trim(), voice: this.voice.value.trim(),
      emotion: this.emotion.value as TtsConfig["emotion"], instruction: this.customInstruction,
      rate: Number(this.rate.value), apiKey: this.key.value.trim() || (sameEndpoint ? current.apiKey : ""), introduced: true };
  }

  private async commit(config: TtsConfig, preservePreview = false): Promise<boolean> {
    if (this.disposed || this.busy) return false;
    if (!preservePreview) this.previewGeneration++;
    this.busy = true; this.applyAvailability();
    try {
      await this.options.onStop();
      await this.options.onChange(config);
      this.dirty = false;
      this.key.value = "";
      this.refresh();
      return !this.disposed;
    } catch (error) { if (!this.disposed) this.options.onError(String(error)); return false; }
    finally { this.busy = false; if (!this.disposed) this.applyAvailability(); }
  }

  private async previewCurrent(character = true): Promise<void> {
    if (this.disposed || this.busy) return;
    const generation = ++this.previewGeneration;
    const config = this.formConfig(), issue = emotionalVoiceIssue(config);
    if (issue) { this.setPlaybackState({ phase: "error", message: issue }); return; }
    const text = this.previewText.value.trim();
    if (!text) { this.setPlaybackState({ phase: "error", message: uiText("请先填写一段试听文字。") }); return; }
    if (!(await this.commit(config, true)) || generation !== this.previewGeneration) return;
    this.setPlaybackState({ phase: "loading" });
    try { await (character && this.options.onCharacterPreview ? this.options.onCharacterPreview(text) : this.options.onPreview(text)); }
    catch (error) { if (!this.disposed && generation === this.previewGeneration) { this.setPlaybackState({ phase: "error", message: String(error) }); this.options.onError(String(error)); } }
  }

  private applyAvailability(): void {
    const cloud = this.provider.value === "bailian";
    this.cloud.hidden = !cloud;
    this.provider.disabled = this.busy;
    for (const input of [this.host, this.region, this.model, this.voice, this.key, this.emotion, this.rate]) input.disabled = this.busy || !cloud;
    this.instruction.disabled = this.busy || !cloud || this.emotion.value !== "custom";
    this.rateValue.value = `${Number(this.rate.value || 1).toFixed(2)}×`;
    this.save.disabled = this.busy; this.preview.disabled = this.busy;
    this.preview.textContent = cloud ? uiText("试听当前角色") : uiText("试听系统语音");
    this.panelPreview.hidden = !cloud; this.panelPreview.disabled = this.busy;
    this.clearKey.disabled = this.busy || !cloud || !this.options.getConfig().apiKey;
    this.stop.disabled = this.playback.phase !== "loading" && this.playback.phase !== "playing";
  }
}

export type VoicePlaybackEvent = ({ id: string } & TtsStreamEvent)
  | { id: string; type: "error"; message: string };
/** Measured facts for one tagged span of PCM (a reply segment), in ms since the playback origin. */
/**
 * Measured facts in ms since the playback origin. "device": the output became
 * usable (tag -1, `waitMs` spent waiting for it). "scheduled": the first
 * source.start() of a tag, with its lead over the audio clock and the raw
 * reported latencies. "audible": the clock reached the tag's first sample.
 * "drained": the tag's scheduled PCM has all played.
 */
export interface VoicePlaybackMark {
  tag: number; kind: "device" | "scheduled" | "audible" | "drained"; atMs: number;
  waitMs?: number; leadMs?: number; baseLatencyMs?: number; outputLatencyMs?: number;
  /** "scheduled": currentTime minus getOutputTimestamp().contextTime, i.e. how far the reported output trails rendering. */
  clockLagMs?: number;
}
interface StreamingVoiceOptions {
  onSpeaking(active: boolean): void;
  onState?(state: EmotionalVoicePlaybackState): void;
  onError?(message: string): void;
  /** Private context factory (tests and legacy callers); it is closed whenever the player is idle. */
  createContext?(): AudioContext;
  /** Shared warm output owned by VoiceOutput; the player only holds it while playing. */
  output?: SharedAudioOutput;
  now?(): number;
  timers?: AudioOutputTimers;
  onMark?(mark: VoicePlaybackMark): void;
}
const playerTimers: AudioOutputTimers = defaultAudioTimers;
/** Gain automation from `points` ([value, time]); an AudioParam without automation just takes `fallback`. */
function ramp(param: AudioParam, now: number, points: [number, number][], fallback: number): void {
  const p = param as Partial<AudioParam> & { value: number };
  try {
    if (typeof p.cancelScheduledValues === "function" && typeof p.setValueAtTime === "function" && typeof p.linearRampToValueAtTime === "function") {
      p.cancelScheduledValues(now);
      points.forEach(([value, time], index) => index === points.length - 1 && time > now ? p.linearRampToValueAtTime!(value, time) : p.setValueAtTime!(value, time));
      return;
    }
  } catch { /* Fall through to an immediate value. */ }
  p.value = fallback;
}
/** Stop polling a clock that has not reached its target for this long; the mouth stays closed. */
const AUDIBLE_GIVE_UP_MS = 15_000;

/**
 * PCM16 mono chunks are scheduled in order as they arrive; cancellation
 * invalidates every late event. "Speaking" (lip-sync) follows the audio clock:
 * it turns on only when the output has actually reached a scheduled sample and
 * off whenever the queue runs dry, so a stalled device cannot move the mouth.
 */
export class StreamingVoicePlayer {
  private generation = 0;
  private id: string | null = null;
  private readonly output: SharedAudioOutput;
  private lease: AudioOutputLease | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private readonly sources = new Map<AudioBufferSourceNode, { tag: number; at: number; end: number }>();
  /** B06: PCM taken off the output by pause(): `offset` already played, `rel` start after the silence point. */
  private held: { buffer: AudioBuffer; tag: number; offset: number; rel: number }[] = [];
  private paused = false;
  /** Context time at which the paused output reached silence; -1 when nothing was faded. */
  private pausedAt = -1;
  private pauseGate: { promise: Promise<void>; resolve(): void } | null = null;
  private readonly tagSources = new Map<number, number>();
  private marks: { tag: number; at: number }[] = [];
  private readonly markedTags = new Set<number>();
  private ready: Promise<void> = Promise.resolve();
  private nextAt = -1;
  private startedAt = 0;
  private firstAudioMs?: number;
  private firstPlaybackMs?: number;
  private playbackStartMs?: number;
  private playbackStartEstimated = false;
  private deviceStartMs?: number;
  private audible = false;
  private pendingStart: number | null = null;
  private watch: unknown = null;
  private watchTarget: { at: number; since: number } | null = null;
  private carry: number | null = null;
  private opening = "";
  private headerChecked = false;
  private totalBytes = 0;
  private done = false;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private completion: Promise<void> = Promise.resolve();
  private resolveCompletion: (() => void) | null = null;
  private rejectCompletion: ((error: Error) => void) | null = null;
  constructor(private readonly options: StreamingVoiceOptions) {
    // An explicit factory means a private context (closed when idle); otherwise use the owner's warm one.
    this.output = options.createContext || !options.output
      ? new SharedAudioOutput({ createContext: options.createContext, now: options.now, idleMs: 0 }) : options.output;
  }

  /** Capture this promise after begin(); later sessions have their own completion. */
  get finished(): Promise<void> { return this.completion; }

  /**
   * Starts (or reuses) the audio device. Callers may dispatch synthesis before
   * this settles: early PCM is queued and scheduled as soon as the device runs.
   * `origin` is the speech request's start time on the same clock as `now`.
   */
  begin(id: string, volume = 1, origin?: number): Promise<void> {
    this.stop();
    if (this.disposed) return Promise.reject(new Error(uiText("语音播放器已关闭。")));
    const generation = this.generation;
    this.completion = new Promise<void>((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; });
    // A transport error may arrive before the owner starts awaiting completion.
    void this.completion.catch(() => {});
    this.id = id; this.startedAt = Number.isFinite(origin) ? origin! : this.now();
    this.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
    this.options.onState?.({ phase: "loading" });
    this.ready = this.output.acquire().then(lease => {
      if (generation !== this.generation || this.id !== id || this.disposed) { lease.release(); return; }
      this.lease = lease; this.context = lease.context; this.deviceStartMs = lease.startMs;
      this.options.onMark?.({ tag: -1, kind: "device", atMs: Math.max(0, this.now() - this.startedAt), waitMs: lease.startMs });
      const gain = this.gain = lease.context.createGain();
      gain.gain.value = this.volume; gain.connect(lease.context.destination);
      this.nextAt = -1;
    }).catch(error => { this.fail(error, generation); throw error; });
    void this.ready.catch(() => {});
    return this.ready;
  }

  /** `tag` groups PCM of one reply segment for audible/drained marks. */
  accept(event: VoicePlaybackEvent, tag = 0): Promise<void> {
    const generation = this.generation;
    const ready = this.ready;
    if (this.disposed || event.id !== this.id) return Promise.resolve();
    const pending = this.queue.then(async () => {
      await ready;
      // B06: while paused nothing new is scheduled (and a reply's "done" waits too).
      while (this.pauseGate && generation === this.generation) await this.pauseGate.promise;
      if (generation !== this.generation || event.id !== this.id) return;
      if (event.type === "error") throw new Error(event.message);
      if (this.done) throw new Error(uiText("音频完成后又收到数据，请重试。"));
      if (event.type === "done") {
        if (this.opening) { const raw = this.opening; this.opening = ""; this.headerChecked = true; this.schedule(raw, generation, tag); }
        if (this.carry !== null) throw new Error(uiText("语音 PCM 末尾字节不完整。"));
        this.done = true;
        this.firstAudioMs ??= event.firstAudioMs;
        if (!this.totalBytes) throw new Error(uiText("语音服务没有返回可播放音频。"));
        this.publish(this.live ? "playing" : "idle");
        if (!this.live) this.finish();
        return;
      }
      if (event.format !== "pcm_s16le" || event.sampleRate !== 24000 || event.channels !== 1) throw new Error(uiText("不支持的语音音频格式。需要 24kHz 单声道 PCM16。"));
      if (event.data.length > 2_000_000 || event.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.data)) throw new Error(uiText("语音音频片段格式不正确或过大。"));
      let raw = atob(event.data);
      if (!raw.length) return;
      this.totalBytes += raw.length;
      if (this.totalBytes > 16_000_000) throw new Error(uiText("语音流超过本机播放上限，请缩短文字。"));
      this.firstAudioMs ??= event.firstAudioMs;
      if (!this.headerChecked) {
        this.opening += raw;
        if (this.opening.length < 4) return;
        raw = this.opening; this.opening = ""; this.headerChecked = true;
        if (raw.startsWith("RIFF")) throw new Error(uiText("收到 WAV 文件头，而当前请求需要原始 PCM 音频。"));
      }
      this.schedule(raw, generation, tag);
    });
    this.queue = pending.catch(error => this.fail(error, generation));
    return this.queue;
  }

  private schedule(raw: string, generation: number, tag: number): void {
    const bytes = new Uint8Array(raw.length + (this.carry === null ? 0 : 1));
    let offset = 0;
    if (this.carry !== null) bytes[offset++] = this.carry;
    for (let index = 0; index < raw.length; index++) bytes[offset + index] = raw.charCodeAt(index);
    this.carry = bytes.length % 2 ? bytes[bytes.length - 1] : null;
    const frames = Math.floor(bytes.length / 2);
    if (!frames) return;
    const context = this.context!;
    const buffer = context.createBuffer(1, frames, 24000), samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2);
    for (let index = 0; index < frames; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(this.gain!);
    // A small bounded lead for the first chunk (and after an underrun) absorbs
    // network jitter; later chunks continue exactly where the previous one ends.
    const lead = this.nextAt < 0 ? PLAYBACK_START_LEAD_S : PLAYBACK_RESUME_LEAD_S;
    const at = Math.max(this.nextAt, context.currentTime + lead);
    this.nextAt = at + buffer.duration;
    this.track(source, { tag, at, end: at + buffer.duration }, generation);
    this.tagSources.set(tag, (this.tagSources.get(tag) ?? 0) + 1);
    if (!this.markedTags.has(tag)) {
      this.markedTags.add(tag); this.marks.push({ tag, at });
      const stamp = this.outputStamp(context);
      this.options.onMark?.({ tag, kind: "scheduled", atMs: Math.max(0, this.now() - this.startedAt), leadMs: (at - context.currentTime) * 1000,
        ...(stamp ? { clockLagMs: (context.currentTime - stamp.contextTime) * 1000 } : {}),
        ...(Number.isFinite(context.baseLatency) ? { baseLatencyMs: context.baseLatency * 1000 } : {}),
        ...(Number.isFinite(context.outputLatency) ? { outputLatencyMs: context.outputLatency * 1000 } : {}) });
    }
    if (!this.audible && this.pendingStart === null) this.pendingStart = at;
    source.start(at);
    if (this.firstPlaybackMs === undefined)
      this.firstPlaybackMs = Math.max(0, this.now() - this.startedAt + (at - context.currentTime + (context.baseLatency || 0) + (context.outputLatency || 0)) * 1000);
    this.publish("playing");
    this.arm(generation);
  }

  private track(source: AudioBufferSourceNode, entry: { tag: number; at: number; end: number }, generation: number): void {
    source.onended = () => {
      const known = this.sources.get(source);
      source.disconnect(); this.sources.delete(source);
      if (generation !== this.generation || !known) return;
      // An ended buffer proves the clock passed it even if no poll observed it.
      this.observe(generation, known.end);
      const left = (this.tagSources.get(known.tag) ?? 1) - 1;
      this.tagSources.set(known.tag, left);
      if (left <= 0) this.options.onMark?.({ tag: known.tag, kind: "drained", atMs: Math.max(0, this.now() - this.startedAt) });
      if (this.done && !this.live) this.finish();
      else if (!this.live) this.silence();
    };
    this.sources.set(source, entry);
  }

  /** Scheduled or held PCM that has not played yet. */
  private get live(): number { return this.sources.size + this.held.length; }

  /**
   * B06 feed pause. The gain fades to silence over PAUSE_FADE_S; every source
   * still sounding after that point is stopped exactly there and kept (buffer
   * plus the offset already played), arriving PCM waits, and the mouth closes.
   * The output device keeps running, so resume() never waits for it.
   */
  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.pauseGate = { promise, resolve };
    const context = this.context, gain = this.gain, generation = this.generation;
    if (context && gain) {
      this.observe(generation);
      const now = context.currentTime, end = now + PAUSE_FADE_S;
      ramp(gain.gain, now, [[gain.gain.value, now], [0, end]], 0);
      this.pausedAt = end;
      for (const [source, entry] of [...this.sources]) {
        if (entry.end <= end) continue; // plays out under the fade and ends normally
        this.sources.delete(source);
        source.onended = () => source.disconnect();
        try { source.stop(end); } catch { /* Never started. */ }
        if (source.buffer) this.held.push({ buffer: source.buffer, tag: entry.tag, offset: Math.max(0, end - entry.at), rel: Math.max(0, entry.at - end) });
      }
      this.held.sort((a, b) => a.rel - b.rel);
    }
    this.disarm();
    this.pendingStart = null;
    if (this.audible) { this.audible = false; this.options.onSpeaking(false); }
  }

  /** Continue exactly where pause() stopped: held PCM restarts from its offset, after a short lead, fading in. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const gate = this.pauseGate; this.pauseGate = null;
    const context = this.context, gain = this.gain, generation = this.generation;
    if (context && gain && this.pausedAt >= 0) {
      const now = context.currentTime, base = Math.max(this.pausedAt, now + PLAYBACK_RESUME_LEAD_S), delta = base - this.pausedAt;
      ramp(gain.gain, now, [[0, now], [0, base], [this.volume, base + PAUSE_FADE_S]], this.volume);
      for (const item of this.held) {
        const source = context.createBufferSource(); source.buffer = item.buffer; source.connect(gain);
        const at = base + item.rel;
        this.track(source, { tag: item.tag, at, end: at + item.buffer.duration - item.offset }, generation);
        source.start(at, item.offset);
      }
      if (this.held.length) this.pendingStart = base + this.held[0].rel;
      this.held = [];
      for (const mark of this.marks) if (mark.at > this.pausedAt) mark.at += delta;
      if (this.nextAt > this.pausedAt) this.nextAt += delta;
      this.pausedAt = -1;
      this.arm(generation);
    }
    gate?.resolve();
  }

  /**
   * Output clock: the context time currently leaving the device and its performance time.
   * `estimated` when it is not the device's own output timestamp (missing, or its lag capped).
   */
  private clock(context: AudioContext): { contextTime: number; performanceTime: number; estimated: boolean } {
    const render = context.currentTime, stamp = this.outputStamp(context);
    // A stalled device stops `currentTime` too, so the cap below never opens the mouth for silence.
    if (stamp && render - stamp.contextTime <= MAX_OUTPUT_LAG_S) return { ...stamp, estimated: false };
    if (stamp) return { contextTime: render - MAX_OUTPUT_LAG_S, performanceTime: this.now(), estimated: true };
    const reported = (context.outputLatency || 0) + (context.baseLatency || 0);
    return { contextTime: render - Math.min(MAX_OUTPUT_LAG_S, Math.max(0, reported)), performanceTime: this.now(), estimated: true };
  }

  private outputStamp(context: AudioContext): { contextTime: number; performanceTime: number } | null {
    const stamp = typeof context.getOutputTimestamp === "function" ? context.getOutputTimestamp() : undefined;
    return stamp && Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime) && stamp.contextTime! > 0 && stamp.performanceTime! > 0
      ? { contextTime: stamp.contextTime!, performanceTime: stamp.performanceTime! } : null;
  }

  private observe(generation: number, passed = -Infinity): void {
    const context = this.context;
    if (generation !== this.generation || !context) return;
    const measured = this.clock(context);
    const contextTime = Math.max(measured.contextTime, passed);
    const at = (time: number) => Math.max(0, measured.performanceTime - (measured.contextTime - time) * 1000 - this.startedAt);
    while (this.marks.length && this.marks[0].at <= contextTime) {
      const mark = this.marks.shift()!;
      const atMs = Math.min(at(mark.at), Math.max(0, this.now() - this.startedAt));
      if (this.playbackStartMs === undefined) {
        this.playbackStartMs = atMs;
        // Inferred rather than read off the device clock: no usable timestamp, or the mark lies past it.
        this.playbackStartEstimated = measured.estimated || mark.at > measured.contextTime;
      }
      this.options.onMark?.({ tag: mark.tag, kind: "audible", atMs });
    }
    if (!this.audible && this.pendingStart !== null && this.pendingStart <= contextTime && this.sources.size) {
      this.audible = true; this.pendingStart = null;
      this.options.onSpeaking(true);
      this.publish("playing");
    }
  }

  /** Re-check exactly when the next scheduled sample should reach the output. */
  private arm(generation: number): void {
    if (this.watch !== null || this.paused || generation !== this.generation || !this.context) return;
    this.observe(generation);
    const targets = [...(this.marks.length ? [this.marks[0].at] : []), ...(!this.audible && this.pendingStart !== null ? [this.pendingStart] : [])];
    if (!targets.length) { this.watchTarget = null; return; }
    const target = Math.min(...targets);
    if (this.watchTarget?.at !== target) this.watchTarget = { at: target, since: this.now() };
    // A clock that never reaches its sample (stalled device) stops being polled.
    else if (this.now() - this.watchTarget.since > AUDIBLE_GIVE_UP_MS) return;
    const { contextTime } = this.clock(this.context);
    const wait = Math.max(5, Math.min(250, (Math.min(...targets) - contextTime) * 1000 + 2));
    const timers = this.options.timers ?? playerTimers;
    this.watch = timers.set(() => { this.watch = null; if (generation === this.generation) this.arm(generation); },
      Number.isFinite(wait) ? wait : AUDIBLE_POLL_MS);
  }

  private disarm(): void {
    if (this.watch !== null) { (this.options.timers ?? playerTimers).clear(this.watch); this.watch = null; }
    this.watchTarget = null;
  }

  /** The queue ran dry before more PCM (next segment) arrived: close the mouth. */
  private silence(): void {
    this.pendingStart = null;
    if (!this.audible) return;
    this.audible = false;
    this.options.onSpeaking(false);
  }

  stop(): void {
    this.resolveCompletion?.(); this.resolveCompletion = this.rejectCompletion = null;
    this.generation++; this.id = null; this.done = false;
    this.carry = null; this.opening = ""; this.headerChecked = false; this.totalBytes = 0;
    this.firstAudioMs = undefined; this.firstPlaybackMs = undefined; this.playbackStartMs = undefined; this.playbackStartEstimated = false; this.deviceStartMs = undefined;
    this.queue = Promise.resolve();
    this.disarm();
    for (const source of this.sources.keys()) { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
    // A stop during a feed pause drops the held PCM for good: nothing of this playback can come back.
    this.paused = false; this.pausedAt = -1;
    const gate = this.pauseGate; this.pauseGate = null; gate?.resolve();
    this.reset();
    this.options.onSpeaking(false);
  }
  dispose(): void { if (this.disposed) return; this.stop(); this.disposed = true; }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  private publish(phase: EmotionalVoicePlaybackState["phase"]): void {
    this.options.onState?.({ phase, firstAudioMs: this.firstAudioMs, firstPlaybackMs: this.firstPlaybackMs,
      ...(this.playbackStartMs === undefined ? {} : { playbackStartMs: this.playbackStartMs, ...(this.playbackStartEstimated ? { playbackStartEstimated: true } : {}) }),
      ...(this.deviceStartMs === undefined ? {} : { deviceStartMs: this.deviceStartMs }) });
  }
  private reset(): void {
    this.sources.clear(); this.held = []; this.tagSources.clear(); this.marks = []; this.markedTags.clear();
    this.audible = false; this.pendingStart = null; this.nextAt = -1;
    this.gain?.disconnect(); this.gain = null; this.context = null;
    const lease = this.lease; this.lease = null; lease?.release();
  }
  private finish(): void {
    this.resolveCompletion?.(); this.resolveCompletion = this.rejectCompletion = null;
    this.disarm();
    this.options.onSpeaking(false); this.publish("idle");
    this.id = null;
    this.reset();
  }
  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation || this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    const reject = this.rejectCompletion; this.resolveCompletion = this.rejectCompletion = null;
    this.stop(); this.options.onState?.({ phase: "error", message }); this.options.onError?.(message);
    reject?.(new Error(message));
  }
}
