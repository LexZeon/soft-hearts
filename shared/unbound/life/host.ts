/**
 * Unbound v1 step 4 「她自己的生活」, the host side (docs/claude/2026-11-17-unbound-step4.md). Once a second while she is out:
 * (I-174 item 1, docs/claude/2026-11-21-i174-parity-fixes.md: moved here from electron/unbound/life.ts unchanged, pure as it always was, so the
 * companion window's page runs the same scheduler and arbiter for her small things: src/unbound/window-mode/window-arbiter.ts.)
 *
 *  1. Reads what is already known, through the pure gates of shared/unbound/life/signals.ts only (idle seconds, 「知道你是不是在忙」,
 *     full-screen, and while she is out: the pose sensing's present / facing / posture / wave / stretch with their confidence, you
 *     talking not to her, the computer's sound, the foreground program's kind). Memory only; nothing is stored or sent.
 *  2. You interacting with her (a call, the input box, waiting for her reply, a click, her reply coming out, her reading aloud) owns
 *     her: whatever she does eases out, and the page turns her to you ('attend'). A peek or a close moment backs off only for a call, a pull,
 *     a game or a click (I-192 interruptsClosePose: typing to her, her reply and her reading aloud let her stay as long as she decides).
 *  3. Cues from what you do (shared/unbound/life/reactions.ts): coming back, a wave, a stretch, facing her; each may ask an existing
 *     action now (a reaction); "facing her, sure" turns her gaze to you through I-081's gaze attention.
 *  4. Her mood (read only) sets the pace (mood-read.ts); each action is due on its own schedule; the arbiter (arbiter.ts) picks at
 *     most one: higher levels first, one at a time, a gap between two you notice, nothing when there is no chance.
 *  5. The page plays the plan and reports; a walk's end is where she stands now: the host's placement, saved in the profile.
 *
 * Mood write: only when you answer her coming closer (talk to her or click her during the walk or within the answer window): the
 * existing 'peek-answered' moment (its cooldown family is shared with spoke-answered). Her own moving writes nothing; trials and the
 * fast-forward never write. No Claude call anywhere here.
 */
import { gazeMoodFrom, GazeAttention, type GazeMood, type GazeMoodSource } from '../../senses';
import type { MoodReading } from '../director';
import type { LifeContext, LifeSpot } from './action';
import {
  arbitrate, gazeOwner, interactionOf, quietOf, ARBITER_WAIT_WORDS, INTERACTION_WORDS, LIFE_QUIET_WORDS,
  type ArbiterDecision, type LifeInteraction, type LifeRunning, type LifeSituation, type LifeWant,
} from './arbiter';
import { LIFE_KNOB_DEFAULTS, lifeDrives, lifeRates, patchLifeKnobs, type LifeKnobs, type LifeRates } from './mood-read';
import { PresenceTracker, reactionFor, temperDrives, CUE_WORDS, REACTION_TIMING, type LifeCue } from './reactions';
import { LIFE_ACTIONS, lifeAction } from './registry';
import { endsAction, isUserEndCause, type ActionKind, type UserEndCause } from '../action-ends'; // the one interruption arbiter
import { GO_WAIT_MS, GoOutcomes, chosenSpotOpen, chosenSpotUntil, goBlock, goDecide, goStayWhyOfBlock, goStayedRow, goWentRow, metresBetween, parseGoBeatAsk, placeMovedRow, type GoBeatAnswer, type GoOutcome, type GoStayWhy, type GoTarget, type GoWord, type LifeJournalRow } from '../her-position'; // I-193: her reply's "go where" words
import { DOING_WORDS, FOREGROUND_WORDS, lifeSignals, type LifeSignals } from './signals';
import { WANDER_FASTER } from './actions/place';
import { noticeable, parseLifeReport, planEnd, type LifeCancelReason, type LifeLevel, type LifePlan } from './types';
import type { LifeCommand } from './types';
import type { LifeView } from './view';

export type { LifeView };

