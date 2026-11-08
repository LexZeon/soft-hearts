/**
 * I-006 第 3 步：浏览器里的视频要不要让小模型看一眼小图。
 * 纯逻辑：时间随调用进来，只在内存里记（不写盘）。
 *
 * 问一次的条件，缺一不可：浏览器在前台连续停够 browserFrontSeconds 秒；你有 idleSeconds 秒没碰键盘鼠标（读不到空闲秒数——
 * 开关关着、锁屏、读取出错——就一次都不问）；这一段"浏览器在前台、你没回来操作"里还没问过；过去一小时的次数没到上限。
 * 你一动键盘鼠标，这一段就算结束，下一次停手可以再问（次数由上限管）；浏览器离开前台，连前台时间也重新数。
 * 上限：每小时 base 次打底，过去一小时每 interactionsPerExtra 次聊天或互动多一次，最多 max 次。
 */
import { WATCH_ALONG_KNOBS, type WatchAlongKnobs } from './knobs';

const MINUTE = 60_000;
const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** 这一小时最多问几次：0 次互动 6、10 次 8、100 次 20（上限）。 */
export function browserVideoQuota(interactionsLastHour: number, knobs: WatchAlongKnobs = WATCH_ALONG_KNOBS): number {
  const q = knobs.quota, n = Math.max(0, Math.floor(finite(interactionsLastHour, 0)));
  return Math.min(q.max, q.base + Math.floor(n / Math.max(1, q.interactionsPerExtra)));
}

export interface BrowserVideoAsk { now: number; idleSeconds: number | null; interactionsLastHour: number }

export class BrowserVideoGate {
  private asks: number[] = [];
  private streak: { key: string; since: number } | null = null;
  private asked = false;

  constructor(private readonly knobs: WatchAlongKnobs = WATCH_ALONG_KNOBS) {}

  /** 此刻前台是哪个（需要看一眼才知道的）程序；null = 别的程序、她自己的窗口或读不到：前台时间重新数。 */
  front(key: string | null, now: number): void {
    if (key === null || !Number.isFinite(now)) { this.streak = null; this.asked = false; return; }
    if (this.streak?.key !== key) { this.streak = { key, since: now }; this.asked = false; }
  }

  /** 现在该问一次吗？答"是"时已经记上这一次。 */
  ask(input: BrowserVideoAsk): boolean {
    const { now } = input, streak = this.streak, idle = input.idleSeconds;
    if (!streak || !Number.isFinite(now)) return false;
    if (typeof idle !== 'number' || !Number.isFinite(idle) || idle < 0) return false;
    if (idle < this.knobs.idleSeconds) { this.asked = false; return false; } // you are back at it: the next pause may ask again
    if (this.asked || now - streak.since < this.knobs.browserFrontSeconds * 1000) return false;
    const from = now - this.knobs.quota.windowMinutes * MINUTE;
    this.asks = this.asks.filter(at => at > from && at <= now);
    if (this.asks.length >= browserVideoQuota(input.interactionsLastHour, this.knobs)) return false;
    this.asks.push(now);
    this.asked = true;
    return true;
  }

  /** 过去一小时问了几次（开发者面板和测试）。 */
  count(now: number): number {
    const from = now - this.knobs.quota.windowMinutes * MINUTE;
    return this.asks.filter(at => at > from && at <= now).length;
  }

  /** 共享关掉：全忘了。 */
  reset(): void { this.asks = []; this.streak = null; this.asked = false; }
}
