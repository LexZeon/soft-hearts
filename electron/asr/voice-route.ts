/**
 * Which recognizer hears the microphone, and what happens when it cannot. main.ts hands its closures in; everything here is testable without Electron.
 *
 *  - 识别方式 'local' → the app's own recognizer (host.ts); 'compatible' → the transcription address (electron/asr.ts).
 *  - Turning voice input on with the local recognizer and no component: refused with a reason (VoicePolicy).
 *  - A failed recognition keeps a closed category on the capture (the windows say it in her words, both of them) and
 *    one journal line — never audio, never words. Voice input then turns off: a switch that is on while nothing can be
 *    heard was the confusing part; off plus a sentence saying why (and what to do) is not.
 */
import type { VoiceInputConfig, VoiceInputEngine } from '../../shared/contracts';
import type { JournalInput } from '../../shared/journal';
import { VOICE_INPUT_FAILURES, type VoiceInputFailure } from '../../shared/speech-failure';
import { AsrError } from '../asr';
import type { MediaOwner, VoicePolicy } from '../runtime';
import { LocalAsrError, type LocalAsrHost } from './host';

export interface VoiceRouteDeps {
  config(): VoiceInputConfig;
  local(): Pick<LocalAsrHost, 'voiceBlocked' | 'transcribe'> | null;
  compatible(config: VoiceInputConfig, wav: ArrayBuffer, signal: AbortSignal): Promise<string>;
  journal(input: JournalInput): void;
  characterId(): string | null;
}

export const engineOf = (config: VoiceInputConfig | undefined): VoiceInputEngine => config?.engine === 'compatible' ? 'compatible' : 'local';

/** The closed category of a recognition error (anything unknown is "other"). */
export function voiceFailureOf(error: unknown): VoiceInputFailure {
  const failure = error instanceof LocalAsrError || error instanceof AsrError ? error.failure : undefined;
  return failure && (VOICE_INPUT_FAILURES as readonly string[]).includes(failure) ? failure : 'other';
}

export class VoiceRoute {
  constructor(private readonly deps: VoiceRouteDeps) {}

  get engine(): VoiceInputEngine { return engineOf(this.deps.config()); }

  /** MediaRuntime's voice gate: only the local recognizer can refuse (the compatible address is tried on the first words). */
  readonly policy: VoicePolicy = {
    blocked: (owner: MediaOwner) => {
      if (this.engine !== 'local') return null;
      const local = this.deps.local();
      const refusal = local ? local.voiceBlocked(owner) : 'unavailable';
      if (refusal) this.note(refusal === 'unavailable' ? 'local-failed' : refusal, false);
      return refusal;
    },
  };

  transcribe(wav: ArrayBuffer, signal: AbortSignal): Promise<string> {
    const config = this.deps.config();
    if (engineOf(config) === 'compatible') return this.deps.compatible(config, wav, signal);
    const local = this.deps.local();
    if (!local) return Promise.reject(new LocalAsrError('needs-component', 'no local recognizer on this computer'));
    return local.transcribe(wav, config.language, signal);
  }

  /** A recognition failed for the open capture: keep its category (and safe message) on it and write one journal line. */
  failed(capture: { asrFailure?: string; asrCategory?: VoiceInputFailure }, error: unknown): void {
    const failure = voiceFailureOf(error);
    capture.asrCategory = failure;
    // The compatible path exposes only validated configuration / known transport messages (electron/asr.ts), never response
    // bodies or credentials; the local recognizer's own messages stay in the host (its category says enough).
    if (error instanceof Error && !(error instanceof LocalAsrError) && error.message.length <= 600 && !/[\x00-\x1f\x7f]/.test(error.message))
      capture.asrFailure = error.message;
    this.note(failure, true);
  }

  /**
   * Voice input stays on but heard nothing usable (2026-11-06): the microphone gave only silence, or speech came back as no
   * words. One journal line with the category (and the clip's loudest level in dBFS, a number), never audio or words.
   */
  heard(failure: 'no-sound' | 'empty', peakDb?: number): void { this.note(failure, false, peakDb); }

  private note(failure: VoiceInputFailure, stopped: boolean, peakDb?: number): void {
    try { this.deps.journal({ type: 'voice-input', characterId: this.deps.characterId(), engine: this.engine, failure, stopped,
      ...(peakDb !== undefined ? { peakDb } : {}) }); }
    catch { /* the journal never changes voice input */ }
  }
}
