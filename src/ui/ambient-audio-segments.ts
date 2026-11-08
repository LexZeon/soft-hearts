import { encodeWav, resamplePcm, SPEAKING_MAX_MS } from './MediaInput';

export type AmbientAudioPurpose = 'music' | 'movie';

export interface AmbientEncodedSegment {
  /** Opaque host-issued session identity. It is never a file or URL. */
  sessionKey: string;
  sequence: number;
  mode: AmbientAudioPurpose;
  startOffsetMs: number;
  endOffsetMs: number;
  /** Local monotonic timestamps, useful only inside this renderer. */
  startedAtMs: number;
  endedAtMs: number;
  wav: ArrayBuffer;
}

export interface AmbientSegmentLimits {
  maxSeconds: number;
  minSoundSeconds: number;
  silenceSeconds: number;
  retainedSilenceSeconds: number;
  rmsThreshold: number;
  ttsTailMs: number;
}

export const DEFAULT_AMBIENT_SEGMENT_LIMITS: Readonly<AmbientSegmentLimits> = Object.freeze({
  maxSeconds: 12,
  minSoundSeconds: 0.35,
  silenceSeconds: 0.55,
  retainedSilenceSeconds: 0.15,
  rmsThreshold: 0.008,
  ttsTailMs: 500,
});

interface PcmSegment { samples: Float32Array; startedAtMs: number; endedAtMs: number }

function limits(value: Partial<AmbientSegmentLimits>): AmbientSegmentLimits {
  const result = { ...DEFAULT_AMBIENT_SEGMENT_LIMITS, ...value };
  const finite = (number: number, min: number, max: number) => Number.isFinite(number) && number >= min && number <= max;
  if (!finite(result.maxSeconds, 1, 15) || !finite(result.minSoundSeconds, 0.1, result.maxSeconds)
    || !finite(result.silenceSeconds, 0.1, 2) || !finite(result.retainedSilenceSeconds, 0, result.silenceSeconds)
    || !finite(result.rmsThreshold, 0.001, 0.1) || !finite(result.ttsTailMs, 200, 2000))
    throw new Error('系统声音分段参数不正确。');
  return result;
}

/** Energy segmentation, not a claim that instrumental sound is human speech. */
class AmbientPcmSegments {
  private chunks: Float32Array[] = [];
  private length = 0;
  private soundLength = 0;
  private silenceLength = 0;
  private startedAtMs = 0;
  constructor(private readonly config: AmbientSegmentLimits) {}

  reset(): void { this.chunks = []; this.length = this.soundLength = this.silenceLength = 0; }
  get bufferedSamples(): number { return this.length; }

  push(pcm: Float32Array, frameEndMs: number): PcmSegment[] {
    const output: PcmSegment[] = [];
    const max = Math.floor(this.config.maxSeconds * 16000);
    let offset = 0;
    while (offset < pcm.length) {
      const count = Math.min(pcm.length - offset, max - this.length);
      const part = pcm.subarray(offset, offset + count);
      let energy = 0;
      for (const value of part) energy += value * value;
      const sound = part.length > 0 && Math.sqrt(energy / part.length) >= this.config.rmsThreshold;
      const partStarted = frameEndMs - (pcm.length - offset) / 16;
      offset += count;
      if (!sound && !this.length) continue;
      if (!this.length) this.startedAtMs = partStarted;
      this.chunks.push(part.slice()); this.length += count;
      if (sound) { this.soundLength += count; this.silenceLength = 0; }
      else this.silenceLength += count;
      if (this.length < max && this.silenceLength < this.config.silenceSeconds * 16000) continue;
      if (this.soundLength >= this.config.minSoundSeconds * 16000) {
        const keep = Math.min(max, this.length - Math.max(0, this.silenceLength - Math.floor(this.config.retainedSilenceSeconds * 16000)));
        const samples = new Float32Array(keep);
        let written = 0;
        for (const chunk of this.chunks) {
          const amount = Math.min(chunk.length, keep - written);
          if (amount <= 0) break;
          samples.set(chunk.subarray(0, amount), written); written += amount;
        }
        output.push({ samples, startedAtMs: this.startedAtMs, endedAtMs: this.startedAtMs + keep / 16 });
      }
      this.reset();
    }
    return output;
  }
}

