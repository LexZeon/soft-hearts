import type { PetReplyUpdate } from '../shared/contracts';
import { validReplyPieces } from '../shared/reply-bubbles';

/** This channel accepts display data only; it never carries provider or execution settings. */
export function validateReplyUpdate(value: unknown): PetReplyUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('回答气泡格式不正确。');
  const patch = value as PetReplyUpdate;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !['text', 'state', 'anchor', 'interactionOpacity', 'segmented', 'pieces'].includes(key))) throw new Error('回答气泡字段不正确。');
  if (patch.text !== undefined && (typeof patch.text !== 'string' || patch.text.length > 32000)) throw new Error('回答气泡文字过长。');
  if (patch.state !== undefined && !['waiting', 'streaming', 'complete', 'hidden'].includes(patch.state)) throw new Error('回答气泡状态不正确。');
  if (patch.state === 'waiting' && patch.text?.trim()) throw new Error('等待提示不能包含回复正文。');
  if (patch.text !== undefined && patch.state === undefined) throw new Error('更新回答必须包含显示状态。');
  if (patch.segmented !== undefined && typeof patch.segmented !== 'boolean') throw new Error('回答气泡分段格式不正确。');
  // Display offsets only: they must describe this exact text revision of an unsegmented body.
  if (patch.pieces !== undefined && (patch.text === undefined || patch.state === 'waiting' || patch.segmented === true || !validReplyPieces(patch.pieces, patch.text)))
    throw new Error('回答气泡分句格式不正确。');
  if (patch.interactionOpacity !== undefined && (typeof patch.interactionOpacity !== 'number' || !Number.isFinite(patch.interactionOpacity) || patch.interactionOpacity < 0 || patch.interactionOpacity > 1)) throw new Error('回答气泡透明度不正确。');
  if (patch.anchor !== undefined) {
    const a = patch.anchor;
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(key => !['x', 'y', 'visible', 'radius'].includes(key)) || typeof a.visible !== 'boolean' || !Number.isFinite(a.x) || !Number.isFinite(a.y) || Math.abs(a.x) > 100000 || Math.abs(a.y) > 100000 || (a.radius !== undefined && (!Number.isFinite(a.radius) || a.radius < 0 || a.radius > 10000))) throw new Error('回答气泡锚点不正确。');
  }
  return patch;
}
