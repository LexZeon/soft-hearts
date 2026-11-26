import type { AudioCaptureAck, AudioCaptureDescriptor } from '../../shared/senses/audio-capture';
import type { AudioDanceSample } from '../../shared/senses/audio-dance';
import { audioEnergy } from './audio-energy';

interface Options {
  owner: 'controls' | 'pet';
  acknowledge(value: AudioCaptureAck): Promise<boolean>;
  onPcm(samples: Float32Array, rate: number, endedAt: number): void;
  onError(message: string): void;
  onReady?(value: boolean): void;
  onSample?(value: AudioDanceSample | null): void;
  /**
   * I-177: the call's microphone choice (the user's own priority list; deviceId null = the system default, exactly as before). Asked before
   * the microphone opens and, when the names were still blank, once more after the first grant. It picks WHICH microphone; no new permission.
   */
  micChoice?(): Promise<{ deviceId: string | null; labelsKnown: boolean }>;
}
interface Owned {
  descriptor: AudioCaptureDescriptor; stream: MediaStream; context: AudioContext;
  source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode | null; mute: GainNode | null;
  analyser: AnalyserNode | null; frame: number;
  unwatch(): void;
  /** I-190: the device this stream was asked for (null: the system default), so a new choice knows whether it changes anything. */
  asked?: string | null;
}

/** Exactly one host-selected microphone. Chat and ambient consume this same PCM;
 * no caller can choose a device or disable chat's echo/noise processing.
 */
export class MicrophoneInput {
  private desired: AudioCaptureDescriptor | null = null;
  private owned: Owned | null = null;
  private pending: { descriptor: AudioCaptureDescriptor } | null = null;
  private releasing: Promise<void> = Promise.resolve();
  private work: Promise<void> | null = null;
  private disposed = false;
  private changes = 0;
  /** I-190: the device the last open asked for and got (null: the system default); a swap under way. */
  private opened: string | null = null;
  private swapping = false;
  constructor(private readonly options: Options) {}

  apply(descriptor: AudioCaptureDescriptor | null): Promise<void> {
    const next = !this.disposed && descriptor?.source === 'microphone' && descriptor.owner === this.options.owner ? structuredClone(descriptor) : null;
    this.desired = next; this.changes++;
    if (this.pending && next?.id === this.pending.descriptor.id) this.pending.descriptor = next;
    if (this.owned && next?.id === this.owned.descriptor.id) { this.owned.descriptor = next; this.syncConsumers(this.owned); }
    else if (this.owned) this.retireOwned('released');
    if (!this.work) {
      const started = this.changes;
      this.work = this.drive().finally(() => {
        this.work = null;
        if (this.changes !== started && this.desired && !this.owned && !this.disposed) void this.apply(this.desired).catch(error => this.options.onError(error instanceof Error ? error.message : '麦克风释放未完成。'));
      });
    }
    return this.work;
  }
  dispose(): Promise<void> { this.disposed = true; return this.apply(null); }

