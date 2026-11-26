import type { SpeechRequestContext, SpeechWireEvent, TtsConfig, TtsStreamEvent, TtsSynthesisResult } from "../../shared/voice/tts";
import { synthesizeBailianSpeech, TTS_TEXT_LIMIT, TtsError, validateTtsConfig } from "./tts";
import type { SpeechFailure } from "../../shared/voice/speech-failure";
import { failureInfo, type SpeechFailureInfo } from "./speech-failure-record";
import { speakableText } from "../../shared/voice/speakable-text";
import { applyReading } from "../../shared/voice/reading-map";
import { isFishMood, type FishMood } from "../../shared/voice/fish-voice";
import type { KeepInfo, SentenceTee } from "./voice-keep/recorder";

/** The shared contract is extended by the host wiring owner. */
type SegmentSpeechRequestContext = SpeechRequestContext & { segmentIndex?: number };
/** What a synthesizer may know besides the words: the reply it reads for, and that reply's frozen mood (Drama 3's direction). */
export interface SpeechSynthesisContext { replyId?: string; mood?: FishMood }
export type SpeechSynthesizer = (
  config: TtsConfig,
  text: string,
  signal: AbortSignal,
  emit: (event: TtsStreamEvent) => void | Promise<void>,
  context?: SpeechSynthesisContext,
) => Promise<TtsSynthesisResult | void>;

/**
 * I-070: one synthesizer per paid provider. Drama 3 must be given (main.ts passes the one under the monthly limit,
 * electron/voice/fish-voice-host.ts); without it a Drama 3 request is refused rather than spent unmetered.
 */
export function speechSynthesizer(fish?: SpeechSynthesizer): SpeechSynthesizer {
  return (config, text, signal, emit, context) => {
    if (config.provider === "fish") {
      if (!fish) return Promise.reject(new TtsError("Drama 3 的用量记账还没准备好，这句先不朗读。"));
      return fish(config, text, signal, emit, context);
    }
    return synthesizeBailianSpeech(config, text, signal, emit);
  };
}

/**
 * A finished synthesis keeps its routing (`lastRecipient`) until the window says its audio has played out (release) or the reading
 * is cancelled. If neither ever arrives (a cancelled / superseded / failed reading in the window, a hidden window) that routing
 * made `busy` true for good, and everything that waits for her to be quiet (listening along, proactive speech, the companion's mouth)
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
    private readonly synthesize: SpeechSynthesizer = speechSynthesizer(),
    /**
     * A synthesis that failed by itself (not stopped, not superseded): its closed category only, for the experience
     * journal. Nothing else happens — no system-voice fallback, no retry, no extra notice.
     */
    private readonly failed?: (failure: SpeechFailure, provider: "bailian" | "fish", info?: SpeechFailureInfo) => void,
    private readonly lease: SpeechRouteLease = {},
    /** 2026-11-24: a sentence of a reply is about to be synthesized (the journal gives the reply its number here; a failure is then matched to the reply's reading rows). */
    private readonly begun?: (replyId: string | undefined) => void,
    /** 2026-11-24 dev-only 保存她念出来的声音 (electron/voice/voice-keep/): a tee on this sentence's PCM; null (the usual) keeps nothing. Never changes a reading. */
    private readonly keep?: (info: KeepInfo) => SentenceTee | null,
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
    // What is read of it: stage directions in brackets stay in the bubble only (shared/voice/speakable-text.ts). The caller has
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
    try { this.begun?.(replyId); } catch { /* journal only */ }
    let config: TtsConfig;
    let readAs = spoken; // I-164 读法: the voice's own reading of it (her reading map); the bubble and everything checked above keep the shown text
    let mood: FishMood | undefined;
    let paid: "bailian" | "fish" = "bailian";
    try {
      // Resolve before cancelling a current stream: a stale turn has no authority over it.
      const raw = this.getConfig(owner, replyId
        ? { replyId, ...(segmentIndex === undefined ? {} : { segmentIndex }) } : undefined);
      if (raw?.provider === "fish") paid = "fish";
      config = validateTtsConfig(structuredClone(raw));
      readAs = applyReading(spoken, raw?.voicePlan?.reading).slice(0, TTS_TEXT_LIMIT);
      // The reply's frozen mood rides beside the config (never stored in it): Drama 3 turns it into an acting direction.
      if (isFishMood(raw?.speechMood)) mood = raw.speechMood;
    } catch (error) {
      // A settings problem (TtsError) is a failed reading too; a reply that is no longer on screen is not.
      if (error instanceof TtsError) try { this.failed?.(error.failure, paid, failureInfo(error, replyId, segmentIndex)); } catch { /* Same. */ }
      this.send(owner, { id, type: 'error', message: error instanceof TtsError ? error.publicMessage : '语音合成失败，请稍后重试。' });
      return;
    }
    this.stop();
    this.disarmLease();
    const request: ActiveSpeech = { owner, id, controller: new AbortController() };
    const recipient = { owner, id, ...(replyId ? { replyId } : {}) };
    this.active = request;
    this.lastRecipient = recipient;
    let tee: SentenceTee | null = null; // dev-only keep: this sentence's audio, written when the provider says it is done
    try { tee = this.keep?.({ provider: config.provider === "fish" ? "fish" : "bailian", voiceId: (config.provider === "fish" ? config.fishVoiceId : config.voice) ?? "",
      ...(config.provider === "fish" ? {} : { model: config.model }), text: spoken, readAs, ...(replyId ? { replyId } : {}), ...(segmentIndex === undefined ? {} : { segmentIndex }) }) ?? null; } catch { tee = null; }
    try {
      // Freeze the effective character/model style and secret in the host at dispatch.
      await this.synthesize(config, readAs, request.controller.signal, event => {
        if (this.active !== request || request.controller.signal.aborted) return;
        try { if (event.type === "audio") tee?.audio(event.data); else tee?.done(); } catch { /* the dev keep never changes a reading */ }
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
      }, { ...(replyId ? { replyId } : {}), ...(mood ? { mood } : {}) });
    } catch (error) {
      if (this.active !== request || request.controller.signal.aborted) return;
      try { this.failed?.(error instanceof TtsError ? error.failure : 'other', config.provider === "fish" ? "fish" : "bailian", failureInfo(error, replyId, segmentIndex)); } catch { /* A journal problem never changes the reading. */ }
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
