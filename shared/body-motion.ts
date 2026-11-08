/** Ephemeral host-owned presentation only. These identities grant no file access. */
export const BODY_RECIPE_IDS = Object.freeze(['idle.neutral', 'idle.proud', 'body.confirm'] as const);
export type BodyRecipeId = typeof BODY_RECIPE_IDS[number];
export type BodyMaskId = 'candidate-head-v1' | 'candidate-pose-v1';
export interface BodyMotionCue {
  readonly id: string;
  readonly token: string;
  readonly recipeId: BodyRecipeId;
  readonly at: number;
  readonly expiresAt: number;
  readonly durationMs: number;
  readonly strength: number;
}
export interface BodyMotionPlan {
  readonly cue: BodyMotionCue | null;
  readonly mode: 'closed' | 'maintainer-qa' | 'idle-scheduler';
  readonly reason: BodyMotionReason;
  /** Host-issued lifecycle nonce; only the normal idle observation channel uses it. */
  readonly observationEpoch?: string;
}
export const BODY_MOTION_REASONS = Object.freeze(['normal-pool-closed', 'qa-ready', 'qa-issued', 'qa-consumed', 'blocked',
  'unsupported-target', 'invalid-scope', 'expired', 'cancelled', 'clock-break',
  'idle-waiting', 'idle-playing', 'idle-issued', 'idle-blocked', 'idle-invalid-input',
  'idle-no-approved-recipes', 'idle-no-alternative', 'idle-disposed'] as const);
export type BodyMotionReason = typeof BODY_MOTION_REASONS[number];
export interface BodyMotionResource {
  readonly cueId: string;
  readonly recipeId: BodyRecipeId;
  readonly packId: 'gene' | '100style-idles';
  readonly motionId: 'convinced' | 'neutral-idle' | 'proud-idle';
  readonly sha256: string;
  readonly maskId: BodyMaskId;
  readonly durationMs: number;
  readonly url: string;
}
export const BODY_START_AGE_MS = 1_500;
export const BODY_MAX_STRENGTH = 0.3;
export const BODY_IDLE_REPORT_INTERVAL_MS = 750;
export const BODY_IDLE_OBSERVATION_TTL_MS = 2_250;
export const BODY_STAGE_OBSERVATION_KEYS = Object.freeze(['ready', 'enabled', 'visible', 'manualPose', 'manualGesture',
  'manualExpression', 'manualHead', 'dynamicPose', 'cameraOrWindow', 'inputBlocked', 'directContact', 'music',
  'speaking', 'waitingForReply', 'chatGesture', 'preview'] as const);
export type BodyStageObservation = Readonly<Record<typeof BODY_STAGE_OBSERVATION_KEYS[number], boolean>>
  & { readonly revision: number; readonly epoch: string };
/** A denial/readiness observation, never model, asset or execution authority. */
export function readBodyStageObservation(value: unknown): BodyStageObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('身体动作观察不合法。');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
  if (keys.length !== BODY_STAGE_OBSERVATION_KEYS.length + 2
    || keys.some(k => typeof k !== 'string' || k !== 'revision' && k !== 'epoch' && !(BODY_STAGE_OBSERVATION_KEYS as readonly string[]).includes(k)))
    throw new Error('身体动作观察字段不合法。');
  const result: Record<string, boolean | number | string> = {};
  for (const key of ['epoch', 'revision', ...BODY_STAGE_OBSERVATION_KEYS]) {
    const field = fields[key];
    if (!field || !Object.hasOwn(field, 'value') || field.get || field.set) throw new Error('身体动作观察必须是数据。');
    const v: unknown = field.value;
    if (key === 'epoch' ? !bodyIdentity(v) : key === 'revision' ? !Number.isSafeInteger(v) || (v as number) < 1 : typeof v !== 'boolean')
      throw new Error('身体动作观察值不合法。');
    result[key] = v as number | boolean | string;
  }
  return Object.freeze(result) as BodyStageObservation;
}
export const bodyIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export const isBodyRecipeId = (value: unknown): value is BodyRecipeId => typeof value === 'string'
  && (BODY_RECIPE_IDS as readonly string[]).includes(value);

/** Shape validation is not authority: the host's current lease remains required. */
export function isBodyMotionCue(value: unknown): value is BodyMotionCue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cue = value as BodyMotionCue;
  const keys = ['id', 'token', 'recipeId', 'at', 'expiresAt', 'durationMs', 'strength'];
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && bodyIdentity(cue.id) && bodyIdentity(cue.token) && isBodyRecipeId(cue.recipeId)
    && [cue.at, cue.expiresAt, cue.durationMs, cue.strength].every(Number.isFinite)
    && cue.at >= 0 && cue.at <= Number.MAX_SAFE_INTEGER - 60_000
    && cue.durationMs >= 250 && cue.durationMs <= 30_000
    && cue.expiresAt === cue.at + cue.durationMs + BODY_START_AGE_MS
    && cue.strength > 0 && cue.strength <= BODY_MAX_STRENGTH;
}
