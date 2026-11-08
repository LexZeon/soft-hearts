import type { AppSettings } from '../../shared/contracts';
import { CUE_TEXT, FEED_CUE_KINDS, FEED_CUE_MAX_BYTES, FEED_SOUND_IDS, type CueKind, type FeedCueClip } from '../../shared/feed-cue';
import type { TtsConfig } from '../../shared/tts';
import { SharedAudioOutput, defaultAudioTimers, type AudioOutputTimers } from './audio-output';
import type { FeedCuePort, FeedCueStarted } from './feed-speech-pause';

export interface FeedCueApi { synthesizeFeedCue?(kind: CueKind): Promise<FeedCueClip | null> }
export interface FeedCuePlayerOptions {
  api: FeedCueApi;
  getTtsConfig(): TtsConfig;
  getVoiceConfig(): AppSettings['voice'];
  /** Cue output; the player owns (and disposes) one when absent. */
  audio?: SharedAudioOutput;
  timers?: AudioOutputTimers;
  now?(): number;
  /**
   * The kinds this player fetches once feeding starts (prepare) or a missing clip was asked for (default: every feeding sound,
   * #32). X1's waiting hum is its own player with ['think'].
   */
  kinds?: readonly CueKind[];
  /**
   * The kinds fetched ahead by FeedCuePrefetch (prefetch(), while a reply plays aloud): default the two original feeding sounds
   * ("啊～""嗯～") for the feeding player, or `kinds` when given. #32's other sounds are fetched only once she is being fed.
   */
  prefetchKinds?: readonly CueKind[];
}

/** Chromium can drop an utterance spoken in the same task as cancel(). */
const SETTLE_MS = 80;
/** Clips kept per player (#32: ten feeding sounds per voice, a voice switch or two). */
const MAX_CLIPS = 24;
/** At most this many cue requests at once per player (#32 asks for up to ten when feeding starts; the rest wait their turn). */
const MAX_FETCHING = 2;
/** After a failed fetch the same voice is not asked again for this long (the host also limits this). */
const RETRY_MS = 60_000;
/** A cue never holds anything longer than this, even if the engine never reports its end. */
const MAX_CUE_MS = 3000;
/** System cues are a touch brighter than the reply voice. */
const SYSTEM_CUE_PITCH = 1.12;

/**
 * B06 feeding cues in her current voice. Bailian: a short clip synthesized by
 * the host once per voice and kept here as samples, played on its own Web
 * Audio source (never through the reply player, which stays paused). System
 * voice: a short utterance on the free engine, which the paused reply has
 * released (see FeedSpeechPause `release`). A cue that cannot start in time is
 * skipped, never played late. Switching voice/character/model makes cached
 * clips of the old voice unreachable, and pending fetches for it are dropped.
 * X1: the waiting hum uses a second instance (kinds ['think']): its own clip
 * cache and playback token, so it never stops, delays or evicts a feeding cue.
 * #32: the feeding player knows ten sounds (shared/feed-cue.ts FEED_SOUND_IDS). The two original ones are fetched ahead
 * (prefetch); the rest once she is being fed (prepare), two requests at a time, each once per voice. Which one plays is
 * decided elsewhere (src/ui/feed-cue-choice.ts, from the host's pick); `ready()` tells it whether a clip is here yet.
 */
export class FeedCuePlayer implements FeedCuePort {
  private readonly clips = new Map<string, Float32Array>();
  private readonly fetching = new Set<string>();
  private readonly waiting: { identity: string; kind: CueKind }[] = [];
  private readonly failedAt = new Map<string, number>();
  private readonly audio: SharedAudioOutput;
  private readonly ownsAudio: boolean;
  private token = 0;
  private current: { stop(): void } | null = null;
  private disposed = false;
  constructor(private readonly options: FeedCuePlayerOptions) {
    this.ownsAudio = !options.audio;
    this.audio = options.audio ?? new SharedAudioOutput({ now: options.now, timers: options.timers });
  }

  sharesEngine(): boolean { return this.config()?.provider === 'system'; }

  /** Feeding started (or a clip was missing): warm the device and fetch this player's kinds for the current voice. `first` jumps the queue. */
  prepare(first?: CueKind): void {
    const config = this.cueConfig();
    if (!config) return;
    this.audio.prewarm();
    const identity = this.identity(config);
    if (first) this.fetch(identity, first, true);
    for (const kind of this.options.kinds ?? FEED_SOUND_IDS) this.fetch(identity, kind);
  }