/** Fixed rules (not knobs). */
export const LIFE_TIMING = Object.freeze({
  /** A click on her counts as you interacting for this long (ms). */
  clickHoldMs: 8_000,
  /** Step 5: a pull counts as you interacting from its start until its end report, at most this long without one (ms). */
  pullLeaseMs: 120_000,
  /** Her reply counts as still coming out this long after its last word (ms; reading aloud is its own signal). */
  replyTailMs: 6_000,
  /** You answered her coming closer: during the walk or this long after it (ms). */
  answerWindowMs: 25_000,
  /** The page never reported the end: over after the plan's own length plus this (ms). */
  reportSlackMs: 20_000,
  /** The schedule draws each next time this much around the action's interval. */
  jitter: [0.6, 1.4] as const,
  /** The first time after she comes out: this part of the interval at most. */
  firstShare: [0.25, 0.8] as const,
  /** Fast-forward: schedules and gaps run this many times faster; the scripted day lasts this long (ms). */
  fastSpeed: 20, fastDayMs: 6 * 60_000,
});

export interface LifeReadings { idleSeconds: unknown; state: unknown; pose: unknown; activity: unknown; talkedAt: unknown; sound: unknown }
export interface LifePorts {
  clock(): number;
  random(): number;
  /** The raw readings; only lifeSignals' fields are ever looked at (electron/unbound/electron-host.ts fills them in). */
  readings(): Partial<LifeReadings>;
  asleep(): boolean;
  inCall(): boolean;
  /** You sent her something and wait for the reply. */
  waiting(): boolean;
  /** Her small input box is open. */
  typing(): boolean;
  /** Her voice is reading something now (replySpeechBusy() || speechPlaybackActivity.busy). */
  readingAloud(): boolean;
  mood(): MoodReading | null;
  /** Her mood view for I-081's gaze attention (null: neutral). */
  gazeMood?(): GazeMoodSource | null;
  lastInteractionAt(): number | null;
  /** The 'peek-answered' moment; true when applied. */
  answered(): boolean;
  /** A cue she noticed (kinds, bands and a duration only), for the interaction history. */
  noticed?(cue: LifeCue): void;
  /** You started talking, not to her (the fact only), or you answered her coming closer: for the interaction history. */
  happened?(kind: 'talked' | 'answered' | 'pulled-along'): void;
  /** Batch B: a game, an offer or her reach for your hand is on (you are playing with her: whatever she does eases out, a walk brakes). */
  playing?(): boolean;
  /** A repeating timer (the host's one-second beat when there is no peek); returns a stop function. */
  every(ms: number, run: () => void): () => void;
  /** I-193: one row per "go where" word (went / stayed and why) and one per walk of hers that ended (closed words and metres only). */
  journal?(row: LifeJournalRow): void;
}
export interface LifeLink {
  /** She is out and her window is on screen. */
  shown(): boolean;
  fullscreen(): boolean;
  /** She is out at all (the senses she reads exist only then). */
  out(): boolean;
  send(command: LifeCommand): void;
  /** Where she stands now (null before her world is known), and a spot on her floor. */
  here(): LifeSpot | null;
  toWorld(spot: LifeSpot): { xM: number; depthM: number } | null;
  /** A walk ended: she stands here now (world m). */
  arrived(at: { xM: number; depthM: number }): void;
  /** I-193: she would stand over a window that must stay clear (the one you are using) at this spot. Absent today: the app has no reading of your windows. */
  covers?(spot: LifeSpot): boolean;
  /** I-193: how near "come-near" walks her (I-212: a size on the screen): the default place's, else a chest-up framing for her height; null: not known. */
  nearSize?(): number | null;
  /** I-193: the nearest she walks to by herself, "only the face" (her-position/reach.ts); null: not known. */
  nearestSize?(): number | null;
  /** I-193 numbers: ⟦go 30% 1.2m⟧ as a spot on this screen for her height (metres through screen-terms only); null: cannot be converted. */
  goTarget?(target: GoTarget): { across?: number; size?: number } | null;
  /** I-193: the display has a taskbar (its work area is smaller than the display): her rough-position line may name it. */
  taskbar?(): boolean;
  peekActive(): boolean;
  /** Something the arbiter says ends a peek or a close moment (today only a game: a new action of hers): it backs off. */
  interruptPeek(cause: string): void;
  /** You ended one of her own things directly (a large pull, a click): her next turn hears it once and the journal gets a row. */
  interrupted?(action: ActionKind, by: UserEndCause): void;
  changed(): void;
}

interface Running { id: string; action: string; level: LifeLevel; plan: LifePlan; startedAt: number; trial: boolean; easing: boolean; answerable: boolean; cue: LifeCue | null; deadline: number;
  /** I-193: she chose this walk in her reply (a "go where" word): a call, her reply, her reading aloud or your typing do not end it. */
  chosen?: boolean;
  /** Where the walk began (world m), for the journal's "how many metres she moved". */
  from?: { xM: number; depthM: number } | null }
