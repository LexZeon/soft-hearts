import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';
import { BODY_START_AGE_MS, isBodyMotionCue,
  type BodyMaskId, type BodyMotionCue, type BodyMotionResource, type BodyRecipeId } from '../shared/body-motion';
import type { MotionLibrary } from './motion-library';
import { vmdDurationMs } from '../shared/vmd-duration';

/** Host-only path. Its caller still rechecks the live lease after URL registration. */
export type ResolvedBodyMotionResource = Omit<BodyMotionResource, 'url'> & { readonly path: string };
export interface BodyMotionResolveOptions {
  /** A clock function permits fresh checks after each asynchronous operation. */
  readonly now?: number | (() => number);
  /** Host-owned current cue/model/context authority; only explicit true admits. */
  readonly stillCurrent: () => boolean;
}
interface ResourceIdentity {
  readonly packId: BodyMotionResource['packId'];
  readonly motionId: BodyMotionResource['motionId'];
  readonly sha256: string;
  readonly bytes: number;
  readonly durationMs: number;
  readonly maskId: BodyMaskId;
}

// Independent fixed byte identities, never generated from a mutable catalog.
// Gene c7eace43dffaccff6ad0597433ef85fa57c91e03;
// 100STYLE 3ad1793831ecf4301fec98d4462e5470bd2ae2da.
// These are candidate QA resources, not automatic-use approval or a model gate.
const resources = Object.freeze({
  'body.confirm': Object.freeze({ packId: 'gene', motionId: 'convinced', bytes: 37_017,
    sha256: '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82',
    durationMs: 10_000, maskId: 'candidate-head-v1' }),
  'idle.neutral': Object.freeze({ packId: '100style-idles', motionId: 'neutral-idle', bytes: 935_582,
    sha256: '58887fab2e456bc9f5da21f275cc986a5fa8e96997b61b481e064ca3696002bb',
    durationMs: 10_000, maskId: 'candidate-pose-v1' }),
  'idle.proud': Object.freeze({ packId: '100style-idles', motionId: 'proud-idle', bytes: 503_570,
    sha256: '811ae39e09565bf824baf4803f8467b2881f1b42088448a49e9cb2fde7403a05',
    durationMs: vmdDurationMs(161), maskId: 'candidate-pose-v1' }),
} as const satisfies Record<BodyRecipeId, ResourceIdentity>);
const cueKeys = Object.freeze(['id', 'token', 'recipeId', 'at', 'expiresAt', 'durationMs', 'strength'] as const);
const invalidCue = () => new Error('身体动作已失效或不受支持。');
const invalidResource = () => new Error('身体动作资源校验失败。');
const finiteTime = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/** No getters/proxy reads are allowed to change an identity between checks. */
function snapshotCue(value: unknown): Readonly<BodyMotionCue> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) throw invalidCue();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidCue();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== cueKeys.length || keys.some(key => typeof key !== 'string' || !cueKeys.includes(key as typeof cueKeys[number])))
    throw invalidCue();
  const copy: Record<string, unknown> = {};
  for (const key of cueKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw invalidCue();
    copy[key] = descriptor.value;
  }
  if (!isBodyMotionCue(copy)) throw invalidCue();
  return Object.freeze(copy as unknown as BodyMotionCue);
}

/**
 * Resolve only the host's current, fresh-start QA cue through the read-only local
 * preview resolver. No downloading, arbitrary asset/path inputs or state writes.
 * Shape/pins never replace host ownership: stillCurrent must retain the same cue,
 * scope and verified target before and after all awaits and final URL admission.
 */
export async function resolveBodyMotionResource(
  library: Pick<MotionLibrary, 'resolvePreview'>,
  cue: BodyMotionCue,
  options: BodyMotionResolveOptions,
): Promise<ResolvedBodyMotionResource> {
  const admitted = snapshotCue(cue), resource = resources[admitted.recipeId];
  if (admitted.durationMs !== resource.durationMs) throw invalidCue();
  const sourceClock = options?.now, stillCurrent = options?.stillCurrent;
  if (typeof stillCurrent !== 'function' || (sourceClock !== undefined && typeof sourceClock !== 'number' && typeof sourceClock !== 'function'))
    throw invalidCue();
  const clock = typeof sourceClock === 'function' ? sourceClock
    : typeof sourceClock === 'number' ? () => sourceClock : Date.now;
  let highWater: number | null = null;
  const assertCurrent = (): void => {
    let now: number;
    try {
      if (stillCurrent() !== true) throw invalidCue();
      now = clock();
    } catch { throw invalidCue(); }
    if (!finiteTime(now) || (highWater !== null && now < highWater)
      || now < admitted.at || now - admitted.at > BODY_START_AGE_MS || now >= admitted.expiresAt) throw invalidCue();
    highWater = now;
  };

  assertCurrent();
  // The existing preview route retains bundled source/license notice validation.
  const target = await library.resolvePreview(resource.packId, resource.motionId);
  assertCurrent();
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw invalidResource();
  assertCurrent();
  const info = await lstat(target);
  assertCurrent();
  if (!info.isFile() || info.isSymbolicLink() || info.size !== resource.bytes) throw invalidResource();
  assertCurrent();
  const bytes = await readFile(target);
  assertCurrent();
  if (bytes.length !== resource.bytes || bytes.length !== info.size
    || bytes.subarray(0, 30).toString('ascii').replace(/\0.*$/, '') !== 'Vocaloid Motion Data 0002'
    || createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw invalidResource();
  assertCurrent();
  return Object.freeze({ cueId: admitted.id, recipeId: admitted.recipeId, packId: resource.packId,
    motionId: resource.motionId, sha256: resource.sha256, maskId: resource.maskId,
    durationMs: resource.durationMs, path: target });
}
