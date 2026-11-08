import {uiText} from './ui-language';
import type { RuntimeState } from "../../shared/contracts";
import { VOICE_OPEN_AFTER_REPLY, VOICE_OPEN_WAIT_MS, type VoiceCaptureBinding } from '../../shared/voice-segments';
import type { VoiceConversationEvent } from '../../shared/voice-conversation';
import { t, registerUiMessages } from '../../shared/ui-language';
import { VOICE_UI_MESSAGES, type VoiceUiKey } from '../../shared/voice-ui-messages';
import { DEFAULT_SPEECH_LEVEL, SilenceWatch, SpeechLevelGate } from './voice-level'; import { VoiceCaptureStats } from './voice-capture-stats';
import { GlanceSampler } from './camera-glance-sampler';
registerUiMessages(VOICE_UI_MESSAGES);

type Feature = "voiceInput" | "cameraSharing";
interface MediaInputOptions {
  windowKind: "pet" | "controls";
  onTranscript: (text: string) => void;
  /** `explained`: the windows already said why in her words (a recognition failure with a category); no extra error notice. */
  onError: (error: string, feature: Feature, explained?: boolean) => void;
  onStatus?: (text: string) => void;
  onVoiceStatus?: (text: string) => void;
  canStartVoice?: () => boolean;
  /** 2026-11-06: the microphone gave only silence, or speech came back as no words; voice input stays on (say it in her words). */
  onUnheard?: (failure: "no-sound" | "empty") => void;
  /**
   * Hold T to talk (src/ui/push-to-talk.ts): the microphone's sound counts only while holdToTalk() is in
   * effect; everything else is thrown away. Letting go sends what was said at once (no pause detection). Off: the older
   * continuous listening that sends after a pause.
   */
  pushToTalk?: boolean;
}

/** Held this long before she is told someone started talking (a tap stops nothing). */
export const HOLD_TO_TALK_START_MS = 250;

/** Longest the microphone stays paused for her voice without a renewal (the window's own "speaking" messages come with every sentence). */
export const SPEAKING_MAX_MS = 5 * 60_000;

/** Area averaging avoids simply dropping samples when converting native microphone PCM. */
export function resamplePcm(input: Float32Array, sourceRate: number, targetRate = 16000): Float32Array {
  if (!(sourceRate > 0) || !(targetRate > 0)) throw new Error(t('voice.capture.sampleRate'));
  if (sourceRate === targetRate) return input.slice();
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const start = index * ratio, end = Math.min(input.length, (index + 1) * ratio);
    if (ratio < 1) {
      const left = Math.floor(start), fraction = start - left;
      output[index] = input[left] * (1 - fraction) + input[Math.min(left + 1, input.length - 1)] * fraction;
    } else {
      let sum = 0;
      for (let sample = Math.floor(start); sample < end; sample++) sum += input[sample] * (Math.min(end, sample + 1) - Math.max(start, sample));
      output[index] = sum / (end - start);
    }
  }
  return output;
}

export function encodeWav(pcm: Float32Array, sampleRate = 16000): ArrayBuffer {
  const size = 44 + pcm.length * 2;
  if (size > 4_000_000) throw new Error(t('voice.capture.tooLarge'));
  const buffer = new ArrayBuffer(size), view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  write(0, "RIFF"); view.setUint32(4, size - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let index = 0; index < pcm.length; index++) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(pcm[index]) ? pcm[index] : 0));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