interface Answerable { startedAt: number; endedAt: number | null; answered: boolean }
interface Reaction { action: string; cue: LifeCue; until: number }

const safe = <T>(read: () => T, fallback: T): T => { try { const value = read(); return value ?? fallback; } catch { return fallback; } };
const FAST_PHASES = Object.freeze([
  { words: '快进：你在忙', doing: 'busy' as const, idle: 3, A: null },
  { words: '快进：你停下来了', doing: 'paused' as const, idle: 120, A: null },
  { words: '快进：她困了', doing: 'paused' as const, idle: 200, A: 0.85 },
  { words: '快进：平常', doing: 'unknown' as const, idle: null, A: null },
]);

export class LifeHost {
  private knobs: LifeKnobs = { ...LIFE_KNOB_DEFAULTS };
  private readonly nextAt = new Map<string, number>();
  private current: Running | null = null;
  private answerable: Answerable | null = null;
  private reactions: Reaction[] = [];
  private readonly tracker = new PresenceTracker();
  private readonly gaze: GazeAttention;
  private facing = false;
  private attending: LifeInteraction | null = null;
  private attendSent: 'user' | 'facing' | null = null;
  private interactionEndedAt: number | null = null;
  private lastNoticeableEndAt: number | null = null;
  private peekWasActive = false;
  private streaming = false;
  private replyUntil = 0;
  private clickedAt = -Infinity;
  private pulledUntil = -Infinity;
  /** I-205b: until when the spot she chose in her reply is hers (her-position/keep.ts); a pull ends it. */
  private chosenSpotEnd: number | null = null;
  private seq = 0;
  private why: string | null = null;
  private lastCue: string | null = null;
  private fast: { startedAt: number } | null = null;
  private lastRates: LifeRates | null = null;
  private lastSituation: LifeSituation | null = null;
  /** I-193: a chosen walk waiting for a small move of hers to ease out (dropped after GO_WAIT_MS). */
  private pendingGo: { plan: LifePlan; at: number; stayMinutes: number; word: GoWord; metres: number | null; target: GoTarget | null } | null = null;

  constructor(private readonly ports: LifePorts, private readonly link: LifeLink) {
    this.gaze = new GazeAttention(() => safe(() => ports.random(), 0.5));
  }

  get active(): boolean { return !!this.current; }
  /** You are pulling her now (from the pull's start report to its end, at most LIFE_TIMING.pullLeaseMs). */
  get pulledNow(): boolean { return this.now() < this.pulledUntil; }
  get knobValues(): LifeKnobs { return { ...this.knobs }; }
  setKnobs(patch: unknown): void { this.knobs = patchLifeKnobs(this.knobs, patch); this.link.changed(); }

  /** Her reply streaming (any surface that tells the peek): a cue that you and she are talking. */
  chat(type: 'delta' | 'done' | 'error'): void {
    if (type === 'delta') this.streaming = true;
    else { this.streaming = false; this.replyUntil = this.now() + LIFE_TIMING.replyTailMs; }
  }
  /** You clicked her (the host took the touch report). */
  touched(): void { this.clickedAt = this.now(); }
  /**
   * Step 5 (拉她): a pull began (you own her: whatever she does eases out, the walk brakes), or ended. When she walked along, where
   * she stands is yours for a while: her own "go somewhere" waits at least `stayMinutes` (a walk straight back would read as
   * refusing you), and the day's history counts it ("被拉着走过").
   */
  pulled(phase: 'start' | 'end', walked = false, stayMinutes = 0): void {
    const now = this.now();
    if (phase === 'start') { this.pulledUntil = now + LIFE_TIMING.pullLeaseMs; this.chosenSpotEnd = null; return; }
    this.pulledUntil = -Infinity;
    if (!walked) return;
    const stay = now + Math.max(0, stayMinutes) * 60_000;
    this.nextAt.set('place', Math.max(this.nextAt.get('place') ?? 0, stay));
    safe(() => { this.ports.happened?.('pulled-along'); return true; }, false);
  }

  /** I-193: where she stands now (null before her world is known). */
  here(): LifeSpot | null { return safe(() => this.link.here(), null); }
  /** I-193: the display has a taskbar (false when not known). */
  taskbar(): boolean { return safe(() => this.link.taskbar?.() ?? false, false); }