export interface AmbientAudioSegmentOptions<Result> {
  onSegment(segment: AmbientEncodedSegment, signal: AbortSignal): Promise<Result>;
  /** The only completion callback; cancelled/old-session results never reach it. */
  onAccepted?(result: Result, segment: AmbientEncodedSegment): void;
  onStatus?(text: string): void;
  onError?(message: string): void;
  onGap?(gap: { startOffsetMs: number; endOffsetMs: number; reason: 'backpressure' }): void;
  now?: () => number;
  limits?: Partial<AmbientSegmentLimits>;
}

interface QueuedSegment { revision: number; segment: AmbientEncodedSegment }
interface PendingSegment extends QueuedSegment { controller: AbortController }

/**
 * A PCM tap for the already-owned system stream. It never acquires a device,
 * records a file, chooses an ASR language, or sends audio by itself.
 * One request and one waiting WAV are the complete bounded request queue.
 */
export class AmbientAudioSegments<Result = unknown> {
  private readonly config: AmbientSegmentLimits;
  private readonly pcm: AmbientPcmSegments;
  private readonly now: () => number;
  private revision = 0;
  private session: { key: string; mode: AmbientAudioPurpose; startedAtMs: number } | null = null;
  private sequence = 0;
  private queued: QueuedSegment | null = null;
  private pending: PendingSegment | null = null;
  private speaking = false;
  private resumeAtMs = -Infinity;
  private speakingSinceMs = 0;
  private lastFrameEndMs = -Infinity;
  private sampleRate: number | null = null;
  private disposed = false;
  private status = '';

  constructor(private readonly options: AmbientAudioSegmentOptions<Result>) {
    this.config = limits(options.limits ?? {});
    this.pcm = new AmbientPcmSegments(this.config);
    this.now = options.now ?? (() => performance.now());
  }

  get active(): boolean { return this.session !== null && !this.disposed; }
  get state(): Readonly<{ active: boolean; inFlight: boolean; queued: boolean; bufferedSamples: number; pausedForTts: boolean }> {
    this.expireSpeaking();
    return { active: this.active, inFlight: this.pending !== null, queued: this.queued !== null,
      bufferedSamples: this.pcm.bufferedSamples, pausedForTts: this.speaking || this.now() < this.resumeAtMs };
  }

  start(sessionKey: string, mode: AmbientAudioPurpose, startedAtMs = this.now()): void {
    if (this.disposed) return;
    if (!sessionKey || sessionKey.length > 160 || /[\u0000-\u001f]/u.test(sessionKey)
      || (mode !== 'music' && mode !== 'movie') || !Number.isFinite(startedAtMs))
      throw new Error('系统声音会话不正确。');
    this.invalidate();
    this.session = { key: sessionKey, mode, startedAtMs };
    this.sequence = 0;
    this.reportStatus(this.speaking ? '朗读期间暂停理解系统声音' : '等待系统声音片段');
  }

  /** Caller must invoke this for hide, teardown, capture loss, and scope changes. */
  stop(): void {
    this.session = null;
    this.invalidate();
    this.reportStatus('');
  }

  dispose(): void { this.stop(); this.disposed = true; }

  /** "She is speaking" that nobody renewed for SPEAKING_MAX_MS is over (2026-11-06: a reading that never said "stopped" must not mute this for good). */
  private expireSpeaking(): void {
    const now = this.now();
    if (this.speaking && now - this.speakingSinceMs > SPEAKING_MAX_MS) { this.speaking = false; this.resumeAtMs = now; }
  }

  setSpeaking(active: boolean, atMs = this.now()): void {
    if (active && Number.isFinite(atMs)) this.speakingSinceMs = atMs;
    if (active === this.speaking || !Number.isFinite(atMs)) return;
    this.speaking = active;
    this.invalidate();
    this.resumeAtMs = active ? Infinity : atMs + this.config.ttsTailMs;
    if (this.active) this.reportStatus(active ? '朗读期间暂停理解系统声音' : '等待朗读尾音结束');
  }

