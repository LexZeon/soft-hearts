import {uiText,uiTemplate} from './ui-language';
import type { DesktopAPI, SystemAudioState } from '../../shared/contracts';
import type { AmbientMode } from '../../shared/ambient-audio';
import type { AmbientAudioView, AmbientSubmissionResult } from '../../shared/ambient-audio-runtime';
import { AmbientAudioControls } from './AmbientAudio';
import { AmbientAudioSegments } from './ambient-audio-segments';
import type { SystemAudioInput } from './SystemAudio';

interface Options {
  api: Pick<DesktopAPI, 'beginAmbientAudio' | 'confirmAmbientAudioCapture' | 'stopAmbientAudio' | 'getAmbientAudioState' | 'submitAmbientAudio' | 'onAmbientAudioState'>;
  input: Pick<SystemAudioInput, 'active' | 'toggle' | 'setEnabled' | 'stop' | 'setPcmListener'>;
  onMusicEnabled(enabled: boolean): void;
  onExpanded?(expanded: boolean): void;
  onError(message: string): void;
}

/** Purpose consent and segmentation share the existing single loopback owner. */
export class AmbientAudioController {
  private readonly panel: AmbientAudioControls;
  private readonly segments: AmbientAudioSegments<AmbientSubmissionResult>;
  private readonly unsubscribe: () => void;
  private generation = 0;
  private stateRevision = 0;
  private disposed = false;
  private starting = false;
  private stopping = false;
  private localSpeaking = false;
  private state: AmbientAudioView | null = null;

  constructor(container: HTMLElement, private readonly options: Options) {
    this.panel = new AmbientAudioControls(container, {
      onStart: mode => this.start(mode), onStop: () => this.stop(),
      onDanceOnly: () => this.danceOnly(),
      onExpanded: options.onExpanded, onError: options.onError,
    });
    this.segments = new AmbientAudioSegments({
      onSegment: async packet => options.api.submitAmbientAudio({ sessionId: packet.sessionKey,
        sequence: packet.sequence, wav: packet.wav, startOffsetMs: packet.startOffsetMs, endOffsetMs: packet.endOffsetMs }),
      onAccepted: result => { if (result.status === 'accepted') this.panel.setState({ status: uiText('已保存系统音频文字，可在设置的系统音频文字记录中查看。') }); },
      onStatus: status => this.panel.setState({ status }), onError: options.onError,
      onGap: () => this.panel.setState({ status: uiText('识别尚未完成，部分声音未送出；已保存的文字保持。') }),
    });
    this.unsubscribe = options.api.onAmbientAudioState(state => this.apply(state));
  }

  get active(): boolean { return !this.disposed && (this.state?.active ?? false); }
  get sessionId(): string | null { return this.disposed ? null : this.state?.sessionId ?? null; }
  get isExpanded(): boolean { return this.panel.isExpanded; }
  toggleExpanded(): void { this.panel.toggleExpanded(); }

  async init(): Promise<void> {
    const revision = this.stateRevision;
    const state = await this.options.api.getAmbientAudioState();
    if (!this.disposed && revision === this.stateRevision) this.apply(state);
  }
  captureState(state: SystemAudioState): void {
    this.panel.setState({ localDanceActive: state.active && !this.active });
    this.options.onMusicEnabled(state.active && (!this.active || this.state?.mode === 'music'));
    if (!state.active && this.active && !this.starting && !this.stopping) void this.stop(false).catch(() => {});
  }
  setSpeaking(active: boolean): void { this.localSpeaking = active; this.applySpeaking(); }

