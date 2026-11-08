import type { SystemAudioState } from "../../shared/contracts";

export interface SystemAudioSample {
  /** Monotonic seconds; all energy values are bounded to 0..1. */
  time: number;
  rms: number;
  low: number;
  mid: number;
  high: number;
}

interface SystemAudioOptions {
  onSample(sample: SystemAudioSample): void;
  onState(state: SystemAudioState): void;
  onStatus?(text: string): void;
  onError(message: string): void;
}

function unit(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0; }

type ConnectionStage = "grant" | "capture" | "context";
interface InteractionState { focused?: boolean; activated?: boolean }
const errorNames = new Set(["NotAllowedError", "SecurityError", "InvalidStateError", "NotReadableError", "NotFoundError", "NotSupportedError", "AbortError", "OperationError"]);
const localErrors = new Set(["系统声音未获授权，请重新开启。", "未取得系统音轨，请确认当前系统支持共享电脑声音。"]);

function interactionState(): InteractionState {
  return {
    focused: typeof document === "undefined" ? undefined : document.hasFocus(),
    activated: navigator.userActivation?.isActive,
  };
}

function connectionError(error: unknown, stage: ConnectionStage, state: InteractionState): Error {
  if (error instanceof Error && localErrors.has(error.message)) return error;
  const errorName = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
  const name = typeof errorName === "string" && errorNames.has(errorName) ? errorName : "";
  let message = stage === "grant" ? "系统声音共享未获授权，请显示桌宠后重新点击音乐按钮。"
    : stage === "context" ? "系统声音分析未能启动，请重新点击音乐按钮。"
    : name === "NotAllowedError" || name === "SecurityError" ? "系统声音采集被拒绝，请将桌宠窗口置于前台后重新点击音乐按钮。"
    : name === "InvalidStateError" ? "系统声音采集未能启动，请将桌宠窗口置于前台后重新点击音乐按钮。"
    : name === "NotFoundError" || name === "NotSupportedError" ? "当前系统未提供可用的系统声音采集。"
    : name === "NotReadableError" ? "暂时无法读取系统声音，请稍后重新点击音乐按钮。"
    : name === "AbortError" ? "系统声音连接已中断，请重新点击音乐按钮。"
    : "系统声音连接失败，请稍后重新点击音乐按钮。";
  // Keep only bounded diagnostics in this error; never forward arbitrary native/IPC text.
  const details = [stage === "grant" ? "授权" : stage === "capture" ? "采集" : "音频分析"];
  if (name) details.push(name);
  if (state.focused !== undefined) details.push(state.focused ? "窗口已聚焦" : "窗口未聚焦");
  if (state.activated !== undefined) details.push(state.activated ? "有点击激活" : "无点击激活");
  message += `（${details.join("；")}）`;
  return new Error(message);
}

/** One loopback. Optional transient PCM is enabled only by a separately consented consumer. */
export class SystemAudioInput {
  private revision = 0;
  private wanted = false;
  private disposed = false;
  private ready = false;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frame = 0;
  private releaseListeners: (() => void) | null = null;
  private unsubscribe: (() => void) | null;
  private grantQueue: Promise<unknown> = Promise.resolve();
  private pendingPermissions = 0;
  private pendingHostEnabled: boolean | null = null;
  private starting: Promise<void> | null = null;
  private status = "";
  private closing: Promise<void> = Promise.resolve();
  private pcmListener: ((samples: Float32Array, sampleRate: number, frameEndMs: number) => void) | null = null;
  private pcmProcessor: ScriptProcessorNode | null = null;
  private pcmMute: GainNode | null = null;

  constructor(private readonly options: SystemAudioOptions) {
    this.unsubscribe = window.desktop.onSystemAudioState(state => {
      // A revoke is an expected host-off acknowledgement, not a new failure.
      if (state.active || (this.wanted && this.pendingHostEnabled === false)) return;
      if (this.wanted || this.ready) this.cancelLocally();
    });
    this.options.onState({ active: false });
  }

  get active(): boolean { return this.ready; }

  setPcmListener(listener: ((samples: Float32Array, sampleRate: number, frameEndMs: number) => void) | null): void {
    this.pcmListener = listener;
    this.releasePcm();
    if (!listener || !this.ready || !this.context || !this.source) return;
    const context = this.context;
    const processor = this.pcmProcessor = context.createScriptProcessor(4096, 1, 1);
    const mute = this.pcmMute = context.createGain(); mute.gain.value = 0;
    processor.onaudioprocess = event => {
      if (this.ready && this.context === context && this.pcmProcessor === processor && this.pcmListener)
        this.pcmListener(event.inputBuffer.getChannelData(0).slice(), context.sampleRate, performance.now());
    };
    this.source.connect(processor); processor.connect(mute); mute.connect(context.destination);
  }

  private releasePcm(): void {
    const processor = this.pcmProcessor;
    if (processor) {
      processor.onaudioprocess = null;
      try { this.source?.disconnect(processor); } catch { /* A cancelled context can already be disconnected. */ }
      try { processor.disconnect(); } catch { /* Owned teardown continues through context closure. */ }
    }
    this.pcmProcessor = null;
    try { this.pcmMute?.disconnect(); } catch { /* Continue releasing the source and tracks. */ }
    this.pcmMute = null;
  }

