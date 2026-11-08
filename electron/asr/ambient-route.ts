/**
 * Which recognizer transcribes the played sound for 陪听歌、看剧 (R12; 「和她一起听」 I-016 and the older system-audio session).
 * the approved I-016 plan: "声音只在本机，转写只在本机". main.ts hands its
 * closures in; everything here is testable without Electron.
 *
 *  - Only the app's own recognizer on this computer ever hears a played clip: the sound never leaves it. There is no port to the
 *    compatible transcription address any more (Codex T-207: an old setting with a changed address sent the WAV out).
 *  - It still reads 识别方式 of voice input (no second setting): 'local' (the default) → local transcription; 'compatible' →
 *    no transcription at all, the switch is refused as 'not-local' and hears only the rhythm (she says why).
 *  - One recognizer, one request at a time: the callers go through ForegroundAsr, so voice input stays ahead of this.
 *  - Turning a switch on with the local recognizer and no component: refused with a reason (same question and window
 *    handling as voice input, LocalAsrHost.voiceBlocked).
 *  - The language comes back from the model's own tag and goes through the old rules (`classify`: zh / ja / en are
 *    supported, yue / ko … are not, nothing → unknown). The event and emotion tags come back too (closed lists).
 *  - A failure keeps only its closed category: one journal line (at most one a minute per category), never audio or words.
 */
import type { AudioReadingRefusal, VoiceInputConfig, VoiceInputEngine } from '../../shared/contracts';
import type { JournalInput } from '../../shared/journal';
import { VOICE_INPUT_FAILURES, type VoiceInputFailure } from '../../shared/speech-failure';
import type { AudioReadingAck, AudioReadingPurpose, AudioReadingSource, AudioReadingView } from '../../shared/audio-reading-toggles';
import { AmbientAsrError, classify, validateAmbientWav, type AmbientAsrResult } from '../ambient-asr';
import { AsrError } from '../asr';
import type { MediaOwner } from '../runtime';
import type { AsrEmotionTag, AsrEventTag, AsrTags } from './decode';
import { LocalAsrError, type LocalAsrHost } from './host';
import { engineOf } from './voice-route';

export interface AmbientAsrRouteDeps {
  /** The stored voice-input setting (only 识别方式 is read here). */
  config(): VoiceInputConfig;
  local(): Pick<LocalAsrHost, 'ready' | 'voiceBlocked' | 'recognize'> | null;
  journal(input: JournalInput): void;
  characterId(): string | null;
  now?(): number;
}

/** Why a listening/watching switch hears only the rhythm: the local recognizer's reasons, or 识别方式 is not local. */
export type AmbientRefusal = AudioReadingRefusal;

/** A played clip with 识别方式 = compatible: not transcribed (never sent out), and not a recognition failure either. */
export class AmbientNotLocalError extends Error {
  readonly failure = 'other' as const;
  constructor() { super('played sound is transcribed only by the local recognizer'); this.name = 'AmbientNotLocalError'; }
}

/** What kind of sound the local model heard and in what tone (closed tags). Not used by any behaviour yet. */
export interface AmbientSoundTags { event: AsrEventTag | null; emotion: AsrEmotionTag | null }
export interface LocalAmbientAsrResult extends AmbientAsrResult { sound: AmbientSoundTags }

/** A repeated failure of the same category is written to the journal at most this often. */
export const AMBIENT_FAILURE_NOTE_MS = 60_000;


/** The closed category of a transcription error (anything unknown is "other"). */
export function ambientFailureOf(error: unknown): VoiceInputFailure {
  const failure = error instanceof LocalAsrError || error instanceof AsrError || error instanceof AmbientAsrError ? error.failure : undefined;
  return failure && (VOICE_INPUT_FAILURES as readonly string[]).includes(failure) ? failure : 'other';
}

/** The local recognizer's words and tags → a transcript result: the language by the old rules, whole clip, no sub-windows. */
export function localAmbientResult(result: { text: string; tags?: AsrTags }): LocalAmbientAsrResult {
  const tags = result.tags;
  // With punctuation on, a clip of music without singing comes back as just "." (and a guessed language): no words.
  const text = /[\p{L}\p{N}]/u.test(result.text) ? result.text.trim() : '';
  return {
    text,
    // Only words prove a language; a clip with nothing said (or no whitelisted tag) is "unknown".
    language: classify(text && tags?.language ? [tags.language] : []),
    languageDetection: { version: 2, scope: 'whole-result', windowAnalysis: text ? 'not-requested' : 'skipped-empty' },
    sound: { event: tags?.event ?? null, emotion: tags?.emotion ?? null },
  };
}

