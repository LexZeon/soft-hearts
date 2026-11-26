import type { AudioReadingSource } from '../voice';
import { validCounter } from './music-detect/onset'; // direct: this file is inside the senses part (moved from shared/stage/, wiring rewrite step 1)

/** Local energy only: never PCM, a device identity, text or an execution grant. */
export interface AudioDanceSample {
  time: number; rms: number; low: number; mid: number; high: number;
  /** I-072: the computer's sound also sends three running onset counters (numbers in 0..ONSET_WRAP, shared/senses/music-detect/onset.ts); all three or none. */
  onsetLow?: number; onsetMid?: number; onsetHigh?: number;
}
const LEVELS = ['time', 'rms', 'low', 'mid', 'high'], ONSETS = ['onsetLow', 'onsetMid', 'onsetHigh'] as const;
export interface AudioDanceFrame {
  /** null reports analysis failure for this exact lease, withdrawing dance only. */
  id: string; source: AudioReadingSource; revision: number; sample: AudioDanceSample | null;
}
export interface AudioDanceIntent { source: AudioReadingSource; enabled: boolean; }

function object(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property)) return null;
    result[key] = property.value;
  }
  return result;
}
export function parseAudioDanceFrame(value: unknown): AudioDanceFrame | null {
  const frame = object(value, ['id', 'source', 'revision', 'sample']);
  if (!frame || typeof frame.id !== 'string' || !frame.id || frame.id.length > 128 || /[\x00-\x1f\x7f]/.test(frame.id)
    || !['system-audio', 'microphone'].includes(frame.source as string)
    || !Number.isSafeInteger(frame.revision) || (frame.revision as number) < 0) return null;
  if (frame.sample === null) return { id: frame.id, source: frame.source as AudioReadingSource, revision: frame.revision as number, sample: null };
  const counted = typeof frame.sample === 'object' && frame.sample !== null && Reflect.ownKeys(frame.sample).length === LEVELS.length + ONSETS.length;
  const sample = object(frame.sample, counted ? [...LEVELS, ...ONSETS] : LEVELS);
  if (!sample || typeof sample.time !== 'number' || !Number.isFinite(sample.time) || sample.time < 0) return null;
  for (const name of ['rms', 'low', 'mid', 'high'])
    if (typeof sample[name] !== 'number' || !Number.isFinite(sample[name]) || (sample[name] as number) < 0 || (sample[name] as number) > 1) return null;
  if (counted && !ONSETS.every(name => validCounter(sample[name]))) return null;
  return { id: frame.id, source: frame.source as AudioReadingSource, revision: frame.revision as number,
    sample: { time: sample.time, rms: sample.rms as number, low: sample.low as number, mid: sample.mid as number, high: sample.high as number,
      ...(counted ? { onsetLow: sample.onsetLow as number, onsetMid: sample.onsetMid as number, onsetHigh: sample.onsetHigh as number } : {}) } };
}
export function parseAudioDanceIntent(value: unknown): AudioDanceIntent | null {
  const intent = object(value, ['source', 'enabled']);
  return intent && ['system-audio', 'microphone'].includes(intent.source as string) && typeof intent.enabled === 'boolean'
    ? { source: intent.source as AudioReadingSource, enabled: intent.enabled } : null;
}
