/**
 * Local pose sensing (I-001 stage 1, docs/claude/2026-11-03-pose-sensing-stage1.md).
 *
 * The only things that ever leave the inference process are the signals below: enums, booleans and clamped numbers.
 * Never the frame, never a string from the model. The host re-validates every message with `parsePoseSignal` before
 * anything else sees it.
 *
 * I-081 (19:5x: "都会传，开启这个功能了就认为是同意的"): with 「姿势识别（本机）」 on, the signal also carries where
 * the user is in the camera's frame (`face`) and the body points (`points`), normalised to 0..1, smoothed and rounded to two
 * decimals. They live in memory only (the stage turns `face` into where she looks); never written to disk or the journal, never
 * uploaded. The UI says so wherever it lists what pose sensing recognises (POSE_RECOGNISES below).
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

/** COCO-17 body points in this order (nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles). */
export const POSE_POINT_COUNT = 17;
/** A point in the camera's frame as the camera records it (not mirrored): x 0 = the frame's left edge, y 0 = its top. */
export interface PosePoint { x: number; y: number }

/**
 * I-081: everything pose sensing recognises, in the words every place that lists it uses (the camera panel's pose row, the
 * question before the first download, the internal channel's handbook entry and confirmation).
 */
export const POSE_RECOGNISES = '你在不在、朝向、坐着还是站着、动作幅度、挥手、点头摇头、画面里有几个人，以及你在画面里的位置、离屏幕大概多远和身体各个点的坐标';
export const POSE_LOCAL_ONLY = '只在这台电脑上算，不保存、不上传';

export interface PoseSignal {
  /** Somebody is in front of the camera (with hysteresis). */
  present: boolean;
  /** 0..1, how sure the detector is. */
  confidence: number;
  facing: PoseFacing;
  /** 0..1 (2026-11-17): how sure `facing` is (keypoint scores x agreement of the last frames); 0 while facing is 'unknown'. Bands: pose-confidence.ts. */
  facingConfidence: number;
  posture: PosePosture;
  /** 0..1: the same for `posture`. */
  postureConfidence: number;
  /** 0..1, smoothed amount of upper-body movement. */
  energy: number;
  /** Moving rhythmically (bobbing / swaying). */
  rhythm: boolean;
  /** Beats per minute of that rhythm, 40..180, null when there is no rhythm. */
  tempo: number | null;
  /** One-shot events since the previous signal. */
  events: PoseEvent[];
  /** 0..1 for each event in `events` (keypoint scores x how clearly the motion passed its test); no keys for events not in this signal. */
  eventConfidence: Partial<Record<PoseEvent, number>>;
  /** Reserved (rock-paper-scissors); always null in stage 1. */
  hand: PoseHand | null;
  capability: PoseCapability;
  /**
   * I-081: the centre of the user's face in the frame (the shoulders' middle, raised to about head height, when the face is not
   * seen), 0..1, smoothed, two decimals. null while nobody is there or only presence is measured.
   */
  face: PosePoint | null;
  /** I-081: the 17 body points (POSE_POINT_COUNT, COCO order), 0..1, smoothed, two decimals; null for a point not seen. Empty while `face` is null. */
  points: (PosePoint | null)[];
  /**
   * I-167: how far away the user's head is and which way it points (shared/behaviors/gaze-attention/head-pose.ts, from the face points at
   * full precision, smoothed): yaw / pitch in whole degrees in the screen's frame (yaw + = toward the screen's right as the user sees it,
   * pitch + = down), distance in metres (two decimals). null while `face` is null or the nose and both eyes are not seen.
   */
  head: PoseHead | null;
  /**
   * I-189 #7: how many people the detector counts in the frame (0..4; confident boxes only, the lowest of the last three detections, so
   * one stray box never makes two). A number only: never where they are, never who.
   */
  people: number;
}

/** I-167: the head's direction and distance (numbers only, derived from the keypoints; never a picture). */
export interface PoseHead { yaw: number; pitch: number; distance: number }

export const POSE_SIGNAL_KEYS = ['present', 'confidence', 'facing', 'facingConfidence', 'posture', 'postureConfidence', 'energy', 'rhythm', 'tempo', 'events', 'eventConfidence', 'hand', 'capability', 'face', 'points', 'head', 'people'] as const;

