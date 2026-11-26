import { buildCompanionPersona } from './conversation-context';
import type { CardLanguage } from '../../shared/foundation/character-card';
import { recallLateCheck, withMoodNow } from '../memory';
import { DraftFillLines } from './draft-fill';
import { CareAskedTracker } from '../../shared/senses';
import { createHash, randomUUID } from 'node:crypto';
import type { ProviderConfig } from '../../shared/foundation/settings';
import type { StreamEvent } from '../../shared/brain/stream-event';
import { memoryRecallMatch, type MemoryScope, type MemoryTurnHandle, type RecentChat } from '../../shared/memory';
import { MoodHost } from '../mood';
import { MemoryStore } from '../memory';
import { MoodReplyProtocol, type HerFolderOption, type SettingProposalOption } from '../mood';
import type { OpeningMode } from './reply-opening';
import { asksForEnglish, chatLooksChinese, draftFilterLine, speakersFromPersona } from './reply-draft-guard';
import { appendBounded } from './reply-latency';
import type { MoodView } from '../../shared/mood';
import { validateMoodParameters, type MoodParameters } from '../../shared/foundation/mood';
import type { SpeechMood } from '../mood';
import { VoiceCompanionGroup } from '../voice';
import { EmphasisStream } from '../../shared/voice';
import { UserStateDiagnostics, UserStateStore } from '../senses';
import { DayReadStore } from '../memory';
import { RelationshipHost } from '../memory';
import { HerLifeHost } from '../stage';
import { HerNeedsHost, type HerNeedsHostOptions } from '../mood';
import { InteractionBudgetHost, type InteractionBudgetHostOptions } from '../initiative';
import type { MoodInteractionNote } from '../mood';
import type { BudgetCreditKind } from '../../shared/initiative';
import { innerLoopQuiet } from '../../shared/initiative';
import { PoseReactionHost, type PoseReactionHostOptions, type PoseSimulation, type PoseSimulationResult } from '../mood';
import type { PoseCharacter } from '../../shared/mood';
import { localDateKey } from '../memory';
import { SYSTEM_FATIGUE_CLOCK } from '../mood';
import type { HerLifeActivity, HerLifeSwitchOffer, HerLifeWatchKind } from '../../shared/stage';
import { scanDanceRequest } from '../../shared/actions';
import { herLifeBusy } from '../../shared/behaviors/user-activity/effects';
import type { UserActivityView } from '../../shared/senses';
import { REALER_EMOTIONS_CHAT_TEXT, REALER_EMOTIONS_SESSION_TAG } from '../../shared/mood';
import type { RelationshipOpening } from '../memory';
import { BlushJournal, blushMomentInput, blushStageInput, draftFilterInput, fatiguePhaseInput, replyCheckInput } from '../memory/journal/extras'; // direct: through ./memory (the index) this would close an import cycle (docs/claude/2026-11-16-overhaul-parts-2.md)
import { MoodJournal, herLifeInput, herNeedInput, herNeedReliefInput, poseInput, relationshipInput, userStateInput, type JournalSink } from '../memory';
import path from 'node:path';
import { speechBeatsFor, type SpeechBeatsHost } from './speech-beats/host';
import { isLookOffer } from '../../shared/senses';
import { chatActionAllowed, type ChatActionWord } from '../../shared/brain/chat-actions';
import { moodNowCompact } from '../../shared/foundation/mood-guide';
import { explicitWakeRequest } from '../../shared/mood';
import { SPEAK_ONLY_REPLY_INSTRUCTION, type SpeakOnlyTurnKind } from './speak-only/rules';
import { SpeakOnlyJudge } from './speak-only/judge-host';
import type { SpeakOnlyJudgeOptions, SpeakOnlyOutcome } from './speak-only/judge-host';
import { tailBookInput } from './speak-only/book-journal';
import { speakOnlyJudgment } from './speak-only/judgment';
import { chatSettingsSystemText, mentionsSettings } from './chat-settings';
import { getPromptSwitches } from '../../shared/brain/prompt-switches';
import { todayLines } from '../mood';
import { REALER_EMOTIONS_RELAXED, RHYTHM_LINE, VISITOR_MARK_RELAXED, i139Text, type I139Language } from '../../shared/foundation/i139-texts';
import { boundaryKinds, routedWhyBlock } from '../../shared/brain/prompt-route';
import { ContextLock } from './context-lock';
import { TurnOwners, switchStops, type OwnersStopped } from './turn-owner/owners';
import { StageMoods, type LiveMood } from '../mood';
import { StreamGapProbe, streamGapsInput } from './stream-gaps';

/** I-117: the safety host as the companion uses it (electron/safety/wiring.ts SafetyChatPort). */
export interface CompanionSafetyPort {
  turn(id: string, text: string, realer: boolean): string;
  /** Reads a message without taking any line (a spoken sentence of a voice group: its persona stays as it is). */
  read(id: string, text: string): void;
}

import { memoryProviderScope } from '../foundation/memory-provider-scope'; // foundation since the wiring rewrite step 2
export { memoryProviderScope };

export type { CompanionTurn } from './companion-turn'; // I-209 step 2: the turn's shape lives beside it (this file only shrinks)
import type { CompanionTurn } from './companion-turn';

/**
 * F6 "更真实的情绪" (shared/mood/realer-emotions.ts): while the card has it on, its paragraph joins the block a conversation opens with
 * (after the relationship lines), and the session tag changes, so an open session restarts when the switch turns. Off: the
 * opening is returned unchanged, so every prompt is byte for byte what it is without the switch.
 */
// I-139 (`relaxed`: the switch and the card's language): the paragraph points at the care text instead of the old numbered rule.
export function withRealerEmotions(opening: RelationshipOpening | null, on: boolean, relaxed?: { language?: I139Language | null } | null): RelationshipOpening | null {
  if (!on) return opening;
  return {
    text: [opening?.text ?? '', relaxed ? i139Text(REALER_EMOTIONS_RELAXED, relaxed.language) : REALER_EMOTIONS_CHAT_TEXT].filter(Boolean).join('\n\n'),
    tag: opening ? `${opening.tag}|${REALER_EMOTIONS_SESSION_TAG}` : REALER_EMOTIONS_SESSION_TAG,
    memes: opening?.memes ?? true,
  };
}

/** P1 第二阶段: what her card, mood and body bring to a pose decision (shared/mood/pose-reactions.ts). */
export function poseCharacter(view: MoodView): PoseCharacter {
  return { weights: view.parameters.weights, mood: view.snapshot.primary, fatigue: view.fatigue ? { phase: view.fatigue.phase, F: view.fatigue.F } : null,
    motionIntervalMs: view.parameters.frequency.motionIntervalMs, posture: view.snapshot.intensity.posture, chatBoredomRelief: view.parameters.interaction.chatBoredomRelief };
}

/**
 * I-010 互动余额: what one accepted interaction counts as. A message that came while her own line was unanswered answers her
 * (it counts more); the chat event a finished 猜拳 match sends (topic 'rps', electron/initiative/rps/host.ts rpsMoodEvent) is a game.
 */
export function budgetCreditKind(note: Pick<MoodInteractionNote, 'type' | 'topic' | 'answered'>): BudgetCreditKind {
  if (note.type === 'rua') return 'touch';
  if (note.type === 'food') return 'food';
  return note.topic === 'rps' ? 'game' : note.answered ? 'answer' : 'message';
}

const scopeKey = (scope: MemoryScope) => JSON.stringify([scope.characterId, scope.providerScope]);
const sameScope = (a: MemoryScope | null, b: MemoryScope) => a?.characterId === b.characterId && a.providerScope === b.providerScope;

/** Private state and text persistence, kept outside providers and renderer permissions. */
/** Skeleton step 5: what the companion needs from the small-action host (electron/brain/chat-actions-host.ts). */
export interface ChatActionPort {
  offered(): readonly ChatActionWord[]; request(word: ChatActionWord): void; cancel(): void; refresh?(): unknown;
  /** 体验记录: her tail's pick that never became a cue ('held' by her mood) or no pick at all (null, null). */
  noted?(word: ChatActionWord | null, answer: 'held' | null): void;
}

