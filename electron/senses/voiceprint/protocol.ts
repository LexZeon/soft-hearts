/**
 * Unbound v1 step 3: the messages between the host and the voiceprint process. The host sends the component paths, then one clip of
 * samples at a time; the process answers with 192 numbers or an error. Nothing else (no text, no path, no recording) goes either way.
 */
import { VOICEPRINT_MODEL_SHAPE } from './manifest';

/** At most this many samples per clip (30 s at 16 kHz). */
export const MAX_CLIP_SAMPLES = 480_000;

export type VoiceprintHostToWorker =
  | { type: 'init'; runtimeEntry: string; model: string; modelSize: number; modelSha256: string; threads: number }
  | { type: 'embed'; id: string; samples: Float32Array }
  | { type: 'stop' };
export type VoiceprintWorkerToHost =
  | { type: 'ready'; loadMs: number }
  | { type: 'failed'; reason: 'runtime' | 'model' }
  | { type: 'result'; id: string; vector: Float32Array; ms: number }
  | { type: 'error'; id: string };

const ID = /^vp-\d{1,12}$/;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const samplesOf = (value: unknown): Float32Array | null => {
  if (value instanceof Float32Array) return value.length && value.length <= MAX_CLIP_SAMPLES && value.every(Number.isFinite) ? value : null;
  return null;
};

export function parseVoiceprintHostMessage(value: unknown): VoiceprintHostToWorker | null {
  const m = record(value);
  if (!m) return null;
  if (m.type === 'init' && typeof m.runtimeEntry === 'string' && typeof m.model === 'string' && Number.isSafeInteger(m.modelSize)
    && typeof m.modelSha256 === 'string' && /^[0-9a-f]{64}$/.test(m.modelSha256) && Number.isSafeInteger(m.threads))
    return { type: 'init', runtimeEntry: m.runtimeEntry, model: m.model, modelSize: m.modelSize as number, modelSha256: m.modelSha256, threads: m.threads as number };
  if (m.type === 'embed' && typeof m.id === 'string' && ID.test(m.id)) { const samples = samplesOf(m.samples); return samples ? { type: 'embed', id: m.id, samples } : null; }
  if (m.type === 'stop') return { type: 'stop' };
  return null;
}

export function parseVoiceprintWorkerMessage(value: unknown): VoiceprintWorkerToHost | null {
  const m = record(value);
  if (!m) return null;
  if (m.type === 'ready' && typeof m.loadMs === 'number') return { type: 'ready', loadMs: m.loadMs };
  if (m.type === 'failed' && (m.reason === 'runtime' || m.reason === 'model')) return { type: 'failed', reason: m.reason };
  if (m.type === 'error' && typeof m.id === 'string' && ID.test(m.id)) return { type: 'error', id: m.id };
  if (m.type === 'result' && typeof m.id === 'string' && ID.test(m.id) && typeof m.ms === 'number') {
    const raw = m.vector;
    const vector = raw instanceof Float32Array ? raw : Array.isArray(raw) ? Float32Array.from(raw as number[]) : null;
    if (!vector || vector.length !== VOICEPRINT_MODEL_SHAPE.embedding || !vector.every(Number.isFinite)) return null;
    return { type: 'result', id: m.id, vector, ms: m.ms };
  }
  return null;
}
