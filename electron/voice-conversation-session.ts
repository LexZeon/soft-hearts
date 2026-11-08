import { VoiceTextContinuation, type FinalVoiceText, type FinalReceipt, type VoiceTextSeal,
  type VoiceTextLeg, type VoiceTextCompletion, type VoiceTextSettlement } from './voice-text-continuation';
import type { VoiceContinuationState } from '../shared/voice-conversation';

export type VoiceSessionCancelReason = 'voice-off' | 'scope-change' | 'hide' | 'stop-generation' | 'teardown'
  | 'asr-failed' | 'delivery-failed' | 'text-overflow';
export interface VoiceSessionCancel { groupId: string; epoch: string; reason: VoiceSessionCancelReason; }
export type VoiceSessionReply =
  | { type: 'delta'; groupId: string; epoch: string; replyId: string; text: string }
  | { type: 'terminal'; groupId: string; epoch: string; replyId: string;
      completion: Readonly<VoiceTextCompletion>; allowSpeech: boolean };
/** Host callbacks only. Notice sinks are synchronous; only dispatch is async. */
export interface VoiceConversationPorts {
  dispatch(leg: VoiceTextLeg, signal: AbortSignal, emit: (text: string) => void): Promise<VoiceTextCompletion>;
  userRow(value: { groupId: string; epoch: string; first: boolean; seq: number; canonicalUserText: string }): undefined;
  reply(value: VoiceSessionReply): undefined;
  settlement(value: VoiceTextSettlement): undefined;
  stopTts(): undefined;
  cancelled(value: VoiceSessionCancel & { activeReplyId: string | null }): undefined;
  fault(value: { stage: string }): undefined;
  /**
   * R33 merge: more of the same utterance arrived while this leg's reply is
   * being generated (only offered after `turnReady`). The host asks its provider
   * to stop that reply early and returns true when the request was made; the
   * leg's dispatch then settles 'superseded' (stopped in time: the new sentences
   * become a merged leg) or 'complete' (it had already finished: they become an
   * ordinary continuation). Never a retry, never a second request for this leg.
   */
  merge?(leg: VoiceTextLeg): boolean;
  progress?(value: { groupId: string; epoch: string; replyId: string; state: VoiceContinuationState }): undefined;
}
interface GroupEntry { queue: VoiceTextContinuation; revoked: boolean; }
interface Flight { entry: GroupEntry; leg: VoiceTextLeg; controller: AbortController; speechVersion: number; outputLength: number;
  /** The provider holds this leg's input and is generating (host `turnReady`). */
  ready?: boolean; merging?: boolean; mergeRefused?: boolean; terminal?: boolean; }
type SessionReceipt = FinalReceipt | { state: 'rejected'; reason: 'unavailable' | 'closed-group' | 'group-overflow' | 'delivery-failed' | 'reentrant' };
const MAX_OPEN_GROUPS = 4, MAX_GROUP_IDS = 128, MAX_FINAL = 4000, MAX_REPLY_UNITS = 128000;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const reasons: readonly string[] = ['voice-off', 'scope-change', 'hide', 'stop-generation', 'teardown',
  'asr-failed', 'delivery-failed', 'text-overflow'];

/** FIFO across utterances. Aborting never releases the actual dispatch promise. */
export class VoiceConversationSession {
  private readonly groups = new Map<string, GroupEntry>();
  private readonly closed = new Set<string>();
  private flight?: Flight;
  private enabled = true;
  private destroyed = false;
  private speechVersion = 0;
  private firstFault: string | null = null;
  private noticeDepth = 0;
  private revocations = 0;
  private readonly withdrawalNotices: (VoiceSessionCancel & { activeReplyId: string | null })[] = [];
  private stopPending = false;
  private flushingWithdrawals = false;
  private stoppingNotice = false;

  constructor(private epoch: string, private readonly ports: VoiceConversationPorts) {
    if (!validId(epoch)) throw Error('Invalid host epoch.');
  }

