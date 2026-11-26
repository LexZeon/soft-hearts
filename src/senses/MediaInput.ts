import {uiText} from '../foundation/ui-language';
import type { RuntimeState } from "../../shared/foundation/runtime-state";
import { VOICE_OPEN_AFTER_REPLY, VOICE_OPEN_WAIT_MS, type VoiceCaptureBinding } from '../../shared/voice';
import type { VoiceConversationEvent } from '../../shared/voice';
import { t, registerUiMessages } from '../../shared/foundation/ui-language';
import { VOICE_UI_MESSAGES, type VoiceUiKey } from '../../shared/voice';
import { SilenceWatch, SpeechLevelGate } from '../voice'; import { VoiceCaptureStats } from '../voice';
import { GlanceSampler } from './camera-glance-sampler';
import { openCamera } from './camera-choice'; // I-190: the chosen camera
import type { VoiceCallKnobs } from '../../shared/voice';
import { BargeInDetector } from '../voice';
import { ChunkLead, VadSpeechDetector, type CallVadStream, type VadHeard } from '../voice';
import { TURN_AUDIO_SECONDS, TurnEndJudge, toTurnAudio, type CallTurnStream, type TurnEndBy } from '../voice'; // I-099/I-100: Smart Turn
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
   * Hold T to talk (src/voice/push-to-talk.ts): the microphone's sound counts only while holdToTalk() is in
   * effect; everything else is thrown away. Letting go sends what was said at once (no pause detection). Off: the older
   * continuous listening that sends after a pause.
   */
  pushToTalk?: boolean;
  /** I-091 call mode (src/voice/voice-call/): what the microphone heard, for the short sound before her reply and the turn timing. */
  onCallEvent?: (event: CallInputEvent) => void;
  /** I-099: the call's neural voice activity detection (src/voice/voice-call/vad.ts); without it, or when it cannot answer, loudness decides. */
  callVad?: Pick<CallVadStream, 'ready' | 'start' | 'stop' | 'probe'>;
  /** I-099/I-100: in a call (with the VAD), the turn model that says whether a pause is the end of your turn (src/voice/voice-call/turn-end.ts). */
  callTurn?: Pick<CallTurnStream, 'ready' | 'start' | 'stop' | 'ask'>;
  /** I-189 #2: asked only when talking over her would fire: true (your face is turned from the screen, sure) → not talking over her. */
  overHerHeld?: () => boolean;
}
/**
 * I-091: a call's microphone events. 'pause': the user stopped after saying enough (quietMs since the last voiced chunk).
 * 'voiced' (I-099): `at` is when that speech ended (the VAD's last speech window, or the chunk for loudness); `vad`: the VAD said so.
 */
export type CallInputEvent = { type: 'voiced'; at?: number; vad?: boolean } | { type: 'pause'; quietMs: number } | { type: 'endpoint'; by?: TurnEndBy; smartTurnOff?: 'guard' } | { type: 'handed-in' } | { type: 'barge-in' } | { type: 'over-her-end'; clip: boolean };
/** listening over her that never heard a voiced chunk ends after this long (she goes on; the microphone pauses again). */
export const OVER_HER_IDLE_MS = 1500;

/** Held this long before she is told someone started talking (a tap stops nothing). */
export const HOLD_TO_TALK_START_MS = 250;

/** Longest the microphone stays paused for her voice without a renewal (the window's own "speaking" messages come with every sentence). */
export const SPEAKING_MAX_MS = 5 * 60_000;

