/**
 * I-099/I-100: Smart Turn v3.2 inside the speech inference process, calls only. The model
 * (BSD-2-Clause, Daily; shared/voice/smart-turn.json) is the official CPU ONNX file bundled under assets/bundled/smart-turn/; the main
 * process reads and checks it and hands the bytes over. One request = the last seconds of the user's current turn (16 kHz
 * float samples) → one number in [0, 1], the model's probability that the turn is complete. Nothing is kept after a request.
 */
import { smartTurnFeatures, TURN_FRAMES, TURN_MELS, TURN_SAMPLES } from './smart-turn-features';
import type { VadOrtLike, VadOrtSession } from './vad';

/** At most this many samples per request: the model only looks at the last 8 s. */
export const TURN_MAX_SAMPLES = TURN_SAMPLES;

export class SmartTurn {
  private constructor(private readonly ort: VadOrtLike, private session: VadOrtSession | null, private readonly input: string) {}

  /** One small CPU session (two threads: one inference is a few tens of milliseconds). */
  static async open(ort: VadOrtLike, model: Uint8Array): Promise<SmartTurn> {
    const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
      intraOpNumThreads: 2, interOpNumThreads: 1, extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } });
    if (session.inputNames.length !== 1 || session.inputNames[0] !== 'input_features' || session.outputNames.length < 1) {
      await session.release().catch(() => undefined);
      throw new Error('unexpected Smart Turn inputs or outputs');
    }
    return new SmartTurn(ort, session, session.inputNames[0]);
  }

  /** The probability that the turn that produced `audio` (16 kHz mono, its last 8 s) is complete. */
  async complete(audio: Float32Array): Promise<number> {
    const session = this.session;
    if (!session) throw new Error('Smart Turn released');
    if (audio.length < 1 || audio.length > TURN_MAX_SAMPLES) throw new Error('bad turn audio');
    const features = smartTurnFeatures(audio);
    const output = await session.run({ [this.input]: new this.ort.Tensor('float32', features, [1, TURN_MELS, TURN_FRAMES]) });
    const first = Object.values(output)[0], p = Number(first?.data[0]);
    if (!Number.isFinite(p)) throw new Error('unexpected Smart Turn output');
    return Math.max(0, Math.min(1, p));
  }

  async release(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.release();
  }
}
