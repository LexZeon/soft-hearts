/**
 * Local pose sensing (I-001 stage 1, docs/claude/2026-11-03-pose-sensing-stage1.md).
 *
 * The only things that ever leave the inference process are the abstract signals below: enums,
 * booleans and clamped numbers. No frame, no keypoint coordinate, no string from the model.
 * The host re-validates every message with `parsePoseSignal` before anything else sees it.
 */

export const POSE_FACINGS = ['toward', 'side', 'away', 'unknown'] as const;
export const POSE_POSTURES = ['sitting', 'standing', 'slumped', 'leaning-back', 'unknown'] as const;
/** `yawn` is reserved for the whole-body model (later stage); stage 1 never emits it. */
export const POSE_EVENTS = ['wave', 'stretch', 'yawn'] as const;
/** Reserved for the rock-paper-scissors game (MediaPipe, later); stage 1 always sends null. */
export const POSE_HANDS = ['rock', 'paper', 'scissors'] as const;
/** `presence-only`: this computer is too slow for the pose model; only presence is measured. */
export const POSE_CAPABILITIES = ['full', 'presence-only'] as const;

export type PoseFacing = typeof POSE_FACINGS[number];
export type PosePosture = typeof POSE_POSTURES[number];
export type PoseEvent = typeof POSE_EVENTS[number];
export type PoseHand = typeof POSE_HANDS[number];
export type PoseCapability = typeof POSE_CAPABILITIES[number];

export interface PoseSignal {
  /** Somebody is in front of the camera (with hysteresis). */
  present: boolean;
  /** 0..1, how sure the detector is. */
  confidence: number;
  facing: PoseFacing;
  posture: PosePosture;
  /** 0..1, smoothed amount of upper-body movement. */
  energy: number;
  /** Moving rhythmically (bobbing / swaying). */
  rhythm: boolean;
  /** Beats per minute of that rhythm, 40..180, null when there is no rhythm. */
  tempo: number | null;
  /** One-shot events since the previous signal. */
  events: PoseEvent[];
  /** Reserved (rock-paper-scissors); always null in stage 1. */
  hand: PoseHand | null;
  capability: PoseCapability;
}

export const POSE_SIGNAL_KEYS = ['present', 'confidence', 'facing', 'posture', 'energy', 'rhythm', 'tempo', 'events', 'hand', 'capability'] as const;

const unit = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 : null;
const member = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** Exact-shape check: any extra key (coordinates, image data, text) rejects the whole message. */
export function parsePoseSignal(value: unknown): PoseSignal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== POSE_SIGNAL_KEYS.length || !POSE_SIGNAL_KEYS.every(key => Object.hasOwn(record, key))) return null;
  const confidence = unit(record.confidence), energy = unit(record.energy);
  if (typeof record.present !== 'boolean' || confidence === null || energy === null || typeof record.rhythm !== 'boolean') return null;
  if (!member(POSE_FACINGS, record.facing) || !member(POSE_POSTURES, record.posture) || !member(POSE_CAPABILITIES, record.capability)) return null;
  if (record.hand !== null && !member(POSE_HANDS, record.hand)) return null;
  let tempo: number | null = null;
  if (record.tempo !== null) {
    if (typeof record.tempo !== 'number' || !Number.isFinite(record.tempo) || record.tempo < 40 || record.tempo > 180) return null;
    tempo = Math.round(record.tempo);
  }
  if (!record.rhythm && tempo !== null) return null;
  if (!Array.isArray(record.events) || record.events.length > POSE_EVENTS.length) return null;
  const events: PoseEvent[] = [];
  for (const event of record.events) {
    if (!member(POSE_EVENTS, event) || events.includes(event)) return null;
    events.push(event);
  }
  return { present: record.present, confidence, facing: record.facing, posture: record.posture, energy,
    rhythm: record.rhythm, tempo, events, hand: (record.hand ?? null) as PoseHand | null, capability: record.capability };
}

export const EMPTY_POSE_SIGNAL: PoseSignal = Object.freeze({
  present: false, confidence: 0, facing: 'unknown', posture: 'unknown', energy: 0, rhythm: false, tempo: null,
  events: [] as PoseEvent[], hand: null, capability: 'full',
}) as PoseSignal;