  acceptFinal(value: FinalVoiceText): SessionReceipt {
    if (this.noticeDepth) return { state: 'rejected', reason: 'reentrant' };
    if (!value || value.epoch !== this.epoch) return { state: 'rejected', reason: 'wrong-scope' };
    if (!this.enabled || this.destroyed) return { state: 'rejected', reason: 'unavailable' };
    if (!validId(value.groupId) || !validId(value.segmentId) || !Number.isSafeInteger(value.seq) || value.seq < 1
      || typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_FINAL || value.text.includes('\0'))
      return { state: 'rejected', reason: 'invalid' };
    if (this.closed.has(value.groupId)) return { state: 'rejected', reason: 'closed-group' };
    let entry = this.groups.get(value.groupId);
    if (!entry) {
      if (value.seq !== 1) return { state: 'rejected', reason: 'gap' };
      if (this.groups.size >= MAX_OPEN_GROUPS || this.groups.size + this.closed.size >= MAX_GROUP_IDS)
        return { state: 'rejected', reason: 'group-overflow' };
      entry = { queue: new VoiceTextContinuation(value.groupId, value.epoch), revoked: false };
      this.groups.set(value.groupId, entry);
    }
    const receipt = entry.queue.acceptFinal(value);
    if (receipt.state !== 'accepted') return receipt;
    if (!this.stopReading()) return { state: 'rejected', reason: 'delivery-failed' };
    if (!this.current(entry)) return { state: 'rejected', reason: 'unavailable' };
    this.speechVersion++;
    if (!this.sink('user-row', () => this.ports.userRow({ groupId: value.groupId, epoch: value.epoch,
      first: receipt.first, seq: receipt.seq, canonicalUserText: receipt.canonicalUserText })))
      return { state: 'rejected', reason: 'delivery-failed' };
    if (!this.current(entry)) return { state: 'rejected', reason: 'unavailable' };
    this.pump();
    this.mergePending();
    return receipt;
  }
  /** Host-only: this leg's input has reached the provider and its reply is being generated. */
  turnReady(replyId: string): void {
    const flight = this.flight;
    if (flight?.leg.replyId !== replyId || !this.currentFlight(flight) || flight.terminal) return;
    flight.ready = true;
    this.mergePending();
  }

  seal(value: VoiceTextSeal): { state: string; reason?: string } {
    if (this.noticeDepth) return { state: 'rejected', reason: 'reentrant' };
    if (!value || value.epoch !== this.epoch) return { state: 'rejected', reason: 'wrong-scope' };
    if (!this.enabled) return { state: 'rejected', reason: 'unavailable' };
    if (!validId(value.groupId)) return { state: 'rejected', reason: 'invalid' };
    if (this.closed.has(value.groupId)) return { state: 'rejected', reason: 'closed-group' };
    let entry = this.groups.get(value.groupId);
    if (!entry) {
      if (value.lastSeq !== 0) return { state: 'rejected', reason: 'gap' };
      if (this.groups.size + this.closed.size >= MAX_GROUP_IDS) return { state: 'rejected', reason: 'group-overflow' };
      const empty = new VoiceTextContinuation(value.groupId, value.epoch), result = empty.seal(value);
      if (result.state === 'sealed') this.closed.add(value.groupId);
      return result;
    }
    const result = entry.queue.seal(value); this.pump(); return result;
  }

  /** A verified host speech-start stops reading before ASR final delivery. */
  speechStarted(): boolean {
    if (!this.enabled || this.destroyed) return false;
    this.speechVersion++;
    if (this.noticeDepth) { if (!this.stoppingNotice) this.stopPending = true; return true; }
    return this.stopReading();
  }

  cancel(value: VoiceSessionCancel): boolean {
    if (!value || value.epoch !== this.epoch || !this.groups.has(value.groupId) || !reasons.includes(value.reason)) return false;
    this.revoke(value.reason); return true;
  }

  revoke(reason: VoiceSessionCancelReason): boolean {
    if (!reasons.includes(reason)) throw Error('Invalid host cancellation.');
    if (reason === 'teardown') this.destroyed = true;
    this.invalidate(reason);
    if (!this.stoppingNotice) this.stopPending = true;
    return this.flushWithdrawals();
  }

  /** A newly authorized host scope must provide a fresh epoch. */
  changeScope(epoch: string): boolean {
    if (this.destroyed || !validId(epoch) || epoch === this.epoch) return false;
    if (this.noticeDepth) { this.revoke('scope-change'); return false; }
    const previousRevocations = this.revocations;
    if (!this.revoke('scope-change')) return false;
    if (this.destroyed || this.revocations !== previousRevocations + 1) return false;
    this.epoch = epoch; this.closed.clear(); this.enabled = true;
    this.firstFault = null; this.speechVersion++; this.pump(); return true;
  }

