/**
 * I-135: the face check's inference inside its utility process: YuNet finds faces, the largest one is aligned with its
 * five landmarks and SFace turns it into 128 numbers. `ort` is injected (onnxruntime-node from the component folder in
 * the app; a fake in tests). CPU only: both models are small and the companion's WebGL keeps the graphics card.
 * Nothing is kept between frames; the frame and the crop are dropped after `analyze`.
 */
import { alignFace, SFACE_SIZE } from './align';
import { FACE_KNOBS } from './knobs';
import { brightness, EMBEDDING_SIZE, frontalness, sharpness } from './score';
import { decodeYunet, detectorInput, largestFace } from './yunet';

export interface FaceOrtTensor { data: ArrayLike<number>; dims: readonly number[] }
export interface FaceOrtSession {
  inputNames: readonly string[]; outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, FaceOrtTensor>>;
  release(): Promise<void>;
}
export interface FaceOrtLike {
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<FaceOrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}

/** One analysed frame: measurements plus the embedding of the largest face (null when there is no face). */
export interface FaceAnalysis {
  found: boolean;
  detScore: number;
  faceWidth: number;
  frontal: number;
  sharpness: number;
  brightness: number;
  embedding: Float32Array | null;
  /** The face's box in the frame's pixels (x, y, width, height), for the enrolment preview only. */
  box?: readonly [number, number, number, number] | null;
}

export const NO_FACE: FaceAnalysis = Object.freeze({ found: false, detScore: 0, faceWidth: 0, frontal: 0, sharpness: 0, brightness: 0, embedding: null, box: null });

export function cpuOptions(threads: number): Record<string, unknown> {
  return { graphOptimizationLevel: 'all', logSeverityLevel: 3, executionProviders: ['cpu'], intraOpNumThreads: Math.max(1, Math.min(4, threads)), interOpNumThreads: 1,
    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } };
}

export class FaceEngine {
  private constructor(private readonly ort: FaceOrtLike, private readonly detector: FaceOrtSession, private readonly recognizer: FaceOrtSession) {}

  static async open(ort: FaceOrtLike, detectorModel: Uint8Array, recognizerModel: Uint8Array, threads = 1): Promise<FaceEngine> {
    const detector = await ort.InferenceSession.create(detectorModel, cpuOptions(threads));
    try { return new FaceEngine(ort, detector, await ort.InferenceSession.create(recognizerModel, cpuOptions(threads))); }
    catch (error) { await detector.release().catch(() => undefined); throw error; }
  }

  async analyze(rgba: Uint8Array, width: number, height: number): Promise<FaceAnalysis> {
    const knobs = FACE_KNOBS.detector;
    const input = detectorInput(rgba, width, height, knobs.inputSize);
    const detected = await this.detector.run({ [this.detector.inputNames[0] ?? 'input']: new this.ort.Tensor('float32', input.data, [1, 3, input.size, input.size]) });
    const face = largestFace(decodeYunet(detected, input, knobs));
    if (!face) return NO_FACE;
    const aligned = alignFace(rgba, width, height, face.landmarks);
    const output = await this.recognizer.run({ [this.recognizer.inputNames[0] ?? 'data']: new this.ort.Tensor('float32', aligned.rgb, [1, 3, SFACE_SIZE, SFACE_SIZE]) });
    const feature = output[this.recognizer.outputNames[0] ?? 'fc1'] ?? Object.values(output)[0];
    if (!feature || feature.data.length !== EMBEDDING_SIZE) throw new Error('unexpected SFace output');
    const embedding = Float32Array.from(feature.data);
    if (!embedding.every(Number.isFinite)) throw new Error('SFace output is not finite');
    return {
      found: true, detScore: face.score, faceWidth: face.width, box: [face.x, face.y, face.width, face.height], frontal: frontalness(face.landmarks),
      sharpness: sharpness(aligned.grey, SFACE_SIZE), brightness: brightness(aligned.grey, SFACE_SIZE), embedding,
    };
  }

  async release(): Promise<void> {
    await Promise.allSettled([this.detector.release(), this.recognizer.release()]);
  }
}
