import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatGestureCue, ChatGestureResource } from '../shared/chat-gesture';
import type { MotionLibrary } from './motion-library';

/** This type stays in the host. Register path before constructing the public URL resource. */
export type ResolvedChatGesture = Omit<ChatGestureResource, 'url'> & { path: string };
const resources = {
  explain: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2',
    sha256: '6abec61bc8fde28e6d340c9c7cdd00e08edd2340c3939efc3ab041fdf327748d', durationMs: 6_000 },
  consider: { packId: 'genea-2022-gestures', motionId: 'speaking-gesture-2',
    sha256: '6abec61bc8fde28e6d340c9c7cdd00e08edd2340c3939efc3ab041fdf327748d', durationMs: 6_000 },
  upbeat: { packId: 'mpi-embm-gestures', motionId: 'conversation-joy',
    sha256: '027860a2db2891277a36e723dc69300b16828a701e33169ec29edd3397db710b', durationMs: 2_933.333 },
} as const;

export function chatGestureDurationMs(intent: ChatGestureCue['intent']): number { return resources[intent].durationMs; }

/** Host-selected IDs only. resolvePreview also verifies the selected pack's pinned notices. */
export async function resolveChatGestureResource(
  library: Pick<MotionLibrary, 'resolvePreview'>, cue: ChatGestureCue, now = Date.now(),
): Promise<ResolvedChatGesture> {
  if (!cue || typeof cue !== 'object' || Object.keys(cue).some(key => !['id', 'at', 'expiresAt', 'intent', 'strength', 'reason'].includes(key))
    || !Object.hasOwn(resources, cue.intent) || typeof cue.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(cue.id)
    || ![cue.at, cue.expiresAt, cue.strength, now].every(Number.isFinite)
    || cue.at < 0 || cue.at > now || cue.expiresAt <= now || cue.expiresAt > cue.at + 7_500
    || cue.strength <= 0 || cue.strength > 0.7 || typeof cue.reason !== 'string' || cue.reason.length > 160)
    throw new Error('聊天手势已失效或不受支持。');
  const resource = resources[cue.intent];
  const target = await library.resolvePreview(resource.packId, resource.motionId);
  // Independently pin the capability to these reviewed clips even if a local
  // catalog is changed. No cache, download, preview state or settings mutation.
  if (!path.isAbsolute(target)) throw new Error('聊天手势资源校验失败。');
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 30 || info.size > 8 * 1024 * 1024)
    throw new Error('聊天手势资源校验失败。');
  const bytes = await readFile(target);
  if (bytes.length !== info.size || bytes.subarray(0, 30).toString('ascii').replace(/\0.*$/, '') !== 'Vocaloid Motion Data 0002'
    || createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw new Error('聊天手势资源校验失败。');
  return { cueId: cue.id, intent: cue.intent, ...resource, path: target };
}