/** One bounded utterance; short noises are discarded and trailing silence is trimmed. */
export class VoiceSegmenter {
  private chunks: Float32Array[] = [];
  private length = 0;
  private voiced = 0;
  private silence = 0;
  get active(): boolean { return this.length > 0; }
  reset(): void { this.chunks = []; this.length = this.voiced = this.silence = 0; }
  push(samples: Float32Array, sampleRate: number, level = DEFAULT_SPEECH_LEVEL): Float32Array | null {
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const speech = samples.length > 0 && Math.sqrt(energy / samples.length) >= level;
    if (!speech && !this.length) return null;
    this.chunks.push(samples.slice()); this.length += samples.length;
    if (speech) { this.voiced += samples.length; this.silence = 0; }
    else this.silence += samples.length;
    if (this.silence < sampleRate * 0.65 && this.length < sampleRate * 15) return null;
    return this.flush(sampleRate);
  }
  flush(sampleRate: number): Float32Array | null {
    let result: Float32Array | null = null;
    if (this.voiced >= sampleRate * 0.25) {
      const length = Math.min(Math.floor(sampleRate * 15), this.length - Math.max(0, this.silence - Math.floor(sampleRate * 0.15)));
      result = new Float32Array(length);
      let offset = 0;
      for (const chunk of this.chunks) {
        const count = Math.min(chunk.length, length - offset);
        if (count <= 0) break;
        result.set(chunk.subarray(0, count), offset); offset += count;
      }
    }
    this.reset();
    return result;
  }
}

/** Devices remain off unless this exact window owns an explicitly enabled runtime feature. */
export class MediaInput {
  private disposed = false;
  private voiceWanted = false;
  private cameraWanted = false;
  /** I-036 「发图片」: the small frame kept ready at the host; stopped while the user said "别看" (`cameraHeld`). */
  private glanceHeld = false;
  private readonly glance = new GlanceSampler({ video: () => this.cameraStream && this.video?.videoWidth ? this.video : null,
    publish: dataUrl => window.desktop.publishCameraFrame(dataUrl) });
  private voiceRevision = 0;
  private cameraRevision = 0;
  private cameraStream: MediaStream | null = null;
  private releaseCameraListeners: (() => void) | null = null;
  private readonly segmenter = new VoiceSegmenter();
  /** 2026-11-06: what counts as speech follows the room; a microphone that gives only silence is noticed. */
  private gate = new SpeechLevelGate();
  private silence = new SilenceWatch(); private stats = new VoiceCaptureStats(); private statsEnd: 'stopped' | 'failed' = 'stopped'; /* 体验记录: numbers of one capture */ private sendStats = (end: 'stopped' | 'no-sound' | 'failed') => { const report = this.stats.report(end, this.gate.threshold); if (report) { try { void window.desktop.noteJournalFact('voice-capture', report).catch(() => {}); } catch { /* journal only */ } } };
  private statusHold: { key: VoiceUiKey; until: number } | null = null;
  private speakingSince = 0;
  private voiceSampleRate = 16000;
  private microphoneIsReady = false;
  private voiceBinding: VoiceCaptureBinding | null = null;
  private captureSeq = 0;
  private pcmQueue: Array<{ wav: ArrayBuffer | null; revision: number; binding: VoiceCaptureBinding }> = [];
  private finishQueued = false;
  private sendingPcm = false;
  private speechDetected = false;
  private endpointTimer: ReturnType<typeof setTimeout> | undefined;
  private speechGeneration = 0;
  private speaking = false;
  private resumeAt = 0;
  /** Hold to talk: T is down (since), and whether her side was told someone started talking. */
  private talk: { since: number; told: boolean } | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private releaseCameraSamples: (() => void) | null = null;
  private cameraPending: { revision: number; id: string } | null = null;
  private readonly cameraSamples = new Set<string>();
  private voiceStatus = '';
  private voiceStatusKey: VoiceUiKey | '' = '';

  constructor(private readonly options: MediaInputOptions) {}

  async applyRuntime(state: RuntimeState): Promise<void> {
    if (this.disposed) return;
    const tasks: Promise<void>[] = [];
    const voice = state.voiceInput && state.voiceOwner === this.options.windowKind;
    // Only 「发图片」 opens the stream here (I-036); 「姿势识别」 owns the camera in its own hidden window and gives this window nothing.
    const camera = state.cameraSharing && state.cameraImages === true && state.cameraOwner === this.options.windowKind;
    this.glanceHeld = state.cameraHeld === true;
    if (voice !== this.voiceWanted) {
      this.voiceWanted = voice;
      const revision = ++this.voiceRevision;
      this.stopVoice();
      if (voice) tasks.push(this.startVoice(revision));
    }
    if (camera !== this.cameraWanted) {
      this.cameraWanted = camera;
      const revision = ++this.cameraRevision;
      this.stopCamera();
      if (camera) tasks.push(this.startCamera(revision));
    }
    this.syncGlance();
    await Promise.all(tasks);
  }

