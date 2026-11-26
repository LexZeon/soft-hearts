/**
 * I-209 step 4 (the switch 「她们都能接话」 default on: "可以"; no daily cap: "不加"): who answers a line on the
 * full-screen stage, decided by the characters.
 *
 *  - After each line a character said on stage (a reply to the user, a line of her own, a chime-in), every OTHER character on stage asks her
 *    own haiku whether she wants to answer. The user's own line is answered by the one the user clicked ("点谁和谁说", her own chat turn);
 *    the round starts after that reply, so the others hear both.
 *  - The first yes takes the floor: the other decisions still out are dropped (their calls aborted), she says her line with her own Claude
 *    call and voice, and her line starts the next round (her line is a line like any other). Nobody answers her own line.
 *  - It goes on while someone keeps saying yes and stops when nobody does. No sentence cap, no daily cap, no cooldown: the facts say how many
 *    lines came without the user and how long ago the user spoke; what to do with that is hers (chime-facts.ts, facts only).
 *  - Any newer line (the user's turn beginning, someone's line) drops the round in flight: its decisions and a line not yet shown never come
 *    back (the speaker port checks the signal before it shows and before it archives). The abort's reason says which: the user's turn (or
 *    leaving) also stops a line already being read (turns.ts: talking over her), someone else's line ('line') does not.
 *  - The switch off: nothing here asks or speaks; only the one the user clicked answers, and characters do not answer each other.
 * Every decision is one journal row (who, yes/no/dropped/failed, ms; never a word), so the user can count the calls a group chat used.
 * Pure: the ports do the calls, the speaking and the clock.
 */
import { CHIME_RECENT, type ChimeFacts, type StageLine } from './facts';
import { CHIME_DROP_LINE } from './turns';

export type ChimeAskOutcome = 'yes' | 'no' | 'dropped' | 'failed';
/** Stage voice: how her line ended, in closed words (turns.ts); 'undelivered' is only in rows written before 2026-11-24 late. */
export type ChimeLineOutcome = 'said' | 'quiet' | 'dropped' | 'failed' | 'unreadable' | 'busy' | 'not-shown';
/** One journal row: a decision ('ask') or her line ('line'). Closed words and a duration only. */
export type ChimeRow = { characterId: string; step: 'ask'; outcome: ChimeAskOutcome; ms: number } | { characterId: string; step: 'line'; outcome: ChimeLineOutcome; ms: number };

export interface ChimeInPorts {
  /** The switch 「她们都能接话」 (and three on stage being on at all). */
  enabled(): boolean;
  /** Everyone on stage now (card ids, the desktop companion included); fewer than two: nobody chimes in. */
  present(): readonly string[];
  name(id: string): string;
  /** Her haiku: does she want to answer now. */
  ask(id: string, facts: ChimeFacts, signal: AbortSignal): Promise<boolean>;
  /** Her line: shown in her bubble, read in her voice, archived once; never after `signal` aborted. */
  speak(id: string, facts: ChimeFacts, signal: AbortSignal): Promise<ChimeLineOutcome>;
  /** The existing user signals (true only when known). */
  user(): { busy: boolean | null; away: boolean | null };
  journal(row: ChimeRow): void;
  clock(): number;
}

/** How many line ids are remembered against hearing the same line twice. */
const SEEN_MAX = 256;

export class ChimeIn {
  private generation = 0;
  private controllers: AbortController[] = [];
  private readonly recent: StageLine[] = [];
  private readonly seen = new Set<string>();
  private streak = 0;
  private lastUserAt: number | null = null;
  /** Counts for the record (tests, diagnostics): decisions asked, yes, lines said; the longest chain without the user. */
  readonly counts = { asked: 0, yes: 0, said: 0, longest: 0 };

  constructor(private readonly ports: ChimeInPorts) {}

