import type { AudioReadingSource } from './audio-reading-toggles';

/** Finite, host-issued identities; none grants a renderer path or device choice. */
export interface ReadingCaptureToken {
  scopeId: string; source: AudioReadingSource; epoch: number; captureId: string;
}
export interface AudioCaptureDescriptor {
  id: string; source: AudioReadingSource; owner: 'controls' | 'pet'; revision: number;
  chat: boolean; dance: boolean; ambient: ReadingCaptureToken | null;
}
export interface AudioCaptureState {
  revision: number;
  slots: Record<AudioReadingSource, AudioCaptureDescriptor | null>;
}
export interface AudioCaptureAck {
  id: string; source: AudioReadingSource; revision: number;
  phase: 'ready' | 'released' | 'lost';
}
export interface AudioReadingPcm {
  token: ReadingCaptureToken; captureRevision: number; sequence: number; startedAtMs: number; pcm16: ArrayBuffer;
}
export interface AudioReadingPcmAck { accepted: boolean; reason?: string; segmentId?: string; }

const sources = ['system-audio', 'microphone'];
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\x00-\x1f\x7f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function data(value: unknown, names: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(k => typeof k !== 'string' || !names.includes(k))) return null;
  const out: Record<string, unknown> = {};
  for (const key of names) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) return null;
    out[key] = d.value;
  }
  return out;
}
export function parseReadingCaptureToken(value: unknown): ReadingCaptureToken | null {
  const v = data(value, ['scopeId', 'source', 'epoch', 'captureId']);
  if (!v || !id(v.scopeId) || !sources.includes(v.source as string) || !integer(v.epoch) || v.epoch < 1 || !id(v.captureId)) return null;
  return { scopeId: v.scopeId, source: v.source as AudioReadingSource, epoch: v.epoch, captureId: v.captureId };
}
export function parseAudioCaptureAck(value: unknown): AudioCaptureAck | null {
  const v = data(value, ['id', 'source', 'revision', 'phase']);
  if (!v || !id(v.id) || !sources.includes(v.source as string) || !integer(v.revision)
    || !['ready', 'released', 'lost'].includes(v.phase as string)) return null;
  return { id: v.id, source: v.source as AudioReadingSource, revision: v.revision, phase: v.phase as AudioCaptureAck['phase'] };
}
export function parseAudioReadingPcm(value: unknown): AudioReadingPcm | null {
  const v = data(value, ['token', 'captureRevision', 'sequence', 'startedAtMs', 'pcm16']);
  const token = v && parseReadingCaptureToken(v.token);
  if (!v || !token || !integer(v.captureRevision) || !integer(v.sequence) || v.sequence < 1 || !integer(v.startedAtMs)
    || !(v.pcm16 instanceof ArrayBuffer) || !v.pcm16.byteLength || v.pcm16.byteLength % 2 || v.pcm16.byteLength > 384000) return null;
  return { token, captureRevision: v.captureRevision, sequence: v.sequence, startedAtMs: v.startedAtMs, pcm16: v.pcm16 };
}
