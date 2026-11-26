/**
 * Unbound v1 step 4, afternoon addition C: what she noticed of you while she was out, following the touch pipeline's five steps
 * (electron/mood/touch/brain.ts), all local except the one opus call she decides on and haiku's short summary:
 *  1. recognised: electron/unbound/life.ts hands each cue (left, came back, facing her, a wave, a stretch, leaning back), you talking
 *     not to her, and your answering her coming closer;
 *  2. mood: a sure facing → I-081's 'eye-contact' moment; a sure wave → 'waved' (the same family: one cooldown for both); coming
 *     back is the existing 'back' moment (I-066 writes it already: nothing twice); talking to others, leaving, a maybe → nothing;
 *  3. speak?: one roll from her mood numbers and character (shared/unbound/life/history.ts); yes → one speech cue (Unbound: no cap),
 *     which the opening choice hands to the inner loop with this as its focus (`claims`, `promptLine`): the existing path;
 *  4. tell: the next chat turn's per-turn perception line carries "用户刚才……" and "今天你们之间：……" (`turnLine`); a long account of
 *     the day is condensed by haiku to two or three sentences, at most once per CONDENSE_EVERY_MS, cached; only the account goes
 *     (kinds and count words: never a word of yours, never a picture or a sound);
 *  5. journal: one 'noticed' row per event: its kind, its band, whether she asked to speak. Never a word.
 * Memory only; today's events are dropped at the day's end.
 */
import type { MoodReading } from '../../shared/unbound/director';
import { closeMissedLine, closeMomentLine, type CloseHappened, type CloseMissed } from '../../shared/unbound/close-moments';
import { interruptedLine, type ActionInterrupted } from '../../shared/unbound/action-ends';
import { NOTICED_KINDS, INSTRUCTION_WORDS, dayAccount, noticedSpeakChance, noticedTurnLine, type Noticed, type NoticedKind } from '../../shared/unbound/life/history';

export type NoticedSpoke = 'asked' | 'held' | 'quiet' | 'asleep';
export interface NoticedJournalRow { characterId: string | null; kind: NoticedKind; band: 'sure' | 'maybe'; spoke: NoticedSpoke }

export interface HistoryPorts {
  clock(): number;
  random(): number;
  /** The local day (e.g. '2026-11-17'): events from another day are dropped. */
  day(now: number): string;
  characterId(): string | null;
  mood(): MoodReading | null;
  asleep(): boolean;
  /** Her character's lean (reaction dispositions 0..100; lively, restrained). */
  lean?(): { lively?: number; restrained?: number } | null;
  /** A mood moment ('eye-contact' or 'waved'); true when applied (its own cooldown family gates it). */
  moment(kind: 'eye-contact' | 'waved'): boolean;
  /** One speech cue now (Unbound: no cap); `claims` is asked during this call when the opening choice takes it. */
  attention(): boolean;
  journal?(row: NoticedJournalRow): void;
  /** haiku: the day's account condensed (only that text is sent); absent: the local account. */
  condense?(account: string, signal: AbortSignal): Promise<string>;
}

export const HISTORY_TIMING = Object.freeze({
  /** A cue she asked to speak about is the inner loop's focus for this long (ms). */
  offeredMs: 60_000,
  /** A thing you did counts as "刚才" this long (ms): older ones only count in the day's account. */
  freshMs: 10 * 60_000,
  /** An account longer than this (characters) is condensed by haiku. */
  condenseOver: 80,
  /** haiku is asked at most this often (ms), and only when the account changed. */
  condenseEveryMs: 30 * 60_000,
  condenseTimeoutMs: 20_000,
  /** You talking to others counts once per this long (ms). */
  talkedGapMs: 5 * 60_000,
});

const safe = <T>(read: () => T, fallback: T): T => { try { const value = read(); return value ?? fallback; } catch { return fallback; } };
const DIGITS = /[0-9０-９]/;

