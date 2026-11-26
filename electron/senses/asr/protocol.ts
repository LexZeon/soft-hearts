/**
 * Messages between the main process and the speech inference process (utilityProcess). The host validates every
 * message from the process with `parseAsrWorkerMessage`; anything else is dropped. Text goes back only as the answer
 * to one recognize request; the process never sees chat, settings or the network.
 */
import { ASR_LANGUAGES, type AsrLanguage } from './engine';
import { ASR_EMOTION_TAGS, ASR_EVENT_TAGS, ASR_LANGUAGE_TAGS, type AsrTags } from './decode';
import { VAD_MAX_PROBS, VAD_MAX_SAMPLES } from './vad';
import { TURN_MAX_SAMPLES } from './smart-turn';

export interface AsrWorkerInit {
  type: 'init';
  /** Absolute path of the onnxruntime-node package folder inside the component directory. */
  runtimeEntry: string;
  model: string; modelSize: number; modelSha256: string;
  tokens: string; tokensSha256: string;
  threads: number;
}
export type AsrHostToWorker =
  | AsrWorkerInit
  /**
   * `wav`: a checked 16 kHz mono PCM16 WAV (electron/senses/asr.ts validateWav). `tags`: also send back the whitelisted
   * language / event / emotion tags (listening and watching transcription asks; voice input does not).
   */
  | { type: 'recognize'; id: string; wav: ArrayBuffer; language: AsrLanguage; tags?: true }
  /**
   * I-099, calls only: load the Silero VAD from these bytes (the bundled official file, checked by the main process and again
   * here), then the call's microphone as 16 kHz float samples, one chunk per request (`reset`: a new call's stream).
   */
  | { type: 'vad-init'; model: ArrayBuffer; sha256: string }
  | { type: 'vad'; id: string; pcm: Float32Array; reset: boolean }
  /**
   * I-099/I-100, calls only: load Smart Turn v3.2 from these bytes (the bundled official file, checked by the main process and
   * again here); then the last seconds of the user's turn (16 kHz float samples) → the probability that the turn is complete.
   */
  | { type: 'turn-init'; model: ArrayBuffer; sha256: string }
  | { type: 'turn'; id: string; pcm: Float32Array }
  | { type: 'stop' };

export type AsrWorkerToHost =
  | { type: 'ready'; loadMs: number }
  | { type: 'result'; id: string; text: string; ms: number; tags?: AsrTags }
  | { type: 'error'; id: string }
  | { type: 'failed'; reason: 'runtime' | 'model' }
  /** I-099: the VAD is loaded / could not load; one chunk's probabilities (numbers in [0, 1] only) or none. */
  | { type: 'vad-ready' }
  | { type: 'vad-failed' }
  | { type: 'vad-result'; id: string; probs: number[] }
  | { type: 'vad-error'; id: string }
  /** I-099/I-100: Smart Turn is loaded / could not load; one turn's probability (a number in [0, 1] only) or none. */
  | { type: 'turn-ready' }
  | { type: 'turn-failed' }
  | { type: 'turn-result'; id: string; p: number }
  | { type: 'turn-error'; id: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join() === [...expected].sort().join();
const ms = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 600_000;

export function parseAsrWorkerMessage(value: unknown): AsrWorkerToHost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'ready': return keys(v, ['type', 'loadMs']) && ms(v.loadMs) ? { type: 'ready', loadMs: v.loadMs } : null;
    case 'result': {
      const tagged = Object.hasOwn(v, 'tags'), tags = tagged ? parseAsrTags(v.tags) : undefined;
      return keys(v, tagged ? ['type', 'id', 'text', 'ms', 'tags'] : ['type', 'id', 'text', 'ms']) && (!tagged || tags) && typeof v.id === 'string'
        && ID.test(v.id) && typeof v.text === 'string' && v.text.length <= 4000 && !v.text.includes('\0') && ms(v.ms)
        ? { type: 'result', id: v.id, text: v.text, ms: v.ms, ...(tags ? { tags } : {}) } : null;
    }
    case 'error': return keys(v, ['type', 'id']) && typeof v.id === 'string' && ID.test(v.id) ? { type: 'error', id: v.id } : null;
    case 'failed': return keys(v, ['type', 'reason']) && (v.reason === 'runtime' || v.reason === 'model') ? { type: 'failed', reason: v.reason } : null;
    case 'vad-ready': return keys(v, ['type']) ? { type: 'vad-ready' } : null;
    case 'vad-failed': return keys(v, ['type']) ? { type: 'vad-failed' } : null;
    case 'vad-result': return keys(v, ['type', 'id', 'probs']) && typeof v.id === 'string' && ID.test(v.id) && Array.isArray(v.probs)
      && v.probs.length <= VAD_MAX_PROBS && v.probs.every(p => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1)
      ? { type: 'vad-result', id: v.id, probs: [...v.probs] as number[] } : null;
    case 'vad-error': return keys(v, ['type', 'id']) && typeof v.id === 'string' && ID.test(v.id) ? { type: 'vad-error', id: v.id } : null;
    case 'turn-ready': return keys(v, ['type']) ? { type: 'turn-ready' } : null;
    case 'turn-failed': return keys(v, ['type']) ? { type: 'turn-failed' } : null;
    case 'turn-result': return keys(v, ['type', 'id', 'p']) && typeof v.id === 'string' && ID.test(v.id) && typeof v.p === 'number' && Number.isFinite(v.p) && v.p >= 0 && v.p <= 1
      ? { type: 'turn-result', id: v.id, p: v.p } : null;
    case 'turn-error': return keys(v, ['type', 'id']) && typeof v.id === 'string' && ID.test(v.id) ? { type: 'turn-error', id: v.id } : null;
    default: return null;
  }
}