  snapshot() {
    return { epoch: this.epoch, enabled: this.enabled, openGroups: this.groups.size,
      closedGroups: this.closed.size, flightReplyId: this.flight?.leg.replyId ?? null,
      flightAborted: this.flight?.controller.signal.aborted ?? false, firstFault: this.firstFault };
  }

  private current(entry: GroupEntry): boolean {
    return this.enabled && !this.destroyed && !entry.revoked && entry.queue.epoch === this.epoch
      && this.groups.get(entry.queue.groupId) === entry;
  }
  private currentFlight(flight: Flight): boolean {
    return this.flight === flight && !flight.controller.signal.aborted && this.current(flight.entry);
  }

  private pump(): void {
    if (this.flight || !this.enabled || this.destroyed) return;
    while (this.groups.size && this.enabled && !this.flight) {
      const entry = this.groups.values().next().value as GroupEntry;
      const result = entry.queue.takeSettlement();
      if (result) {
        if (!this.sink('settlement', () => this.ports.settlement(result))) return;
        if (!this.current(entry)) return;
        this.close(entry); continue;
      }
      if (entry.queue.snapshot().settled) { this.close(entry); continue; }
      let leg: VoiceTextLeg | undefined;
      try { leg = entry.queue.takeNextLeg(); } catch { this.fail('plan'); return; }
      if (!leg) return; // Head waits for its seal/terminal, never bypassed by another group.
      const flight: Flight = { entry, leg, controller: new AbortController(), speechVersion: this.speechVersion, outputLength: 0 };
      this.flight = flight;
      let operation: Promise<VoiceTextCompletion>;
      try {
        operation = Promise.resolve(this.ports.dispatch(leg, flight.controller.signal, text => {
          if (!this.currentFlight(flight)) return;
          if (typeof text !== 'string' || flight.outputLength + text.length > MAX_REPLY_UNITS) { this.fail('invalid-delta'); return; }
          flight.outputLength += text.length;
          this.sink('reply-delta', () => this.ports.reply({ type: 'delta', groupId: leg!.groupId,
            epoch: leg!.epoch, replyId: leg!.replyId, text }));
        }));
      } catch { operation = Promise.reject(Error('Dispatch failed.')); }
      void operation.then(completion => this.terminal(flight, completion), () => this.terminal(flight,
        { status: 'delivery-unknown', coveredThroughSeq: 0, hasAppraisal: false }))
        .finally(() => {
          // An ignored abort leaves this field occupied until operation actually settles.
          if (this.flight === flight) this.flight = undefined;
          this.pump();
        });
    }
  }

  private terminal(flight: Flight, completion: VoiceTextCompletion): void {
    if (!this.currentFlight(flight)) return;
    flight.terminal = true;
    const expectedThrough = flight.entry.queue.activeThroughSeq(flight.leg.replyId);
    if (!flight.entry.queue.completeLeg(flight.leg.replyId, completion)) { this.fail('invalid-terminal'); return; }
    const effective = flight.entry.queue.completionFor(flight.leg.replyId)!;
    const copy = Object.freeze({ ...effective });
    if (copy.status === 'delivery-unknown') this.progress(flight, 'unconfirmed');
    this.sink('reply-terminal', () => this.ports.reply({ type: 'terminal', groupId: flight.leg.groupId,
      epoch: flight.leg.epoch, replyId: flight.leg.replyId, completion: copy,
      allowSpeech: copy.status === 'complete' && copy.coveredThroughSeq === expectedThrough
        && flight.speechVersion === this.speechVersion }));
  }
  private progress(flight: Flight, state: VoiceContinuationState): boolean {
    return !this.ports.progress || this.sink('continuation-progress', () => this.ports.progress!({
      groupId: flight.leg.groupId, epoch: flight.leg.epoch, replyId: flight.leg.replyId, state }));
  }
  /**
   * New finals wait in the queue for the next leg either way. While the current
   * leg's reply is still generating, ask once to stop it so they are merged in
   * right away; otherwise (not yet at the provider, no merge port, refused) they
   * are shown as queued for an explicit continuation after this reply.
   */
  private mergePending(): void {
    const flight = this.flight;
    if (!flight || !this.currentFlight(flight) || flight.terminal || flight.merging
      || !flight.entry.queue.snapshot().pendingFinals) return;
    if (!flight.ready || flight.mergeRefused || !this.ports.merge) { this.progress(flight, 'queued'); return; }
    flight.merging = true;
    let requested = false;
    try { requested = this.ports.merge(flight.leg) === true; } catch { requested = false; }
    if (!this.currentFlight(flight) || flight.terminal) return;
    if (!requested) { flight.merging = false; flight.mergeRefused = true; this.progress(flight, 'queued'); return; }
    this.progress(flight, 'merging');
  }