  private safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }

  /** The user began a turn (her line is not said yet): whatever was being decided or said is dropped. */
  userSpoke(at: number): void { this.drop('user'); this.streak = 0; this.lastUserAt = at; }

  /**
   * A line was said on stage and archived (electron/brain/stage-chat/hearing.ts tells it). The user's line: remembered; the one the user
   * clicked answers it with her own turn. A character's line: the next round asks everyone else on stage.
   */
  heard(line: StageLine): void {
    if (!line || typeof line.id !== 'string' || this.seen.has(line.id)) return;
    this.seen.add(line.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);
    this.recent.push({ ...line });
    while (this.recent.length > CHIME_RECENT) this.recent.shift();
    if (line.speaker === null) { this.drop('user'); this.streak = 0; this.lastUserAt = line.at; return; }
    this.streak++;
    this.counts.longest = Math.max(this.counts.longest, this.streak);
    this.round(line);
  }

  /** Who is out decides nothing new; leaving full screen (or the switch off) drops the round. */
  stop(): void { this.drop('stop'); this.recent.length = 0; this.streak = 0; this.lastUserAt = null; }

  /** `why`: 'user' (the user's turn), 'stop' (leaving, switched off) or CHIME_DROP_LINE (someone else's newer line). */
  private drop(why: string): void {
    this.generation++;
    const controllers = this.controllers;
    this.controllers = [];
    for (const controller of controllers) controller.abort(why);
  }

  facts(id: string): ChimeFacts {
    const present = this.safe(() => [...this.ports.present()], [] as string[]);
    const user = this.safe(() => this.ports.user(), { busy: null, away: null });
    const now = this.safe(() => this.ports.clock(), Date.now());
    return {
      self: id, selfName: this.safe(() => this.ports.name(id), ''),
      present: present.map(other => ({ id: other, name: this.safe(() => this.ports.name(other), '') })),
      recent: this.recent.map(line => ({ ...line })), streak: this.streak,
      sinceUserMs: this.lastUserAt === null ? null : Math.max(0, now - this.lastUserAt),
      userBusy: user?.busy ?? null, userAway: user?.away ?? null,
    };
  }

  private round(line: StageLine): void {
    this.drop(CHIME_DROP_LINE);
    const generation = this.generation;
    if (!this.safe(() => this.ports.enabled(), false)) return;
    const present = this.safe(() => [...this.ports.present()], [] as string[]);
    if (present.length < 2 || !line.speaker || !present.includes(line.speaker)) return;
    const candidates = present.filter(id => id !== line.speaker);
    const asks = candidates.map(id => ({ id, controller: new AbortController(), started: this.safe(() => this.ports.clock(), 0), settled: false }));
    this.controllers = asks.map(ask => ask.controller);
    let winner: string | null = null;
    const ms = (started: number) => Math.max(0, Math.round(this.safe(() => this.ports.clock(), started) - started));
    const current = () => generation === this.generation;
    for (const ask of asks) {
      this.counts.asked++;
      let facts: ChimeFacts;
      try { facts = this.facts(ask.id); } catch { continue; }
      void Promise.resolve().then(() => this.ports.ask(ask.id, facts, ask.controller.signal)).then(yes => yes === true, () => null).then(answer => {
        if (ask.settled) return;
        ask.settled = true;
        if (!current() || ask.controller.signal.aborted || winner !== null) { this.row({ characterId: ask.id, step: 'ask', outcome: 'dropped', ms: ms(ask.started) }); return; }
        if (answer === null) { this.row({ characterId: ask.id, step: 'ask', outcome: 'failed', ms: ms(ask.started) }); return; }
        if (!answer) { this.row({ characterId: ask.id, step: 'ask', outcome: 'no', ms: ms(ask.started) }); return; }
        winner = ask.id; this.counts.yes++;
        this.row({ characterId: ask.id, step: 'ask', outcome: 'yes', ms: ms(ask.started) });
        for (const other of asks) if (other !== ask && !other.settled) { other.settled = true; other.controller.abort(); this.row({ characterId: other.id, step: 'ask', outcome: 'dropped', ms: ms(other.started) }); }
        this.say(ask.id, ask.controller, generation);
      });
    }
  }

  private say(id: string, controller: AbortController, generation: number): void {
    const started = this.safe(() => this.ports.clock(), 0);
    let facts: ChimeFacts;
    try { facts = this.facts(id); } catch { return; }
    void Promise.resolve().then(() => (generation === this.generation && !controller.signal.aborted ? this.ports.speak(id, facts, controller.signal) : 'dropped' as const))
      .then(outcome => outcome, () => 'failed' as const).then(outcome => {
        if (outcome === 'said') this.counts.said++;
        this.row({ characterId: id, step: 'line', outcome, ms: Math.max(0, Math.round(this.safe(() => this.ports.clock(), started) - started)) });
      });
  }

  private row(row: ChimeRow): void { try { this.ports.journal(row); } catch { /* the journal never stops a round */ } }
}
