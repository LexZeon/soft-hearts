// The tee on her read-aloud output: SpeechRuntime.speak asks `begin` once per sentence it is about to synthesize and feeds the returned
// tee the PCM chunks of that one sentence; `done` writes it. This is the only way audio gets in here, and only her own voice (the bytes the
// provider returned) is ever offered: the microphone, the user's voice and call audio of the user have no path to this file (the origin
// check below refuses anything else; electron/voice/voice-keep README and tests/voice-keep.test.ts hold both).
// Nothing in the app feeds kept audio to a model: the files are for the user's ears. A problem in here never changes a reading.
import { VOICE_KEEP_SENTENCE_MAX_BYTES, VOICE_KEEP_SIZE_CAP_BYTES } from './knobs';
import type { KeptSentence, VoiceKeepStore } from './store';

/** The only thing that may be kept. Any other origin (a microphone, the user's voice, a call) is refused. */
export const HER_READING = 'her-reading';
export interface KeepInfo { provider: 'bailian' | 'fish'; voiceId: string; model?: string; text: string; readAs?: string; replyId?: string; segmentIndex?: number }
export interface SentenceTee { audio(base64: string): void; done(): void }
export interface VoiceKeepRecorderPorts {
  /** Whether the tool exists here at all, and whether the user switched it on (both read at every sentence). */
  available(): boolean;
  on(): boolean;
  character(): { id: string; name: string } | null;
  now(): number;
  store: Pick<VoiceKeepStore, 'keep'>;
  /** One row for the tool's own event file (switch, cap, expiry); closed words and numbers only. */
  event(row: Record<string, string | number | boolean>): void;
  /** A write failed: the sentence is simply not kept (never an error to the reading). */
  failed?(error: unknown): void;
}

export class VoiceKeepRecorder {
  /** Bytes of kept audio on disk as far as this run knows (the host measures at start and after a sweep or 清空). */
  bytes = 0;
  private capped = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly replyClock = new Map<string, number>();
  constructor(private readonly ports: VoiceKeepRecorderPorts) {}

  /** The disk was measured again (start, a sweep, 清空): keeping may go on once it is under the cap. */
  measured(bytes: number): void {
    this.bytes = bytes;
    if (bytes < VOICE_KEEP_SIZE_CAP_BYTES) this.capped = false;
  }
  get isCapped(): boolean { return this.capped; }
  /** Every write started so far has finished (tests; the app never waits for it). */
  async idle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  begin(origin: string, info: KeepInfo): SentenceTee | null {
    if (origin !== HER_READING) return null;
    try {
      if (!this.ports.available() || !this.ports.on()) return null;
      if (this.bytes >= VOICE_KEEP_SIZE_CAP_BYTES) {
        if (!this.capped) { this.capped = true; this.ports.event({ kind: 'size-cap', bytes: this.bytes, at: this.ports.now() }); }
        return null;
      }
      const at = this.ports.now();
      const card = this.ports.character();
      const replyAt = this.replyStart(info.replyId, at);
      const chunks: Buffer[] = [];
      let size = 0, over = false;
      return {
        audio: data => {
          if (over) return;
          try {
            const chunk = Buffer.from(data, 'base64');
            if (size + chunk.length > VOICE_KEEP_SENTENCE_MAX_BYTES) { over = true; chunks.length = 0; return; }
            size += chunk.length; chunks.push(chunk);
          } catch { over = true; chunks.length = 0; }
        },
        done: () => {
          if (over || !size) return;
          const entry: KeptSentence = { at, characterId: card?.id ?? null, characterName: card?.name ?? null, provider: info.provider, voiceId: info.voiceId,
            ...(info.model ? { model: info.model } : {}), text: info.text, ...(info.readAs && info.readAs !== info.text ? { readAs: info.readAs } : {}),
            replyId: info.replyId ?? null, sentenceIndex: info.segmentIndex ?? null, replyAt };
          const job = this.ports.store.keep(entry, Buffer.concat(chunks)).then(written => { this.bytes += written; })
            .catch(error => { try { this.ports.failed?.(error); } catch { /* nothing */ } })
            .finally(() => { this.pending.delete(job); });
          this.pending.add(job);
        },
      };
    } catch (error) { try { this.ports.failed?.(error); } catch { /* nothing */ } return null; }
  }

  /** A reply's sentences share the clock of its first one, so they sort together; the map keeps only the latest few replies. */
  private replyStart(replyId: string | undefined, at: number): number {
    if (!replyId) return at;
    const known = this.replyClock.get(replyId);
    if (known !== undefined) return known;
    this.replyClock.set(replyId, at);
    if (this.replyClock.size > 24) this.replyClock.delete(this.replyClock.keys().next().value as string);
    return at;
  }
}