  private close(entry: GroupEntry): void {
    this.groups.delete(entry.queue.groupId); this.closed.add(entry.queue.groupId);
  }
  private sink(stage: string, action: () => unknown): boolean {
    let failed = false;
    this.noticeDepth++;
    try {
      const returned = action();
      if (returned && typeof (returned as { then?: unknown }).then === 'function') {
        void Promise.resolve(returned).catch(() => {});
        throw Error('Async notice sink is not supported.');
      }
    } catch { failed = true; this.firstFault ??= stage; }
    finally { this.noticeDepth--; this.flushWithdrawals(); }
    if (failed) { this.fail(stage); return false; }
    return true;
  }
  private rawNotice(stage: string, action: () => unknown): boolean {
    if (this.noticeDepth) { this.firstFault ??= 'reentrant-notice'; return false; }
    this.noticeDepth++;
    try {
      const returned = action();
      if (returned && typeof (returned as { then?: unknown }).then === 'function') {
        void Promise.resolve(returned).catch(() => {}); this.firstFault ??= stage; return false;
      }
      return true;
    } catch { this.firstFault ??= stage; return false; }
    finally { this.noticeDepth--; this.flushWithdrawals(); }
  }
  private fail(stage: string): void {
    this.firstFault ??= stage;
    this.invalidate('delivery-failed');
    if (stage !== 'stop-tts' && !this.stoppingNotice) this.stopPending = true;
    this.flushWithdrawals();
    this.rawNotice('fault', () => this.ports.fault({ stage: this.firstFault! }));
  }
  private invalidate(reason: VoiceSessionCancelReason): void {
    this.enabled = false; this.speechVersion++; this.revocations++;
    const entries = [...this.groups.values()]; this.groups.clear();
    for (const entry of entries) {
      entry.revoked = true; const activeReplyId = entry.queue.cancel() ?? null;
      this.closed.add(entry.queue.groupId);
      this.withdrawalNotices.push({ groupId: entry.queue.groupId,
        epoch: entry.queue.epoch, reason, activeReplyId });
    }
    this.flight?.controller.abort(); // Deliberately keep the flight reference.
  }
  private stopReading(): boolean {
    this.stoppingNotice = true;
    try { return this.sink('stop-tts', () => this.ports.stopTts()); }
    finally { this.stoppingNotice = false; }
  }
  /** Coalesce withdrawal only; never queue final/user-row publication recursively. */
  private flushWithdrawals(): boolean {
    if (this.noticeDepth || this.flushingWithdrawals) return true;
    this.flushingWithdrawals = true;
    let delivered = true, stopAttempted = false, reportStopFailure = false;
    try {
      while (this.withdrawalNotices.length || this.stopPending) {
        for (const notice of this.withdrawalNotices.splice(0))
          delivered = this.rawNotice('cancelled', () => this.ports.cancelled(notice)) && delivered;
        if (this.stopPending) {
          this.stopPending = false;
          if (stopAttempted) continue; // Nested revoke during this same stop is already covered.
          stopAttempted = true; this.stoppingNotice = true;
          let stopped: boolean;
          try { stopped = this.rawNotice('stop-tts', () => this.ports.stopTts()); }
          finally { this.stoppingNotice = false; }
          delivered = stopped && delivered;
          if (!stopped && this.enabled) { this.invalidate('delivery-failed'); reportStopFailure = true; }
        }
      }
    } finally { this.flushingWithdrawals = false; }
    if (reportStopFailure) this.rawNotice('fault', () => this.ports.fault({ stage: this.firstFault! }));
    return delivered;
  }
}