/** The reply to a refused switch: nothing changed, so the requested cell exactly as the host has it, not accepted. */
export function refusedReadingAck(view: AudioReadingView, source: AudioReadingSource, purpose: AudioReadingPurpose): AudioReadingAck {
  return { scopeId: view.scopeId, source, purpose, accepted: false, cell: { ...view.sources[source][purpose] },
    capture: { ...view.sources[source].capture }, overall: { ...view.overall } };
}

/**
 * I-016 (docs/claude/2026-11-03-listen-kind.md): what one transcribed clip sounded like, for the host's "is it music" judgement
 * (electron/listen-kind-source.ts): whether it had words (only punctuation is no words) and the local model's event tag (null
 * with the compatible address). Never the text.
 */
export interface AmbientHeard { words: boolean; event: AsrEventTag | null }

export class AmbientAsrRoute {
  private last: { failure: VoiceInputFailure; at: number } | null = null;
  private readonly now: () => number;
  private readonly observers = new Set<(heard: AmbientHeard) => void>();

  constructor(private readonly deps: AmbientAsrRouteDeps) { this.now = deps.now ?? Date.now; }

  /** I-016: be told about every clip transcribed from now on (words or not, event tag). Returns the way to stop. */
  observe(listener: (heard: AmbientHeard) => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  private heard(result: AmbientAsrResult | LocalAmbientAsrResult): void {
    const heard: AmbientHeard = { words: /[\p{L}\p{N}]/u.test(result.text ?? ''), event: 'sound' in result ? result.sound.event : null };
    for (const listener of [...this.observers]) { try { listener({ ...heard }); } catch { /* an observer never changes transcription */ } }
  }

  get engine(): VoiceInputEngine { return engineOf(this.deps.config()); }

  /** Can a listening/watching session transcribe now: 识别方式 is local and its component is ready. */
  ready(): boolean {
    if (engineOf(this.deps.config()) !== 'local') return false;
    try { return !!this.deps.local()?.ready; } catch { return false; }
  }

  /**
   * Turning a switch's words on: null when it may, otherwise why not ('not-local' with 识别方式 = compatible: rhythm only). With
   * the local recognizer this raises the control window's download question and brings it into view (like voice input); a
   * local refusal is noted in the journal by category.
   */
  blocked(owner: MediaOwner): AmbientRefusal | null {
    if (engineOf(this.deps.config()) !== 'local') return 'not-local';
    const local = this.deps.local();
    const refusal = local ? local.voiceBlocked(owner) : 'unavailable';
    if (refusal) this.note('local', refusal === 'unavailable' ? 'local-failed' : refusal, true);
    return refusal;
  }

  /**
   * One clip of played sound (≤ 12 s, 16 kHz mono WAV) → its words and language, by the local recognizer only. Throws with a
   * category on failure; with 识别方式 = compatible it throws AmbientNotLocalError at once (nothing heard, nothing sent).
   */
  async transcribe(wav: ArrayBuffer, signal: AbortSignal): Promise<AmbientAsrResult | LocalAmbientAsrResult> {
    if (engineOf(this.deps.config()) !== 'local') throw new AmbientNotLocalError();
    try {
      validateAmbientWav(wav);
      const local = this.deps.local();
      if (!local) throw new LocalAsrError('needs-component', 'no local recognizer on this computer');
      // Automatic language detection, never the voice-input language (that would force the model's tag).
      const result = localAmbientResult(await local.recognize(wav, '', signal, { tags: true }));
      this.last = null;
      this.heard(result);
      return result;
    } catch (error) {
      // Cancelled (voice input took the recognizer, the switch went off): not a failure.
      if (!signal.aborted) this.failed('local', error);
      throw error;
    }
  }

  private failed(engine: VoiceInputEngine, error: unknown): void {
    const failure = ambientFailureOf(error), at = this.now();
    if (this.last && this.last.failure === failure && at - this.last.at < AMBIENT_FAILURE_NOTE_MS) return;
    this.last = { failure, at };
    this.note(engine, failure, false);
  }

  private note(engine: VoiceInputEngine, failure: VoiceInputFailure, refused: boolean): void {
    try { this.deps.journal({ type: 'audio-reading', characterId: this.deps.characterId(), engine, failure, refused }); }
    catch { /* the journal never changes transcription */ }
  }
}
