// I-010 互动余额: one simulated day (08:00–24:00) on the real MoodHost (boredom, speech cues, the "没人回应最多几句" quota), the real
// opening choice (electron/inner-loop/opening-host.ts, her pick), the real 她也会需要你 host and the real 猜拳 invitation rule, with and
// without the interaction budget, on a fake clock. Nothing calls a model: when the opening choice gives her a speech cue she always
// says her line (an upper bound, the same on both sides). Used by tests/interaction-budget-day.test.ts and
// scripts/interaction-budget-day.ts (the numbers in docs/claude/2026-11-05-i010-interaction-budget.md).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../../electron/mood';
import { OpeningHost, type OpeningLoop } from '../../electron/inner-loop/opening-host';
import { innerLoopQuietAt } from '../../electron/inner-loop/context';
import { HerNeedsHost } from '../../electron/her-needs/host';
import { InteractionBudgetHost, openingBudget } from '../../electron/interaction-budget/host';
import type { InteractionBudgetKnobs } from '../../shared/behaviors/interaction-budget/knobs';
import { budgetCreditKind } from '../../electron/companion';
import { OpeningChoiceDirector } from '../../shared/behaviors/opening-choice/choose';
import { FixedBoredomTiming } from '../../shared/behaviors/boredom-timing/fake';
import { rpsInviteVerdict, rpsPlayfulness } from '../../shared/rps-personality';
import { advanceFatigue, createFatigue, DEFAULT_FATIGUE_PARAMETERS, type FatigueState } from '../../shared/fatigue';
import type { MoodCue, MoodParameters } from '../../shared/mood';
import type { MoodView } from '../../shared/mood-runtime';
import type { InnerLoopFocus } from '../../shared/inner-loop';

const MINUTE = 60_000;
const STEP = 5_000;
const NO_BLOCKERS = Object.freeze({ chat: false, tts: false, manualMotion: false });

/** How the user behaves that day. Minutes are local minutes after midnight. */
export interface DayUser {
  readonly name: string;
  /** Messages the user sends on their own (not counting answers to her). */
  readonly messages: readonly number[];
  /** Pats on their own. */
  readonly pats: readonly number[];
  /** Snacks on their own. */
  readonly snacks: readonly number[];
  /** Chance the user answers one of her lines (after `answerAfter` minutes). */
  readonly answer: number;
  readonly answerAfter: number;
  /** Chance the user accepts her invitation to play (the match takes 2 minutes). */
  readonly accept: number;
  /** Chance the user soothes one of her small needs with a pat (after 3 minutes). */
  readonly soothe: number;
}

export interface BudgetDayOptions {
  readonly parameters: MoodParameters;
  readonly user: DayUser;
  readonly seed: number;
  /** true: the interaction budget is wired as in the app; false: the rules before I-010. */
  readonly budget: boolean;
  /** Local minutes of the day the app is open, default 08:00–24:00. */
  readonly from?: number;
  readonly to?: number;
  /** Debugging: one line per new cue and per user action. */
  readonly trace?: (line: string) => void;
  /** Other budget numbers than the knob file (tuning runs). */
  readonly knobs?: InteractionBudgetKnobs;
}