/** A condensed account is used only when it is short, has no digits and no instruction word (else the local one). */
export function usableCondensed(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const line = text.replace(/\s+/g, '').trim();
  if (!line || line.length > 120 || DIGITS.test(line) || INSTRUCTION_WORDS.some(word => line.includes(word))) return null;
  return line.startsWith('今天你们之间') ? line : `今天你们之间：${line}`;
}

export class UnboundHistory {
  private events: (Noticed & { told: boolean })[] = [];
  private dayKey = '';
  private pending: Noticed | null = null;
  private offered: { noticed: Noticed; at: number; characterId: string | null } | null = null;
  private spokeAt: number | null = null;
  private lastTalkedAt = -Infinity;
  private condensed: { account: string; text: string } | null = null;
  private condensing: { account: string; controller: AbortController } | null = null;
  private lastCondenseAt = -Infinity;
  private close: CloseHappened | null = null;
  /** 2026-11-23: a kiss / hug she wrote that did not walk up, and an action of hers you ended: told once on her next turn. */
  private missed: CloseMissed | null = null;
  private stopped: ActionInterrupted | null = null;

  constructor(private readonly ports: HistoryPorts) {}

  /** One thing she noticed (kinds outside the list, or an unsure band, are ignored). */
  note(input: { kind: string; band: string; at?: number; awayMs?: number }): void {
    if (!(NOTICED_KINDS as readonly string[]).includes(input.kind) || (input.band !== 'sure' && input.band !== 'maybe')) return;
    const now = this.now();
    if (input.kind === 'talked') { if (now - this.lastTalkedAt < HISTORY_TIMING.talkedGapMs) return; this.lastTalkedAt = now; }
    this.roll(now);
    const noticed: Noticed = { kind: input.kind as NoticedKind, band: input.band, at: now, ...(typeof input.awayMs === 'number' && input.awayMs > 0 ? { awayMs: input.awayMs } : {}) };
    // Step 5: being pulled along is told by the touch line already ("你跟着走了几步"); here it only counts in the day's account.
    this.events.push({ ...noticed, told: noticed.kind === 'pulled-along' });
    if (this.events.length > 200) this.events.shift();
    if (noticed.band === 'sure') {
      if (noticed.kind === 'facing') safe(() => this.ports.moment('eye-contact'), false);
      if (noticed.kind === 'wave') safe(() => this.ports.moment('waved'), false);
    }
    const spoke = this.speak(noticed, now);
    safe(() => { this.ports.journal?.({ characterId: safe(() => this.ports.characterId(), null), kind: noticed.kind, band: noticed.band, spoke }); return true; }, false);
  }

  /** I-184: a kiss or a hug of hers happened (her next turn hears it once, as a fact: closeMomentLine). */
  closeMoment(item: CloseHappened): void { this.close = { ...item }; }
  /** 2026-11-23: a kiss or a hug her reply wrote did not walk up (her next turn hears it once, as information: closeMissedLine). */
  closeMissed(item: CloseMissed): void { this.missed = { ...item }; }
  /** 2026-11-23: you ended an action of hers directly (her next turn hears it once: interruptedLine). */
  interrupted(item: ActionInterrupted): void { this.stopped = { ...item }; }
  /** I-203: the full facts of an interrupted kiss / hug of her reply were told (her immediate turn, or her next chat turn): the short line is not told again. */
  toldCut(): void { this.stopped = null; if (this.missed?.block === 'unreached') this.missed = null; }

  /** This chat turn's sentences ('' for none): what she was not told yet, and today's account. Marks the fresh ones told. */
  turnLine(): string {
    const now = this.now();
    const fresh = <T extends { at: number }>(item: T | null): item is T => !!item && now - item.at < HISTORY_TIMING.freshMs;
    const close = fresh(this.close) ? closeMomentLine([this.close]) : '';
    const missed = fresh(this.missed) ? closeMissedLine([this.missed]) : '', stopped = fresh(this.stopped) ? interruptedLine([this.stopped]) : '';
    this.close = null; this.missed = null; this.stopped = null;
    return close + missed + stopped + this.noticedLine(now);
  }
  private noticedLine(now: number): string {
    this.roll(now);
    const fresh = this.events.filter(e => !e.told && now - e.at < HISTORY_TIMING.freshMs);
    for (const e of this.events) e.told = true;
    const local = dayAccount(this.events);
    let day = local;
    if (local.length > HISTORY_TIMING.condenseOver) {
      if (this.condensed && this.condensed.account === local) day = this.condensed.text;
      else this.condense(local, now); // until it is back (or when it fails), the local account
    }
    return noticedTurnLine(fresh.map(({ told: _told, ...n }) => n), day);
  }

