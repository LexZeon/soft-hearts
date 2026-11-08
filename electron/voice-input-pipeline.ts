import { VoiceSegmentRuntime, type VoiceSegmentRuntimeOptions } from './voice-segment-runtime';
import { VoiceConversationSession, type VoiceConversationPorts } from './voice-conversation-session';
import type { VoiceCancelReason, VoiceCaptureBinding, VoicePcmSubmission } from '../shared/voice-segments';

export interface RejectedVoiceDraft {
  readonly epoch: string; readonly groupId: string | null; readonly segmentId: string | null;
  readonly text: string; readonly reason: string;
}
export interface VoiceInputPipelineOptions extends VoiceConversationPorts {
  transcribe: VoiceSegmentRuntimeOptions['transcribe'];
  rejectedDraft(value: Readonly<RejectedVoiceDraft>): undefined;
  id?: () => string;
}
interface Scope { owner: number; epoch: string; binding: VoiceCaptureBinding; }

/** Host only: the driver verifies consent/sender and supplies each fresh epoch. */
export class VoiceInputPipeline {
  private readonly producer: VoiceSegmentRuntime;
  private readonly session: VoiceConversationSession;
  private scope?: Scope;
  private draft: Readonly<RejectedVoiceDraft> | null = null;
  private noticeDepth = 0;
  private opening = false;
  private disposed = false;
  private revision = 0;
  // Metadata only: at most 128 known IDs plus one final being validated.
  // Keep exact old identities through a deferred synchronous withdrawal flush.
  private readonly knownGroups = new Set<string>();
  private noticeFailures = 0;

  constructor(private readonly ports: VoiceInputPipelineOptions) {
    this.session = new VoiceConversationSession('pipeline-idle', {
      dispatch: (leg, signal, emit) => ports.dispatch(leg, signal, emit),
      ...(ports.merge ? { merge: ports.merge } : {}),
      ...(ports.progress ? { progress: value => this.inEpoch(value.epoch, () => ports.progress!(value)) } : {}),
      userRow: value => this.inEpoch(value.epoch, () => ports.userRow(value)),
      reply: value => this.inEpoch(value.epoch, () => ports.reply(value)),
      settlement: value => this.inEpoch(value.epoch, () => ports.settlement(value)),
      cancelled: value => {
        const key = this.groupKey(value.epoch, value.groupId);
        if (!this.knownGroups.delete(key)) return undefined;
        return this.notice(() => ports.cancelled(value));
      },
      stopTts: () => this.notice(() => ports.stopTts()),
      fault: value => {
        const scope = this.scope;
        if (scope && this.session.snapshot().epoch === scope.epoch) {
          this.producer.cancel('stop-generation');
          if (this.scope === scope) this.notice(() => ports.fault(value));
        }
        return undefined;
      },
    });
    this.producer = new VoiceSegmentRuntime({ transcribe: ports.transcribe, id: ports.id,
      final: value => {
        const scope = this.scope;
        if (!scope || scope.epoch !== value.epoch) throw Error('Stale voice final.');
        const key = this.groupKey(value.epoch, value.groupId), wasKnown = this.knownGroups.has(key);
        this.knownGroups.add(key);
        const receipt = this.session.acceptFinal(value);
        if (this.scope !== scope) throw Error('Voice scope changed during final delivery.');
        if (receipt.state !== 'accepted' && receipt.state !== 'duplicate') {
          if (!wasKnown) this.knownGroups.delete(key);
          this.saveDraft(scope, { ...value, reason: receipt.reason });
          throw Error('Voice final was rejected.');
        }
      },
      seal: value => {
        const scope = this.scope;
        if (!scope || scope.epoch !== value.epoch) throw Error('Stale voice seal.');
        const receipt = this.session.seal(value);
        if (this.scope !== scope || !['sealed', 'duplicate'].includes(receipt.state))
          throw Error('Voice seal was rejected.');
      },
      cancel: value => { if (this.scope?.epoch === value.epoch) this.session.cancel(value); },
      speechStarted: () => { if (!this.session.speechStarted()) throw Error('Voice session is unavailable.'); },
      fault: value => {
        const scope = this.scope;
        if (!scope || !this.producer.view().faulted) return;
        this.session.revoke(value.reason);
        if (this.scope !== scope) return;
        if (!this.draft && value.unpublishedText) this.saveDraft(scope, {
          epoch: scope.epoch, groupId: null, segmentId: null, text: value.unpublishedText, reason: value.reason,
        });
        if (this.scope === scope) this.notice(() => ports.fault({ stage: value.reason }));
      },
    });
  }

