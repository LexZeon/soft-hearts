/**
 * Unbound U2, the host side of the director (docs/claude/2026-11-12-unbound-peek.md): decides *when* she comes up to the lens,
 * keeps it from ever getting in your way, and writes her mood back when you answer her.
 *
 *  - Once a second (while she is in Unbound): the readiness (shared/unbound/director.ts peekReadiness) from what the app already
 *    knows: seconds since your last key or mouse (the 「知道你是不是在忙」 reading, nothing new is sensed), full-screen, her sleep,
 *    a call, her reply streaming, you waiting for her. Ready → a short wait from her mood → the plan (planPeek) goes to the page.
 *  - While a peek plays (shared/unbound/action-ends/): the mouse moving, typing and the keys never back her off;
 *    she holds as long as she decides (I-192, up to the cap). The window takes the mouse only over her, as at any time: a click on her does not
 *    end the close family (kiss, hug, the look); a small press or pull only sways her; a large pull ends it on the page and becomes the pull
 *    (the page reports cancelled 'pull': she is told next turn, a journal row); a game starting ends it here. A peek that never reports its
 *    end is over after PEEK_TIMING.maxPeekMs.
 *  - Answered: you talk to her or click her during the peek or within PEEK_TIMING.responseWindowMs after it: one small O lift
 *    through the mood moments (kind 'peek-answered', its own cooldown and day count). Nothing is written when you do not answer,
 *    and never for a trial from the developer panel.
 */
import {
  PEEK_BLOCK_WORDS, PEEK_KNOB_DEFAULTS, PEEK_KNOB_RANGES, PEEK_TIMING, PeekHistory, PeekVariation, QUIET_CUE, parsePeekReport, peekReadiness, peekWait, planPeek,
  type DirectorPlan, type MoodReading, type PeekCancelReason, type PeekCommand, type PeekKnobs, type PeekPhase, type PeekView,
} from '../../shared/unbound/director';
import { moodLevel } from '../../shared/foundation/mood';
import { NEAR_ARM_MS } from '../../shared/unbound/pull';
import { closeEndWhy, parseCloseBeatAsk, parseFrameBeatAsk, pauseSeconds, type AfterBeat, type ChatCloseAnswer, type CloseAct, type CloseBeatFate, type CloseVia, type FrameBeatAsk } from '../../shared/unbound/close-moments';
import type { CloseBase, CloseMomentsLink } from './close-moments';
import { endsAction, type ActionKind, type UserEndCause } from '../../shared/unbound/action-ends';
import type { ChatCloseBlock } from '../../shared/unbound/close-moments';
import type { CloseBeatSequenceLink } from './close-sequence';

export interface PeekPorts {
  clock(): number;
  random(): number;
  /** Seconds since the last key or mouse input as of the last activity tick; null when not known (switch off, locked, asleep). */
  idleSeconds(): number | null;
  asleep(): boolean;
  inCall(): boolean;
  /** You sent her something and are waiting for the reply. */
  userTalking(): boolean;
  mood(): MoodReading | null;
  /** Her last interaction with you (chat or touch), ms; null when none. */
  lastInteractionAt(): number | null;
  /** The small O lift (mood moments 'peek-answered'); true when applied. */
  answered(): boolean;
  /**
   * Unbound v1 step 4: her voice is reading something now (replySpeechBusy() || speechPlaybackActivity.busy, as the watch-along
   * initiative reads it). Counts as "she is speaking" like a reply's words, for as long as it lasts (the 6 s tail alone was a gap).
   */
  readingAloud?(): boolean;
  /** A repeating timer (the host's once-a-second tick of the peek and her life); returns a stop function. */
  every(ms: number, run: () => void): () => void;
  /** I-184: her close moments (close-moments.ts). Absent: the peek is the only thing she comes up to the lens for, as before. */
  close?: CloseMomentsLink;
  /**
   * 2026-11-23: what her reply's kiss or hug and your interruptions leave behind: a kiss / hug she wrote that did not walk up (its block word),
   * an action you ended directly (a large pull). Each: one journal row and one information line for her next turn (unbound-wiring).
   */
  notes?: { missed(kind: 'kiss' | 'hug', block: ChatCloseBlock): void; interrupted(action: ActionKind, by: UserEndCause): void;
    /** T-264: she walked up but her face never got into the window: it did not happen (journaled with the closed word 'unreached', told next turn). */
    notReached?(kind: 'kiss' | 'hug'): void;
    /** 2026-11-25: one row per kiss / hug she wrote, once its fate is known: played (the hold reached) or not, and why (closed words). */
    outcome?(fate: CloseBeatFate): void };
  /** 2026-11-23: her reply's words after a kiss or a hug wait until it is done (close-sequence.ts); absent: nothing waits. */
  sequence?: CloseBeatSequenceLink;
}
/** Unbound v1 step 4: the one owner of her free time (electron/unbound/life.ts). Absent: the peek decides alone, as before. */
export interface PeekArbiter {
  /** May the peek start now? A lower action running is asked to ease out first (then false: the peek asks again next second). */
  claim(): boolean;
  /** Why not even think of it (her reading of you: nobody there, you talking to someone, a video), or null. */
  block(): string | null;
  /** Per hour and cooldown from her mood, or null (the knobs then). */
  pace(cooldownKnob: number): { perHour: number; cooldownMinutes: number } | null;
}
export interface PeekLink {
  /** She is in Unbound with her window on screen. */
  shown(): boolean;
  /** I-199: a full-screen program is in front (information: her own peeks wait; nothing she is doing or asked to do stops). */
  fullscreen(): boolean;
  send(command: PeekCommand): void;
  changed(): void;
}