export class CompanionService {
  readonly mood: MoodHost;
  readonly memory: MemoryStore;
  /** 边说边演: the grey lines of replies that were only a performance (recentChat reads them by turn id). */
  private readonly speechBeats: SpeechBeatsHost;
  /** Her short-lived read of how the user is now: memory only, per character, fades (electron/senses/user-state.ts). */
  readonly userState: UserStateStore;
  /** I-089 item 5: the day's gentle read of the user from signals already on (voice tone, her look's tag, the hour, message rhythm): memory only, one private line. */
  readonly dayRead = new DayReadStore();
  /** 熟悉度 (docs/claude/2026-11-02-familiarity-plan.md): per character, survives a change of chat model, never exported with a card. */
  readonly relationship: RelationshipHost;
  /** 她自己的生活 (docs/claude/2026-11-02-her-life.md): per character, `<profile>/her-life.json`. */
  readonly herLife: HerLifeHost;
  /** 她也会需要你 (docs/claude/2026-11-03-she-needs-you.md): per character, `<profile>/her-needs.json` (only today's counts). */
  readonly herNeeds: HerNeedsHost;
  /**
   * I-010 互动余额 (docs/claude/2026-11-05-i010-interaction-budget.md): how much room she has, now, for the things she does on her own,
   * from your recent interactions and her character. Memory only, per character.
   */
  readonly budget: InteractionBudgetHost;
  /** P1 第二阶段 (docs/claude/2026-11-03-pose-sensing-stage2.md): her reactions to the local pose signals; memory only. */
  readonly pose: PoseReactionHost;
  private relationshipOpened = '';
  /** 外号 (electron/memory/relationship/nickname-route.ts): called once a reply is done; reads haiku's verdict for that message. Null: none. */
  private nicknameRoute: ((requestId: string, characterId: string, userText?: string) => void) | null = null;
  setNicknameRoute(route: ((requestId: string, characterId: string, userText?: string) => void) | null): void { this.nicknameRoute = route; }
  private realerSource: (characterId: string) => boolean = () => false;
  /** 体验记录 (electron/memory/journal/): the mood side of the journal; null when no journal was given (tests). */
  private readonly moodJournal: MoodJournal | null;
  private scope: MemoryScope | null = null;
  private requestedScope: MemoryScope | null = null;
  private requestedContextKey = '';
  private conversation: string = randomUUID();
  /**
   * C2: per scope, the conversation the user explicitly began last in this run (新对话, or a deleted record reset the
   * window). Switching back to her carries on that one, never an older one it replaced.
   */
  private readonly freshConversation = new Map<string, string>();
  /** Switch lock (electron/brain/context-lock.ts): every context change bumps it at once and settles it however its step ends. */
  private readonly lock = new ContextLock();
  /** I-209 step 2 (electron/brain/turn-owner/): per character, whether her turns are still current; the seats of the others on stage. */
  private readonly owners = new TurnOwners();
  /** I-209 step 2: a live mood for everyone on stage (electron/mood/stage-moods.ts). */
  readonly stageMoods: StageMoods;
  private recalling = new Map<string, string>();
  private readonly activeTurns = new Set<Pick<CompanionTurn, 'id' | 'scope' | 'finish'>>();
  private operations: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;
  private readonly contextListeners = new Set<() => void>();
  /** Developer mode only: one count line per reply the draft filter cut something from (reply-draft-guard.ts draftFilterLine). */
  private readonly draftFilterLog: string;