  /**
   * I-193: her reply reached a "go where" word (go-left, come-near, go-cursor…) and the page asks (peekReport({ goBeat })).
   * undefined: not such a question. 'stay': not now (the gates of shared/unbound/her-position/gates.ts: not shown, asleep, pulled, a game, the box
   * open, a peek or a close moment; a call is not one), or she is already there, or there is nowhere to go. 'go': the walk is on (or waits at most
   * GO_WAIT_MS for a small move of hers to ease out). It is her own walk path (plan.walk of the life player: the gait, no teleport), level 'place'; her
   * mood is not written; her own "换个地方站" waits a few minutes after it, so she does not walk straight back.
   */
  goAsk(value: unknown): GoBeatAnswer | undefined {
    const ask = parseGoBeatAsk(value);
    if (!ask) return undefined;
    const word = ask.goBeat, now = this.now(), situation = this.situation(now);
    const target: GoTarget | null = word === 'go' ? { ...(ask.percent !== undefined ? { percent: ask.percent } : {}), ...(ask.metres !== undefined ? { metres: ask.metres } : {}) } : null; // I-193 numbers, as she wrote them
    const block = goBlock(this.goGates(situation));
    if (block) return this.goStayed(word, goStayWhyOfBlock(block), target);
    const context = this.context(now, situation, false, null);
    if (!context.here) return this.goStayed(word, 'no-place', target);
    const go = goDecide({ word, here: context.here, cursorAcross: ask.cursorAcross ?? null, random: context.random, drives: context.drives,
      nearSize: safe(() => this.link.nearSize?.() ?? null, null), covers: spot => safe(() => this.link.covers?.(spot) ?? false, false),
      nearestLimit: safe(() => this.link.nearestSize?.() ?? null, null), target: target ? safe(() => this.link.goTarget?.(target) ?? null, null) : null });
    if ('why' in go) { if (go.why === 'already-there') this.chosenSpotEnd = chosenSpotUntil(now); return this.goStayed(word, go.why, target); } // she chose to stay where she is: that is a choice too
    const world = context.toWorld(go.spot);
    if (!world) return this.goStayed(word, 'no-place', target);
    if (this.pendingGo) return this.goStayed(word, 'queued', target);
    const metres = metresBetween(safe(() => this.link.toWorld(context.here!), null), world);
    const plan: LifePlan = { action: 'place', level: 'place', keys: [{ t: 0 }], walk: { xM: world.xM, depthM: world.depthM, speedMps: go.speedMps }, amplitude: context.drives.amplitude, easeS: 1, waitQuickS: 0 };
    if (this.current) { this.cancel('higher'); this.pendingGo = { plan, at: now, stayMinutes: go.stayMinutes, word, metres, target }; return 'go'; } // its row comes when it starts or is dropped
    this.launchGo(plan, now, go.stayMinutes, word, metres, target);
    return 'go';
  }

  /** I-193: how her go-markers went since the last turn (fed by their journal rows), told once by her next turn's position line. */
  private readonly goOutcomes = new GoOutcomes();
  takeGoOutcomes(): GoOutcome[] { return this.goOutcomes.take(this.now()); }
  /** Every go-word leaves one row (I-193): this is the "she stayed" one. */
  private goStayed(word: GoWord, why: GoStayWhy, target: GoTarget | null = null): 'stay' { this.row(goStayedRow(word, why, target)); return 'stay'; }
  private row(row: LifeJournalRow | null): void { if (row) { this.goOutcomes.note(row, this.now()); safe(() => { this.ports.journal?.(row); return true; }, false); } }
  /** A chosen walk that never started (it waited too long, a gate closed, she went in): its word's row says so. */
  private dropPendingGo(): void {
    const go = this.pendingGo;
    this.pendingGo = null;
    if (go) this.row(goStayedRow(go.word, 'dropped', go.target));
  }

  /** Where she stands now in world metres: the start of a walk, for the journal's metres. */
  private startOfWalk(): { xM: number; depthM: number } | null { const here = this.here(); return here ? safe(() => this.link.toWorld(here), null) : null; }