  private async drive(): Promise<void> {
    for (;;) {
      await this.releasing;
      if (!this.desired || this.disposed) return;
      if (this.owned?.descriptor.id === this.desired.id) return;
      const pending = this.pending = { descriptor: this.desired };
      let stream: MediaStream | null = null;
      let context: AudioContext | null = null;
      try {
        const first = await this.choose();
        stream = await this.open(first);
        if (!first.labelsKnown) { // the names are blank until the first grant: look again with the stream open
          const again = await this.choose();
          if (again.labelsKnown && again.deviceId) { const next = await this.open(again).catch(() => null); if (next) { stream.getTracks().forEach(track => track.stop()); stream = next; } }
        }
        if (this.disposed || this.desired?.id !== pending.descriptor.id) {
          stream.getTracks().forEach(track => track.stop()); stream = null;
          await this.options.acknowledge(this.ack(pending.descriptor, 'released'));
          continue;
        }
        const descriptor = this.desired;
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const owned: Owned = { descriptor, stream, context, source, processor: null, mute: null, analyser: null, frame: 0, unwatch: () => {}, asked: this.opened };
        owned.unwatch = this.watch(owned);
        this.owned = owned;
        this.syncConsumers(owned);
        if (context.state === 'suspended') await context.resume();
        if (this.owned !== owned || this.disposed || this.desired?.id !== descriptor.id) {
          if (this.owned === owned) this.retireOwned('released');
          continue;
        }
        // A metadata-only revision change keeps the same physical stream.
        owned.descriptor = this.desired;
        if (!await this.options.acknowledge(this.ack(owned.descriptor, 'ready'))) {
          this.desired = null; this.retireOwned('released');
          continue;
        }
        this.options.onReady?.(true);
        return;
      } catch (error) {
        if (this.owned?.descriptor.id === pending.descriptor.id) {
          this.desired = null; this.retireOwned('lost');
        } else {
          stream?.getTracks().forEach(track => track.stop());
          if (context && context.state !== 'closed') await context.close();
          const current = this.desired?.id === pending.descriptor.id;
          if (current) this.desired = null;
          await this.options.acknowledge(this.ack(pending.descriptor, current ? 'lost' : 'released'));
        }
        if (!this.disposed) this.options.onError(error instanceof Error ? error.message : '麦克风无法启动，请重新开启。');
      } finally { if (this.pending === pending) this.pending = null; }
    }
  }
  private async choose(): Promise<{ deviceId: string | null; labelsKnown: boolean }> {
    if (!this.options.micChoice) return { deviceId: null, labelsKnown: true };
    try { return await this.options.micChoice(); } catch { return { deviceId: null, labelsKnown: true }; }
  }
  /** One getUserMedia; a chosen device that is gone falls back to the system default. The processing flags never change. */
  private async open(choice: { deviceId: string | null; labelsKnown: boolean }): Promise<MediaStream> {
    const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (choice.deviceId && choice.labelsKnown) {
      try { const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: choice.deviceId } }, video: false }); this.opened = choice.deviceId; return stream; } catch { /* unplugged since: the default */ }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    this.opened = null;
    return stream;
  }
  /** The stream's tracks ending (unplugged, revoked) stops every use, as before; a stream swapped out by reselect no longer counts. */
  private watch(owned: Owned): () => void {
    const stream = owned.stream;
    const lost = () => {
      if (this.owned !== owned || owned.stream !== stream) return;
      this.desired = null; this.retireOwned('lost');
      this.options.onError('麦克风已断开，相关音频功能已停止，请明确重新开启。');
    };
    for (const track of stream.getTracks()) track.addEventListener('ended', lost);
    return () => stream.getTracks().forEach(track => track.removeEventListener('ended', lost));
  }
  /**
   * I-190: the user picked another microphone (the toolbar's ▾, the Unbound input box's panel, another window) while it is open: the same
   * consumers (chat, listening, rhythm) are fed from the chosen device. No new grant (this window already holds the microphone) and no
   * acknowledgement (the host's capture did not change); a device that will not open leaves the current stream as it is. Closed: nothing
   * (the next open reads the list anyway). Never opens a microphone that is not already open.
   */
  async reselect(): Promise<boolean> {
    const owned = this.owned;
    if (!owned || this.work || this.disposed || this.swapping) return false;
    this.swapping = true;
    try {
      const choice = await this.choose();
      const want = choice.labelsKnown ? choice.deviceId : null;
      if (this.owned !== owned || want === (owned.asked ?? null)) return false;
      let stream: MediaStream;
      try { stream = await this.open(choice); } catch { return false; }
      if (this.owned !== owned || this.disposed) { stream.getTracks().forEach(track => track.stop()); return false; }
      const old = owned.stream, oldSource = owned.source, source = owned.context.createMediaStreamSource(stream);
      owned.unwatch();
      for (const node of [owned.processor, owned.analyser]) if (node) { try { oldSource.disconnect(node); } catch { /* already apart */ } source.connect(node); }
      oldSource.disconnect();
      owned.stream = stream; owned.source = source; owned.asked = this.opened;
      owned.unwatch = this.watch(owned);
      old.getTracks().forEach(track => track.stop());
      return true;
    } finally { this.swapping = false; }
  }
  private retireOwned(phase: 'released' | 'lost'): void {
    const owned = this.owned; if (!owned) return;
    this.owned = null; this.options.onReady?.(false); owned.unwatch();
    this.releasePcm(owned); this.releaseAnalyser(owned); owned.source.disconnect();
    owned.stream.getTracks().forEach(track => track.stop());
    const close = owned.context.state === 'closed' ? Promise.resolve() : owned.context.close();
    this.releasing = this.releasing.then(() => close).then(async () => {
      await this.options.acknowledge(this.ack(owned.descriptor, phase));
    });
  }
  private ack(descriptor: AudioCaptureDescriptor, phase: AudioCaptureAck['phase']): AudioCaptureAck {
    return { source: 'microphone', id: descriptor.id, revision: descriptor.revision, phase };
  }
  private releasePcm(owned: Owned): void {
    if (owned.processor) {
      owned.processor.onaudioprocess = null;
      try { owned.source.disconnect(owned.processor); } catch { /* Context may already be closing. */ }
      owned.processor.disconnect(); owned.processor = null;
    }
    owned.mute?.disconnect(); owned.mute = null;
  }
  private releaseAnalyser(owned: Owned): void {
    if (owned.frame) cancelAnimationFrame(owned.frame);
    owned.frame = 0;
    if (owned.analyser) {
      try { owned.source.disconnect(owned.analyser); } catch { /* Owned closure continues. */ }
      owned.analyser.disconnect(); owned.analyser = null;
    }
  }
  private syncConsumers(owned: Owned): void {
    // Dance cannot start a PCM/ASR branch or a connection to an output endpoint.
    if (!owned.descriptor.chat && !owned.descriptor.ambient) this.releasePcm(owned);
    else if (!owned.processor) {
      const processor = owned.processor = owned.context.createScriptProcessor(4096, 1, 1);
      const mute = owned.mute = owned.context.createGain(); mute.gain.value = 0;
      processor.onaudioprocess = event => {
        if (this.owned !== owned || this.desired?.id !== owned.descriptor.id
          || !owned.descriptor.chat && !owned.descriptor.ambient) return;
        this.options.onPcm(event.inputBuffer.getChannelData(0), owned.context.sampleRate, performance.now());
      };
      // Existing separately consented chat/understanding needs a silent processor
      // sink. Its output buffer stays zero; microphone audio is never monitored.
      owned.source.connect(processor); processor.connect(mute); mute.connect(owned.context.destination);
    }
    if (!owned.descriptor.dance || !this.options.onSample) { this.releaseAnalyser(owned); return; }
    if (owned.analyser) return;
    const analyser = owned.analyser = owned.context.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.65; owned.source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize), spectrum = new Float32Array(analyser.frequencyBinCount);
    let lastAt = -Infinity;
    const read = (now: number) => {
      owned.frame = 0;
      if (this.owned !== owned || this.desired?.id !== owned.descriptor.id || !owned.descriptor.dance || owned.analyser !== analyser) return;
      if (now - lastAt >= 1000 / 30) {
        lastAt = now;
        try {
          analyser.getFloatTimeDomainData(samples); analyser.getFloatFrequencyData(spectrum);
          this.options.onSample?.(audioEnergy(samples, spectrum, owned.context.sampleRate, now / 1000));
        } catch {
          this.releaseAnalyser(owned); this.options.onSample?.(null);
          this.options.onError('麦克风律动分析已停止；其他已开启用途保持，请明确重新开启律动。'); return;
        }
      }
      owned.frame = requestAnimationFrame(read);
    };
    owned.frame = requestAnimationFrame(read);
  }
}
