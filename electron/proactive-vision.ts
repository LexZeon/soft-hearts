import type { Attachment } from '../shared/contracts';
import type { ProactiveOrigin, ProactiveSpeechLease } from '../shared/proactive-speech';
import { ProactiveSpeechGate } from './proactive-speech-gate';
import { cleanMojibake } from '../shared/mojibake';

export interface ProactiveVisionMessage {
  id: string;
  text: string;
  origin: ProactiveOrigin;
}

export interface ProactiveVisionDependencies {
  gate: ProactiveSpeechGate;
  clock?: () => number;
  capture: (signal: AbortSignal) => Promise<Attachment[]>;
  generate: (attachments: Attachment[], signal: AbortSignal) => Promise<string>;
  offer: (message: ProactiveVisionMessage) => boolean | void;
  /** Host-confirmed visible presentation; a renderer append alone is insufficient. */
  present: (message: Readonly<ProactiveVisionMessage>, signal: AbortSignal) => Promise<boolean>;
  /** Final synchronous proof check, in the same continuation as lease commit. */
  presentationCurrent: (message: Readonly<ProactiveVisionMessage>) => boolean;
  current: () => boolean;
  archive: (message: ProactiveVisionMessage) => Promise<void>;
  cancelOffer?: (id: string) => void;
  /** Static stage only. Never expose a provider response or observed private content. */
  onError?: (message: 'capture' | 'generation' | 'delivery' | 'archive') => void;
  /**
   * I-020 #10 备选: this opportunity ended without a line because there was no frame or the model gave nothing (never for a
   * cancellation or a late result). Called after the lease is released, so the opening choice may pick once more among the rest.
   */
  unable?: (opportunityId: string, stage: 'capture' | 'generation') => void;
}

interface Pending {
  lease: ProactiveSpeechLease;
  deadline: number;
  stage: 'capture' | 'generation' | 'delivery';
  message: ProactiveVisionMessage | null;
  offeredAt: number | null;
  presenting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  releaseAbort: () => void;
}

const REQUEST_MS = 35_000;
const ACK_MS = 20_000;

/**
 * A single accepted mood speech cue may become one bounded visual remark.
 * Capture and model execution are injected host capabilities, never renderer paths.
 * No mood reward, user response, retry, polling, tool execution or raw-frame archive
 * is created here. The shared speech gate consumes the opportunity once.
 */
export class ProactiveVision {
  private pending: Pending | null = null;
  private disposed = false;
  private readonly clock: () => number;
  private lastNow = -Infinity;

  constructor(private readonly dependencies: ProactiveVisionDependencies) {
    this.clock = dependencies.clock ?? Date.now;
  }

  get pendingId(): string | null { return this.pending?.lease.id ?? null; }
  get awaitingOffer(): string | null { return this.pending?.message ? this.pending.lease.id : null; }