  private goGates(situation: LifeSituation) {
    return { shown: situation.shown, asleep: situation.asleep, pulled: situation.pulled === true, playing: situation.playing === true, typing: situation.typing, busy: safe(() => this.link.peekActive(), false) };
  }
  private startPendingGo(now: number, situation: LifeSituation): void {
    const go = this.pendingGo;
    if (!go) return;
    if (now - go.at > GO_WAIT_MS || goBlock(this.goGates(situation))) { this.dropPendingGo(); return; }
    if (this.current) return;
    this.pendingGo = null;
    this.launchGo(go.plan, now, go.stayMinutes, go.word, go.metres, go.target);
  }
  private launchGo(plan: LifePlan, now: number, stayMinutes: number, word: GoWord, metres: number | null, target: GoTarget | null = null): void {
    const id = `life-${now.toString(36)}-${++this.seq}`;
    this.current = { id, action: 'place', level: 'place', plan, startedAt: now, trial: false, easing: false, answerable: false, cue: null, chosen: true, from: this.startOfWalk(),
      deadline: now + (planEnd(plan) + 30) * 1000 + LIFE_TIMING.reportSlackMs };
    this.row(goWentRow(word, metres, target));
    this.chosenSpotEnd = chosenSpotUntil(now);
    this.nextAt.set('place', Math.max(this.nextAt.get('place') ?? 0, now + Math.max(0, stayMinutes) * 60_000));
    this.link.send({ type: 'start', id, plan, trial: false });
    this.link.changed();
  }

  /** The peek is about to start: may it? A lower action running is asked to ease out first (the peek tries again next second). */
  claim(): boolean {
    const now = this.now(), situation = this.situation(now), decision = this.decide(now, situation, [{ id: 'peek', level: 'peek' }]);
    if (decision.kind === 'start' && decision.id === 'peek') return true;
    if (decision.kind === 'yield') this.cancel(decision.reason);
    return false;
  }
  /** Why the peek should not even think about it now (her reading of you), or null. */
  peekBlock(): string | null {
    const s = this.lastSituation?.signals;
    if (!s) return null;
    if (s.someoneInFront === false) return '摄像头前没人';
    if (s.talkingToOthers) return '你在和别人说话';
    if (s.soundPlaying) return '电脑在放声音';
    if (s.foreground === 'video' || s.foreground === 'game') return s.foreground === 'video' ? '你在看视频' : '你在玩游戏';
    return null;
  }
  /** The peek's pace from her mood: per hour (1..4 by default), and a cooldown that fits it (never longer than the peek's own knob). */
  peekPace(cooldownKnob: number): { perHour: number; cooldownMinutes: number } | null {
    const rates = this.lastRates;
    if (!rates) return null;
    const perHour = Math.max(1, Math.round(rates.peekPerHour));
    return { perHour, cooldownMinutes: Math.min(cooldownKnob, 48 / perHour) / this.speed() };
  }

  /** Once a second while she is out. */
  tick(): void {
    const now = this.now(), situation = this.situation(now);
    this.lastSituation = situation;
    const interaction = interactionOf(situation);
    if (interaction !== this.attending) {
      if (!interaction) this.interactionEndedAt = now;
      this.attending = interaction;
    }
    if (interaction && endsAction('look', interaction) && this.link.peekActive()) this.link.interruptPeek(interaction); // the close family: only a game (a large pull ends it on the page)
    const peekActive = safe(() => this.link.peekActive(), false);
    if (this.peekWasActive && !peekActive) this.lastNoticeableEndAt = now;
    this.peekWasActive = peekActive;
    this.notice(situation.signals, now);
    this.lookBack(situation, interaction);
    this.sendAttend(interaction ? 'user' : this.facing ? 'facing' : null);
    this.answerWatch(now);
    if (this.current && now > this.current.deadline) this.finish(now, null); // the page went quiet: over
    this.startPendingGo(now, situation);
    const decision = this.decide(now, situation, []);
    this.why = decision.kind === 'wait' ? (decision.why === 'user' && interaction ? INTERACTION_WORDS[interaction] : decision.why === 'quiet' ? LIFE_QUIET_WORDS[quietOf(situation)!] : ARBITER_WAIT_WORDS[decision.why]) : null;
    if (decision.kind === 'yield') this.yieldTo(decision.reason, interaction); // the arbiter's row for what runs: typing never ends it
    else if (decision.kind === 'start') this.start(decision.id, now, situation, false);
    if (this.fast && now - this.fast.startedAt > LIFE_TIMING.fastDayMs) this.fast = null;
    this.link.changed();
  }

