import { buildCompanionPersona } from './conversation-context';
import { recallLateCheck } from './recall-late-check';
import { DraftFillLines } from './draft-fill';
import { CareAskedTracker } from '../shared/care-asked';
import { createHash, randomUUID } from 'node:crypto';
import type { ProviderConfig, StreamEvent } from '../shared/contracts';
import { memoryRecallMatch, type MemoryScope, type MemoryTurnHandle, type RecentChat } from '../shared/memory';
import { MoodHost } from './mood';
import { MemoryStore } from './memory';
import { MoodReplyProtocol, type SettingProposalOption } from './mood-chat';
import type { OpeningMode } from './reply-opening';
import { asksForEnglish, chatLooksChinese, draftFilterLine, speakersFromPersona } from './reply-draft-guard';
import { appendBounded } from './reply-latency';
import type { MoodView } from '../shared/mood-runtime';
import { validateMoodParameters, type MoodParameters } from '../shared/mood';
import type { SpeechMood } from './speech-emotion';
import { VoiceCompanionGroup } from './voice-companion';
import { UserStateDiagnostics, UserStateStore } from './user-state';
import { RelationshipHost } from './relationship/host';
import { HerLifeHost } from './her-life/host';
import { HerNeedsHost, type HerNeedsHostOptions } from './her-needs/host';
import { InteractionBudgetHost, type InteractionBudgetHostOptions } from './interaction-budget/host';
import type { MoodInteractionNote } from './mood';
import type { BudgetCreditKind } from '../shared/behaviors/interaction-budget/interface';
import { innerLoopQuiet } from '../shared/inner-loop';
import { PoseReactionHost, type PoseReactionHostOptions, type PoseSimulation, type PoseSimulationResult } from './pose-reactions/host';
import type { PoseCharacter } from '../shared/pose-reactions';
import { localDateKey } from './diary/diary-dates';
import { SYSTEM_FATIGUE_CLOCK } from './fatigue-host';
import type { HerLifeActivity, HerLifeSwitchOffer, HerLifeWatchKind } from '../shared/her-life';
import { scanDanceRequest } from '../shared/dance-request';
import { herLifeBusy } from '../shared/behaviors/user-activity/effects';
import type { UserActivityView } from '../shared/behaviors/user-activity/interface';
import { REALER_EMOTIONS_CHAT_TEXT, REALER_EMOTIONS_SESSION_TAG } from '../shared/realer-emotions';
import type { RelationshipOpening } from './relationship/host';
import { BlushJournal, blushMomentInput, blushStageInput, draftFilterInput, fatiguePhaseInput, replyCheckInput } from './journal/extras';
import { MoodJournal, herLifeInput, herNeedInput, herNeedReliefInput, poseInput, relationshipInput, userStateInput, type JournalSink } from './journal/sources';
import path from 'node:path';
import { isLookOffer } from '../shared/look-request';
import { chatActionAllowed, type ChatActionWord } from '../shared/chat-actions';

export function memoryProviderScope(provider: ProviderConfig): string {
  return createHash('sha256').update(JSON.stringify([provider.kind, provider.baseUrl.trim().replace(/\/$/, ''), provider.model])).digest('hex');
}

