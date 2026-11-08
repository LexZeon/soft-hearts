import { randomUUID } from 'node:crypto';

/** Host-only shapes. The ASR owner proves microphone consent before calling. */
export interface FinalVoiceText { groupId: string; segmentId: string; seq: number; epoch: string; text: string; }
export interface VoiceTextSeal { groupId: string; epoch: string; lastSeq: number; reason: 'host-endpoint' | 'finish-speaking'; }
type RejectReason = 'wrong-scope' | 'invalid' | 'gap' | 'conflict' | 'overflow' | 'sealed' | 'cancelled';
export type FinalReceipt =
  | { state: 'accepted'; first: boolean; seq: number; canonicalUserText: string }
  | { state: 'duplicate'; seq: number }
  | { state: 'rejected'; reason: RejectReason };
export interface VoiceTextLeg {
  readonly replyId: string;
  readonly groupId: string;
  readonly epoch: string;
  readonly kind: 'initial' | 'continuation';
  /**
   * R33: the previous leg of this utterance was stopped early (superseded) so
   * these new sentences could be merged in; its partial reply stays shown and
   * known to the provider, and this leg answers on from it.
   */
  readonly merged: boolean;
  /** Only the new finals, never a silent resend of the entire utterance. */
  readonly inputText: string;
  /** Frozen same-utterance prefix for context; excludes every unsent final. */
  readonly priorUserText: string;
  readonly fromSeq: number;
  readonly throughSeq: number;
  /** Display/archive context, not another provider input message. */
  readonly canonicalUserText: string;
  readonly segments: readonly Readonly<FinalVoiceText>[];
}
export interface VoiceTextCompletion {
  /**
   * 'superseded' (R33): the host stopped this leg's reply on purpose because
   * more of the same utterance arrived. The provider did receive this leg's
   * input (coverage is the whole leg), but the reply was cut short: it is never
   * spoken, never an appraisal candidate, and a continuation leg follows.
   */
  status: 'complete' | 'superseded' | 'error' | 'stopped' | 'delivery-unknown';
  /** Host-verified input coverage, never a renderer assertion. */
  coveredThroughSeq: number;
  /** Only a validated completed reply can have an appraisal candidate. */
  hasAppraisal: boolean;
}
interface LegRecord { leg: VoiceTextLeg; completion?: Readonly<VoiceTextCompletion>; }
export interface VoiceTextSettlement {
  readonly groupId: string;
  readonly epoch: string;
  readonly lastSeq: number;
  readonly canonicalUserText: string;
  readonly status: 'complete' | 'partial';
  /** Selects a host-held candidate; no reward payload or effect is executed here. */
  readonly appraisalReplyId: string | null;
  readonly unsentSequences: readonly number[];
}
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const MAX_TEXT = 16000, MAX_PENDING = 8;
/** A finished leg the next leg may continue from: answered in full, or stopped on purpose to merge. */
const continuable = (record: LegRecord | undefined) => !!record?.completion
  && (record.completion.status === 'complete' || record.completion.status === 'superseded')
  && record.completion.coveredThroughSeq === record.leg.throughSeq;

/** One host-owned utterance. No transport, timer, thread handle, IPC or reward. */
export class VoiceTextContinuation {
  private readonly finals: Readonly<FinalVoiceText>[] = [];
  private readonly ids = new Map<string, number>();
  private pending: Readonly<FinalVoiceText>[] = [];
  private readonly legs: LegRecord[] = [];
  private active?: LegRecord;
  private sealed?: Readonly<VoiceTextSeal>;
  private cancelled = false;
  private settled = false;
  private canonicalText = '';

  constructor(readonly groupId: string, readonly epoch: string) {
    if (!validId(groupId) || !validId(epoch)) throw new Error('Invalid host voice identity.');
  }

  acceptFinal(value: FinalVoiceText): FinalReceipt {
    if (!value || value.groupId !== this.groupId || value.epoch !== this.epoch)
      return { state: 'rejected', reason: 'wrong-scope' };
    if (!validId(value.segmentId) || !Number.isSafeInteger(value.seq) || value.seq < 1
      || typeof value.text !== 'string' || !value.text.trim()) return { state: 'rejected', reason: 'invalid' };
    if (this.cancelled) return { state: 'rejected', reason: 'cancelled' };
    const prior = this.finals[value.seq - 1], priorSeq = this.ids.get(value.segmentId);
    if (prior || priorSeq !== undefined) {
      return prior?.segmentId === value.segmentId && prior.text === value.text && priorSeq === value.seq
        ? { state: 'duplicate', seq: value.seq } : { state: 'rejected', reason: 'conflict' };
    }
    if (this.sealed || this.settled) return { state: 'rejected', reason: 'sealed' };
    if (value.seq !== this.finals.length + 1) return { state: 'rejected', reason: 'gap' };
    const canonical = this.canonicalText + (this.finals.length ? '\n' : '') + value.text;
    if (canonical.length > MAX_TEXT || this.pending.length >= MAX_PENDING)
      return { state: 'rejected', reason: 'overflow' };
    const final = Object.freeze({ groupId: value.groupId, segmentId: value.segmentId,
      seq: value.seq, epoch: value.epoch, text: value.text });
    this.finals.push(final); this.ids.set(final.segmentId, final.seq); this.pending.push(final);
    this.canonicalText = canonical;
    return { state: 'accepted', first: final.seq === 1, seq: final.seq, canonicalUserText: canonical };
  }

