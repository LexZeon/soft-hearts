/**
 * BGE-small-zh-v1.5 inside the embedding process: tokens (tokenizer.ts) -> ONNX Runtime on the CPU -> the [CLS] vector of the
 * last hidden state (the model's own pooling) -> length 1. `ort` is injected (onnxruntime-node from the component folder in the
 * app; a fake in tests). CPU only, like the speech process.
 */
import { WordPieceTokenizer } from './tokenizer';

export interface EmbedOrtTensor { data: ArrayLike<number>; dims: readonly number[] }
export interface EmbedOrtSession {
  inputNames: readonly string[]; outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, EmbedOrtTensor>>;
  release(): Promise<void>;
}
export interface EmbedOrtLike {
  InferenceSession: { create(model: string, options: Record<string, unknown>): Promise<EmbedOrtSession> };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;
}

export const EMBEDDING_DIMS = 512;
/** Longer text is cut (memories are summarised to a few lines before they get here). */
export const MAX_TOKENS = 128;

export function cpuSessionOptions(threads: number): Record<string, unknown> {
  return { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3,
    intraOpNumThreads: Math.max(1, Math.min(8, Math.round(threads))), interOpNumThreads: 1,
    extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } } };
}

/** The [CLS] row of each text, divided by its length. Pure (tested without a model). */
export function clsVectors(data: ArrayLike<number>, batch: number, steps: number, dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    const v = new Float32Array(dims);
    let norm = 0;
    for (let d = 0; d < dims; d++) { const x = Number(data[b * steps * dims + d]); v[d] = x; norm += x * x; }
    norm = Math.sqrt(norm);
    if (!(norm > 0) || !Number.isFinite(norm)) throw new Error('embedding is empty');
    for (let d = 0; d < dims; d++) v[d] /= norm;
    out.push(v);
  }
  return out;
}

export class EmbeddingEngine {
  private constructor(private readonly ort: EmbedOrtLike, private session: EmbedOrtSession | null, private readonly tokenizer: WordPieceTokenizer) {}

  static async open(ort: EmbedOrtLike, modelPath: string, vocabText: string, threads = 2): Promise<EmbeddingEngine> {
    const tokenizer = new WordPieceTokenizer(vocabText);
    const session = await ort.InferenceSession.create(modelPath, cpuSessionOptions(threads));
    const inputs = [...session.inputNames].sort().join();
    if (inputs !== 'attention_mask,input_ids,token_type_ids' || !session.outputNames.length) {
      await session.release().catch(() => undefined);
      throw new Error('unexpected model inputs or outputs');
    }
    return new EmbeddingEngine(ort, session, tokenizer);
  }

  /** One unit-length 512-number vector per text, in order. */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const session = this.session;
    if (!session) throw new Error('embedder released');
    if (!texts.length) return [];
    const rows = texts.map(text => this.tokenizer.encode(text, MAX_TOKENS));
    const steps = Math.max(...rows.map(row => row.length));
    const ids = new BigInt64Array(rows.length * steps), mask = new BigInt64Array(rows.length * steps), types = new BigInt64Array(rows.length * steps);
    rows.forEach((row, b) => row.forEach((id, i) => { ids[b * steps + i] = BigInt(id); mask[b * steps + i] = 1n; }));
    const dims = [rows.length, steps];
    const { Tensor } = this.ort;
    const output = await session.run({ input_ids: new Tensor('int64', ids, dims), attention_mask: new Tensor('int64', mask, dims), token_type_ids: new Tensor('int64', types, dims) });
    const hidden = output[session.outputNames[0]!];
    const [batch, outSteps, width] = hidden?.dims ?? [];
    if (!hidden || batch !== rows.length || outSteps !== steps || width !== EMBEDDING_DIMS) throw new Error('unexpected model output');
    return clsVectors(hidden.data, batch, steps, width);
  }

  async release(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.release();
  }
}