  /** `herNeeds`: a clock, a random source or a replacement trigger for 她也会需要你 (tests and the T-106 swap); the app passes none. */
  constructor(directory: string, changed: (view: MoodView) => void, options: { herNeeds?: Pick<HerNeedsHostOptions, 'clock' | 'random' | 'trigger' | 'limits' | 'balance'>; journal?: JournalSink;
    pose?: Pick<PoseReactionHostOptions, 'clock' | 'random' | 'id' | 'policy'>; budget?: InteractionBudgetHostOptions } = {}) {
    const journal = options.journal ?? null;
    this.draftFilterLog = path.join(directory, 'dev', 'reply-draft-filter.jsonl');
    this.moodJournal = journal ? new MoodJournal(journal) : null;
    this.mood = new MoodHost(directory, view => { changed(view); this.moodJournal?.view(view); });
    if (this.moodJournal) { const moodJournal = this.moodJournal; this.mood.setJournalObserver(event => moodJournal.event(event)); }
    this.stageMoods = new StageMoods(this.mood);
    const note = (input: Parameters<JournalSink['record']>[0]) => { try { const who = (input as { characterId?: unknown }).characterId; journal?.record(withMoodNow(input, (typeof who === 'string' && this.mood.liveOf(who)) || this.mood.get())); } catch { /* Keeping a record never blocks her (I-209 step 2: her own mood in her line). */ } };
    this.journalNote = note;
    if (journal) { // 体验记录 第一批新记录项: a blush moment and a sleepiness phase change (electron/memory/journal/extras.ts)
      const blushJournal = this.blushJournal = new BlushJournal(journal);
      this.mood.setBlushJournal(moment => blushJournal.moment(blushMomentInput(moment)));
      this.mood.setFatigueJournal(change => note(fatiguePhaseInput(change)));
    }
    this.memory = new MemoryStore(directory);
    this.speechBeats = speechBeatsFor(directory);
    this.speechBeats.languageFrom(() => this.language()); // the cut marker of a cut reply reads in her chat's language
    // The only file this ever writes is the developer-mode diagnostic line (time, state, confidence).
    const diagnostics = new UserStateDiagnostics({ enabled: () => this.mood.isDeveloperMode(), file: () => path.join(directory, 'dev', 'user-state.jsonl') });
    this.userState = new UserStateStore({ changed: id => this.mood.userStateChanged(id), record: (entry, id) => { diagnostics.record(entry); note(userStateInput(id, entry)); } });
    this.mood.setUserStateSource(id => this.userState.view(id));
    this.relationship = new RelationshipHost({ directory, developerMode: () => this.mood.isDeveloperMode(), changed: id => this.mood.relationshipChanged(id),
      journal: (id, entry) => note(relationshipInput(id, entry)) });
    this.mood.setRelationshipSource(id => this.relationship.view(id));
    this.herLife = new HerLifeHost({ file: () => path.join(directory, 'her-life.json'), diagnosticsFile: () => path.join(directory, 'dev', 'her-life.jsonl'),
      developerMode: () => this.mood.isDeveloperMode(), changed: id => this.mood.herLifeChanged(id), journal: (id, entry, test) => note(herLifeInput(id, entry, test)),
      // P1 第二阶段: her own small moments while the user was at the computer join her own-life material for the diary.
      moments: (id, start, end) => this.pose?.diaryLine(id, start, end) ?? '' });
    this.mood.setHerLifeSource(id => this.herLife.view(id));
    // I-010 互动余额: every real interaction the mood model accepts is counted here once; her own initiatives ask it for room.
    this.budget = new InteractionBudgetHost({ ...(options.herNeeds?.clock ? { clock: options.herNeeds.clock } : {}), ...options.budget });
    this.mood.setBudgetObserver((id, note) => { this.budget.credit(id, budgetCreditKind(note), note.contact ? `contact:${note.contact}` : note.id, note.at); });
    this.mood.setBudgetSource(id => this.budget.view(id));
    this.herNeeds = new HerNeedsHost({ file: () => path.join(directory, 'her-needs.json'), diagnosticsFile: () => path.join(directory, 'dev', 'her-needs.jsonl'),
      developerMode: () => this.mood.isDeveloperMode(), changed: id => this.mood.herNeedChanged(id), lift: (id, lift) => this.mood.lift(lift, id),
      balance: id => this.budget.room(id, 'need').factor, spent: (id, need, at) => { this.budget.spend(id, 'need', `need:${need}:${at}`); }, ...options.herNeeds,
      journal: (id, event) => note(event.type === 'relieved' ? herNeedReliefInput(id, event.relief) : herNeedInput(id, event)) });
    this.mood.setHerNeedSource(id => this.herNeeds.view(id));
    this.pose = new PoseReactionHost({ changed: id => this.mood.poseChanged(id), presence: (id, relief, eventId, awayMs) => { this.mood.presence({ id: eventId, relief }, id); this.mood.moments.arrive(id, awayMs ?? null); },
      journal: (id, event, kind) => note(poseInput(id, event, kind)), interactionsSince: (id, at) => this.budget.interactionsSince(id, at), ...options.pose });
    this.mood.setPoseSource(id => this.pose.view(id));
    this.mood.setInteractionObserver((id, kind, amount) => { void this.relationship.noteTouch(id); this.herLife.interact(id); this.herNeeds.interact(id, kind, amount); });
  }
  /** F6: whether the card of a character has "更真实的情绪" on (main.ts reads the card store; off when it cannot tell). */
  setRealerEmotionsSource(source: (characterId: string) => boolean): void { this.realerSource = source; }
  /** I-117: reads each message for danger signals (nothing kept) and gives this turn's private safety lines (electron/safety/wiring.ts). */
  setSafety(port: CompanionSafetyPort | null): void { this.safety = port; }
  private safety: CompanionSafetyPort | null = null;
  private safetyLines(id: string, text: string, characterId: string): string {
    try { return this.safety?.turn(id, text, this.realerEmotions(characterId)) ?? ''; } catch { return ''; }
  }
  /** I-006 第 1 步: whether the user is absorbed (electron/senses/user-activity.ts). The mood host slows her boredom by it; her own life weighs by it. Memory only. */
  setUserActivitySource(source: () => UserActivityView | null): void { this.userActivityFor = source; this.mood.setUserActivitySource(source); }
  private userActivityFor: () => UserActivityView | null = () => null;
  /** I-006 第 3 步: what the user is watching or playing on the shared screen (electron/senses/watch-along.ts; null with sharing off). She follows it in her own life. Memory only. */
  setWatchSource(source: () => HerLifeWatchKind | null): void { this.watchFor = source; }
  private watchFor: () => HerLifeWatchKind | null = () => null;
  /**
   * Skeleton step 5 (electron/brain/chat-actions-host.ts): the small actions this model can do now (offered in the tail), and where her pick
   * goes (one cue; the stage decides). A new message drops a pick still waiting for her to finish speaking. Absent: nothing offered.
   */
  setChatActions(port: ChatActionPort | null): void { this.chatActions = port; }
  /** I-111: turns the user's line into a vector for recall by meaning; it is started at once and waited for (a few ms) just before the recall. Absent: nothing. */
  setSemanticPrefetch(prefetch: ((text: string) => Promise<void>) | null): void { this.semanticPrefetch = prefetch; }
  private semanticPrefetch: ((text: string) => Promise<void>) | null = null;
  /** The tail's one line of her numbers now and her card's baselines (shared/foundation/mood-guide.ts; docs/claude/2026-11-11-mood-batch1.md); '' when unknown. */
  /** Evaluation only (scripts/lib/mood-guide-ab.ts, the first-token A/B): the tail's mood sentences as before the shared guide. The app never sets it. */
  setTailGuideBefore(value: boolean): void { this.tailGuideBefore = value === true; }
  private tailGuideBefore = false;
  /**
   * I-115 A: where the situation text gets one or two of today's chat notes (the notebook's own title and summary, from electron/memory/memory-notes).
   * The host gives the reader (electron/main.ts); without one, or when it fails, the situation simply has no "today" line.
   */
  setTodayNotes(read: ((scope: MemoryScope, start: number, end: number) => readonly { title: string; summary: string }[]) | null): void { this.todayNotes = read; }
  private todayNotes: ((scope: MemoryScope, start: number, end: number) => readonly { title: string; summary: string }[]) | null = null;
  private lastTodayLines: string[] = [];
  private todayForSituation(scope: MemoryScope): string[] {
    if (!this.todayNotes) return [];
    try {
      const now = Date.now(), day = new Date(now); day.setHours(0, 0, 0, 0);
      const lines = todayLines(this.todayNotes(scope, day.getTime(), now + 1), Math.random, this.lastTodayLines);
      this.lastTodayLines = lines;
      return lines;
    } catch { return []; }
  }
  private tailMoodNow(characterId?: string): string {
    try { const view = characterId ? this.mood.liveOf(characterId) : this.mood.get(); return view?.characterId ? moodNowCompact(view.snapshot.values, view.parameters.baseline) : ''; } catch { return ''; }
  }
  /**
   * F4: with this on, a reply the draft filter left empty gets one short line of her own (electron/brain/draft-fill.ts) instead of failing
   * the chat. Off by default (the host turns it on), so the older failed-reply path stays what the tests of it cover.
   */
  setDraftFill(on: boolean): void { this.draftFill = on ? (this.draftFill ?? new DraftFillLines()) : null; }
  private draftFill: DraftFillLines | null = null;
  /**
   * I-046: every chat turn (typed and voice) asks for an opening marker, and only what she writes after it is shown, read aloud and
   * archived (electron/brain/reply-opening.ts). Off by default (the host turns it on with REPLY_OPENING_ENABLED), so the tests of the
   * protocol without it keep what they cover.
   */
  /** I-071: her language now (the host's chat language setting); English mode adds one line to the session opening and is judged as English chat by the draft guard. */
  setLanguageSource(source: (characterId?: string) => CardLanguage): void { this.languageSource = source; this.relationship.setLanguageSource(() => source()); }
  private languageSource: (characterId?: string) => CardLanguage = () => 'zh-CN';
  /** I-209 step 2: a turn's own character's card language (none: the desktop companion's). */
  private language(characterId?: string): CardLanguage { try { return this.languageSource(characterId); } catch { return 'zh-CN'; } }
  setReplyOpening(on: boolean | OpeningMode): void { this.replyOpening = on === true ? 'turn' : on; }
  /**
   * I-098 speak-only (electron/brain/speak-only/rules.ts): on with the judge's call, off with null (the default: every prompt and every mood
   * write as before). Typed chat only; a voice group keeps its tail.
   */
  setSpeakOnly(options: SpeakOnlyJudgeOptions | null): void { this.speakOnlyJudge?.dispose(); this.speakOnlyJudge = options ? new SpeakOnlyJudge(options) : null; }
  private speakOnlyJudge: SpeakOnlyJudge | null = null;
  private replyOpening: OpeningMode | false = false;
  /** I-017: the kinds of care she asked in each conversation's current stretch (categories only, memory only). */
  private readonly careAsked = new CareAskedTracker();
  private chatActions: ChatActionPort | null = null;
  private journalNote: ((input: Parameters<JournalSink['record']>[0]) => void) | null = null;
  private blushJournal: BlushJournal | null = null;
  /** The companion window's answer to a new blush cue (could the stage show it?); the experience journal only. */
  noteBlushStage(stage: unknown): void {
    try { const id = this.mood.get().characterId; if (id) this.blushJournal?.moment(blushStageInput(id, stage)); } catch { /* never blocks her */ }
  }
  /** I-006 第 3 步: chats and interactions of the past hour (the interaction budget's own count), which raise the hourly count of browser looks. 0 when unknown. */
  interactionsLastHour(now = Date.now()): number {
    try { const id = this.mood.get().characterId; return id ? this.budget.interactionsSince(id, now - 3_600_000) : 0; } catch { return 0; }
  }
  private realerEmotions(characterId: string): boolean {
    try { return this.realerSource(characterId) === true; } catch { return false; }
  }
  async load(): Promise<void> {
    // MoodHost preserves an unreadable source and exposes storageError while
    // blocking saves. Text memory can still work with an in-memory mood profile.
    await this.mood.load().catch(() => {});
    await this.herLife.load();
    await this.herNeeds.load();
    await this.memory.load();
  }
  /** 她自己的生活: the existing one-second mood tick (after MoodHost.tick), with the same canExpress gate. */
  herLifeTick(canExpress: boolean, now = Date.now()): void {
    const view = this.mood.get();
    if (!view.characterId) return;
    // I-010: the budget hears the card's tendencies and whether it is her night (it never reads the mood back itself).
    this.budget.observe(view.characterId, { weights: view.parameters.weights,
      night: innerLoopQuiet({ phase: view.fatigue?.phase ?? null, localMinute: SYSTEM_FATIGUE_CLOCK.localMinute(now) }).night });
    this.herLife.tick(view.characterId, { now, expressions: view.expressions, canExpress, phase: view.snapshot.phase,
      lastInteractionAt: view.snapshot.lastInteractionAt, fatigue: view.fatigue?.phase, parameters: view.parameters,
      mood: view.snapshot.primary, localMinute: SYSTEM_FATIGUE_CLOCK.localMinute(now),
      ...(() => { try { const busy = herLifeBusy(this.userActivityFor()); return busy ? { busy } : {}; } catch { return {}; } })(),
      ...(() => { try { const watch = this.watchFor(); return watch ? { watch } : {}; } catch { return {}; } })() });
    // 她也会需要你: the same tick and the same canExpress gate (docs/claude/2026-11-03-she-needs-you.md).
    this.herNeeds.tick(view.characterId, { now, day: localDateKey(now), expressions: view.expressions, canExpress, phase: view.snapshot.phase,
      lastInteractionAt: view.snapshot.lastInteractionAt, fatigue: view.fatigue?.phase, fatigueF: view.fatigue?.F, longing: view.snapshot.longing, boredom: view.snapshot.boredom, mood: view.snapshot.primary,
      channels: view.snapshot.values, parameters: view.parameters, localMinute: SYSTEM_FATIGUE_CLOCK.localMinute(now) });
    // P1 第二阶段: the same tick and gate for her reactions to the local pose signals (her own stretch, staleness, the view).
    // I-006 第 2 步: and the user's breather (the user-activity state; 说不准 while the switch is off).
    let activity: UserActivityView | null = null;
    try { activity = this.userActivityFor(); } catch { activity = null; }
    this.pose.tick(view.characterId, { now, expressions: view.expressions, canExpress, character: poseCharacter(view), activity });
  }
  /** Developer test command ("测试：我打了个哈欠" …): as if local sensing saw it (electron/mood/pose-reactions/host.ts simulate). */
  poseSimulate(kind: PoseSimulation, now = Date.now()): PoseSimulationResult {
    let view: MoodView;
    try { view = this.mood.get(); } catch { return 'no-character'; }
    if (!view.characterId) return 'no-character';
    if (!view.expressions) return 'expressions-off';
    this.pose.tick(view.characterId, { now, expressions: view.expressions, canExpress: true, character: poseCharacter(view) });
    return this.pose.simulate(kind, now);
  }
  /**
   * The user is typing to her (the chat box of either window; pretrial issue 6). Like a touch, it lifts her out of her own
   * thing at once: she looks up, and the message being typed hears what she was doing. Nothing else counts it.
   */
  noteTyping(now = Date.now()): void {
    let characterId: string | null = null;
    try { characterId = this.mood.get().characterId; } catch { characterId = null; } // Before any character is active.
    if (characterId) this.herLife.interact(characterId, now);
  }
  /** "换件事做" for the inner loop: what she may switch to now (the host's own gates), or null. */
  herLifeOffer(characterId: string, canExpress: boolean, now = Date.now()): HerLifeSwitchOffer | null {
    const view = this.mood.get();
    if (view.characterId !== characterId) return null;
    return this.herLife.offer(characterId, { now, expressions: view.expressions, canExpress, phase: view.snapshot.phase,
      fatigue: view.fatigue?.phase, parameters: view.parameters });
  }
  herLifeSwitch(characterId: string, activity: HerLifeActivity, canExpress: boolean, now = Date.now()): boolean {
    const view = this.mood.get();
    if (view.characterId !== characterId) return false;
    return this.herLife.switchTo(characterId, activity, { now, expressions: view.expressions, canExpress, phase: view.snapshot.phase,
      fatigue: view.fatigue?.phase, parameters: view.parameters });
  }
  /**
   * Developer test command ("测试：发呆", electron/safety/test-commands/): start one of her own states now; `null` = she picks by her
   * own rules. 'expressions-off': with "自动表现" paused she stays where she is, so nothing would show.
   */
  herLifeStartNow(activity: HerLifeActivity | null, now = Date.now()): { ok: true; activity: HerLifeActivity } | { ok: false; reason: 'no-character' | 'expressions-off' } {
    let view: MoodView;
    try { view = this.mood.get(); } catch { return { ok: false, reason: 'no-character' }; } // Before any character is active there is no mood yet.
    if (!view.characterId) return { ok: false, reason: 'no-character' };
    if (!view.expressions) return { ok: false, reason: 'expressions-off' };
    const chosen = this.herLife.startNow(view.characterId, activity, { parameters: view.parameters, mood: view.snapshot.primary,
      localMinute: SYSTEM_FATIGUE_CLOCK.localMinute(now) });
    return chosen ? { ok: true, activity: chosen } : { ok: false, reason: 'no-character' };
  }
  currentScope(): MemoryScope {
    if (!this.scope) throw new Error('角色记忆尚未就绪。');
    if (this.lock.switching) throw new Error('角色或对话正在切换，请稍后再试。');
    return { ...this.scope };
  }
  /** Opaque, runtime-only voice authority; a new conversation cannot borrow its predecessor. */
  /** I-040: the conversation now (a new one starts on "new conversation" and on a character switch). */
  get conversationId(): string { return this.conversation; }
  currentSpeechScope(): string {
    const scope = this.currentScope();
    return createHash('sha256').update(JSON.stringify([scopeKey(scope), this.conversation, this.lock.generation])).digest('hex');
  }
  /**
   * I-209 step 2 (docs/claude/2026-11-24-i209-step2.md): whose turn this is. None, or the desktop companion's: today's scope and conversation
   * (throws while switching). Someone else on the full-screen stage: her seat. Anyone else is not here to answer.
   */
  private turnSeat(characterId?: string): { scope: MemoryScope; conversationId: string; own: boolean; current: () => boolean } {
    const companion = this.currentScope(), own = !characterId || characterId === companion.characterId;
    const seat = own ? null : this.owners.seat(characterId!);
    if (!own && !seat) throw new Error('她不在台上，这一轮不能由她来回。');
    const scope = seat ? { characterId: seat.characterId, providerScope: seat.providerScope } : companion;
    const conversationId = seat ? seat.conversationId : this.conversation, generation = this.owners.generation(scope.characterId);
    return { scope, conversationId, own, current: () => this.owners.current(scope.characterId, generation) && this.conversationOf(scope.characterId) === conversationId };
  }
  /** The conversation `characterId` is in now (the desktop companion's, or her seat's on stage); null when she is neither. */
  conversationOf(characterId: string): string | null {
    return this.scope?.characterId === characterId ? this.conversation : this.owners.seat(characterId)?.conversationId ?? null;
  }
  /** The scope a turn of `characterId` belongs to (none: the companion's; throws while switching or when she is not on stage). */
  ownerScope(characterId?: string): MemoryScope { return this.turnSeat(characterId).scope; }
  /** What a turn of `characterId` is accepted under: the companion's currentSpeechScope, or her seat's scope, conversation and generation. */
  speechScopeOf(characterId?: string): string {
    const seat = this.turnSeat(characterId);
    return seat.own ? this.currentSpeechScope()
      : createHash('sha256').update(JSON.stringify([scopeKey(seat.scope), seat.conversationId, 'seat', this.owners.generation(seat.scope.characterId)])).digest('hex');
  }
  /**
   * Who is on the full-screen stage besides the desktop companion (step 1's presence; [] when she is not out). A newcomer gets her own
   * conversation and live mood; one who left has her turns stopped and her conversation sealed. Never stops anyone else's turn.
   */
  stage(ids: readonly string[]): void {
    const scope = this.requestedScope ?? this.scope;
    if (!scope) return;
    const { left } = this.owners.present(ids, scope.characterId, scope.providerScope, id => this.resumedConversation({ characterId: id, providerScope: scope.providerScope }));
    this.stageMoods.set(this.owners.ids());
    if (!left.length) return;
    const halted = this.stopActiveTurns(left.map(seat => seat.characterId));
    for (const seat of left) void this.serialize(async () => { await halted; await this.memory.seal({ characterId: seat.characterId, providerScope: seat.providerScope }); }).catch(() => {});
  }
  /** Who is on stage besides the desktop companion. */
  onStage(): string[] { return this.owners.ids(); }
  /** Her live mood (the active one's, or someone else's on stage); null without one. */
  moodOf(characterId: string): LiveMood | null { return this.stageMoods.view(characterId); }
  private primaryOf(characterId: string): SpeechMood['primary'] { return (this.mood.liveOf(characterId) ?? this.mood.get()).snapshot.primary; }
  /**
   * Called synchronously whenever the accepted context is invalidated: a new
   * conversation, a deleted chat record, or a different character, provider
   * or persona. Listener errors never block the transition.
   */
  onContextChange(listener: () => void): () => void {
    this.contextListeners.add(listener);
    return () => { this.contextListeners.delete(listener); };
  }
  private contextChanged(): void {
    try { this.relationship.dropPendingNickname(); } catch { /* never blocks a transition */ }
    for (const listener of [...this.contextListeners]) { try { listener(); } catch { /* Never blocks a transition. */ } }
  }
  /** A bounded status message only; never includes archived text or private machine paths. */
  getStorageNotice(): string | undefined { return this.memory.getNotice(); }
  /**
   * C2/C3 (pretrial fixes 2026-11-03): her current conversation for the chat window, so an in-place card update or a
   * switch back to her shows where the two of them were. Throws the usual "正在切换" while a context is committing.
   */
  recentChat(): RecentChat {
    const scope = this.currentScope();
    // I-139: a visitor's line reads with the relaxed mark (the window built from her archive uses the same one).
    const mark = getPromptSwitches().relaxed === true ? i139Text(VISITOR_MARK_RELAXED, this.language()) : undefined;
    // 边说边演: the grey line of a reply that was only a performance (it has no words in the archive) is shown again; her history below stays clean.
    const shown = this.memory.recentShown(scope, this.conversation, 24, mark, turnId => { const entry = this.speechBeats.archive.get(scope, turnId); return entry?.performanceOnly && entry.line ? entry.line : null; },
      (turnId, length) => this.speechBeats.archive.cutShown(scope, turnId, length, this.language())); // 2026-11-23: the quiet marker where her words were cut
    const opened = this.memory.hasOpened(scope.characterId); // 2026-11-25: the window shows her greeting only when she never opened with the user
    return { characterId: scope.characterId, messages: this.memory.recentConversation(scope, this.conversation, 24, mark), ...(opened === null ? {} : { opened }), ...(shown.some(row => row.performed || row.cut) ? { shown } : {}) };
  }

