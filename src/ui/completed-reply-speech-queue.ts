import type { ApprovedReplySpeechSegment } from '../../shared/tts';
import type { SpeechTone } from '../../shared/speech-mood-tone';

interface ReplySpeechApi {
  nextReplySpeechSegment(replyId: string, completedIndex?: number): Promise<ApprovedReplySpeechSegment | null>;
  cancelReplySpeech(replyId: string): Promise<void>;
}
/** One continuous playback for a whole reply (see VoiceOutput.openReply). */
export interface ReplySpeechSession {
  /** Resolves when the next approved segment may be prepared (at most one ahead); false once the playback was stopped. */
  append(text: string, context: ApprovedReplySpeechSegment['context'], tone?: SpeechTone, pauseBeforeMs?: number): Promise<boolean>;
  /** Resolves once everything appended has played. */
  close(): Promise<void>;
  /** Stop this session only if it is still the current one. */
  cancel(): void;
  /** Play out the sentence being heard now and nothing after it (see CompletedReplySpeechQueue.finishCurrent). */
  finishCurrent?(): void;
}
/** A single local playback sequence. Cancellation invalidates every pending continuation. */
export class CompletedReplySpeechQueue {
  private generation = 0;
  private active: string | null = null;
  /** finishCurrent() for this generation: no further segment is fetched or played. */
  private finishing = -1;
  /** The reply that was cut by finishCurrent(): a later kick of the same reply reads nothing more of it. */
  private cut: string | null = null;
  constructor(private readonly api: ReplySpeechApi, private readonly play: (segment: ApprovedReplySpeechSegment) => Promise<void>, private readonly enabled: () => boolean,
    /** R02: Bailian replies use one continuous session; system speech keeps segment-by-segment play. */
    private readonly openSession?: (replyId: string) => ReplySpeechSession | null) {}
  private session: ReplySpeechSession | null = null;
  get replyId(): string | null { return this.active; }
  cancel(): void {
    const id = this.active;this.active = null;this.generation++;
    // Stop our own continuous session directly: the host's cancellation echo is not guaranteed.
    const session = this.session;this.session = null;session?.cancel();
    if (id) void this.api.cancelReplySpeech(id).catch(() => {});
  }
  /**
   * The user turned the microphone on while she was reading: the sentence
   * being heard plays to its end, the rest of this reply is not read (its bubbles still show), then she listens.
   * `replyId`: the reply on screen, cut even when its reading has not started yet. True when a reading was cut.
   */
  finishCurrent(replyId?: string | null): boolean {
    const active = this.active;
    this.cut = active ?? replyId ?? null;
    if (!active) return false;
    this.finishing = this.generation;
    this.session?.finishCurrent?.();
    return true;
  }
  async speak(replyId: string): Promise<void> {
    this.cancel();
    if (!this.enabled()) return;
    if (replyId === this.cut) return; // cut by finishCurrent(): nothing more of this reply is read
    this.cut = null;
    const generation = ++this.generation;this.active = replyId;
    const current = () => generation === this.generation && this.active === replyId && this.enabled();
    const finishing = () => this.finishing === generation;
    let previous: number | undefined;
    let session: ReplySpeechSession | null | undefined, closed = false;
    try {
      while (current()) {
        // Finishing: what was handed over plays out (a session ends after its current sentence); nothing more is fetched.
        if (finishing()) { closed = true; if (session) await session.close(); return; }
        // With a session this asks for N+1 while N is still playing; the host
        // still returns it only after its own bubble is confirmed on screen.
        const piece = await this.api.nextReplySpeechSegment(replyId, previous);
        if (!current()) return;
        if (!piece || finishing()) { closed = true; if (session) await session.close(); return; }
        if (piece.replyId !== replyId || piece.index !== (previous === undefined ? 0 : previous + 1) || piece.context.replyId !== replyId || piece.context.segmentIndex !== piece.index) throw Error('回复句段身份已失效。');
        if (session === undefined) { session = this.openSession?.(replyId) ?? null; this.session = session; }
        if (session) {
          // Stopped underneath us (voice or provider changed): never walk the remaining bubbles silently.
          if (!await session.append(piece.text, piece.context, piece.tone, piece.pauseBeforeMs)) {
            if (finishing() && current()) { closed = true; await session.close(); return; }
            if (current()) this.cancel(); return;
          }
        } else await this.play(piece);
        if (!current()) return;
        previous = piece.index;
      }
    } catch (error) { if (current()) { this.cancel(); throw error; } }
    finally {
      // A cancelled, disabled or failed sequence never leaves its session waiting for segments.
      if (session && !closed) session.cancel();
      if (session && this.session === session) this.session = null;
      if (generation === this.generation && this.active === replyId) this.active = null;
    }
  }
}