/** I-184: a close moment the peek's channel plays instead of the look. */
/** `armsStill` (I-192 follow-up, Codex T-261): the page said her arms cannot move on this model: a hug is recorded with its arms still. */
interface CloseRun { kind: CloseAct; via: CloseVia; after: AfterBeat | null; recorded: boolean; armsStill?: boolean;
  /** 2026-11-23: her reply's words after it were let go (once). */
  released?: boolean;
  /** 2026-11-25: its journal row (one per kiss / hug she wrote) was written. */
  fated?: boolean }

const safe = <T>(read: () => T, fallback: T): T => { try { const value = read(); return value ?? fallback; } catch { return fallback; } };

/** The parts of the mood view the director reads (shared/mood/mood-runtime.ts MoodView). */
export interface PeekMoodSource {
  snapshot: { values: Record<'D' | 'O' | 'E' | 'N' | 'C', number>; boredom: number; longing: number };
  parameters: { baseline: Record<'D' | 'O' | 'E' | 'N' | 'C', number>; evidence: { level: number } };
  fatigue?: { A: number; sleeping: boolean } | null;
}
/** Her mood for movement: D/O/E/N/C relative to the card's baseline (moodLevel), A, B and M as they are. Read only. */
export function peekMoodFrom(view: PeekMoodSource | null | undefined): MoodReading | null {
  if (!view?.snapshot?.values || !view.parameters?.baseline) return null;
  const level = (key: 'D' | 'O' | 'E' | 'N' | 'C') => {
    const value = view.snapshot.values[key], baseline = view.parameters.baseline[key], evidence = view.parameters.evidence?.level ?? 1;
    if (![value, baseline, evidence].every(Number.isFinite)) return 50;
    return Math.min(100, Math.max(0, moodLevel(value, baseline, evidence)));
  };
  const finite = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return { D: level('D'), O: level('O'), E: level('E'), N: level('N'), C: level('C'),
    A: finite(view.fatigue?.A, 0.2), B: finite(view.snapshot.boredom, 0), M: finite(view.snapshot.longing, 0) };
}

export class PeekDirectorHost {
  private knobs: PeekKnobs = { ...PEEK_KNOB_DEFAULTS };
  private readonly history = new PeekHistory();
  /** Codex T-246a: the per-peek templates are drawn without replacement and never three times running (memory only). */
  private readonly variation = new PeekVariation();
  private current: { id: string; trial: boolean; startedAt: number; phase: PeekPhase; endedAt: number | null; answered: boolean; cancelled: PeekCancelReason | null;
    /** I-184: a close moment instead of the look; `recorded` once its hold was reached (it happened). */
    close: CloseRun | null } | null = null;
  /** The last peek after it ended (its answer window). */
  private last: { id: string; trial: boolean; startedAt: number; endedAt: number; answered: boolean; cancelled: PeekCancelReason | null } | null = null;
  private waitUntil: number | null = null;
  private speakingUntil = 0;
  private streaming = false;
  private seq = 0;
  private blocked: string | null = null;
  /** Unbound v1 step 4: set by the host once its life host exists. */
  arbiter: PeekArbiter | null = null;