export interface BudgetDayResult {
  /** Speech opportunities the mood model raised (before her pick and the budget). */
  opportunities: number;
  /** Lines she said on her own (her small feeling, an invitation, a line about a need). */
  lines: number;
  invites: number;
  games: number;
  needs: number;
  /** Speech opportunities the budget turned into silence. */
  budgetQuiet: number;
  /** The user's own interactions plus answers, snacks, pats and games (what the budget counted). */
  interactions: number;
  /** When each of her lines came (local minutes). */
  lineAt: number[];
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A user who is around in four sessions (a message every 3–6 minutes, pats, a snack) with idle stretches between. */
export function livelyUser(seed: number): DayUser {
  const random = rng(seed * 7 + 1), messages: number[] = [], pats: number[] = [], snacks: number[] = [];
  for (const [from, to] of [[9 * 60, 10 * 60 + 30], [12 * 60, 13 * 60], [15 * 60, 16 * 60 + 30], [19 * 60 + 30, 21 * 60 + 30]]) {
    for (let m = from; m < to; m += 3 + Math.floor(random() * 4)) messages.push(m);
    for (let m = from + 7; m < to; m += 20) pats.push(m);
    snacks.push(from + 25);
  }
  return { name: '热闹的一天', messages, pats, snacks, answer: 0.9, answerAfter: 1, accept: 0.7, soothe: 0.8 };
}
/** A user who sends three messages all day and seldom answers. */
export const QUIET_USER: DayUser = { name: '安静的一天', messages: [9 * 60 + 10, 13 * 60 + 20, 18 * 60 + 40], pats: [], snacks: [], answer: 0.3, answerAfter: 5, accept: 0.2, soothe: 0.3 };
/** A user who says hello at 08:05 and then never interacts again. */
export const SILENT_USER: DayUser = { name: '一整天没理她', messages: [8 * 60 + 5], pats: [], snacks: [], answer: 0, answerAfter: 1, accept: 0, soothe: 0 };

export async function runBudgetDay(options: BudgetDayOptions): Promise<BudgetDayResult> {
  const from = options.from ?? 8 * 60, to = options.to ?? 24 * 60;
  const midnight = new Date(2026, 10, 5).getTime();
  const clock = { now: midnight + from * MINUTE };
  const minuteOf = (wall: number) => (wall - midnight) / MINUTE;
  const random = rng(options.seed), userRandom = rng(options.seed * 31 + 7);
  let fatigue: Readonly<FatigueState> = createFatigue({ monotonicMs: 86_400_000, localMinute: from }, {}, DEFAULT_FATIGUE_PARAMETERS);
  const start = clock.now;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-budget-day-'));
  const result: BudgetDayResult = { opportunities: 0, lines: 0, invites: 0, games: 0, needs: 0, budgetQuiet: 0, interactions: 0, lineAt: [] };
  const characterId = 'card';
  const budget = options.budget ? new InteractionBudgetHost({ clock: () => clock.now, ...(options.knobs ? { knobs: options.knobs } : {}) }) : null;
  const rps = { invites: [] as { at: number; date: string }[], lastGameAt: null as number | null };
  const pending: { at: number; run: () => void }[] = [];
  const later = (minutes: number, run: () => void) => { pending.push({ at: clock.now + minutes * MINUTE, run }); };
  let serial = 0;
  const seen = new Set<string>();
  let opening: OpeningHost | null = null;
  let needs: HerNeedsHost | null = null;
  let latest: MoodView | null = null;
  const host = new MoodHost(directory, view => {
    latest = view;
    const cue = view.snapshot.cue;
    if (!cue || !opening) return;
    const fresh = !seen.has(cue.id);
    if (fresh) seen.add(cue.id);
    if (cue.kind === 'speech' && fresh) result.opportunities++;
    const owner = opening.claim(cue, {}, view);
    if (fresh && options.trace) options.trace(`${minuteOf(clock.now).toFixed(1)} cue ${cue.kind} boredom ${view.snapshot.boredom.toFixed(0)} → ${owner}`);
  }, () => clock.now, { fatigueClock: { monotonicMs: () => 86_400_000 + clock.now - start, wallMs: () => clock.now, localMinute: wall => minuteOf(wall) % 1440 },
    boredomTiming: new FixedBoredomTiming() });
  try {
    await host.load();
    host.activate(characterId, options.parameters);
    host.setFatigueActivity(NO_BLOCKERS);
    if (budget) {
      host.setBudgetObserver((id, note) => { if (budget.credit(id, budgetCreditKind(note), note.contact ? `contact:${note.contact}` : note.id, note.at)) result.interactions++; });
    } else host.setBudgetObserver(() => { result.interactions++; });
    needs = new HerNeedsHost({ file: () => null, diagnosticsFile: () => null, developerMode: () => false, changed: () => {}, clock: () => clock.now, random,
      lift: (id, lift) => host.lift(lift, id),
      ...(budget ? { balance: (id: string) => budget.room(id, 'need').factor, spent: (id: string, need: string, at: number) => { budget.spend(id, 'need', `need:${need}:${at}`); } } : {}) });
    await needs.load();
    const quiet = () => innerLoopQuietAt(fatigue.phase, minuteOf(clock.now) % 1440);
    const asleep = () => fatigue.phase === 'asleep' || fatigue.phase === 'micro-awake';
    const chat = (answer = false) => {
      const id = `user-${++serial}`;
      host.event({ type: 'chat', id, reason: answer ? '回她的话' : '用户聊天' }, characterId);
      needs!.interact(characterId, 'chat', 1);
    };
    const pat = () => {
      host.event({ type: 'rua', id: `pat-${++serial}`, effectiveMs: 400 }, characterId);
      host.event({ type: 'phase', id: `pat-end-${serial}`, phase: 'idle' }, characterId); // the hand is lifted
      needs!.interact(characterId, 'touch', 6_000);
    };
    const snack = () => {
      host.event({ type: 'food', id: `snack-${++serial}` }, characterId);
      needs!.interact(characterId, 'food', 1);
    };
    const said = () => {
      result.lines++; result.lineAt.push(Math.round(minuteOf(clock.now)));
      if (userRandom() < options.user.answer) later(options.user.answerAfter, () => chat(true));
    };
    const loop: OpeningLoop = {
      offerOpportunity: (value, focus?: InnerLoopFocus) => {
        const cue = value as MoodCue;
        if (cue.kind !== 'speech' || asleep()) return false;
        if (focus === 'play') {
          result.invites++;
          rps.invites.push({ at: clock.now, date: '2026-11-05' });
          result.lines++; result.lineAt.push(Math.round(minuteOf(clock.now)));
          const accepted = userRandom() < options.user.accept;
          // "来！" answers her invitation (electron/rps/host.ts respond: counted once per invitation, not a mood event).
          if (accepted) later(1, () => { if (budget?.credit(characterId, 'answer', `rps-answer:${++serial}`)) result.interactions++; });
          if (accepted) later(2, () => {
            result.games++;
            rps.lastGameAt = clock.now;
            host.event({ type: 'chat', id: `game-${++serial}`, delta: { D: 2 }, context: 'positive', topic: 'rps', reason: '一起玩了猜拳' }, characterId);
          });
          return true;
        }
        // Her small feeling, or a line about the need she has now (the need's one speech chance).
        needs!.speechChance(characterId);
        said();
        return true;
      },
      canTake: value => (value as MoodCue).kind === 'speech' && !asleep(),
      claims: () => false,
      asleep,
      silence: value => { const cue = value as MoodCue; host.releaseSpeech({ id: cue.id, at: cue.at }, characterId); return true; },
      restReminderDue: () => false,
      quietNow: quiet,
    };
    // The budget's one roll per opportunity: counted when it turns the opportunity into silence.
    const base = budget ? openingBudget(() => budget) : null, roll = rng(options.seed * 17 + 5);
    let lastFactor = 1;
    const counted = base ? { ...base, room: (id: string, mood: string) => { const room = base.room(id, mood); lastFactor = room.factor; return room; } } : null;
    opening = new OpeningHost({ loop, chooser: new OpeningChoiceDirector({ random: rng(options.seed * 13 + 3) }),
      random: () => { const value = roll(); if (!(value < lastFactor)) result.budgetQuiet++; return value; },
      innerOn: () => true, developerMode: () => false, clock: () => clock.now,
      releaseSpeech: (cue, id) => { host.releaseSpeech({ id: cue.id, at: cue.at }, id); budget?.refund(id, cue.id); },
      play: (id, isQuiet) => {
        if (isQuiet || !latest) return false;
        const view = latest, now = clock.now;
        const lastInvite = rps.invites.length ? rps.invites[rps.invites.length - 1].at : null;
        const interactions = budget ? { interactions: { sinceInvite: lastInvite === null ? null : budget.interactionsSince(id, lastInvite),
          sinceGame: rps.lastGameAt === null ? null : budget.interactionsSince(id, rps.lastGameAt),
          needed: Math.max(budget.againAfter(id, 'invite'), rps.lastGameAt !== null ? budget.againAfter(id, 'game') : 0) } } : {};
        return rpsInviteVerdict({ now, today: '2026-11-05', playfulness: rpsPlayfulness(view.snapshot, view.parameters), quiet: isQuiet, herLife: null, gameActive: false,
          invites: rps.invites, lastGameAt: rps.lastGameAt, ...interactions }) === 'ok';
      },
      need: id => needs!.hasSpeechChance(id),
      ...(counted ? { budget: counted } : {}) });

    const own = [
      ...options.user.messages.map(m => ({ at: midnight + m * MINUTE, run: () => chat() })),
      ...options.user.pats.map(m => ({ at: midnight + m * MINUTE, run: pat })),
      ...options.user.snacks.map(m => ({ at: midnight + m * MINUTE, run: snack })),
    ];
    pending.push(...own);
    let lastNeedId: string | null = null;
    const end = midnight + to * MINUTE;
    while (clock.now < end) {
      clock.now += STEP;
      fatigue = advanceFatigue(fatigue, { clock: { monotonicMs: 86_400_000 + clock.now - start, localMinute: minuteOf(clock.now) % 1440 },
        channels: host.get().snapshot.values, baseline: host.get().parameters.baseline, blockers: NO_BLOCKERS, mode: 'active' }, DEFAULT_FATIGUE_PARAMETERS);
      pending.sort((a, b) => a.at - b.at);
      while (pending.length && pending[0].at <= clock.now) pending.shift()!.run();
      host.tick(true, { fatigueActivity: NO_BLOCKERS });
      const view: MoodView = host.get();
      budget?.observe(characterId, { weights: view.parameters.weights, night: quiet().night });
      needs.tick(characterId, { now: clock.now, day: '2026-11-05', expressions: true, canExpress: true, phase: view.snapshot.phase,
        lastInteractionAt: view.snapshot.lastInteractionAt, fatigue: fatigue.phase, fatigueF: fatigue.F, longing: view.snapshot.longing, boredom: view.snapshot.boredom,
        mood: view.snapshot.primary, channels: view.snapshot.values, parameters: view.parameters, localMinute: minuteOf(clock.now) % 1440 });
      const need = needs.view(characterId);
      const showing = need && need.mode === 'need' ? `${need.id}:${need.since}` : null;
      if (showing && showing !== lastNeedId) {
        result.needs++;
        if (userRandom() < options.user.soothe) later(3, () => { pat(); pat(); });
      }
      lastNeedId = showing;
    }
    return result;
  } finally {
    needs?.dispose();
    await host.flush().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

/** The three character types the record compares: the card's own numbers with its tendencies changed. */
export function characterTypes(base: MoodParameters): { name: string; parameters: MoodParameters }[] {
  const make = (weights: Partial<MoodParameters['weights']>, playfulIntensity?: number) => {
    const parameters = structuredClone(base);
    parameters.weights = { ...parameters.weights, ...weights };
    if (playfulIntensity !== undefined) parameters.intensity = { ...parameters.intensity, playful: playfulIntensity };
    return parameters;
  };
  return [
    { name: '黏人爱玩', parameters: make({ close: 1.6, playful: 1.6, cautious: 0.7 }) },
    { name: '一般（Gene 原卡）', parameters: structuredClone(base) },
    { name: '谨慎慢热', parameters: make({ close: 0.8, playful: 0.9, cautious: 1.6 }) },
  ];
}
