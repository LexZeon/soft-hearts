import type { FatiguePhase } from '../../shared/fatigue';
import type { HerLifeActivity, HerLifeSwitchOffer } from '../../shared/her-life';
import { innerLoopNightKey, type InnerLoopDiagnostic, type InnerLoopView } from '../../shared/inner-loop';
import { RestReminderStore } from './rest-reminder-store';
import type { MoodParameters } from '../../shared/mood';
import type { ProactiveSpeechLease, ProactiveSpeechOpportunity } from '../../shared/proactive-speech';
import { proactiveTalk, type ProactiveTalk } from '../../shared/behaviors/inner-rhythm/knobs';
import { VisionPresentationGuard, type VisionPresentationSurface } from '../vision-presentation-adapter';
import { innerLoopLocalMinute, innerLoopPrompt, innerLoopQuietAt, type InnerLoopContextSources } from './context';
import { InnerLoopDiagnostics } from './diagnostics';
import { InnerLoop, type InnerLoopClaim, type InnerLoopDependencies, type InnerLoopMessage } from './inner-loop';
import { decideWithClaude } from './model';
import { OpeningHost, type OpeningBudget } from './opening-host';
import type { OpeningChoiceHost } from '../../shared/behaviors/opening-choice/interface';
import { userActivitySentence, userIsBusy } from '../../shared/behaviors/user-activity/effects';
import type { UserActivityView } from '../../shared/behaviors/user-activity/interface';

/** Everything electron/main.ts supplies; each reader is called only at the moment it is needed. */
export interface InnerLoopHostOptions {
  gate: { tryAcquire(opportunity: ProactiveSpeechOpportunity, source: 'inner'): ProactiveSpeechLease | null };
  /** App setting `innerLoop` (default on). */
  setting(): boolean;
  /** MoodView.expressions ("暂停自动表现" off). */
  expressions(): boolean;
  /** The existing moodTimer canExpress gate. */
  canExpress(): boolean;
  /** Visible, no typing (userInputUntil), no drag, no chat, idle mood phase; without the speech-busy part. */
  current(): boolean;
  characterId(): string;
  gateScope(): string;
  parameters(): MoodParameters;
  fatiguePhase(): FatiguePhase | null | undefined;
  context: Omit<InnerLoopContextSources, 'now' | 'parameters'>;
  realize(claim: Readonly<InnerLoopClaim>, kind: 'look' | 'motion', eventId: string): void;
  releaseSpeech(claim: Readonly<InnerLoopClaim>): void;
  /** Same renderer channel and bubble as a visual initiative. */
  offer(message: InnerLoopMessage): boolean | void;
  cancelOffer(id: string): void;
  surface(): VisionPresentationSurface | null;
  /** Speech scope + vision generation: user input or a context change invalidates a shown line. */
  presentationIdentity(): string;
  archive(message: InnerLoopMessage): Promise<void>;
  developerMode(): boolean;
  diagnosticsFile(): string | null;
  diagnosticsChanged(): void;
  /** 体验记录 (electron/journal/sources.ts innerLoopInput): each decision in every mode; categories only, never the line she said. */
  journal?(entry: InnerLoopDiagnostic, characterId: string): void;
  /** Called when an opportunity ends, to release request-scoped leases (user profile context). */
  settled?(): void;
  decide?: InnerLoopDependencies['decide'];
  /**
   * Claude availability (electron/chat-availability.ts): told after each model call. Our own timeout or a
   * cancellation is not reported (the signal was aborted on our side).
   */
  report?: { success(): void; failure(error: unknown): void };
  /** <profile>/inner-loop-state.json: the night of the last rest reminder. Omitted: no night reminder. */
  restReminderFile?: () => string | null;
  /** 她自己的生活 (electron/her-life/host.ts): "换件事做" on motion opportunities. Omitted: no such option. */
  herLife?: {
    offer(characterId: string): HerLifeSwitchOffer | null;
    switch(characterId: string, activity: HerLifeActivity): boolean;
  };
  /** G1 猜拳 (electron/rps/host.ts): "邀请玩猜拳" on speech opportunities. Omitted: no such option. */
  play?: {
    eligible(characterId: string, quiet: boolean): boolean;
    invited(characterId: string): void;
  };
  /**
   * I-020 #10, look don't take (HerNeedsHost.hasSpeechChance): she has a small need she could speak about now. The opening choice
   * weighs it; only the inner loop's prompt (context.need) spends it. Omitted: never counted.
   */
  needReady?(characterId: string): boolean;
  /** I-006 第 1 步: whether the user is absorbed right now (electron/user-activity.ts view). Leans the opening choice toward 这次不说 and adds one line to 【此刻】. Omitted: as before. */
  userActivity?: () => UserActivityView | null;
  /** I-020 #10: replaces the opening choice's picker (tests: a seeded random, or the fixed-order fake). */
  openingChoice?: OpeningChoiceHost;
  /** I-010 互动余额: the opening choice's soft cap (electron/inner-loop/opening-host.ts OpeningBudget). Omitted: exactly as before. */
  budget?: OpeningBudget;
  clock?: () => number;
  /** I-013 L1: the random source of the call rhythm (tests: seeded). Default Math.random. */
  random?: () => number;
  /** 设置「她主动找你说话」 (AppSettings.proactiveTalk). Omitted or unknown: 适中, exactly as before. */
  talk?: () => ProactiveTalk | undefined;
}

