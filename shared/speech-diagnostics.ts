/**
 * R02 developer-mode speech diagnostics: one record per utterance or reply
 * segment. Records carry timings, counts, the provider and voice ID only:
 * never text, reply IDs, instructions, paths or credentials.
 *
 * Clocks: every value in `t` is renderer `performance.now()` milliseconds
 * relative to the record's `queued` stage, so all of them are on ONE clock.
 * Host measurements (a different process and clock origin) are carried only as
 * durations, never as absolute times. IPC send is not arrival, and
 * `scheduled` (source.start called) is not `playbackStart` (the audio clock
 * reached the first sample, or the system engine reported its start).
 */
export const SPEECH_DIAGNOSTIC_STAGES = [
  /** The text was accepted for playback (renderer). */
  'queued',
  /** Host playback-activity lease IPC (sleep blocker), when the host requires one. */
  'leaseStart', 'leaseEnd',
  /** Character preview preparation IPC (persona and mood style), previews only. */
  'prepareStart', 'prepareEnd',
  /** Audio output acquisition (AudioContext create/resume) for this playback. */
  'deviceStart', 'deviceEnd',
  /** Cloud: synthesizeSpeech invoked. System: utterance handed to the engine. */
  'request',
  /** Cloud: first PCM event arrived in the renderer. */
  'firstPacket',
  /** Cloud: first AudioBufferSourceNode.start() called for this segment. */
  'scheduled',
  /** Cloud: audio clock reached the first sample. System: engine start event. */
  'playbackStart',
  /** System: first word boundary event (proof of progress). */
  'firstBoundary',
  'ended', 'error', 'cancelled',
  /** First mouth open and last mouth close attributed to this record. */
  'lipSyncStart', 'lipSyncStop',
] as const;
export type SpeechDiagnosticStage = typeof SPEECH_DIAGNOSTIC_STAGES[number];

export interface SpeechDiagnosticRecord {
  v: 1;
  provider: 'system' | 'bailian';
  /** Bailian voice ID or the system voiceURI; bounded, no text. */
  voice: string;
  kind: 'reply' | 'speech' | 'preview';
  segmentIndex: number | null;
  /** UTF-16 length of the spoken text; the text itself is never recorded. */
  textLength: number;
  outcome: 'ended' | 'error' | 'cancelled';
  /** System engine error code, or "failed" for any other error. */
  errorCode: string | null;
  /** Stage → renderer ms since `queued` (one clock). */
  t: Partial<Record<SpeechDiagnosticStage, number>>;
  /** Host clock duration: synthesis dispatch → first decoded PCM bytes. */
  hostFirstAudioMs: number | null;
  /** Raw AudioContext.baseLatency / outputLatency at the first schedule, in ms. */
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  /** currentTime − getOutputTimestamp().contextTime at the first schedule, ms (reported output position lag). */
  clockLagMs: number | null;
  /** How far ahead of the audio clock the first chunk was started, in ms. */
  startLeadMs: number | null;
  /** Duration of the most recent full device start (may predate this record, e.g. at chat send). */
  deviceColdStartMs: number | null;
  /** Chat send → this reply's first playbackStart (renderer clock), first segment only. */
  sendToFirstAudioMs: number | null;
  /** Previous segment of the same reply ended → this segment's playbackStart. */
  interSegmentGapMs: number | null;
  /** System: stall closes of the mouth; cloud: queue ran dry before the segment's synthesis ended. */
  stalls: number;
  /** System: the utterance ended < 300 ms after starting with real text (probably silent). */
  quickEnd: boolean;
  /** B06: feed pauses during this record, their total ms, and system-voice pause fallbacks (cancel + re-speak). */
  feedPauses?: number;
  feedPausedMs?: number;
  pauseFallbacks?: number;
  /** System voice: frozen mood multipliers applied on top of the user's rate and the default pitch. */
  rateScale?: number;
  pitchScale?: number;
}

const KEYS = ['v', 'provider', 'voice', 'kind', 'segmentIndex', 'textLength', 'outcome', 'errorCode', 't', 'hostFirstAudioMs',
  'baseLatencyMs', 'outputLatencyMs', 'clockLagMs', 'startLeadMs', 'deviceColdStartMs', 'sendToFirstAudioMs', 'interSegmentGapMs', 'stalls', 'quickEnd'] as const;
