/**
 * I-006 第 1 步的真实现：从一秒一次的读数（空闲秒数、锁屏、睡眠、她的窗口有没有焦点）算出"在忙 / 歇一下 / 不在 / 说不准"和专注度
 * （接口见 interface.ts，旋钮见 knobs.ts）。纯逻辑：没有计时器、没有文件、没有时钟（时间随读数进来），只在内存里记当前状态。
 *
 * 规矩（不是旋钮）：
 *  - 没操作不等于走了：很久没动、但没锁屏没睡眠，只是"说不准"，不会变成"不在"。只有锁屏、电脑睡眠才是"不在"。
 *  - 读不到（null、不是数、负数）= 说不准，并且忘掉之前的专注度：不产生任何新行为。
 *  - 你在她自己的窗口里操作是在找她：专注度不涨、很快落下去；你刚在忙就转过来，算"歇一下"（每忙一段一次）。
 *  - 除状态本身（哪一种、专注度、从几点开始、这一段做了几分钟）外什么都不记。
 */
import { USER_ACTIVITY_KNOBS, type UserActivityKnobs } from './knobs';
import { UNKNOWN_ACTIVITY, type UserActivityHost, type UserActivityPretend, type UserActivitySample, type UserActivityView } from './interface';

const MINUTE = 60_000;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
/** 测试假装"在忙"时显示的"已经忙了多久"（只用于她的话里，假的）。 */
const PRETEND_BUSY_MINUTES = 12;

interface Pause { readonly since: number; readonly cause: 'idle' | 'came' }
interface Override { readonly kind: UserActivityPretend; readonly since: number; readonly until: number }

export class UserActivityTracker implements UserActivityHost {
  private focus = 0;
  private peak = 0;
  private busy = false;
  private busySince = 0;
  private stretchSince: number | null = null;
  private restUsed = false;
  private pause: Pause | null = null;
  private awaySince: number | null = null;
  private last: number | null = null;
  private current: UserActivityView = UNKNOWN_ACTIVITY;
  private override: Override | null = null;

  constructor(private readonly knobs: UserActivityKnobs = USER_ACTIVITY_KNOBS) {}

  tick(sample: UserActivitySample): UserActivityView {
    const now = sample?.now;
    if (typeof now !== 'number' || !Number.isFinite(now)) return this.view();
    if (this.override && now < this.override.until) return this.view(now);
    this.override = null;
    const dt = this.last === null ? 0 : clamp((now - this.last) / 1000, 0, this.knobs.tickCapSec);
    this.last = now;
    if (sample.locked === true || sample.asleep === true) {
      this.forget();
      this.awaySince ??= now;
      return this.current = Object.freeze({ state: 'away', focus: 0, since: this.awaySince, busyMinutes: 0 });
    }
    this.awaySince = null;
    const idle = sample.idleSeconds;
    if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) { this.forget(); return this.current = UNKNOWN_ACTIVITY; }

    const k = this.knobs;
    const operating = idle < k.operatingBelowSec, toHer = operating && sample.windowFocused === true;
    if (operating && !toHer) {
      this.focus = Math.min(1, this.focus + dt / (k.riseMinutes * 60));
      this.peak = Math.max(this.peak, this.focus);
    } else if (toHer) this.focus = Math.max(0, this.focus - dt / (k.returnFallMinutes * 60));
    else this.focus = Math.max(0, this.focus - dt / (k.fallMinutes * 60));
    if (this.stretchSince === null && this.focus > 0) this.stretchSince = now;
    if (!this.busy && this.focus >= k.busyAt) { this.busy = true; this.busySince = now; }
    else if (this.busy && this.focus < k.busyLeaveAt) { this.busy = false; this.restUsed = false; this.peak = 0; this.stretchSince = null; }
    if (!this.busy && this.focus <= 0) { this.peak = 0; this.stretchSince = null; }

    if (this.pause && ((operating && !toHer) || now - this.pause.since >= k.pause.endsAfterMinutes * MINUTE)) this.pause = null;
    if (!this.pause && this.busy && !this.restUsed) {
      if (toHer) { this.pause = { since: now, cause: 'came' }; this.restUsed = true; }
      else if (this.peak >= k.pause.needsPeak && idle >= k.pause.fromIdleSec && idle <= k.pause.toIdleSec) { this.pause = { since: now, cause: 'idle' }; this.restUsed = true; }
    }
    return this.current = this.build(now);
  }

  view(now?: number): UserActivityView {
    const at = now ?? this.last ?? 0;
    if (this.override && at < this.override.until) return this.pretended(this.override);
    return this.current;
  }

  pretend(kind: UserActivityPretend | null, now: number): void {
    if (kind === null || !Number.isFinite(now)) { this.override = null; return; }
    const minutes = kind === 'pause' ? this.knobs.pause.endsAfterMinutes : this.knobs.pretendMinutes;
    this.override = { kind, since: now, until: now + minutes * MINUTE };
  }

  pretending(now: number): boolean { return !!this.override && now < this.override.until; }

  reset(): void { this.forget(); this.last = null; this.awaySince = null; this.override = null; this.current = UNKNOWN_ACTIVITY; }

  private forget(): void {
    this.focus = 0; this.peak = 0; this.busy = false; this.busySince = 0; this.stretchSince = null; this.restUsed = false; this.pause = null;
  }

  private build(now: number): UserActivityView {
    const busyMinutes = this.stretchSince === null ? 0 : Math.max(0, (now - this.stretchSince) / MINUTE);
    if (this.pause) return Object.freeze({ state: 'pause', focus: this.focus, since: this.pause.since, busyMinutes, cause: this.pause.cause });
    if (this.busy) return Object.freeze({ state: 'busy', focus: this.focus, since: this.busySince, busyMinutes });
    // Not "在忙" yet (or no longer), but the focus is still there: it already slows her boredom a little (effects.ts quietPace).
    return this.focus > 0 ? Object.freeze({ state: 'unknown', focus: this.focus, since: 0, busyMinutes: 0 }) : UNKNOWN_ACTIVITY;
  }

  private pretended(o: Override): UserActivityView {
    return o.kind === 'busy'
      ? Object.freeze({ state: 'busy', focus: 1, since: o.since, busyMinutes: PRETEND_BUSY_MINUTES, pretended: true })
      : Object.freeze({ state: 'pause', focus: 0.8, since: o.since, busyMinutes: PRETEND_BUSY_MINUTES, cause: 'idle', pretended: true });
  }
}
