import type { FatiguePhase } from '../../../shared/mood';
import type { HerLifeActivity, HerLifeSwitchOffer } from '../../../shared/stage';
import { innerLoopNightKey, type InnerLoopDiagnostic, type InnerLoopView } from '../../../shared/initiative/inner-loop';
import { RestReminderStore } from './rest-reminder-store';
import type { MoodParameters } from '../../../shared/foundation/mood';
import type { ProactiveSpeechLease, ProactiveSpeechOpportunity } from '../../../shared/brain';
import { proactiveTalk, type ProactiveTalk } from '../../../shared/behaviors/inner-rhythm/knobs';
import { VisionPresentationGuard, type VisionPresentationSurface } from '../../senses/vision-presentation-adapter';
import { innerLoopLocalMinute, innerLoopPrompt, innerLoopQuietAt, type InnerLoopContextSources } from './context';
import { InnerLoopDiagnostics } from './diagnostics';
import { InnerLoop, type InnerLoopClaim, type InnerLoopDependencies, type InnerLoopMessage } from './inner-loop';
import { decideWithClaude } from './model';
import { OpeningHost, type OpeningBudget, type OpeningHostOptions } from '../../brain';
import type { OpeningChoiceHost } from '../../../shared/brain';
import { userActivitySentence, userIsBusy } from '../../../shared/behaviors/user-activity/effects';
import { backSentence } from '../../../shared/behaviors/user-activity/presence';
import type { UserActivityView } from '../../../shared/senses';
import { interconnectTurnLine } from '../../brain';

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
  /** I-174 item 3: what keeps a line already offered (she is here, no message of yours under way); absent: current(). */
  holds?(): boolean;
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
  archive(message: InnerLoopMessage, owner?: string): Promise<void>;
  developerMode(): boolean;
  diagnosticsFile(): string | null;
  diagnosticsChanged(): void;
  /** 体验记录 (electron/memory/journal/sources.ts innerLoopInput): each decision in every mode; categories only, never the line she said. */
  journal?(entry: InnerLoopDiagnostic, characterId: string): void;
  /** Called when an opportunity ends, to release request-scoped leases (user profile context). */
  settled?(): void;
  decide?: InnerLoopDependencies['decide'];
  /**
   * Claude availability (electron/brain/chat-availability.ts): told after each model call. Our own timeout or a
   * cancellation is not reported (the signal was aborted on our side).
   */
  report?: { success(): void; failure(error: unknown): void };
  /** <profile>/inner-loop-state.json: the night of the last rest reminder. Omitted: no night reminder. */
  restReminderFile?: () => string | null;
  /** 她自己的生活 (electron/stage/her-life/host.ts): "换件事做" on motion opportunities. Omitted: no such option. */
  herLife?: {
    offer(characterId: string): HerLifeSwitchOffer | null;
    switch(characterId: string, activity: HerLifeActivity): boolean;
  };
  /** G1 猜拳 (electron/initiative/rps/host.ts): "邀请玩猜拳" on speech opportunities. Omitted: no such option. */
  play?: {
    eligible(characterId: string, quiet: boolean): boolean;
    invited(characterId: string): void;
  };
  /**
   * I-020 #10, look don't take (HerNeedsHost.hasSpeechChance): she has a small need she could speak about now. The opening choice
   * weighs it; only the inner loop's prompt (context.need) spends it. Omitted: never counted.
   */
  needReady?(characterId: string): boolean;
  /** I-006 第 1 步: whether the user is absorbed right now (electron/senses/user-activity.ts view). Leans the opening choice toward 这次不说 and adds one line to 【此刻】. Omitted: as before. */
  userActivity?: () => UserActivityView | null;
  /** I-020 #10: replaces the opening choice's picker (tests: a seeded random, or the fixed-order fake). */
  openingChoice?: OpeningChoiceHost;
  /**
   * I-050 她的文件夹 (electron/initiative/her-folder/keepsake.ts), optional: the opening choice gets a "给你留点东西" candidate. `peek` looks without
   * taking ('write' = she would leave a new keepsake, 'tell' = she holds one and would say a light line, null = neither now);
   * `write` starts the quiet writing for this cue (true = started); `line` is the written line for focus 'keepsake'; `counts` is
   * one counts-only line for the developer view. Omitted: no such candidate, exactly as before.
   */
  keepsake?: {
    peek(characterId: string): 'write' | 'tell' | null;
    write(characterId: string, cue: { readonly id: string; readonly at: number }): boolean;
    line(claim: Readonly<InnerLoopClaim>): string | null;
    counts?(characterId: string): string;
  };
  /**
   * I-086 她也照顾你 (electron/initiative/give/host.ts), optional: the opening choice gets a "递给你点东西" candidate. `peek` looks without taking (null:
   * nothing to hand over now; else the reasons from her hormones and mood values); `promptLine` is what she is about to hand over, for her
   * prompt (focus 'give'); `delivered` starts the stage once her line was shown. Omitted: no such candidate, exactly as before.
   */
  give?: {
    peek(characterId: string): { readonly leans: readonly { readonly text: string; readonly factor: number }[] } | null;
    promptLine(characterId: string): string;
    delivered(characterId: string, claimId: string, text: string): void;
  };
  /**
   * I-188 她认出的时刻 (electron/initiative/moments/host.ts): the moment a cue carries (focus 'moment'), its line for her prompt, and how the
   * opportunity ended. Omitted: the focus is refused, exactly as before.
   */
  moment?: { current(characterId: string): { quietOk: boolean; night?: string } | null; promptLine(characterId: string): string; done(claimId: string, delivered: boolean): void };
  /** I-010 互动余额: the opening choice's soft cap (electron/brain/opening-host.ts OpeningBudget). Omitted: exactly as before. */
  budget?: OpeningBudget;
  /** I-066 你现在方便吗 (electron/brain/opening-host.ts OpeningHostOptions.presence). Omitted: exactly as before. */
  presence?: Omit<NonNullable<OpeningHostOptions['presence']>, 'characterId' | 'personality'>;
  /** 松绑 (electron/initiative/impulse/host.ts): each opening-choice candidate's factor from her urge. Omitted: exactly as before. */
  leans?: OpeningHostOptions['leans'];
  /** I-066 体验记录: why a speech cue did not reach the inner loop, and what became of a held intent (closed categories only). */
  speechCueJournal?: OpeningHostOptions['journal'];
  clock?: () => number;
  /** I-013 L1: the random source of the call rhythm (tests: seeded). Default Math.random. */
  random?: () => number;
  /** 设置「她主动找你说话」 (AppSettings.proactiveTalk). Omitted or unknown: 适中, exactly as before. */
  talk?: () => ProactiveTalk | undefined;
  /** I-137: 三方互通 is on; 【此刻】 gets the one fact line (electron/brain/interconnect-line.ts). Omitted: no line, exactly as before. */
  interconnected?: () => boolean;
}

