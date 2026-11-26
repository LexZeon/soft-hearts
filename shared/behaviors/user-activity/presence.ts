/**
 * I-066 你现在方便吗：the one shared judgment (interface.ts PresenceView) every feature that may interrupt the user asks first.
 * Plan docs/claude/2026-11-10-proactive-presence-plan.md (the user's corrections of 2026-11-10: the companion being open means the user is
 * open to her; busy never stops her; only a call or meeting, a locked or asleep computer, or the user being away does).
 *
 * Pure logic: no timer, no file, no clock of its own (time comes in with the readings), memory only. It keeps the latest reading, when
 * the current away stretch began, the "just back" window, the one screen-look verdict and the times of the looks in the past hour.
 *
 * Rules (thresholds in knobs.ts `presence`):
 *  - switch 「知道你是不是在忙」 off (or nothing readable): only "the user interacted with her in the last offInteractionMinutes" counts as
 *    present (idle / yes); otherwise unknown / no.
 *  - locked or asleep → away / no.
 *  - a meeting seen by the screen look (cached lookCacheMinutes) → meeting / no, whatever the input does.
 *  - input after an away stretch → back / yes for backMinutes (the best moment).
 *  - input within unsureAfterSec → idle / yes, or busy / gently (busy is never "no").
 *  - no input for longer (unsure):
 *      a fresh look decides: desktop → away / no; unknown → unknown / no (hold); watching, gaming, working, browsing → present;
 *      the local camera sees nobody → away / no; sees somebody and screen sharing is off → present;
 *      a look is possible (sharing on, within perHour, none in flight, no failure in the last lookCacheMinutes) → no, `lookWanted`;
 *      a look is in flight → no (hold until it answers);
 *      otherwise the input alone: ≥ awayAfterMinutes → away / no, else present.
 */
import { USER_ACTIVITY_KNOBS, type UserActivityKnobs } from './knobs';
import {
  NOT_PRESENT, SCREEN_LOOKS, type PresenceContext, type PresencePretend, type PresenceView, type ScreenLook, type UserActivitySample,
} from './interface';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A reading older than this is not a reading (the one-second tick stopped). */
const STALE_MS = 5_000;
/** How long a pretended "back" says the user was away (so the greeting rule can be tried). */
const PRETEND_AWAY_MINUTES = 45;

interface Reading { readonly now: number; readonly idleSeconds: number | null; readonly locked: boolean; readonly asleep: boolean }
interface Override { readonly kind: PresencePretend; readonly until: number }

export class PresenceJudge {
  private reading: Reading | null = null;
  private awaySince: number | null = null;
  /** The present stretch was confirmed by a look or the camera while there was no input: it is not an absence. */
  private seenWhileStill = false;
  private back: { readonly since: number; readonly awayMinutes: number } | null = null;
  private look: { readonly look: ScreenLook; readonly at: number } | null = null;
  private looks: number[] = [];
  private looking: { readonly token: number } | null = null;
  private failedAt = -Infinity;
  private token = 0;
  private override: Override | null = null;

  constructor(private readonly knobs: UserActivityKnobs = USER_ACTIVITY_KNOBS) {}

  /** The one-second reading (the same sample the tracker gets). `person`: the local camera, when it runs. */
  tick(sample: UserActivitySample, person?: boolean | null): void {
    const now = sample?.now;
    if (typeof now !== 'number' || !Number.isFinite(now)) return;
    const idle = typeof sample.idleSeconds === 'number' && Number.isFinite(sample.idleSeconds) && sample.idleSeconds >= 0 ? sample.idleSeconds : null;
    const locked = sample.locked === true, asleep = sample.asleep === true;
    this.reading = { now, idleSeconds: idle, locked, asleep };
    const k = this.knobs.presence;
    if (person === true && idle !== null && !locked && !asleep) this.seenWhileStill = true;
    const still = idle !== null && idle * 1000 >= k.awayAfterMinutes * MINUTE;
    if (locked || asleep || (still && !this.seenWhileStill)) {
      const start = idle !== null ? now - idle * 1000 : now;
      this.awaySince = this.awaySince === null ? start : Math.min(this.awaySince, start);
      this.back = null;
      return;
    }
    if (idle === null) return;
    if (idle * 1000 < k.awayAfterMinutes * MINUTE && idle < k.unsureAfterSec) {
      // Input again: an away stretch ends here ("刚回来"), and a stretch confirmed by a look or the camera is over.
      if (this.awaySince !== null) {
        const returned = now - idle * 1000;
        this.back = { since: returned, awayMinutes: Math.max(0, Math.floor((returned - this.awaySince) / MINUTE)) };
      }
      this.awaySince = null;
      this.seenWhileStill = false;
    }
    if (this.back && now - this.back.since >= k.backMinutes * MINUTE) this.back = null;
  }