// ---- What the control window may see about the component and the sensing process (no paths, no text from elsewhere).

export const POSE_PHASES = [
  /** This platform has no component package (only Windows x64 / ARM64 do). */
  'unsupported',
  /** Not downloaded yet; turning the camera on asks first. */
  'not-installed',
  'downloading',
  /** Verifying and unpacking after download or import. */
  'installing',
  /** Installed; the camera is off. */
  'idle',
  /** Loading the models and picking GPU or CPU; the camera is not open yet. */
  'starting',
  'running',
  /** Waiting before an automatic restart after the sensing process stopped unexpectedly. */
  'restarting',
] as const;
export type PosePhase = typeof POSE_PHASES[number];
export const POSE_NOTICES = ['', 'download-failed', 'verify-failed', 'import-incomplete', 'import-done', 'removed', 'camera-unavailable', 'too-slow', 'crashed', 'canceled'] as const;
export type PoseNotice = typeof POSE_NOTICES[number];
export const POSE_LEVELS = ['normal', 'reduced', 'minimal', 'presence-only'] as const;
export type PoseLevel = typeof POSE_LEVELS[number];

export interface PoseSensingView {
  phase: PosePhase;
  /** True after the user tried to turn the camera on while the component is missing: show the one-line question. */
  prompt: boolean;
  /** Bytes the first download fetches over the network (for the question). */
  downloadBytes: number;
  /** Bytes on disk when installed (0 when not installed). */
  installedBytes: number;
  /** 0..1 while downloading / installing, otherwise null. */
  progress: number | null;
  route: 'gpu' | 'cpu' | null;
  level: PoseLevel | null;
  componentVersion: number;
  notice: PoseNotice;
  /** True while downloading: the small pack could not be fetched, the official sources are used (downloadBytes is their total). */
  fallback?: boolean;
  /** How many camera requests were refused so far (absent = none): each new one brings the question into view again. */
  asked?: number;
}

export function samePoseView(a: PoseSensingView, b: PoseSensingView): boolean {
  return a.phase === b.phase && a.prompt === b.prompt && a.downloadBytes === b.downloadBytes && a.installedBytes === b.installedBytes
    && a.progress === b.progress && a.route === b.route && a.level === b.level && a.componentVersion === b.componentVersion && a.notice === b.notice
    && !!a.fallback === !!b.fallback && (a.asked ?? 0) === (b.asked ?? 0);
}

/** Renderer-side guard for the state broadcast (the preload hands it through unchanged). */
export function parsePoseView(value: unknown): PoseSensingView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const bytes = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < 2 ** 40;
  if (!member(POSE_PHASES, v.phase) || typeof v.prompt !== 'boolean' || !bytes(v.downloadBytes) || !bytes(v.installedBytes)) return null;
  if (v.progress !== null && (typeof v.progress !== 'number' || !(v.progress >= 0 && v.progress <= 1))) return null;
  if (v.route !== null && v.route !== 'gpu' && v.route !== 'cpu') return null;
  if (v.level !== null && !member(POSE_LEVELS, v.level)) return null;
  if (!bytes(v.componentVersion) || !member(POSE_NOTICES, v.notice)) return null;
  if (v.fallback !== undefined && typeof v.fallback !== 'boolean') return null;
  if (v.asked !== undefined && !(bytes(v.asked) && (v.asked as number) > 0)) return null;
  return { phase: v.phase, prompt: v.prompt, downloadBytes: v.downloadBytes as number, installedBytes: v.installedBytes as number,
    progress: v.progress as number | null, route: v.route as 'gpu' | 'cpu' | null, level: v.level as PoseLevel | null,
    componentVersion: v.componentVersion as number, notice: v.notice, ...(v.fallback ? { fallback: true } : {}),
    ...(v.asked ? { asked: v.asked as number } : {}) };
}

/** Megabytes the way the question says it ("约 85 MB"): decimal, rounded to a whole number. */
export function poseMegabytes(bytes: number): number { return Math.max(1, Math.round(bytes / 1_000_000)); }