export interface CompanionTurn {
  scope: MemoryScope;
  recordId: string;
  id: string;
  persona: string;
  /**
   * I-021 删除一致性, the late window (Codex T-222 E04): `persona` (this turn's, with whatever the host added after it) as it may
   * go out now. When the user took something back after the turn recalled its memories (a note deleted while the message
   * waited for the Claude process), only the memories still recalled stay (electron/recall-late-check.ts). Read where the
   * message is written; with nothing taken back it returns `persona` itself.
   */
  withCurrentRecall(persona: string): string;
  push(type: StreamEvent['type'], text: string): void;
  /** Available only after successful delivery/archive in the still-current scope. */
  speechMood(): SpeechMood | null;
  /** True only after a valid ordinary protocol tail and successful current archive/delivery. */
  profileReplyAccepted?(): boolean;
  /** Bounded nonce-bound private proposal; only after this exact ordinary reply completes and archives. */
  textMemorialProposal?(): string | null;
  /** Raw nonce-bound settings proposal (electron/chat-settings.ts); same lifetime rule as above. */
  settingProposal?(): string | null;
  /**
   * 识图第 1 步: her completed reply offered to look closer at the shared screen ("要我凑近看看吗", read from what she said by
   * shared/look-request.ts isLookOffer; no instruction or tail field, so the first token does not move). Same lifetime rule as above.
   */
  lookOffer?(): boolean;
  /** 熟悉度: the relationship lines for a session that opens with this turn (electron/relationship/host.ts); '' when there are none. */
  relationshipOpening?: string;
  /** Changes when an open session must restart (the switch, the stage or the nickname changed). */
  relationshipTag?: string;
  /** Her diary's memes may ride along in the opening block. */
  relationshipMemes?: boolean;
  /**
   * After finish('complete'): true when the draft filter (electron/reply-draft-guard.ts) removed the whole reply. The turn
   * was archived as an error and gave no mood update; the host fails the chat instead of showing an empty bubble.
   */
  emptyReply?(): boolean;
  /**
   * The reply exactly as it was shown, archived and handed to the voice (what the reply protocol let through), once finish()
   * has been called; null before, or when the window could not be given all of it. The conversation's Claude session records
   * this instead of what Claude wrote (electron/claude-session.ts CompanionSessionInput.shown).
   */
  shownReply?(): string | null;
  finish(status: 'complete' | 'stopped' | 'error'): Promise<void>;
}

/**
 * F6 "更真实的情绪" (shared/realer-emotions.ts): while the card has it on, its paragraph joins the block a conversation opens with
 * (after the relationship lines), and the session tag changes, so an open session restarts when the switch turns. Off: the
 * opening is returned unchanged, so every prompt is byte for byte what it is without the switch.
 */
export function withRealerEmotions(opening: RelationshipOpening | null, on: boolean): RelationshipOpening | null {
  if (!on) return opening;
  return {
    text: [opening?.text ?? '', REALER_EMOTIONS_CHAT_TEXT].filter(Boolean).join('\n\n'),
    tag: opening ? `${opening.tag}|${REALER_EMOTIONS_SESSION_TAG}` : REALER_EMOTIONS_SESSION_TAG,
    memes: opening?.memes ?? true,
  };
}

/** P1 第二阶段: what her card, mood and body bring to a pose decision (shared/pose-reactions.ts). */
export function poseCharacter(view: MoodView): PoseCharacter {
  return { weights: view.parameters.weights, mood: view.snapshot.primary, fatigue: view.fatigue ? { phase: view.fatigue.phase, F: view.fatigue.F } : null,
    motionIntervalMs: view.parameters.frequency.motionIntervalMs, posture: view.snapshot.intensity.posture, chatBoredomRelief: view.parameters.interaction.chatBoredomRelief };
}

/**
 * I-010 互动余额: what one accepted interaction counts as. A message that came while her own line was unanswered answers her
 * (it counts more); the chat event a finished 猜拳 match sends (topic 'rps', electron/rps/host.ts rpsMoodEvent) is a game.
 */
export function budgetCreditKind(note: Pick<MoodInteractionNote, 'type' | 'topic' | 'answered'>): BudgetCreditKind {
  if (note.type === 'rua') return 'touch';
  if (note.type === 'food') return 'food';
  return note.topic === 'rps' ? 'game' : note.answered ? 'answer' : 'message';
}

const scopeKey = (scope: MemoryScope) => JSON.stringify([scope.characterId, scope.providerScope]);
const sameScope = (a: MemoryScope | null, b: MemoryScope) => a?.characterId === b.characterId && a.providerScope === b.providerScope;

/** Private state and text persistence, kept outside providers and renderer permissions. */
/** Skeleton step 5: what the companion needs from the small-action host (electron/chat-actions-host.ts). */
export interface ChatActionPort {
  offered(): readonly ChatActionWord[]; request(word: ChatActionWord): void; cancel(): void; refresh?(): unknown;
  /** 体验记录: her tail's pick that never became a cue ('held' by her mood) or no pick at all (null, null). */
  noted?(word: ChatActionWord | null, answer: 'held' | null): void;
}

