import type { SpeechRequestContext, SpeechWireEvent, TtsConfig, TtsStreamEvent, TtsSynthesisResult } from "../shared/tts";
import { synthesizeBailianSpeech, TTS_TEXT_LIMIT, TtsError, validateTtsConfig } from "./tts";
import type { SpeechFailure } from "../shared/speech-failure";
import { speakableText } from "../shared/speakable-text";

/** The shared contract is extended by the host wiring owner. */
type SegmentSpeechRequestContext = SpeechRequestContext & { segmentIndex?: number };
export type SpeechSynthesizer = (
  config: TtsConfig,
  text: string,
  signal: AbortSignal,
  emit: (event: TtsStreamEvent) => void | Promise<void>,
) => Promise<TtsSynthesisResult | void>;

/**
 * A finished synthesis keeps its routing (`lastRecipient`) until the window says its audio has played out (release) or the reading
 * is cancelled. If neither ever arrives (a cancelled / superseded / failed reading in the window, a hidden window) that routing
 * made `busy` true for good, and everything that waits for her to be quiet (listening along, proactive speech, the pet's mouth)
 * waited with it (2026-11-06, 朗读过后听不见了). The window's longest legitimate drain is one sentence of audio, so two minutes
 * after the transport finished the routing is let go. A fallback, not a pace.
 */
export const SPEECH_ROUTE_LEASE_MS = 120_000;
export interface SpeechRouteLease {
  /** The routing was let go by the deadline (journal it; re-evaluate whatever waited). */
  expired?(recipient: { owner: number; id: string; replyId?: string }): void;
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

interface ActiveSpeech {
  owner: number;
  id: string;
  controller: AbortController;
}

/** One bounded, owner-scoped synthesis request. No renderer-supplied config or audio URLs. */
export class SpeechRuntime {
  private active: ActiveSpeech | null = null;
  // A renderer may still be draining PCM after the transport has completed.
  // Keep only its routing identity, never the config, credentials or controller.
  private lastRecipient: { owner: number; id: string; replyId?: string } | null = null;

  constructor(
    private readonly getConfig: (owner: number, context?: SegmentSpeechRequestContext) => TtsConfig,
    private readonly emit: (owner: number, event: SpeechWireEvent) => void,
    private readonly synthesize: SpeechSynthesizer = synthesizeBailianSpeech,
    /**
     * A synthesis that failed by itself (not stopped, not superseded): its closed category only, for the experience
     * journal. Nothing else happens — no system-voice fallback, no retry, no extra notice.
     */
    private readonly failed?: (failure: SpeechFailure) => void,
    private readonly lease: SpeechRouteLease = {},
  ) {}
  private leaseTimer: unknown = null;
  private disarmLease(): void {
    if (this.leaseTimer === null) return;
    (this.lease.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.leaseTimer);
    this.leaseTimer = null;
  }
  private armLease(recipient: { owner: number; id: string; replyId?: string }): void {
    this.disarmLease();
    const set = this.lease.setTimer ?? ((run: () => void, ms: number) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; });
    this.leaseTimer = set(() => {
      this.leaseTimer = null;
      if (this.lastRecipient !== recipient || this.active !== null) return;
      this.lastRecipient = null;
      try { this.lease.expired?.(recipient); } catch { /* a journal problem never changes the reading */ }
    }, SPEECH_ROUTE_LEASE_MS);
  }

  /** Includes transport completion while the owner still drains final PCM. */
  get busy(): boolean { return this.active !== null || this.lastRecipient !== null; }

