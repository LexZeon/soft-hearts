/** Host facts for ambient-owned consumers only. No capture or device authority. */
export const audioReadingSources = ['system-audio', 'microphone'] as const;
export const audioReadingPurposes = ['music', 'movie'] as const;
export type AudioReadingSource = typeof audioReadingSources[number];
export type AudioReadingPurpose = typeof audioReadingPurposes[number];
export type AudioReadingPhase = 'off' | 'waiting' | 'ready' | 'paused' | 'error';
export interface AudioReadingIntent { source: AudioReadingSource; purpose: AudioReadingPurpose; enabled: boolean }
export interface AudioReadingCell { revision: number; intent: boolean; phase: AudioReadingPhase; status: string }
export interface AudioReadingCapture { revision: number; active: boolean; phase: AudioReadingPhase; status: string }
export interface AudioReadingOverall { revision: number; active: boolean; status: string }
export interface AudioReadingSourceView { capture: AudioReadingCapture; music: AudioReadingCell; movie: AudioReadingCell }
export interface AudioReadingView {
  scopeId: string;
  sources: Record<AudioReadingSource, AudioReadingSourceView>;
  overall: AudioReadingOverall;
}
/** An ack contains only the requested cell, never replacement intents for other cells. */
export interface AudioReadingAck {
  scopeId: string; source: AudioReadingSource; purpose: AudioReadingPurpose;
  accepted: boolean; cell: AudioReadingCell; capture: AudioReadingCapture; overall: AudioReadingOverall;
}
export interface AudioReadingActions {
  setIntent(source: AudioReadingSource, purpose: AudioReadingPurpose, enabled: boolean): Promise<AudioReadingAck>;
}
type Data = Record<string, unknown>;
function record(value: unknown, keys: readonly string[]): Data | undefined {
  if (!value || typeof value !== 'object') return;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return;
  const data: Data = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return;
    data[key] = descriptor.value;
  }
  return data;
}
const revision = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const scope = (v: unknown): v is string => text(v, 128) && v.length > 0;
const source = (v: unknown): v is AudioReadingSource => audioReadingSources.includes(v as AudioReadingSource);
const purpose = (v: unknown): v is AudioReadingPurpose => audioReadingPurposes.includes(v as AudioReadingPurpose);
const phase = (v: unknown): v is AudioReadingPhase => ['off', 'waiting', 'ready', 'paused', 'error'].includes(v as string);
function cell(value: unknown): AudioReadingCell | undefined {
  const v = record(value, ['revision', 'intent', 'phase', 'status']);
  if (!v || !revision(v.revision) || typeof v.intent !== 'boolean' || !phase(v.phase) || !text(v.status, 240)) return;
  if ((!v.intent && v.phase !== 'off') || (v.intent && v.phase === 'off')) return;
  return { revision: v.revision, intent: v.intent, phase: v.phase, status: v.status };
}
function capture(value: unknown): AudioReadingCapture | undefined {
  const v = record(value, ['revision', 'active', 'phase', 'status']);
  if (!v || !revision(v.revision) || typeof v.active !== 'boolean' || !phase(v.phase) || !text(v.status, 240)) return;
  if (v.active !== (v.phase === 'ready')) return;
  return { revision: v.revision, active: v.active, phase: v.phase, status: v.status };
}
function overall(value: unknown): AudioReadingOverall | undefined {
  const v = record(value, ['revision', 'active', 'status']);
  if (!v || !revision(v.revision) || typeof v.active !== 'boolean' || !text(v.status, 240)) return;
  return { revision: v.revision, active: v.active, status: v.status };
}
/** Reject extra capability fields, coercion, accessors and non-data shapes. */
export function parseAudioReadingIntent(value: unknown): AudioReadingIntent | undefined {
  const v = record(value, ['source', 'purpose', 'enabled']);
  if (!v || !source(v.source) || !purpose(v.purpose) || typeof v.enabled !== 'boolean') return;
  return { source: v.source, purpose: v.purpose, enabled: v.enabled };
}
export function parseAudioReadingView(value: unknown): AudioReadingView | undefined {
  const v = record(value, ['scopeId', 'sources', 'overall']);
  if (!v || !scope(v.scopeId)) return;
  const sources = record(v.sources, audioReadingSources), total = overall(v.overall);
  if (!sources || !total) return;
  const parsed = {} as Record<AudioReadingSource, AudioReadingSourceView>;
  for (const key of audioReadingSources) {
    const s = record(sources[key], ['capture', 'music', 'movie']);
    if (!s) return;
    const c = capture(s.capture), music = cell(s.music), movie = cell(s.movie);
    if (!c || !music || !movie) return;
    parsed[key] = { capture: c, music, movie };
  }
  return { scopeId: v.scopeId, sources: parsed, overall: total };
}
export function parseAudioReadingAck(value: unknown): AudioReadingAck | undefined {
  const v = record(value, ['scopeId', 'source', 'purpose', 'accepted', 'cell', 'capture', 'overall']);
  if (!v || !scope(v.scopeId) || !source(v.source) || !purpose(v.purpose) || typeof v.accepted !== 'boolean') return;
  const c = cell(v.cell), cap = capture(v.capture), total = overall(v.overall);
  if (!c || !cap || !total) return;
  return { scopeId: v.scopeId, source: v.source, purpose: v.purpose, accepted: v.accepted, cell: c, capture: cap, overall: total };
}
/** No saved consent is restored. Host assigns a fresh scope before accepting input. */
export function createAudioReadingView(scopeId: string): AudioReadingView {
  if (!scope(scopeId)) throw new TypeError('Invalid audio reading scope');
  const make = (): AudioReadingSourceView => ({
    capture: { revision: 0, active: false, phase: 'off', status: '' },
    music: { revision: 0, intent: false, phase: 'off', status: '' },
    movie: { revision: 0, intent: false, phase: 'off', status: '' },
  });
  return { scopeId, sources: { 'system-audio': make(), microphone: make() }, overall: { revision: 0, active: false, status: '' } };
}