  /** frameEndMs uses the same monotonic clock as start(); offsets are not wall time. */
  push(input: Float32Array, sourceRate: number, frameEndMs = this.now()): void {
    const session = this.session;
    if (!session || this.disposed) return;
    this.expireSpeaking();
    if (this.speaking || frameEndMs < this.resumeAtMs) { this.pcm.reset(); return; }
    if (!Number.isFinite(sourceRate) || sourceRate < 8000 || sourceRate > 192000
      || !Number.isFinite(frameEndMs) || frameEndMs <= this.lastFrameEndMs
      || input.length === 0 || input.length > sourceRate * 2) {
      this.pcm.reset(); this.reportStatus('已忽略无效的系统声音片段'); return;
    }
    const frameDurationMs = input.length / sourceRate * 1000;
    if (Number.isFinite(this.lastFrameEndMs) && frameEndMs - this.lastFrameEndMs > frameDurationMs + 250) {
      this.pcm.reset(); this.reportStatus('系统声音片段中断，已重新分段');
    }
    this.lastFrameEndMs = frameEndMs;
    if (this.sampleRate !== null && this.sampleRate !== sourceRate) this.pcm.reset();
    this.sampleRate = sourceRate;
    const clean = new Float32Array(input.length);
    for (let index = 0; index < input.length; index++) clean[index] = Number.isFinite(input[index]) ? Math.max(-1, Math.min(1, input[index])) : 0;
    let samples = resamplePcm(clean, sourceRate);
    // The first resumed block can straddle consent or the TTS-tail boundary.
    // Trim those samples, rather than merely changing the packet timestamp.
    const allowed = Math.floor((frameEndMs - Math.max(session.startedAtMs, this.resumeAtMs)) * 16);
    if (allowed <= 0) { this.pcm.reset(); return; }
    if (samples.length > allowed) samples = samples.subarray(samples.length - allowed);
    for (const result of this.pcm.push(samples, frameEndMs)) {
      // A packet cannot predate the explicit session consent.
      const startOffsetMs = Math.max(0, result.startedAtMs - session.startedAtMs);
      const endOffsetMs = Math.max(startOffsetMs, result.endedAtMs - session.startedAtMs);
      const segment: AmbientEncodedSegment = { sessionKey: session.key, sequence: ++this.sequence, mode: session.mode,
        startOffsetMs, endOffsetMs, startedAtMs: result.startedAtMs, endedAtMs: result.endedAtMs, wav: encodeWav(result.samples) };
      this.enqueue({ revision: this.revision, segment });
    }
  }

  private invalidate(): void {
    this.revision++;
    this.queued = null;
    this.pcm.reset(); this.sampleRate = null; this.lastFrameEndMs = -Infinity;
    // Keep the pending slot occupied until settlement, even if abort is ignored.
    this.pending?.controller.abort();
  }

  private current(value: QueuedSegment): boolean {
    return this.active && value.revision === this.revision && value.segment.sessionKey === this.session?.key;
  }

  private enqueue(value: QueuedSegment): void {
    if (!this.current(value)) return;
    if (!this.pending) { this.dispatch(value); return; }
    if (!this.queued) { this.queued = value; this.reportStatus('正在转写，下一片段已暂存'); return; }
    this.reportStatus('转写速度不足，已略过后续片段；请检查连接');
    this.options.onGap?.({ startOffsetMs: value.segment.startOffsetMs, endOffsetMs: value.segment.endOffsetMs, reason: 'backpressure' });
  }

  private dispatch(value: QueuedSegment): void {
    if (!this.current(value) || this.pending) return;
    const pending: PendingSegment = { ...value, controller: new AbortController() };
    this.pending = pending;
    this.reportStatus('正在理解系统声音…');
    void Promise.resolve().then(() => {
      if (!this.current(pending) || pending.controller.signal.aborted) return undefined;
      return this.options.onSegment(pending.segment, pending.controller.signal);
    }).then(result => {
      if (this.current(pending) && !pending.controller.signal.aborted && result !== undefined)
        this.options.onAccepted?.(result, pending.segment);
    }).catch(() => {
      if (this.current(pending) && !pending.controller.signal.aborted)
        this.options.onError?.('系统声音转写未完成，请检查转写连接。');
    }).finally(() => {
      if (this.pending !== pending) return;
      this.pending = null;
      const next = this.queued; this.queued = null;
      if (next && this.current(next)) this.dispatch(next);
      else if (this.active && !this.speaking && this.now() >= this.resumeAtMs) this.reportStatus('等待系统声音片段');
    });
  }

  private reportStatus(text: string): void {
    if (text === this.status) return;
    this.status = text; this.options.onStatus?.(text);
  }
}
