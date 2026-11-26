/**
 * Messages between the main process and the embedding process (utilityProcess). The host validates every message from the
 * process with `parseSemanticWorkerMessage`; anything else is dropped. Text goes in only as the texts of one embed request
 * (a few short memory summaries or the user's line) and comes back only as numbers; the process never sees settings or the
 * network.
 */
import { EMBEDDING_DIMS } from './engine';

export const MAX_TEXTS = 32;
export const MAX_TEXT_CHARS = 1_000;

export interface SemanticWorkerInit {
  type: 'init';
  runtimeEntry: string;
  model: string; modelSize: number; modelSha256: string;
  vocab: string; vocabSha256: string;
  threads: number;
}
export type SemanticHostToWorker =
  | SemanticWorkerInit
  | { type: 'embed'; id: string; texts: string[] }
  | { type: 'stop' };

export type SemanticWorkerToHost =
  | { type: 'ready'; loadMs: number }
  /** `vectors`: one Float32Array of EMBEDDING_DIMS unit-length numbers per text, in order. */
  | { type: 'result'; id: string; vectors: Float32Array[]; ms: number }
  | { type: 'error'; id: string }
  | { type: 'failed'; reason: 'runtime' | 'model' };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join() === [...expected].sort().join();
const ms = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 600_000;

function asVector(value: unknown): Float32Array | null {
  let vector: Float32Array | null = null;
  if (value instanceof Float32Array) vector = value;
  else if (ArrayBuffer.isView(value) && value.byteLength === EMBEDDING_DIMS * 4) vector = new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (!vector || vector.length !== EMBEDDING_DIMS) return null;
  let norm = 0;
  for (const x of vector) { if (!Number.isFinite(x)) return null; norm += x * x; }
  return Math.abs(Math.sqrt(norm) - 1) < 0.01 ? vector : null;
}

export function parseSemanticWorkerMessage(value: unknown): SemanticWorkerToHost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'ready': return keys(v, ['type', 'loadMs']) && ms(v.loadMs) ? { type: 'ready', loadMs: v.loadMs } : null;
    case 'result': {
      if (!keys(v, ['type', 'id', 'vectors', 'ms']) || typeof v.id !== 'string' || !ID.test(v.id) || !ms(v.ms) || !Array.isArray(v.vectors) || v.vectors.length > MAX_TEXTS) return null;
      const vectors = v.vectors.map(asVector);
      return vectors.every((vector): vector is Float32Array => !!vector) ? { type: 'result', id: v.id, vectors, ms: v.ms } : null;
    }
    case 'error': return keys(v, ['type', 'id']) && typeof v.id === 'string' && ID.test(v.id) ? { type: 'error', id: v.id } : null;
    case 'failed': return keys(v, ['type', 'reason']) && (v.reason === 'runtime' || v.reason === 'model') ? { type: 'failed', reason: v.reason } : null;
    default: return null;
  }
}

/** The worker's side: only well-formed requests are acted on. */
export function parseSemanticHostMessage(value: unknown): SemanticHostToWorker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'stop') return { type: 'stop' };
  if (v.type === 'embed') {
    return typeof v.id === 'string' && ID.test(v.id) && Array.isArray(v.texts) && v.texts.length >= 1 && v.texts.length <= MAX_TEXTS
      && v.texts.every(text => typeof text === 'string' && text.length <= MAX_TEXT_CHARS && !text.includes('\0'))
      ? { type: 'embed', id: v.id, texts: v.texts as string[] } : null;
  }
  if (v.type === 'init') {
    const text = (key: string) => typeof v[key] === 'string' && (v[key] as string).length < 4096;
    const hex = (key: string) => typeof v[key] === 'string' && /^[0-9a-f]{64}$/.test(v[key] as string);
    return text('runtimeEntry') && text('model') && text('vocab') && hex('modelSha256') && hex('vocabSha256') && Number.isSafeInteger(v.modelSize) && (v.modelSize as number) > 0
      && Number.isInteger(v.threads) && (v.threads as number) >= 1 && (v.threads as number) <= 8 ? v as unknown as SemanticWorkerInit : null;
  }
  return null;
}
