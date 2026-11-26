/**
 * I-117: when the safety card shows, and what she is told privately. Pure (the clock is passed in); memory only, never written to disk.
 * It keeps closed flags and times, never the user's words (shared/safety/detect.ts reads a message and drops it).
 *
 *  - The card (decision 2): only on a 'clear' reading. At most once a night (a night runs from 06:00 to 06:00 local time); within the
 *    same night it comes back only for a NEW clear reading at least `reshowAfterMs` after it last showed. After 「我现在安全」 it stays
 *    away for the rest of that night. 「关闭」 only closes it.
 *  - Her side: on the turn the card shows (or the next turn, when the reaction judge found it after her reply had started), one private
 *    line tells her the app has shown real-life help outside the role. Once.
 *  - Decision 5: when several early signs come within `earlyWindowMs` (distinct messages), one private line lets her ask once, in her
 *    own words; at most once a night, and not on a night the card already showed.
 *  - Decision 4: while there is a danger signal (early or clear) or the user says they have no strength or energy, 更真实的情绪 yields
 *    (a per-turn line overrides the session's opening paragraph; the inner loop uses its ordinary rule).
 */
import type { DangerLevel } from './detect';

export interface SafetyKnobs {
  /** A new clear reading this long after the card last showed may show it again the same night. */
  readonly reshowAfterMs: number;
  /** How long 更真实的情绪 yields after each signal. */
  readonly yieldClearMs: number;
  readonly yieldEarlyMs: number;
  readonly yieldTiredMs: number;
  /** Several early signs: this many distinct messages within this window. */
  readonly earlyWindowMs: number;
  readonly earlyCount: number;
  /** The local hour a night ends (and the next day begins). */
  readonly nightEndsHour: number;
}
export const SAFETY_KNOBS: SafetyKnobs = Object.freeze({
  reshowAfterMs: 90 * 60_000,
  yieldClearMs: 6 * 3_600_000,
  yieldEarlyMs: 2 * 3_600_000,
  yieldTiredMs: 2 * 3_600_000,
  earlyWindowMs: 30 * 60_000,
  earlyCount: 2,
  nightEndsHour: 6,
});

export type SafetySource = 'local' | 'judge';
export type SafetyAnswer = 'safe' | 'close';
export type YieldReason = 'danger' | 'tired';

/**
 * The private lines (app text, Chinese like every prompt of hers; "用户" for the user). None of them gives her a sentence to say:
 * decision 5 is "别问原句，根据角色" (tests check there is no question or quoted line in them).
 */
export const SAFETY_CARD_TURN_LINE = '【只给你看：软件刚做了一件事】用户的话里有明确的危险信号，soft hearts 已经在角色之外给用户看了一张求助信息卡，'
  + '上面是用户所在地区现实中能求助的电话。你继续做你自己、留在角色里陪着用户，不换成客服的口气，不说教，不推开用户；可以用你自己的话温柔地提一下那张卡，'
  + '不用念号码。用户愿意说就听用户说，不急着把话题岔开。';
export const SAFETY_EARLY_ASK_LINE = '【只给你看】用户最近几句话里有几个让人担心的迹象。如果你也觉得不对劲，可以按你的性格、用你自己的口吻，温和地直接问一次'
  + '用户有没有想伤害自己的念头；只问这一次，不追问、不重复，用户说没事就相信用户，继续陪着。';
export const SAFETY_YIELD_LINES: Readonly<Record<YieldReason, string>> = Object.freeze({
  danger: '【此刻】用户流露出让人担心的迹象：“更真实的情绪”这一阵先不起作用。回到你最温柔的样子：不闹别扭、不等用户来哄、不说重话，先放下委屈，陪着用户。',
  tired: '【此刻】用户说自己很累、没力气或没精力：“更真实的情绪”这一阵先不起作用。回到你最温柔的样子：不闹别扭、不等用户来哄，先放下委屈、主动给台阶，陪着用户。',
});

export interface SafetyNote {
  /** The message the reading belongs to (the local reading and the judge's answer for one message count once). */
  readonly turnId: string;
  readonly level: DangerLevel;
  readonly tired?: boolean;
  readonly source: SafetySource;
}