  async start(mode: AmbientMode): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.starting = true; this.stopping = false;
    this.segments.stop(); this.options.input.setPcmListener(null);
    let state: AmbientAudioView | null = null;
    try {
      const stateRevision = this.stateRevision;
      state = await this.options.api.beginAmbientAudio(mode);
      if (generation !== this.generation || this.disposed) { await this.options.api.stopAmbientAudio(state.sessionId ?? undefined); return; }
      if (stateRevision !== this.stateRevision && this.state) {
        if (!this.state.active || this.state.sessionId !== state.sessionId) {
          await this.options.api.stopAmbientAudio(state.sessionId ?? undefined); return;
        }
        // A same-session event may contain newer host suspension than this ack.
        state = { ...this.state };
      }
      this.apply(state);
      await this.options.input.setEnabled(true);
      if (generation !== this.generation || this.disposed) return;
      if (!this.state?.active || this.state.sessionId !== state.sessionId) { await this.options.input.stop(); return; }
      if (!this.options.input.active || !state.sessionId) throw new Error(uiText('未取得系统声音，理解没有启动。'));
      const monotonic = performance.now(), wall = Date.now(), startedAt = this.state.startedAt;
      if (!Number.isFinite(monotonic) || !Number.isSafeInteger(wall) || typeof startedAt !== 'number'
        || !Number.isSafeInteger(startedAt) || startedAt < 0 || wall - startedAt < -250)
        throw new Error(uiText('系统声音会话时间不正确，请重新开启。'));
      // Host consent remains the archive timeline. A delayed capture must not
      // silently move its first samples back to the time of the begin request.
      const timelineStart = monotonic - Math.max(0, wall - startedAt);
      if (!Number.isFinite(timelineStart)) throw new Error(uiText('系统声音会话时间不正确，请重新开启。'));
      this.segments.start(state.sessionId, mode, timelineStart);
      this.applySpeaking();
      this.options.input.setPcmListener((samples, rate, end) => this.segments.push(samples, rate, end));
      await this.options.api.confirmAmbientAudioCapture(state.sessionId);
      if (generation !== this.generation || this.disposed) { await this.options.api.stopAmbientAudio(state.sessionId); return; }
      if (!this.state?.active || this.state.sessionId !== state.sessionId) {
        this.segments.stop(); this.options.input.setPcmListener(null); await this.options.input.stop(); return;
      }
      this.applySpeaking();
      this.captureState({ active: true });
    } catch (error) {
      if (generation === this.generation) {
        this.segments.stop(); this.options.input.setPcmListener(null);
        await this.options.api.stopAmbientAudio(state?.sessionId ?? undefined).catch(() => {});
        if (generation !== this.generation || this.disposed) return;
        await this.options.input.stop();
        if (generation !== this.generation || this.disposed) return;
        throw error;
      }
    } finally { if (generation === this.generation) this.starting = false; }
  }

  private async danceOnly(): Promise<void> {
    const pending = this.stop(false), generation = this.generation;
    await pending;
    if (this.disposed || generation !== this.generation) return;
    await this.options.input.toggle();
    if (!this.disposed && generation === this.generation) this.captureState({ active: this.options.input.active });
  }

  async stop(releaseLoopback = true): Promise<void> {
    const generation = ++this.generation; this.starting = false; this.stopping = true;
    const id = this.state?.sessionId ?? undefined;
    this.segments.stop(); this.options.input.setPcmListener(null);
    const captureStop = releaseLoopback ? this.options.input.stop() : Promise.resolve();
    try {
      await Promise.all([captureStop, this.options.api.stopAmbientAudio(id).then(state => {
        if (!this.disposed && generation === this.generation) this.apply(state);
      })]);
    } finally { if (generation === this.generation) this.stopping = false; }
  }

  dispose(): void {
    if (this.disposed) return;
    const id = this.state?.sessionId ?? undefined;
    ++this.generation; this.disposed = true; this.starting = false;
    this.unsubscribe(); this.segments.dispose(); this.panel.dispose(); this.options.input.setPcmListener(null);
    void this.options.api.stopAmbientAudio(id).catch(() => {});
  }

  private apply(state: AmbientAudioView): void {
    if (this.disposed) return;
    ++this.stateRevision;
    this.state = { ...state };
    if (!state.active) { this.segments.stop(); this.options.input.setPcmListener(null); }
    this.applySpeaking();
    this.panel.setState({ active: state.active, mode: state.mode, available: state.available,
      destination: state.destination, unavailableReason: uiText('请先在连接与声音配置转写服务。'),
      status: `${state.status}${state.active ? ` · ${state.languageNotice}` : ''}`,
      localDanceActive: this.options.input.active && !state.active });
    this.options.onMusicEnabled(this.options.input.active && (!state.active || state.mode === 'music'));
  }

  private applySpeaking(): void {
    // An unrelated window's false cannot clear the host's aggregate suspension,
    // and an early host acknowledgement cannot clear this window's final PCM.
    // The segmenter starts its tail guard only on the combined true -> false.
    this.segments.setSpeaking(this.localSpeaking || this.state?.suspended === true);
  }
}