  /** Async host faults must retire only the matching live capture. */
  receiveVoiceFault(event: Extract<VoiceConversationEvent, { type: 'fault' }>, explained = false): void {
    if (event.owner !== this.options.windowKind || event.epoch !== this.voiceBinding?.epoch) return;
    const message = typeof event.message === 'string' && event.message.length <= 600
      && !/[\x00-\x1f\x7f]/.test(event.message) ? event.message : t('voice.capture.paused');
    this.fail(new Error(message), 'voiceInput', this.voiceRevision, explained);
  }

  setSpeaking(speaking: boolean): void {
    if (speaking) this.speakingSince = performance.now(); // each "speaking" renews it (2026-11-06: never deaf for good)
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    this.segmenter.reset();
    this.resumeAt = speaking ? Infinity : performance.now() + 200;
  }

  /** Explicit button: keep the consented microphone, stop owned reading first. */
  async startSpeaking(): Promise<void> {
    const binding = this.voiceBinding, revision = this.voiceRevision;
    if (!binding || !this.active('voiceInput', revision)) return;
    this.speechGeneration++;
    if (!await window.desktop.signalVoiceCapture(binding.captureSessionId, 'speech-start')) throw Error(t('voice.capture.stopped'));
    if (this.voiceBinding !== binding || !this.active('voiceInput', revision)) return;
    this.speaking = false; this.segmenter.reset(); this.resumeAt = 0;
    this.reportVoice('voice.capture.supplement');
  }
  /** Separate from cancelling generation; flush current accepted speech first. */
  async finishSpeaking(): Promise<void> {
    const binding = this.voiceBinding, revision = this.voiceRevision;
    if (!binding || !this.active('voiceInput', revision)) return;
    clearTimeout(this.endpointTimer); this.endpointTimer = undefined;
    this.speechGeneration++;
    if (this.finishQueued) return this.drainPcm();
    if (this.pcmQueue.filter(value => value.wav !== null).length >= 3)
      throw Error(t('voice.capture.queueUnfinished'));
    const current = this.segmenter.flush(this.voiceSampleRate);
    if (current) {
      const wav = encodeWav(resamplePcm(current, this.voiceSampleRate));
      if (wav.byteLength > 480044 || this.pcmQueue.filter(value => value.wav !== null).length >= 3)
        throw Error(t('voice.capture.queueUnfinished'));
      this.pcmQueue.push({ wav, revision, binding });
    }
    // An explicit marker orders finish after the accepted renderer prefix and
    // before speech captured afterward, without blocking capture or dropping it.
    this.finishQueued = true; this.speechDetected = false;
    this.pcmQueue.push({ wav: null, revision, binding });
    await this.drainPcm();
  }

  dispose(): void {
    this.disposed = true;
    this.voiceWanted = this.cameraWanted = false;
    this.voiceRevision++; this.cameraRevision++;
    this.stopVoice(); this.stopCamera();
  }

  private active(feature: Feature, revision: number): boolean {
    return !this.disposed && (feature === "voiceInput" ? this.voiceWanted && revision === this.voiceRevision : this.cameraWanted && revision === this.cameraRevision);
  }
  private stopStream(stream: MediaStream | null): void { stream?.getTracks().forEach(track => track.stop()); }
  private watchTracks(stream: MediaStream, feature: Feature, revision: number): () => void {
    const tracks = stream.getTracks();
    const ended = () => this.fail(new Error(feature === "voiceInput" ? t('voice.capture.disconnected') : uiText("摄像头已断开，已停止共享。")), feature, revision);
    for (const track of tracks) track.addEventListener("ended", ended);
    return () => { for (const track of tracks) track.removeEventListener("ended", ended); };
  }
  private fail(error: unknown, feature: Feature, revision: number, explained = false): void {
    if (!this.active(feature, revision)) return;
    if (feature === "voiceInput") { this.voiceWanted = false; this.voiceRevision++; this.statsEnd = 'failed'; this.stopVoice(); }
    else { this.cameraWanted = false; this.cameraRevision++; this.stopCamera(); }
    let message = error instanceof Error ? error.message : String(error);
    const transcriptionPrefix = "Error invoking remote method 'desk:transcribeAudio': Error: ";
    if (feature === "voiceInput" && message.startsWith(transcriptionPrefix)) message = message.slice(transcriptionPrefix.length);
    this.options.onError(message, feature, explained);
  }