const unit = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) / 100 : null;
const member = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/** A point: exactly {x, y}, finite numbers, clamped to 0..1 and rounded to two decimals; anything else is null (the message is refused). */
function readPoint(value: unknown): PosePoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'x') || !Object.hasOwn(value, 'y')) return null;
  const x = unit((value as PosePoint).x), y = unit((value as PosePoint).y);
  return x === null || y === null ? null : { x, y };
}

/** I-167: a head reading: exactly {yaw, pitch, distance}, finite; angles clamped to ±90 and rounded to whole degrees, distance to 0.1..5 m, two decimals. */
function readHead(value: unknown): PoseHead | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 3 || !['yaw', 'pitch', 'distance'].every(key => Object.hasOwn(v, key))) return null;
  if (![v.yaw, v.pitch, v.distance].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  const angle = (n: number) => Math.round(Math.min(90, Math.max(-90, n))) || 0;
  return { yaw: angle(v.yaw as number), pitch: angle(v.pitch as number), distance: Math.round(Math.min(5, Math.max(0.1, v.distance as number)) * 100) / 100 };
}

/** Exact-shape check: any extra key (image data, a box, text) rejects the whole message; so does a malformed point. */
export function parsePoseSignal(value: unknown): PoseSignal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  // I-189: `people` may be absent (a signal from before it existed reads as 0); every other key must be there, and nothing else.
  const hasPeople = Object.hasOwn(record, 'people');
  if (keys.length !== POSE_SIGNAL_KEYS.length - (hasPeople ? 0 : 1) || !POSE_SIGNAL_KEYS.every(key => key === 'people' || Object.hasOwn(record, key))) return null;
  if (hasPeople && !(typeof record.people === 'number' && Number.isInteger(record.people) && record.people >= 0 && record.people <= 4)) return null;
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
  // 2026-11-17: the confidences; finite numbers only, clamped to 0..1; keys only for events that are in `events`.
  const facingConfidence = unit(record.facingConfidence), postureConfidence = unit(record.postureConfidence);
  if (facingConfidence === null || postureConfidence === null) return null;
  if (!record.eventConfidence || typeof record.eventConfidence !== 'object' || Array.isArray(record.eventConfidence)) return null;
  const eventConfidence: Partial<Record<PoseEvent, number>> = {};
  for (const [name, raw] of Object.entries(record.eventConfidence)) {
    const read = unit(raw);
    if (!member(POSE_EVENTS, name) || !events.includes(name) || read === null) return null;
    eventConfidence[name] = read;
  }
  // I-081: the position and the body points, only while somebody is there and the pose model runs; a bounded, exact shape.
  let face: PosePoint | null = null;
  if (record.face !== null) {
    if (!record.present || record.capability !== 'full') return null;
    face = readPoint(record.face);
    if (!face) return null;
  }
  if (!Array.isArray(record.points)) return null;
  if (record.points.length !== 0 && (record.points.length !== POSE_POINT_COUNT || !face)) return null;
  const points: (PosePoint | null)[] = [];
  for (const point of record.points) {
    if (point === null) { points.push(null); continue; }
    const read = readPoint(point);
    if (!read) return null;
    points.push(read);
  }
  // I-167: the head reading only with a face (the same rule as the points).
  let head: PoseHead | null = null;
  if (record.head !== null) {
    if (!face) return null;
    head = readHead(record.head);
    if (!head) return null;
  }
  return { present: record.present, confidence, facing: record.facing, facingConfidence, posture: record.posture, postureConfidence, energy,
    rhythm: record.rhythm, tempo, events, eventConfidence, hand: (record.hand ?? null) as PoseHand | null, capability: record.capability, face, points, head,
    people: hasPeople ? record.people as number : 0 };
}

export const EMPTY_POSE_SIGNAL: PoseSignal = Object.freeze({
  present: false, confidence: 0, facing: 'unknown', facingConfidence: 0, posture: 'unknown', postureConfidence: 0, energy: 0, rhythm: false, tempo: null,
  events: [] as PoseEvent[], eventConfidence: {} as Partial<Record<PoseEvent, number>>, hand: null, capability: 'full', face: null, points: [] as (PosePoint | null)[], head: null, people: 0,
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
