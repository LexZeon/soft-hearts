import type { AppSettings } from "../../shared/contracts";
import type { SpeechRequestContext, TtsConfig } from "../../shared/tts";
import { StreamingVoicePlayer, type EmotionalVoicePlaybackState, type VoicePlaybackEvent, type VoicePlaybackMark } from "./EmotionalVoice";
import { SharedAudioOutput } from "./audio-output";
import { SpeechOutput, type SpeechOutputHooks, type SystemSpeechEvent, type SystemVoiceConfig } from "./speech";
import { SpeechDiagnostics, type SpeechTimeline } from "./speech-diagnostics";
import type { SpeechDiagnosticRecord } from "../../shared/speech-diagnostics";
import { NEUTRAL_SPEECH_TONE, systemVoiceScale, type SpeechTone, type SystemVoiceScale } from "../../shared/speech-mood-tone";
import { speakableText } from "../../shared/speakable-text";

/** The shared contract is extended by the host wiring owner. */
type SegmentSpeechRequestContext = SpeechRequestContext & { segmentIndex?: number };
export type VoiceOutputEvent = VoicePlaybackEvent & { cancelled?: boolean };
/** Lifecycle facts only; PCM scheduling is not proof of physical audibility. */
export type VoiceOutputPlaybackState = EmotionalVoicePlaybackState & {
  provider?: TtsConfig["provider"];
  generation?: number;
  playbackId?: string;
  replyId?: string;
  segmentIndex?: number;
};
export interface VoiceOutputApi {
  synthesizeSpeech(id: string, text: string, context?: SegmentSpeechRequestContext): Promise<void>;
  cancelSpeech(id: string): Promise<void>;
  /** Natural playback drain; optional for existing adapters. */
  releaseSpeech?(id: string): Promise<void>;
  /** Both hooks are required together for host-owned preplayback coverage. */
  beginSpeechPlaybackActivity?(playbackId: string): Promise<string | null>;
  endSpeechPlaybackActivity?(playbackId: string, lease: string): Promise<void>;
  onSpeechEvent(callback: (event: VoiceOutputEvent) => void): () => void;
  /** R02 dev diagnostics: one finished timing record (no text); the host writes it only in developer mode. */
  recordSpeechDiagnostic?(record: SpeechDiagnosticRecord): Promise<void>;
}
interface SystemVoice {
  voices(): SpeechSynthesisVoice[];
  speak(text: string, config: SystemVoiceConfig): void | Promise<void>;
  stop(): void;
  dispose?(): void;
  /** B06 feed pause; optional for small adapters. `release`: give the engine up (a system-voice cue needs it). */
  pause?(release?: boolean): void;
  resume?(): void;
}
interface StreamVoice {
  readonly finished: Promise<void>;
  begin(id: string, volume?: number, origin?: number): Promise<void>;
  accept(event: VoicePlaybackEvent, tag?: number): Promise<void>;
  stop(): void;
  dispose(): void;
  pause?(): void;
  resume?(): void;
}
interface StreamCallbacks {
  onSpeaking(active: boolean): void;
  onState(state: EmotionalVoicePlaybackState): void;
  onError(message: string): void;
  /** The owner's warm output; a custom player may ignore it. */
  output?: SharedAudioOutput;
  onMark?(mark: VoicePlaybackMark): void;
}
export interface VoiceOutputOptions {
  getTtsConfig(): TtsConfig;
  getVoiceConfig(): AppSettings["voice"];
  api: VoiceOutputApi;
  onSpeaking(active: boolean): void;
  onState?(state: VoiceOutputPlaybackState): void;
  onError(message: string): void;
  /** Small adapters allow lifecycle tests without a browser or audio device. */
  createSystem?(onSpeaking: (active: boolean) => void, hooks?: SpeechOutputHooks): SystemVoice;
  createPlayer?(callbacks: StreamCallbacks): StreamVoice;
  createId?(): string;
  /** Shared cloud audio output; VoiceOutput owns (and disposes) one when absent. */
  audio?: SharedAudioOutput;
  now?(): number;
  /** F7 developer listening trial: the silence before a later system-voice sentence (tests pass their own clock). */
  wait?(ms: number): Promise<void>;
}

