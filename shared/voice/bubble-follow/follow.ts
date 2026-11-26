/**
 * I-165: how much of one reply her bubble may show while her voice reads it.
 *
 * Pure and clock-free: the caller passes `now` and schedules its own timer from `nextChange(now)`. The same state machine runs in the
 * companion window (the native reply bubble, src/voice/bubble-follow-view.ts) and in the host for full-screen Unbound
 * (electron/unbound/bubble-hold.ts). Offsets are into the reply's shown text (the reading map, I-164, never changes it).
 *
 * - `begin(id)`: the reply will be read aloud; nothing of it is shown yet (the bubble shows "……").
 * - `segment(id, index, end)`: where sentence `index` of the host's reading plan ends.
 * - `heard(id, index, 'start' | 'end' | 'skip')`: that sentence became audible, finished, or has nothing to say (a stage direction):
 *   it is shown now. 'sentence' mode shows it whole; 'char' mode reveals it through the sentence's estimated audio time.
 * - `release(id, reason)`: the voice will not follow (ended, cancelled, failed, interrupted): everything shows, for good.
 * - A stall (the next sentence did not start in time) releases too. `pause`/`resume` (B06 feeding) freeze those clocks.
 * A cancelled, late or superseded reading never touches a newer reply: every call names its reply and only the current one counts.
 */
import { BUBBLE_FOLLOW_KNOBS, type BubbleFollowKnobs, type BubbleFollowMode } from './knobs';

export type BubbleFollowRelease = 'over' | 'cancelled' | 'error' | 'interrupted' | 'stall' | 'off' | 'superseded';
export type BubbleHeardPhase = 'start' | 'end' | 'skip';

interface Segment { end: number; knownAt: number; startAt: number | null; endAt: number | null; skipped: boolean }
interface Reply {
  id: string; mode: Exclude<BubbleFollowMode, 'off'>; begunAt: number; released: BubbleFollowRelease | null;
  segments: Map<number, Segment>;
  /** The highest offset shown whole (cumulative; never goes back). */
  shown: number;
  /** 'char' mode: the sentence being revealed now. */
  speaking: { index: number; from: number; to: number; at: number; ms: number } | null;
  /** Learned from sentences already heard: real audio milliseconds per code unit. */
  msPerChar: number | null;
  pausedAt: number | null;
  /** Never smaller than any cap returned before. */
  lastCap: number;
}

const MAX_INDEX = 127;
const okIndex = (index: unknown): index is number => Number.isInteger(index) && (index as number) >= 0 && (index as number) <= MAX_INDEX;
const okId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);

export class BubbleFollow {
  private reply: Reply | null = null;
  constructor(private readonly knobs: BubbleFollowKnobs = BUBBLE_FOLLOW_KNOBS) {}

  /** The reply being followed (released or not), or null. */
  get replyId(): string | null { return this.reply?.id ?? null; }
  /** Why the current reply stopped following (null while it still follows, or with none). */
  get released(): BubbleFollowRelease | null { return this.reply?.released ?? null; }

  /** Reply `id` will be read aloud: hold its text back. A newer reply replaces an older one (which then no longer matters). */
  begin(id: string, now: number, mode: BubbleFollowMode = this.knobs.mode): boolean {
    if (!okId(id) || mode === 'off' || !Number.isFinite(now)) return false;
    if (this.reply?.id === id) return true;
    this.reply = { id, mode: mode === 'char' ? 'char' : 'sentence', begunAt: now, released: null, segments: new Map(), shown: 0, speaking: null,
      msPerChar: null, pausedAt: null, lastCap: 0 };
    return true;
  }

  /** True while reply `id` holds text back. */
  holding(id: string | null | undefined): boolean { return !!id && this.reply?.id === id && this.reply.released === null; }

  segment(id: string, index: number, end: number, now: number): void {
    const reply = this.current(id);
    if (!reply || !okIndex(index) || !Number.isSafeInteger(end) || end < 0 || end > 100_000) return;
    const known = reply.segments.get(index);
    if (known) {
      // Heard before its end was known (a placeholder), or corrected before it was heard.
      if (known.end < 0 || (known.end !== end && known.startAt === null && !known.skipped)) known.end = end;
    } else reply.segments.set(index, { end, knownAt: now, startAt: null, endAt: null, skipped: false });
    // A sentence heard before its end was known (the plan's broadcast came late): show it now.
    this.advanceShown(reply, now);
  }

  heard(id: string, index: number, phase: BubbleHeardPhase, now: number): void {
    const reply = this.current(id);
    if (!reply || !okIndex(index) || !Number.isFinite(now) || (phase !== 'start' && phase !== 'end' && phase !== 'skip')) return;
    let segment = reply.segments.get(index);
    if (!segment) { segment = { end: -1, knownAt: now, startAt: null, endAt: null, skipped: false }; reply.segments.set(index, segment); }
    if (phase === 'skip') { segment.skipped = true; segment.startAt ??= now; segment.endAt ??= now; }
    else if (phase === 'start') {
      segment.startAt ??= now;
      // Playback is sequential: an earlier sentence that never said 'end' ended now.
      for (const [other, earlier] of reply.segments) if (other < index && earlier.startAt !== null && earlier.endAt === null) this.ended(reply, other, now);
    } else {
      segment.startAt ??= now;
      if (segment.endAt === null) this.ended(reply, index, now);
    }
    this.advanceShown(reply, now);
  }

  /** Reply `id` stops following: everything shows from now on. Sticky (a late fact never holds it again). */
  release(id: string, reason: BubbleFollowRelease): boolean {
    const reply = this.current(id);
    if (!reply) return false;
    reply.released = reason;
    reply.speaking = null;
    return true;
  }

