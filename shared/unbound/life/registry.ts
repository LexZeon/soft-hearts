/**
 * Unbound v1 step 4: her own actions. To add one (a hop, a little dance, reaching out): write actions/<name>.ts exporting a
 * LifeActionSpec (its level, when it makes sense, its key frames) and add it to this list. Nothing else changes: the arbiter, the
 * schedule and gaps, the mood reading, the host and the page's player take it from here (electron/unbound/README.md「加一个她自己的动作」).
 * Order matters only among actions of the same level: the first listed wins a tie.
 */
import type { LifeActionSpec } from './action';
import { PLACE } from './actions/place';
import { SHIFT } from './actions/shift';
import { GLANCE } from './actions/glance';
import { PAUSE } from './actions/pause';

export const LIFE_ACTIONS: readonly LifeActionSpec[] = Object.freeze([PLACE, GLANCE, SHIFT, PAUSE]);
export const LIFE_ACTION_IDS: readonly string[] = Object.freeze(LIFE_ACTIONS.map(action => action.id));
export const lifeAction = (id: string): LifeActionSpec | null => LIFE_ACTIONS.find(action => action.id === id) ?? null;