  /** The opening choice's claimant: the speech cue she just asked for to answer something you did. */
  claims(cue: { kind?: unknown; source?: unknown } | null | undefined): boolean {
    const pending = this.pending;
    if (!pending || !cue || cue.kind !== 'speech' || cue.source !== undefined) return false;
    this.pending = null;
    this.offered = { noticed: pending, at: this.now(), characterId: safe(() => this.ports.characterId(), null) };
    return true;
  }

  /** The inner loop's focus line for that cue ('' when there is none or it is stale). */
  promptLine(characterId: string): string {
    const offered = this.offered;
    if (!offered || offered.characterId !== characterId || this.now() - offered.at > HISTORY_TIMING.offeredMs) return '';
    const event = this.events.find(e => e.at === offered.noticed.at && e.kind === offered.noticed.kind);
    if (event) event.told = true;
    return noticedTurnLine([offered.noticed], '');
  }

  /** Counts by kind today (developer panel). */
  counts(): Partial<Record<NoticedKind, number>> {
    const out: Partial<Record<NoticedKind, number>> = {};
    for (const e of this.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
    return out;
  }

  dispose(): void { this.condensing?.controller.abort(); this.condensing = null; }

  // ---- inside ---------------------------------------------------------------------------------------------------------------

  private now(): number { const value = safe(() => this.ports.clock(), Date.now()); return Number.isFinite(value) ? value : Date.now(); }

  /** A new day: yesterday's events go. */
  private roll(now: number): void {
    const key = safe(() => this.ports.day(now), '');
    if (key === this.dayKey) return;
    this.dayKey = key; this.events = []; this.condensed = null; this.dispose();
  }

  private speak(noticed: Noticed, now: number): NoticedSpoke {
    if (safe(() => this.ports.asleep(), false)) return 'asleep';
    const mood = safe(() => this.ports.mood(), null);
    if (!mood) return 'quiet';
    const chance = noticedSpeakChance({ kind: noticed.kind, band: noticed.band, mood, lean: safe(() => this.ports.lean?.() ?? undefined, undefined),
      sinceSpokeMs: this.spokeAt === null ? null : now - this.spokeAt });
    if (!(chance > 0) || !(safe(() => this.ports.random(), 1) < chance)) return 'quiet';
    this.pending = noticed;
    const ok = safe(() => this.ports.attention(), false), claimed = this.pending === null;
    this.pending = null;
    if (ok && claimed) { this.spokeAt = now; return 'asked'; }
    return 'held';
  }

  /** haiku condenses the day's account in the background (the turn never waits); a bad answer keeps the local one. */
  private condense(account: string, now: number): void {
    const run = this.ports.condense;
    if (!run || this.condensing || now - this.lastCondenseAt < HISTORY_TIMING.condenseEveryMs) return;
    this.lastCondenseAt = now;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), HISTORY_TIMING.condenseTimeoutMs);
    this.condensing = { account, controller };
    void Promise.resolve().then(() => run(account, controller.signal)).then(text => {
      const line = usableCondensed(text);
      if (line && this.condensing?.controller === controller) this.condensed = { account, text: line };
    }, () => undefined).finally(() => { clearTimeout(timer); if (this.condensing?.controller === controller) this.condensing = null; });
  }
}

/** The haiku prompt for condensing (only the local account is sent: kinds and count words). */
export const CONDENSE_SYSTEM = '把下面这段关于今天的事实压成两三句很短的中文。只陈述发生了什么，不加评价、不加建议、不写数字，不对任何人提要求。只输出压缩后的句子。';
