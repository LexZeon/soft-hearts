import { BEHAVIOR_RECIPES } from '../shared/behavior-recipes';
import type { IdleMotionCandidate } from '../shared/idle-motion';

/** No current asset has continuous-use approval. A one-shot QA pass does not populate this registry. */
export const CONTINUOUS_IDLE_CANDIDATES: readonly IdleMotionCandidate[] = Object.freeze([]);

/** Host-only fixed-resource qualification; never receives renderer/card/settings data. */
export function reviewedIdleCandidates(rows: readonly IdleMotionCandidate[]): readonly IdleMotionCandidate[] {
  if (!Array.isArray(rows) || rows.length > 16) return Object.freeze([]);
  const valid = rows.filter((row: IdleMotionCandidate) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const fields = Object.getOwnPropertyDescriptors(row);
    const keys = ['recipeId', 'revision', 'sha256', 'durationMs', 'strength', 'validation'];
    if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key]
      || !Object.hasOwn(fields[key], 'value') || fields[key].get || fields[key].set)) return false;
    if (row?.recipeId !== 'idle.neutral' && row?.recipeId !== 'idle.proud') return false;
    const resource = BEHAVIOR_RECIPES[row.recipeId];
    return row.validation === 'continuous-use-verified' && row.sha256 === resource.sha256
      && row.durationMs === resource.durationMs && typeof row.revision === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(row.revision)
      && Number.isFinite(row.strength) && row.strength > 0 && row.strength <= 0.3;
  });
  return Object.freeze(valid.filter(row => valid.filter(other => other.recipeId === row.recipeId).length === 1)
    .map(row => Object.freeze({ ...row })));
}
