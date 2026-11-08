/**
 * I-006 第 1 步的假实现：固定一种状态，不看读数。守约测试（tests/user-activity.test.ts）拿它和真实现跑同一组约定；
 * 别的功能的测试用它把"你在忙 / 歇一下 / 不在"固定住，去看那条路自己的行为。
 */
import { UNKNOWN_ACTIVITY, type UserActivityHost, type UserActivityPretend, type UserActivitySample, type UserActivityView } from './interface';

export class FixedUserActivity implements UserActivityHost {
  readonly samples: UserActivitySample[] = [];
  constructor(private current: UserActivityView = UNKNOWN_ACTIVITY) {}

  /** 换一种固定的状态。 */
  set(view: UserActivityView): void { this.current = view; }
  tick(sample: UserActivitySample): UserActivityView { this.samples.push(sample); return this.current; }
  view(): UserActivityView { return this.current; }
  pretend(): void { /* 固定的：假装没有用。 */ }
  pretending(): boolean { return false; }
  reset(): void { this.current = UNKNOWN_ACTIVITY; }
}

export const BUSY_ACTIVITY: UserActivityView = Object.freeze({ state: 'busy', focus: 1, since: 1, busyMinutes: 30 });
export const PAUSE_ACTIVITY: UserActivityView = Object.freeze({ state: 'pause', focus: 0.8, since: 1, busyMinutes: 30, cause: 'idle' });
