/** I-184: the plan in a director command as the page reads it: the peek's, or a close moment's (anything else: null). */
import { parsePeekPlan, type DirectorPlan } from '../director';
import { parseCloseMomentPlan } from './plan';

export function parseDirectorPlan(value: unknown): DirectorPlan | null {
  return parsePeekPlan(value) ?? parseCloseMomentPlan(value);
}