  constructor(private readonly ports: PeekPorts, private readonly link: PeekLink) {}

  /**
   * The life host's interaction mid-peek: it backs off only when the interruption arbiter's row for the close family says so (today only a
   * game: a new action of hers; a large pull ends it on the page). A call, a click, typing, her reply and her reading aloud never do.
   */
  interrupt(cause: string): void {
    const current = this.current;
    if (this.active && current && endsAction(this.kindOf(current.close), cause)) this.cancel(cause === 'play' ? 'play' : 'input');
  }
  private kindOf(close: CloseRun | null): ActionKind { return close?.kind === 'kiss' || close?.kind === 'hug' ? close.kind : 'look'; }

  get active(): boolean { return !!this.current && this.current.endedAt === null; }

  setKnobs(patch: Partial<PeekKnobs>): void {
    for (const key of ['idleSeconds', 'cooldownMinutes', 'perHour', 'softness'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      const [lo, hi] = PEEK_KNOB_RANGES[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi) this.knobs[key] = key === 'perHour' ? Math.round(value) : value;
    }
  }
  get knobValues(): PeekKnobs { return { ...this.knobs }; }

  /** Her reply streaming (control window chat): a cue. I-192: a reply that starts mid-peek no longer backs her off (she holds while she speaks). */
  chat(type: 'delta' | 'done' | 'error'): void {
    const now = this.now();
    if (type === 'delta') this.streaming = true;
    else { this.streaming = false; this.speakingUntil = now + PEEK_TIMING.speakingTailMs; }
  }

  /** Once a second while she is in Unbound. */
  tick(): void {
    const now = this.now();
    this.answerWatch(now);
    if (this.current && this.current.endedAt === null && now - this.current.startedAt > PEEK_TIMING.maxPeekMs) { this.cancel('timeout'); this.end(now); }
    const mood = safe(() => this.ports.mood(), null);
    const reading = safe(() => this.ports.readingAloud?.() ?? false, false); // I-192: no longer backs a peek off (she holds while she reads)
    const pace = this.arbiter ? safe(() => this.arbiter!.pace(this.knobs.cooldownMinutes), null) : null;
    const ready = peekReadiness({
      shown: safe(() => this.link.shown(), false), fullscreen: safe(() => this.link.fullscreen(), false),
      idleSeconds: safe(() => this.ports.idleSeconds(), null), asleep: safe(() => this.ports.asleep(), false), inCall: safe(() => this.ports.inCall(), false),
      cue: { ...QUIET_CUE, speaking: this.streaming || now < this.speakingUntil || reading, userTalking: safe(() => this.ports.userTalking(), false) },
      mood, active: this.active,
    }, this.history, now, pace ? { ...this.knobs, ...pace } : this.knobs);
    const block = ready.ok && this.arbiter ? safe(() => this.arbiter!.block(), null) : null;
    const blocked = ready.ok ? block : PEEK_BLOCK_WORDS[ready.why];
    if (blocked !== this.blocked) { this.blocked = blocked; this.link.changed(); }
    if (!ready.ok || !mood || block) { this.waitUntil = null; return; }
    this.waitUntil ??= now + peekWait(mood, safe(() => this.ports.random(), 0.5)) * 1000;
    if (now < this.waitUntil) return;
    if (this.arbiter && !safe(() => this.arbiter!.claim(), false)) return; // step 4: the arbiter's turn order (asks again next second)
    this.waitUntil = null;
    // I-184: this time a kiss or a hug instead of the look (rare; its own caps), else the peek as before.
    const own = this.ports.close ? safe(() => this.ports.close!.own(this.closeBase(now, reading)), null) : null;
    if (!own || !this.startClose(own, 'own')) this.start(mood, false);
  }

  /** 「试一下：凑到镜头前」: now, whatever the idle time and cooldown (still only while she is shown, and still cancelled by input). */
  trial(): boolean {
    if (!safe(() => this.link.shown(), false) || this.active) return false;
    return this.start(safe(() => this.ports.mood(), null) ?? { D: 70, O: 60, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 }, true);
  }

  /**
   * I-159 E: she was let go nearer to the lens than her face station: she plays the peek (the same one: leans in, stares,
   * blinks, backs off) and then stands at her place, the face station the page just reported. Like a trial: not counted, no mood written,
   * still cancelled by input. Mouse moves and keys in the first PULL_NEAR_ARM_MS (the hand leaving the mouse) do not count, here or on the page.
   */
  pulledNear(heldMs = 0): boolean {
    if (!safe(() => this.link.shown(), false) || this.active) return false;
    // I-184: held at the nearest long enough, she decides (look, kiss, hug, shy back a step, nothing); one decision per let-go.
    const now = this.now(), close = this.ports.close;
    const kind = close ? safe(() => close.pulled(this.closeBase(now, safe(() => this.ports.readingAloud?.() ?? false, false)), heldMs), 'look' as const) : 'look';
    if (kind === 'none') return false; // she stays a moment and walks back to her face station herself (the page's NearReturn)
    if (kind !== 'look' && this.startClose(kind, 'pulled', NEAR_ARM_MS)) return true;
    return this.start(safe(() => this.ports.mood(), null) ?? { D: 70, O: 60, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 }, true, NEAR_ARM_MS);
  }

  /**
   * I-185: her reply reached ⟦kiss⟧ or ⟦hug⟧ on the page: 'play' (this channel plays the family's performance: she walks up, the same plan
   * and curves; recorded only if its hold is reached) or 'lighter' (the page plays the lighter word where she stands). Not counted in the
   * peek's pace; your input still backs her off (after the arm buffer: your hand leaving the keys after sending).
   */
  chatBeat(kind: 'kiss' | 'hug'): ChatCloseAnswer {
    const close = this.ports.close;
    if (!close?.chat) return 'lighter';
    const now = this.now();
    let block: ChatCloseBlock | null;
    try { block = close.chat(this.closeBase(now, false), kind, this.active); } catch { block = 'busy'; } // null: it may walk up
    if (!block && !this.startClose(kind, 'chat')) block = this.active ? 'busy' : 'unready'; // no plan (her mood not read yet) or one already on
    const answer: ChatCloseAnswer = block ? 'lighter' : 'play';
    // Never silent: a kiss / hug she wrote that does not walk up is journaled with its block word and told next turn.
    if (block) safe(() => { this.ports.notes?.missed(kind, block!); return true; }, false);
    if (block) this.fate({ kind, outcome: 'not-played', why: block }); // 2026-11-25: its one row
    safe(() => { this.ports.sequence?.asked(kind, answer); return true; }, false); // her words after it wait for it ('play') or go on now
    return answer;
  }

  /** The page's report (already only from the Unbound window's own top frame). I-185: or its question about a kiss or a hug (the answer goes back). */
  report(value: unknown): ChatCloseAnswer | undefined {
    const ask = parseCloseBeatAsk(value);
    if (ask) return this.chatBeat(ask.closeBeat);
    const frame = parseFrameBeatAsk(value);
    if (frame) { this.frameBeat(frame); return; }
    const report = parsePeekReport(value);
    const current = this.current;
    if (!report) return;
    if (report.clicked) this.clicked(report.id);
    if (!current || report.id !== current.id || current.endedAt !== null) return;
    const was = current.phase;
    current.phase = report.phase;
    // I-203: a kiss / hug from her reply cut short (a large pull, a face that could not reach) cuts the reply: its words and frames stop, she knows why.
    const chat = current.close?.via === 'chat' && (current.close.kind === 'kiss' || current.close.kind === 'hug') ? current.close.kind : null;
    const cutBy = (report.cancelled === 'pull' || report.cancelled === 'unreached') && !current.cancelled ? report.cancelled : null;
    if (chat && cutBy) safe(() => { this.ports.sequence?.interrupted?.({ kind: chat, frame: was === 'hold' ? 'holding' : 'walking', cause: cutBy === 'pull' ? 'pulled-away' : 'could-not-reach' }); return true; }, false);
    if (report.cancelled === 'pull' && current.cancelled !== 'pull') { // you pulled her away: told and journaled once
      safe(() => { this.ports.notes?.interrupted(this.kindOf(current.close), 'pull'); return true; }, false);
    }
    // T-264: the arrival wait ran out with her face not there: not recorded (the hold below never comes); journaled and told once, as information.
    if (report.cancelled === 'unreached' && !current.cancelled && current.close && current.close.kind !== 'shy') {
      const kind = current.close.kind;
      safe(() => { this.ports.notes?.notReached?.(kind); return true; }, false);
    }
    // I-203: a kiss / hug from her reply is holding: her words after a hug-held come now; a kiss's contact stops her words until she pulls back.
    if (chat && report.phase === 'hold' && was !== 'hold' && !current.cancelled && !report.cancelled) safe(() => { this.ports.sequence?.held?.(chat); return true; }, false);
    if (report.cancelled) current.cancelled = report.cancelled;
    const close = current.close;
    // I-192 follow-up (Codex T-261): the page says her arms cannot move on this model: the hug (her face came) is recorded with its arms still.
    if (close && report.arms === false) close.armsStill = true;
    if (close && !close.recorded && report.phase === 'hold' && !current.cancelled && close.kind !== 'shy') {
      close.recorded = true; // I-184: it happened (once per performance): the mood moment, the record, her next turn's line
      const arms = close.kind === 'hug' && close.armsStill ? 'still' as const : undefined;
      safe(() => { this.ports.close?.happened(close.kind as 'kiss' | 'hug', close.via, close.after, arms); return true; }, false);
      if (close.via === 'chat' && !close.fated) { close.fated = true; this.fate({ kind: close.kind as 'kiss' | 'hug', outcome: 'played', why: null, ...(arms ? { arms } : {}) }); }
    }
    if (report.phase === 'settle' || report.phase === 'done') this.closeDone(current.close); // back from it: her words after it may come
    if (report.phase === 'done') this.end(this.now());
    this.link.changed();
  }

  stop(): void {
    safe(() => { this.ports.sequence?.stop?.(); return true; }, false); // she left full-screen: nothing waits for an action here
    if (this.current && this.current.endedAt === null) this.end(this.now());
    this.waitUntil = null;
  }

  view(): PeekView {
    const now = this.now(), shown = this.current ?? this.last;
    return { knobs: { ...this.knobs }, phase: this.current?.endedAt === null ? this.current.phase : null, trial: !!this.current?.trial && this.current.endedAt === null,
      blocked: this.blocked, lastAt: this.history.last(), inLastHour: this.history.inLastHour(now),
      last: shown ? { cancelled: shown.cancelled, answered: shown.answered } : null };
  }

  // ---- inside ---------------------------------------------------------------------------------------------------------------

  private now(): number { const value = safe(() => this.ports.clock(), Date.now()); return Number.isFinite(value) ? value : Date.now(); }

  /** I-184: what this host knows of the gates (close-moments.ts reads the rest: typing, arms, a pull). */
  private closeBase(now: number, reading: boolean): CloseBase {
    return { shown: safe(() => this.link.shown(), false), asleep: safe(() => this.ports.asleep(), false),
      inCall: safe(() => this.ports.inCall(), false), speaking: this.streaming || now < this.speakingUntil || reading };
  }
  /** I-184: a close moment through the peek's own channel (the same timeout). Her own counts in the peek's pace. */
  private startClose(kind: CloseAct, via: CloseVia, armMs = 0): boolean {
    const plan = this.ports.close ? safe(() => this.ports.close!.plan(kind, via), null) : null;
    if (!plan) return false;
    const asked = via !== 'own'; // pulled (I-159 E) or her reply (I-185): like a trial, not counted in her own pace
    const started = this.start(null, asked, armMs, { plan, run: { kind, via, after: plan.after, recorded: false } });
    // 2026-11-25 (16:26 "抱抱不行"): her own hand reach lets go as she walks up (it never holds her arms against what she does now).
    if (started) safe(() => { this.ports.close?.started?.(kind, via); return true; }, false);
    return started;
  }

  /** 2026-11-25: the one journal row of a kiss / hug she wrote. */
  private fate(fate: CloseBeatFate): void { safe(() => { this.ports.notes?.outcome?.(fate); return true; }, false); }

  /**
   * I-203: the page's words reached a frame of hers: a pause (her words stop `pauseSeconds` from now; a kiss / hug from her reply holds on
   * through it) or a let-go (the kiss / hug from her reply lets go there). Relayed to her body only while one from her reply plays.
   */
  private frameBeat(ask: FrameBeatAsk): void {
    const seconds = ask.frameBeat === 'pause' ? pauseSeconds(ask.long === true) : 0;
    if (ask.frameBeat === 'pause') safe(() => { this.ports.sequence?.reached?.('pause', seconds); return true; }, false);
    const current = this.current;
    if (!current || current.endedAt !== null || current.cancelled || current.close?.via !== 'chat') return;
    this.link.send({ type: 'frame', id: current.id, frame: ask.frameBeat, seconds });
  }

  /** A kiss or a hug from her reply is back (or ended): her words after it may come now (once per performance). */
  private closeDone(close: CloseRun | null): void {
    if (!close || close.via !== 'chat' || close.released) return;
    // 2026-11-25: back (or ended) without ever reaching its hold: its one row says how it ended (the peek's cancel reason, or none given).
    if (!close.fated && (close.kind === 'kiss' || close.kind === 'hug')) { close.fated = true; this.fate({ kind: close.kind, outcome: 'not-played', why: closeEndWhy(this.current?.close === close ? this.current.cancelled : null) }); }
    close.released = true;
    safe(() => { this.ports.sequence?.finished(); return true; }, false);
  }

  private start(mood: MoodReading | null, trial: boolean, armMs = trial ? PEEK_TIMING.trialArmMs : 0,
    close: { plan: DirectorPlan; run: CloseRun } | null = null): boolean {
    const now = this.now();
    if (this.current && this.current.endedAt === null) return false;
    if (!close && !mood) return false;
    if (this.current) this.retire();
    const id = `peek-${now.toString(36)}-${++this.seq}`;
    const plan: DirectorPlan = close ? close.plan : planPeek(mood!, () => safe(() => this.ports.random(), 0.5), this.variation);
    this.current = { id, trial, startedAt: now, phase: 'notice', endedAt: null, answered: false, cancelled: null, close: close?.run ?? null };
    if (!trial) this.history.record(now);
    this.link.send({ type: 'start', id, plan, trial, armAfterMs: armMs });
    this.link.changed();
    return true;
  }

  private cancel(reason: PeekCancelReason): void {
    const current = this.current;
    if (!current || current.endedAt !== null) return;
    if (!current.cancelled) current.cancelled = reason;
    this.link.send({ type: 'cancel', id: current.id, reason });
    this.link.changed();
  }

  private end(now: number): void {
    const current = this.current;
    if (!current || current.endedAt !== null) return;
    current.endedAt = now;
    this.closeDone(current.close); // ended without its way back reported (timeout, left Unbound): nothing waits on it any more
    this.retire();
    this.link.changed();
  }
  private retire(): void {
    const c = this.current;
    if (!c) return;
    this.last = { id: c.id, trial: c.trial, startedAt: c.startedAt, endedAt: c.endedAt ?? this.now(), answered: c.answered, cancelled: c.cancelled };
    this.current = null;
  }

  /** Within the answer window: you talked to her or touched her after the peek began. */
  private answerWatch(now: number): void {
    const peek = this.current ?? this.last;
    if (!peek || peek.trial || peek.answered) return;
    const endedAt = 'endedAt' in peek ? peek.endedAt : null;
    if (endedAt !== null && now - endedAt > PEEK_TIMING.responseWindowMs) return;
    const at = safe(() => this.ports.lastInteractionAt(), null);
    if (typeof at === 'number' && at > peek.startedAt) this.answer(peek);
  }
  private clicked(id: string): void {
    const now = this.now();
    for (const peek of [this.current, this.last]) {
      if (!peek || peek.id !== id || peek.trial || peek.answered) continue;
      if (peek.endedAt !== null && now - peek.endedAt > PEEK_TIMING.responseWindowMs) continue;
      this.answer(peek);
    }
  }
  private answer(peek: { answered: boolean }): void {
    peek.answered = true;
    safe(() => this.ports.answered(), false);
    this.link.changed();
  }
}