  /**
   * Fetch the prefetch clips for the current voice without touching the audio device
   * (FeedCuePrefetch, while a reply is playing): the two original feeding sounds. Only with read-aloud on and the
   * Bailian voice; the clip cache and failure back-off decide whether a request is made.
   */
  prefetch(): void {
    const config = this.cueConfig();
    if (!config) return;
    const identity = this.identity(config);
    for (const kind of this.options.prefetchKinds ?? this.options.kinds ?? FEED_CUE_KINDS) this.fetch(identity, kind);
  }

  /** #32: `kind` can start now: the system voice can always say it; Bailian only once its clip for the current voice is here. */
  ready(kind: CueKind): boolean {
    const config = this.config();
    if (this.disposed || !config || !this.voice().enabled) return false;
    if (config.provider === 'system') return true;
    return config.provider === 'bailian' && this.clips.has(this.identity(config) + kind);
  }

  async play(kind: CueKind, deadlineMs: number): Promise<FeedCueStarted | null> {
    this.stop();
    const token = ++this.token, startedAt = this.now();
    const config = this.config(), voice = this.voice();
    if (this.disposed || !config || !voice.enabled) return null;
    if (config.provider === 'bailian') {
      const samples = this.clips.get(this.identity(config) + kind);
      if (!samples) { this.prepare(kind); return null; } // not ready: skip now, ready next time (this one first)
      return this.playClip(samples, voice.volume, token, startedAt, deadlineMs);
    }
    if (config.provider === 'system') return this.speak(kind, voice, token, startedAt, deadlineMs);
    return null;
  }

  stop(): void {
    this.token++;
    const current = this.current; this.current = null;
    current?.stop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop(); this.disposed = true;
    if (this.ownsAudio) this.audio.dispose();
  }

  private async playClip(samples: Float32Array, volume: number, token: number, startedAt: number, deadlineMs: number): Promise<FeedCueStarted | null> {
    const lease = await this.within(this.audio.acquire().catch(() => null), deadlineMs - (this.now() - startedAt));
    if (!lease) return null;
    if (token !== this.token || this.now() - startedAt > deadlineMs) { lease.release(); return null; }
    const context = lease.context;
    let source: AudioBufferSourceNode, gain: GainNode;
    try {
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.getChannelData(0).set(samples);
      gain = context.createGain(); gain.gain.value = Math.max(0, Math.min(1, volume)); gain.connect(context.destination);
      source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
    } catch { lease.release(); return null; }
    let finish!: () => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    let done = false;
    const end = () => {
      if (done) return; done = true;
      try { source.disconnect(); gain.disconnect(); } catch { /* Already detached. */ }
      lease.release(); finish();
      if (this.current === handle) this.current = null;
    };
    const handle = { stop: () => { try { source.stop(); } catch { /* Not started. */ } end(); } };
    source.onended = end;
    source.start(context.currentTime + 0.01);
    this.current = handle;
    // A device that never reports the end cannot hold the reply.
    const guard = this.timers.set(end, Math.ceil(samples.length / 24) + 500);
    void ended.then(() => this.timers.clear(guard));
    return { ended };
  }

