/**
 * I-135 认出"不是你": what windows may see of the face check. Enums, counts and byte sizes only — never a picture, an
 * embedding, a score or a path. The verdict itself ('you' / 'not-you') is not in the view: it goes to her prompt through
 * the host (electron/senses/face/host.ts `strangerLine`).
 */

export type FaceCheckPhase = 'unsupported' | 'not-installed' | 'downloading' | 'installing' | 'idle' | 'starting' | 'ready';
export type FaceCheckNotice = '' | 'download-failed' | 'verify-failed' | 'canceled' | 'removed' | 'failed'
  | 'enrolled' | 'enrol-failed' | 'enrol-needs-camera' | 'no-encryption' | 'deleted';

export interface FaceCheckView {
  /** The switch 「认出是不是你」 (default off). */
  enabled: boolean;
  phase: FaceCheckPhase;
  downloadBytes: number;
  installedBytes: number;
  progress: number | null;
  /** How many embeddings are stored (a count; 0 = not enrolled). */
  enrolled: number;
  /** 0..1 while enrolling, otherwise null. */
  enrolling: number | null;
  /** The camera is on (either 「发图片」 or 「姿势识别」). */
  camera: boolean;
  /** The small light near her: the camera is being used for face checks right now. */
  active: boolean;
  notice: FaceCheckNotice;
}

export const FACE_CHECK_PHASES: readonly FaceCheckPhase[] = Object.freeze(['unsupported', 'not-installed', 'downloading', 'installing', 'idle', 'starting', 'ready']);
export const FACE_CHECK_NOTICES: readonly FaceCheckNotice[] = Object.freeze(['', 'download-failed', 'verify-failed', 'canceled', 'removed', 'failed',
  'enrolled', 'enrol-failed', 'enrol-needs-camera', 'no-encryption', 'deleted']);

export const OFF_FACE_CHECK_VIEW: FaceCheckView = Object.freeze({ enabled: false, phase: 'unsupported', downloadBytes: 0, installedBytes: 0, progress: null,
  enrolled: 0, enrolling: null, camera: false, active: false, notice: '' });

/** The one private line she gets while the person at the computer is clearly not the user. */
export const FACE_STRANGER_LINE = '现在坐在电脑前的不是他。你不认识这个人。';

const KEYS = ['enabled', 'phase', 'downloadBytes', 'installedBytes', 'progress', 'enrolled', 'enrolling', 'camera', 'active', 'notice'];
const bytes = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 2 ** 40;
const fraction = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);

/** The renderer's check of a view from the host: exact keys, closed values. */
export function parseFaceCheckView(value: unknown): FaceCheckView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== [...KEYS].sort().join()) return null;
  if (typeof v.enabled !== 'boolean' || typeof v.camera !== 'boolean' || typeof v.active !== 'boolean') return null;
  if (!(FACE_CHECK_PHASES as readonly unknown[]).includes(v.phase) || !(FACE_CHECK_NOTICES as readonly unknown[]).includes(v.notice)) return null;
  if (!bytes(v.downloadBytes) || !bytes(v.installedBytes) || !fraction(v.progress) || !fraction(v.enrolling)) return null;
  if (typeof v.enrolled !== 'number' || !Number.isInteger(v.enrolled) || v.enrolled < 0 || v.enrolled > 64) return null;
  return v as unknown as FaceCheckView;
}

export function sameFaceCheckView(a: FaceCheckView, b: FaceCheckView): boolean {
  return KEYS.every(key => a[key as keyof FaceCheckView] === b[key as keyof FaceCheckView]);
}

/** How the current enrolment frame is (closed words; the panel turns them into plain advice). */
export const FACE_ENROL_HINTS = ['no-face', 'too-small', 'too-dark', 'too-bright', 'off-angle', 'blurry', 'good', 'starting'] as const;
export type FaceEnrolHint = (typeof FACE_ENROL_HINTS)[number];

/**
 * 2026-11-25: what the control window shows while the user enrols: the camera's live picture (a small JPEG, sent only to the control
 * window, only while enrolling, never stored), the found face's box as fractions of the picture, a hint, and how many sets are taken.
 * Rides on the same channel as the view in its own wrapper `{ enrolPreview }` (the view parser refuses it).
 */
export interface FaceEnrolPreview {
  image: string | null;
  box: readonly [number, number, number, number] | null;
  hint: FaceEnrolHint;
  taken: number;
  total: number;
}
export const FACE_ENROL_IMAGE_MAX = 90_000;
export function parseFaceEnrolPreviewMessage(value: unknown): { enrolPreview: FaceEnrolPreview | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join() !== 'enrolPreview') return null;
  const p = (value as { enrolPreview: unknown }).enrolPreview;
  if (p === null) return { enrolPreview: null };
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const v = p as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'box,hint,image,taken,total') return null;
  if (v.image !== null && (typeof v.image !== 'string' || v.image.length > FACE_ENROL_IMAGE_MAX || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v.image))) return null;
  if (v.box !== null && (!Array.isArray(v.box) || v.box.length !== 4 || !v.box.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))) return null;
  if (!(FACE_ENROL_HINTS as readonly unknown[]).includes(v.hint)) return null;
  const small = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 16;
  if (!small(v.taken) || !small(v.total)) return null;
  return { enrolPreview: v as unknown as FaceEnrolPreview };
}

/** Journal counts (认出 / 不是你 / 拿不准→当成你 / 跳过, plus how many times she switched to "not you"). Numbers only. */
export interface FaceCheckCounts { matched: number; notYou: number; unsure: number; skipped: number; stranger: number }
export const EMPTY_FACE_CHECK_COUNTS: FaceCheckCounts = Object.freeze({ matched: 0, notYou: 0, unsure: 0, skipped: 0, stranger: 0 });