  /** Her archive as a voice utterance's window reads it: her replies come back with the cut marker where her words were cut short (2026-11-23). */
  cutMarkedWindow(): { chatWindowSource: ReturnType<SpeechBeatsHost['longChatArchive']> extends infer R ? NonNullable<R> extends { chatWindowSource: infer F } ? F : never : never } | null {
    return this.speechBeats.longChatArchive(this.memory, false);
  }

  /**
   * What `context(...)` with these would do (2026-11-25, only the user cutting in interrupts her): 'same' (nothing), 'character' (another character: a switch),
   * or 'connection' / 'persona' (the same character with another connection or card text: it restarts her chat process, so a save waits until she is done).
   */
  contextChange(characterId: string, provider: ProviderConfig, persona: string): 'same' | 'character' | 'connection' | 'persona' {
    const scope = { characterId, providerScope: memoryProviderScope(provider) };
    const key = JSON.stringify([scopeKey(scope), createHash('sha256').update(persona).digest('hex')]);
    if (key === this.requestedContextKey) return 'same';
    const now = this.requestedScope ?? this.scope;
    if (!now || now.characterId !== characterId) return 'character';
    return now.providerScope !== scope.providerScope ? 'connection' : 'persona';
  }

  context(characterId: string, provider: ProviderConfig, persona: string, moodParameters?: MoodParameters): Promise<void> {
    const template = moodParameters ? validateMoodParameters(moodParameters) : undefined;
    const scope = { characterId, providerScope: memoryProviderScope(provider) };
    const signature = createHash('sha256').update(persona).digest('hex');
    const key = JSON.stringify([scopeKey(scope), signature]);
    if (key === this.requestedContextKey && (this.pendingOperations > 0 || !this.lock.switching)) {
      // The same request again: it waits for what is queued and is done only when that took (a failed one never reads as done;
      // a change queued after it, such as a new conversation, does not make it fail).
      return this.operations.then(() => {
        if (!sameScope(this.scope, scope)) throw new Error('角色切换没有完成，请再试一次。');
        if (template) try { this.mood.applyTemplate(characterId, template); } catch { /* a listener of her mood publish (the template, checked above, is in) */ }
      });
    }
    this.requestedContextKey = key;
    const stops = switchStops(this.requestedScope ?? this.scope, scope); // I-209 step 2: the outgoing one's turns (everyone's on another connection), never another on stage
    this.requestedScope = { ...scope };
    // Invalidate before the first filesystem await, including seal() in progress (change() bumps at once and settles however it ends).
    let publishFailed = false;
    const quietly = (run: () => void) => { try { run(); } catch { publishFailed = true; } };
    return this.change(stops, async stopped => {
      try {
        await stopped;
        const previous = this.scope ? { ...this.scope } : null;
        // C3 (pretrial fixes 2026-11-03): the same character with a new persona (her card updated in place) carries on the
        // conversation they are in; the next turn simply uses the new persona. Another character or connection is a new one.
        const inPlace = !!previous && sameScope(previous, scope);
        if (previous && !inPlace) await this.memory.seal(previous);
        // A listener of her mood publish that throws (one that read the scope while it was switching) is not the switch failing:
        // her mood moved. Only a mood that stayed where it was fails it (switch lock 2026-11-23).
        quietly(() => this.mood.activate(characterId, template));
        if (this.mood.activeCharacterId !== characterId) this.mood.activate(characterId, template);
        void this.relationship.ensure(characterId);
        quietly(() => this.mood.invalidate());
        this.scope = { ...scope };
        // I-209 step 2: she was on stage already: her seat (conversation, opening) carries on as the companion's; a turn of hers stays current.
        const seat = inPlace ? null : this.owners.take(characterId);
        if (seat) { this.conversation = seat.conversationId; if (seat.opened) this.relationshipOpened = seat.opened; }
        else if (!inPlace) this.conversation = previous && previous.characterId !== characterId && previous.providerScope === scope.providerScope
          ? this.resumedConversation(scope) : randomUUID();
        this.stage(this.owners.ids()); // the others on stage, under this connection
        this.recalling.clear();
        // I-021 删除一致性: chats kept under this connection before the archive listed connections per character are hers.
        await this.memory.rememberScope(scope).catch(() => {});
      } catch (error) {
        // The switch did not happen: the lock settles on the scope she is still in, and asking for this one again runs it again.
        if (this.requestedContextKey === key) { this.requestedContextKey = ''; this.requestedScope = this.scope ? { ...this.scope } : null; }
        throw error;
      }
    }).then(() => { if (publishFailed) quietly(() => this.mood.invalidate()); }); // the windows get her new view once the switch settled
  }
  /**
   * C2 (pretrial fixes 2026-11-03): switching (back) to a character carries on the conversation she talked in last, so the
   * chat window can show it and the next message joins it; a new id when she has none, or when the user began a new
   * conversation after it. Only a switch of character on the same connection; the first context of a run starts fresh.
   */
  private resumedConversation(scope: MemoryScope): string {
    // The one the user began explicitly is also her latest once they talked in it; before that it is still the one to show.
    const fresh = this.freshConversation.get(scopeKey(scope));
    if (fresh) return fresh;
    try { return this.memory.latestConversation(scope)?.id ?? randomUUID(); } catch { return randomUUID(); }
  }