export interface InnerLoopHost {
  loop: InnerLoop;
  /** I-020 #10: who takes a mood cue (electron/main.ts's mood publish calls opening.claim). */
  opening: OpeningHost;
  presentation: VisionPresentationGuard;
  reminders: RestReminderStore | null;
  view(): InnerLoopView;
}

export function createInnerLoopHost(options: InnerLoopHostOptions): InnerLoopHost {
  const clock = options.clock ?? Date.now;
  const diagnostics = new InnerLoopDiagnostics({ enabled: options.developerMode, file: options.diagnosticsFile, changed: options.diagnosticsChanged });
  const live = () => options.setting() && options.expressions() && options.current();
  const presentation = new VisionPresentationGuard({ surface: options.surface, identity: options.presentationIdentity, eligible: live });
  const sources = (): InnerLoopContextSources => ({ ...options.context, now: clock, parameters: options.parameters,
    ...(options.userActivity ? { userActivity: () => userActivitySentence(options.userActivity!()) } : {}) });
  const reminders = options.restReminderFile ? new RestReminderStore(options.restReminderFile) : null;
  const loop = new InnerLoop({
    gate: options.gate, clock,
    // Read the reminder night early so the first night chance after launch is not lost to loading.
    enabled: () => { void reminders?.load(); return options.setting() && options.expressions(); },
    canStart: () => options.canExpress() && options.current(),
    current: live,
    scope: () => { const characterId = options.characterId(), gateScope = options.gateScope(); return characterId && gateScope ? { characterId, gateScope } : null; },
    parameters: options.parameters,
    quiet: () => innerLoopQuietAt(options.fatiguePhase(), innerLoopLocalMinute(options.context, clock())),
    prompt: (claim, allowSpeech, quiet, herLife, play, focus) => innerLoopPrompt(sources(), claim, allowSpeech, quiet, herLife, play, focus),
    play: options.play ? {
      eligible: (claim, quiet) => options.play!.eligible(claim.characterId, quiet.quiet),
      invited: claim => options.play!.invited(claim.characterId),
    } : undefined,
    herLife: options.herLife ? {
      offer: claim => options.herLife!.offer(claim.characterId),
      switch: (claim, activity) => { options.herLife!.switch(claim.characterId, activity); },
    } : undefined,
    decide: async (prompt, signal) => {
      try {
        const result = await (options.decide ?? decideWithClaude)(prompt, signal);
        try { options.report?.success(); } catch { /* Availability bookkeeping never changes a decision. */ }
        return result;
      } catch (error) {
        if (!signal.aborted) { try { options.report?.failure(error); } catch { /* Same. */ } }
        throw error;
      }
    },
    realize: options.realize, releaseSpeech: options.releaseSpeech,
    offer: options.offer, cancelOffer: options.cancelOffer,
    present: (message, signal) => presentation.present(message, signal),
    presentationCurrent: message => presentation.current(message),
    archive: options.archive,
    record: (entry, characterId) => {
      diagnostics.record(entry);
      try { options.journal?.(entry, characterId); } catch { /* Keeping a record never changes a decision. */ }
    },
    restReminder: reminders ? {
      lastInteractionAt: () => options.context.lastInteractionAt(),
      nightKey: now => innerLoopNightKey(now, innerLoopLocalMinute(options.context, now)),
      used: night => reminders.used(night),
      remember: night => reminders.remember(night),
    } : undefined,
    settled: () => options.settled?.(),
    // I-013 L1: varied spacing, stretched at night and while the user is away (existing signals only: the last interaction and the activity view).
    rhythm: {
      random: options.random ?? Math.random,
      awayMinutes: () => { const at = options.context.lastInteractionAt(); return typeof at === 'number' && Number.isFinite(at) ? Math.max(0, (clock() - at) / 60_000) : null; },
      userAway: () => options.userActivity?.()?.state === 'away',
      ...(options.talk ? { talk: () => proactiveTalk(options.talk!()) } : {}),
    },
  });
  // I-020 #10: what she says at a speech opportunity is hers to pick (electron/inner-loop/opening-host.ts).
  const opening = new OpeningHost({ loop, chooser: options.openingChoice, clock, ...(options.budget ? { budget: options.budget } : {}),
    innerOn: () => options.setting() && options.expressions(),
    play: options.play ? (characterId, quiet) => options.play!.eligible(characterId, quiet) : undefined,
    need: options.needReady ? characterId => options.needReady!(characterId) : undefined,
    busy: options.userActivity ? () => userIsBusy(options.userActivity!()) : undefined,
    releaseSpeech: (cue, characterId) => options.releaseSpeech({ id: cue.id, kind: 'speech', at: cue.at, characterId }),
    developerMode: options.developerMode, changed: options.diagnosticsChanged });
  return { loop, opening, presentation, reminders, view: () => {
    let enabled = true, developerMode = false, characterId = '';
    try { enabled = options.setting(); } catch { enabled = true; }
    try { developerMode = options.developerMode(); } catch { developerMode = false; }
    try { characterId = options.characterId(); } catch { characterId = ''; }
    // The opening "why" lines: developer mode only, memory only (never the 体验记录, never a file).
    return { enabled, developerMode, recent: developerMode ? diagnostics.recent() : [], opening: developerMode && characterId ? [...opening.recent(characterId)] : [] };
  } };
}