  /** 「试一下」 one action now (developer panel): only while she is out and nothing of hers or yours runs; never written to her mood. */
  trial(id: string): boolean {
    const now = this.now(), situation = this.situation(now);
    if (!lifeAction(id) || !situation.shown || this.current || interactionOf(situation) || safe(() => this.link.peekActive(), false)) return false;
    return this.start(id, now, situation, true);
  }
  /** 「快进」 (developer panel): her day in a few minutes, from a script of what you do; schedules and gaps run LIFE_TIMING.fastSpeed times faster. */
  fastForward(on: boolean): void {
    this.fast = on ? { startedAt: this.now() } : null;
    this.nextAt.clear();
    this.link.changed();
  }

  /** The page's report (only from the shown window's top frame, the host checked). */
  report(value: unknown): void {
    const report = parseLifeReport(value), current = this.current;
    if (!report || !current || report.id !== current.id) return;
    if (report.at) {
      safe(() => { this.link.arrived(report.at!); return true; }, false);
      if (!current.trial && current.plan.walk && current.from) { // I-193: one row per walk that ended (the start is spent with it)
        const metres = metresBetween(current.from, report.at);
        current.from = null;
        this.row(placeMovedRow(current.chosen ? 'go-word' : 'own', this.here(), metres));
      }
    }
    if (report.phase === 'easing') current.easing = true;
    if (report.phase === 'done') this.finish(this.now(), report.skipped ? 'skipped' : null);
    this.link.changed();
  }

  /** She went in (or the window went): nothing carries over except the knobs. */
  stop(): void {
    this.current = null; this.dropPendingGo(); this.reactions = []; this.nextAt.clear(); this.tracker.reset(); this.facing = false;
    this.attending = null; this.attendSent = null; this.fast = null; this.peekWasActive = false; this.answerable = null;
  }

  view(): LifeView {
    const now = this.now(), situation = this.lastSituation, context = situation ? this.context(now, situation, false, null) : null;
    const fastPhase = this.fastPhase(now);
    return {
      knobs: { ...this.knobs }, rates: this.lastRates,
      running: this.current ? { action: this.current.action, words: lifeAction(this.current.action)?.words ?? this.current.action, easing: this.current.easing, trial: this.current.trial } : null,
      why: this.why,
      gaze: gazeOwner({ peekActive: safe(() => this.link.peekActive(), false), interaction: this.attending, facing: this.facing, running: this.running() }),
      doing: situation ? [DOING_WORDS[situation.signals.doing], situation.signals.foreground ? FOREGROUND_WORDS[situation.signals.foreground] : null].filter(Boolean).join('，') : null,
      fastForward: this.fast && fastPhase ? { phase: fastPhase.words, leftS: Math.max(0, Math.round((LIFE_TIMING.fastDayMs - (now - this.fast.startedAt)) / 1000)) } : null,
      actions: LIFE_ACTIONS.map(spec => {
        const at = this.nextAt.get(spec.id);
        return { id: spec.id, words: spec.words, level: spec.level, inS: at === undefined ? null : Math.max(0, Math.round((at - now) / 1000)), notNow: context ? safe(() => spec.notNow(context), null) : null };
      }),
      lastCue: this.lastCue,
    };
  }

  // ---- inside ---------------------------------------------------------------------------------------------------------------

  private now(): number { const value = safe(() => this.ports.clock(), Date.now()); return Number.isFinite(value) ? value : Date.now(); }
  private speed(): number { return this.fast ? LIFE_TIMING.fastSpeed : 1; }
  private fastPhase(now: number) {
    if (!this.fast) return null;
    const share = (now - this.fast.startedAt) / LIFE_TIMING.fastDayMs;
    return FAST_PHASES[Math.min(FAST_PHASES.length - 1, Math.max(0, Math.floor(share * FAST_PHASES.length)))];
  }

  private situation(now: number): LifeSituation {
    const out = safe(() => this.link.out(), false), raw = safe(() => this.ports.readings(), {} as Partial<LifeReadings>);
    let signals: LifeSignals = lifeSignals({ ...raw, fullscreen: safe(() => this.link.fullscreen(), false), out, now });
    let mood = safe(() => this.ports.mood(), null);
    const phase = this.fastPhase(now);
    if (phase) { // fast-forward: a scripted you, and her sleepiness for the sleepy part (decisions only; nothing is written)
      signals = { ...signals, doing: phase.doing, idleSeconds: phase.idle, foreground: null };
      if (mood && phase.A !== null) mood = { ...mood, A: phase.A };
    }
    return {
      shown: safe(() => this.link.shown(), false), asleep: safe(() => this.ports.asleep(), false), inCall: safe(() => this.ports.inCall(), false),
      typing: safe(() => this.ports.typing(), false), waiting: safe(() => this.ports.waiting(), false), clicked: now - this.clickedAt < LIFE_TIMING.clickHoldMs,
      pulled: now < this.pulledUntil, playing: safe(() => this.ports.playing?.() === true, false),
      replying: this.streaming || now < this.replyUntil, readingAloud: safe(() => this.ports.readingAloud(), false), signals, mood,
    };
  }

