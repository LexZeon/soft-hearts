import {t} from '../shared/ui-language';
import { createHash } from 'node:crypto';
import {
  audioReadingSources, audioReadingPurposes, createAudioReadingView, parseAudioReadingIntent, parseAudioReadingView,
  type AudioReadingSource, type AudioReadingPurpose, type AudioReadingView, type AudioReadingAck,
  type AudioReadingPhase,
} from '../shared/audio-reading-toggles';

export const AUDIO_READING_BROKER_LIMITS = Object.freeze({ pcmBytes: 384_000, pendingPerSource: 2, retainedPerSource: 3, textCharacters: 4000 });
export type AudioReadingTally = 'received' | 'skipped-paused' | 'with-text' | 'empty' | 'failed';
export interface AudioReadingCaptureToken { scopeId: string; source: AudioReadingSource; epoch: number; captureId: string }
/** The adapter releases only this ambient reference, never another consumer's tracks. */
export interface AudioReadingCaptureLease { captureId: string; /** Idempotent, including a retry after uncertain rejection. */ release(): Promise<void> }
export interface AudioReadingSegmentIdentity extends AudioReadingCaptureToken {
  segmentId: string; sequence: number; startedAtMs: number; endedAtMs: number;
}
export interface AudioReadingAsrInput extends AudioReadingSegmentIdentity { wav: ArrayBuffer }
export interface AudioReadingPublication extends AudioReadingSegmentIdentity {
  origin: 'ambient'; text: string; purposes: readonly AudioReadingPurpose[];
  signal: AbortSignal;
  /** Recheck after every downstream await, including before a comment. */
  currentPurposes(): readonly AudioReadingPurpose[];
  /** Release this bounded completion only after downstream work is finished. */
  finish(): void;
}
export interface AudioReadingPublicationTicket {
  readonly segmentId: string;
  readonly signal: AbortSignal;
  /** Single publication point: late closes are removed, off/on never reclaims old data. */
  take(): AudioReadingPublication | null;
  discard(): void;
}
export interface AudioReadingBrokerPorts {
  acquire(input: { scopeId: string; source: AudioReadingSource; epoch: number; signal: AbortSignal }): Promise<AudioReadingCaptureLease>;
  transcribe(input: AudioReadingAsrInput, signal: AbortSignal): Promise<{ text: string }>;
  /** Only an ambient completion queue. No user/chat/steer or reward route. */
  publicationReady(ticket: AudioReadingPublicationTicket): undefined;
  viewChanged?(view: AudioReadingView): undefined;
  /** Counts only: what became of each clip of the played sound; the host sums them per minute for the journal. */
  tally?(kind: AudioReadingTally): void;
}
type Epoch = { scopeId: string; number: number; controller: AbortController };
type Job = {
  identity: AudioReadingSegmentIdentity; epoch: Epoch; generations: Partial<Record<AudioReadingPurpose, number>>;
  controller: AbortController; wav?: ArrayBuffer; text?: string; taken: boolean; finished: boolean;
};
type Slot = {
  epoch?: Epoch; counter: number; versions: Record<AudioReadingPurpose, number>; canAcquire: boolean;
  lease?: AudioReadingCaptureLease; retiring?: AudioReadingCaptureLease; releaseBlocked: boolean; unrecoverable: boolean;
  captureWork?: Promise<void>; asrWork?: Promise<void>; activeJob?: Job;
  queue: Job[]; ready: Set<Job>; issued: Set<Job>; highestSequence: number; lastEndMs: number;
};
const slot = (): Slot => ({ counter: 0, versions: { music: 0, movie: 0 }, canAcquire: false,
  releaseBlocked: false, unrecoverable: false, queue: [], ready: new Set(), issued: new Set(), highestSequence: 0, lastEndMs: 0 });
const tokenText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f]/.test(v);
const phases: Record<AudioReadingPhase, string> = { off: '', waiting: '等待采集就绪', ready: '采集已就绪', paused: '采集已暂停', error: '采集未完成，请重试' };

/** Host-only controller. Device policy and final store/speech gates belong to adapters. */
export class AudioReadingHostBroker {
  private view: AudioReadingView;
  private readonly slots: Record<AudioReadingSource, Slot> = { 'system-audio': slot(), microphone: slot() };
  private disposed = false;
  private paused: Record<AudioReadingSource, boolean> = { 'system-audio': false, microphone: false };
  private mutationDepth = 0;
  private readonly counted = new WeakSet<object>();
  private count(kind: AudioReadingTally): void { try { this.ports.tally?.(kind); } catch { /* a count never changes listening */ } }
  private flushingAborts = false;
  private readonly aborts = new Set<AbortController>();

