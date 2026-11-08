/**
 * #32 照着做的一侧：舞台（src/stage/mood-feedback.ts）按主机挑好的这一份点心的吃法张嘴、嚼、摇头。这里不做决定。
 *
 * 连续（R29，"像 K 帧"）：
 *  - 张嘴、嚼的快慢和大小不是一下子换掉：每一帧朝这一份的值平滑地靠过去（打算晚到几十毫秒也不跳）；
 *    嚼的节拍按"嚼的时钟"累加（时钟 += dt × 快慢），所以快慢变了相位也不跳。
 *  - 摇头是加在头部弹簧目标上的一小段：sin²（起止都是 0、速度也是 0）× 来回几下，再经过原来的弹簧，速度连续。
 *  - 没有打算（自动表现关着、假实现给的照常、旧主机）时，四个倍数正好是 1、摇头正好是 0：舞台每一帧和原来逐位一样。
 */
import { isFeedEatSound, isFeedOpenSound } from '../../feed-cue';
import type { FeedCueView, FeedEatFrame, FeedEatMoment, FeedEatStage } from './interface';

/** 安全线（不是旋钮）：只会比原来慢、比原来小；摇头很轻、很短。主机挑的和舞台读的都过这一关。 */
export const FEED_CUE_LIMITS = Object.freeze({
  openRate: [0.25, 1], openSize: [0.3, 1], chewRate: [0.4, 1], chewSize: [0.4, 1],
  shakeAmplitude: [0.005, 0.05], shakeMs: [300, 1500], shakeSwings: [1, 3],
} as const);
/** 倍数朝这一份的值靠过去的快慢（每秒）。 */
const EASE = 8;

const within = (value: unknown, [low, high]: readonly [number, number]): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9_:-]{1,140}$/u;

/** 主机交来的打算：形状和范围都对才用（拷一份），否则 null（舞台照原来的）。 */
export function readFeedCueView(value: unknown): FeedCueView | null {
  if (!record(value) || typeof value.sessionId !== 'string' || !ID.test(value.sessionId) || !record(value.open)) return null;
  const L = FEED_CUE_LIMITS, o = value.open;
  if (typeof o.id !== 'string' || !ID.test(o.id) || (o.sound !== null && !isFeedOpenSound(o.sound)) || !record(o.mouth)
    || !within(o.mouth.rate, L.openRate) || !within(o.mouth.size, L.openSize)) return null;
  let shake: FeedCueView['open']['shake'] = null;
  if (o.shake !== null) {
    const s = o.shake;
    if (!record(s) || !within(s.amplitude, L.shakeAmplitude) || !within(s.ms, L.shakeMs) || !Number.isInteger(s.swings) || !within(s.swings, L.shakeSwings)) return null;
    shake = { amplitude: s.amplitude, ms: s.ms, swings: s.swings };
  }
  const open = { id: o.id, sound: o.sound as FeedCueView['open']['sound'], mouth: { rate: o.mouth.rate, size: o.mouth.size }, shake };
  if (value.eat === undefined) return { sessionId: value.sessionId, open };
  const e = value.eat;
  if (!record(e) || typeof e.id !== 'string' || !ID.test(e.id) || (e.sound !== null && !isFeedEatSound(e.sound)) || !record(e.chew)
    || !within(e.chew.rate, L.chewRate) || !within(e.chew.size, L.chewSize)) return null;
  return { sessionId: value.sessionId, open, eat: { id: e.id, sound: e.sound as NonNullable<FeedCueView['eat']>['sound'], chew: { rate: e.chew.rate, size: e.chew.size } } };
}

const toward = (value: number, target: number, dt: number): number => value === target ? value : target + (value - target) * Math.exp(-EASE * dt);

/** 舞台这一侧（接口见 interface.ts FeedEatStage）。 */
export class FeedEatPerformer implements FeedEatStage {
  private openRate = 1;
  private openSize = 1;
  private chewRate = 1;
  private chewSize = 1;
  private input: unknown = undefined;
  private plan: FeedCueView | null = null;
  /** 摇过头的那一份（同一份只摇一次）。 */
  private shookId = '';
  private shake: { amplitude: number; seconds: number; swings: number; t: number } | null = null;

  reset(): void {
    this.openRate = this.openSize = this.chewRate = this.chewSize = 1;
    this.input = undefined; this.plan = null; this.shookId = ''; this.shake = null;
  }

  frame(dt: number, moment: FeedEatMoment, planInput: FeedCueView | null | undefined, headAllowed: boolean): FeedEatFrame {
    const step = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    if (planInput !== this.input) { this.input = planInput; this.plan = planInput == null ? null : readFeedCueView(planInput); }
    const plan = moment.feeding ? this.plan : null;
    this.openRate = toward(this.openRate, plan ? plan.open.mouth.rate : 1, step);
    this.openSize = toward(this.openSize, plan ? plan.open.mouth.size : 1, step);
    this.chewRate = toward(this.chewRate, plan?.eat ? plan.eat.chew.rate : 1, step);
    this.chewSize = toward(this.chewSize, plan?.eat ? plan.eat.chew.size : 1, step);
    if (plan?.open.shake && moment.holding && plan.open.id !== this.shookId) {
      this.shookId = plan.open.id;
      this.shake = { amplitude: plan.open.shake.amplitude, seconds: plan.open.shake.ms / 1000, swings: plan.open.shake.swings, t: 0 };
    }
    let yaw = 0;
    const s = this.shake;
    if (s) {
      s.t += step;
      if (s.t >= s.seconds) this.shake = null;
      else if (headAllowed) {
        const phase = s.t / s.seconds, window = Math.sin(Math.PI * phase);
        yaw = s.amplitude * Math.sin(2 * Math.PI * s.swings * phase) * window * window;
      }
    }
    return { openRate: this.openRate, openSize: this.openSize, chewRate: this.chewRate, chewSize: this.chewSize, yaw };
  }
}