  private running(): LifeRunning | null {
    if (safe(() => this.link.peekActive(), false)) return { id: 'peek', level: 'peek', easing: false };
    return this.current ? { id: this.current.id, level: this.current.level, easing: this.current.easing } : null;
  }

  private context(now: number, situation: LifeSituation, trial: boolean, cue: LifeCue | null): LifeContext {
    const drives = temperDrives(lifeDrives(situation.mood ?? { D: 50, O: 50, E: 50, N: 50, C: 50, A: 0.2, B: 0, M: 0 }), situation.signals);
    return { now, situation, drives, rates: lifeRates(drives, this.knobs), here: safe(() => this.link.here(), null), toWorld: spot => safe(() => this.link.toWorld(spot), null),
      random: () => Math.min(1, Math.max(0, safe(() => this.ports.random(), 0.5))), trial, cue, youLeft: this.tracker.away, chosenSpotKept: chosenSpotOpen(this.chosenSpotEnd, now) };
  }

  /** The arbiter's answer now; `extra`: wants from outside (the peek's claim). */
  private decide(now: number, situation: LifeSituation, extra: LifeWant[]): ArbiterDecision {
    const context = this.context(now, situation, false, null);
    this.lastRates = context.rates;
    this.reactions = this.reactions.filter(r => r.until > now);
    const wants: LifeWant[] = [...extra];
    for (const spec of LIFE_ACTIONS) {
      const reaction = this.reactions.find(r => r.action === spec.id) ?? null;
      const interval = spec.interval(context.rates) / (spec.id === 'place' && this.tracker.away ? WANDER_FASTER : 1) / this.speed();
      if (!this.nextAt.has(spec.id)) this.nextAt.set(spec.id, now + interval * 1000 * this.between(LIFE_TIMING.firstShare));
      if (!reaction && now < this.nextAt.get(spec.id)!) continue;
      let why: string | null;
      try { why = spec.notNow({ ...context, cue: reaction?.cue ?? null }); } catch { why = '不行'; }
      if (why !== null) continue;
      wants.push({ id: spec.id, level: spec.level, ...(reaction ? { prompt: true } : {}) });
    }
    return arbitrate({ now, interaction: interactionOf(situation), quiet: quietOf(situation), running: this.running(), wants,
      lastNoticeableEndAt: this.lastNoticeableEndAt, interactionEndedAt: this.interactionEndedAt, knobs: this.knobs, speed: this.speed() });
  }

  private between([lo, hi]: readonly [number, number]): number { return lo + (hi - lo) * Math.min(1, Math.max(0, safe(() => this.ports.random(), 0.5))); }
  private reschedule(action: string, now: number, rates: LifeRates): void {
    const spec = lifeAction(action);
    if (!spec) return;
    const interval = spec.interval(rates) / (action === 'place' && this.tracker.away ? WANDER_FASTER : 1) / this.speed();
    this.nextAt.set(action, now + interval * 1000 * this.between(LIFE_TIMING.jitter));
  }

  private start(action: string, now: number, situation: LifeSituation, trial: boolean): boolean {
    const spec = lifeAction(action);
    if (!spec || this.current) return false;
    const reaction = this.reactions.find(r => r.action === action) ?? null;
    const context = this.context(now, situation, trial, reaction?.cue ?? null);
    const choice = safe(() => spec.plan(context), null);
    this.reactions = this.reactions.filter(r => r !== reaction);
    if (!choice) { this.reschedule(action, now, context.rates); return false; }
    const id = `life-${now.toString(36)}-${++this.seq}`, plan = choice.plan;
    const walkS = plan.walk && context.here ? 30 : 0;
    this.current = { id, action, level: spec.level, plan, startedAt: now, trial, easing: false, answerable: choice.answerable && !trial && !this.fast,
      cue: reaction?.cue ?? null, deadline: now + (planEnd(plan) + walkS) * 1000 + LIFE_TIMING.reportSlackMs, from: plan.walk ? this.startOfWalk() : null };
    if (this.current.answerable) this.answerable = { startedAt: now, endedAt: null, answered: false };
    this.link.send({ type: 'start', id, plan, trial });
    this.link.changed();
    return true;
  }