export { encodeWav, resamplePcm, VoiceSegmenter } from './voice-pcm';
import { encodeWav, resamplePcm, VoiceSegmenter } from './voice-pcm';

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
  /** I-091: the call's knobs while a call is on in this window (no T key, barge-in, shorter endpoint); null otherwise. */
  private call: VoiceCallKnobs | null = null;
  private readonly bargeIn = new BargeInDetector();
  /** sound over her reading opens listening; she keeps reading. Null: not listening over her. */
  private overHer: { since: number; heard: boolean } | null = null;
  /** I-091: her short "嗯" is playing: speech must reach the barge-in gate (her own sound must not start a turn). */
  private echoGuard = false;
  private callVoicedAt = 0;
  private callPaused = true;
  /** I-099: the call's VAD verdicts, the moments before a confirmed start, and the chunks waiting for (or behind) a VAD answer. */
  private readonly vadSpeech = new VadSpeechDetector();
  private readonly vadLead = new ChunkLead();
  private vadQueue: Promise<void> = Promise.resolve();
  private vadBacklog = 0;
  /** I-099/I-100: in a call with the VAD, this call's turn judge (null otherwise). */
  private turnJudge: TurnEndJudge | null = null;

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
    if (this.overHer) return; // what the user says over her keeps being collected; listening over her ends with the clip
    this.segmenter.reset(); this.vadSpeech.reset(); this.vadLead.clear();
    if (speaking) this.bargeIn.reset();
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

  /** I-190: another camera was chosen while 「发图片」 holds one here: the same switch, a fresh stream from the chosen camera. */
  switchCamera(): void { if (!this.cameraWanted || this.disposed || !this.cameraStream) return; const revision = ++this.cameraRevision; this.stopCamera(); void this.startCamera(revision); }

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
        // I-099: in a call the chunk is first heard by the VAD, in order; a chunk it cannot answer goes by loudness.
        const vad = this.call ? this.options.callVad : undefined;
        if (vad && (vad.ready || this.vadBacklog > 0)) { this.viaVad(vad, samples, sampleRate, revision, binding); return; }
        this.route(samples, sampleRate, revision, binding, null, performance.now());
  }

  /** I-099: ask the call's VAD about this chunk (behind the chunks before it), then route it with the answer. */
  private viaVad(vad: NonNullable<MediaInputOptions['callVad']>, samples: Float32Array, sampleRate: number, revision: number, binding: VoiceCaptureBinding): void {
    const at = performance.now(), call = this.call;
    this.vadBacklog++;
    this.vadQueue = this.vadQueue.then(() => vad.probe(samples, sampleRate)).catch(() => null).then(probs => {
      this.vadBacklog--;
      if (this.call !== call || this.voiceBinding !== binding || !this.active('voiceInput', revision)) return;
      this.route(samples, sampleRate, revision, binding, probs, at);
    }).catch(() => { /* one chunk lost; the next is heard as usual */ });
  }

  /** One chunk after the VAD (probs) or without it (null): talking over her, paused for her voice, T, or listening. */
  private route(samples: Float32Array, sampleRate: number, revision: number, binding: VoiceCaptureBinding, probs: readonly number[] | null, at: number): void {
        const heard = probs && this.call ? this.vadSpeech.push(probs, this.segmenter.active) : null;
        const speech = heard && heard.share !== null && this.call ? heard.share >= this.call.vad.bargeInShare : undefined;
        if (this.speaking && this.call && !this.overHer && this.bargeIn.push(samples, sampleRate, this.gate.threshold, speech)) {
          if (this.options.overHerHeld?.() === true) this.bargeIn.reset(); else { this.vadSpeech.reset(); this.interrupt(sampleRate, revision, binding); return; } }
        if (this.overHer && this.call) { this.listen(samples, sampleRate, revision, binding, heard, at); this.overHerDone(); return; }
        if (this.speaking || performance.now() < this.resumeAt) { this.vadSpeech.reset(); this.vadLead.clear(); this.stats.paused(samples.length / sampleRate); this.segmenter.reset(); this.reportVoice(this.call && this.speaking ? 'voice.capture.callReading' : 'voice.capture.reading'); return; }
        if (this.options.pushToTalk && !this.call) { this.heldPcm(samples, sampleRate, revision, binding); return; }
        this.listen(samples, sampleRate, revision, binding, heard, at);
  }

  /**
   * Continuous listening (a call, or the older mode without the T key): pause detection decides the end of an utterance.
   * I-099: with the call's VAD verdict (`heard`), "speech" is the VAD's (while her "嗯" plays it must also reach the raised
   * gate); without it, loudness against the gate as before.
   */
  private listen(samples: Float32Array, sampleRate: number, revision: number, binding: VoiceCaptureBinding, heard: VadHeard | null = null, at = performance.now()): void {
        let energy = 0;
        for (const sample of samples) energy += sample * sample;
        const level = Math.sqrt(energy / samples.length);
        const raised = !!this.call && (this.echoGuard || !!this.overHer); // her "嗯" or her reading is in the room: the echo gate
        const threshold = raised ? this.bargeIn.gate(this.gate.threshold) : this.gate.threshold;
        const voiced = heard ? heard.speech && (!raised || level >= threshold) : level >= threshold;
        if (!this.overHer) this.gate.observe(level, this.segmenter.active || this.speechDetected); else if (voiced) this.overHer.heard = true;
        if (this.silence.feed(level, samples.length / sampleRate)) this.noteUnheard('no-sound');
        if (voiced) {
          this.speechGeneration++;
          clearTimeout(this.endpointTimer); this.endpointTimer = undefined;
          if (!this.speechDetected) {
            this.speechDetected = true;
            void window.desktop.signalVoiceCapture(binding.captureSessionId, 'speech-start')
              .then(ok => { if (!ok) this.fail(Error(t('voice.capture.stopped')), 'voiceInput', revision); })
              .catch(error => this.fail(error, 'voiceInput', revision));
          }
        }
        this.reportVoice(voiced ? 'voice.capture.detected' : level >= threshold / 2 ? 'voice.capture.quiet' : 'voice.capture.listening');
        if (heard && voiced && heard.started && !this.segmenter.active) this.segmenter.lead(this.vadLead.take()); // I-099: the first syllable too
        const judge = heard ? this.turnJudge : null; // I-099/I-100: with the VAD in a call, the turn model also hears each pause
        if (!heard) this.turnJudge?.reset();
        judge?.chunk(voiced, this.segmenter.active, samples.length / sampleRate * 1000);
        const utterance = this.segmenter.push(samples, sampleRate, threshold, this.call ? (judge ? judge.silenceMs(this.call.endpointSilenceMs) : this.call.endpointSilenceMs) / 1000 : undefined, heard ? voiced : undefined);
        if (heard && !this.segmenter.active && !utterance) this.vadLead.keep(samples, sampleRate, this.call?.vad.prerollMs ?? 0); else this.vadLead.clear();
        if (this.call) this.callHeard(voiced, sampleRate, !!utterance, heard ? at - heard.tailMs : at, !!heard, utterance ? judge?.takeBy() : undefined, judge?.offReason ?? undefined);
        this.cutUtterance(utterance, sampleRate, revision, binding);
  }

  /** An utterance was cut (by the silence rule or by the turn model), or what was collected was too little: hand it to recognition, tell the host. */
  private cutUtterance(utterance: Float32Array | null, sampleRate: number, revision: number, binding: VoiceCaptureBinding): void {
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
          }, this.call ? 0 : 1500); // I-091: in a call the end is decided by the shorter silence alone
        }
  }

  /** I-099/I-100: the user's current turn at 16 kHz for the turn model: its newest seconds, the quiet at its end trimmed to tailMs. */
  private turnAudio(): Float32Array | null {
    const call = this.call, rate = this.voiceSampleRate;
    const raw = call ? this.segmenter.tail(rate, TURN_AUDIO_SECONDS, call.turn.tailMs) : null;
    return raw ? toTurnAudio(raw, rate) : null;
  }

  /** I-099/I-100: the turn model says the user has finished: cut the utterance now, as if the silence had run out. */
  private endTurnNow(): void {
    const binding = this.voiceBinding, revision = this.voiceRevision, rate = this.voiceSampleRate;
    if (!this.call || !binding || !this.active('voiceInput', revision) || !this.segmenter.active || (this.speaking && !this.overHer)) return;
    const by = this.turnJudge?.takeBy();
    const utterance = this.segmenter.flush(rate);
    this.callHeard(false, rate, !!utterance, performance.now(), true, by, this.turnJudge?.offReason ?? undefined);
    this.cutUtterance(utterance, rate, revision, binding);
  }

  private idleVoiceKey(): VoiceUiKey { return this.options.pushToTalk && !this.call ? 'voice.capture.holdT' : 'voice.capture.listening'; }

  /** Hold to talk: voice input is on here and its capture is open (T does something). */
  get canHoldToTalk(): boolean { return this.options.pushToTalk === true && !this.call && !!this.voiceBinding && this.active('voiceInput', this.voiceRevision); }

  /** I-091: a call is on in this window (its knobs) or not (null). Switching drops what was half collected. */
  setCall(knobs: VoiceCallKnobs | null): void {
    this.bargeIn.use(knobs?.bargeIn); // I-177 batch 2: headphones lower the gate
    if ((knobs === null) === (this.call === null)) { this.call = knobs; return; }
    const binding = this.voiceBinding;
    this.call = knobs; this.talk = null; this.echoGuard = false; this.overHer = null; this.callPaused = true;
    clearTimeout(this.endpointTimer); this.endpointTimer = undefined; this.speechGeneration++;
    this.segmenter.reset(); this.bargeIn.reset(); this.vadSpeech.reset(); this.vadLead.clear();
    if (knobs) this.options.callVad?.start(); else this.options.callVad?.stop(); // I-099: a fresh VAD stream per call
    this.turnJudge?.reset(); this.turnJudge = null; // I-099/I-100: and a fresh turn judge
    if (knobs && this.options.callTurn) { this.options.callTurn.start(); this.turnJudge = new TurnEndJudge(this.options.callTurn, knobs.turn, { audio: () => this.turnAudio(), endNow: () => this.endTurnNow() }); } else this.options.callTurn?.stop();
    if (this.speechDetected && binding) { this.speechDetected = false; void window.desktop.signalVoiceCapture(binding.captureSessionId, 'endpoint').catch(() => {}); }
    this.speechDetected = false;
    if (binding && this.active('voiceInput', this.voiceRevision)) this.reportVoice(this.microphoneIsReady ? this.idleVoiceKey() : 'voice.capture.waiting');
  }
  get inCall(): boolean { return this.call !== null; }
  /** I-091: her short "嗯" is playing (true) or ended (false). */
  setEchoGuard(on: boolean): void { this.echoGuard = on; }

  /**
   * I-091: the user may be talking over her reading. Sound alone no
   * longer stops her. The microphone listens over her (through the echo gate) until this clip is cut; the host stops her only when its
   * words are a clear sentence or a stop command (electron/voice/utterance-gate.ts). The words already said are kept.
   */
  private interrupt(sampleRate: number, revision: number, binding: VoiceCaptureBinding): void {
    const preroll = this.bargeIn.takePreroll();
    this.overHer = { since: performance.now(), heard: false }; this.segmenter.reset(); this.vadLead.clear();
    try { this.options.onCallEvent?.({ type: 'barge-in' }); } catch { /* the window's own stop */ }
    if (this.voiceBinding !== binding || !this.active('voiceInput', revision)) return;
    for (const chunk of preroll) this.listen(chunk, sampleRate, revision, binding);
  }

  /** Listening over her ends when its clip was cut (or nothing voiced came): while she still speaks the microphone pauses again. */
  private overHerDone(): void {
    const over = this.overHer;
    if (!over || this.segmenter.active || this.speechDetected || (!over.heard && performance.now() - over.since < OVER_HER_IDLE_MS)) return;
    this.overHer = null;
    try { this.options.onCallEvent?.({ type: 'over-her-end', clip: over.heard }); } catch { /* the duck only */ } // I-177 batch 2: nothing heard → her voice comes back now
    if (this.speaking) { this.segmenter.reset(); this.vadSpeech.reset(); this.vadLead.clear(); this.bargeIn.reset(); this.resumeAt = Infinity; } else this.resumeAt = 0;
  }

  /** I-091: per chunk in a call: voiced → 'voiced'; the first quiet chunk after enough speech → 'pause'; the cut → 'endpoint'. */
  private callHeard(voiced: boolean, sampleRate: number, cut: boolean, at = performance.now(), vad = false, by?: TurnEndBy, smartTurnOff?: 'guard'): void {
    const now = performance.now(), emit = (event: CallInputEvent) => { try { this.options.onCallEvent?.(event); } catch { /* timing and sound only */ } };
    if (voiced) { this.callVoicedAt = at; this.callPaused = false; emit({ type: 'voiced', at, vad }); }
    else if (!this.callPaused && this.call && this.segmenter.active
      && this.segmenter.voicedSeconds(sampleRate) * 1000 >= this.call.filler.minVoicedMs) {
      this.callPaused = true; emit({ type: 'pause', quietMs: Math.max(0, now - this.callVoicedAt) });
    }
    if (cut) { this.callPaused = true; emit({ type: 'endpoint', ...(by ? { by } : {}), ...(smartTurnOff ? { smartTurnOff } : {}) }); }
  }

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
          if (this.call) try { this.options.onCallEvent?.({ type: 'handed-in' }); } catch { /* timing only */ }
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
      const stream = await openCamera({ width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 } });
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