  newConversation(): Promise<void> {
    const scope = this.requestedScope ? { ...this.requestedScope } : this.currentScope();
    // A failed seal does not select another scope; the lock settles all the same (change()), also when the switch it followed failed.
    return this.change([scope.characterId], async stopped => {
      await stopped;
      await this.memory.seal(scope);
      const fresh = randomUUID();
      if (sameScope(this.scope, scope)) this.conversation = fresh;
      this.freshConversation.set(scopeKey(scope), fresh);
      this.recalling.delete(scopeKey(scope));
    });
  }
  /**
   * One change of the accepted context (switch lock, docs/claude/2026-11-23-switch-lock.md): the generation moves now, before any
   * await, so nothing in flight from before lands after it; her turns stop and the listeners hear of it; then `step` runs in turn.
   * However the step ends (done, thrown, returned early), its bump settles: no change leaves the lock held.
   */
  private change<T>(stops: OwnersStopped, step: (stopped: Promise<void>) => Promise<T>): Promise<T> {
    const generation = this.lock.bump();
    this.owners.bump(stops); // I-209 step 2: only these characters' turns stop (another one on stage keeps talking)
    try { this.mood.cancelChatGesture(); } catch { /* never blocks a transition */ }
    const stopped = this.stopActiveTurns(stops);
    this.contextChanged();
    return this.serialize(() => this.lock.settle(generation, () => step(stopped)));
  }