  open(owner: number, freshEpoch: string): VoiceCaptureBinding {
    if (this.noticeDepth || this.opening || this.disposed || !Number.isSafeInteger(owner) || owner < 1 || typeof freshEpoch !== 'string'
      || !freshEpoch || freshEpoch.length > 128 || /[\x00-\x1f\x7f]/.test(freshEpoch)
      || freshEpoch === this.session.snapshot().epoch) throw Error('Invalid or reentrant voice scope.');
    const revision = ++this.revision;
    this.opening = true;
    try {
      // Keep the previous scope through its withdrawal notifications. Clearing
      // it first would silently suppress the host's old-group cancellation.
      if (!this.release('scope-change') || revision !== this.revision || this.disposed
        || !this.session.changeScope(freshEpoch) || revision !== this.revision || this.disposed)
        throw Error('Voice scope could not be opened.');
      const binding = this.producer.open(owner, freshEpoch);
      this.knownGroups.clear();
      this.scope = { owner, epoch: freshEpoch, binding: { ...binding } };
      this.draft = null;
      return { ...binding };
    } catch (error) {
      this.release('scope-change'); this.scope = undefined; this.draft = null;
      throw error;
    } finally { this.opening = false; }
  }
  submit(owner: number, value: VoicePcmSubmission) { return this.producer.submit(owner, value); }
  endpoint(owner: number, sessionId: string) { return this.producer.endpoint(owner, sessionId); }
  finishSpeaking(owner: number, sessionId: string) { return this.producer.finishSpeaking(owner, sessionId); }
  speechStarted(owner: number, sessionId: string) { return this.producer.speechStarted(owner, sessionId); }
  /** Host-only: this leg's reply is being generated by the provider (R33 merge may now be offered). */
  turnReady(replyId: string): void { this.session.turnReady(replyId); }
  cancel(owner: number, sessionId: string, reason: VoiceCancelReason): boolean {
    if (!this.matches(owner, sessionId)
      || !['voice-off', 'scope-change', 'hide', 'stop-generation', 'teardown'].includes(reason)) return false;
    this.revision++;
    if (reason === 'teardown') this.disposed = true;
    let notified = false;
    try { notified = this.release(reason); }
    finally { this.scope = undefined; this.draft = null; }
    // Request revoked with no synchronous notice error observed yet. A nested
    // notice can flush afterward; inspect firstFault, never treat this boolean
    // as a settled ASR/provider promise or completed physical PCM drain.
    return notified;
  }
  /** Host teardown remains terminal even if no renderer capture was opened. */
  dispose(): void {
    this.disposed = true; this.revision++;
    try { this.release('teardown'); }
    finally { this.scope = undefined; this.draft = null; }
  }
  snapshot() {
    return { scope: this.scope ? { owner: this.scope.owner, ...this.scope.binding } : null,
      rejectedDraft: this.draft ? { ...this.draft } : null,
      capture: this.producer.view(), session: this.session.snapshot() };
  }
  private matches(owner: number, sessionId: string): boolean {
    return this.scope?.owner === owner && this.scope.binding.captureSessionId === sessionId;
  }
  private release(reason: VoiceCancelReason): boolean {
    let complete = true;
    const before = this.noticeFailures;
    try { this.producer.cancel(reason); } catch { complete = false; }
    try { complete = this.session.revoke(reason) && complete; } catch { complete = false; }
    return complete && this.noticeFailures === before;
  }
  private groupKey(epoch: string, groupId: string): string {
    return epoch + '\0' + groupId;
  }
  private inEpoch(epoch: string, action: () => unknown): undefined {
    return this.scope?.epoch === epoch ? this.notice(action) : undefined;
  }
  private notice(action: () => unknown): undefined {
    this.noticeDepth++;
    try {
      const returned = action();
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => {});
        throw Error('Voice notice sinks must synchronously return undefined.');
      }
      return undefined;
    } catch (error) {
      this.noticeFailures++;
      throw error;
    } finally { this.noticeDepth--; }
  }
  private saveDraft(scope: Scope, value: RejectedVoiceDraft): void {
    if (this.scope !== scope) return;
    if (typeof value.text !== 'string' || value.text.length > 4000) throw Error('Rejected final exceeds the verified text bound.');
    this.draft = Object.freeze({ epoch: value.epoch, groupId: value.groupId, segmentId: value.segmentId,
      text: value.text, reason: value.reason });
    this.notice(() => this.ports.rejectedDraft(this.draft!));
  }
}
