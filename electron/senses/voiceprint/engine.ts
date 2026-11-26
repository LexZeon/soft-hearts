/**
 * Unbound v1 step 3: the voiceprint's inference inside its utility process (electron/senses/voiceprint/worker.ts). 16 kHz samples in
 * [-1, 1] → 80 Kaldi filter banks (Povey window, unscaled, electron/senses/asr/features.ts) with each utterance's mean taken off →
 * CAM++ → 192 numbers, unit length. `ort` is injected (onnxruntime-node from the component folder; a fake in tests). CPU only.
 * Nothing is kept between clips.
 */
import { fbank, MEL_BINS } from '../asr/features';
import { VOICEPRINT_MODEL_SHAPE } from './manifest';

export interface VoiceOrtTensor { data: ArrayLike<number>; dims: readonly number[] }
export interface VoiceOrtSession {
  inputNames: readonly string[]; outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, VoiceOrtTensor>>;
  release(): Promise<void>;
}
export interface VoiceOrtLike {
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<VoiceOrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}

/** At most this many seconds of a clip are used (a longer one says nothing more about who is speaking). */
export const MAX_CLIP_SECONDS = 20;

/** The model's input for one clip: filter banks minus their mean over the clip (CAM++'s global-mean normalisation). */
export function speakerFeatures(samples: Float32Array): { data: Float32Array; frames: number } {
  const clip = samples.length > MAX_CLIP_SECONDS * 16_000 ? samples.subarray(0, MAX_CLIP_SECONDS * 16_000) : samples;
  const { data, frames } = fbank(clip, { window: 'povey', scale: 1 });
  if (frames) {
    const mean = new Float64Array(MEL_BINS);
    for (let f = 0; f < frames; f++) for (let b = 0; b < MEL_BINS; b++) mean[b] += data[f * MEL_BINS + b];
    for (let b = 0; b < MEL_BINS; b++) mean[b] /= frames;
    for (let f = 0; f < frames; f++) for (let b = 0; b < MEL_BINS; b++) data[f * MEL_BINS + b] -= mean[b];
  }
  return { data, frames };
}

function cpuOptions(threads: number): Record<string, unknown> {
  return { graphOptimizationLevel: 'all', logSeverityLevel: 3, executionProviders: ['cpu'], intraOpNumThreads: Math.max(1, Math.min(4, threads)), interOpNumThreads: 1,
    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } };
}

export class SpeakerEngine {
  private constructor(private readonly ort: VoiceOrtLike, private readonly session: VoiceOrtSession) {}

  static async open(ort: VoiceOrtLike, model: Uint8Array, threads = 1): Promise<SpeakerEngine> {
    return new SpeakerEngine(ort, await ort.InferenceSession.create(model, cpuOptions(threads)));
  }

  /** One clip → 192 numbers of unit length. Throws when the clip is shorter than one frame or the model answers something else. */
  async embed(samples: Float32Array): Promise<Float32Array> {
    const { data, frames } = speakerFeatures(samples);
    if (frames < 10) throw new Error('clip too short');
    const output = await this.session.run({ [this.session.inputNames[0] ?? 'x']: new this.ort.Tensor('float32', data, [1, frames, MEL_BINS]) });
    const result = output[this.session.outputNames[0] ?? 'embedding'] ?? Object.values(output)[0];
    if (!result || result.data.length !== VOICEPRINT_MODEL_SHAPE.embedding) throw new Error('unexpected model output');
    const vector = Float32Array.from(result.data);
    let norm = 0; for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm <= 0) throw new Error('model output is not usable');
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
  }

  async release(): Promise<void> { await this.session.release().catch(() => undefined); }
}