  constructor(scopeId: string, private readonly ports: AudioReadingBrokerPorts) { this.view = createAudioReadingView(scopeId); }
  getView(): AudioReadingView { return parseAudioReadingView(this.view)!; }

  /** IPC sender authorization is outside this host-only finite action. Ack means accepted intent. */
  async setIntent(source: AudioReadingSource, purpose: AudioReadingPurpose, enabled: boolean): Promise<AudioReadingAck> {
    if (this.disposed || !parseAudioReadingIntent({ source, purpose, enabled })) throw new Error('Invalid ambient intent');
    return this.mutate(() => {
    const ownerView = this.view, s = this.slots[source], cell = ownerView.sources[source][purpose];
    if (cell.intent !== enabled) { s.versions[purpose]++; cell.revision++; cell.intent = enabled; }
    if (!enabled) this.cellPhase(source, purpose, 'off');
    if (!this.hasIntent(source)) { this.invalidate(source); this.phase(source, 'off'); }
    else if (enabled && (!s.epoch || !s.canAcquire)) this.newEpoch(source);
    else if (s.lease) this.phase(source, 'ready');
    else if (enabled) this.cellPhase(source, purpose, this.view.sources[source].capture.phase === 'off' ? 'waiting' : this.view.sources[source].capture.phase, this.view.sources[source].capture.status);
    this.prune(source); this.driveCapture(source); this.pumpAsr(source);
    const ack: AudioReadingAck = { scopeId: ownerView.scopeId, source, purpose, accepted: true,
      cell: { ...ownerView.sources[source][purpose] }, capture: { ...ownerView.sources[source].capture }, overall: { ...ownerView.overall } };
    this.emit(); return ack;
    });
  }

  currentCapture(source: AudioReadingSource): AudioReadingCaptureToken | null {
    this.checkSource(source);
    const s = this.slots[source];
    return !this.disposed && s.epoch && s.lease ? { scopeId: s.epoch.scopeId, source, epoch: s.epoch.number, captureId: s.lease.captureId } : null;
  }

  /** Input is host-validated mono 16kHz PCM16, not a renderer device or URL. Own one bounded copy. */
  submitSegment(token: AudioReadingCaptureToken, input: { sequence: number; startedAtMs: number; pcm16: ArrayBuffer }): { accepted: boolean; reason?: string; segmentId?: string } {
    if (!this.matches(token)) return { accepted: false, reason: 'inactive' };
    if (this.paused[token.source]) { this.count('skipped-paused'); return { accepted: false, reason: 'paused' }; }
    const s = this.slots[token.source];
    if (!input || Reflect.ownKeys(input).length !== 3 || !['sequence', 'startedAtMs', 'pcm16'].every(k => Object.hasOwn(input, k))
      || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !Number.isSafeInteger(input.startedAtMs) || input.startedAtMs < 0
      || !(input.pcm16 instanceof ArrayBuffer) || !input.pcm16.byteLength || input.pcm16.byteLength % 2 || input.pcm16.byteLength > AUDIO_READING_BROKER_LIMITS.pcmBytes)
      return { accepted: false, reason: 'invalid' };
    if (input.sequence <= s.highestSequence) return { accepted: false, reason: 'duplicate' };
    if (input.startedAtMs < s.lastEndMs) return { accepted: false, reason: 'overlap' };
    if (s.queue.length >= AUDIO_READING_BROKER_LIMITS.pendingPerSource || s.queue.length + Number(!!s.asrWork) + s.ready.size + s.issued.size >= AUDIO_READING_BROKER_LIMITS.retainedPerSource)
      return { accepted: false, reason: 'busy' };
    const generations: Job['generations'] = {};
    for (const p of audioReadingPurposes) if (this.view.sources[token.source][p].intent) generations[p] = s.versions[p];
    const segmentId = createHash('sha256').update(JSON.stringify([token.scopeId, token.source, token.epoch, token.captureId, input.sequence])).digest('hex');
    const identity = { ...token, segmentId, sequence: input.sequence, startedAtMs: input.startedAtMs, endedAtMs: input.startedAtMs + input.pcm16.byteLength / 32 };
    if (!Number.isSafeInteger(Math.ceil(identity.endedAtMs))) return { accepted: false, reason: 'invalid' };
    const job: Job = { identity, epoch: s.epoch!, generations, controller: new AbortController(), wav: this.wav(input.pcm16), taken: false, finished: false };
    s.highestSequence = input.sequence; s.lastEndMs = identity.endedAtMs; s.queue.push(job); this.count('received'); this.pumpAsr(token.source);
    return { accepted: true, segmentId };
  }