  /** The judgment now. */
  judge(now: number, context: PresenceContext): PresenceView {
    const k = this.knobs.presence;
    if (this.override && now < this.override.until) return this.pretended(this.override.kind);
    this.override = null;
    if (!context?.switchOn) return this.byInteraction(now, context);
    const r = this.reading;
    if (!r || now < r.now || now - r.now > STALE_MS) return this.byInteraction(now, context);
    if (r.locked || r.asleep) return Object.freeze({ presence: 'away', interrupt: 'no', source: 'input', why: 'locked' });
    const look = this.freshLook(now);
    if (look === 'meeting') return Object.freeze({ presence: 'meeting', interrupt: 'no', source: 'screen', why: 'meeting' });
    if (r.idleSeconds === null) return this.byInteraction(now, context);
    if (this.back && now >= this.back.since && now - this.back.since < k.backMinutes * MINUTE)
      return Object.freeze({ presence: 'back', interrupt: 'yes', source: 'input', awayMinutes: this.back.awayMinutes });
    const busy = context.activity?.state === 'busy';
    const present = (source: PresenceView['source']): PresenceView => Object.freeze(busy
      ? { presence: 'busy', interrupt: 'gently', source } : { presence: 'idle', interrupt: 'yes', source });
    if (r.idleSeconds < k.unsureAfterSec) return present('input');
    // Unsure: no input for a while, the screen not locked.
    if (look === 'desktop') return Object.freeze({ presence: 'away', interrupt: 'no', source: 'screen', why: 'desktop' });
    if (look === 'unknown') return Object.freeze({ presence: 'unknown', interrupt: 'no', source: 'screen', why: 'look-unknown' });
    if (look) return present('screen');
    if (context.person === false) return Object.freeze({ presence: 'away', interrupt: 'no', source: 'camera', why: 'nobody' });
    // Somebody in front of the camera does not rule out a call: with screen sharing on, the look still runs.
    if (context.person === true && !context.screenOn) return present('camera');
    const long = r.idleSeconds * 1000 >= k.awayAfterMinutes * MINUTE;
    const state = long ? 'away' : busy ? 'busy' : 'idle';
    if (this.looking) return Object.freeze({ presence: state, interrupt: 'no', source: 'screen', why: 'looking' });
    if (this.mayLook(now, context)) return Object.freeze({ presence: state, interrupt: 'no', source: 'input', why: 'looking', lookWanted: true });
    if (context.person === true) return present('camera');
    return long ? Object.freeze({ presence: 'away', interrupt: 'no', source: 'input', why: 'idle-long' }) : present('input');
  }

  /**
   * Start one screen look now, if the judgment wants one: returns a token for `endLook`, or null (sharing off, the hourly count used,
   * one in flight, a fresh verdict, a recent failure). Counted at the start, so a failed look still counts.
   */
  beginLook(now: number, context: PresenceContext): number | null {
    if (!this.mayLook(now, context)) return null;
    this.looks.push(now);
    this.looking = { token: ++this.token };
    return this.token;
  }

  /** The look's verdict (null: it failed, timed out or answered outside the closed list). A stale token is dropped. */
  endLook(token: number, verdict: ScreenLook | null, now: number): void {
    if (!this.looking || this.looking.token !== token) return;
    this.looking = null;
    if (verdict === null || !(SCREEN_LOOKS as readonly string[]).includes(verdict)) { this.failedAt = now; return; }
    this.look = { look: verdict, at: now };
    // A look that sees the user there (not a desktop, not "can't tell") means the stillness was not an absence.
    if (verdict !== 'desktop' && verdict !== 'unknown') { this.seenWhileStill = true; this.awaySince = null; }
  }

