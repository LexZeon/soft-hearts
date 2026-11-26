// Fakes for the recall-by-meaning tests: a concept-based embedder (so that "meaning" is exactly what the test says it is, and a negation
// or a namesake can be given the highest similarity on purpose), a fake onnxruntime, and a fake component store. No model, no network.
import { EMBEDDING_DIMS } from '../../electron/memory/memory-semantic/engine';
import type { EmbedOrtLike } from '../../electron/memory/memory-semantic/engine';

/** concept -> words that mean it (the "synonyms" of the test world). */
export const CONCEPTS: Record<string, string[]> = {
  cat: ['猫', '团子', '橘', '喵'],
  dog: ['狗', '柴犬', '遛'],
  nuts: ['花生', '坚果', '过敏', '疹子'],
  japan: ['东京', '日本', '出差'],
  job: ['面试', '求职', '找工作', '被拒'],
  guitar: ['吉他', '乐器', '弹琴'],
  home: ['搬到', '住在', '城市', '公寓'],
  sleep: ['失眠', '睡不着', '睡眠'],
};
const NAMES = Object.keys(CONCEPTS);

/** One unit vector per text: one dimension per concept it contains, plus a small deterministic bump from its characters so no two texts are identical. */
export function conceptVector(text: string, noise = true): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMS);
  NAMES.forEach((name, index) => { if (CONCEPTS[name].some(word => text.includes(word))) v[index] = 1; });
  if (noise || !v.some(x => x)) {
    let h = 7;
    for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
    v[100 + (h % 300)] += noise ? 0.12 : 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export interface FakeEmbedder { embed(texts: string[]): Promise<Float32Array[]>; calls: string[][]; fail: boolean; delay: number }
/** `noise` false: two texts with the same concepts are exactly equal (for tests about ties and ordering). */
export function fakeEmbedder(noise = false): FakeEmbedder {
  const value: FakeEmbedder = { calls: [], fail: false, delay: 0,
    async embed(texts) {
      value.calls.push([...texts]);
      if (value.delay) await new Promise(resolve => setTimeout(resolve, value.delay));
      if (value.fail) throw new Error('model gone');
      return texts.map(text => conceptVector(text, noise));
    } };
  return value;
}

/** A fake onnxruntime whose "model" returns the concept vector at the [CLS] position (so the engine's whole path can be run). */
export function fakeEmbedOrt(options: { inputs?: string[]; dims?: number } = {}): { ort: EmbedOrtLike; created: string[]; fed: Record<string, bigint[][]>[]; released: { count: number } } {
  const created: string[] = [], fed: Record<string, bigint[][]>[] = [], released = { count: 0 };
  const ort: EmbedOrtLike = {
    Tensor: class { constructor(public type: string, public data: BigInt64Array, public dims: number[]) {} } as never,
    InferenceSession: { async create(model) {
      created.push(model);
      return {
        inputNames: options.inputs ?? ['input_ids', 'attention_mask', 'token_type_ids'], outputNames: ['last_hidden_state'],
        async run(feeds) {
          const ids = feeds.input_ids as { data: BigInt64Array; dims: number[] };
          const [batch, steps] = ids.dims;
          fed.push({ input_ids: Array.from({ length: batch }, (_, b) => Array.from(ids.data.slice(b * steps, (b + 1) * steps))) });
          const dims = options.dims ?? EMBEDDING_DIMS;
          const data = new Float32Array(batch * steps * dims);
          for (let b = 0; b < batch; b++) data[b * steps * dims] = 3 + b; // the [CLS] row: not unit length on purpose
          return { last_hidden_state: { data, dims: [batch, steps, dims] } };
        },
        async release() { released.count++; },
      };
    } },
  };
  return { ort, created, fed, released };
}