  /** Host device-loss receipt must identify this accepted capture. No automatic reacquisition. */
  sourceLost(token: AudioReadingCaptureToken): boolean {
    if (!this.matches(token)) return false;
    return this.mutate(() => { this.invalidate(token.source); this.phase(token.source, 'error', t('采集连接已断开，请重新开启')); this.driveCapture(token.source); this.emit(); return true; });
  }

  /** Retry a failed release explicitly; never acquire over an uncertain old reference. */
  retryRelease(source: AudioReadingSource): void {
    this.checkSource(source); const s = this.slots[source];
    if (s.retiring) { s.releaseBlocked = false; this.driveCapture(source); }
  }

  /** Speech priority pauses consumers, retaining the physical capture reference. */
  setPaused(source: AudioReadingSource, paused: boolean): void {
    this.checkSource(source);
    if (typeof paused !== 'boolean' || this.disposed || this.paused[source] === paused) return;
    this.mutate(() => {
      this.paused[source] = paused; this.prune(source);
      const slot = this.slots[source];
      if (this.hasIntent(source)) {
        if (slot.lease) this.phase(source, 'ready'); else if (slot.canAcquire) this.phase(source, 'waiting');
      }
      this.emit(); if (!paused) this.pumpAsr(source);
    });
  }

  reportProcessing(token: AudioReadingCaptureToken, state: 'recognizing' | 'saved' | 'archive-error'): void {
    if (!this.matches(token)) return;
    const status = state === 'recognizing' ? t('正在转写音频…') : state === 'saved' ? t('音频原文已保存') : t('音频原文未能保存，请重试');
    this.phase(token.source, 'ready', status); this.emit();
  }

  /** Hide/provider/context owners call clear; capture consent is not restored. */
  clear(): void {
    if (this.disposed) return;
    this.mutate(() => { this.clearInternal(); this.emit(); });
  }
  changeScope(scopeId: string): void {
    if (this.disposed || scopeId === this.view.scopeId) throw new Error('A fresh ambient scope is required');
    const next = createAudioReadingView(scopeId); this.mutate(() => { this.clearInternal(); this.view = next; this.emit(); });
  }
  dispose(): void { if (!this.disposed) this.mutate(() => { this.clearInternal(); this.disposed = true; }); }

  /** A stuck dependency stays pending. A rejected release is reported, never counted as freed. */
  async settled(): Promise<{ released: boolean }> {
    for (;;) {
      const pending = audioReadingSources.flatMap(source => [this.slots[source].captureWork, this.slots[source].asrWork].filter((p): p is Promise<void> => !!p));
      if (!pending.length) break;
      await Promise.all(pending);
    }
    return { released: audioReadingSources.every(source => { const s = this.slots[source]; return !s.lease && !s.retiring && !s.unrecoverable; }) };
  }