  async start(scope: string, cue: { id: string; kind: string; until: number; source?: unknown }, eligible: boolean): Promise<void> {
    const now = this.now();
    if (this.disposed || this.pending || !eligible || !this.current() || !Number.isFinite(now)
      || !cue || cue.kind !== 'speech' || cue.source !== undefined || !Number.isFinite(cue.until) || cue.until <= now) return;
    const lease = this.dependencies.gate.tryAcquire({ scope, opportunityId: cue.id, expiresAt: now + REQUEST_MS }, 'vision');
    if (!lease) return;
    const pending: Pending = { lease, deadline: now + REQUEST_MS, stage: 'capture', message: null,
      offeredAt: null, presenting: false, timer: null, releaseAbort: () => {} };
    const aborted = () => {
      if (this.pending !== pending) return;
      if (this.now() >= pending.deadline) this.report(pending.stage);
      this.finish(pending, true);
    };
    lease.signal.addEventListener('abort', aborted, { once: true });
    pending.releaseAbort = () => lease.signal.removeEventListener('abort', aborted);
    this.pending = pending;
    try {
      if (!this.live(pending)) return this.cancelPending(pending);
      const attachments = validateFrames(await untilAborted(this.dependencies.capture(lease.signal), lease.signal));
      if (!this.live(pending)) return this.cancelPending(pending);
      if (!attachments.length) {
        this.report('capture');
        this.cancelPending(pending);
        return this.unable(lease.id, 'capture');
      }
      pending.stage = 'generation';
      const text = boundedText(await untilAborted(this.dependencies.generate(attachments, lease.signal), lease.signal));
      if (!this.live(pending)) return this.cancelPending(pending);
      if (!text) {
        this.report('generation');
        this.cancelPending(pending);
        return this.unable(lease.id, 'generation');
      }
      pending.stage = 'delivery';
      const at = this.now();
      const sources = attachments.map(attachment => attachment.source);
      const message: ProactiveVisionMessage = { id: lease.id, text,
        origin: { kind: 'proactive', id: lease.id, at, sources,
          labels: sources.map(source => source === 'screen' ? '屏幕' : '摄像头') } };
      pending.message = message;
      pending.offeredAt = at;
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.report('delivery');
        this.cancelPending(pending);
      }, Math.max(0, Math.min(ACK_MS, pending.deadline - at)));
      pending.timer.unref?.();
      if (this.dependencies.offer(structuredClone(message)) === false) {
        this.report('delivery');
        this.cancelPending(pending);
      }
    } catch {
      if (this.pending !== pending) return;
      const failed = !lease.signal.aborted, stage = pending.stage;
      if (failed) this.report(stage);
      this.cancelPending(pending);
      // A capture or model error (not a cancellation): the same fallback as an empty result.
      if (failed && stage !== 'delivery') this.unable(lease.id, stage);
    }
  }

  /** A renderer acknowledgement requests host presentation verification. */
  async ack(id: string): Promise<boolean> {
    const pending = this.pending, now = this.now();
    if (!pending || pending.lease.id !== id || !pending.message || pending.offeredAt === null || pending.presenting) return false;
    if (!this.live(pending) || now - pending.offeredAt < 0 || now - pending.offeredAt >= ACK_MS) {
      this.report('delivery');
      this.cancelPending(pending);
      return false;
    }
    pending.presenting = true;
    try {
      const presentation = frozenMessage(pending.message);
      const shown = await untilAborted(this.dependencies.present(presentation, pending.lease.signal), pending.lease.signal);
      const completedAt = this.now();
      if (shown !== true || !this.live(pending) || completedAt - pending.offeredAt < 0 || completedAt - pending.offeredAt >= ACK_MS) {
        if (this.pending === pending) {
          this.report('delivery');
          this.cancelPending(pending);
        }
        return false;
      }
      // Do not await between this exact host proof and commit. An earlier true
      // promise may describe a presentation revision that is no longer visible.
      if (this.dependencies.presentationCurrent(presentation) !== true) {
        this.report('delivery');
        this.cancelPending(pending);
        return false;
      }
      if (!pending.lease.commit()) { this.cancelPending(pending); return false; }
      const message = structuredClone(pending.message!);
      this.finish(pending, false);
      // An archive failure cannot repeat a presentation or spend another cue.
      // Only text/origin is saved, after successful host-visible confirmation.
      try { void this.dependencies.archive(message).catch(() => this.report('archive')); }
      catch { this.report('archive'); }
      return true;
    } catch {
      if (this.pending === pending) {
        if (!pending.lease.signal.aborted) this.report('delivery');
        this.cancelPending(pending);
      }
      return false;
    }
  }

  cancel(): void { if (this.pending) this.cancelPending(this.pending); }
  dispose(): void { this.disposed = true; this.cancel(); }

  private current(): boolean {
    try { return this.dependencies.current() === true; } catch { return false; }
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) return NaN;
    this.lastNow = Math.max(this.lastNow, now);
    return this.lastNow;
  }

  private live(pending: Pending): boolean {
    return !this.disposed && this.pending === pending && !pending.lease.signal.aborted
      && this.current() && this.now() < pending.deadline;
  }

  private cancelPending(pending: Pending): void {
    this.finish(pending, true);
    pending.lease.cancel();
  }

  private finish(pending: Pending, revokeOffer: boolean): void {
    if (this.pending !== pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.releaseAbort();
    if (revokeOffer && pending.message) {
      try { this.dependencies.cancelOffer?.(pending.lease.id); } catch { /* An unavailable window has already lost the offer. */ }
    }
    pending.message = null;
  }

  private unable(id: string, stage: 'capture' | 'generation'): void {
    try { this.dependencies.unable?.(id, stage); } catch { /* The fallback never revives this turn. */ }
  }

  private report(stage: 'capture' | 'generation' | 'delivery' | 'archive'): void {
    try { this.dependencies.onError?.(stage); } catch { /* Diagnostics cannot revive or duplicate a turn. */ }
  }
}

function frozenMessage(message: ProactiveVisionMessage): Readonly<ProactiveVisionMessage> {
  const copy = structuredClone(message);
  Object.freeze(copy.origin.sources);
  Object.freeze(copy.origin.labels);
  Object.freeze(copy.origin);
  return Object.freeze(copy);
}

function validateFrames(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return [];
  const sources = new Set<string>(), result: Attachment[] = [];
  for (const frame of value) {
    if (!frame || typeof frame !== 'object' || !['screen', 'camera'].includes(frame.source)
      || sources.has(frame.source) || typeof frame.dataUrl !== 'string' || frame.dataUrl.length > 4_000_000
      || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(frame.dataUrl)) return [];
    sources.add(frame.source);
    result.push({ source: frame.source, dataUrl: frame.dataUrl });
  }
  return result;
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string') return '';
  // The remark comes from a shared frame, where "UTF-8 read as GBK" text is most often seen: the same repair-or-drop as a
  // chat reply (shared/mojibake.ts). A remark that was nothing but garbage comes out empty and is skipped like any empty one.
  let text = cleanMojibake(value).text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 400);
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  return text;
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DOMException('Proactive vision cancelled', 'AbortError')); };
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