  begin(id: string, text: string, persona: string, emit: (type: StreamEvent['type'], text: string) => void, options: {textMemorial?:boolean; settingProposal?: SettingProposalOption; herFolder?: HerFolderOption | null; herFolderHint?: string | null; speaker?: 'visitor'; characterId?: string} = {}): Promise<CompanionTurn> {
    // Capture the accepted request's scope before awaiting. A pending transition
    // rejects new work until its commit instead of borrowing the old scope.
    // I-209 step 2: `characterId` (none: the desktop companion) is whose turn this is, from here to its archive; her mood, memory, journal, familiarity.
    const seat = this.turnSeat(options.characterId), { scope, conversationId, own } = seat;
    const expressionToken = own ? this.mood.get().token : '';
    if (own) this.mood.beginChatGesture(id, expressionToken);
    const meant = this.semanticPrefetch ? this.semanticPrefetch(text) : null; // I-111: runs beside the awaits below
    // Drops a pick still waiting, and starts reading this model's words now (the archive awaits below give it time; never awaited).
    if (own) try { this.chatActions?.cancel(); this.chatActions?.refresh?.(); } catch { /* nothing waiting */ }
    // I-098: a new message drops an earlier message's judge still running (its answer is never used). Seam: someone else on stage answers
    // with the tail as its carrier until she has her own judge (step 3).
    const speakOnlyJudge = own ? this.speakOnlyJudge : null;
    speakOnlyJudge?.begin(id);
    return this.serialize(async () => {
      let handle: MemoryTurnHandle | undefined;
      const current = seat.current;
      const assertCurrent = () => { if (!current()) throw new Error('这轮聊天所属的角色或对话已改变。'); };
      try {
        assertCurrent();
        if ([...this.activeTurns].some(turn => turn.id === id && sameScope(turn.scope, scope))) throw new Error('这轮聊天正在进行，不能重复启动。');
        await this.relationship.prepare(scope, dayOf => this.memory.chatActivity(scope, dayOf)).catch(() => {});
        assertCurrent();
        handle = await this.memory.beginTurn(scope, { id, userText: text, at: Date.now(), conversationId, ...(options.speaker === 'visitor' ? { speaker: 'visitor' as const } : {}) }); // I-135: a visitor's line is archived as not the user's
        assertCurrent();
        // A completed request ID cannot produce fresh UI text absent from its archive.
        if (!this.isOpenTurn(scope, handle.recordId, id)) throw new Error('这轮聊天已经结束，请使用新的消息编号。');
        await meant; // I-111: already done in the usual case; never longer than knobs.pace.prefetchMs, never throws
        const recallRevision = this.memory.recallRevision();
        let recalled = this.memory.retrieve(scope, text, { excludeRecordId: handle.recordId });
        if (options.speaker !== 'visitor') await this.memory.noteUserRecall(scope, text, { // I-135: a visitor's words never count as the user remembering something
          eventId: id, at: Date.now(), excludeRecordId: handle.recordId,
          confirmedRecordId: this.recalling.get(scopeKey(scope)),
        });
        assertCurrent();
        // 她也会需要你: this message may soothe her, or end the 低落 a need nobody answered left (释然); both lift the mood, so it comes
        // first and this very reply is written under the lifted mood. The one private line about it (only while she has a need, or just was
        // soothed or relieved), told once.
        const herNeedContext = this.herNeeds.chatTurn(scope.characterId);
        // I-078 第 2 步: "醒醒" in the user's own words wakes her at once (before her state line, so this reply is written awake but
        // groggy); any other message wakes her a little (the chat event below).
        if (explicitWakeRequest(text)) this.mood.wakeByWords(scope.characterId, id);
        // I-139: the light mood line (no numbers) and no routed why: the care text in the fixed prompt replaces every why variant.
        const relaxed = getPromptSwitches().relaxed === true ? { language: this.language(scope.characterId) } : null;
        const stateContext = relaxed ? this.mood.chatContext({ relaxed: true, language: relaxed.language, characterId: scope.characterId })
          : this.mood.chatContext({ characterId: scope.characterId, ...(getPromptSwitches().situation || getPromptSwitches().route ? { today: this.todayForSituation(scope) } : {}) });
        // Round 2 (shared/brain/prompt-route.ts): on a boundary turn the routed mode puts the short why in front of her state in this turn's message.
        const routedWhy = !relaxed && getPromptSwitches().route && boundaryKinds(text).length ? routedWhyBlock() : '';
        // I-089 item 5: only the length and the time of this message count toward the day's read; her own fresher judgment, when she has one, is the line.
        if (options.speaker !== 'visitor') this.dayRead.noteMessage(text.length); // I-135: not the user's day
        const userStateContext = this.userState.chatContext(scope.characterId) || this.dayRead.chatContext();
        const careAskedContext = this.careAsked.line(conversationId, text); // I-017: the kinds of care she has already asked in this stretch
        const safetyContext = this.safetyLines(id, text, scope.characterId); // I-117: may show the help card; '' unless it applies
        // 她自己的生活: the user is back; this one turn may hear what she was doing (taken once).
        const herLifeContext = this.herLife.chatTurn(scope.characterId);
        // 熟悉度: a plain yes to her nickname question is read first; then the lines a session opens with.
        await this.relationship.resolveNickname(scope.characterId, conversationId, text).catch(() => null);
        const ownerSeat = own ? null : this.owners.seat(scope.characterId), firstTurn = (ownerSeat ? ownerSeat.opened : this.relationshipOpened) !== conversationId;
        if (ownerSeat) ownerSeat.opened = conversationId; else this.relationshipOpened = conversationId;
        const relationshipOpening = withRealerEmotions(this.relationship.opening(scope.characterId, { firstTurn }), this.realerEmotions(scope.characterId), relaxed);
        const nicknameAsk = !options.textMemorial && !options.settingProposal?.instruction && !options.herFolder?.instruction && !options.herFolderHint
          && this.relationship.nicknameAsk(scope.characterId, { conversationId, userState: this.userState.current(scope.characterId)?.state ?? null });
        assertCurrent();
        // I-021 删除一致性: a note the user deleted (or a memory removed) while this turn waited above is not handed over: recall
        // again. Nothing awaits between here and the persona below. Unchanged otherwise, so ordinary turns recall exactly once.
        const recalledAt = this.memory.recallRevision();
        if (recalledAt !== recallRevision) recalled = this.memory.retrieve(scope, text, { excludeRecordId: handle.recordId });
        this.mood.event({ type: 'chat', id, reason: '收到用户聊天' }, scope.characterId);
        // M1: "跳一个" is only a request that adds to her own want to dance for a while; she decides (shared/actions/dance-request.ts).
        if (scanDanceRequest(text)) this.mood.noteDanceRequest(id, scope.characterId);

        let archival = Promise.resolve(); const gaps = new StreamGapProbe(); // 2026-11-24: where the text stopped arriving (electron/brain/stream-gaps.ts)
        let archiveFailure: unknown;
        let deliveryFailure: unknown;
        let finished = false;
        let finishing: Promise<void> | undefined;
        let body = '';
        let completedSpeechMood: SpeechMood | null = null;
        let completedProfileReply = false;
        let completedSettingProposal: string | null = null;
        let completedHerFile: string | null = null;
        let completedLookOffer = false;
        let emptied = false;
        let offeredActions: readonly ChatActionWord[] = [];
        try { offeredActions = own ? this.chatActions?.offered() ?? [] : []; } catch { offeredActions = []; }
        // T-250: doubled emphasis markers (**晶莹**) are dropped here, so the bubble, the voice, the proofs and the archive see one text.
        const emphasis = new EmphasisStream(delta => {
          if (!delta) return; gaps.shown(delta.length);
          body += delta;
          // Drain text produced before invalidation into its old archive only.
          archival = archival.then(async () => { await this.memory.appendAssistant(scope, id, delta, Date.now()); })
            .catch(error => { archiveFailure ??= error; });
          if (current() && !deliveryFailure) {
            try { emit('delta', delta); } catch (error) { deliveryFailure = error; }
          }
        });
        const protocol = new MoodReplyProtocol(delta => emphasis.push(delta), {
          ...(options.textMemorial ? {textMemorial:{userText:text,persona,mood:stateContext,context:'当前已授权普通聊天中的文字；只可内部准备一次文本纪念邀请，不在本轮正文提问，不保存任何资料。'}} : {}),
          ...(options.settingProposal ? { settingProposal: options.settingProposal } : {}),
          ...(options.herFolder ? { herFolder: options.herFolder } : {}),
          ...(options.herFolderHint ? { folderHint: options.herFolderHint } : {}), // I-056
          ...(nicknameAsk ? { nicknameAsk: true } : {}),
          ...(offeredActions.length ? { actions: offeredActions } : {}),
          speakers: speakersFromPersona(persona),
          chineseChat: chatLooksChinese(text, persona, this.language(scope.characterId)),
          englishAsked: asksForEnglish(text, this.language(scope.characterId)),
          ...(this.replyOpening ? { opening: this.replyOpening } : {}), userText: text,
          moodNow: getPromptSwitches().situation ? '' : this.tailMoodNow(scope.characterId), ...(this.tailGuideBefore ? { guideBefore: true } : {}),
          ...(speakOnlyJudge ? { speakOnly: true } : {}), // I-098: no state tail unless the turn needs it as a carrier
        });
        const speakKind: SpeakOnlyTurnKind | null = speakOnlyJudge ? (protocol.tailless ? 'judge' : 'tail') : null;
        let judged: Promise<SpeakOnlyOutcome | null> = Promise.resolve(null);
        const recordId = handle.recordId;
        // The late window (Codex T-222 E04): taken back after this, while the message waits for the process, it is still dropped.
        const withCurrentRecall = recallLateCheck({ recalled, revision: recalledAt, currentRevision: () => this.memory.recallRevision(),
          recallNow: () => this.memory.retrieve(scope, text, { excludeRecordId: recordId }), changed: kept => { recalled = kept; } });
        const turn: CompanionTurn = {
          scope: { ...scope }, recordId, id,
          relationshipOpening: relationshipOpening?.text ?? '', relationshipTag: relationshipOpening?.tag ?? '', relationshipMemes: relationshipOpening?.memes ?? true,
          persona: buildCompanionPersona({ persona, relationship: relationshipOpening?.text, stateContext: [routedWhy, stateContext].filter(Boolean).join('\n\n'), userState: userStateContext, herLife: herLifeContext, herNeed: herNeedContext, careAsked: careAskedContext, safety: safetyContext, memories: recalled, protocolInstruction: protocol.instruction(),
            // I-098 C and D: the human speaking rules; the settings catalog only on a message that looks like a settings request.
            // I-139: the one rhythm sentence instead (its honesty lines are in the fixed prompt's technical notes).
            ...(speakOnlyJudge ? { replyInstruction: relaxed ? i139Text(RHYTHM_LINE, relaxed.language) : SPEAK_ONLY_REPLY_INSTRUCTION, ...(mentionsSettings(text) ? { settingsCatalog: chatSettingsSystemText() } : {}) } : {}) }),
          withCurrentRecall,
          speakOnly: speakKind,
          speakOnlyJudged: () => judged,
          speechMood: () => current() && completedSpeechMood ? { ...completedSpeechMood } : null,
          profileReplyAccepted: () => current() && completedProfileReply,
          textMemorialProposal: () => current() && completedProfileReply ? protocol.textMemorialProposal() : null,
          settingProposal: () => current() ? completedSettingProposal : null,
          herFileProposal: () => current() ? completedHerFile : null,
          lookOffer: () => current() && completedLookOffer,
          emptyReply: () => emptied,
          // finish() runs the protocol's last flush synchronously, before it first awaits, so `body` is final once `finished` is set.
          shownReply: () => finished && current() && !deliveryFailure ? body : null,
          push: (type, value) => {
            if (finished || !current()) return;
            if (type === 'delta') { gaps.raw(value, body.length); protocol.push(value); }
            else if (!deliveryFailure) { try { emit(type, value); } catch (error) { deliveryFailure = error; } }
          },
          finish: status => {
            if (finishing) return finishing;
            finished = true;
            if (status !== 'complete') this.mood.cancelChatGesture(id);
            finishing = (async () => {
              try {
                const valid = current();
                let appraisal = protocol.finish(status === 'complete' && valid);
                emphasis.flush();
                let judgeLater = false;
                // Everything the reply said was an internal draft: archived as a failed reply, no mood, no gesture.
                emptied = status === 'complete' && valid && protocol.emptiedByFilter();
                const whole = emptied;
                // F4: nothing of the reply is left, so she says one short line of her own (no model call) as this turn's reply.
                let filled = false;
                if (emptied && this.draftFill) {
                  try {
                    const line = this.draftFill.pick(this.primaryOf(scope.characterId), scope.characterId);
                    if (line) {
                      body += line; filled = true; emptied = false;
                      appraisal = null; // a tail that came with nothing but draft still moves no mood, as before
                      archival = archival.then(async () => { await this.memory.appendAssistant(scope, id, line, Date.now()); })
                        .catch(error => { archiveFailure ??= error; });
                      if (!deliveryFailure) { try { emit('delta', line); } catch (error) { deliveryFailure = error; } }
                    }
                  } catch { /* she then fails the old way: emptied stays true */ }
                }
                if (emptied) this.mood.cancelChatGesture(id);
                // Developer mode only: how much was cut and of which shapes (never the text), as a count line.
                const drops = protocol.draftDrops();
                try { const cut = draftFilterInput(scope.characterId, drops, whole, filled); if (cut) this.journalNote?.(cut); } catch { /* the journal never changes a reply */ }
                // I-046: the check before the reply is kept (how the opening marker went, protocol words left), names and numbers only.
                try { const check = replyCheckInput(scope.characterId, status === 'complete' && valid ? protocol.replyCheck() : null, whole, filled); if (check) this.journalNote?.(check); } catch { /* the journal never changes a reply */ }
                try { const g = streamGapsInput(scope.characterId, gaps); if (g) this.journalNote?.(g); } catch { /* the journal never changes a reply */ }
                if (drops.length && this.mood.isDeveloperMode()) {
                  console.info('[soft hearts] reply draft filter', JSON.stringify(drops), whole ? (filled ? 'whole reply dropped, filled' : 'whole reply dropped') : '');
                  void appendBounded(this.draftFilterLog, draftFilterLine(drops, whole, Date.now())).catch(() => {});
                }
                await archival;
                await this.memory.finishTurn(scope, id, valid ? (emptied ? 'error' : status) : 'stopped', Date.now());
                // A context can change during the archive await.
                if (status === 'complete' && current() && !emptied) {
                  if (appraisal) {
                    this.mood.event({ type: 'appraisal', id: `appraisal-${id}`, responseTo: id, ...appraisal }, scope.characterId,
                      { expressions: own && expressionToken === this.mood.get().token });
                    try { this.journalNote?.(tailBookInput(scope.characterId, appraisal, protocol.userState(), id)); } catch { /* I-098: the tail's mood-book line, for comparison */ }
                    if (!archiveFailure && !deliveryFailure) this.mood.requestChatGesture(id, appraisal, expressionToken);
                    else this.mood.cancelChatGesture(id);
                    // Skeleton step 5: a small action she picked goes to the stage as one cue (it plays only if it can); her mood gates as for the talking gesture.
                    const action = own ? protocol.chatAction() : null, view = this.mood.get(); // seam: her small actions go to the stage of the one they belong to (step 4)
                    if (action && !archiveFailure && !deliveryFailure && view.token === expressionToken && chatActionAllowed(action, { expressions: view.expressions, snapshot: view.snapshot }))
                      try { this.chatActions?.request(action); } catch { /* the stage simply does not get it */ }
                    else if (action) { try { this.chatActions?.noted?.(action, 'held'); } catch { /* journal only */ } }
                    else { try { this.chatActions?.noted?.(null, null); } catch { /* journal only */ } }
                    // Only with an accepted tail, in the still-current scope; replaces her previous read of him.
                    this.userState.note(scope.characterId, protocol.userState());
                    this.dayRead.noteSaid(protocol.userState()?.state);
                    // 熟悉度: a quality moment (she read the user's state, or answered with concern / support); and the nickname question, if she asked it.
                    const read = protocol.userState();
                    if ((read && read.state !== 'calm' && read.state !== 'unknown') || appraisal.context === 'concern' || appraisal.context === 'support')
                      void this.relationship.noteQuality(scope.characterId);
                    const asked = protocol.nickname();
                    if (asked && !archiveFailure && !deliveryFailure) this.relationship.captureNicknameAsk(scope.characterId, conversationId, asked);
                  } else if (speakKind === 'judge' && !filled && !archiveFailure && !deliveryFailure) {
                    // I-098 B: no tail was asked; the judge gives this message's mood after the reply (below). The talking gesture waits for it.
                    judgeLater = true;
                  } else {
                    this.mood.cancelChatGesture(id);
                    // 心情第二批: no usable tail (missing, malformed, unconfident): a tiny lift by her label stands in for Opus's share, so a
                    // message never leaves her mood untouched (one per message; never with a tail). A draft-only reply she filled (F4) keeps
                    // its rule: no mood.
                    if (!archiveFailure && !deliveryFailure && !filled) this.mood.moments.tailless(scope.characterId, id);
                  }
                  if (!archiveFailure && !deliveryFailure) { void this.relationship.noteRound(scope.characterId); try { this.nicknameRoute?.(id, scope.characterId, text); } catch { /* never blocks a reply */ } }
                  if (!filled) this.careAsked.note(conversationId, body); // I-017: which kinds of care this reply asked (categories only)
                  const mentioned = recalled.filter(record => memoryRecallMatch(body, record).score >= 4);
                  if (mentioned.length === 1) this.recalling.set(scopeKey(scope), mentioned[0].id);
                  else this.recalling.delete(scopeKey(scope));
                }
                if (archiveFailure) throw new Error(`聊天文字保存失败：${String(archiveFailure)}`);
                if (deliveryFailure) throw new Error('聊天界面已关闭或无法接收输出，已保留产生的文字。');
                if (status === 'complete' && current() && !emptied) {
                  completedSpeechMood = {
                    context: appraisal?.context ?? 'neutral',
                    primary: this.primaryOf(scope.characterId),
                    gesture: appraisal?.gesture ?? 'none',
                  };
                  // I-098: with no tail asked, a complete, current, kept reply stands where an accepted tail stood (the profile's gate).
                  completedProfileReply = !!appraisal || judgeLater;
                  completedSettingProposal = protocol.settingProposal();
                  completedHerFile = protocol.herFileProposal();
                  completedLookOffer = isLookOffer(body);
                  if (judgeLater && speakOnlyJudge) judged = speakOnlyJudgment({ mood: this.mood, judgeNow: () => this.speakOnlyJudge, moodNow: () => this.tailMoodNow(scope.characterId),
                    note: input => this.journalNote?.(input), chatActions: this.chatActions, userState: this.userState, dayRead: this.dayRead, relationship: this.relationship }, speakOnlyJudge, { id, characterId: scope.characterId, conversationId, userText: text,
                    reply: body, persona, actions: offeredActions, expressionToken, current });
                }
              } finally { this.activeTurns.delete(turn); }
            })();
            return finishing;
          },
        };
        this.activeTurns.add(turn);
        return turn;
      } catch (error) {
        if (![...this.activeTurns].some(turn => turn.id === id && sameScope(turn.scope, scope))) this.mood.cancelChatGesture(id);
        // No failed setup may retain a streaming slot after its user original.
        if (handle) await this.memory.finishTurn(scope, id, current() ? 'error' : 'stopped', Date.now()).catch(() => {});
        throw error;
      }
    });
  }

