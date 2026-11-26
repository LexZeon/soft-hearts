/**
 * I-136: the stage's side of the picked face (MoodView.touchFace). Kept apart from face.ts so the companion window does not load the scorer.
 */
import type { TouchFaceEvent, TouchFaceId, TouchFaceView } from './interface';
import { TOUCH_FACES } from './knobs';

const ID = /^[A-Za-z0-9:_-]{1,160}$/u;
const KINDS = new Set(['click', 'pinch', 'pull']);

/** Strict: anything odd is "no pick" (the pinch then shows only its physical movement). The amounts are always the table's own. */
export function readTouchFace(value: unknown): TouchFaceView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (typeof v.id !== 'string' || !ID.test(v.id) || !KINDS.has(v.kind as string) || typeof v.face !== 'string' || !Object.hasOwn(TOUCH_FACES, v.face)
    || !n(v.at) || !n(v.until)) return null;
  const row = TOUCH_FACES[v.face as TouchFaceId];
  return { id: v.id, kind: v.kind as TouchFaceEvent, face: v.face as TouchFaceId, smile: row.smile, eyelids: row.eyelids, at: v.at as number, until: v.until as number };
}

/** The pinch layer's face: the view's pick when it is a pinch face, else null. */
export function pinchFacePick(value: unknown): { smile: number; eyelids: number } | null {
  const face = readTouchFace(value);
  return face && face.kind === 'pinch' ? { smile: face.smile, eyelids: face.eyelids } : null;
}
