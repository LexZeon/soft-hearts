// I-189 #4 posture, #5 long staring, #6 sitting too long, #7 two people .
// Pure watchers over the local pose signals: each keeps only times, minutes and counts (never a point, a picture or a word) and answers
// "is there something to tell her now". What she is told and when is the moments host's (I-188 gates); none of this words a reaction.
// Time is integrated per signal: the time since the previous signal belongs to the previous reading, at most `MAX_STEP_MS` of it.
import type { PoseSignal } from '../../senses/pose-signals';
import { POSE_USES_KNOBS, type PoseUsesKnobs } from './knobs';

const MAX_STEP_MS = 5_000;
const MINUTE = 60_000;
type Reading = Pick<PoseSignal, 'present' | 'facing' | 'facingConfidence' | 'posture' | 'postureConfidence' | 'energy' | 'capability' | 'points' | 'people'>;

const seated = (s: Reading) => s.present && s.capability === 'full' && (s.posture === 'sitting' || s.posture === 'slumped' || s.posture === 'leaning-back') && s.postureConfidence >= 0.3;
const standing = (s: Reading, confidence: number) => s.present && s.capability === 'full' && s.posture === 'standing' && s.postureConfidence >= confidence;

// ---------------------------------------------------------------- #6 sitting without standing up

export interface SittingFacts { readonly minutes: number; readonly todayMinutes: number; readonly standUps: number }

export class SittingClock {
  private sitSince: number | null = null;
  private standSince: number | null = null;
  private goneSince: number | null = null;
  private last: { at: number; seated: boolean } | null = null;
  private day = '';
  private todayMs = 0;
  private standUps = 0;
  /** How many times this sitting stretch was already told (0, 1, 2). */
  private told = 0;

  constructor(private readonly knobs: PoseUsesKnobs['sitting'] = POSE_USES_KNOBS.sitting) {}

  note(signal: Reading, at: number, day: string): void {
    if (!Number.isFinite(at) || (this.last && at < this.last.at)) return;
    if (day !== this.day) { this.day = day; this.todayMs = 0; this.standUps = 0; }
    if (this.last?.seated) this.todayMs += Math.min(MAX_STEP_MS, at - this.last.at);
    const isSeated = seated(signal);
    this.last = { at, seated: isSeated };
    if (!signal.present) {
      this.standSince = null;
      this.goneSince ??= at;
      if (this.sitSince !== null && at - this.goneSince >= this.knobs.breakMinutes * MINUTE) this.stoodUp();
      return;
    }
    this.goneSince = null;
    if (standing(signal, 0.5)) {
      this.standSince ??= at;
      if (this.sitSince !== null && at - this.standSince >= this.knobs.standSeconds * 1000) this.stoodUp();
      return;
    }
    this.standSince = null;
    if (isSeated) this.sitSince ??= at;
  }

  private stoodUp(): void { this.sitSince = null; this.told = 0; this.standUps++; }

  /** Minutes of this sitting stretch (0 while not sitting). */
  minutes(now: number): number { return this.sitSince === null || !(now >= this.sitSince) ? 0 : (now - this.sitSince) / MINUTE; }
  facts(now: number): SittingFacts {
    return { minutes: Math.round(this.minutes(now)), todayMinutes: Math.round(this.todayMs / MINUTE), standUps: this.standUps };
  }
  /** Something to tell her: the first long stretch, then once more much later; null otherwise. Taking it counts it as told. */
  take(now: number): SittingFacts | null {
    const minutes = this.minutes(now), due = this.told === 0 ? this.knobs.firstMinutes : this.told === 1 ? this.knobs.againMinutes : Infinity;
    if (this.goneSince !== null || !(minutes >= due)) return null;
    this.told++;
    return this.facts(now);
  }
  forget(): void { this.sitSince = this.standSince = this.goneSince = null; this.last = null; this.told = 0; }
}

// ---------------------------------------------------------------- #5 long staring, and looking away after it

export interface StareFacts { readonly minutes: number; readonly awaySeconds?: number }

export class StareWatch {
  private since: number | null = null;
  private lastStill = -Infinity;
  private lastAt = -Infinity;
  private told = false;
  private ended: { minutes: number; at: number } | null = null;
  private day = '';
  private count = 0;

  constructor(private readonly knobs: PoseUsesKnobs['staring'] = POSE_USES_KNOBS.staring) {}

  note(signal: Reading, at: number, day: string): void {
    if (!Number.isFinite(at) || at < this.lastAt) return;
    if (day !== this.day) { this.day = day; this.count = 0; }
    this.lastAt = at;
    const still = signal.present && signal.capability === 'full' && signal.facing === 'toward' && signal.facingConfidence >= this.knobs.towardConfidence && signal.energy <= this.knobs.stillEnergy;
    if (still) {
      if (this.since === null || at - this.lastStill > this.knobs.glanceSeconds * 1000) { this.since = at; this.told = false; this.ended = null; }
      this.lastStill = at;
      return;
    }
    // Not still: a glance shorter than glanceSeconds keeps the stretch; longer ends it (and a long one may become "looked away").
    if (this.since !== null && at - this.lastStill > this.knobs.glanceSeconds * 1000) {
      const minutes = (this.lastStill - this.since) / MINUTE;
      this.ended = minutes >= this.knobs.minutes ? { minutes, at: this.lastStill } : null;
      this.since = null; this.told = false;
    }
  }

  minutes(now: number): number { return this.since === null || now - this.lastStill > this.knobs.glanceSeconds * 1000 ? 0 : (this.lastStill - this.since) / MINUTE; }

