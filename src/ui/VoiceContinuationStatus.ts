import type { VoiceConversationEvent, VoiceContinuationState } from '../../shared/voice-conversation';
import { t, registerUiMessages } from '../../shared/ui-language';
import { VOICE_UI_MESSAGES, type VoiceUiKey } from '../../shared/voice-ui-messages';
registerUiMessages(VOICE_UI_MESSAGES);

const labels: Record<VoiceContinuationState, VoiceUiKey> = {
  request: 'voice.continuation.request', queued: 'voice.continuation.queued',
  continuation: 'voice.continuation.continuation', merging: 'voice.continuation.merging',
  merged: 'voice.continuation.merged', unconfirmed: 'voice.continuation.unconfirmed',
  settled: 'voice.continuation.settled', partial: 'voice.continuation.partial',
};

/** Presentation only: no provider IDs, acceptance authority, timers or retries. */
export class VoiceContinuationStatus {
  private current: { epoch: string; group: string; seq: number; reply: string | null; state: VoiceContinuationState | null } | null = null;
  constructor(private readonly output: HTMLElement) {
    output.setAttribute('role', 'status'); output.setAttribute('aria-live', 'polite');
    this.clear();
  }
  clear(): void { this.current = null; this.output.textContent = ''; this.output.hidden = true; }
  /** Optional presentation refresh; never starts capture, retries or a reply. */
  refresh(): void {
    if (this.current) this.output.textContent = t(this.current.state ? labels[this.current.state] : 'voice.continuation.received');
  }
  receive(event: VoiceConversationEvent): void {
    if (event.type === 'row') {
      if (!this.current || this.current.epoch !== event.epoch || this.current.group !== event.groupId)
        this.current = { epoch: event.epoch, group: event.groupId, seq: event.seq, reply: null, state: null };
      else if (event.seq <= this.current.seq) return;
      else this.current.seq = event.seq;
      if (!this.current.state) this.output.textContent = t('voice.continuation.received');
      this.output.hidden = false; return;
    }
    const current = this.current;
    if (!current || current.epoch !== event.epoch) return;
    if (event.type === 'revoked') { this.clear(); return; }
    if (!('groupId' in event) || event.groupId !== current.group) return;
    if (event.type === 'cancelled') { this.clear(); return; }
    if (event.type === 'start') { current.reply = event.replyId; return; }
    if (event.type !== 'continuation' || current.reply && current.reply !== event.replyId) return;
    current.reply = event.replyId;
    // A slow initial dispatch must not erase already queued supplementary text.
    if (event.state === 'request' && current.state === 'queued') return;
    current.state = event.state;
    this.output.textContent = t(labels[event.state]); this.output.hidden = false;
  }
}