interface PlaybackSession {
  generation: number;
  /** Speech request start on the `now()` clock; the origin of measured playback times. */
  startedAt: number;
  provider: TtsConfig["provider"];
  identity: string;
  preview: boolean;
  context?: SegmentSpeechRequestContext;
  playbackId: string;
  activityLease: string | null;
  activityEnd: ((playbackId: string, lease: string) => Promise<void>) | null;
  activityRelease: Promise<void> | null;
  player: StreamVoice | null;
  segments: string[];
  segment: number;
  requestId: string | null;
  request: Promise<void>;
  requestHasAudio: boolean;
  queue: Promise<void>;
  networkDone: boolean;
  finishing: boolean;
  totalBytes: number;
  firstAudioMs?: number;
  systemInitializing: boolean;
  systemStarted: boolean;
  systemHasCompletion: boolean;
  systemEnded: boolean;
  /** R02 per-stage timing: one timeline per reply segment (reply sessions) or one for the whole playback. */
  timelines: SpeechTimeline[];
  /** Bailian voice ID or system voiceURI, for diagnostics only. */
  voiceId: string;
  /** Set by stop(): the owner interrupted this playback (not a natural end or a failure). */
  stopped?: boolean;
  /** System voice: called once when the engine reports the utterance started. */
  onStarted?(): void;
  resolve(): void;
  reject(error: Error): void;
  finished: Promise<void>;
  /** Present for a reply-level cloud playback whose approved segments arrive one by one. */
  reply?: ReplyState;
  /** B06: a cloud request that came due during a feed pause; it is sent on resume. */
  requestDeferred?: boolean;
  /**
   * Reply segments whose audio all played out before their synthesis said "done": when it
   * was the segment's last audio, that drain is its end (X-088). Cleared by later audio.
   */
  drainedEarly?: Map<number, number>;
}

interface ReplyGate { resolve(live: boolean): void; reject(error: Error): void; network: boolean; heard: boolean; settled: boolean }
interface ReplyState {
  voice: AppSettings["voice"];
  contexts: SegmentSpeechRequestContext[];
  opened: boolean;
  closed: boolean;
  /** Every appended segment has finished its synthesis and more may follow. */
  waiting: boolean;
  gates: ReplyGate[];
  /** finishCurrent(): the segment being heard then; playback ends when it ends. */
  cutAt?: number;
}

/** A whole reply on one continuous cloud player (R02). */
export interface ReplyPlayback {
  /**
   * Queue one host-approved segment. Resolves when the next segment may be
   * prepared: this one's synthesis has finished and it has started playing.
   * That bounds paid pre-synthesis to at most one segment ahead of the audio.
   * Resolves false when the playback was stopped first (cancel, voice or
   * provider change): the caller must not ask for more segments.
   */
  append(text: string, context: SegmentSpeechRequestContext, tone?: SpeechTone, pauseBeforeMs?: number): Promise<boolean>;
  /** No more segments. Resolves after every queued sample has played. */
  close(): Promise<void>;
  /** Stop this reply only if it is still the current playback. */
  cancel(): void;
  /**
   * The user turned the microphone on mid-reading: the segment being heard
   * plays to its end and nothing after it; with nothing audible yet it stops now. Appends then resolve false.
   */
  finishCurrent(): void;
}

