import { listenSwitchOn } from '../../shared/listen-together';
import {uiText,uiTemplate} from './ui-language';
import type { DesktopAPI, SystemAudioState } from '../../shared/contracts';
import type { AudioCaptureDescriptor, AudioCaptureState, AudioReadingPcmAck } from '../../shared/audio-capture';
import { audioReadingSources, audioReadingPurposes, type AudioReadingSource, type AudioReadingView } from '../../shared/audio-reading-toggles';
import { ListenTogetherSwitch } from './ListenTogetherSwitch';
import { AmbientAudioSegments } from './ambient-audio-segments';
import { MicrophoneInput } from './MicrophoneInput';
import type { MediaInput } from './MediaInput';
import type { SystemAudioInput } from './SystemAudio';
import { parseAudioDanceFrame, type AudioDanceFrame, type AudioDanceSample } from '../../shared/audio-dance';
import { AudioDanceFusion } from './audio-dance-fusion';
import './AudioReadingToggles.css';

interface Options {
  api: Pick<DesktopAPI, 'getAudioReadingView' | 'setAudioReadingIntent' | 'onAudioReadingView' | 'getAudioCaptureState'
    | 'onAudioCaptureState' | 'ackAudioCapture' | 'submitAudioReadingPcm' | 'setAudioDanceIntent' | 'onAmbientAudioState'
    | 'setAudioDanceSourceIntent' | 'submitAudioDanceSample' | 'onAudioDanceSample'>;
  owner: 'controls' | 'pet'; media: MediaInput; system: SystemAudioInput | null;
  onMusicEnabled(value: boolean): void; onError(message: string): void;
  onMusicSample?(value: AudioDanceSample): void;
  onDanceStatus?(active: boolean, status: string): void;
  onExpanded?(value: boolean): void;
}

/** Every window runs the finite capture receiver; only the host-selected owner
 * acquires a source. The pet additionally renders the one switch 「和她一起听」 (I-016; it replaced the four reading toggles
 * and the audio-rhythm button: the host turns rhythm and words on and off together for the computer's sound).
 */
export class AudioReadingClient {
  private view: AudioReadingView | null = null;
  private capture: AudioCaptureState = { revision: -1, slots: { 'system-audio': null, microphone: null } };
  private readonly microphone: MicrophoneInput;
  private readonly segments: Record<AudioReadingSource, AmbientAudioSegments<AudioReadingPcmAck>>;
  private keys: Record<AudioReadingSource, string> = { 'system-audio': '', microphone: '' };
  private sequences: Record<AudioReadingSource, { key: string; value: number }> = {
    'system-audio': { key: '', value: 0 }, microphone: { key: '', value: 0 },
  };
  private panel: HTMLElement | null = null;
  private listenSwitch: ListenTogetherSwitch | null = null;
  private readonly fusion = new AudioDanceFusion();
  private readonly danceFrames: Partial<Record<AudioReadingSource, { id: string; revision: number; at: number }>> = {};
  private readonly danceSending: Partial<Record<AudioReadingSource, boolean>> = {};
  private danceFrame = 0;
  private danceEnabled = false;
  private danceOperation = 0;
  private danceSummary = '';
  private readonly unsubscribes: (() => void)[] = [];
  private localSpeaking = false;
  private hostSpeaking = false;
  private disposed = false;
  private systemOwned: AudioCaptureDescriptor | null = null;
  private systemPending: AudioCaptureDescriptor | null = null;
  private systemWork: Promise<void> | null = null;
  private systemChanges = 0;
  private startingSystem = false;
  private stoppingSystem = false;