  async speak(owner: number, id: string, text: string, context?: SegmentSpeechRequestContext): Promise<void> {
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("语音窗口不正确。");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("语音请求编号不正确。");
    if (typeof text !== "string" || !text.trim() || text.length > TTS_TEXT_LIMIT)
      throw new Error(`语音文字须为 1–${TTS_TEXT_LIMIT} 个字符。`);
    // What is read of it: stage directions in brackets stay in the bubble only (shared/speakable-text.ts). The caller has
    // already matched `text` against the segment the bubble shows; only the words sent to the voice service change.
    const spoken = speakableText(text);
    if (!spoken) throw new Error('这段只有动作描写，不朗读。');
    let replyId: string | undefined;
    let segmentIndex: number | undefined;
    if (context !== undefined) {
      if (!context || typeof context !== 'object' || Array.isArray(context)
        || !Object.hasOwn(context, 'replyId')
        || Object.keys(context).some(key => key !== 'replyId' && key !== 'segmentIndex')) throw new Error('语音所属回合不正确。');
      const value = context.replyId;
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('语音所属回合不正确。');
      replyId = value;
      if (Object.hasOwn(context, 'segmentIndex')) {
        if (!Number.isInteger(context.segmentIndex) || context.segmentIndex! < 0 || context.segmentIndex! > 127)
          throw new Error('语音所属分段不正确。');
        segmentIndex = context.segmentIndex;
      }
    }
    let config: TtsConfig;
    try {
      // Resolve before cancelling a current stream: a stale turn has no authority over it.
      config = validateTtsConfig(structuredClone(this.getConfig(owner, replyId
        ? { replyId, ...(segmentIndex === undefined ? {} : { segmentIndex }) } : undefined)));
    } catch (error) {
      // A settings problem (TtsError) is a failed reading too; a reply that is no longer on screen is not.
      if (error instanceof TtsError) try { this.failed?.(error.failure); } catch { /* Same. */ }
      this.send(owner, { id, type: 'error', message: error instanceof TtsError ? error.publicMessage : '语音合成失败，请稍后重试。' });
      return;
    }
    this.stop();
    this.disarmLease();
    const request: ActiveSpeech = { owner, id, controller: new AbortController() };
    const recipient = { owner, id, ...(replyId ? { replyId } : {}) };
    this.active = request;
    this.lastRecipient = recipient;
    try {
      // Freeze the effective character/model style and secret in the host at dispatch.
      await this.synthesize(config, spoken, request.controller.signal, event => {
        if (this.active !== request || request.controller.signal.aborted) return;
        const forwarded: SpeechWireEvent = event.type === "audio" ? {
          id, type: "audio", data: event.data, format: event.format, sampleRate: event.sampleRate,
          channels: event.channels, ...(event.firstAudioMs === undefined ? {} : { firstAudioMs: event.firstAudioMs }),
        } : {
          id, type: "done", firstAudioMs: event.firstAudioMs, audioBytes: event.audioBytes,
          ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        };
        if (!this.send(owner, forwarded)) {
          if (this.active === request) this.active = null;
          if (this.lastRecipient === recipient) this.lastRecipient = null;
          request.controller.abort();
        }
      });
    } catch (error) {
      if (this.active !== request || request.controller.signal.aborted) return;
      try { this.failed?.(error instanceof TtsError ? error.failure : 'other'); } catch { /* A journal problem never changes the reading. */ }
      this.send(owner, { id, type: "error", message: error instanceof TtsError ? error.publicMessage : "语音合成失败，请稍后重试。" });
    } finally {
      if (this.active === request) {
        this.active = null;
        if (this.lastRecipient === recipient) this.armLease(recipient);
      }
    }
  }

  cancel(owner: number, id: string): boolean {
    if (this.lastRecipient?.owner !== owner || this.lastRecipient.id !== id) return false;
    this.stop();
    return true;
  }

  /** Host-only routing lookup before exact cancellation; never a live persona getter. */
  recipientReply(owner: number, id: string): string | null {
    return this.lastRecipient?.owner === owner && this.lastRecipient.id === id
      ? this.lastRecipient.replyId ?? null : null;
  }

  /** Natural PCM drain releases routing, preserving the reply's later approved segments. */
  release(owner: number, id: string): boolean {
    if (this.active !== null || this.lastRecipient?.owner !== owner || this.lastRecipient.id !== id) return false;
    this.lastRecipient = null;
    this.disarmLease();
    return true;
  }

  /** Host-only reply cancellation; transport IDs remain private to each PCM segment. */
  cancelReply(owner: number, replyId: string): boolean {
    if (typeof replyId !== 'string' || !replyId || this.lastRecipient?.owner !== owner
      || this.lastRecipient.replyId !== replyId) return false;
    this.stop();
    return true;
  }

  dropOwner(owner: number): void {
    if (this.lastRecipient?.owner === owner) this.stop();
  }

  stop(): void {
    const request = this.active;
    const recipient = this.lastRecipient;
    this.disarmLease();
    if (!request && !recipient) return;
    // Detach before abort or emit: synchronous listeners cannot cancel a newer request.
    this.active = null;
    this.lastRecipient = null;
    request?.controller.abort();
    const target = recipient ?? request!;
    this.send(target.owner, { id: target.id, type: "error", cancelled: true, message: "语音已停止。" });
  }

  private send(owner: number, event: SpeechWireEvent): boolean {
    try { this.emit(owner, event); return true; }
    catch { return false; }
  }
}