  pause(now: number): void { const reply = this.live(); if (reply && reply.pausedAt === null) reply.pausedAt = now; }
  resume(now: number): void {
    const reply = this.live();
    if (!reply || reply.pausedAt === null) return;
    const shift = Math.max(0, now - reply.pausedAt);
    reply.pausedAt = null;
    reply.begunAt += shift;
    for (const segment of reply.segments.values()) {
      segment.knownAt += shift;
      if (segment.startAt !== null) segment.startAt += shift;
      if (segment.endAt !== null) segment.endAt += shift;
    }
    if (reply.speaking) reply.speaking.at += shift;
  }

  /**
   * How much of reply `id` the bubble may show now: null = everything (not followed, released, or another reply). Checks the
   * stall clocks first, so a reply whose voice stopped coming releases here.
   */
  cap(id: string | null | undefined, now: number): number | null {
    const reply = id ? this.current(id) : null;
    if (!reply || reply.released !== null) return null;
    if (this.stalled(reply, now)) { this.release(reply.id, 'stall'); return null; }
    let cap = reply.shown;
    const speaking = reply.speaking;
    if (speaking && reply.pausedAt === null) {
      const progress = speaking.ms <= 0 ? 1 : Math.min(1, Math.max(0, (now - speaking.at) / speaking.ms));
      cap = Math.max(cap, speaking.from + Math.floor((speaking.to - speaking.from) * progress));
    } else if (speaking) cap = Math.max(cap, reply.lastCap);
    reply.lastCap = Math.max(reply.lastCap, cap);
    return reply.lastCap;
  }

  /** When `cap` next changes by itself (a 'char' step or a stall), or null. */
  nextChange(now: number): number | null {
    const reply = this.live();
    if (!reply || reply.pausedAt !== null) return null;
    let next = this.stallAt(reply);
    const speaking = reply.speaking;
    if (speaking && speaking.to > speaking.from && now < speaking.at + speaking.ms) {
      const step = speaking.ms / (speaking.to - speaking.from);
      const done = Math.floor((now - speaking.at) / step) + 1;
      const at = speaking.at + done * step;
      next = next === null ? at : Math.min(next, at);
    }
    return next === null ? null : Math.max(now, next);
  }

  private current(id: string): Reply | null { return okId(id) && this.reply?.id === id ? this.reply : null; }
  private live(): Reply | null { return this.reply && this.reply.released === null ? this.reply : null; }

  /** Sentence `index` played out at `now`: learn her real pace from it ('char' mode estimates the next sentences with it). */
  private ended(reply: Reply, index: number, now: number): void {
    const segment = reply.segments.get(index);
    if (!segment || segment.endAt !== null) return;
    segment.endAt = now;
    const chars = this.charsOf(reply, index);
    if (chars > 0 && segment.startAt !== null && now > segment.startAt) {
      const [low, high] = this.knobs.charMsRange;
      reply.msPerChar = Math.min(high, Math.max(low, (now - segment.startAt) / chars));
    }
  }

  private charsOf(reply: Reply, index: number): number {
    const segment = reply.segments.get(index);
    if (!segment || segment.end < 0) return 0;
    let from = 0;
    for (const [other, earlier] of reply.segments) if (other < index && earlier.end >= 0) from = Math.max(from, earlier.end);
    return Math.max(0, segment.end - from);
  }

  /** Sentence-level progress: the end of the latest sentence heard (or skipped) whose end is known; 'char' mode paces the newest. */
  private advanceShown(reply: Reply, now: number): void {
    let latest = -1;
    for (const [index, segment] of reply.segments) if (segment.startAt !== null && segment.end >= 0 && index > latest) latest = index;
    if (latest < 0) return;
    const target = reply.segments.get(latest)!;
    let before = 0;
    for (const [index, segment] of reply.segments) if (index < latest && segment.end >= 0) before = Math.max(before, segment.end);
    const ended = target.endAt !== null || target.skipped;
    if (reply.mode === 'sentence' || ended) {
      reply.shown = Math.max(reply.shown, target.end);
      if (reply.speaking && reply.speaking.index <= latest) reply.speaking = null;
      return;
    }
    // 'char': everything before this sentence is shown whole; this one is revealed through its estimated audio time.
    reply.shown = Math.max(reply.shown, before);
    if (reply.speaking?.index === latest) return;
    const from = Math.max(before, reply.shown), chars = Math.max(0, target.end - from);
    const [low, high] = this.knobs.charMsRange;
    const per = Math.min(high, Math.max(low, reply.msPerChar ?? this.knobs.charMs));
    reply.speaking = { index: latest, from, to: target.end, at: target.startAt ?? now, ms: chars * per };
  }

  private stalled(reply: Reply, now: number): boolean {
    if (reply.pausedAt !== null) return false;
    const at = this.stallAt(reply);
    return at !== null && now >= at;
  }

  /** When this reply counts as stalled (its voice stopped coming), or null while nothing is overdue yet. */
  private stallAt(reply: Reply): number | null {
    let latest = -1;
    for (const [index, segment] of reply.segments) if (segment.startAt !== null && index > latest) latest = index;
    if (latest < 0) {
      // Its first sentence is known (the reading asked for it): it should sound soon. Not even that: a backstop.
      const first = reply.segments.get(0);
      return first && first.end >= 0 ? first.knownAt + this.knobs.firstStallMs : reply.begunAt + this.knobs.sentenceMaxMs;
    }
    const heard = reply.segments.get(latest)!;
    if (heard.endAt === null) return heard.startAt! + this.knobs.sentenceMaxMs;
    const next = reply.segments.get(latest + 1);
    return next && next.end >= 0 ? Math.max(heard.endAt, next.knownAt) + this.knobs.nextStallMs : null;
  }
}
