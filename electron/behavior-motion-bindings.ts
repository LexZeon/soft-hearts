import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isBehaviorFaceBindingId, isBehaviorSemantic, MAX_BEHAVIOR_CUE_AGE_MS,
  MAX_BEHAVIOR_CUE_LIFETIME_MS, MAX_BEHAVIOR_FACE_STRENGTH,
  type BehaviorFaceBindingId, type BehaviorFaceMotionId, type BehaviorMotionCue,
  type BehaviorMotionResource,
} from '../shared/behavior-motion';
import type { MotionLibrary } from './motion-library';

/** Host-only paths; the IPC owner registers a resource only after rechecking its live cue. */
export type ResolvedBehaviorMotionResource = Omit<BehaviorMotionResource, 'url'> & { path: string };

// Independently pinned Gene revision c7eace43dffaccff6ad0597433ef85fa57c91e03.
// These source bytes are approved only for the emotion-face recipe: the renderer
// must mask bones, mouth and red-cheek morphs and retain the original once timeline.
// Never construct this allowlist from the mutable motion catalog at runtime.
const resources = {
  'face.smile': { motionId: 'smile', sha256: '87cfd8818c6474a968ed83f8c6040d3a9657d8947a2eab7f47675a3fa50fb2b3', durationMs: 10_000 },
  'face.embarrassed-smile': { motionId: 'embarrassed-smile', sha256: '1fe9d30181511c135b8fd9c8afb9795a29b197aa7da05a4a104c2c1e113296d3', durationMs: 10_000 },
  'face.happy': { motionId: 'happy', sha256: '8da8b93dfc2dba19535246126558f82238c915ff8a90b2d05dfba17a333f903e', durationMs: 10_000 },
  'face.laugh': { motionId: 'laugh', sha256: '714c04a833285aacc7b75039d872fc852c6df75025296bae0a707e5bbb3e159e', durationMs: 10_000 },
  'face.compassion': { motionId: 'compassion', sha256: 'd90a4b147a5c87cb514aee1f6a44ae3c43beb13473039223897028f4847654f7', durationMs: 10_000 },
  'face.in-trouble': { motionId: 'in-trouble', sha256: '62754cb6c6912a75c1506b8bcc375a03dfdffe5a9c6fe7573c1f9152e44a2497', durationMs: 10_000 },
  'face.disappointed': { motionId: 'disappointed', sha256: 'ae12bcab9288fed1b951c565871f4414debd81a45b81ef1b29472f373f751790', durationMs: 10_000 },
  'face.disgust': { motionId: 'disgust', sha256: '96944c44a88ac91ea7b87edfeccc677c8c83abf3cebeb76923ce3a95baf0f21f', durationMs: 10_000 },
  'face.sentimental': { motionId: 'sentimental', sha256: 'f9f746e6c2fc660e21b5264a4282b8a155dbf8efdd3ce5d288ac834b5e71d8da', durationMs: 10_000 },
  'face.sad': { motionId: 'sad', sha256: 'f7039798db01383d05febe7dcae03cb164ad6acee2015906459e9f6c425ba507', durationMs: 10_000 },
  'face.convinced': { motionId: 'convinced', sha256: '10e9afe2685408850935acbf5f54210098896a530c274ebf4f88a0e31ce0ce82', durationMs: 10_000 },
} as const satisfies Record<BehaviorFaceBindingId, { motionId: BehaviorFaceMotionId; sha256: string; durationMs: number }>;

const cueKeys = new Set(['id', 'kind', 'bindingId', 'semantic', 'at', 'expiresAt', 'strength', 'stateKey']);
const finiteTime = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function checkedCue(value: unknown, now: number): BehaviorMotionCue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('行为表情已失效或不受支持。');
  const keys = Reflect.ownKeys(value), cue = value as BehaviorMotionCue;
  if (keys.length !== cueKeys.size || keys.some(key => typeof key !== 'string' || !cueKeys.has(key))
    || typeof cue.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(cue.id)
    || (cue.kind !== 'state' && cue.kind !== 'reaction')
    || !isBehaviorFaceBindingId(cue.bindingId) || !Object.hasOwn(resources, cue.bindingId)
    || !isBehaviorSemantic(cue.semantic)
    || typeof cue.stateKey !== 'string' || !cue.stateKey.trim() || cue.stateKey.length > 256 || /[\u0000-\u001f\u007f]/.test(cue.stateKey)
    || !finiteTime(now) || !finiteTime(cue.at) || !finiteTime(cue.expiresAt)
    || cue.at > now || now - cue.at > MAX_BEHAVIOR_CUE_AGE_MS || cue.expiresAt <= now
    || cue.expiresAt - cue.at > MAX_BEHAVIOR_CUE_LIFETIME_MS
    || typeof cue.strength !== 'number' || !Number.isFinite(cue.strength)
    || cue.strength <= 0 || cue.strength > MAX_BEHAVIOR_FACE_STRENGTH)
    throw new Error('行为表情已失效或不受支持。');
  // A caller mutation during resolvePreview/readFile cannot change the admitted identity.
  return { id: cue.id, kind: cue.kind, bindingId: cue.bindingId, semantic: cue.semantic,
    at: cue.at, expiresAt: cue.expiresAt, strength: cue.strength, stateKey: cue.stateKey };
}

/** Only approved local face identities; no download, source edits, cache or settings mutation. */
export async function resolveBehaviorMotionResource(
  library: Pick<MotionLibrary, 'resolvePreview'>, cue: BehaviorMotionCue, now = Date.now(),
): Promise<ResolvedBehaviorMotionResource> {
  const admitted = checkedCue(cue, now), resource = resources[admitted.bindingId];
  // resolvePreview retains the library's source/license notice checks.
  const target = await library.resolvePreview('gene', resource.motionId);
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('行为表情资源校验失败。');
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 30 || info.size > 8 * 1024 * 1024)
    throw new Error('行为表情资源校验失败。');
  const bytes = await readFile(target);
  if (bytes.length !== info.size || bytes.subarray(0, 30).toString('ascii').replace(/\0.*$/, '') !== 'Vocaloid Motion Data 0002'
    || createHash('sha256').update(bytes).digest('hex') !== resource.sha256)
    throw new Error('行为表情资源校验失败。');
  return { cueId: admitted.id, bindingId: admitted.bindingId, packId: 'gene', ...resource, recipe: 'emotion-face', path: target };
}