  seal(value: VoiceTextSeal): { state: 'sealed' | 'duplicate' } | { state: 'rejected'; reason: RejectReason } {
    if (!value || value.groupId !== this.groupId || value.epoch !== this.epoch)
      return { state: 'rejected', reason: 'wrong-scope' };
    if (!Number.isSafeInteger(value.lastSeq) || value.lastSeq < 0
      || !['host-endpoint', 'finish-speaking'].includes(value.reason)) return { state: 'rejected', reason: 'invalid' };
    if (this.cancelled) return { state: 'rejected', reason: 'cancelled' };
    if (this.sealed) return this.sealed.lastSeq === value.lastSeq && this.sealed.reason === value.reason
      ? { state: 'duplicate' } : { state: 'rejected', reason: 'conflict' };
    if (value.lastSeq !== this.finals.length) return { state: 'rejected', reason: 'gap' };
    this.sealed = Object.freeze({ groupId: value.groupId, epoch: value.epoch,
      lastSeq: value.lastSeq, reason: value.reason });
    if (value.lastSeq === 0) this.settled = true; // No user row or reward for an empty group.
    return { state: 'sealed' };
  }

  /** Caller reserves a slot, then records the actual provider attempt separately. */
  takeNextLeg(): VoiceTextLeg | undefined {
    if (this.cancelled || this.settled || this.active || !this.pending.length) return;
    const previous = this.legs.at(-1);
    // Errors/unknown delivery never turn into automatic retries or continuations.
    if (previous && !continuable(previous)) return;
    const segments = Object.freeze([...this.pending]); this.pending = [];
    const leg = Object.freeze({ replyId: randomUUID(), groupId: this.groupId, epoch: this.epoch,
      kind: this.legs.length ? 'continuation' as const : 'initial' as const,
      merged: previous?.completion?.status === 'superseded',
      inputText: segments.map(final => final.text).join('\n'), fromSeq: segments[0].seq,
      priorUserText: this.finals.slice(0, segments[0].seq - 1).map(final => final.text).join('\n'),
      throughSeq: segments.at(-1)!.seq, canonicalUserText: this.canonicalText, segments });
    this.active = { leg }; this.legs.push(this.active);
    return leg;
  }

  activeThroughSeq(replyId: string): number | undefined {
    return this.active?.leg.replyId === replyId ? this.active.leg.throughSeq : undefined;
  }
  completionFor(replyId: string): Readonly<VoiceTextCompletion> | undefined {
    return this.legs.find(record => record.leg.replyId === replyId)?.completion;
  }

  /** Called only for the reserved host reply ID after a real verified terminal. */
  completeLeg(replyId: string, completion: VoiceTextCompletion): boolean {
    if (this.cancelled || this.settled || !this.active || this.active.leg.replyId !== replyId) return false;
    if (!completion || !['complete', 'superseded', 'error', 'stopped', 'delivery-unknown'].includes(completion.status)
      || !Number.isSafeInteger(completion.coveredThroughSeq) || completion.coveredThroughSeq < 0
      || completion.coveredThroughSeq > this.active.leg.throughSeq || typeof completion.hasAppraisal !== 'boolean'
      || (completion.status !== 'complete' && completion.hasAppraisal)
      // A merge stops a reply whose input the provider already holds; anything less is not a merge.
      || (completion.status === 'superseded' && completion.coveredThroughSeq !== this.active.leg.throughSeq)) return false;
    this.active.completion = Object.freeze({ status: completion.status,
      coveredThroughSeq: completion.coveredThroughSeq, hasAppraisal: completion.hasAppraisal });
    this.active = undefined;
    return true;
  }

  /** Claim once after ASR seal and the final leg; never choose an earlier success. */
  takeSettlement(): VoiceTextSettlement | undefined {
    if (this.cancelled || this.settled || !this.sealed || this.active || !this.finals.length) return;
    const last = this.legs.at(-1), result = last?.completion;
    // Pending finals after a leg that may be continued (or merged) still get their own leg first.
    if (!last || !result || (this.pending.length && continuable(last))) return;
    const covered = !this.pending.length && result.status === 'complete'
      && last.leg.throughSeq === this.sealed.lastSeq && result.coveredThroughSeq === this.sealed.lastSeq;
    this.settled = true;
    return Object.freeze({ groupId: this.groupId, epoch: this.epoch, lastSeq: this.sealed.lastSeq,
      canonicalUserText: this.canonicalText, status: covered ? 'complete' as const : 'partial' as const,
      appraisalReplyId: covered && result.hasAppraisal ? last.leg.replyId : null,
      unsentSequences: Object.freeze(this.pending.map(final => final.seq)) });
  }

  /** Caller aborts only the returned owned reply; the module cannot stop a process. */
  cancel(): string | undefined {
    if (this.cancelled || this.settled) return;
    this.cancelled = true;
    const replyId = this.active?.leg.replyId;
    this.active = undefined; this.pending = [];
    return replyId;
  }

  snapshot() {
    return Object.freeze({ groupId: this.groupId, epoch: this.epoch, canonicalUserText: this.canonicalText,
      acceptedFinals: this.finals.length, pendingFinals: this.pending.length,
      activeReplyId: this.active?.leg.replyId ?? null, sealed: Boolean(this.sealed),
      cancelled: this.cancelled, settled: this.settled, plannedLegs: this.legs.length });
  }
}