  constructor(container: HTMLElement | null, private readonly options: Options) {
    this.segments = Object.fromEntries(audioReadingSources.map(source => [source, new AmbientAudioSegments<AudioReadingPcmAck>({
      onSegment: (packet, signal) => {
        const descriptor = this.owned(source), key = this.key(descriptor);
        if (signal.aborted || !descriptor?.ambient || packet.sessionKey !== key) return Promise.resolve({ accepted: false, reason: 'inactive' });
        const sequence = this.sequences[source];
        const tokenKey = JSON.stringify(descriptor.ambient);
        if (sequence.key !== tokenKey) { sequence.key = tokenKey; sequence.value = 0; }
        return options.api.submitAudioReadingPcm({ token: { ...descriptor.ambient }, captureRevision: descriptor.revision,
          sequence: ++sequence.value, startedAtMs: Math.max(0, Math.round(Date.now() - performance.now() + packet.startedAtMs)),
          pcm16: packet.wav.slice(44) });
      }, onError: options.onError,
    })])) as Record<AudioReadingSource, AmbientAudioSegments<AudioReadingPcmAck>>;
    this.microphone = new MicrophoneInput({ owner: options.owner, acknowledge: value => options.api.ackAudioCapture(value),
      onPcm: (samples, rate, end) => { options.media.pushVoicePcm(samples, rate); this.segments.microphone.push(samples, rate, end); },
      onError: options.onError, onReady: ready => options.media.microphoneReady(ready),
      onSample: sample => this.sendDanceSample('microphone', sample) });
    if (container) {
      this.panel = document.createElement('section'); this.panel.className = 'ambient-audio-panel'; this.panel.hidden = true;
      this.panel.dataset.moodUi = 'true';
      const heading = document.createElement('strong'); heading.textContent = uiText('一起听');
      const close = document.createElement('button'); close.type = 'button'; close.textContent = uiText('关闭面板');
      close.onclick = () => { if (this.isExpanded) this.toggleExpanded(); }; this.panel.append(heading, close);
      this.listenSwitch = new ListenTogetherSwitch(this.panel, { set: enabled => this.setListen(enabled) });
      container.replaceChildren(this.panel);
    }
    options.system?.setPcmListener(null);
    this.unsubscribes.push(options.api.onAudioReadingView(view => this.applyView(view)),
      options.api.onAudioCaptureState(state => this.applyCapture(state)),
      options.api.onAmbientAudioState(state => { this.hostSpeaking = state.suspended; this.pauses(); }));
    if (options.owner === 'pet') this.unsubscribes.push(options.api.onAudioDanceSample(frame => this.receiveDanceSample(frame)));
  }
  get active(): boolean { return !!this.view && audioReadingSources.some(source => audioReadingPurposes.some(p => this.view!.sources[source][p].intent)); }
  get sessionId(): string | null { return this.active ? this.view!.scopeId : null; }
  get isExpanded(): boolean { return !!this.panel && !this.panel.hidden; }
  /** 「和她一起听」 is on (the computer's sound). */
  get listening(): boolean { return listenSwitchOn(this.view, this.capture.slots['system-audio']?.dance === true); }
  /** 和她一起看 (the pet toolbar): the same switch as 「和她一起听」, from outside the panel. */
  async setListenTogether(enabled: boolean): Promise<void> { if (!this.disposed && this.view) await this.setListen(enabled).catch(() => {}); } // setListen already told the user
  toggleExpanded(): void { if (this.panel) this.panel.hidden = !this.panel.hidden; this.options.onExpanded?.(this.isExpanded); }
  async init(): Promise<void> {
    const revision = this.capture.revision;
    const [view, capture] = await Promise.all([this.options.api.getAudioReadingView(), this.options.api.getAudioCaptureState()]);
    if (this.disposed) return;
    if (!this.view) this.applyView(view);
    if (this.capture.revision === revision) this.applyCapture(capture);
  }
  setSpeaking(value: boolean): void { this.localSpeaking = value; this.pauses(); }
  captureState(state: SystemAudioState): void {
    if (!state.active && this.systemOwned && !this.startingSystem && !this.stoppingSystem) {
      const descriptor = this.systemOwned; this.systemOwned = null;
      void this.releaseSystem(descriptor, 'lost').catch(error => this.options.onError(String(error)));
    }
    this.refreshDance();
  }
  captureSystemSample(sample: AudioDanceSample): void { this.sendDanceSample('system-audio', sample); }
  async stop(): Promise<void> {
    await Promise.all(audioReadingSources.flatMap(source => audioReadingPurposes.map(purpose => this.options.api.setAudioReadingIntent({ source, purpose, enabled: false }))));
    await this.options.api.setAudioDanceIntent(false);
    await this.options.api.setAudioDanceSourceIntent({ source: 'microphone', enabled: false });
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    ++this.danceOperation;
    if (this.danceFrame) cancelAnimationFrame(this.danceFrame); this.danceFrame = 0;
    this.fusion.clear();
    if (this.options.owner === 'pet') this.options.onMusicEnabled(false);
    if (this.options.owner === 'pet') this.options.onDanceStatus?.(false, '');
    this.unsubscribes.forEach(fn => fn()); this.listenSwitch?.dispose(); this.panel?.remove();
    for (const source of audioReadingSources) this.segments[source].dispose();
    this.options.system?.setPcmListener(null);
    void this.microphone.dispose().catch(error => this.options.onError(String(error)));
    if (this.systemOwned) {
      const old = this.systemOwned; this.systemOwned = null;
      void this.releaseSystem(old, 'released').catch(error => this.options.onError(String(error)));
    }
  }
  private owned(source: AudioReadingSource): AudioCaptureDescriptor | null {
    const descriptor = this.capture.slots[source];
    return descriptor?.owner === this.options.owner ? descriptor : null;
  }
  private key(descriptor: AudioCaptureDescriptor | null): string {
    return descriptor?.ambient ? `${descriptor.id}/${descriptor.ambient.epoch}/${descriptor.revision}` : '';
  }
  private applyView(view: AudioReadingView): void {
    if (this.disposed) return;
    this.view = structuredClone(view);
    this.renderSwitch();
    this.pauses();
  }
  private applyCapture(state: AudioCaptureState): void {
    if (this.disposed || state.revision <= this.capture.revision) return;
    this.capture = structuredClone(state);
    for (const source of audioReadingSources) {
      const descriptor = this.owned(source), key = this.key(descriptor);
      if (key !== this.keys[source]) {
        this.keys[source] = key; this.segments[source].stop();
        if (key) this.segments[source].start(key, 'music', performance.now());
        if (source === 'system-audio') this.options.system?.setPcmListener(key
          ? (samples, rate, end) => this.segments['system-audio'].push(samples, rate, end) : null);
      }
      const frame = this.danceFrames[source], current = state.slots[source];
      if (!current?.dance || frame && (frame.id !== current.id || frame.revision !== current.revision)) {
        this.fusion.clear(source); delete this.danceFrames[source];
      }
    }
    this.pauses();
    void this.microphone.apply(this.owned('microphone')).catch(error => this.options.onError(String(error)));
    const system = this.owned('system-audio');
    if (this.systemOwned && system?.id === this.systemOwned.id) this.systemOwned = system;
    if (this.systemPending && system?.id === this.systemPending.id) this.systemPending = system;
    this.systemChanges++;
    if (!this.systemWork) {
      const started = this.systemChanges;
      this.systemWork = this.driveSystem().catch(error => this.options.onError(String(error))).finally(() => {
        this.systemWork = null;
        if (!this.disposed && this.systemChanges !== started && this.owned('system-audio')?.id !== this.systemOwned?.id) this.applySystemAgain();
      });
    }
    this.refreshDance();
  }
  private applySystemAgain(): void {
    if (this.systemWork) return;
    this.systemWork = this.driveSystem().catch(error => this.options.onError(String(error))).finally(() => { this.systemWork = null; });
  }
  private async driveSystem(): Promise<void> {
    const input = this.options.system; if (!input) return;
    for (;;) {
      const desired = this.disposed ? null : this.owned('system-audio');
      if (this.systemOwned && this.systemOwned.id !== desired?.id) {
        const old = this.systemOwned; this.systemOwned = null; await this.releaseSystem(old, 'released'); continue;
      }
      if (!desired || this.systemOwned) return;
      this.startingSystem = true; this.systemPending = desired;
      try {
        await input.setEnabled(true);
        const current = this.owned('system-audio');
        if (this.disposed || current?.id !== desired.id) { await this.releaseSystem(this.systemPending ?? desired, 'released'); continue; }
        if (!input.active) { await this.releaseSystem(current, 'lost'); return; }
        this.systemOwned = current;
        if (!await this.options.api.ackAudioCapture({ source: 'system-audio', id: current.id, revision: current.revision, phase: 'ready' })) {
          this.systemOwned = null; await this.releaseSystem(current, 'released'); return;
        }
        // Readiness alone never enables dance; only a current host-accepted
        // energy frame can enter the single fused Stage route.
        return;
      } finally { this.startingSystem = false; this.systemPending = null; }
    }
  }
  private async releaseSystem(descriptor: AudioCaptureDescriptor, phase: 'released' | 'lost'): Promise<void> {
    this.stoppingSystem = true;
    try {
      await this.options.system?.releaseOwned();
      await this.options.api.ackAudioCapture({ source: 'system-audio', id: descriptor.id, revision: descriptor.revision, phase });
    } finally { this.stoppingSystem = false; }
  }
  private pauses(): void {
    for (const source of audioReadingSources) this.segments[source].setSpeaking(this.localSpeaking || this.hostSpeaking || this.view?.sources[source].capture.phase === 'paused');
  }
  private danceWanted(): boolean { return audioReadingSources.some(source => this.capture.slots[source]?.dance); }
  /** I-016: the one switch. On = the computer's sound, music cell (the host adds the rhythm); off = every computer's-sound cell. */
  private async setListen(enabled: boolean): Promise<void> {
    try {
      if (enabled) await this.options.api.setAudioReadingIntent({ source: 'system-audio', purpose: 'music', enabled: true });
      else for (const purpose of audioReadingPurposes) await this.options.api.setAudioReadingIntent({ source: 'system-audio', purpose, enabled: false });
    } catch (error) { if (!this.disposed) this.options.onError(error instanceof Error ? error.message : uiText('「和她一起听」没能切换。')); throw error; }
  }
  private renderSwitch(): void {
    this.listenSwitch?.update({ view: this.view, systemDance: this.capture.slots['system-audio']?.dance === true, danceActive: this.danceEnabled });
  }
  private sendDanceSample(source: AudioReadingSource, sample: AudioDanceSample | null): void {
    const descriptor = this.owned(source);
    if (this.disposed || !descriptor?.dance || sample !== null && this.danceSending[source]) return;
    this.danceSending[source] = true;
    void this.options.api.submitAudioDanceSample({ id: descriptor.id, source, revision: descriptor.revision, sample })
      .catch(() => { /* An unavailable host never authorizes a local bypass. */ })
      .finally(() => { this.danceSending[source] = false; });
  }
  private receiveDanceSample(value: AudioDanceFrame): void {
    if (this.disposed || this.options.owner !== 'pet') return;
    const frame = parseAudioDanceFrame(value), descriptor = frame && this.capture.slots[frame.source];
    if (!frame || !frame.sample || !descriptor?.dance || descriptor.id !== frame.id || descriptor.revision !== frame.revision) return;
    const now = performance.now();
    this.danceFrames[frame.source] = { id: frame.id, revision: frame.revision, at: now };
    this.fusion.push(frame.source, frame.sample, now);
    this.refreshDance();
  }
  private refreshDance(): void {
    if (this.disposed || this.options.owner !== 'pet') return;
    const now = performance.now();
    const actual = audioReadingSources.filter(source => this.capture.slots[source]?.dance
      && this.danceFrames[source] && now - this.danceFrames[source]!.at <= 250);
    const active = actual.length > 0;
    if (active !== this.danceEnabled) { this.danceEnabled = active; this.options.onMusicEnabled(active); }
    const result = this.fusion.read(now);
    if (active && result) this.options.onMusicSample?.(result.sample);
    const names = (list: AudioReadingSource[]) => list.map(source => source === 'microphone' ? uiText('麦克风') : uiText('系统声音')).join('、');
    const wanted = audioReadingSources.filter(source => this.capture.slots[source]?.dance);
    const summary = active ? uiTemplate`音频律动 · ${names(actual)} · 仅本机分析`
      : wanted.length ? uiTemplate`音频律动 · 等待${names(wanted)}采集／分析` : '';
    if (summary !== this.danceSummary) { this.danceSummary = summary; this.options.onDanceStatus?.(active, summary); }
    this.renderSwitch();
    if (!this.danceFrame && this.danceWanted()) this.danceFrame = requestAnimationFrame(() => {
      this.danceFrame = 0; this.refreshDance();
    });
  }
}