  /** How many looks in the past hour (developer view, tests). */
  looksInLastHour(now: number): number { this.looks = this.looks.filter(at => now - at < HOUR && at <= now); return this.looks.length; }
  /** The fresh verdict, if any (developer view, journal). */
  verdict(now: number): ScreenLook | null { return this.freshLook(now); }
  lookInFlight(): boolean { return this.looking !== null; }

  /** 测试：假装 (null: stop). Lasts `pretendMinutes` (back: `backMinutes`). */
  pretend(kind: PresencePretend | null, now: number): void {
    if (kind === null || !Number.isFinite(now)) { this.override = null; return; }
    const minutes = kind === 'back' ? this.knobs.presence.backMinutes : this.knobs.pretendMinutes;
    this.override = { kind, until: now + minutes * MINUTE };
  }
  pretending(now: number): boolean { return !!this.override && now < this.override.until; }

  /** Screen sharing turned off: the verdict (and a look in flight) is forgotten at once. */
  forgetScreen(): void { this.look = null; this.looking = null; this.failedAt = -Infinity; }

  /** The switch off: forget everything. */
  reset(): void {
    this.reading = null; this.awaySince = null; this.seenWhileStill = false; this.back = null; this.override = null;
    this.forgetScreen(); this.looks = [];
  }

  private mayLook(now: number, context: PresenceContext): boolean {
    const k = this.knobs.presence;
    if (context?.screenOn !== true || this.looking || this.freshLook(now) !== null) return false;
    if (now - this.failedAt < k.look.cacheMinutes * MINUTE) return false;
    return this.looksInLastHour(now) < k.look.perHour;
  }

  private freshLook(now: number): ScreenLook | null {
    const look = this.look;
    if (!look || now < look.at || now - look.at > this.knobs.presence.look.cacheMinutes * MINUTE) return null;
    return look.look;
  }

  private byInteraction(now: number, context: PresenceContext | undefined): PresenceView {
    const at = context?.lastInteractionAt;
    const recent = typeof at === 'number' && Number.isFinite(at) && now >= at && now - at <= this.knobs.presence.offInteractionMinutes * MINUTE;
    return recent ? Object.freeze({ presence: 'idle', interrupt: 'yes', source: 'input' }) : NOT_PRESENT;
  }

  private pretended(kind: PresencePretend): PresenceView {
    if (kind === 'away') return Object.freeze({ presence: 'away', interrupt: 'no', source: 'input', why: 'locked', pretended: true });
    if (kind === 'meeting') return Object.freeze({ presence: 'meeting', interrupt: 'no', source: 'screen', why: 'meeting', pretended: true });
    return Object.freeze({ presence: 'back', interrupt: 'yes', source: 'input', awayMinutes: PRETEND_AWAY_MINUTES, pretended: true });
  }
}

/**
 * The greeting rule when the user comes back with nothing held (never a fixed "你回来啦" every time): only after an
 * absence of at least greet.afterAwayMinutes, with a chance set by the card's personality (clingy more often). 0 = no greeting chance.
 */
export function greetChance(view: Pick<PresenceView, 'presence' | 'awayMinutes'> | null | undefined,
  personality: Partial<Record<'playful' | 'close' | 'comfortable' | 'cautious', number>> | null | undefined,
  knobs: UserActivityKnobs = USER_ACTIVITY_KNOBS): number {
  const g = knobs.presence.greet;
  if (view?.presence !== 'back' || typeof view.awayMinutes !== 'number' || view.awayMinutes < g.afterAwayMinutes) return 0;
  let chance = g.base;
  for (const [tendency, weight] of Object.entries(g.personality)) {
    const value = personality?.[tendency as keyof typeof personality];
    chance += (weight ?? 0) * (Math.min(4, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 1)) - 1);
  }
  return Math.min(g.max, Math.max(g.min, chance));
}

/** 【此刻】's line when the user just came back from a long absence (only the state and the minutes; '' otherwise). */
export function backSentence(view: Pick<PresenceView, 'presence' | 'awayMinutes'> | null | undefined, knobs: UserActivityKnobs = USER_ACTIVITY_KNOBS): string {
  if (view?.presence !== 'back' || typeof view.awayMinutes !== 'number' || view.awayMinutes < knobs.presence.greet.afterAwayMinutes) return '';
  return `用户离开电脑约 ${Math.min(999, Math.round(view.awayMinutes))} 分钟，刚回来。`;
}