  private async speak(kind: CueKind, voice: AppSettings['voice'], token: number, startedAt: number, deadlineMs: number): Promise<FeedCueStarted | null> {
    // The paused reply has just cancel()ed its utterance (in this or the other window), and
    // Chromium can drop an utterance spoken right after cancel(): always leave the settle gap.
    await new Promise<void>(resolve => this.timers.set(resolve, SETTLE_MS));
    if (token !== this.token) return null;
    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(CUE_TEXT[kind]);
      const voices = speechSynthesis.getVoices();
      utterance.voice = voices.find(item => item.voiceURI === voice.voiceURI) ?? voices.find(item => item.lang.startsWith('zh')) ?? null;
      utterance.lang = utterance.voice?.lang ?? 'zh-CN';
      utterance.rate = voice.rate; utterance.pitch = SYSTEM_CUE_PITCH; utterance.volume = voice.volume;
    } catch { return null; }
    let finish!: () => void, begin!: (started: boolean) => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<boolean>(resolve => { begin = resolve; });
    let state: 'queued' | 'speaking' | 'done' = 'queued';
    const end = () => { if (state === 'done') return; state = 'done'; begin(false); finish(); if (this.current === handle) this.current = null; };
    const handle = { stop: () => {
      if (state === 'done') return;
      // Only our own cue is still with the engine: the paused reply released it.
      try { speechSynthesis.cancel(); } catch { /* Best effort. */ }
      end();
    } };
    utterance.onstart = () => { if (state === 'queued') { state = 'speaking'; begin(true); } };
    utterance.onend = end;
    utterance.onerror = end;
    this.current = handle;
    try { speechSynthesis.speak(utterance); } catch { end(); return null; }
    const timer = this.timers.set(() => begin(false), Math.max(0, deadlineMs - (this.now() - startedAt)));
    const ok = await started;
    this.timers.clear(timer);
    if (!ok || token !== this.token) { if (this.current === handle) handle.stop(); return null; }
    const guard = this.timers.set(() => handle.stop(), MAX_CUE_MS);
    void ended.then(() => this.timers.clear(guard));
    return { ended };
  }

  /** Queue `kind` for `identity` (deduplicated; `first` puts it at the front); at most MAX_FETCHING requests run at once. */
  private fetch(identity: string, kind: CueKind, first = false): void {
    const key = identity + kind, failed = this.failedAt.get(key);
    if (this.clips.has(key) || this.fetching.has(key) || (failed !== undefined && this.now() - failed < RETRY_MS)) return;
    if (typeof this.options.api.synthesizeFeedCue !== 'function') return;
    const queued = this.waiting.findIndex(item => item.identity === identity && item.kind === kind);
    if (queued >= 0 && first) this.waiting.unshift(...this.waiting.splice(queued, 1));
    else if (queued < 0) { if (first) this.waiting.unshift({ identity, kind }); else this.waiting.push({ identity, kind }); }
    this.pump();
  }

  private pump(): void {
    const request = this.options.api.synthesizeFeedCue;
    while (this.fetching.size < MAX_FETCHING && this.waiting.length && typeof request === 'function') {
      const { identity, kind } = this.waiting.shift()!;
      const key = identity + kind, config = this.config();
      // A queued kind for a voice that is no longer current is dropped (the new voice queues its own).
      if (this.disposed || !config || this.identity(config) !== identity || this.clips.has(key) || this.fetching.has(key)) continue;
      this.fetching.add(key);
      void Promise.resolve().then(() => request.call(this.options.api, kind)).then(clip => {
        const config = this.config();
        // A clip for a voice that is no longer current is dropped, never played.
        if (this.disposed || !config || this.identity(config) !== identity) return;
        const samples = clip && decodeCue(clip);
        if (!samples) { this.failedAt.set(key, this.now()); return; }
        this.clips.set(key, samples);
        while (this.clips.size > MAX_CLIPS) this.clips.delete(this.clips.keys().next().value!);
      }, () => { this.failedAt.set(key, this.now()); }).finally(() => { this.fetching.delete(key); this.pump(); });
    }
  }

  private within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
    if (ms <= 0) { void promise.then(value => (value as { release?: () => void } | null)?.release?.()); return Promise.resolve(null); }
    return new Promise<T | null>(resolve => {
      let settled = false;
      const timer = this.timers.set(() => { if (!settled) { settled = true; resolve(null); } }, ms);
      void promise.then(value => {
        if (settled) { (value as { release?: () => void } | null)?.release?.(); return; }
        settled = true; this.timers.clear(timer); resolve(value);
      });
    });
  }

  private identity(config: TtsConfig): string {
    return JSON.stringify([config.provider, config.apiHost, config.region, config.model, config.voice, config.rate]) + '\u0000';
  }
  private config(): TtsConfig | null { try { return this.options.getTtsConfig(); } catch { return null; } }
  /** The Bailian config cues may be fetched for: read-aloud on, not disposed. */
  private cueConfig(): TtsConfig | null {
    const config = this.config();
    return !this.disposed && config && this.voice().enabled && config.provider === 'bailian' ? config : null;
  }
  private voice(): AppSettings['voice'] { return this.options.getVoiceConfig(); }
  private get timers(): AudioOutputTimers { return this.options.timers ?? defaultAudioTimers; }
  private now(): number { return this.options.now?.() ?? performance.now(); }
}

/** Strict decode of a host clip: PCM16 mono, bounded, nonempty. */
export function decodeCue(clip: FeedCueClip): Float32Array | null {
  if (!clip || typeof clip.pcm !== 'string' || clip.pcm.length % 4 !== 0 || clip.pcm.length > Math.ceil(FEED_CUE_MAX_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(clip.pcm)) return null;
  let raw: string;
  try { raw = atob(clip.pcm); } catch { return null; }
  const frames = Math.floor(raw.length / 2);
  if (!frames || raw.length > FEED_CUE_MAX_BYTES) return null;
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index++) {
    const value = raw.charCodeAt(index * 2) | (raw.charCodeAt(index * 2 + 1) << 8);
    samples[index] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
  }
  return samples;
}