  /** 'staring': still and facing the screen for long (once a stretch); 'away': after such a stretch, looked away for awaySeconds. */
  take(now: number): ({ kind: 'staring' } & StareFacts) | ({ kind: 'away' } & StareFacts) | null {
    if (this.count >= this.knobs.perDay) return null;
    const minutes = this.minutes(now);
    if (!this.told && minutes >= this.knobs.minutes) { this.told = true; this.count++; return { kind: 'staring', minutes: Math.round(minutes) }; }
    const ended = this.ended;
    if (ended && this.since === null && now - ended.at >= this.knobs.awaySeconds * 1000) {
      this.ended = null;
      if (now - ended.at > 10 * MINUTE) return null; // long gone: not "just looked away" any more
      return { kind: 'away', minutes: Math.round(ended.minutes), awaySeconds: Math.round((now - ended.at) / 1000) };
    }
    return null;
  }
  forget(): void { this.since = null; this.lastStill = -Infinity; this.lastAt = -Infinity; this.told = false; this.ended = null; }
}

// ---------------------------------------------------------------- #4 slumped for long, or very close to the screen

export interface PostureFacts { readonly posture: 'slumped' | 'close'; readonly minutes: number }

export class PostureWatch {
  /** One bucket a minute: present ms, slumped ms, close ms. */
  private buckets: { minute: number; present: number; slumped: number; close: number }[] = [];
  private last: { at: number; slumped: boolean; close: boolean; present: boolean } | null = null;
  private closeSince: number | null = null;
  private lastClose = -Infinity;
  private day = '';
  private count = 0;
  private toldAt = -Infinity;

  constructor(private readonly knobs: PoseUsesKnobs['posture'] = POSE_USES_KNOBS.posture) {}

  note(signal: Reading, at: number, day: string): void {
    if (!Number.isFinite(at) || (this.last && at < this.last.at)) return;
    if (day !== this.day) { this.day = day; this.count = 0; }
    const last = this.last;
    if (last?.present) {
      const minute = Math.floor(last.at / MINUTE), ms = Math.min(MAX_STEP_MS, at - last.at);
      let bucket = this.buckets.at(-1);
      if (!bucket || bucket.minute !== minute) { bucket = { minute, present: 0, slumped: 0, close: 0 }; this.buckets.push(bucket); }
      bucket.present += ms; if (last.slumped) bucket.slumped += ms; if (last.close) bucket.close += ms;
    }
    const oldest = Math.floor(at / MINUTE) - this.knobs.windowMinutes;
    while (this.buckets.length && this.buckets[0].minute < oldest) this.buckets.shift();
    const present = signal.present && signal.capability === 'full';
    const slumped = present && signal.posture === 'slumped' && signal.postureConfidence >= this.knobs.confidence;
    const l = signal.points?.[5], r = signal.points?.[6];
    const close = present && !!l && !!r && Math.abs(l.x - r.x) >= this.knobs.closeShoulderShare;
    if (close) { this.closeSince ??= at; this.lastClose = at; } else if (at - this.lastClose > 30_000) this.closeSince = null; // a short lean back does not end it
    this.last = { at, slumped, close, present };
  }

  take(now: number): PostureFacts | null {
    if (this.count >= this.knobs.perDay || now - this.toldAt < this.knobs.cooldownMinutes * MINUTE) return null;
    let present = 0, slumped = 0;
    for (const b of this.buckets) { present += b.present; slumped += b.slumped; }
    let facts: PostureFacts | null = null;
    if (slumped >= this.knobs.slumpMinutes * MINUTE && present > 0 && slumped / present >= this.knobs.slumpShare) facts = { posture: 'slumped', minutes: Math.round(slumped / MINUTE) };
    else if (this.closeSince !== null && now - this.lastClose <= 30_000 && this.lastClose - this.closeSince >= this.knobs.closeMinutes * MINUTE) facts = { posture: 'close', minutes: Math.round((this.lastClose - this.closeSince) / MINUTE) };
    if (!facts) return null;
    this.count++; this.toldAt = now; this.buckets = []; this.closeSince = null;
    return facts;
  }
  forget(): void { this.buckets = []; this.last = null; this.closeSince = null; this.lastClose = -Infinity; }
}

// ---------------------------------------------------------------- #7 two people in the frame (only a count; never who, never a picture)

export class PeopleWatch {
  private twoSince: number | null = null;
  private lastTwo = -Infinity;
  private episode = false;
  private told = false;

  constructor(private readonly knobs: PoseUsesKnobs['people'] = POSE_USES_KNOBS.people) {}

  /** Reads only `present` and `people` (a number the detector counted). */
  note(signal: Pick<PoseSignal, 'present' | 'people'>, at: number): void {
    if (!Number.isFinite(at)) return;
    const two = signal.present && Number.isInteger(signal.people) && signal.people >= 2;
    if (two) {
      this.twoSince ??= at; this.lastTwo = at;
      if (!this.episode && at - this.twoSince >= this.knobs.sustainSeconds * 1000) { this.episode = true; this.told = false; }
      return;
    }
    this.twoSince = null;
    if (this.episode && at - this.lastTwo >= this.knobs.endMinutes * MINUTE) { this.episode = false; this.told = false; }
  }

  /** True once per episode (two people confirmed and held): her next turn gets the one note. */
  take(): boolean {
    if (!this.episode || this.told) return false;
    this.told = true;
    return true;
  }
  forget(): void { this.twoSince = null; this.lastTwo = -Infinity; this.episode = false; this.told = false; }
}