  /** One accepted event for a host voice group; continuation legs do not call begin(). */
  beginVoiceGroup(id: string, text: string, persona: string): Promise<VoiceCompanionGroup> {
    const seat = this.turnSeat(), { scope, conversationId } = seat; // I-209 step 2: a voice group is the desktop companion's (a call with the one on stage)
    const expressionToken = this.mood.get().token;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)
      || typeof text !== 'string' || !text.trim() || text.length > 16000 || text.includes('\0'))
      throw Error('连续语音身份或原文不正确。');
    const current = seat.current;
    this.mood.beginChatGesture(id, expressionToken);
    try { this.chatActions?.cancel(); } catch { /* nothing waiting */ }
    return this.serialize(async () => {
      let handle: MemoryTurnHandle | undefined;
      const assertCurrent = () => { if (!current()) throw Error('连续语音所属角色或对话已改变。'); };
      try {
        assertCurrent();
        if ([...this.activeTurns].some(turn => turn.id === id && sameScope(turn.scope, scope))) throw Error('连续语音已开始。');
        await this.relationship.prepare(scope, dayOf => this.memory.chatActivity(scope, dayOf)).catch(() => {});
        assertCurrent();
        handle = await this.memory.beginTurn(scope, { id, userText: text, at: Date.now(), conversationId });
        assertCurrent();
        if (!this.isOpenTurn(scope, handle.recordId, id)) throw Error('连续语音已经结束。');
        await this.memory.noteUserRecall(scope, text, { eventId: id, at: Date.now(), excludeRecordId: handle.recordId,
          confirmedRecordId: this.recalling.get(scopeKey(scope)) });
        assertCurrent();
        // 她也会需要你: a spoken sentence soothes her like a typed one (the voice persona carries no extra line).
        this.herNeeds.interact(scope.characterId, 'chat', 1);
        // 她自己的生活 (pretrial issue 6): speaking to her lifts her out of her own thing at once (she looks up). The voice persona
        // still carries no extra line: the first-token A/B of 2026-11-03 could not clear the her-life line on a reply's own turn
        // (docs/claude/2026-11-03-pretrial-fixes-continuity.md), so the line waits for the next typed turn, as before.
        this.herLife.interact(scope.characterId);
        // I-117: a spoken sentence may show the help card too; the voice persona stays as it is, her private line waits for the next typed turn.
        try { this.safety?.read(id, text); } catch { /* never blocks her */ }
        if (explicitWakeRequest(text)) this.mood.wakeByWords(scope.characterId, id); // I-078 第 2 步: "醒醒" said aloud too
        this.mood.event({ type: 'chat', id, reason: '收到用户语音' }, scope.characterId);
        const recordId = handle.recordId;
        const group = new VoiceCompanionGroup({ id, scope, recordId, persona, initialText: text,
          memory: this.memory, mood: this.mood, userState: this.userState, relationship: this.relationship, expressionToken, current,
          ...(this.replyOpening ? { opening: this.replyOpening } : {}),
          recall: value => this.memory.retrieve(scope, value, { excludeRecordId: recordId }),
          recallRevision: () => this.memory.recallRevision(),
          closed: () => { this.activeTurns.delete(group); },
          language: () => this.language(),
          ...(getPromptSwitches().relaxed === true ? { relaxed: true } : {}), // I-139: the light mood line and the rhythm sentence, as typed chat
        });
        this.activeTurns.add(group);
        return group;
      } catch (error) {
        this.mood.cancelChatGesture(id);
        if (handle) await this.memory.finishTurn(scope, id, current() ? 'error' : 'stopped', Date.now()).catch(() => {});
        throw error;
      }
    });
  }

  removeMemory(id: string, beforeDelete?: (scope: MemoryScope) => Promise<void>): Promise<boolean> {
    if (typeof id !== 'string' || !id || id.length > 256 || id.includes('\0')) throw new Error('聊天记录编号不正确。');
    const scope = this.currentScope();
    return this.change([scope.characterId], async stopped => {
      await stopped;
      // An owned linked archive must be removed under the same synchronous
      // context invalidation, before deleting the normal record itself.
      await beforeDelete?.(scope);
      const deleted = await this.memory.delete(scope, id);
      // What she concluded about him from a chat the user just deleted goes with it.
      if (deleted) { this.userState.clear(scope.characterId); this.dayRead.clear(); }
      // Never call newConversation() after an await: a provider may have changed.
      await this.memory.seal(scope);
      const fresh = randomUUID();
      if (sameScope(this.scope, scope)) this.conversation = fresh;
      this.freshConversation.set(scopeKey(scope), fresh);
      this.recalling.clear();
      return deleted;
    });
  }

  /**
   * I-014 回收站: the current character's whole chat memory leaves (into the recycle bin, `forget`), under the same
   * context invalidation as removeMemory: her turns stop first, then a fresh conversation starts so nothing she was told
   * in the forgotten chats rides along. Another character's memory is not in any live session and needs none of this.
   */
  forgetCurrentMemories<T>(forget: () => Promise<T>): Promise<T> {
    const scope = this.currentScope();
    return this.change([scope.characterId], async stopped => {
      await stopped;
      const result = await forget();
      this.userState.clear(scope.characterId); this.dayRead.clear();
      await this.memory.seal(scope);
      const fresh = randomUUID();
      if (sameScope(this.scope, scope)) this.conversation = fresh;
      this.freshConversation.set(scopeKey(scope), fresh);
      this.recalling.clear();
      return result;
    });
  }

  /** Every writer this service owns, saved now (the quit path and tests await this before the folder may go). */
  async flush(): Promise<void> {
    await this.operations;
    await this.stopActiveTurns();
    this.moodJournal?.flushTouch(); // 体验记录: a run of pats still open becomes its line before quitting.
    await this.memory.flush();
    await this.mood.flush();
    // 熟悉度, her own life and her needs save on their own queues and 1 s timers: a pending save is written now, a
    // write in flight is awaited, unchanged state writes nothing.
    await Promise.all([this.relationship.flush(), this.herLife.settle(), this.herNeeds.settle()]);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations++;
    const result = this.operations.then(operation, operation).finally(() => { this.pendingOperations--; });
    this.operations = result.catch(() => {});
    return result;
  }
  private async stopActiveTurns(stops: OwnersStopped = 'all'): Promise<void> {
    // Original callers see storage failures; a later switch must still release UI. I-209 step 2: only the turns of `stops`.
    await Promise.allSettled([...this.activeTurns].filter(turn => stops === 'all' || stops.includes(turn.scope.characterId)).map(turn => turn.finish('stopped')));
  }
  private isOpenTurn(scope: MemoryScope, recordId: string, id: string): boolean {
    let offset = 0;
    while (true) {
      const page = this.memory.read(scope, recordId, { messageOffset: offset, messageLimit: 10, textLimit: 1 });
      if (!page) return false;
      const message = page.messages.find(item => item.turnId === id && item.role === 'assistant');
      if (message) return message.status === 'streaming';
      if (page.nextMessageOffset === undefined) return false;
      offset = page.nextMessageOffset;
    }
  }
}
