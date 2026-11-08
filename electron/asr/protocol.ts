/**
 * Messages between the main process and the speech inference process (utilityProcess). The host validates every
 * message from the process with `parseAsrWorkerMessage`; anything else is dropped. Text goes back only as the answer
 * to one recognize request; the process never sees chat, settings or the network.
 */
import { ASR_LANGUAGES, type AsrLanguage } from './engine';
import { ASR_EMOTION_TAGS, ASR_EVENT_TAGS, ASR_LANGUAGE_TAGS, type AsrTags } from './decode';

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
   * `wav`: a checked 16 kHz mono PCM16 WAV (electron/asr.ts validateWav). `tags`: also send back the whitelisted
   * language / event / emotion tags (listening and watching transcription asks; voice input does not).
   */
  | { type: 'recognize'; id: string; wav: ArrayBuffer; language: AsrLanguage; tags?: true }
  | { type: 'stop' };

export type AsrWorkerToHost =
  | { type: 'ready'; loadMs: number }
  | { type: 'result'; id: string; text: string; ms: number; tags?: AsrTags }
  | { type: 'error'; id: string }
  | { type: 'failed'; reason: 'runtime' | 'model' };

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
    default: return null;
  }
}

/** The tags of one result: exactly these three keys, each null or a member of its closed list (electron/asr/decode.ts). */
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
