/**
 * I-135: messages between the main process and the face-check utility process. Both directions are validated key by key;
 * anything else is dropped. The process gets component paths and small RGBA frames and answers with numbers only: the
 * measurements and the 128-number embedding of the largest face (which never leaves the host: compared there, and stored
 * only encrypted when the user enrols).
 */
import { EMBEDDING_SIZE } from './score';

export interface FaceWorkerInit {
  type: 'init';
  /** Absolute path of the onnxruntime-node package folder inside the component directory. */
  runtimeEntry: string;
  detector: string; detectorSize: number; detectorSha256: string;
  recognizer: string; recognizerSize: number; recognizerSha256: string;
  threads: number;
}
export type FaceHostToWorker =
  | FaceWorkerInit
  | { type: 'analyze'; id: string; width: number; height: number; data: ArrayBuffer }
  | { type: 'stop' };

export interface FaceResultMessage {
  type: 'result'; id: string;
  found: boolean; detScore: number; faceWidth: number; frontal: number; sharpness: number; brightness: number;
  embedding: number[] | null;
  ms: number;
  /** The face's box in the frame's pixels [x, y, width, height]; only the enrolment preview reads it. */
  box?: [number, number, number, number];
}
export type FaceWorkerToHost =
  | { type: 'ready'; loadMs: number }
  | { type: 'failed'; reason: 'runtime' | 'model' }
  | FaceResultMessage
  | { type: 'error'; id: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[0-9a-f]{64}$/;
export const FACE_FRAME_MAX = Object.freeze({ width: 640, height: 480 });
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join() === [...expected].sort().join();
const num = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export function parseFaceWorkerMessage(value: unknown): FaceWorkerToHost | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'ready': return keys(v, ['type', 'loadMs']) && num(v.loadMs, 0, 600_000) ? { type: 'ready', loadMs: v.loadMs } : null;
    case 'failed': return keys(v, ['type', 'reason']) && (v.reason === 'runtime' || v.reason === 'model') ? { type: 'failed', reason: v.reason } : null;
    case 'error': return keys(v, ['type', 'id']) && typeof v.id === 'string' && ID.test(v.id) ? { type: 'error', id: v.id } : null;
    case 'result': {
      const base = ['type', 'id', 'found', 'detScore', 'faceWidth', 'frontal', 'sharpness', 'brightness', 'embedding', 'ms'];
      if (!keys(v, base) && !keys(v, [...base, 'box'])) return null;
      let box: [number, number, number, number] | undefined;
      if ('box' in v) {
        if (!Array.isArray(v.box) || v.box.length !== 4 || !v.box.every(n => num(n, -1e5, 1e5))) return null;
        box = v.box as [number, number, number, number];
      }
      if (typeof v.id !== 'string' || !ID.test(v.id) || typeof v.found !== 'boolean') return null;
      if (!num(v.detScore, 0, 1) || !num(v.faceWidth, 0, 10_000) || !num(v.frontal, 0, 1) || !num(v.sharpness, 0, 1e7)
        || !num(v.brightness, 0, 255) || !num(v.ms, 0, 600_000)) return null;
      let embedding: number[] | null = null;
      if (v.embedding !== null) {
        if (!Array.isArray(v.embedding) || v.embedding.length !== EMBEDDING_SIZE || !v.embedding.every(n => num(n, -1e6, 1e6))) return null;
        embedding = v.embedding as number[];
      }
      if (v.found !== (embedding !== null)) return null;
      return { type: 'result', id: v.id, found: v.found, detScore: v.detScore, faceWidth: v.faceWidth, frontal: v.frontal,
        sharpness: v.sharpness, brightness: v.brightness, embedding, ms: v.ms, ...(box ? { box } : {}) };
    }
    default: return null;
  }
}

/** RGBA frame for one analysis: at most 640×480 and exactly width·height·4 bytes. */
export function parseFaceFrame(width: unknown, height: unknown, data: unknown): { width: number; height: number; rgba: Uint8Array } | null {
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 16 || height < 16 || width > FACE_FRAME_MAX.width || height > FACE_FRAME_MAX.height) return null;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
  return bytes && bytes.byteLength === width * height * 4 ? { width, height, rgba: bytes } : null;
}

export function parseFaceHostMessage(value: unknown): FaceHostToWorker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'init':
      if (!keys(v, ['type', 'runtimeEntry', 'detector', 'detectorSize', 'detectorSha256', 'recognizer', 'recognizerSize', 'recognizerSha256', 'threads'])) return null;
      if (typeof v.runtimeEntry !== 'string' || typeof v.detector !== 'string' || typeof v.recognizer !== 'string') return null;
      if (!num(v.detectorSize, 1, 1e9) || !num(v.recognizerSize, 1, 1e9) || typeof v.detectorSha256 !== 'string' || !SHA.test(v.detectorSha256)
        || typeof v.recognizerSha256 !== 'string' || !SHA.test(v.recognizerSha256) || !num(v.threads, 1, 8)) return null;
      return v as unknown as FaceWorkerInit;
    case 'analyze': {
      if (!keys(v, ['type', 'id', 'width', 'height', 'data']) || typeof v.id !== 'string' || !ID.test(v.id)) return null;
      const frame = parseFaceFrame(v.width, v.height, v.data);
      return frame ? { type: 'analyze', id: v.id, width: frame.width, height: frame.height, data: v.data as ArrayBuffer } : null;
    }
    case 'stop': return keys(v, ['type']) ? { type: 'stop' } : null;
    default: return null;
  }
}