export interface InnerLoopHost {
  loop: InnerLoop;
  /** I-020 #10: who takes a mood cue (electron/main.ts's mood publish calls opening.claim). */
  opening: OpeningHost;
  presentation: VisionPresentationGuard;
  reminders: RestReminderStore | null;
  /** I-188: her moments (electron/initiative/moments/host.ts), set by their wiring; the 1-second clock ticks them beside the opening choice. */
  moments?: { tick(): void } | null;
  view(): InnerLoopView;
}

export function createInnerLoopHost(options: InnerLoopHostOptions): InnerLoopHost {
  const clock = options.clock ?? Date.now;
  const diagnostics = new InnerLoopDiagnostics({ enabled: options.developerMode, file: options.diagnosticsFile, changed: options.diagnosticsChanged });
  const live = () => options.setting() && options.expressions() && options.current();
  const holds = () => options.setting() && options.expressions() && (options.holds ? options.holds() : options.current());
  const presentation = new VisionPresentationGuard({ surface: options.surface, identity: options.presentationIdentity, eligible: holds }); // I-174: a line out is kept through a touch
  // I-066: 【此刻】 also says when the user just came back from a long absence (only the minutes; '' otherwise).
  const back = () => { try { return options.presence ? backSentence(options.presence.view()) : ''; } catch { return ''; } };
  const sources = (): InnerLoopContextSources => ({ ...options.context, now: clock, parameters: options.parameters,
    ...(options.give ? { give: (characterId: string) => options.give!.promptLine(characterId) } : {}),
    ...(options.moment ? { moment: (characterId: string) => options.moment!.promptLine(characterId) } : {}),
    // I-137: the 三方互通 fact rides on the same 【此刻】 line (a fact, not something to bring up).
    ...(options.userActivity || options.presence || options.interconnected ? { userActivity: () => [options.userActivity ? userActivitySentence(options.userActivity()) : '', back(),
      options.interconnected ? interconnectTurnLine(options.interconnected) : ''].filter(Boolean).join('') } : {}) });
  const reminders = options.restReminderFile ? new RestReminderStore(options.restReminderFile) : null;
  const loop = new InnerLoop({
    gate: options.gate, clock,
    // Read the reminder night early so the first night chance after launch is not lost to loading.
    enabled: () => { void reminders?.load(); return options.setting() && options.expressions(); },
    canStart: () => options.canExpress() && options.current(),
    current: live, holds,
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
    ...(options.keepsake ? { keepsake: { line: (claim: Readonly<InnerLoopClaim>) => options.keepsake!.line(claim) } } : {}),
    ...(options.give ? { give: { delivered: (claim: Readonly<InnerLoopClaim>, text: string) => options.give!.delivered(claim.characterId, claim.id, text) } } : {}),
    ...(options.moment ? { moment: { current: (characterId: string) => options.moment!.current(characterId), done: (claimId: string, delivered: boolean) => options.moment!.done(claimId, delivered) } } : {}),
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
  // I-020 #10: what she says at a speech opportunity is hers to pick (electron/brain/opening-host.ts).
  const opening = new OpeningHost({ loop, chooser: options.openingChoice, clock, ...(options.budget ? { budget: options.budget } : {}),
    innerOn: () => options.setting() && options.expressions(),
    play: options.play ? (characterId, quiet) => options.play!.eligible(characterId, quiet) : undefined,
    need: options.needReady ? characterId => options.needReady!(characterId) : undefined,
    busy: options.userActivity ? () => userIsBusy(options.userActivity!()) : undefined,
    keepsake: options.keepsake,
    ...(options.give ? { give: { peek: (characterId: string) => options.give!.peek(characterId) } } : {}),
    ...(options.presence ? { presence: { ...options.presence, characterId: options.characterId, personality: () => options.parameters().weights } } : {}),
    ...(options.speechCueJournal ? { journal: options.speechCueJournal } : {}),
    ...(options.leans ? { leans: options.leans } : {}),
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