  /**
   * The arbiter's yield (arbitrate): a higher action of hers always takes over; your interaction only when the interruption arbiter's row for
   * what runs says so (shared/unbound/action-ends: typing and the mouse never; a walk she chose goes on while she talks). You ending it directly
   * (a large pull, a click) is told to her and journaled.
   */
  private yieldTo(reason: 'user' | 'higher', interaction: LifeInteraction | null): void {
    const current = this.current;
    if (!current || current.easing) return;
    const kind: ActionKind = current.chosen ? 'walk' : 'life';
    if (reason === 'user' && !endsAction(kind, interaction)) return;
    this.cancel(reason);
    if (reason === 'user' && !current.trial && isUserEndCause(interaction)) safe(() => { this.link.interrupted?.(kind, interaction); return true; }, false);
  }

  private cancel(reason: LifeCancelReason): void {
    const current = this.current;
    if (!current || current.easing) return;
    current.easing = true;
    this.link.send({ type: 'cancel', id: current.id, reason });
  }

  private finish(now: number, how: 'skipped' | null): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    if (noticeable(current.level) && how !== 'skipped') this.lastNoticeableEndAt = now;
    if (this.answerable && this.answerable.endedAt === null && current.answerable) this.answerable.endedAt = now;
    this.reschedule(current.action, now, this.lastRates ?? lifeRates(lifeDrives({ D: 50, O: 50, E: 50, N: 50, C: 50, A: 0.2, B: 0, M: 0 }), this.knobs));
  }

  /** Cues from the camera: a reaction (an action now) and the facing look; each is told to the interaction history. */
  private talking = false;
  private notice(signals: LifeSignals, now: number): void {
    if (signals.talkingToOthers && !this.talking && !this.fast) safe(() => { this.ports.happened?.('talked'); return true; }, false);
    this.talking = signals.talkingToOthers;
    for (const cue of this.tracker.update(signals, now)) {
      this.lastCue = `${cue.band === 'maybe' ? '好像' : ''}${CUE_WORDS[cue.kind]}`;
      safe(() => { this.ports.noticed?.(cue); return true; }, false);
      for (const action of reactionFor(cue)) {
        this.reactions = this.reactions.filter(r => r.action !== action);
        this.reactions.push({ action, cue, until: now + REACTION_TIMING.freshMs });
      }
    }
  }

  /** You face her (sure): I-081's gaze attention decides, as on the companion, whether she looks back now (four quarter-second steps a tick). */
  private lookBack(situation: LifeSituation, interaction: LifeInteraction | null): void {
    const pose = situation.signals.pose, sure = pose?.facing?.band === 'sure' ? pose.facing.value : 'unknown';
    const mood: GazeMood = gazeMoodFrom(safe(() => this.ports.gazeMood?.() ?? null, null));
    let frame = null;
    for (let i = 0; i < 4; i++) frame = this.gaze.frame({ dt: 0.25, user: pose ? { present: pose.present, facing: sure, energy: 0 } : null, mouse: false,
      allowed: !situation.asleep, speaking: !!interaction, mood });
    this.gaze.takeEvents();
    this.facing = !!frame && frame.engaged && frame.target === 'user' && frame.user > 0.5;
  }

  private sendAttend(on: 'user' | 'facing' | null): void {
    if (on === this.attendSent) return;
    this.attendSent = on;
    this.link.send(on ? { type: 'attend', on: true, why: on } : { type: 'attend', on: false });
  }

  /** You answered her coming closer: talked to her or clicked her after the walk began, within the window after it. */
  private answerWatch(now: number): void {
    const a = this.answerable;
    if (!a || a.answered) return;
    if (a.endedAt !== null && now - a.endedAt > LIFE_TIMING.answerWindowMs) { this.answerable = null; return; }
    const at = safe(() => this.ports.lastInteractionAt(), null);
    if ((typeof at === 'number' && at > a.startedAt) || this.clickedAt > a.startedAt) {
      a.answered = true;
      safe(() => this.ports.answered(), false);
      safe(() => { this.ports.happened?.('answered'); return true; }, false);
    }
  }
}
