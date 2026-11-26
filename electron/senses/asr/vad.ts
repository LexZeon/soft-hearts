/**
 * I-099: Silero VAD inside the speech inference process.
 * The model (v6.2, MIT, Silero Team; shared/voice/silero-vad.json) is the official ONNX file bundled under assets/bundled/silero-vad/;
 * the main process reads and checks it and hands the bytes over (a path inside app.asar cannot be opened by native code).
 *
 * Streaming: 16 kHz samples come in any length; every completed 512-sample window (32 ms) gives one speech probability. As in
 * the upstream wrapper (src/silero_vad/utils_vad.py OnnxWrapper), each window is fed with the 64 samples before it and the
 * model's recurrent state is carried from window to window. Only numbers go back; no audio is kept after a request.
 */
export const VAD_RATE = 16_000;
export const VAD_WINDOW = 512;
export const VAD_CONTEXT = 64;
export const VAD_WINDOW_MS = VAD_WINDOW / VAD_RATE * 1000;
/** At most this many samples per request (1 s; a call sends one microphone chunk, ~85 ms). */
export const VAD_MAX_SAMPLES = VAD_RATE;
/** At most this many probabilities per answer (1 s of windows, plus one from the samples carried over). */
export const VAD_MAX_PROBS = Math.ceil(VAD_MAX_SAMPLES / VAD_WINDOW) + 1;

export interface VadOrtTensor { data: ArrayLike<number>; dims: readonly number[] }
export interface VadOrtSession {
  inputNames: readonly string[]; outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, VadOrtTensor>>;
  release(): Promise<void>;
}
export interface VadOrtLike {
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<VadOrtSession> };
  Tensor: new (type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: number[]) => unknown;
}

const STATE_SIZE = 2 * 1 * 128;

export class SileroVad {
  private state = new Float32Array(STATE_SIZE);
  private context = new Float32Array(VAD_CONTEXT);
  private pending = new Float32Array(0);
  private constructor(private readonly ort: VadOrtLike, private session: VadOrtSession | null) {}

  /** One small CPU session (one thread: a window takes well under a millisecond). */
  static async open(ort: VadOrtLike, model: Uint8Array): Promise<SileroVad> {
    const session = await ort.InferenceSession.create(model, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
      intraOpNumThreads: 1, interOpNumThreads: 1, extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } });
    if ([...session.inputNames].sort().join() !== 'input,sr,state' || [...session.outputNames].sort().join() !== 'output,stateN') {
      await session.release().catch(() => undefined);
      throw new Error('unexpected VAD inputs or outputs');
    }
    return new SileroVad(ort, session);
  }

  /** A new stream (a new call): forget the recurrent state, the context and any carried samples. */
  reset(): void { this.state = new Float32Array(STATE_SIZE); this.context = new Float32Array(VAD_CONTEXT); this.pending = new Float32Array(0); }

  /** More samples of the stream → one probability per window completed by them (possibly none). */
  async push(samples: Float32Array): Promise<number[]> {
    const session = this.session;
    if (!session) throw new Error('VAD released');
    if (samples.length > VAD_MAX_SAMPLES) throw new Error('too many samples');
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending); all.set(samples, this.pending.length);
    const probs: number[] = [];
    let offset = 0;
    const { Tensor } = this.ort;
    const sr = new Tensor('int64', BigInt64Array.of(BigInt(VAD_RATE)), []);
    for (; offset + VAD_WINDOW <= all.length; offset += VAD_WINDOW) {
      const input = new Float32Array(VAD_CONTEXT + VAD_WINDOW);
      input.set(this.context); input.set(all.subarray(offset, offset + VAD_WINDOW), VAD_CONTEXT);
      const output = await session.run({ input: new Tensor('float32', input, [1, input.length]),
        state: new Tensor('float32', this.state, [2, 1, 128]), sr });
      const probability = Number(output.output?.data[0]), next = output.stateN?.data;
      if (!Number.isFinite(probability) || !next || next.length !== STATE_SIZE) throw new Error('unexpected VAD output');
      this.state = Float32Array.from(next);
      this.context = input.slice(input.length - VAD_CONTEXT);
      probs.push(Math.max(0, Math.min(1, probability)));
    }
    this.pending = all.slice(offset);
    return probs;
  }

  async release(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.release();
  }
}
