import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { HER_LIFE_TABLE, isHerLifeMotionId, type HerLifeMotionId, type HerLifeMotionResource, type HerLifeView } from '../../shared/her-life';
import type { MotionLibrary } from '../motion-library';

/** This type stays in the host. Register the path before handing the renderer a URL. */
export type ResolvedHerLifeMotion = Omit<HerLifeMotionResource, 'url'> & { path: string };

/**
 * The two existing Gene library motions a state may add (shared/her-life.ts), pinned independently of the
 * catalog by size and SHA-256, exactly like the chat gestures (electron/chat-gesture.ts). No download, no
 * other pack, no renderer-chosen path.
 */
const resources: Readonly<Record<HerLifeMotionId, { packId: 'gene'; motionId: HerLifeMotionId; sha256: string; bytes: number; durationMs: number }>> = Object.freeze({
  thinking: { packId: 'gene', motionId: 'thinking', sha256: '1f9927296862cc379004f29d8d7fa902918ad2868967c71b5fe7006e80bd118e', bytes: 47_546, durationMs: 10_000 },
  sleepy: { packId: 'gene', motionId: 'sleepy', sha256: 'a221e723825210da250b56b4a05fa9d3b2409504e531c9f756feadbed4f6efd5', bytes: 41_056, durationMs: 10_000 },
});

/** Only the motion of the state she is in right now may be resolved (expressions on). */
export function herLifeMotionAllowed(motionId: unknown, view: { expressions: boolean; herLife?: HerLifeView | null } | null | undefined): motionId is HerLifeMotionId {
  return isHerLifeMotionId(motionId) && !!view && view.expressions === true && !!view.herLife
    && HER_LIFE_TABLE[view.herLife.activity]?.motion?.id === motionId;
}

export async function resolveHerLifeMotionResource(library: Pick<MotionLibrary, 'resolvePreview'>, motionId: unknown): Promise<ResolvedHerLifeMotion> {
  if (!isHerLifeMotionId(motionId)) throw new Error('这段动作不属于她自己的生活。');
  const resource = resources[motionId];
  const target = await library.resolvePreview(resource.packId, resource.motionId);
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('动作资源校验失败。');
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== resource.bytes) throw new Error('动作资源校验失败。');
  const bytes = await readFile(target);
  if (bytes.length !== resource.bytes || bytes.subarray(0, 30).toString('ascii').replace(/\0.*$/, '') !== 'Vocaloid Motion Data 0002'
    || createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw new Error('动作资源校验失败。');
  return { motionId: resource.motionId, sha256: resource.sha256, durationMs: resource.durationMs, path: target };
}