  microphoneReady(ready: boolean): void {
    this.microphoneIsReady = ready;
    if (this.voiceWanted && this.voiceBinding) this.reportVoice(ready ? this.idleVoiceKey() : 'voice.capture.waiting');
  }

  /** PCM arrives only from the one host-selected shared microphone owner. */
  pushVoicePcm(samples: Float32Array, sampleRate: number): void {
    const revision = this.voiceRevision, binding = this.voiceBinding;
    if (!binding || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
    this.voiceSampleRate = sampleRate; this.stats.chunk(samples, sampleRate);

        if (!this.active("voiceInput", revision)) return;
        // "She is speaking" that nobody renewed for SPEAKING_MAX_MS is not speaking (a reading cancelled before it began never says stopped).
        if (this.speaking && performance.now() - this.speakingSince > SPEAKING_MAX_MS) {
          this.speaking = false; this.resumeAt = 0; this.segmenter.reset();
          void window.desktop.signalVoiceCapture(binding.captureSessionId, 'pause-stuck').catch(() => {});
        }
        if (this.speaking || performance.now() < this.resumeAt) { this.stats.paused(samples.length / sampleRate); this.segmenter.reset(); this.reportVoice('voice.capture.reading'); return; }
        if (this.options.pushToTalk) { this.heldPcm(samples, sampleRate, revision, binding); return; }
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const level = Math.sqrt(energy / samples.length);
        const threshold = this.gate.threshold;
        this.gate.observe(level, this.segmenter.active || this.speechDetected);
        if (this.silence.feed(level, samples.length / sampleRate)) this.noteUnheard('no-sound');
        if (level >= threshold) {
          this.speechGeneration++;
          clearTimeout(this.endpointTimer); this.endpointTimer = undefined;
          if (!this.speechDetected) {
            this.speechDetected = true;
            void window.desktop.signalVoiceCapture(binding.captureSessionId, 'speech-start')
              .then(ok => { if (!ok) this.fail(Error(t('voice.capture.stopped')), 'voiceInput', revision); })
              .catch(error => this.fail(error, 'voiceInput', revision));
          }
        }
        this.reportVoice(level >= threshold ? 'voice.capture.detected' : level >= threshold / 2 ? 'voice.capture.quiet' : 'voice.capture.listening');
        const utterance = this.segmenter.push(samples, sampleRate, threshold);
        if (!utterance && this.speechDetected && !this.segmenter.active) {
          this.speechDetected = false;
          void window.desktop.signalVoiceCapture(binding.captureSessionId, 'endpoint')
            .catch(error => this.fail(error, 'voiceInput', revision));
        }
        if (utterance) {
          this.speechDetected = false;
          void this.transcribe(utterance, sampleRate, revision);
          const endpointGeneration = this.speechGeneration;
          this.endpointTimer = setTimeout(() => {
            this.endpointTimer = undefined;
            if (this.voiceBinding === binding && this.active('voiceInput', revision) && !this.speechDetected)
              void this.drainPcm().then(() => {
                if (this.voiceBinding === binding && this.active('voiceInput', revision) && !this.speechDetected
                  && this.speechGeneration === endpointGeneration)
                  return window.desktop.signalVoiceCapture(binding.captureSessionId, 'endpoint');
              })
                .catch(error => this.fail(error, 'voiceInput', revision));
          }, 1500);
        }
  }

  private idleVoiceKey(): VoiceUiKey { return this.options.pushToTalk ? 'voice.capture.holdT' : 'voice.capture.listening'; }

  /** Hold to talk: voice input is on here and its capture is open (T does something). */
  get canHoldToTalk(): boolean { return this.options.pushToTalk === true && !!this.voiceBinding && this.active('voiceInput', this.voiceRevision); }

  /** T went down: from now on the microphone's sound counts. */
  holdToTalk(): void {
    if (!this.canHoldToTalk || this.talk) return;
    this.talk = { since: performance.now(), told: false };
    this.segmenter.reset(); this.speechDetected = false;
    clearTimeout(this.endpointTimer); this.endpointTimer = undefined; this.speechGeneration++;
    this.reportVoice('voice.capture.holding');
  }

  /** T came up: what was said is sent now (send false: a tap, thrown away). */
  releaseToTalk(send = true): void {
    const talk = this.talk; this.talk = null;
    if (!talk) return;
    const binding = this.voiceBinding, revision = this.voiceRevision;
    this.speechDetected = false;
    if (!binding || !this.active('voiceInput', revision)) { this.segmenter.reset(); return; }
    const utterance = send && talk.told ? this.segmenter.flush(this.voiceSampleRate) : (this.segmenter.reset(), null);
    if (utterance) void this.transcribe(utterance, this.voiceSampleRate, revision);
    if (talk.told) void this.drainPcm().then(() => {
      if (this.voiceBinding === binding && this.active('voiceInput', revision) && !this.talk)
        return window.desktop.signalVoiceCapture(binding.captureSessionId, 'endpoint');
    }).catch(error => this.fail(error, 'voiceInput', revision));
    this.reportVoice(this.microphoneIsReady ? this.idleVoiceKey() : 'voice.capture.waiting');
  }

  /** Hold to talk: one chunk of the microphone's sound. Without T held it is thrown away. */
  private heldPcm(samples: Float32Array, sampleRate: number, revision: number, binding: VoiceCaptureBinding): void {
    if (!this.talk) { this.segmenter.reset(); this.reportVoice(this.microphoneIsReady ? this.idleVoiceKey() : 'voice.capture.waiting'); return; }
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    if (this.silence.feed(Math.sqrt(energy / Math.max(1, samples.length)), samples.length / sampleRate)) this.noteUnheard('no-sound');
    if (!this.talk.told && performance.now() - this.talk.since >= HOLD_TO_TALK_START_MS) {
      this.talk.told = true; this.speechDetected = true;
      void window.desktop.signalVoiceCapture(binding.captureSessionId, 'speech-start')
        .then(ok => { if (!ok) this.fail(Error(t('voice.capture.stopped')), 'voiceInput', revision); })
        .catch(error => this.fail(error, 'voiceInput', revision));
    }
    // Everything said while T is held counts (level 0): no pause ends it; a very long hold is cut into 15-second pieces.
    const piece = this.segmenter.push(samples, sampleRate, 0);
    if (piece) void this.transcribe(piece, sampleRate, revision);
    this.reportVoice('voice.capture.holding');
  }

  private async startVoice(revision: number): Promise<void> {
    try {
      this.reportVoice('voice.capture.opening');
      if (this.options.canStartVoice && !this.options.canStartVoice()) throw Error(t('voice.capture.draft'));
      const binding = await this.openAfterReply(revision);
      if (!binding) return;
      if (!this.active('voiceInput', revision)) { void window.desktop.signalVoiceCapture(binding.captureSessionId, 'cancel'); return; }
      this.voiceBinding = binding; this.captureSeq = 0; this.stats.begin(this.speaking || performance.now() < this.resumeAt);
      if (this.active('voiceInput', revision)) this.reportVoice(this.microphoneIsReady ? this.idleVoiceKey() : 'voice.capture.waiting');
    } catch (error) { this.fail(error, "voiceInput", revision); }
  }

  /**
   * Her reply is still being written (turning voice input on mid-chat stopped her and then itself):
   * the switch stays on, the status says she is finishing, and the capture opens as soon as the reply is done.
   */
  private async openAfterReply(revision: number): Promise<VoiceCaptureBinding | null> {
    const started = performance.now();
    for (;;) {
      try { return await window.desktop.openVoiceCapture(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes(VOICE_OPEN_AFTER_REPLY) || performance.now() - started > VOICE_OPEN_WAIT_MS) throw error;
      }
      if (!this.active('voiceInput', revision)) return null;
      this.reportVoice('voice.capture.afterReply');
      await new Promise(resolve => setTimeout(resolve, 400));
      if (!this.active('voiceInput', revision)) return null;
    }
  }

  private async transcribe(pcm: Float32Array, sampleRate: number, revision: number): Promise<void> {
    const binding = this.voiceBinding;
    if (!binding || !this.active('voiceInput', revision)) return;
    try {
      const wav = encodeWav(resamplePcm(pcm, sampleRate));
      if (wav.byteLength > 480044 || this.pcmQueue.filter(value => value.wav !== null).length >= 3) throw Error(t('voice.capture.overflow'));
      this.pcmQueue.push({ wav, revision, binding });
      this.reportVoice('voice.capture.queued'); await this.drainPcm();
    } catch (error) { this.fail(error, "voiceInput", revision); }
  }
  private drainPromise: Promise<void> = Promise.resolve();
  private drainPcm(): Promise<void> {
    if (this.sendingPcm) return this.drainPromise;
    this.sendingPcm = true;
    this.drainPromise = (async () => {
      let continueNewScope = false;
      try {
        while (this.pcmQueue.length) {
          const item = this.pcmQueue[0];
          if (!this.active('voiceInput', item.revision) || this.voiceBinding !== item.binding) { this.pcmQueue.shift(); continue; }
          if (item.wav === null) {
            const accepted = await window.desktop.signalVoiceCapture(item.binding.captureSessionId, 'finish-speaking');
            if (!this.active('voiceInput', item.revision) || this.voiceBinding !== item.binding) {
              continueNewScope = this.voiceBinding !== null && this.voiceBinding !== item.binding; return;
            }
            if (!accepted) throw Error(t('voice.capture.finishFailed'));
            this.finishQueued = false; this.pcmQueue.shift(); continue;
          }
          const receipt = await window.desktop.submitVoicePcm({ captureSessionId: item.binding.captureSessionId,
            captureSeq: this.captureSeq + 1, wav: item.wav });
          if (!this.active('voiceInput', item.revision) || this.voiceBinding !== item.binding) {
            continueNewScope = this.voiceBinding !== null && this.voiceBinding !== item.binding; return;
          }
          if (receipt.state === 'rejected') throw Error(t('voice.capture.rejected', { reason: receipt.reason }));
          this.captureSeq++; this.pcmQueue.shift();
        }
      } finally {
        this.sendingPcm = false;
        if (continueNewScope && this.pcmQueue.length && this.voiceBinding)
          queueMicrotask(() => { void this.drainPcm().catch(error => this.fail(error, 'voiceInput', this.voiceRevision)); });
      }
    })();
    return this.drainPromise;
  }

  private stopVoice(): void {
    const binding = this.voiceBinding; this.voiceBinding = null; if (binding) { this.sendStats(this.statsEnd); } this.statsEnd = 'stopped';
    this.speechGeneration++;
    clearTimeout(this.endpointTimer); this.endpointTimer = undefined;
    this.pcmQueue = []; this.speechDetected = false; this.finishQueued = false; this.talk = null;
    this.gate = new SpeechLevelGate(); this.silence = new SilenceWatch(); this.statusHold = null;
    if (binding) void window.desktop.signalVoiceCapture(binding.captureSessionId, 'cancel').catch(() => {});
    this.reportVoice('');
    this.segmenter.reset();
  }

  refreshVoiceStatus(): void { this.reportVoice(this.voiceStatusKey); }

  /**
   * Voice input is on and listening but nothing usable came of it: the microphone gives only silence,
   * or the recognizer heard speech and returned no words. The status line says so for a while, her windows say it in her words
   * (onUnheard) and, for the silent microphone, the host writes one journal line. Voice input stays on.
   */
  noteUnheard(failure: 'no-sound' | 'empty'): void {
    const binding = this.voiceBinding;
    if (!binding || !this.active('voiceInput', this.voiceRevision)) return;
    const key: VoiceUiKey = failure === 'no-sound' ? 'voice.capture.noSound' : 'voice.capture.unheard';
    this.statusHold = { key, until: performance.now() + 8000 };
    this.reportVoice(key);
    if (failure === 'no-sound') { this.sendStats('no-sound'); void window.desktop.signalVoiceCapture(binding.captureSessionId, 'no-sound').catch(() => {}); }
    this.options.onUnheard?.(failure);
  }
  private reportVoice(key: VoiceUiKey | ''): void {
    // The routine "listening" refresh of every audio chunk must not wipe a sentence that was just said (it would last 85 ms).
    if (this.statusHold && key !== this.statusHold.key) {
      if (performance.now() >= this.statusHold.until || key === '') this.statusHold = null;
      else if (key === 'voice.capture.listening' || key === 'voice.capture.quiet' || key === 'voice.capture.queued' || key === 'voice.capture.holdT' || key === 'voice.capture.holding') return;
      else this.statusHold = null;
    }
    this.voiceStatusKey = key;
    const text = key ? t(key) : '';
    if (text === this.voiceStatus) return;
    this.voiceStatus = text;
    this.options.onVoiceStatus?.(text);
  }

  private async startCamera(revision: number): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } }, audio: false });
      if (!this.active("cameraSharing", revision)) { this.stopStream(stream); return; }
      this.cameraStream = stream;
      this.releaseCameraListeners = this.watchTracks(stream, "cameraSharing", revision);
      const video = this.video = document.createElement("video");
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      if (!this.active("cameraSharing", revision)) return;
      // Each message/attention event asks for one fresh frame. There is no camera
      // polling timer or unsolicited frame on enable.
      this.releaseCameraSamples = window.desktop.onCameraSample?.(id => void this.publishFrame(revision, id)) ?? null;
      this.options.onStatus?.(uiText("摄像头共享已开启"));
      this.syncGlance();
    } catch (error) { this.fail(error, "cameraSharing", revision); }
  }

  private async publishFrame(revision: number, id: string): Promise<void> {
    const video = this.video;
    if (!this.active("cameraSharing", revision) || !this.cameraStream || !video?.videoWidth || !video.videoHeight
      || typeof id !== "string" || !/^camera-[a-zA-Z0-9_-]{1,100}$/.test(id) || this.cameraSamples.has(id)) return;
    this.cameraSamples.add(id);
    if (this.cameraSamples.size > 128) this.cameraSamples.delete(this.cameraSamples.values().next().value!);
    if (this.cameraPending) return;
    const pending = this.cameraPending = { revision, id };
    try {
      const canvas = this.canvas ??= document.createElement("canvas");
      const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
      const width = Math.max(1, Math.round(video.videoWidth * scale)), height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const context = canvas.getContext("2d");
      if (!context) throw new Error(uiText("无法创建摄像头共享画面"));
      context.drawImage(video, 0, 0, width, height);
      let dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      // Do not retain the sampled picture as an idle camera cache.
      canvas.width = canvas.height = 1;
      if (!this.active("cameraSharing", revision) || this.cameraPending !== pending) return;
      const published = window.desktop.publishCameraSample(id, dataUrl);
      dataUrl = "";
      await published;
    } catch {
      // A cancelled/expired host request is not a camera device failure. Keep the
      // explicitly enabled stream available for the next user/attention event.
      if (this.active("cameraSharing", revision) && this.cameraPending === pending)
        this.options.onStatus?.(uiText("此次摄像头画面未能提交，等待下一次消息。"));
    } finally {
      if (this.canvas) this.canvas.width = this.canvas.height = 1;
      if (this.cameraPending === pending) this.cameraPending = null;
    }
  }

  private syncGlance(): void {
    this.glance.sync(!this.disposed && this.cameraWanted && !this.glanceHeld && !!this.cameraStream && !!this.video);
  }

  private stopCamera(): void {
    this.glance.sync(false);
    this.releaseCameraListeners?.(); this.releaseCameraListeners = null;
    this.releaseCameraSamples?.(); this.releaseCameraSamples = null;
    this.cameraPending = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    this.video = this.canvas = null;
    this.stopStream(this.cameraStream); this.cameraStream = null;
  }
}