  private checkSource(source: AudioReadingSource): void { if (!audioReadingSources.includes(source)) throw new Error('Invalid ambient source'); }
  private mutate<T>(action: () => T): T {
    this.mutationDepth++;
    try { return action(); }
    finally {
      this.mutationDepth--;
      if (!this.mutationDepth && !this.flushingAborts) {
        this.flushingAborts = true;
        try { while (this.aborts.size) { const controller = this.aborts.values().next().value!; this.aborts.delete(controller); controller.abort(); } }
        finally { this.flushingAborts = false; }
      }
    }
  }
  private abort(controller: AbortController): void {
    if (this.mutationDepth || this.flushingAborts) this.aborts.add(controller);
    else controller.abort();
  }
  private hasIntent(source: AudioReadingSource): boolean { return audioReadingPurposes.some(p => this.view.sources[source][p].intent); }
  private live(source: AudioReadingSource, epoch: Epoch): boolean { return !this.disposed && this.slots[source].epoch === epoch && !epoch.controller.signal.aborted && this.view.scopeId === epoch.scopeId && this.hasIntent(source); }
  private matches(token: AudioReadingCaptureToken): boolean {
    if (!token || !audioReadingSources.includes(token.source)) return false;
    const s = this.slots[token.source];
    return !!s.epoch && !!s.lease && this.live(token.source, s.epoch) && token.scopeId === s.epoch.scopeId && token.epoch === s.epoch.number && token.captureId === s.lease.captureId;
  }
  private eligible(source: AudioReadingSource, job: Job): AudioReadingPurpose[] {
    if (job.finished || job.controller.signal.aborted || this.paused[source] || !this.live(source, job.epoch)) return [];
    return audioReadingPurposes.filter(p => job.generations[p] !== undefined && job.generations[p] === this.slots[source].versions[p] && this.view.sources[source][p].intent);
  }
  private cellPhase(source: AudioReadingSource, purpose: AudioReadingPurpose, phase: AudioReadingPhase, status = t(phases[phase])): void {
    const c = this.view.sources[source][purpose];
    if (c.phase !== phase || c.status !== status) { c.revision++; c.phase = phase; c.status = status; }
  }
  private phase(source: AudioReadingSource, phase: AudioReadingPhase, status = t(phases[phase])): void {
    if (this.paused[source] && phase === 'ready') { phase = 'paused'; status = t('语音活动期间暂停背景理解'); }
    const c = this.view.sources[source].capture, active = phase === 'ready';
    if (c.phase !== phase || c.active !== active || c.status !== status) { c.revision++; c.phase = phase; c.active = active; c.status = status; }
    for (const p of audioReadingPurposes) if (this.view.sources[source][p].intent) this.cellPhase(source, p, phase === 'off' ? 'waiting' : phase, status);
    const total = this.view.overall, anyActive = audioReadingSources.some(s => this.view.sources[s].capture.active);
    const summary = anyActive ? t('音频采集已就绪') : audioReadingSources.some(s => this.hasIntent(s)) ? t('音频采集未就绪') : '';
    if (total.active !== anyActive || total.status !== summary) { total.revision++; total.active = anyActive; total.status = summary; }
  }
  private emit(): void { if (!this.disposed) { try { this.ports.viewChanged?.(this.getView()); } catch { /* Observer failure grants no authority. */ } } }
  private finish(source: AudioReadingSource, job: Job, abort = false): void {
    job.finished = true; job.wav = undefined; job.text = undefined;
    const s = this.slots[source]; s.ready.delete(job); s.issued.delete(job); s.queue = s.queue.filter(j => j !== job);
    if (abort) this.abort(job.controller);
  }
  private prune(source: AudioReadingSource): void {
    const s = this.slots[source];
    for (const job of new Set([...s.queue, ...s.ready, ...s.issued, ...(s.activeJob ? [s.activeJob] : [])])) if (!this.eligible(source, job).length) {
      if (this.paused[source] && !job.finished && !job.text) this.count('skipped-paused'); // queued clips dropped by a pause
      this.finish(source, job, true);
    }
  }
  private invalidate(source: AudioReadingSource): void {
    const s = this.slots[source];
    const oldEpoch = s.epoch; s.epoch = undefined; s.canAcquire = false;
    for (const job of new Set([...s.queue, ...s.ready, ...s.issued, ...(s.activeJob ? [s.activeJob] : [])])) this.finish(source, job, true);
    if (s.lease) { s.retiring = s.lease; s.lease = undefined; }
    if (oldEpoch) this.abort(oldEpoch.controller);
  }
  private newEpoch(source: AudioReadingSource): void {
    const s = this.slots[source]; this.invalidate(source);
    if (!Number.isSafeInteger(s.counter + 1)) throw new Error('Ambient epoch exhausted');
    s.epoch = { scopeId: this.view.scopeId, number: ++s.counter, controller: new AbortController() };
    s.canAcquire = true; s.highestSequence = 0; s.lastEndMs = 0; this.phase(source, s.releaseBlocked || s.unrecoverable ? 'error' : 'waiting');
  }
  private clearInternal(): void {
    for (const source of audioReadingSources) {
      const s = this.slots[source];
      for (const p of audioReadingPurposes) { const c = this.view.sources[source][p]; if (c.intent) { c.intent = false; c.revision++; s.versions[p]++; } this.cellPhase(source, p, 'off'); }
      this.invalidate(source); this.phase(source, 'off'); this.driveCapture(source);
    }
  }
  private driveCapture(source: AudioReadingSource): void {
    const s = this.slots[source]; if (s.captureWork) return;
    if (s.retiring && !s.releaseBlocked) {
      const lease = s.retiring;
      s.captureWork = Promise.resolve().then(() => lease.release()).then(() => { if (s.retiring === lease) s.retiring = undefined; }, () => {
        s.releaseBlocked = true; if (this.hasIntent(source)) { this.phase(source, 'error', t('音频引用释放未完成')); this.emit(); }
      }).finally(() => { s.captureWork = undefined; this.driveCapture(source); });
      return;
    }
    const epoch = s.epoch;
    if (s.retiring || s.unrecoverable || s.lease || !s.canAcquire || !epoch || !this.live(source, epoch)) return;
    s.captureWork = Promise.resolve().then(async () => {
      if (!this.live(source, epoch)) return;
      const lease = await this.ports.acquire({ scopeId: epoch.scopeId, source, epoch: epoch.number, signal: epoch.controller.signal });
      if (!lease || typeof lease.release !== 'function') { s.unrecoverable = true; throw new Error('Invalid capture lease'); }
      if (!tokenText(lease.captureId) || !this.live(source, epoch)) { s.retiring = lease; if (!tokenText(lease.captureId) && this.live(source, epoch)) { s.canAcquire = false; this.phase(source, 'error'); this.emit(); } return; }
      s.lease = lease; this.phase(source, 'ready'); this.emit();
    }).catch(() => {
      if (this.live(source, epoch)) { s.canAcquire = false; this.phase(source, 'error'); this.emit(); }
    }).finally(() => { s.captureWork = undefined; this.driveCapture(source); });
  }
  private pumpAsr(source: AudioReadingSource): void {
    const s = this.slots[source]; if (s.asrWork || !s.queue.length) return;
    const job = s.queue.shift()!; s.activeJob = job;
    s.asrWork = Promise.resolve().then(async () => {
      if (!this.eligible(source, job).length || !job.wav) return;
      const result = await this.ports.transcribe({ ...job.identity, wav: job.wav }, job.controller.signal);
      job.wav = undefined;
      if (!this.eligible(source, job).length) return;
      if (result && typeof result.text === 'string' && !result.text.trim()) { this.counted.add(job); this.count('empty'); }
      if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > AUDIO_READING_BROKER_LIMITS.textCharacters || result.text.includes('\0')) throw new Error('Invalid ambient transcript');
      job.text = result.text; s.ready.add(job); this.counted.add(job); this.count('with-text');
      const ticket: AudioReadingPublicationTicket = Object.freeze({ segmentId: job.identity.segmentId, signal: job.controller.signal,
        take: () => {
          const purposes = this.eligible(source, job);
          if (job.taken || !s.ready.has(job) || !purposes.length || job.text === undefined) return null;
          job.taken = true; s.ready.delete(job); s.issued.add(job);
          return Object.freeze({ ...job.identity, origin: 'ambient' as const, text: job.text, purposes: Object.freeze(purposes), signal: job.controller.signal,
            currentPurposes: () => Object.freeze(this.eligible(source, job)), finish: () => this.finish(source, job) });
        }, discard: () => this.finish(source, job, true) });
      const returned: unknown = this.ports.publicationReady(ticket);
      if (returned !== undefined) { void Promise.resolve(returned).catch(() => {}); this.finish(source, job, true); throw new Error('Publication notice must be synchronous'); }
    }).catch(() => {
      this.finish(source, job, true);
      if (this.live(source, job.epoch) && s.lease) { if (!this.counted.has(job)) this.count('failed'); this.phase(source, 'ready', t('音频转写未完成')); this.emit(); }
    }).finally(() => {
      job.wav = undefined; if (!s.ready.has(job) && !s.issued.has(job)) this.finish(source, job);
      s.activeJob = undefined; s.asrWork = undefined; this.pumpAsr(source);
    });
  }
  private wav(pcm: ArrayBuffer): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + pcm.byteLength), data = new DataView(buffer), bytes = new Uint8Array(buffer);
    const tag = (offset: number, text: string) => [...text].forEach((char, i) => bytes[offset + i] = char.charCodeAt(0));
    tag(0, 'RIFF'); data.setUint32(4, 36 + pcm.byteLength, true); tag(8, 'WAVE'); tag(12, 'fmt '); data.setUint32(16, 16, true);
    data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 16000, true); data.setUint32(28, 32000, true);
    data.setUint16(32, 2, true); data.setUint16(34, 16, true); tag(36, 'data'); data.setUint32(40, pcm.byteLength, true); bytes.set(new Uint8Array(pcm), 44);
    return buffer;
  }
}
