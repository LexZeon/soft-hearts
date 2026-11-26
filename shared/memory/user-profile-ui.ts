// Type-only projection: renderer code gains no store, file or extraction API.
export type { ReviewShown, UserDiaryEntry, UserProfileEntry, UserProfileKind, UserProfileView } from '../../electron/memory/user-profile';
export type { UpcomingShown, UpcomingState } from '../behaviors/upcoming/interface';
import type { UserProfileKind } from '../../electron/memory/user-profile';

export interface UserProfileExpected {
  scopeId: string;
  generation: number;
  revision: number;
}
export interface UserProfileToggleRequest extends UserProfileExpected { enabled: boolean }
export interface UserProfileEditRequest extends UserProfileExpected {
  id: string;
  edit: { text: string; kind: UserProfileKind };
}
export interface UserProfileDeleteRequest extends UserProfileExpected { id: string }
/** L3 diary management: a day is named by its local date; the host owns the scope. */
export interface UserDiaryEditRequest extends UserProfileExpected { date: string; text: string }
export interface UserDiaryDeleteRequest extends UserProfileExpected { date: string }
export type UserDiaryClearRequest = UserProfileExpected;
/** P-001 她记得的事: one thing is named by its id (the host owns the scope); clearing takes nothing more. */
export interface UserUpcomingDeleteRequest extends UserProfileExpected { id: string }
export type UserUpcomingClearRequest = UserProfileExpected;
/** I-088 第 1 条 her look-backs: one is named by its kind and period key (a week by the date of its Monday, a month by "YYYY-MM"); the host owns the scope. */
export interface UserReviewEditRequest extends UserProfileExpected { kind: 'week' | 'month'; key: string; text: string }
export interface UserReviewDeleteRequest extends UserProfileExpected { kind: 'week' | 'month'; key: string }

/** Optional message constraint, never a grant to enable collection or select a scope. */
export function validateUserProfileExpected(input: unknown): UserProfileExpected | null {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('用户画像消息范围不正确。');
  const names = ['scopeId', 'generation', 'revision'];
  if (Reflect.ownKeys(input).length !== names.length) throw Error('用户画像消息范围不正确。');
  const values: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('用户画像消息范围不正确。');
    values[name] = descriptor.value;
  }
  if (typeof values.scopeId !== 'string' || !/^[a-f0-9]{64}$/.test(values.scopeId)
    || !Number.isSafeInteger(values.generation) || (values.generation as number) < 0
    || !Number.isSafeInteger(values.revision) || (values.revision as number) < 0) throw Error('用户画像消息范围不正确。');
  return { scopeId: values.scopeId, generation: values.generation as number, revision: values.revision as number };
}