  toggle(): Promise<void> { return this.setEnabled(!this.wanted); }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return;
    if (!enabled) { await this.stop(); return; }
    if (this.wanted) { await this.starting; return; }
    if (this.starting || this.pendingPermissions) {
      this.options.onError("上一轮系统声音连接仍在结束，请稍后再点击开启。");
      return;
    }
    const revision = ++this.revision;
    this.wanted = true;
    this.releaseCapture();
    this.reportState(false);
    this.reportStatus("正在连接系统声音…");
    const pending = this.start(revision);
    this.starting = pending;
    try { await pending; }
    finally { if (this.starting === pending) this.starting = null; }
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.cancelLocally();
    const revision = this.revision;
    try { await this.setPermission(false, revision); }
    catch (error) {
      if (this.isCurrent(revision, false)) this.options.onError(String(error));
    }
  }

  /** Host lease release waits for late capture and owned context closure too. */
  async releaseOwned(): Promise<void> {
    const pending = this.starting;
    await this.stop(); await pending; await this.grantQueue; await this.closing;
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelLocally();
    this.disposed = true;
    this.unsubscribe?.(); this.unsubscribe = null;
    void this.setPermission(false, this.revision, true).catch(() => {});
  }

  private isCurrent(revision: number, wanted = true): boolean {
    return !this.disposed && revision === this.revision && this.wanted === wanted;
  }

  private setPermission(enabled: boolean, revision: number, disposing = false): Promise<SystemAudioState | null> {
    this.pendingPermissions++;
    const pending = this.grantQueue.then(async () => {
      if (revision !== this.revision || this.wanted !== enabled || (this.disposed && !disposing)) return null;
      this.pendingHostEnabled = enabled;
      try { return await window.desktop.setSystemAudioSharing(enabled); }
      finally { this.pendingHostEnabled = null; }
    }).finally(() => { this.pendingPermissions--; });
    this.grantQueue = pending.catch(() => {});
    return pending;
  }

  private async start(revision: number): Promise<void> {
    let stage: ConnectionStage = "grant";
    let interaction = interactionState();
    try {
      const permission = await this.setPermission(true, revision);
      if (!this.isCurrent(revision)) return;
      if (!permission?.active) throw new Error("系统声音未获授权，请重新开启。");
      stage = "capture";
      interaction = interactionState();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: true,
      });
      // Chromium also requires a video grant: the host supplies this pet window only.
      // Stop that compatibility track immediately without reading or displaying frames.
      for (const track of stream.getVideoTracks()) track.stop();
      if (!this.isCurrent(revision)) { this.stopTracks(stream); return; }
      this.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.every(track => track.readyState === "ended"))
        throw new Error("未取得系统音轨，请确认当前系统支持共享电脑声音。");
      const ended = () => this.fail(new Error("系统声音共享已结束。"), revision);
      for (const track of tracks) track.addEventListener("ended", ended);
      this.releaseListeners = () => { for (const track of tracks) track.removeEventListener("ended", ended); };
      stage = "context";
      interaction = interactionState();
      const context = this.context = new AudioContext();
      const analyser = this.analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.65;
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(analyser);
      if (context.state === "suspended") await context.resume();
      if (!this.isCurrent(revision)) return;
      this.reportState(true);
      this.setPcmListener(this.pcmListener);
      this.reportStatus("等待系统声音");
      const samples = new Float32Array(analyser.fftSize);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      let lastAt = -Infinity;
      let lastSoundAt = -Infinity;
      const read = (now: number) => {
        this.frame = 0;
        if (!this.isCurrent(revision)) return;
        if ((now - lastAt) / 1000 >= 1 / 30) {
          lastAt = now;
          try {
            analyser.getFloatTimeDomainData(samples);
            analyser.getFloatFrequencyData(spectrum);
            let energy = 0;
            for (const value of samples) if (Number.isFinite(value)) energy += value * value;
            const rms = unit(Math.sqrt(energy / samples.length));
            const band = (from: number, to: number) => {
              const step = context.sampleRate / analyser.fftSize;
              let power = 0;
              for (let bin = Math.max(1, Math.ceil(from / step)); bin < spectrum.length && bin * step < to; bin++) {
                const amplitude = Number.isFinite(spectrum[bin]) ? Math.pow(10, spectrum[bin] / 20) : 0;
                power += amplitude * amplitude;
              }
              return unit(Math.sqrt(power));
            };
            this.options.onSample({ time: now / 1000, rms, low: band(40, 180), mid: band(180, 2000), high: band(2000, 8000) });
            if (rms >= 0.003) lastSoundAt = now;
            this.reportStatus(now - lastSoundAt < 800 ? "检测到系统声音 · 仅本机分析" : "等待系统声音");
          } catch (error) { this.fail(error, revision); return; }
        }
        if (this.isCurrent(revision)) this.frame = requestAnimationFrame(read);
      };
      this.frame = requestAnimationFrame(read);
    } catch (error) { this.fail(connectionError(error, stage, interaction), revision); }
  }

  private fail(error: unknown, revision: number): void {
    if (!this.isCurrent(revision)) return;
    this.cancelLocally();
    this.options.onError(error instanceof Error ? error.message : String(error));
    void this.setPermission(false, this.revision).catch(() => {});
  }

  private cancelLocally(): void {
    this.wanted = false;
    this.revision++;
    this.releaseCapture();
    this.reportState(false);
    this.reportStatus("");
  }

  private reportState(active: boolean): void { this.ready = active; this.options.onState({ active }); }
  private reportStatus(text: string): void {
    if (text === this.status) return;
    this.status = text;
    this.options.onStatus?.(text);
  }

  private stopTracks(stream: MediaStream): void { for (const track of stream.getTracks()) track.stop(); }

  private releaseCapture(): void {
    this.releasePcm();
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.releaseListeners?.(); this.releaseListeners = null;
    this.source?.disconnect(); this.analyser?.disconnect();
    this.source = null; this.analyser = null;
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") {
      this.closing = Promise.all([this.closing, context.close()]).then(() => {});
      void this.closing.catch(() => this.options.onError("系统声音资源释放未完成，请关闭窗口后重试。"));
    }
    const stream = this.stream; this.stream = null;
    if (stream) this.stopTracks(stream);
  }
}
