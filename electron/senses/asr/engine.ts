/**
 * The SenseVoice recognizer inside the speech inference process: features (features.ts) → ONNX Runtime on the CPU →
 * greedy CTC (decode.ts). `ort` is injected (onnxruntime-node from the component folder in the app; a fake in tests).
 * CPU only on purpose: DirectML was seen once to leave a process that would not exit (2026-11-03), and one utterance
 * at a time is fast enough on the CPU.
 */
import { ctcGreedy, parseTokens, tokensToUtterance, type AsrUtterance } from './decode';
import { senseVoiceFeatures } from './features';
import { normalizeLevel } from './level';
import type { SenseVoiceMeta } from './onnx-metadata';

export interface AsrOrtTensor { data: ArrayLike<number>; dims: readonly number[] }
export interface AsrOrtSession {
  inputNames: readonly string[]; outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, AsrOrtTensor>>;
  release(): Promise<void>;
}
export interface AsrOrtLike {
  InferenceSession: { create(model: string, options: Record<string, unknown>): Promise<AsrOrtSession> };
  Tensor: new (type: 'float32' | 'int32', data: Float32Array | Int32Array, dims: number[]) => unknown;
}

export const ASR_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'] as const;
export type AsrLanguage = (typeof ASR_LANGUAGES)[number];
/** The settings' language field ("zh", "en", "" …) → a language the model knows; anything else listens for all of them. */
export function asrLanguage(value: string): AsrLanguage {
  const key = value.trim().toLowerCase().replace(/[-_].*$/, '');
  return (ASR_LANGUAGES as readonly string[]).includes(key) ? key as AsrLanguage : 'auto';
}

export function cpuSessionOptions(threads: number): Record<string, unknown> {
  return { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
    intraOpNumThreads: Math.max(1, Math.min(8, Math.round(threads))), interOpNumThreads: 1,
    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } };
}

/** At most this much audio per utterance (the voice input pipeline cuts at 15 s; WAVs are checked to ≤ 20 s). */
const MAX_SAMPLES = 20 * 16_000;

export class SenseVoiceEngine {
  private constructor(private readonly ort: AsrOrtLike, private session: AsrOrtSession | null, private readonly meta: SenseVoiceMeta,
    private readonly tokens: readonly string[]) {}

  static async open(ort: AsrOrtLike, modelPath: string, tokensText: string, meta: SenseVoiceMeta, threads = 2): Promise<SenseVoiceEngine> {
    const tokens = parseTokens(tokensText);
    if (tokens.length !== meta.vocabSize) throw new Error('tokens do not match the model');
    const session = await ort.InferenceSession.create(modelPath, cpuSessionOptions(threads));
    const inputs = [...session.inputNames].sort().join(), outputs = session.outputNames;
    if (inputs !== 'language,text_norm,x,x_length' || outputs.length !== 1) {
      await session.release().catch(() => undefined);
      throw new Error('unexpected model inputs or outputs');
    }
    return new SenseVoiceEngine(ort, session, meta, tokens);
  }

  /** One utterance (16 kHz samples in [-1, 1)) → the words, without any special token, and the whitelisted tags (decode.ts). */
  async recognize(samples: Float32Array, language: AsrLanguage = 'zh'): Promise<AsrUtterance> {
    const session = this.session;
    if (!session) throw new Error('recognizer released');
    if (samples.length > MAX_SAMPLES) throw new Error('utterance too long');
    const features = senseVoiceFeatures(normalizeLevel(samples), this.meta, { m: this.meta.lfrM, n: this.meta.lfrN });
    if (!features.frames) return { text: '', language: null, event: null, emotion: null };
    const { Tensor } = this.ort;
    const output = await session.run({
      x: new Tensor('float32', features.data, [1, features.frames, features.dim]),
      x_length: new Tensor('int32', Int32Array.of(features.frames), [1]),
      language: new Tensor('int32', Int32Array.of(this.meta.languages[language]), [1]),
      text_norm: new Tensor('int32', Int32Array.of(this.meta.withItn), [1]),
    });
    const logits = output[session.outputNames[0]!];
    const [batch, frames, vocab] = logits?.dims ?? [];
    if (!logits || batch !== 1 || !frames || vocab !== this.tokens.length) throw new Error('unexpected model output');
    return tokensToUtterance(ctcGreedy(logits.data, frames, vocab), this.tokens);
  }

  /** Free the session (before the process exits by itself). */
  async release(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.release();
  }
}