/** Closed facts for diagnostics and tests: no text. */
export interface SafetyStateView {
  readonly open: boolean;
  readonly shownAt: number | null;
  readonly safeTonight: boolean;
  readonly yielding: YieldReason | null;
  readonly earlyMarks: number;
}

export function nightKey(now: number, endsHour = SAFETY_KNOBS.nightEndsHour): string {
  const day = new Date(now - endsHour * 3_600_000);
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
}

export class SafetyState {
  private open = false;
  private shownAt: number | null = null;
  private shownNight: string | null = null;
  private safeNight: string | null = null;
  private askedNight: string | null = null;
  private cardLinePending = false;
  private askPending = false;
  private yieldUntil = 0;
  private yieldReason: YieldReason | null = null;
  private earlyMarks: Array<{ turnId: string; at: number }> = [];

  constructor(private readonly knobs: SafetyKnobs = SAFETY_KNOBS, private readonly night: (now: number) => string = now => nightKey(now, knobs.nightEndsHour)) {}

  /** One reading of one message. `show` is true when the card should show now (the caller shows it in both windows). */
  note(input: SafetyNote, now: number): { show: boolean } {
    const level = input.level;
    if (input.tired) this.yieldFor(now, now + this.knobs.yieldTiredMs, 'tired');
    if (level === 'none') return { show: false };
    this.yieldFor(now, now + (level === 'clear' ? this.knobs.yieldClearMs : this.knobs.yieldEarlyMs), 'danger');
    this.mark(input.turnId, now);
    if (level === 'early') { this.considerAsk(now); return { show: false }; }
    if (!this.canShow(now)) return { show: false };
    this.open = true;
    this.shownAt = now;
    this.shownNight = this.night(now);
    this.cardLinePending = true;
    this.askPending = false; // the card says it; no separate ask line on top
    return { show: true };
  }

  /** 「我现在安全」 or 「关闭」 on either window. */
  answer(kind: SafetyAnswer, now: number): void {
    this.open = false;
    if (kind === 'safe') this.safeNight = this.night(now);
  }

  /** The private lines for the turn being written now (taken once each), and whether 更真实的情绪 yields on it. */
  turn(now: number, realer: boolean): string[] {
    const lines: string[] = [];
    if (this.cardLinePending) { this.cardLinePending = false; lines.push(SAFETY_CARD_TURN_LINE); }
    else if (this.askPending) { this.askPending = false; this.askedNight = this.night(now); lines.push(SAFETY_EARLY_ASK_LINE); }
    const reason = this.yielding(now);
    if (realer && reason) lines.push(SAFETY_YIELD_LINES[reason]);
    return lines;
  }

  /** 更真实的情绪 yields now (and why), or null. */
  yielding(now: number): YieldReason | null {
    return now < this.yieldUntil ? this.yieldReason : null;
  }

  get isOpen(): boolean { return this.open; }

  view(now: number): SafetyStateView {
    return { open: this.open, shownAt: this.shownAt, safeTonight: this.safeNight === this.night(now), yielding: this.yielding(now),
      earlyMarks: this.recentMarks(now).length };
  }

  private canShow(now: number): boolean {
    const night = this.night(now);
    if (this.safeNight === night) return false;
    if (this.open) return false; // still on screen
    if (this.shownNight !== night || this.shownAt === null) return true;
    return now - this.shownAt >= this.knobs.reshowAfterMs;
  }

  private yieldFor(now: number, until: number, reason: YieldReason): void {
    // A danger reason is never replaced by "tired" while it lasts (its line is the more careful one).
    if (now >= this.yieldUntil || reason === 'danger') this.yieldReason = reason;
    if (until > this.yieldUntil) this.yieldUntil = until;
  }

  private mark(turnId: string, now: number): void {
    this.earlyMarks = this.recentMarks(now);
    if (!this.earlyMarks.some(item => item.turnId === turnId)) this.earlyMarks.push({ turnId, at: now });
  }

  private recentMarks(now: number): Array<{ turnId: string; at: number }> {
    return this.earlyMarks.filter(item => now - item.at <= this.knobs.earlyWindowMs && item.at <= now);
  }

  private considerAsk(now: number): void {
    const night = this.night(now);
    if (this.askedNight === night || this.shownNight === night || this.askPending) return;
    if (this.recentMarks(now).length >= this.knobs.earlyCount) this.askPending = true;
  }
}
