import type { AudioCaptureAck, AudioCaptureDescriptor } from '../../shared/audio-capture';
import type { AudioDanceSample } from '../../shared/audio-dance';
import { audioEnergy } from './audio-energy';

interface Options {
  owner: 'controls' | 'pet';
  acknowledge(value: AudioCaptureAck): Promise<boolean>;
  onPcm(samples: Float32Array, rate: number, endedAt: number): void;
  onError(message: string): void;
  onReady?(value: boolean): void;
  onSample?(value: AudioDanceSample | null): void;
}
interface Owned {
  descriptor: AudioCaptureDescriptor; stream: MediaStream; context: AudioContext;
  source: MediaStreamAudioSourceNode; processor: ScriptProcessorNode | null; mute: GainNode | null;
  analyser: AnalyserNode | null; frame: number;
  unwatch(): void;
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        }, video: false });
        if (this.disposed || this.desired?.id !== pending.descriptor.id) {
          stream.getTracks().forEach(track => track.stop()); stream = null;
          await this.options.acknowledge(this.ack(pending.descriptor, 'released'));
          continue;
        }
        const descriptor = this.desired;
        context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        const lost = () => {
          const current = this.owned;
          if (!current || current.stream !== stream) return;
          this.desired = null; this.retireOwned('lost');
          this.options.onError('麦克风已断开，相关音频功能已停止，请明确重新开启。');
        };
        for (const track of stream.getTracks()) track.addEventListener('ended', lost);
        const owned: Owned = { descriptor, stream, context, source, processor: null, mute: null, analyser: null, frame: 0,
          unwatch: () => stream!.getTracks().forEach(track => track.removeEventListener('ended', lost)) };
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