/** Optional keys come in pairs of facts; each group is present only when it applies. */
const PAUSE_KEYS = ['feedPauses', 'feedPausedMs', 'pauseFallbacks'] as const;
const SCALE_KEYS = ['rateScale', 'pitchScale'] as const;
const MAX_MS = 15 * 60_000;
const ms = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= MAX_MS;
const nullableMs = (value: unknown, min = 0) => value === null || ms(value, min);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Strict copy of a renderer record; anything unexpected rejects the whole record. */
export function validateSpeechDiagnosticRecord(value: unknown): SpeechDiagnosticRecord | null {
  const allowed: readonly string[] = [...KEYS, ...PAUSE_KEYS, ...SCALE_KEYS];
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) || KEYS.some(key => !Object.hasOwn(value, key))) return null;
  for (const group of [PAUSE_KEYS, SCALE_KEYS] as const)
    if (group.some(key => Object.hasOwn(value, key)) && !group.every(key => Object.hasOwn(value, key))) return null;
  const r = value as unknown as SpeechDiagnosticRecord;
  if (r.v !== 1 || (r.provider !== 'system' && r.provider !== 'bailian') || !['reply', 'speech', 'preview'].includes(r.kind)
    || !['ended', 'error', 'cancelled'].includes(r.outcome)) return null;
  if (typeof r.voice !== 'string' || r.voice.length > 160 || /[\u0000-\u001f\u007f]/u.test(r.voice)) return null;
  if (!(r.segmentIndex === null || (Number.isSafeInteger(r.segmentIndex) && r.segmentIndex >= 0 && r.segmentIndex <= 127))) return null;
  if (!Number.isSafeInteger(r.textLength) || r.textLength < 0 || r.textLength > 6000) return null;
  if (!(r.errorCode === null || (typeof r.errorCode === 'string' && /^[a-z0-9-]{1,40}$/u.test(r.errorCode)))) return null;
  if (!plain(r.t) || Object.entries(r.t).some(([stage, at]) => !(SPEECH_DIAGNOSTIC_STAGES as readonly string[]).includes(stage) || !ms(at))) return null;
  if (![r.hostFirstAudioMs, r.baseLatencyMs, r.outputLatencyMs, r.deviceColdStartMs, r.sendToFirstAudioMs, r.interSegmentGapMs].every(item => nullableMs(item))
    || !nullableMs(r.startLeadMs, -MAX_MS) || !nullableMs(r.clockLagMs, -MAX_MS)) return null;
  if (!Number.isSafeInteger(r.stalls) || r.stalls < 0 || r.stalls > 10_000 || typeof r.quickEnd !== 'boolean') return null;
  const count = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 10_000;
  const scale = (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0.5 && item <= 1.5;
  const paused = Object.hasOwn(r, 'feedPauses'), scaled = Object.hasOwn(r, 'rateScale');
  if (paused && (!count(r.feedPauses) || !ms(r.feedPausedMs) || !count(r.pauseFallbacks))) return null;
  if (scaled && (!scale(r.rateScale) || !scale(r.pitchScale))) return null;
  const t: SpeechDiagnosticRecord['t'] = {};
  for (const stage of SPEECH_DIAGNOSTIC_STAGES) if (r.t[stage] !== undefined) t[stage] = Math.round(r.t[stage]!);
  const round = (item: number | null) => item === null ? null : Math.round(item);
  return { v: 1, provider: r.provider, voice: r.voice, kind: r.kind, segmentIndex: r.segmentIndex, textLength: r.textLength,
    outcome: r.outcome, errorCode: r.errorCode, t, hostFirstAudioMs: round(r.hostFirstAudioMs),
    baseLatencyMs: round(r.baseLatencyMs), outputLatencyMs: round(r.outputLatencyMs), clockLagMs: round(r.clockLagMs), startLeadMs: round(r.startLeadMs),
    deviceColdStartMs: round(r.deviceColdStartMs), sendToFirstAudioMs: round(r.sendToFirstAudioMs),
    interSegmentGapMs: round(r.interSegmentGapMs), stalls: r.stalls, quickEnd: r.quickEnd,
    ...(paused ? { feedPauses: r.feedPauses!, feedPausedMs: Math.round(r.feedPausedMs!), pauseFallbacks: r.pauseFallbacks! } : {}),
    ...(scaled ? { rateScale: Math.round(r.rateScale! * 1000) / 1000, pitchScale: Math.round(r.pitchScale! * 1000) / 1000 } : {}) };
}

/** The status-line view of one record: per-stage durations on the renderer clock, plus the host duration. */
export interface SpeechStageSummary {
  leaseMs?: number; prepareMs?: number; deviceMs?: number;
  /** Renderer: synthesizeSpeech invoke → first PCM event (includes IPC both ways and host work). */
  requestToPacketMs?: number;
  /** Host clock: dispatch → first PCM bytes (network). */
  hostFirstAudioMs?: number;
  /** Renderer: first PCM event → first source.start(). */
  packetToScheduledMs?: number;
  /** Renderer: first source.start() → audio clock reached the first sample. */
  scheduledToAudibleMs?: number;
  outputLatencyMs?: number;
  baseLatencyMs?: number;
}

export function summarizeSpeechStages(record: Pick<SpeechDiagnosticRecord, 't' | 'hostFirstAudioMs' | 'outputLatencyMs' | 'baseLatencyMs'>): SpeechStageSummary {
  const t = record.t, span = (from: SpeechDiagnosticStage, to: SpeechDiagnosticStage) =>
    t[from] !== undefined && t[to] !== undefined ? Math.max(0, Math.round(t[to]! - t[from]!)) : undefined;
  const summary: SpeechStageSummary = {
    leaseMs: span('leaseStart', 'leaseEnd'), prepareMs: span('prepareStart', 'prepareEnd'), deviceMs: span('deviceStart', 'deviceEnd'),
    requestToPacketMs: span('request', 'firstPacket'), packetToScheduledMs: span('firstPacket', 'scheduled'),
    scheduledToAudibleMs: span('scheduled', 'playbackStart'),
    ...(record.hostFirstAudioMs === null ? {} : { hostFirstAudioMs: Math.round(record.hostFirstAudioMs) }),
    ...(record.outputLatencyMs === null ? {} : { outputLatencyMs: Math.round(record.outputLatencyMs) }),
    ...(record.baseLatencyMs === null ? {} : { baseLatencyMs: Math.round(record.baseLatencyMs) }),
  };
  for (const key of Object.keys(summary) as (keyof SpeechStageSummary)[]) if (summary[key] === undefined) delete summary[key];
  return summary;
}