export class CompanionService {
  readonly mood: MoodHost;
  readonly memory: MemoryStore;
  /** Her short-lived read of how the user is now: memory only, per character, fades (electron/user-state.ts). */
  readonly userState: UserStateStore;
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
  /** 外号 (electron/relationship/nickname-route.ts): called once a reply is done; reads haiku's verdict for that message. Null: none. */
  private nicknameRoute: ((requestId: string, characterId: string) => void) | null = null;
  setNicknameRoute(route: ((requestId: string, characterId: string) => void) | null): void { this.nicknameRoute = route; }
  private realerSource: (characterId: string) => boolean = () => false;
  /** 体验记录 (electron/journal/): the mood side of the journal; null when no journal was given (tests). */
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
  private contextGeneration = 0;
  private committedGeneration = 0;
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
    const note = (input: Parameters<JournalSink['record']>[0]) => { try { journal?.record(input); } catch { /* Keeping a record never blocks her. */ } };
    this.journalNote = note;
    if (journal) { // 体验记录 第一批新记录项: a blush moment and a sleepiness phase change (electron/journal/extras.ts)
      const blushJournal = this.blushJournal = new BlushJournal(journal);
      this.mood.setBlushJournal(moment => blushJournal.moment(blushMomentInput(moment)));
      this.mood.setFatigueJournal(change => note(fatiguePhaseInput(change)));
    }
    this.memory = new MemoryStore(directory);
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
    this.pose = new PoseReactionHost({ changed: id => this.mood.poseChanged(id), presence: (id, relief, eventId) => { this.mood.presence({ id: eventId, relief }, id); },
      journal: (id, event, kind) => note(poseInput(id, event, kind)), interactionsSince: (id, at) => this.budget.interactionsSince(id, at), ...options.pose });
    this.mood.setPoseSource(id => this.pose.view(id));
    this.mood.setInteractionObserver((id, kind, amount) => { void this.relationship.noteTouch(id); this.herLife.interact(id); this.herNeeds.interact(id, kind, amount); });
  }
  /** F6: whether the card of a character has "更真实的情绪" on (main.ts reads the card store; off when it cannot tell). */
  setRealerEmotionsSource(source: (characterId: string) => boolean): void { this.realerSource = source; }
  /** I-006 第 1 步: whether the user is absorbed (electron/user-activity.ts). The mood host slows her boredom by it; her own life weighs by it. Memory only. */
  setUserActivitySource(source: () => UserActivityView | null): void { this.userActivityFor = source; this.mood.setUserActivitySource(source); }
  private userActivityFor: () => UserActivityView | null = () => null;
  /** I-006 第 3 步: what the user is watching or playing on the shared screen (electron/watch-along.ts; null with sharing off). She follows it in her own life. Memory only. */
  setWatchSource(source: () => HerLifeWatchKind | null): void { this.watchFor = source; }
  private watchFor: () => HerLifeWatchKind | null = () => null;
  /**
   * Skeleton step 5 (electron/chat-actions-host.ts): the small actions this model can do now (offered in the tail), and where her pick
   * goes (one cue; the stage decides). A new message drops a pick still waiting for her to finish speaking. Absent: nothing offered.
   */
  setChatActions(port: ChatActionPort | null): void { this.chatActions = port; }
  /**
   * F4: with this on, a reply the draft filter left empty gets one short line of her own (electron/draft-fill.ts) instead of failing
   * the chat. Off by default (the host turns it on), so the older failed-reply path stays what the tests of it cover.
   */
  setDraftFill(on: boolean): void { this.draftFill = on ? (this.draftFill ?? new DraftFillLines()) : null; }
  private draftFill: DraftFillLines | null = null;
  /**
   * I-046: every chat turn (typed and voice) asks for an opening marker, and only what she writes after it is shown, read aloud and
   * archived (electron/reply-opening.ts). Off by default (the host turns it on with REPLY_OPENING_ENABLED), so the tests of the
   * protocol without it keep what they cover.
   */
  setReplyOpening(on: boolean | OpeningMode): void { this.replyOpening = on === true ? 'turn' : on; }
  private replyOpening: OpeningMode | false = false;
  /** I-017: the kinds of care she asked in each conversation's current stretch (categories only, memory only). */
  private readonly careAsked = new CareAskedTracker();
  private chatActions: ChatActionPort | null = null;
  private journalNote: ((input: Parameters<JournalSink['record']>[0]) => void) | null = null;
  private blushJournal: BlushJournal | null = null;
  /** The pet window's answer to a new blush cue (could the stage show it?); the experience journal only. */
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
  /** Developer test command ("测试：我打了个哈欠" …): as if local sensing saw it (electron/pose-reactions/host.ts simulate). */
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
   * Developer test command ("测试：发呆", electron/test-commands/): start one of her own states now; `null` = she picks by her
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
    if (this.committedGeneration !== this.contextGeneration) throw new Error('角色或对话正在切换，请稍后再试。');
    return { ...this.scope };
  }
  /** Opaque, runtime-only voice authority; a new conversation cannot borrow its predecessor. */
  /** I-040: the conversation now (a new one starts on "new conversation" and on a character switch). */
  get conversationId(): string { return this.conversation; }
  currentSpeechScope(): string {
    const scope = this.currentScope();
    return createHash('sha256').update(JSON.stringify([scopeKey(scope), this.conversation, this.contextGeneration])).digest('hex');
  }
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
    this.relationship.dropPendingNickname();
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
    return { characterId: scope.characterId, messages: this.memory.recentConversation(scope, this.conversation) };
  }

  context(characterId: string, provider: ProviderConfig, persona: string, moodParameters?: MoodParameters): Promise<void> {
    const template = moodParameters ? validateMoodParameters(moodParameters) : undefined;
    const scope = { characterId, providerScope: memoryProviderScope(provider) };
    const signature = createHash('sha256').update(persona).digest('hex');
    const key = JSON.stringify([scopeKey(scope), signature]);
    if (key === this.requestedContextKey && (this.pendingOperations > 0 || this.committedGeneration === this.contextGeneration)) {
      return this.operations.then(() => { this.currentScope(); if (template) this.mood.applyTemplate(characterId, template); });
    }
    this.requestedContextKey = key;
    this.requestedScope = { ...scope };
    // Invalidate before the first filesystem await, including seal() in progress.
    const generation = ++this.contextGeneration;
    this.mood.cancelChatGesture();
    const stopped = this.stopActiveTurns();
    this.contextChanged();
    return this.serialize(async () => {
      await stopped;
      const previous = this.scope ? { ...this.scope } : null;
      // C3 (pretrial fixes 2026-11-03): the same character with a new persona (her card updated in place) carries on the
      // conversation they are in; the next turn simply uses the new persona. Another character or connection is a new one.
      const inPlace = !!previous && sameScope(previous, scope);
      if (previous && !inPlace) await this.memory.seal(previous);
      this.mood.activate(characterId, template);
      void this.relationship.ensure(characterId);
      this.mood.invalidate();
      this.scope = { ...scope };
      if (!inPlace) this.conversation = previous && previous.characterId !== characterId && previous.providerScope === scope.providerScope
        ? this.resumedConversation(scope) : randomUUID();
      this.recalling.clear();
      // I-021 删除一致性: chats kept under this connection before the archive listed connections per character are hers.
      await this.memory.rememberScope(scope).catch(() => {});
      this.committedGeneration = generation;
    });
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
    const generation = ++this.contextGeneration;
    this.mood.cancelChatGesture();
    const stopped = this.stopActiveTurns();
    this.contextChanged();
    return this.serialize(async () => {
      try {
        await stopped;
        await this.memory.seal(scope);
        const fresh = randomUUID();
        if (sameScope(this.scope, scope)) this.conversation = fresh;
        this.freshConversation.set(scopeKey(scope), fresh);
        this.recalling.delete(scopeKey(scope));
      } finally {
        // A failed seal does not select another scope. Keep read-only archive
        // access available instead of leaving the same character stuck forever.
        if (sameScope(this.scope, scope)) this.committedGeneration = generation;
      }
    });
  }

  begin(id: string, text: string, persona: string, emit: (type: StreamEvent['type'], text: string) => void, options: {textMemorial?:boolean; settingProposal?: SettingProposalOption} = {}): Promise<CompanionTurn> {
    // Capture the accepted request's scope before awaiting. A pending transition
    // rejects new work until its commit instead of borrowing the old scope.
    const scope = this.currentScope();
    const conversationId = this.conversation;
    const generation = this.contextGeneration;
    const expressionToken = this.mood.get().token;
    this.mood.beginChatGesture(id, expressionToken);
    // Drops a pick still waiting, and starts reading this model's words now (the archive awaits below give it time; never awaited).
    try { this.chatActions?.cancel(); this.chatActions?.refresh?.(); } catch { /* nothing waiting */ }
    return this.serialize(async () => {
      let handle: MemoryTurnHandle | undefined;
      const current = () => generation === this.contextGeneration && generation === this.committedGeneration && sameScope(this.scope, scope);
      const assertCurrent = () => { if (!current()) throw new Error('这轮聊天所属的角色或对话已改变。'); };
      try {
        assertCurrent();
        if ([...this.activeTurns].some(turn => turn.id === id && sameScope(turn.scope, scope))) throw new Error('这轮聊天正在进行，不能重复启动。');
        await this.relationship.prepare(scope, dayOf => this.memory.chatActivity(scope, dayOf)).catch(() => {});
        assertCurrent();
        handle = await this.memory.beginTurn(scope, { id, userText: text, at: Date.now(), conversationId });
        assertCurrent();
        // A completed request ID cannot produce fresh UI text absent from its archive.
        if (!this.isOpenTurn(scope, handle.recordId, id)) throw new Error('这轮聊天已经结束，请使用新的消息编号。');
        const recallRevision = this.memory.recallRevision();
        let recalled = this.memory.retrieve(scope, text, { excludeRecordId: handle.recordId });
        await this.memory.noteUserRecall(scope, text, {
          eventId: id, at: Date.now(), excludeRecordId: handle.recordId,
          confirmedRecordId: this.recalling.get(scopeKey(scope)),
        });
        assertCurrent();
        // 她也会需要你: this message may soothe her, or end the 低落 a need nobody answered left (释然); both lift the mood, so it comes
        // first and this very reply is written under the lifted mood. The one private line about it (only while she has a need, or just was
        // soothed or relieved), told once.
        const herNeedContext = this.herNeeds.chatTurn(scope.characterId);
        const stateContext = this.mood.chatContext();
        const userStateContext = this.userState.chatContext(scope.characterId);
        const careAskedContext = this.careAsked.line(conversationId, text); // I-017: the kinds of care she has already asked in this stretch
        // 她自己的生活: the user is back; this one turn may hear what she was doing (taken once).
        const herLifeContext = this.herLife.chatTurn(scope.characterId);
        // 熟悉度: a plain yes to her nickname question is read first; then the lines a session opens with.
        await this.relationship.resolveNickname(scope.characterId, conversationId, text).catch(() => null);
        const firstTurn = this.relationshipOpened !== conversationId;
        this.relationshipOpened = conversationId;
        const relationshipOpening = withRealerEmotions(this.relationship.opening(scope.characterId, { firstTurn }), this.realerEmotions(scope.characterId));
        const nicknameAsk = !options.textMemorial && !options.settingProposal?.instruction
          && this.relationship.nicknameAsk(scope.characterId, { conversationId, userState: this.userState.current(scope.characterId)?.state ?? null });
        assertCurrent();
        // I-021 删除一致性: a note the user deleted (or a memory removed) while this turn waited above is not handed over: recall
        // again. Nothing awaits between here and the persona below. Unchanged otherwise, so ordinary turns recall exactly once.
        const recalledAt = this.memory.recallRevision();
        if (recalledAt !== recallRevision) recalled = this.memory.retrieve(scope, text, { excludeRecordId: handle.recordId });
        this.mood.event({ type: 'chat', id, reason: '收到用户聊天' }, scope.characterId);
        // M1: "跳一个" is only a request that adds to her own want to dance for a while; she decides (shared/dance-request.ts).
        if (scanDanceRequest(text)) this.mood.noteDanceRequest(id, scope.characterId);

        let archival = Promise.resolve();
        let archiveFailure: unknown;
        let deliveryFailure: unknown;
        let finished = false;
        let finishing: Promise<void> | undefined;
        let body = '';
        let completedSpeechMood: SpeechMood | null = null;
        let completedProfileReply = false;
        let completedSettingProposal: string | null = null;
        let completedLookOffer = false;
        let emptied = false;
        let offeredActions: readonly ChatActionWord[] = [];
        try { offeredActions = this.chatActions?.offered() ?? []; } catch { offeredActions = []; }
        const protocol = new MoodReplyProtocol(delta => {
          if (!delta) return;
          body += delta;
          // Drain text produced before invalidation into its old archive only.
          archival = archival.then(async () => { await this.memory.appendAssistant(scope, id, delta, Date.now()); })
            .catch(error => { archiveFailure ??= error; });
          if (current() && !deliveryFailure) {
            try { emit('delta', delta); } catch (error) { deliveryFailure = error; }
          }
        }, {
          ...(options.textMemorial ? {textMemorial:{userText:text,persona,mood:stateContext,context:'当前已授权普通聊天中的文字；只可内部准备一次文本纪念邀请，不在本轮正文提问，不保存任何资料。'}} : {}),
          ...(options.settingProposal ? { settingProposal: options.settingProposal } : {}),
          ...(nicknameAsk ? { nicknameAsk: true } : {}),
          ...(offeredActions.length ? { actions: offeredActions } : {}),
          speakers: speakersFromPersona(persona),
          chineseChat: chatLooksChinese(text, persona),
          englishAsked: asksForEnglish(text),
          ...(this.replyOpening ? { opening: this.replyOpening } : {}), userText: text,
        });
        const recordId = handle.recordId;
        // The late window (Codex T-222 E04): taken back after this, while the message waits for the process, it is still dropped.
        const withCurrentRecall = recallLateCheck({ recalled, revision: recalledAt, currentRevision: () => this.memory.recallRevision(),
          recallNow: () => this.memory.retrieve(scope, text, { excludeRecordId: recordId }), changed: kept => { recalled = kept; } });
        const turn: CompanionTurn = {
          scope: { ...scope }, recordId, id,
          relationshipOpening: relationshipOpening?.text ?? '', relationshipTag: relationshipOpening?.tag ?? '', relationshipMemes: relationshipOpening?.memes ?? true,
          persona: buildCompanionPersona({ persona, relationship: relationshipOpening?.text, stateContext, userState: userStateContext, herLife: herLifeContext, herNeed: herNeedContext, careAsked: careAskedContext, memories: recalled, protocolInstruction: protocol.instruction() }),
          withCurrentRecall,
          speechMood: () => current() && completedSpeechMood ? { ...completedSpeechMood } : null,
          profileReplyAccepted: () => current() && completedProfileReply,
          textMemorialProposal: () => current() && completedProfileReply ? protocol.textMemorialProposal() : null,
          settingProposal: () => current() ? completedSettingProposal : null,
          lookOffer: () => current() && completedLookOffer,
          emptyReply: () => emptied,
          // finish() runs the protocol's last flush synchronously, before it first awaits, so `body` is final once `finished` is set.
          shownReply: () => finished && current() && !deliveryFailure ? body : null,
          push: (type, value) => {
            if (finished || !current()) return;
            if (type === 'delta') protocol.push(value);
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
                // Everything the reply said was an internal draft: archived as a failed reply, no mood, no gesture.
                emptied = status === 'complete' && valid && protocol.emptiedByFilter();
                const whole = emptied;
                // F4: nothing of the reply is left, so she says one short line of her own (no model call) as this turn's reply.
                let filled = false;
                if (emptied && this.draftFill) {
                  try {
                    const line = this.draftFill.pick(this.mood.get().snapshot.primary, scope.characterId);
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
                      { expressions: expressionToken === this.mood.get().token });
                    if (!archiveFailure && !deliveryFailure) this.mood.requestChatGesture(id, appraisal, expressionToken);
                    else this.mood.cancelChatGesture(id);
                    // Skeleton step 5: a small action she picked goes to the stage as one cue (it plays only if it can); her mood gates as for the talking gesture.
                    const action = protocol.chatAction(), view = this.mood.get();
                    if (action && !archiveFailure && !deliveryFailure && view.token === expressionToken && chatActionAllowed(action, { expressions: view.expressions, snapshot: view.snapshot }))
                      try { this.chatActions?.request(action); } catch { /* the stage simply does not get it */ }
                    else if (action) { try { this.chatActions?.noted?.(action, 'held'); } catch { /* journal only */ } }
                    else { try { this.chatActions?.noted?.(null, null); } catch { /* journal only */ } }
                    // Only with an accepted tail, in the still-current scope; replaces her previous read of him.
                    this.userState.note(scope.characterId, protocol.userState());
                    // 熟悉度: a quality moment (she read the user's state, or answered with concern / support); and the nickname question, if she asked it.
                    const read = protocol.userState();
                    if ((read && read.state !== 'calm' && read.state !== 'unknown') || appraisal.context === 'concern' || appraisal.context === 'support')
                      void this.relationship.noteQuality(scope.characterId);
                    const asked = protocol.nickname();
                    if (asked && !archiveFailure && !deliveryFailure) this.relationship.captureNicknameAsk(scope.characterId, conversationId, asked);
                  } else this.mood.cancelChatGesture(id);
                  if (!archiveFailure && !deliveryFailure) { void this.relationship.noteRound(scope.characterId); try { this.nicknameRoute?.(id, scope.characterId); } catch { /* never blocks a reply */ } }
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
                    primary: this.mood.get().snapshot.primary,
                    gesture: appraisal?.gesture ?? 'none',
                  };
                  completedProfileReply = !!appraisal;
                  completedSettingProposal = protocol.settingProposal();
                  completedLookOffer = isLookOffer(body);
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
    const scope = this.currentScope(), conversationId = this.conversation, generation = this.contextGeneration;
    const expressionToken = this.mood.get().token;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)
      || typeof text !== 'string' || !text.trim() || text.length > 16000 || text.includes('\0'))
      throw Error('连续语音身份或原文不正确。');
    const current = () => generation === this.contextGeneration && generation === this.committedGeneration && sameScope(this.scope, scope);
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
        this.mood.event({ type: 'chat', id, reason: '收到用户语音' }, scope.characterId);
        const recordId = handle.recordId;
        const group = new VoiceCompanionGroup({ id, scope, recordId, persona, initialText: text,
          memory: this.memory, mood: this.mood, userState: this.userState, relationship: this.relationship, expressionToken, current,
          ...(this.replyOpening ? { opening: this.replyOpening } : {}),
          recall: value => this.memory.retrieve(scope, value, { excludeRecordId: recordId }),
          recallRevision: () => this.memory.recallRevision(),
          closed: () => { this.activeTurns.delete(group); },
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
    const generation = ++this.contextGeneration;
    this.mood.cancelChatGesture();
    const stopped = this.stopActiveTurns();
    this.contextChanged();
    return this.serialize(async () => {
      try {
        await stopped;
        // An owned linked archive must be removed under the same synchronous
        // context invalidation, before deleting the normal record itself.
        await beforeDelete?.(scope);
        const deleted = await this.memory.delete(scope, id);
        // What she concluded about him from a chat the user just deleted goes with it.
        if (deleted) this.userState.clear(scope.characterId);
        // Never call newConversation() after an await: a provider may have changed.
        await this.memory.seal(scope);
        const fresh = randomUUID();
        if (sameScope(this.scope, scope)) this.conversation = fresh;
        this.freshConversation.set(scopeKey(scope), fresh);
        this.recalling.clear();
        return deleted;
      } finally {
        if (sameScope(this.scope, scope)) this.committedGeneration = generation;
      }
    });
  }

  /**
   * I-014 回收站: the current character's whole chat memory leaves (into the recycle bin, `forget`), under the same
   * context invalidation as removeMemory: her turns stop first, then a fresh conversation starts so nothing she was told
   * in the forgotten chats rides along. Another character's memory is not in any live session and needs none of this.
   */
  forgetCurrentMemories<T>(forget: () => Promise<T>): Promise<T> {
    const scope = this.currentScope();
    const generation = ++this.contextGeneration;
    this.mood.cancelChatGesture();
    const stopped = this.stopActiveTurns();
    this.contextChanged();
    return this.serialize(async () => {
      try {
        await stopped;
        const result = await forget();
        this.userState.clear(scope.characterId);
        await this.memory.seal(scope);
        const fresh = randomUUID();
        if (sameScope(this.scope, scope)) this.conversation = fresh;
        this.freshConversation.set(scopeKey(scope), fresh);
        this.recalling.clear();
        return result;
      } finally {
        if (sameScope(this.scope, scope)) this.committedGeneration = generation;
      }
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
  private async stopActiveTurns(): Promise<void> {
    // Original callers see storage failures; a later switch must still release UI.
    await Promise.allSettled([...this.activeTurns].map(turn => turn.finish('stopped')));
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