function safeEnd(text: string, end: number): number {
  const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
  return end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

/** Product limits: at most 6,000 UTF-16 units, sent in sentence-aware 2,000-unit requests. */
export function splitSpeechText(text: string): string[] {
  const trimmed = text.trim();
  let remaining = trimmed.slice(0, safeEnd(trimmed, 6000));
  const segments: string[] = [];
  while (remaining.length) {
    let end = safeEnd(remaining, Math.min(remaining.length, 2000));
    if (end < remaining.length) {
      for (const match of remaining.slice(0, end).matchAll(/[。！？!?；;.\n]["'”’）)\]】」』]*[ \t]*/g)) {
        const boundary = match.index + match[0].length;
        if (boundary >= 1000) end = boundary;
      }
    }
    const part = remaining.slice(0, end);
    if (part.trim()) segments.push(part);
    remaining = remaining.slice(end);
  }
  return segments;
}

function identity(config: TtsConfig): string {
  return config.provider === "system" ? "system" : JSON.stringify([
    config.provider, config.apiHost, config.region, config.model, config.voice,
    config.instruction, config.emotion, config.rate,
  ]);
}

/** One output owner: system speech or a continuous cloud PCM player with narrow host requests. */
export class VoiceOutput {
  private readonly system: SystemVoice;
  private readonly unsubscribe: () => void;
  private generation = 0;
  private active: PlaybackSession | null = null;
  private disposed = false;
  /** B06 feed pause in effect (owner-level: it also holds playbacks started during it). */
  private held = false;
  private readonly audio: SharedAudioOutput;
  private readonly ownsAudio: boolean;
  private readonly diagnostics: SpeechDiagnostics;

  constructor(private readonly options: VoiceOutputOptions) {
    this.diagnostics = new SpeechDiagnostics({ now: () => this.now(), sink: record => options.api.recordSpeechDiagnostic?.(record) });
    // R02: lip-sync for system speech follows the engine's progress, not only its start event.
    const hooks: SpeechOutputHooks = { onMouth: active => this.systemMouth(active), onEvent: event => this.systemEvent(event) };
    this.system = options.createSystem?.(value => this.systemSpeaking(value), hooks) ?? new SpeechOutput(value => this.systemSpeaking(value), hooks);
    this.unsubscribe = options.api.onSpeechEvent(event => this.receive(event));
    this.ownsAudio = !options.audio;
    this.audio = options.audio ?? new SharedAudioOutput({ now: options.now });
  }

  voices(): SpeechSynthesisVoice[] { return this.system.voices(); }

  /**
   * Called when a chat is sent: starts the cloud audio device ahead of speech
   * (no request, no sound) and marks the send for send→first-audio timing.
   */
  prewarm(): void {
    if (this.disposed) return;
    this.diagnostics.noteSend();
    try { if (this.options.getTtsConfig().provider === "bailian") this.audio.prewarm(); } catch { /* Config errors surface on speak. */ }
  }

  speak(text: string, config: AppSettings["voice"], context?: SegmentSpeechRequestContext): Promise<void> {
    const completion = this.start(text, config, false, context);
    void completion.catch(() => {});
    return completion;
  }

  preview(text: string, context?: SegmentSpeechRequestContext): Promise<void> {
    return this.start(text, { ...this.options.getVoiceConfig(), enabled: true }, true, context);
  }

  async previewCharacter(text: string, prepare: () => Promise<SegmentSpeechRequestContext>): Promise<void> {
    return this.start(text, { ...this.options.getVoiceConfig(), enabled: true }, true, undefined, prepare);
  }

  /**
   * One playback owner for a whole reply (R02). Bailian: one continuous player
   * and device, no gap from waiting for segment N to end before requesting N+1,
   * no cancellation between segments. System voice: see openSystemReply.
   */
  openReply(voice: AppSettings["voice"], replyId: string): ReplyPlayback | null {
    if (this.disposed || !voice.enabled) return null;
    let config: TtsConfig;
    try { config = this.options.getTtsConfig(); } catch { return null; }
    if (config.provider === "system") return this.openSystemReply({ ...voice });
    if (config.provider !== "bailian") return null;
    this.stop();
    let resolve!: () => void, reject!: (error: Error) => void;
    const finished = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void finished.catch(() => {});
    const session: PlaybackSession = {
      generation: ++this.generation, startedAt: this.now(), provider: config.provider, identity: identity(config), preview: false,
      context: Object.freeze({ replyId }), playbackId: this.id(), activityLease: null, activityEnd: null, activityRelease: null,
      player: null, segments: [], segment: 0, requestId: null, request: Promise.resolve(), requestHasAudio: false,
      queue: Promise.resolve(), networkDone: false, finishing: false, totalBytes: 0, systemInitializing: false,
      systemStarted: false, systemHasCompletion: false, systemEnded: false, finished, resolve, reject,
      timelines: [], voiceId: config.voice,
      reply: { voice: { ...voice }, contexts: [], opened: false, closed: false, waiting: false, gates: [] },
    };
    this.active = session;
    this.audio.prewarm();
    return {
      append: (text, context) => this.appendReply(session, text, context),
      close: () => { this.closeReply(session); return session.finished; },
      cancel: () => { if (this.current(session)) this.stop(); },
      finishCurrent: () => this.finishReply(session),
    };
  }

  /** Bailian reply: keep the segment being heard, drop everything after it (see ReplyPlayback.finishCurrent). */
  private finishReply(session: PlaybackSession): void {
    const reply = session.reply!;
    if (!this.current(session) || reply.cutAt !== undefined) return;
    // The segment being heard: the newest one that became audible and has not ended.
    let heard = -1;
    session.timelines.forEach((timeline, index) => { if (timeline.time("playbackStart") !== undefined && !timeline.closed) heard = index; });
    if (heard < 0) { this.stop(); return; } // nothing audible (or the sentence just ended): stop now
    reply.cutAt = heard; reply.closed = true;
    session.segments.length = Math.min(session.segments.length, heard + 1);
    for (const gate of reply.gates.slice(heard + 1)) if (!gate.settled) { gate.settled = true; gate.resolve(false); }
    if (session.segment > heard) {
      // Its synthesis is complete: a request for a later segment is dropped and the stream ends after it.
      const requestId = session.requestId; session.requestId = null;
      if (requestId) this.cancel(requestId);
      reply.waiting = false;
      if (!session.networkDone) session.queue = session.queue.then(() => this.endNetwork(session)).catch(error => this.fail(session, error));
    }
    // Otherwise its "done" ends the stream through the ordinary path (no segment follows it any more).
  }

  /**
   * System voice for a reply (R02): one utterance per segment, strictly one
   * after another and never cancelled in between (cancel-then-speak can leave
   * Chromium "speaking" with no sound). The next segment may be prepared as
   * soon as the current one has started, so it is ready the moment it ends.
   */
  private openSystemReply(voice: AppSettings["voice"]): ReplyPlayback {
    let closed = false, stopped = false, finishing = false, tail: Promise<void> = Promise.resolve();
    let current: PlaybackSession | null = null;
    // R02: the reply's mood nudge on rate/pitch, frozen with its first segment (no per-sentence wobble).
    let scale: SystemVoiceScale | null = null, spoken: SystemVoiceConfig = voice;
    return {
      append: (text, context, tone, pauseBeforeMs) => {
        if (closed || stopped || finishing || this.disposed) return Promise.resolve(false);
        // F7 developer listening trial only (0 by default): a short silence before a later sentence of a slow reply.
        const gap = typeof pauseBeforeMs === 'number' && Number.isFinite(pauseBeforeMs) ? Math.min(1_000, Math.max(0, pauseBeforeMs)) : 0;
        if (!scale) {
          scale = systemVoiceScale(tone ?? NEUTRAL_SPEECH_TONE, voice.moodInfluence);
          spoken = { ...voice, rate: Math.max(0.1, Math.min(10, voice.rate * scale.rate)), ...(scale.pitch === 1 ? {} : { pitch: scale.pitch }) };
        }
        const frozen = scale;
        return new Promise<boolean>((resolve, reject) => {
          tail = tail.then(async () => {
            if (stopped || finishing || this.disposed) { resolve(false); return; }
            if (gap > 0) { await (this.options.wait ?? (ms => new Promise<void>(done => setTimeout(done, ms))))(gap); if (stopped || finishing || this.disposed) { resolve(false); return; } }
            const launched = this.launch(text, spoken, false, context, undefined, () => resolve(true), frozen);
            current = launched.session;
            try { await launched.finished; } catch (error) { stopped = true; reject(error); return; }
            // Interrupted from outside (another playback, voice off, provider change): ask for nothing more.
            if (launched.session?.stopped) { stopped = true; resolve(false); } else resolve(true);
          });
        });
      },
      close: () => { closed = true; return tail; },
      cancel: () => { stopped = true; if (current && this.current(current)) this.stop(); },
      // The utterance being spoken ends by itself; queued sentences are never launched.
      finishCurrent: () => { finishing = true; },
    };
  }

  private appendReply(session: PlaybackSession, text: string, context: SegmentSpeechRequestContext): Promise<boolean> {
    const reply = session.reply!;
    if (!this.current(session) || reply.closed) return Promise.resolve(false);
    // A segment that is only a stage direction ("（把脸埋低）") is shown and skipped by the voice (shared/speakable-text.ts).
    if (!text.trim() || !speakableText(text)) return Promise.resolve(true);
    let gate!: ReplyGate;
    const ready = new Promise<boolean>((resolve, reject) => { gate = { resolve, reject, network: false, heard: false, settled: false }; });
    void ready.catch(() => {});
    session.segments.push(text.trim());
    session.timelines.push(this.diagnostics.open({ provider: "bailian", voice: session.voiceId, kind: "reply",
      segmentIndex: context.segmentIndex ?? null, textLength: text.trim().length, replyId: context.replyId }));
    reply.contexts.push(Object.freeze({ replyId: context.replyId,
      ...(context.segmentIndex === undefined ? {} : { segmentIndex: context.segmentIndex }) }));
    reply.gates.push(gate);
    if (!reply.opened) {
      // The first approved segment opens the host activity lease and the player.
      reply.opened = true;
      void this.open(session, reply.voice).catch(error => this.fail(session, error));
    } else if (reply.waiting) { reply.waiting = false; this.request(session); }
    return ready;
  }

  private closeReply(session: PlaybackSession): void {
    const reply = session.reply!;
    if (!this.current(session) || reply.closed) return;
    reply.closed = true;
    if (!reply.opened) { this.active = null; this.generation++; session.resolve(); return; }
    if (!reply.waiting) return;
    reply.waiting = false;
    session.queue = session.queue.then(() => this.endNetwork(session)).catch(error => this.fail(session, error));
  }

  private async endNetwork(session: PlaybackSession): Promise<void> {
    if (!this.continue(session)) return;
    session.networkDone = true;
    await session.player!.accept({ id: session.playbackId, type: "done", firstAudioMs: session.firstAudioMs ?? 0, audioBytes: session.totalBytes });
  }

  /** Release the next append once segment `index` has both finished synthesis and become audible. */
  private gate(session: PlaybackSession, index: number, fact: "network" | "heard"): void {
    const gate = session.reply?.gates[index];
    if (!gate || gate.settled || !this.current(session)) return;
    gate[fact] = true;
    if (gate.network && gate.heard) { gate.settled = true; gate.resolve(true); }
  }

  /** `live` is true only for a natural end; a stop tells the caller to ask for nothing more. */
  private settleGates(session: PlaybackSession, live: boolean, error?: Error): void {
    for (const gate of session.reply?.gates ?? []) {
      if (gate.settled) continue;
      gate.settled = true;
      if (error) gate.reject(error); else gate.resolve(live);
    }
  }

  stop(): void {
    if (this.disposed) return;
    const session = this.active;
    this.active = null;
    this.generation++;
    const requestId = session?.requestId;
    if (session) { session.requestId = null; session.stopped = true; }
    this.system.stop();
    session?.player?.dispose();
    if (session) void this.releaseActivity(session).catch(() => {});
    session?.resolve();
    if (session) this.settleGates(session, false);
    if (requestId) this.cancel(requestId);
    this.mouth(session, false);
    if (session) this.closeTimelines(session, "cancelled");
    if (session) this.publish(session, { phase: "idle", message: "已停止" });
  }

  /**
   * B06: a snack at her mouth pauses speech; resume()
   * continues from the same place. Bailian: the player fades out and holds its
   * scheduled PCM and no further request goes out. System voice: see
   * SpeechOutput.pause. A playback started during the pause waits silently.
   * Cancellation is unchanged: stop() (new message, stop, context change)
   * still ends the playback and nothing of it can come back on resume().
   */
  pause(release = false): void {
    if (this.disposed || this.held) return;
    this.held = true;
    const session = this.active;
    if (session) this.playingTimeline(session)?.feedPause(this.now());
    this.system.pause?.(release);
    session?.player?.pause?.();
  }

  resume(): void {
    if (this.disposed || !this.held) return;
    this.held = false;
    const session = this.active;
    if (session) for (const timeline of session.timelines) timeline.feedResume(this.now());
    this.system.resume?.();
    session?.player?.resume?.();
    if (session?.requestDeferred) { session.requestDeferred = false; this.request(session); }
  }

  get paused(): boolean { return this.held; }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.unsubscribe();
    this.system.dispose?.();
    if (this.ownsAudio) this.audio.dispose();
  }

  private start(text: string, voice: AppSettings["voice"], preview: boolean, context?: SegmentSpeechRequestContext,
    prepare?: () => Promise<SegmentSpeechRequestContext>): Promise<void> {
    return this.launch(text, voice, preview, context, prepare).finished;
  }

  private launch(text: string, voice: SystemVoiceConfig, preview: boolean, context?: SegmentSpeechRequestContext,
    prepare?: () => Promise<SegmentSpeechRequestContext>, onStarted?: () => void, scale?: SystemVoiceScale): { session: PlaybackSession | null; finished: Promise<void> } {
    const none = { session: null, finished: Promise.resolve() };
    if (this.disposed) return none;
    // Nothing to read but stage directions: nothing starts (and nothing already playing is cut off for it).
    if (!speakableText(text)) return none;
    this.stop();
    const segments = splitSpeechText(text);
    if (!voice.enabled || !segments.length) return none;
    let config: TtsConfig;
    try { config = this.options.getTtsConfig(); }
    catch (error) {
      const failure = this.error(error);
      this.options.onState?.({ phase: "error", message: failure.message });
      this.options.onError(failure.message);
      return { session: null, finished: Promise.reject(failure) };
    }
    let resolve!: () => void, reject!: (error: Error) => void;
    const finished = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    // Automatic speech has no caller awaiting it; preview still observes the original promise.
    void finished.catch(() => {});
    const session: PlaybackSession = {
      generation: ++this.generation, startedAt: this.now(), provider: config.provider, identity: identity(config), preview,
      ...(context ? { context: Object.freeze({ replyId: context.replyId,
        ...(context.segmentIndex === undefined ? {} : { segmentIndex: context.segmentIndex }) }) } : {}),
      playbackId: this.id(), activityLease: null, activityEnd: null, activityRelease: null,
      player: null, segments, segment: 0, requestId: null,
      request: Promise.resolve(), requestHasAudio: false, queue: Promise.resolve(),
      networkDone: false, finishing: false, totalBytes: 0, systemInitializing: false, systemStarted: false,
      systemHasCompletion: false, systemEnded: false,
      finished, resolve, reject, ...(onStarted ? { onStarted } : {}),
      timelines: [], voiceId: config.provider === "system" ? voice.voiceURI || "default" : config.voice,
    };
    session.timelines.push(this.diagnostics.open({ provider: config.provider, voice: session.voiceId,
      kind: preview ? "preview" : context?.replyId ? "reply" : "speech", segmentIndex: context?.segmentIndex ?? null,
      textLength: segments.join("").length, ...(context?.replyId ? { replyId: context.replyId } : {}), at: session.startedAt }));
    this.active = session;
    if (scale && session.timelines[0]) { session.timelines[0].rateScale = scale.rate; session.timelines[0].pitchScale = scale.pitch; }
    if (this.held) session.timelines[0]?.feedPause(session.startedAt);
    // The device start is the slow, unbounded step on some machines: begin it now,
    // in parallel with the host lease and preview preparation below.
    if (config.provider === "bailian") this.audio.prewarm();
    void this.open(session, voice, prepare).catch(error => this.fail(session, error));
    return { session, finished };
  }

  private async open(session: PlaybackSession, voice: SystemVoiceConfig,
    prepare?: () => Promise<SegmentSpeechRequestContext>): Promise<void> {
    const api = this.options.api;
    const begin = api.beginSpeechPlaybackActivity, end = api.endSpeechPlaybackActivity;
    if (begin !== undefined || end !== undefined) {
      if (typeof begin !== 'function' || typeof end !== 'function') throw new Error('语音播放活动接口尚未就绪。');
      session.activityEnd = (id, lease) => end.call(api, id, lease);
      this.publish(session, { phase: 'loading' });
      session.timelines[0]?.mark('leaseStart', this.now());
      const lease = await begin.call(api, session.playbackId);
      session.timelines[0]?.mark('leaseEnd', this.now());
      if (typeof lease !== 'string' || lease.length === 0) throw new Error('语音播放活动未获授权。');
      session.activityLease = lease;
      if (!this.current(session)) { await this.releaseActivity(session); return; }
    }
    // With neither hook the legacy dispatch path stays synchronous up to its
    // original first await; it is not production fatigue-activity coverage.
    if (!this.continue(session)) return;
    if (prepare) {
      session.timelines[0]?.mark('prepareStart', this.now());
      const context = await prepare();
      session.timelines[0]?.mark('prepareEnd', this.now());
      if (!this.continue(session)) return;
      session.context = Object.freeze({ replyId: context.replyId,
        ...(context.segmentIndex === undefined ? {} : { segmentIndex: context.segmentIndex }) });
    }
    if (!this.continue(session)) return;
    if (session.provider === 'system') this.systemSpeech(session, voice);
    else await this.cloud(session, voice.volume);
  }

  private systemSpeech(session: PlaybackSession, voice: SystemVoiceConfig): void {
      session.systemInitializing = true;
      this.publish(session, { phase: "loading" });
      try {
        const completion = this.system.speak(session.segments.join(""), { ...voice });
        // Some engines complete without a start event (for example a rejected
        // browser speech queue). A void-only adapter still relies on events.
        if (completion && typeof completion.then === "function") {
          session.systemHasCompletion = true;
          void completion.then(() => {
            if (!this.current(session)) return;
            this.mouth(session, false);
            this.publish(session, { phase: "idle" });
            this.finish(session);
          }, error => this.fail(session, error));
        }
      }
      catch (error) { this.fail(session, error); }
      finally {
        session.systemInitializing = false;
        if (this.current(session) && !session.systemHasCompletion && session.systemEnded) this.systemSpeaking(false);
      }
  }

  private async cloud(session: PlaybackSession, volume: number): Promise<void> {
    const callbacks: StreamCallbacks = {
      onSpeaking: active => { if (this.current(session)) this.mouth(session, active); },
      onState: state => {
        if (!this.current(session)) return;
        if (state.phase === "error") this.fail(session, new Error(state.message || "语音播放失败。"));
        else this.publish(session, state);
      },
      onError: message => this.fail(session, new Error(message)),
    };
    const streamCallbacks: StreamCallbacks = { ...callbacks, output: this.audio, onMark: mark => this.playerMark(session, mark) };
    const player = session.player = this.options.createPlayer?.(streamCallbacks) ?? new StreamingVoicePlayer(streamCallbacks);
    // R02: synthesis is dispatched while the output device starts, not after it.
    // Early PCM waits inside the player and is scheduled once the device runs.
    const ready = player.begin(session.playbackId, volume, session.startedAt);
    void ready.catch(() => {});
    if (this.held) player.pause?.();
    void player.finished.then(() => {
      if (!this.current(session)) return;
      if (session.networkDone) this.finish(session);
      else this.fail(session, new Error("语音播放提前结束，请重试。"));
    }, error => this.fail(session, error));
    this.request(session);
    await ready;
  }

  private request(session: PlaybackSession): void {
    if (!this.continue(session)) return;
    // B06: no paid synthesis while she is eating; resume() sends it.
    if (this.held) { session.requestDeferred = true; return; }
    const requestId = session.requestId = this.id();
    session.requestHasAudio = false;
    // A reply session speaks each approved segment under its own host identity.
    if (session.reply) session.context = session.reply.contexts[session.segment];
    const context = session.context;
    session.request = Promise.resolve().then(() => {
      if (!this.continue(session) || session.requestId !== requestId) return;
      this.timeline(session)?.mark("request", this.now());
      return this.options.api.synthesizeSpeech(requestId, session.segments[session.segment], context);
    }).catch(error => {
      if (this.current(session) && session.requestId === requestId) this.fail(session, error);
    });
  }

  private receive(event: VoiceOutputEvent): void {
    const session = this.active;
    if (!session || session.finishing || session.provider !== "bailian" || event.id !== session.requestId || !this.continue(session)) return;
    // Arrival in the renderer, before any queued processing (IPC send is not arrival).
    const timeline = this.timeline(session);
    if (event.type === "audio") timeline?.mark("firstPacket", this.now());
    if (event.type !== "error" && timeline && timeline.hostFirstAudioMs === null && Number.isFinite(event.firstAudioMs)) timeline.hostFirstAudioMs = event.firstAudioMs!;
    // The host stopped this exact request: stop now, not behind PCM still waiting for the device in the queue below
    // (Codex X-321: that PCM was scheduled when the device ran, then stopped; a cancelled reading must never start).
    if (event.type === "error" && event.cancelled) { session.requestId = null; this.stop(); return; }
    session.queue = session.queue.then(async () => {
      if (!this.continue(session) || event.id !== session.requestId) return;
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "audio") {
        if (event.data) session.requestHasAudio = true;
        if (session.segment === 0) session.firstAudioMs ??= event.firstAudioMs;
        const { firstAudioMs: _firstAudioMs, ...audio } = event;
        // More audio after an early drain: that drain was an underrun, not the segment's end.
        if (event.data) session.drainedEarly?.delete(session.segment);
        await session.player!.accept({ ...audio, id: session.playbackId,
          ...(session.segment === 0 && session.firstAudioMs !== undefined ? { firstAudioMs: session.firstAudioMs } : {}) },
        session.reply ? session.segment : 0);
        return;
      }
      if (!session.requestHasAudio || event.audioBytes <= 0) throw new Error("语音服务没有返回可播放音频。");
      session.totalBytes += event.audioBytes;
      if (session.segment === 0) session.firstAudioMs ??= event.firstAudioMs;
      // The host may acknowledge at dispatch or after stream teardown. Wait before reusing its owner slot.
      await session.request;
      if (!this.continue(session) || event.id !== session.requestId) return;
      if (session.reply) {
        // Both facts are in: everything this segment had already played out, so it ended at that drain.
        const drainedAt = session.drainedEarly?.get(session.segment);
        const timeline = session.timelines[session.segment];
        if (drainedAt !== undefined && timeline) {
          session.drainedEarly!.delete(session.segment);
          timeline.stalls = Math.max(0, timeline.stalls - 1);
          this.diagnostics.close(timeline, "ended", drainedAt);
        }
        this.gate(session, session.segment, "network");
        // finishCurrent(): the kept sentence had already played out before its synthesis said "done".
        if (drainedAt !== undefined && session.reply.cutAt === session.segment) { this.stop(); return; }
      }
      session.segment++;
      if (session.segment < session.segments.length) { this.request(session); return; }
      // A reply waits (playing what it has) until the host approves its next segment.
      if (session.reply && !session.reply.closed) { session.reply.waiting = true; return; }
      await this.endNetwork(session);
    }).catch(error => this.fail(session, error));
  }

  private systemSpeaking(active: boolean): void {
    const session = this.active;
    if (!session || session.provider !== "system" || !this.continue(session)) return;
    if (!active && session.systemInitializing && !session.systemStarted) return;
    // SpeechOutput reports false for errors as well as natural ends. Its
    // promise carries that distinction; do not resolve before its rejection
    // reaches the owner, or the stale-session guard would swallow the error.
    if (!active && (session.systemInitializing || session.systemHasCompletion)) {
      session.systemEnded = true;
      return;
    }
    if (active && !session.systemStarted) { session.systemStarted = true; session.onStarted?.(); }
    this.mouth(session, active);
    this.publish(session, { phase: active ? "playing" : "idle" });
    if (!active) this.finish(session);
  }

  /** Lip-sync only (stall / resume of a started system utterance); never ends the playback. */
  private systemMouth(active: boolean): void {
    const session = this.active;
    if (!session || session.provider !== "system" || !this.current(session) || !session.systemStarted || session.finishing) return;
    this.mouth(session, active);
  }

  /** Engine facts for the current system utterance's timeline (timestamps and codes only). */
  private systemEvent(event: SystemSpeechEvent): void {
    const session = this.active;
    const timeline = session && session.provider === "system" && this.current(session) ? session.timelines[0] : undefined;
    if (!timeline) return;
    if (event.type === "queued") timeline.mark("request", event.at);
    else if (event.type === "start") timeline.mark("playbackStart", event.at);
    else if (event.type === "first-boundary") timeline.mark("firstBoundary", event.at);
    else if (event.type === "end") timeline.mark("ended", event.at);
    else if (event.type === "quick-end") timeline.quickEnd = true;
    else if (event.type === "stall") timeline.stalls++;
    else if (event.type === "pause-fallback") timeline.pauseFallbacks++;
    else if (event.type === "error") timeline.errorCode = event.code;
  }

  /** Player facts on the renderer clock; also opens the reply's next-segment gate. */
  private playerMark(session: PlaybackSession, mark: VoicePlaybackMark): void {
    if (!this.current(session)) return;
    const at = session.startedAt + mark.atMs;
    if (mark.kind === "device") {
      const first = session.timelines[0];
      first?.mark("deviceStart", at - (mark.waitMs ?? 0)); first?.mark("deviceEnd", at);
      if (first) first.deviceColdStartMs = this.audio.lastStartMs ?? null;
      return;
    }
    const timeline = this.timeline(session, mark.tag);
    if (mark.kind === "scheduled") {
      if (timeline && timeline.time("scheduled") === undefined) {
        timeline.mark("scheduled", at);
        timeline.startLeadMs = mark.leadMs ?? null;
        timeline.baseLatencyMs = mark.baseLatencyMs ?? null;
        timeline.outputLatencyMs = mark.outputLatencyMs ?? null;
        timeline.clockLagMs = mark.clockLagMs ?? null;
      }
      return;
    }
    if (mark.kind === "audible") timeline?.mark("playbackStart", at);
    else {
      // Drained: the end of this segment, or an underrun before its synthesis finished.
      const synthesized = session.reply ? !!session.reply.gates[mark.tag]?.network : session.networkDone;
      if (!synthesized) {
        if (timeline) timeline.stalls++;
        // Possibly the segment's real end; decided when its "done" arrives (or more audio does).
        if (session.reply) (session.drainedEarly ??= new Map()).set(mark.tag, at);
      }
      else if (session.reply) this.diagnostics.close(timeline, "ended", at);
    }
    if (session.reply) this.gate(session, mark.tag, "heard");
    // finishCurrent(): the kept sentence has played out; audio of a later one already scheduled is never heard.
    if (mark.kind === "drained" && session.reply?.cutAt === mark.tag && session.reply.gates[mark.tag]?.network) this.stop();
  }

  private timeline(session: PlaybackSession, index = session.segment): SpeechTimeline | undefined {
    return session.reply ? session.timelines[index] : session.timelines[0];
  }

  /** The segment being heard (a reply may already be synthesizing the next one). */
  private playingTimeline(session: PlaybackSession): SpeechTimeline | undefined {
    return session.reply
      ? [...session.timelines].reverse().find(item => !item.closed && item.time("playbackStart") !== undefined) ?? this.timeline(session)
      : session.timelines[0];
  }

  private closeTimelines(session: PlaybackSession, outcome: SpeechDiagnosticRecord["outcome"]): void {
    for (const timeline of session.timelines) this.diagnostics.close(timeline, outcome);
  }

  /** Lip-sync output; the open/close is also recorded on the segment that is playing. */
  private mouth(session: PlaybackSession | null, active: boolean): void {
    this.options.onSpeaking(active);
    if (!session) return;
    const timeline = session.reply
      ? [...session.timelines].reverse().find(item => !item.closed && item.time("playbackStart") !== undefined)
      : session.timelines[0];
    timeline?.mark(active ? "lipSyncStart" : "lipSyncStop", this.now());
  }

  private current(session: PlaybackSession): boolean {
    return !this.disposed && this.active === session && session.generation === this.generation;
  }

  private continue(session: PlaybackSession): boolean {
    if (!this.current(session)) return false;
    try {
      if (identity(this.options.getTtsConfig()) !== session.identity || (!session.preview && !this.options.getVoiceConfig().enabled)) {
        this.stop();
        return false;
      }
    } catch (error) { this.fail(session, error); return false; }
    return true;
  }

  private async finish(session: PlaybackSession): Promise<void> {
    if (!this.current(session) || session.finishing) return;
    session.finishing = true;
    // Playback itself has ended; releasing the host routes below is not part of it.
    this.closeTimelines(session, "ended");
    const requestId = session.requestId;
    try {
      session.player?.dispose();
      // Only actual final playback end reaches this point. Release transport
      // routing without cancelling the frozen style needed by later segments.
      if (requestId) {
        if (this.options.api.releaseSpeech) await this.options.api.releaseSpeech(requestId);
        else await this.options.api.cancelSpeech(requestId);
      }
      await this.releaseActivity(session);
      if (!this.current(session)) return;
      this.active = null; this.generation++; session.requestId = null;
      this.settleGates(session, true);
      session.resolve();
    } catch (error) { this.fail(session, error); }
  }

  private fail(session: PlaybackSession, error: unknown): void {
    if (!this.current(session)) return;
    const failure = this.error(error), requestId = session.requestId;
    this.active = null; this.generation++; session.requestId = null;
    this.system.stop(); session.player?.dispose();
    void this.releaseActivity(session).catch(() => {});
    if (requestId) this.cancel(requestId);
    session.reject(failure);
    this.settleGates(session, false, failure);
    this.mouth(session, false);
    this.closeTimelines(session, "error");
    this.publish(session, { phase: "error", message: failure.message });
    this.options.onError(failure.message);
  }

  private publish(session: PlaybackSession, state: EmotionalVoicePlaybackState): void {
    const stages = session.timelines[0]?.summary();
    this.options.onState?.({ ...state, provider: session.provider, generation: session.generation,
      playbackId: session.playbackId, ...(session.context ? { ...session.context } : {}),
      ...(stages && Object.keys(stages).length ? { stages } : {}) });
  }

  /** One exact opaque lease; no ID-only release or retry can affect a new owner. */
  private releaseActivity(session: PlaybackSession): Promise<void> {
    if (session.activityRelease) return session.activityRelease;
    const lease = session.activityLease, end = session.activityEnd;
    if (lease === null || end === null) return Promise.resolve();
    session.activityLease = null;
    session.activityRelease = Promise.resolve().then(() => end(session.playbackId, lease));
    return session.activityRelease;
  }

  private cancel(id: string): void { void Promise.resolve().then(() => this.options.api.cancelSpeech(id)).catch(() => {}); }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  private id(): string { return this.options.createId?.() ?? crypto.randomUUID(); }
  private error(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }
}
