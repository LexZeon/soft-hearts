/**
 * The origin check of a host initiative (moved out of electron/memory/memory.ts unchanged on 2026-11-24, I-209 step 4, so the store only
 * shrinks while it gains the stage lines): a bounded text identity, real short labels, no picture, path or address.
 */
import type { ProactiveContentSource, ProactiveOrigin } from '../../shared/foundation/chat';

export function validateProactiveOrigin(value: unknown, journal: string): ProactiveOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(field => !['kind', 'id', 'at', 'sources', 'labels'].includes(field))) throw new Error('主动来源只接受有界文字身份。');
  const origin = value as ProactiveOrigin;
  if (origin.kind !== 'proactive' || typeof origin.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(origin.id)) throw new Error('主动来源编号不正确。');
  if (!Number.isFinite(origin.at) || origin.at < 0 || !Number.isSafeInteger(origin.at)) throw new Error("记忆时间必须为有效的毫秒时间。");
  const sources: ProactiveContentSource[] = journal === 'text-invitations' ? ['text'] : ['screen', 'camera', 'ambient', 'inner', 'feed', 'greeting'];
  if (!Array.isArray(origin.sources) || origin.sources.length < 1 || origin.sources.length > 3
    || !origin.sources.every(source => sources.includes(source)) || new Set(origin.sources).size !== origin.sources.length
    || !Array.isArray(origin.labels) || origin.labels.length !== origin.sources.length
    || !origin.labels.every(label => typeof label === 'string' && label.trim().length > 0 && Array.from(label).length <= 80
      && !/[\\/\u0000-\u001f\u007f]|(?:https?|file|data|javascript|blob):/i.test(label))) throw new Error('主动来源需要真实短标签，不能包含图片、路径或网址。');
  return { kind: 'proactive', id: origin.id, at: origin.at, sources: [...origin.sources], labels: origin.labels.map(label => label.trim()) };
}