/** The tags of one result: exactly these three keys, each null or a member of its closed list (electron/senses/asr/decode.ts). */
export function parseAsrTags(value: unknown): AsrTags | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const pick = <T extends string>(list: readonly T[], item: unknown): item is T | null => item === null || (list as readonly unknown[]).includes(item);
  return keys(v, ['language', 'event', 'emotion']) && pick(ASR_LANGUAGE_TAGS, v.language) && pick(ASR_EVENT_TAGS, v.event)
    && pick(ASR_EMOTION_TAGS, v.emotion) ? { language: v.language, event: v.event, emotion: v.emotion } : null;
}

/** The worker's side: only well-formed requests are acted on. */
export function parseAsrHostMessage(value: unknown): AsrHostToWorker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'stop') return { type: 'stop' };
  if (v.type === 'vad-init') {
    const raw = v.model, model = raw instanceof ArrayBuffer ? raw : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice().buffer : null;
    return model && model.byteLength > 0 && model.byteLength <= 8_000_000 && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)
      ? { type: 'vad-init', model, sha256: v.sha256 } : null;
  }
  if (v.type === 'turn-init') {
    const raw = v.model, model = raw instanceof ArrayBuffer ? raw : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice().buffer : null;
    return model && model.byteLength > 0 && model.byteLength <= 20_000_000 && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256)
      ? { type: 'turn-init', model, sha256: v.sha256 } : null;
  }
  if (v.type === 'turn') {
    const pcm = checkedTurnPcm(v.pcm);
    return typeof v.id === 'string' && ID.test(v.id) && pcm ? { type: 'turn', id: v.id, pcm } : null;
  }
  if (v.type === 'vad') {
    const pcm = checkedPcm(v.pcm);
    return typeof v.id === 'string' && ID.test(v.id) && pcm && typeof v.reset === 'boolean' ? { type: 'vad', id: v.id, pcm, reset: v.reset } : null;
  }
  if (v.type === 'recognize') {
    const raw = v.wav; // an ArrayBuffer; a typed-array view is accepted too (structured clone may hand either)
    const wav = raw instanceof ArrayBuffer ? raw : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice().buffer : null;
    return typeof v.id === 'string' && ID.test(v.id) && wav && wav.byteLength <= 4_000_000
      && (ASR_LANGUAGES as readonly unknown[]).includes(v.language) && (v.tags === undefined || v.tags === true)
      ? { type: 'recognize', id: v.id, wav, language: v.language as AsrLanguage, ...(v.tags === true ? { tags: true as const } : {}) } : null;
  }
  if (v.type === 'init') {
    const text = (key: string) => typeof v[key] === 'string' && (v[key] as string).length < 4096;
    return text('runtimeEntry') && text('model') && text('tokens') && typeof v.modelSha256 === 'string' && /^[0-9a-f]{64}$/.test(v.modelSha256)
      && typeof v.tokensSha256 === 'string' && /^[0-9a-f]{64}$/.test(v.tokensSha256) && Number.isSafeInteger(v.modelSize) && (v.modelSize as number) > 0
      && Number.isInteger(v.threads) && (v.threads as number) >= 1 && (v.threads as number) <= 8 ? v as unknown as AsrWorkerInit : null;
  }
  return null;
}

/** I-099: one chunk of 16 kHz float samples for the VAD (1 to VAD_MAX_SAMPLES finite values), copied; anything else is null. */
export function checkedPcm(value: unknown): Float32Array | null {
  if (!(value instanceof Float32Array) || value.length < 1 || value.length > VAD_MAX_SAMPLES) return null;
  for (const sample of value) if (!Number.isFinite(sample) || Math.abs(sample) > 16) return null;
  return value.slice();
}

/** I-099/I-100: the user's turn for Smart Turn (1 to TURN_MAX_SAMPLES finite values = at most 8 s at 16 kHz), copied; anything else is null. */
export function checkedTurnPcm(value: unknown): Float32Array | null {
  if (!(value instanceof Float32Array) || value.length < 1 || value.length > TURN_MAX_SAMPLES) return null;
  for (const sample of value) if (!Number.isFinite(sample) || Math.abs(sample) > 16) return null;
  return value.slice();
}
