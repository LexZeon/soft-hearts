import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyMoodEvent, applyMoodLift, advanceMood, raiseBlushCue, createMoodState, DEFAULT_MOOD_PARAMETERS,
  cancelMoodExpressions, getMoodSnapshot, restoreMoodState, serializeMoodState, validateMoodParameters, MOOD_CHANNELS,
  canRequestAmbientSpeech, getMoodAttentionCandidate, validateAmbientSpeechObservation, releaseUnspokenSpeech,
  type AmbientSpeechObservation, type MoodEvent, type MoodLabel, type MoodParameters, type MoodPhase, type MoodSnapshot, type MoodState, type MoodValues,
} from '../shared/mood';
import { MOOD_LABELS, type DirectContactCancellation, type MoodInput, type MoodView } from '../shared/mood-runtime';
import { selectChatGesture, type ChatGestureAppraisal, type ChatGestureCue } from '../shared/chat-gesture';
import { chatGestureDurationMs } from './chat-gesture';
import { BehaviorMotionController, type BehaviorBindingSource } from './behavior-motion';
import { applyMoodResponse, type CharacterResponseProfile } from '../shared/character-response';
import { BodyMotionController, type BodyMotionHostGates } from './body-motion';
import type { BodyMotionCue, BodyMotionPlan, BodyStageObservation } from '../shared/body-motion';
import type { IdleMotionCandidate } from '../shared/idle-motion';
import type { UserStateView } from '../shared/user-state';
import type { RelationshipView } from '../shared/relationship';
import type { HerLifeView } from '../shared/her-life';
import { welcomeBackLine, type HerNeedView } from '../shared/her-needs';
import type { PoseReactionView } from '../shared/pose-reactions';
import { applyMoodPresence } from '../shared/mood-presence';
import { FatigueHost, SYSTEM_FATIGUE_CLOCK, type FatigueHostClock } from './fatigue-host';
import type { SleepEntryBlockers } from '../shared/fatigue';
import type { LastStop } from '../shared/app-session';
import { heldMoodState, MOOD_PRESETS, MOOD_TEST_HOLD_MS, moodPresetValues, withBaselineMood, withMoodPresetValues, type MoodPreset, type TestFatiguePhase } from '../shared/mood-presets';
import type { MoodJournalEvent } from './journal/sources';
import type { BlushMoment } from './journal/extras';
import type { ReplyRhythmView } from '../shared/reply-rhythm';
import type { ModuleRouterWhy } from '../shared/module-router/interface';
import { HER_CONTACT_RECENT_MS, type HerContact } from '../shared/her-state';
import { IdleGestureDirector, idleGestureNow } from '../shared/behaviors/idle-gesture/choose';
import type { IdleGestureHost } from '../shared/behaviors/idle-gesture/interface';
import { BoredomTimingDirector, boredomTimingNow } from '../shared/behaviors/boredom-timing/choose';
import type { BoredomTimingHost, BoredomTimingNow } from '../shared/behaviors/boredom-timing/interface';
import { quietPace } from '../shared/behaviors/user-activity/effects';
import { busyChatFrequency, recentChatTimes } from '../shared/behaviors/busy-chat/choose';
import { proactiveTalk, type ProactiveTalk } from '../shared/behaviors/inner-rhythm/knobs';
import type { UserActivityView } from '../shared/behaviors/user-activity/interface';
import { ReplyLingerDirector, replyLingerMood } from '../shared/behaviors/reply-linger/choose';
import type { ReplyLingerBubble, ReplyLingerHost, ReplyLingerMood } from '../shared/behaviors/reply-linger/interface';
import { TouchFeedEffectDirector, touchFeedNow } from '../shared/behaviors/touch-feed-effect/choose';
import type { TouchFeedContact, TouchFeedEffect, TouchFeedEffectHost } from '../shared/behaviors/touch-feed-effect/interface';
import type { TouchFeedKind } from '../shared/behaviors/touch-feed-effect/knobs';
import { withTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/perform';
import { BlushDirector, blushNow } from '../shared/behaviors/blush/choose';
import type { BlushContact, BlushHost, BlushPrepared } from '../shared/behaviors/blush/interface';
import { FeedCueDirector, feedCueNow } from '../shared/behaviors/feed-cue/choose';
import type { FeedCueHost, FeedCueNow } from '../shared/behaviors/feed-cue/interface';
import { FEED_CUE_KNOBS, type FeedTaste } from '../shared/behaviors/feed-cue/knobs';
import { FEED_MOOD_REASONS } from '../shared/feed-recognition';
import type { MoodJudgeMoodNote, MoodJudgeView } from '../shared/behaviors/mood-judge/interface';
import type { PauseTalkView } from '../shared/behaviors/pause-talk/interface';
import type { InteractionBudgetView } from '../shared/behaviors/interaction-budget/interface';
import type { MoodReactionPort, ReactionPerformed } from '../shared/behaviors/reactions/interface';

interface Profile { parameters: MoodParameters; state: MoodState }
/**
 * I-010 互动余额: one real interaction the mood model just accepted (told once per accepted event). `contact`: the pat, pinch or
 * snack session it belongs to (a pat sends many events; the budget counts the contact once). `answered`: a message that came
 * while her own line was still unanswered (she spoke, nobody had replied yet). `topic`: a chat event's topic ('rps' = a match ended).
 */
export interface MoodInteractionNote { type: 'chat' | 'rua' | 'food'; id: string; at: number; contact: string | null; topic: string | null; answered: boolean }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
const phases: MoodPhase[] = ['idle', 'rua', 'cheek', 'food-wait', 'food-ready', 'food-eating'];
/** How long a "跳一个" marker stays in the exported view (the stage ignores it after a few seconds anyway). */
const DANCE_REQUEST_VIEW_MS = 60_000;

/** The host owns one simulation per character; renderers only report bounded direct input. */
export class MoodHost {
  private readonly profiles = new Map<string, Profile>();
  private characterId = '';
  private token = randomUUID();
  private revision = 0;
  private exportedScope: { characterId: string; token: string; revision: number } | null = null;
  private developerMode = false;
  /** Developer test mood (setTestMood): memory only, never saved. */
  private testMood: { characterId: string; preset: MoodPreset; id: string; until: number } | null = null;
  private expressions = true;
  private gesture: ChatGestureCue | null = null;
  private gestureTurn: string | null = null;
  private pendingGestureTurn: string | null = null;
  private readonly handledGestureTurns = new Set<string>();
  private readonly acceptedAmbientObservations = new Set<string>();
  private activeSession: { id: string; mode: 'rua' | 'cheek' | 'food'; startedAt: number; lastAt: number; creditedAt: number; budget: number; accepted: boolean; readyAt: number | null } | null = null;
  private directContactCancellation: DirectContactCancellation | null = null;
  /** Retire cancellation as well as acceptance; a late phase cannot reopen it. */
  private readonly closedCheekSessions = new Set<string>();
  private lastTick: number | null = null;
  private lastSaveScheduledAt = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private failure = '';
  private loadBlocked = false;
  private readonly file: string;
  private readonly behavior: BehaviorMotionController;
  private responseProfileFor: (characterId: string) => CharacterResponseProfile | undefined = () => undefined;
  private userStateFor: (characterId: string) => UserStateView | null = () => null;
  private relationshipFor: (characterId: string) => RelationshipView | null = () => null;
  private herLifeFor: (characterId: string) => HerLifeView | null = () => null;
  private herNeedFor: (characterId: string) => HerNeedView | null = () => null;
  private poseFor: (characterId: string) => PoseReactionView | null = () => null;
  private replyRhythmFor: (characterId: string) => ReplyRhythmView | null = () => null;
  private moduleRouterFor: () => readonly ModuleRouterWhy[] = () => [];
  private readingModuleRouter = false;
  /** I-027 心情调整员 (electron/mood-judge/): the developer panel's line (developer mode only, memory only). */
  private moodJudgeFor: () => MoodJudgeView | null = () => null;
  /** I-006 第 1 步 你在专心做事: the state (memory only, shared/behaviors/user-activity/); null/unknown = boredom runs as the card says. */
  private userActivityFor: () => UserActivityView | null = () => null;
  /** I-039: the times (not the text) of the user's recent chat messages per character, and the 「她主动找你说话」 setting. Memory only. */
  private readonly chatTimes = new Map<string, number[]>();
  private talkFor: () => ProactiveTalk | undefined = () => undefined;
  /** F7 停停说说 (electron/pause-talk/): the developer panel's line (developer mode only, memory only). */
  private pauseTalkFor: () => PauseTalkView | null = () => null;
  private readingPauseTalk = false;
  /** I-010 互动余额 (electron/interaction-budget/): told about each accepted real interaction; the developer panel's line. */
  private budgetObserver: ((characterId: string, note: MoodInteractionNote) => void) | null = null;
  private budgetFor: (characterId: string) => InteractionBudgetView | null = () => null;
  /** I-027: told about each accepted change of the current character (type, id, fixed reason, what it moved); never text. */
  private judgeObserver: ((note: MoodJudgeMoodNote) => void) | null = null;
  private interactionObserver: ((characterId: string, kind: 'touch' | 'food', amount: number) => void) | null = null;
  private acceptedFood: { sessionId: string; characterId: string; at: number; delta: { D: number; E: number } | null } | null = null;
  /** I-017: the last few pats, cheek pinches and snacks (memory only), so the next chat turn's perception line may say so. */
  private contacts: { kind: HerContact; at: number; characterId: string }[] = [];
  /** M1: the latest "跳一个" request (memory only). */
  private danceRequest: { id: string; at: number; characterId: string } | null = null;
  /** 体验记录 (electron/journal/sources.ts MoodJournal): each accepted mood change, numbers and labels only. */
  private journalObserver: ((event: MoodJournalEvent) => void) | null = null;
  private blushJournal: ((moment: BlushMoment) => void) | null = null;
  /** I-037 新的反应方式 (electron/reactions/): null while its switch is off, and then nothing here behaves differently. */
  private reactionPort: MoodReactionPort | null = null;
  private visualBindingFor:(characterId:string,...args:Parameters<BehaviorBindingSource>)=>ReturnType<BehaviorBindingSource>=()=>undefined;
  private readonly body: BodyMotionController;
  private bodyVisible = false;
  private readonly fatigue: FatigueHost;
  /** #11 动一动、看你一眼: she picks how (shared/behaviors/idle-gesture/); memory only. */
  private readonly idleGesture: IdleGestureHost;
  /** #8 你不理她时多久看你、动一下、想开口: this round's grace, rate and thresholds (shared/behaviors/boredom-timing/); memory only. */
  private readonly boredomTiming: BoredomTimingHost;
  /** #5 回复说完气泡留多久: she decides per reply (shared/behaviors/reply-linger/); memory only. */
  private readonly replyLinger: ReplyLingerHost;
  /** #21 摸头、捏脸、喂点心让她心情好多少: how much this one lands, how fast she tires of it (shared/behaviors/touch-feed-effect/); memory only. */
  private readonly touchFeed: TouchFeedEffectHost;
  /** #26 脸红: how this blush looks and how long until the next one (shared/behaviors/blush/); memory only. */
  private readonly blush: BlushHost;
  /** #32 喂点心时的语气词和吃法: what she says before and after the bite, how she eats (shared/behaviors/feed-cue/); memory only. */
  private readonly feedCue: FeedCueHost;
  /** #32: the taste I-019 recognized last (its mood shift's reason), memory only; it colours the next snack's sounds. */
  private feedTaste: { characterId: string; at: number; taste: FeedTaste } | null = null;
  /** #32: I-019 will say her line after this bite (electron/main.ts sets it): the sound after the bite stays a sound, never a word. */
  private feedLineFollows: () => boolean = () => false;
  constructor(private readonly directory: string, private readonly changed: (view: MoodView) => void, private readonly clock = Date.now,
    bodyOptions: { readonly idleCandidates?: readonly IdleMotionCandidate[]; readonly fatigueClock?: FatigueHostClock; readonly idleGesture?: IdleGestureHost;
      readonly boredomTiming?: BoredomTimingHost; readonly replyLinger?: ReplyLingerHost; readonly touchFeedEffect?: TouchFeedEffectHost;
      readonly blush?: BlushHost; readonly feedCue?: FeedCueHost } = {}) {
    this.file = path.join(directory, 'mood-state.json');
    this.behavior = new BehaviorMotionController(clock,randomUUID,(...args)=>this.visualBindingFor(this.characterId,...args));
    this.body = new BodyMotionController(clock, randomUUID, bodyOptions);
    this.fatigue = new FatigueHost(directory, bodyOptions.fatigueClock ?? { ...SYSTEM_FATIGUE_CLOCK, wallMs: clock });
    this.idleGesture = bodyOptions.idleGesture ?? new IdleGestureDirector({ clock });
    this.boredomTiming = bodyOptions.boredomTiming ?? new BoredomTimingDirector();
    this.replyLinger = bodyOptions.replyLinger ?? new ReplyLingerDirector({ clock });
    this.touchFeed = bodyOptions.touchFeedEffect ?? new TouchFeedEffectDirector();
    this.blush = bodyOptions.blush ?? new BlushDirector();
    this.feedCue = bodyOptions.feedCue ?? new FeedCueDirector();
    // #11: the claimants run inside `changed` (electron/main.ts); only after it is the idle gesture shown, so only then remembered.
    this.changed = view => { changed(view); this.idleGesture.settle(); };
  }
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.fatigue.load();
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.blockLoad();
    }
    const loaded = new Map<string, Profile>();
    try {
      if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 128) throw new Error('Invalid mood profiles');
      for (const row of raw.profiles) {
        if (!object(row) || !validId(row.characterId) || loaded.has(row.characterId)) throw new Error('Invalid mood character');
        const parameters = validateMoodParameters(row.parameters);
        loaded.set(row.characterId, { parameters, state: restoreMoodState(row.state, this.clock(), parameters) });
      }
    } catch { this.blockLoad(); }
    this.profiles.clear();
    for (const [id, profile] of loaded) this.profiles.set(id, profile);
    this.loadBlocked = false;
    this.failure = '';
  }
  private blockLoad(): never {
    this.loadBlocked = true;
    this.failure = '心情状态无法读取，原 mood-state.json 已保留；本次更改仅保留在内存。修复原文件并重新载入后才能保存。';
    throw new Error(this.failure);
  }
  /** One-time card migration reads old M001 tuning without exposing live state. */
  getSavedParameters(characterId: string): MoodParameters | undefined {
    const profile = this.profiles.get(characterId);
    return profile ? structuredClone(profile.parameters) : undefined;
  }
  canMigrateTemplates(): boolean { return !this.loadBlocked; }
  assertParameterIdentity(value: unknown): void {
    this.refresh();
    if (!object(value) || Object.keys(value).some(key => !['characterId', 'token'].includes(key))
      || value.characterId !== this.characterId || value.token !== this.token)
      throw new Error('角色或模型已切换，请重新读取当前参数后再应用。');
  }
  /** Host-only canonical card template; it never imports state or grants renderer authority. */
  applyTemplate(characterId: string, value: unknown): void {
    const parameters = validateMoodParameters(value);
    const profile = this.profiles.get(characterId);
    if (!profile) return;
    if (characterId === this.characterId) this.refresh();
    profile.parameters = parameters;
    if (characterId === this.characterId && parameters.intensity.posture === 0) this.cancelChatGesture();
    if (!parameters.blush.enabled || parameters.blush.intensity === 0) profile.state = cancelMoodExpressions(profile.state);
    if (characterId === this.characterId) this.publish();
    this.scheduleSave();
  }
  activate(characterId: string, value?: MoodParameters): void {
    if (!validId(characterId)) throw new Error('心情角色编号不正确。');
    const parameters = value ? validateMoodParameters(value) : undefined;
    if (this.characterId === characterId) { if (parameters) this.applyTemplate(characterId, parameters); return; }
    if (!this.profiles.has(characterId) && this.profiles.size >= 128) throw new Error('心情角色存档已达到上限。');
    this.cancelChatGesture();
    this.cancelInteraction();
    this.characterId = characterId;
    if (!this.profiles.has(characterId)) {
      const initial = parameters ?? structuredClone(DEFAULT_MOOD_PARAMETERS);
      this.profiles.set(characterId, { parameters: initial, state: createMoodState(this.clock(), initial) });
    }
    const p = this.profile();
    // Switching away pauses online boredom. It does not erase this role's session
    // experience; an actual relaunch has already reset B in restoreMoodState.
    const boredom = p.state.boredom, idle = p.state.onlineIdleMs;
    p.state = advanceMood(p.state, this.clock(), { online: false }, p.parameters);
    p.state.boredom = boredom; p.state.onlineIdleMs = idle;
    if (parameters) p.parameters = parameters;
    this.fatigue?.activate(characterId, p.state.values, p.parameters.baseline);
    this.token = randomUUID();
    this.lastTick = this.clock();
    this.publish();
    this.scheduleSave();
  }
  invalidate(): void {
    this.body.cancel();
    this.cancelChatGesture();
    this.cancelInteraction();
    if (this.characterId) this.profile().state = cancelMoodExpressions(this.profile().state);
    this.token = randomUUID();
    if (this.characterId) this.publish();
  }
  get(): MoodView {
    if (this.refresh()) { this.revision++; this.changed(this.view()); }
    return this.view();
  }
  /**
   * #11: the look or motion cue `cueId` will not reach a window (the inner loop took it, electron/inner-loop/claim.ts).
   * What was picked for it is dropped: never remembered as "done last time", never in the developer "why".
   */
  cueHidden(cueId: string): void { this.idleGesture.hide(cueId); }
  /**
   * #5 (shared/behaviors/reply-linger/): how long the reply window keeps a reply that just finished showing (or reading aloud),
   * from its last bubble and her mood and card now. The reply window asks once per completion (electron/reply-window.ts);
   * the developer panel gets the why (developer mode only, memory only). Never throws into the reply.
   */
  decideReplyLinger(bubble: ReplyLingerBubble): number {
    let mood: ReplyLingerMood | null = null;
    if (this.characterId) try {
      mood = replyLingerMood({ snapshot: this.effectiveSnapshot(), personality: this.profile().parameters.weights,
        fatiguePhase: this.fatigue?.view(this.characterId)?.phase ?? null });
    } catch { mood = null; }
    const ms = this.replyLinger.decide(this.characterId, bubble, mood);
    if (this.developerMode && this.characterId) try { this.publish(); } catch { /* The panel line never disturbs the reply. */ }
    return ms;
  }
  /** Host-owned optional templates stay outside the legacy mood/card files. */
  setResponseProfileSource(source: (characterId: string) => CharacterResponseProfile | undefined): void {
    this.responseProfileFor = source;
  }
  setVisualBehaviorSource(source:(characterId:string,...args:Parameters<BehaviorBindingSource>)=>ReturnType<BehaviorBindingSource>):void{this.visualBindingFor=source;}
  visualBehaviorChanged(characterId:string):void{
    if(!this.characterId||characterId!==this.characterId)return;this.behavior.cancelPresentation();this.publish();
  }
  bodyPoseChanged(characterId:string):void{
    if(!this.characterId||characterId!==this.characterId)return;this.publish();
  }
  responseProfileChanged(characterId: string): void {
    if (!this.characterId || characterId !== this.characterId) return;
    this.refresh();
    if (this.effectiveSnapshot().intensity.posture === 0) {
      this.dropChatGesture(); this.gesture = null; this.gestureTurn = null;
    }
    this.publish();
  }
  private effectiveSnapshot() {
    const profile = this.profile();
    return applyMoodResponse(getMoodSnapshot(this.heldState(profile.state), this.clock(), this.rules(profile)), this.responseProfileFor(this.characterId));
  }
  /**
   * #8: what the mood model runs on for the current character: the card's parameters with this round's grace, rate and
   * thresholds (shared/behaviors/boredom-timing/; never earlier than the card for a small motion or speech). The saved,
   * exported and editable parameters stay the card's; frequency (cooldown, hourly and unanswered limits) is never touched.
   * #26: and the blush showing now keeps its own shape (shared/behaviors/blush/), so the snapshot's blush.profile matches how long
   * it lasts; when none shows, the card's shape with the cooldown after the last one (never shorter than the card's).
   */
  private rules(profile: Profile): MoodParameters {
    const state = profile.state, card = profile.parameters;
    let boredom = this.boredomTiming.rules(this.characterId, card.boredom,
      { idleMs: state.onlineIdleMs, boredom: state.boredom, at: state.updatedAt, holdMs: card.interaction.attentionMs }, () => this.timingNow(profile));
    // I-006: while the user is absorbed her boredom rises slower (never faster), so every moment only moves later (user-activity/effects.ts quietPace).
    let pace = 1;
    try { pace = quietPace(this.userActivityFor(), card.weights); } catch { pace = 1; }
    if (pace < 1) boredom = { ...boredom, perMinute: boredom.perMinute * pace };
    const blush = this.blush.profile(this.characterId, card.blush, state.blushCue);
    // I-039: a busy stretch of chatting raises her own speech caps (shared/behaviors/busy-chat/); the saved card is never changed.
    let less = false;
    try { less = proactiveTalk(this.talkFor()) === 'less'; } catch { less = false; }
    const frequency = busyChatFrequency({ card, chatTimes: this.chatTimes.get(this.characterId) ?? [], now: this.clock(), less });
    if (boredom === card.boredom && blush === card.blush && frequency === card.frequency) return card;
    return { ...card, ...(boredom === card.boredom ? {} : { boredom: { ...boredom } }), ...(blush === card.blush ? {} : { blush: { ...blush } }),
      ...(frequency === card.frequency ? {} : { frequency: { ...frequency } }) };
  }
  /** "此刻" for #21 and #26: her mood label and tendency on the card's parameters (they depend on none of the drawn numbers). */
  private cardSnapshot(profile: Profile): MoodSnapshot {
    return applyMoodResponse(getMoodSnapshot(this.heldState(profile.state), this.clock(), profile.parameters), this.responseProfileFor(this.characterId));
  }
  /**
   * #21: this pat, pinch or snack's effect for the current character (shared/behaviors/touch-feed-effect/): how much of the old
   * fixed amount it gives (never more) and how fast she tires of it. Null for any other event, or one the mood model will refuse.
   */
  private touchFeedEffect(profile: Profile, event: MoodEvent, now: number, rules: MoodParameters): { kind: TouchFeedKind; effect: TouchFeedEffect } | null {
    if (event.type !== 'rua' && event.type !== 'food') return null;
    try {
      const advanced = advanceMood(profile.state, now, { online: true }, rules);
      if (event.type === 'rua' && (event.effectiveMs === 0 || advanced.phase.startsWith('food-'))) return null;
      const kind: TouchFeedKind = event.type === 'rua' ? 'touch' : 'food', s = this.activeSession;
      const contact: TouchFeedContact = event.type === 'food' ? 'food' : event.id.startsWith('cheek:') || s?.mode === 'cheek' ? 'pinch' : 'pat';
      const session = s && (event.type === 'food' ? s.mode === 'food' : s.mode !== 'food') ? s.id : event.id;
      const effect = this.touchFeed.effect(this.characterId, { kind, contact, sessionId: session, at: this.clock(),
        doses: event.type === 'rua' ? event.effectiveMs / rules.interaction.ruaDoseMs : 1, taken: advanced.freshness[event.type]?.doses ?? 0 }, rules.freshness,
        () => touchFeedNow({ snapshot: this.cardSnapshot(profile), personality: profile.parameters.weights, fatiguePhase: this.fatigue?.view(this.characterId)?.phase }));
      return { kind, effect };
    } catch { return null; }
  }
  /**
   * #32 "此刻" for a snack of the current character: her mood and tendency on the card's parameters, card personality, fatigue,
   * how full she is (#21's freshness for snacks, before this bite), the taste I-019 recognized lately, and whether her line follows.
   */
  private feedCueNowFor(profile: Profile): FeedCueNow | null {
    try {
      const now = this.clock(), rules = this.rules(profile);
      const taken = advanceMood(profile.state, Math.max(now, profile.state.updatedAt), { online: true }, rules).freshness.food?.doses ?? 0;
      const taste = this.feedTaste && this.feedTaste.characterId === this.characterId && now - this.feedTaste.at >= 0
        && now - this.feedTaste.at <= FEED_CUE_KNOBS.tasteMinutes * 60_000 ? this.feedTaste.taste : null;
      let lineFollows = false;
      try { lineFollows = this.feedLineFollows() === true; } catch { lineFollows = false; }
      return feedCueNow({ snapshot: this.cardSnapshot(profile), personality: profile.parameters.weights, fatiguePhase: this.fatigue?.view(this.characterId)?.phase,
        freshness: { card: profile.parameters.freshness, taken }, taste, lineFollows });
    } catch { return null; }
  }
  /** #32: a new snack (the pet's first 'food-wait' of this session) or its bite. Only while 自动表现 is on; never disturbs the feed. */
  private feedCueOpen(profile: Profile, sessionId: string): void {
    if (!this.expressions) return;
    try { this.feedCue.open(this.characterId, sessionId, this.clock(), () => this.feedCueNowFor(profile)); } catch { /* The snack is eaten as before. */ }
  }
  private feedCueBite(sessionId: string, now: FeedCueNow | null): void {
    if (!this.expressions) return;
    try {
      const landing = this.touchFeed.landing?.(this.characterId, 'food', sessionId) ?? null;
      this.feedCue.bite(this.characterId, sessionId, this.clock(), landing, () => now);
    } catch { /* The snack is eaten as before. */ }
  }
  /** #32: I-019's "her line follows this bite" (electron/main.ts: the switch is on and Claude answers). */
  setFeedLineSource(source: () => boolean): void { this.feedLineFollows = source; }
  /** #26: an event that may make the current character blush (a pat, a pinch, warm words): how she would blush right now. */
  private prepareBlush(profile: Profile, event: MoodEvent, now: number): BlushPrepared | null {
    const contact: BlushContact | null = event.type === 'rua' ? (event.id.startsWith('cheek:') || this.activeSession?.mode === 'cheek' ? 'pinch' : 'pat')
      : (event.type === 'chat' || event.type === 'appraisal') && (event.context === 'support' || event.context === 'positive') ? 'words' : null;
    if (!contact) return null;
    try {
      const state = profile.state;
      return this.blush.prepare(this.characterId, profile.parameters.blush,
        { contact, cue: state.blushCue, lastBlushAt: state.lastBlushAt, at: Math.max(now, state.updatedAt), threshold: profile.parameters.fastThreshold },
        () => blushNow({ snapshot: this.cardSnapshot(profile), personality: profile.parameters.weights, fatiguePhase: this.fatigue?.view(this.characterId)?.phase,
          trigger: contact === 'words' ? 'words' : 'touch' }));
    } catch { return null; }
  }
  /** The parameters for this one event: #21's effect and #26's blush (and, for a pat, its threshold) on top of `rules`. */
  private eventRules(rules: MoodParameters, event: MoodEvent, effect: { kind: TouchFeedKind; effect: TouchFeedEffect } | null, blush: BlushPrepared | null): MoodParameters {
    let out = effect ? withTouchFeedEffect(rules, effect.kind, effect.effect) : rules;
    if (blush) out = { ...out, blush: { ...blush.profile },
      ...(event.type === 'rua' && blush.thresholdScale !== 1 ? { fastThreshold: Math.min(30, Math.max(1, rules.fastThreshold * blush.thresholdScale)) } : {}) };
    return out;
  }
  /** #26: after the event: did it make her blush (the mood model's new cue for this event, still there after 自动表现 and test gates). */
  private settleBlush(characterId: string, profile: Profile, event: MoodEvent, prepared: BlushPrepared, previousCueId: string | null): void {
    try {
      const state = profile.state, cue = state.blushCue;
      const raised = cue && cue.id === event.id && previousCueId !== event.id ? { ...cue } : null;
      const at = state.updatedAt, window = profile.parameters.fastWindowMs;
      const total = state.trend.filter(sample => sample.at > at - window && sample.at <= at).reduce((sum, sample) => sum + sample.delta.O, 0);
      const rise = [...state.trend].reverse().find(sample => sample.id === event.id)?.delta.O ?? 0;
      this.blush.settle(characterId, prepared, { cue: raised, rise, total });
    } catch { /* The why line never disturbs her mood. */ }
  }
  /** #8 "此刻" when a round begins: her mood label and tendency (the card's parameters: they do not depend on boredom), card personality, fatigue. */
  private timingNow(profile: Profile): BoredomTimingNow {
    const snapshot = applyMoodResponse(getMoodSnapshot(this.heldState(profile.state), this.clock(), profile.parameters), this.responseProfileFor(this.characterId));
    return boredomTimingNow({ snapshot, personality: profile.parameters.weights, fatiguePhase: this.fatigue?.view(this.characterId)?.phase });
  }
  /** The state as the views read it: a developer test mood (setTestMood) keeps its label's context, longing or reunion for a while. */
  private heldState(state: MoodState): MoodState {
    const hold = this.testMood;
    if (!hold) return state;
    const now = this.clock();
    if (!this.developerMode || hold.characterId !== this.characterId || now >= hold.until) { this.testMood = null; return state; }
    return heldMoodState(state, hold.preset, now, hold.id);
  }
  /**
   * Developer test command ("测试：开心", electron/test-commands/): set her mood to a named state now. The five channels are
   * set to what the label needs and then decay at their own speeds as always; the label's context, longing or reunion is
   * held for MOOD_TEST_HOLD_MS, or until any real event (chat, pat, feeding) happens. Returns the label now shown, or null
   * (not developer mode, or no character). `null` as the label = back to the card's baseline, hold and temporary fatigue
   * look cleared.
   */
  setTestMood(label: MoodLabel | null): MoodLabel | null {
    if (!this.developerMode || !this.characterId) return null;
    this.refresh();
    const p = this.profile();
    this.testMood = null;
    if (label === null) {
      p.state = withBaselineMood(p.state, p.parameters);
      this.fatigue?.setTestPhase(this.characterId, null);
    } else {
      const preset = MOOD_PRESETS[label];
      if (!preset) return null;
      p.state = withMoodPresetValues(p.state, moodPresetValues(preset, p.parameters));
      this.testMood = { characterId: this.characterId, preset, id: randomUUID(), until: this.clock() + MOOD_TEST_HOLD_MS };
    }
    this.scheduleSave();
    this.publish();
    return this.effectiveSnapshot().primary;
  }
  /** Developer test command ("测试：困了"): she looks (light-)drowsy for a while without the sleep model changing. null cancels it. */
  setTestFatigue(phase: TestFatiguePhase | null): boolean {
    if (!this.developerMode || !this.characterId || !this.fatigue) return false;
    const done = this.fatigue.setTestPhase(this.characterId, phase);
    if (done) this.publish();
    return done;
  }
  /**
   * The router's lines for this view. A source that reads the view back (2026-11-04: main.ts asked `mood.get().developerMode`,
   * and get() builds this view, which asks the router again) gets [] instead of recursing until the stack overflows: with
   * developer mode on, every view build spun the main thread for seconds and froze both windows.
   */
  private moduleRouterLines(): readonly ModuleRouterWhy[] {
    if (this.readingModuleRouter) return [];
    this.readingModuleRouter = true;
    try { return this.moduleRouterFor(); } catch { return []; } finally { this.readingModuleRouter = false; }
  }
  /** I-027: the developer panel's 心情调整员 line, or nothing (the source never throws into the view). */
  private moodJudgeLine(): { moodJudge?: MoodJudgeView } {
    try { const view = this.moodJudgeFor(); return view ? { moodJudge: view } : {}; } catch { return {}; }
  }
  /** F7 停停说说: the developer panel's line, or nothing (never throws into the view; a source reading the view back gets nothing). */
  private pauseTalkLine(): { pauseTalk?: PauseTalkView } {
    if (this.readingPauseTalk) return {};
    this.readingPauseTalk = true;
    try { const view = this.pauseTalkFor(); return view ? { pauseTalk: view } : {}; } catch { return {}; } finally { this.readingPauseTalk = false; }
  }
  /** I-010 互动余额: the developer panel's line for the current character, or nothing (the source never reads the mood back). */
  private budgetLine(): { interactionBudget?: InteractionBudgetView } {
    try { const view = this.budgetFor(this.characterId); return view ? { interactionBudget: view } : {}; } catch { return {}; }
  }
  private view(): MoodView {
    const p = this.profile();
    const snapshot = this.effectiveSnapshot();
    // I-022: the developer panel also sees the last time off screen counted as rest (developer mode only, memory only).
    const fatigueNow = this.fatigue?.view(this.characterId), rest = this.developerMode ? this.fatigue?.restNote(this.characterId) : undefined;
    const fatigue = fatigueNow && rest ? Object.freeze({ ...fatigueNow, rest }) : fatigueNow;
    const userState = this.developerMode ? this.userStateFor(this.characterId) : null;
    const relationship = this.developerMode ? this.relationshipFor(this.characterId) : null;
    let replyRhythm: ReplyRhythmView | null = null;
    if (this.developerMode) { try { replyRhythm = this.replyRhythmFor(this.characterId); } catch { replyRhythm = null; } }
    // The stage needs her current state in every mode; it is names and times only.
    let herLife: HerLifeView | null = null;
    try { herLife = this.herLifeFor(this.characterId); } catch { herLife = null; }
    // 她也会需要你: shown only while 自动表现 is on.
    let herNeed: HerNeedView | null = null;
    if (this.expressions) { try { herNeed = this.herNeedFor(this.characterId); } catch { herNeed = null; } }
    // P1 第二阶段: only while 自动表现 is on (the stage would not show it anyway).
    let pose: PoseReactionView | null = null;
    if (this.expressions) { try { pose = this.poseFor(this.characterId); } catch { pose = null; } }
    const request = this.danceRequest, danceRequest = request && request.characterId === this.characterId && this.clock() - request.at <= DANCE_REQUEST_VIEW_MS
      ? { id: request.id, at: request.at } : null;
    // #11: how she does the look or small motion showing now ("此刻" is read only the first time she sees it).
    const idle = this.expressions ? this.idleGesture.present(this.characterId, snapshot.cue, source => idleGestureNow({ kind: snapshot.cue!.kind as 'look' | 'motion',
      source, snapshot, personality: p.parameters.weights, contacts: this.contacts.filter(item => item.characterId === this.characterId),
      fatiguePhase: fatigue?.phase, now: this.clock() })) : null;
    // #32: how she sounds and eats for the snack being fed now (only while 自动表现 is on).
    let feedCue: MoodView['feedCue'] | null = null;
    if (this.expressions) { try { feedCue = this.feedCue.view(this.characterId, this.clock()); } catch { feedCue = null; } }
    // A non-view refresh may rotate token and return before publish. Never export
    // two different scopes at one revision; ordinary publish counts are unchanged.
    if (this.exportedScope && (this.exportedScope.token !== this.token || this.exportedScope.characterId !== this.characterId)
      && this.revision <= this.exportedScope.revision) this.revision = this.exportedScope.revision + 1;
    this.exportedScope = { characterId: this.characterId, token: this.token, revision: this.revision };
    return { characterId: this.characterId, revision: this.revision, token: this.token,
      developerMode: this.developerMode, expressions: this.expressions,
      ...(this.directContactCancellation?.token === this.token && this.directContactCancellation.characterId === this.characterId
        ? { directContactCancellation: { ...this.directContactCancellation } } : {}),
      ...(this.failure ? { storageError: this.failure } : {}),
      parameters: structuredClone(p.parameters), snapshot, ...(fatigue ? { fatigue } : {}), ...(userState ? { userState } : {}), ...(relationship ? { relationship } : {}),
      ...(herLife ? { herLife } : {}),
      ...(herNeed ? { herNeed } : {}),
      ...(pose ? { pose } : {}),
      ...(replyRhythm ? { replyRhythm } : {}),
      ...(danceRequest ? { danceRequest } : {}),
      ...(idle ? { idleGesture: idle.view } : {}),
      ...(this.developerMode ? { idleGestureWhy: this.idleGesture.recent(this.characterId) } : {}),
      ...(this.developerMode ? { boredomTimingWhy: this.boredomTiming.recent(this.characterId) } : {}),
      ...(this.developerMode ? { replyLingerWhy: this.replyLinger.recent(this.characterId) } : {}),
      ...(this.developerMode ? { touchFeedWhy: this.touchFeed.recent(this.characterId) } : {}),
      ...(this.developerMode ? { blushWhy: this.blush.recent(this.characterId) } : {}),
      ...(feedCue ? { feedCue } : {}),
      ...(this.developerMode ? { feedCueWhy: this.feedCue.recent(this.characterId) } : {}),
      ...(this.developerMode ? { moduleRouterWhy: this.moduleRouterLines() } : {}),
      ...(this.developerMode ? this.moodJudgeLine() : {}),
      ...(this.developerMode ? this.pauseTalkLine() : {}),
      ...(this.developerMode ? this.budgetLine() : {}),
      behavior: this.behavior.update(snapshot, this.token, this.expressions, idle ? { cueId: idle.view.cueId, bindingId: idle.bindingId } : null),
      body: this.body.observe(this.token, this.bodyGates(snapshot)),
      gesture: this.gesture ? { ...this.gesture } : null };
  }
  /** Advance reads too: a suspended app must invalidate the renderer's gesture generation. */
  private refresh(): boolean {
    if (!this.characterId) return false;
    const p = this.profile(), now = Math.max(this.clock(), p.state.updatedAt);
    const gap = this.lastTick === null ? Infinity : now - this.lastTick;
    const online = gap >= 0 && gap <= 5_000;
    const reset = !online && this.lastTick !== null;
    const expired = !!this.gesture && this.gesture.expiresAt <= now;
    if (reset) {
      this.body.cancel();
      this.retireCheekSession(); this.activeSession = null; this.token = randomUUID();
      this.dropChatGesture();
      this.gesture = null; this.gestureTurn = null;
    } else if (expired) { this.gesture = null; this.gestureTurn = null; }
    p.state = advanceMood(p.state, now, { online }, this.rules(p));
    this.fatigue?.update(this.characterId, p.state.values, p.parameters.baseline);
    this.lastTick = now;
    return reset || expired;
  }
  private profile(): Profile {
    const p = this.profiles.get(this.characterId);
    if (!p) throw new Error('心情状态尚未就绪。');
    return p;
  }
  private applyEvent(profile: Profile, event: MoodEvent, now: number, allowExpressions = true, characterId = this.characterId): void {
    // A real event (a chat, a pat, feeding) ends a developer test mood's hold: from here the real context counts.
    if (event.type !== 'attention') this.testMood = null;
    const source = event.type === 'attention' && event.source !== undefined ? validateAmbientSpeechObservation(event.source) : undefined;
    const observationKey = source ? JSON.stringify([characterId, source.sessionId, source.observationId]) : undefined;
    if (observationKey && (this.acceptedAmbientObservations.has(observationKey) || !this.expressions || !allowExpressions)) return;
    const previousBlushAt = profile.state.lastBlushAt;
    const alreadyAccepted = profile.state.recentEventIds.includes(event.id);
    const previousCue = profile.state.cue, previousBlushCue = profile.state.blushCue;
    const rules = characterId === this.characterId ? this.rules(profile) : profile.parameters;
    // #21 / #26: only the current character's new events; every other one runs on the card (as #8 does).
    const own = characterId === this.characterId && !alreadyAccepted;
    const effect = own ? this.touchFeedEffect(profile, event, now, rules) : null;
    // I-037: with the reaction table on, whether she blushes is its call (electron/reactions/); the model's own two gates stay out.
    const reactions = this.reactionPort && characterId === this.characterId ? this.reactionPort : null;
    let tableBlush = false;
    try { tableBlush = !!reactions?.ownsBlush(characterId); } catch { tableBlush = false; }
    const oBefore = reactions ? this.closenessRise(profile.state, now, rules) : 0;
    const blush = own && !tableBlush ? this.prepareBlush(profile, event, now) : null;
    const journaled = this.journalObserver && !alreadyAccepted && (event.type === 'rua' || event.type === 'food' || event.type === 'chat' || event.type === 'appraisal')
      ? advanceMood(profile.state, now, { online: true }, rules) : null;
    const unansweredBefore = profile.state.unansweredSpeech;
    profile.state = applyMoodEvent(profile.state, event, now, this.eventRules(rules, event, effect, blush));
    if (tableBlush && profile.state.blushCue?.id === event.id && previousBlushCue?.id !== event.id) {
      profile.state.blushCue = previousBlushCue; profile.state.lastBlushAt = previousBlushAt;
    }
    // I-039: a typed or spoken message (not a game move) the model accepted counts toward "chatting a lot".
    if (event.type === 'chat' && !event.topic && !alreadyAccepted && profile.state.recentEventIds.includes(event.id)) {
      const kept = recentChatTimes(this.chatTimes.get(characterId) ?? [], now);
      kept.push(now);
      this.chatTimes.set(characterId, kept.slice(-60));
    }
    // I-010: a real interaction the model accepted, told once (an event id already accepted never comes here again).
    if (this.budgetObserver && !alreadyAccepted && (event.type === 'rua' || event.type === 'food' || event.type === 'chat') && profile.state.recentEventIds.includes(event.id)) {
      const contact = event.type !== 'chat' && this.activeSession ? this.activeSession.id : null;
      try {
        this.budgetObserver(characterId, { type: event.type, id: event.id, at: now, contact, topic: event.type === 'chat' && typeof event.topic === 'string' ? event.topic : null,
          answered: event.type === 'chat' && unansweredBefore > 0 });
      } catch { /* Counting never blocks her mood. */ }
    }
    if (journaled) this.journalChange(characterId, profile, journaled, event.id, {
      type: event.type as 'rua' | 'food' | 'chat' | 'appraisal', reason: 'reason' in event ? event.reason : undefined,
      context: event.type === 'appraisal' ? event.context : undefined, effectiveMs: event.type === 'rua' ? event.effectiveMs : undefined });
    // I-027: the 心情调整员 hears of it (a pat or a snack with its contact, a message with its request id, Opus's tail with its message).
    if (this.judgeObserver && !alreadyAccepted && (event.type === 'rua' || event.type === 'food' || event.type === 'chat' || event.type === 'appraisal'))
      this.noteJudge(characterId, profile, { type: event.type, id: event.id, reason: 'reason' in event ? event.reason : undefined,
        context: event.type === 'chat' || event.type === 'appraisal' ? event.context : undefined, effectiveMs: event.type === 'rua' ? event.effectiveMs : undefined,
        responseTo: event.type === 'appraisal' ? event.responseTo : undefined }, event.type === 'rua' || event.type === 'food' ? this.activeSession?.id ?? null : null);
    if (characterId === this.characterId && !alreadyAccepted && profile.state.recentEventIds.includes(event.id)) {
      if (event.type === 'chat') this.fatigue?.accept(characterId, 'direct-chat', event.id);
      else if (event.type === 'rua' || event.type === 'food' || event.type === 'phase' && (event.phase === 'rua' || event.phase === 'cheek')) {
        // Phase start and its eventual reward share one accepted contact identity.
        // Renderer frames, assistant appraisals and TTS segments never pulse W.
        const identity = this.activeSession ? `contact:${this.activeSession.id}` : event.id;
        this.fatigue?.accept(characterId, 'physical', identity);
      }
    }
    if (observationKey && profile.state.cue?.id === event.id && profile.state.cue.source?.observationId === source!.observationId) {
      this.acceptedAmbientObservations.add(observationKey);
      if (this.acceptedAmbientObservations.size > 256) this.acceptedAmbientObservations.delete(this.acceptedAmbientObservations.values().next().value!);
    }
    if (!this.expressions) {
      profile.state = cancelMoodExpressions(profile.state);
      profile.state.lastBlushAt = previousBlushAt;
    } else if (!allowExpressions) {
      profile.state.cue = previousCue;
      profile.state.blushCue = previousBlushCue;
      profile.state.lastBlushAt = previousBlushAt;
    }
    if (blush) {
      this.settleBlush(characterId, profile, event, blush, previousBlushCue?.id ?? null);
      this.journalBlush(characterId, profile, event, blush, { cue: previousBlushCue, lastBlushAt: previousBlushAt, now }, !this.expressions || !allowExpressions);
    }
    // I-037: an accepted pat, pinch, snack, message or tail (the reaction host acts on it on a later tick, never inside this update).
    if (reactions && !alreadyAccepted && allowExpressions && (event.type === 'rua' || event.type === 'food' || event.type === 'chat' || event.type === 'appraisal')
      && profile.state.recentEventIds.includes(event.id)) {
      try {
        reactions.observe({ characterId, type: event.type, id: event.id, session: event.type === 'rua' || event.type === 'food' ? this.activeSession?.id ?? null : null,
          pinch: event.type === 'rua' && (event.id.startsWith('cheek:') || this.activeSession?.mode === 'cheek'), oBefore, oAfter: this.closenessRise(profile.state, profile.state.updatedAt, rules),
          threshold: rules.fastThreshold, ...(event.type === 'appraisal' ? { responseTo: event.responseTo, context: event.context } : {}) });
      } catch { /* A reaction never disturbs her mood. */ }
    }
  }
  /** I-037: closeness gained inside the card's fast window up to `at` (the old closeness blush compared exactly this with fastThreshold). */
  private closenessRise(state: MoodState, at: number, rules: MoodParameters): number {
    return state.trend.filter(sample => sample.at > at - rules.fastWindowMs && sample.at <= at).reduce((sum, sample) => sum + sample.delta.O, 0);
  }
  /** I-037 新的反应方式: its port (null: off, everything as before). */
  setReactionPort(port: MoodReactionPort | null): void { this.reactionPort = port; }
  /**
   * I-037: a blush the reaction table chose for the current character (`strength` 0.3–1, times the deeper of the card's intensity and `floor`). It looks as #26
   * picks (shared/behaviors/blush/), but the reaction table's own recent penalty replaces the card's cooldown. One at a time.
   */
  reactionBlush(characterId: string, id: string, strength: number, floor = 0): ReactionPerformed {
    if (!this.characterId || characterId !== this.characterId) return { done: false, why: 'stale' };
    if (!this.expressions) return { done: false, why: 'off' };
    if (this.refresh()) this.publish();
    const p = this.profile(), card = p.parameters.blush, now = Math.max(this.clock(), p.state.updatedAt);
    if (!card.enabled || !(card.intensity > 0)) return { done: false, why: 'card-off' };
    if (p.state.blushCue && p.state.blushCue.until > now) return { done: false, why: 'showing' };
    let prepared: BlushPrepared | null = null;
    try {
      prepared = this.blush.prepare(characterId, card, { contact: 'words', cue: null, lastBlushAt: null, at: now, threshold: p.parameters.fastThreshold },
        () => blushNow({ snapshot: this.cardSnapshot(p), personality: p.parameters.weights, fatiguePhase: this.fatigue?.view(characterId)?.phase, trigger: 'words' }));
    } catch { prepared = null; }
    const rules = this.rules(p);
    const next = raiseBlushCue(p.state, id, strength, now, prepared ? { ...rules, blush: { ...prepared.profile } } : rules, floor);
    if (!next) return { done: false, why: 'showing' };
    p.state = next;
    if (prepared) { try { this.blush.settle(characterId, prepared, { cue: next.blushCue, rise: 0, total: 0 }); } catch { /* the why line only */ } }
    try { this.blushJournal?.({ characterId, event: { type: 'chat', context: 'positive' }, before: { cue: null, lastBlushAt: null, now }, profile: card, gated: false, raised: true,
      applied: { O: 0, E: 0, N: 0 }, total: 0, threshold: p.parameters.fastThreshold }); } catch { /* a record only */ }
    this.scheduleSave();
    this.publish();
    return { done: true };
  }
  /** 体验记录: a candidate blush moment (a pat or warm words), fired or held back and why, as numbers and categories (electron/journal/extras.ts). */
  setBlushJournal(observer: ((moment: BlushMoment) => void) | null): void { this.blushJournal = observer; }
  setFatigueJournal(observer: Parameters<FatigueHost['setPhaseObserver']>[0]): void { this.fatigue.setPhaseObserver(observer); }
  private journalBlush(characterId: string, profile: Profile, event: MoodEvent, prepared: BlushPrepared,
    before: { cue: { id: string; until: number } | null; lastBlushAt: number | null; now: number }, gated: boolean): void {
    const observer = this.blushJournal;
    if (!observer) return;
    try {
      const state = profile.state, cue = state.blushCue, at = state.updatedAt, window = profile.parameters.fastWindowMs;
      const sample = state.trend.at(-1)?.id === event.id ? state.trend.at(-1)! : null;
      observer({ characterId, event: { type: event.type, context: 'context' in event ? event.context : undefined }, before, profile: prepared.profile, gated,
        raised: !!cue && cue.id === event.id && before.cue?.id !== event.id,
        applied: sample ? { O: sample.delta.O, E: sample.delta.E, N: sample.delta.N } : null,
        total: state.trend.filter(item => item.at > at - window && item.at <= at).reduce((sum, item) => sum + item.delta.O, 0), threshold: profile.parameters.fastThreshold });
    } catch { /* Keeping a record never changes her mood. */ }
  }
  /** 体验记录: told about each accepted change (its numbers, labels and the event's type; the journal maps the reason to a fixed one). */
  setJournalObserver(observer: ((event: MoodJournalEvent) => void) | null): void { this.journalObserver = observer; }
  /** `before` is the state advanced to the event's time; a change counts only when the event left its own trend sample (it was applied). */
  private journalChange(characterId: string, profile: Profile, before: MoodState, id: string,
    event: Pick<MoodJournalEvent, 'type' | 'reason' | 'context' | 'effectiveMs'>): void {
    const observer = this.journalObserver;
    if (!observer || profile.state.trend.at(-1)?.id !== id) return;
    try {
      const after = profile.state;
      observer({ characterId, ...event, before: { ...before.values }, after: { ...after.values },
        labelBefore: getMoodSnapshot(before, before.updatedAt, profile.parameters).primary,
        labelAfter: getMoodSnapshot(after, after.updatedAt, profile.parameters).primary });
    } catch { /* Keeping a record never changes her mood. */ }
  }
  private publish(): void { this.refresh(); this.revision++; this.changed(this.view()); }
  private bodyGates(snapshot: Pick<MoodSnapshot, 'phase' | 'intensity'>): BodyMotionHostGates {
    return { enabled: this.expressions, visible: this.bodyVisible, phase: snapshot.phase,
      posture: snapshot.intensity.posture, waitingForReply: this.pendingGestureTurn !== null,
      gestureActive: this.gesture !== null };
  }
  /** Internal startup QA only. There is no settings/card/renderer enable path. */
  configureBodyQa(recipeId: unknown): boolean { return this.body.configureQa(recipeId); }
  observeBodyStage(expectedToken: string, observation: BodyStageObservation): boolean {
    if (expectedToken !== this.token) return false;
    return this.body.observeIdleStage(expectedToken, observation);
  }
  prepareBodyPresentation(expectedToken: string, targetVerified: boolean, observation?: BodyStageObservation): BodyMotionPlan {
    this.refresh();
    if (!this.characterId) return Object.freeze({ cue: null, mode: 'closed', reason: 'blocked' });
    const snapshot = getMoodSnapshot(this.profile().state, this.clock(), this.profile().parameters);
    if (expectedToken !== this.token)
      return Object.freeze({ ...this.body.observe(this.token, this.bodyGates(snapshot)), cue: null, reason: 'invalid-scope' });
    const result = this.body.prepare(this.token, this.bodyGates(snapshot), targetVerified, observation);
    this.publish();
    return result;
  }
  setBodyVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new Error('身体表现可见状态不正确。');
    if (visible === this.bodyVisible) return;
    this.bodyVisible = visible;
    if (!visible) this.body.cancel();
    if (this.characterId) this.publish();
  }
  cancelBodyPresentation(expectedToken?: string, cueId?: string): void {
    if (expectedToken !== undefined && expectedToken !== this.token) return;
    if (cueId !== undefined && !this.getBodyCue(cueId, expectedToken ?? this.token, false)) return;
    if (this.body.cancel() && this.characterId) this.publish();
  }
  /** Main-process resolver checks start freshness; active playback uses full lease. */
  getBodyCue(cueId: string, expectedToken: string, startOnly = true): BodyMotionCue | null {
    if (!this.characterId) return null;
    const view = this.get(), cue = view.body?.cue;
    if (expectedToken !== this.token || !cue || cue.id !== cueId || cue.token !== expectedToken) return null;
    return (startOnly ? this.body.canStartCue(cueId, expectedToken) : this.body.ownsCue(cueId, expectedToken)) ? cue : null;
  }
  /** Developer-panel readout of her read of the user (electron/user-state.ts); the view carries it only in developer mode. */
  setUserStateSource(source: (characterId: string) => UserStateView | null): void { this.userStateFor = source; }
  userStateChanged(characterId: string): void {
    if (this.developerMode && this.characterId && characterId === this.characterId) this.publish();
  }
  /** 熟悉度 (electron/relationship/): the developer panel's numbers, and a touch / feeding that counts toward the day. */
  setRelationshipSource(source: (characterId: string) => RelationshipView | null): void { this.relationshipFor = source; }
  /** What a touch or a snack was worth: patting in effective milliseconds (a cheek release too), feeding in snacks. */
  setInteractionObserver(observer: (characterId: string, kind: 'touch' | 'food', amount: number) => void): void { this.interactionObserver = observer; }
  /** I-019: the bite accepted last (its interaction session, character, wall time and what it gave her), or null. */
  lastAcceptedFood(): { sessionId: string; characterId: string; at: number; delta: { D: number; E: number } | null } | null {
    return this.acceptedFood ? { ...this.acceptedFood, delta: this.acceptedFood.delta ? { ...this.acceptedFood.delta } : null } : null;
  }
  /** '' means the hand-set stage changed (any character). */
  relationshipChanged(characterId: string): void {
    if (this.developerMode && this.characterId && (!characterId || characterId === this.characterId)) this.publish();
  }
  /** 她自己的生活 (electron/her-life/host.ts): her current state for the stage and the developer panel. */
  setHerLifeSource(source: (characterId: string) => HerLifeView | null): void { this.herLifeFor = source; }
  herLifeChanged(characterId: string): void {
    if (this.characterId && characterId === this.characterId) this.publish();
  }
  /** F7 说话节奏 (electron/reply-rhythm-host.ts): the developer panel's view of the latest reply's pace. */
  setReplyRhythmSource(source: (characterId: string) => ReplyRhythmView | null): void { this.replyRhythmFor = source; }
  replyRhythmChanged(characterId: string): void {
    if (this.developerMode && this.characterId && characterId === this.characterId) this.publish();
  }
  /** I-023 haiku 调度台 (electron/module-router/): the developer panel's last few messages (developer mode only, memory only). */
  setModuleRouterSource(source: () => readonly ModuleRouterWhy[]): void { this.moduleRouterFor = source; }
  moduleRouterChanged(): void {
    if (this.developerMode && this.characterId) try { this.publish(); } catch { /* The panel line never disturbs a chat turn. */ }
  }
  /** I-006 第 1 步: the user's activity state (electron/user-activity.ts), read by rules() each time. Memory only. */
  setUserActivitySource(source: () => UserActivityView | null): void { this.userActivityFor = source; }
  /** I-039: the 「她主动找你说话」 setting (少一点 = no busy-chat boost). Memory only; unset = 适中. */
  setProactiveTalkSource(source: () => ProactiveTalk | undefined): void { this.talkFor = source; }
  /** I-039: how many of her own lines the user has not answered yet (the current character); for her prompt only. */
  unansweredSpeech(): number { return this.profiles.get(this.characterId)?.state.unansweredSpeech ?? 0; }
  /** I-027 心情调整员 (electron/mood-judge/): the developer panel's count today, cap and last few batches (developer mode only). */
  setMoodJudgeSource(source: () => MoodJudgeView | null): void { this.moodJudgeFor = source; }
  moodJudgeChanged(): void {
    if (this.developerMode && this.characterId) try { this.publish(); } catch { /* The panel line never disturbs her. */ }
  }
  /** F7 停停说说 (electron/pause-talk/): the last few replies' plans and first characters (developer mode only, memory only). */
  setPauseTalkSource(source: () => PauseTalkView | null): void { this.pauseTalkFor = source; }
  /** I-010 互动余额 (electron/interaction-budget/): told about each accepted pat, pinch, snack and message (any character), once each. */
  setBudgetObserver(observer: ((characterId: string, note: MoodInteractionNote) => void) | null): void { this.budgetObserver = observer; }
  /** I-010: the developer panel's line (developer mode only, memory only). */
  setBudgetSource(source: (characterId: string) => InteractionBudgetView | null): void { this.budgetFor = source; }
  pauseTalkChanged(): void {
    if (this.developerMode && this.characterId) try { this.publish(); } catch { /* The panel line never disturbs a chat turn. */ }
  }
  /**
   * I-027: told about each accepted change of the current character: a pat or pinch (with its contact), a snack, a message, Opus's
   * tail, a host-owned lift. Type, id, the app's fixed reason, the context and what it moved; never text. Never throws into her mood.
   */
  setJudgeObserver(observer: ((note: MoodJudgeMoodNote) => void) | null): void { this.judgeObserver = observer; }
  /** I-027: a developer test mood holds now (the judge stays quiet while it does). */
  isTestMoodActive(): boolean {
    const hold = this.testMood;
    return !!hold && this.developerMode && hold.characterId === this.characterId && this.clock() < hold.until;
  }
  private noteJudge(characterId: string, profile: Profile, event: { type: MoodJudgeMoodNote['type']; id: string; reason?: string; context?: MoodJudgeMoodNote['context'];
    effectiveMs?: number; responseTo?: string }, session: string | null): void {
    const observer = this.judgeObserver;
    if (!observer || characterId !== this.characterId) return;
    const sample = profile.state.trend.at(-1);
    if (!sample || sample.id !== event.id) return; // Not applied (refused, a repeat, or nothing moved).
    try {
      observer({ characterId, type: event.type, id: event.id, ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.context !== undefined ? { context: event.context } : {}), ...(session ? { session } : {}),
        ...(event.effectiveMs !== undefined ? { effectiveMs: event.effectiveMs } : {}), ...(event.responseTo !== undefined ? { responseTo: event.responseTo } : {}),
        applied: { ...sample.delta } });
    } catch { /* Watching never changes her mood. */ }
  }
  /** 她也会需要你 (electron/her-needs/host.ts): the small feeling she has now, for the stage and the developer panel. */
  setHerNeedSource(source: (characterId: string) => HerNeedView | null): void { this.herNeedFor = source; }
  herNeedChanged(characterId: string): void {
    if (this.characterId && characterId === this.characterId) this.publish();
  }
  /** P1 第二阶段 (electron/pose-reactions/host.ts): her attention and reactions to the local pose signals, for the stage. */
  setPoseSource(source: (characterId: string) => PoseReactionView | null): void { this.poseFor = source; }
  poseChanged(characterId: string): void {
    if (this.expressions && this.characterId && characterId === this.characterId) this.publish();
  }
  /**
   * 在场 (shared/mood-presence.ts): the user came back in front of the computer. A little less bored, nothing else: not an
   * interaction, not a mood event (no reason line, no trend, no interaction clock). The current character only, while 自动表现 is on.
   */
  presence(presence: { id: string; relief: number }, characterId = this.characterId): boolean {
    const p = this.profiles.get(characterId);
    if (!p || !this.expressions || characterId !== this.characterId || !(presence.relief > 0)) return false;
    if (this.refresh()) this.publish();
    const fresh = !p.state.recentEventIds.includes(presence.id);
    p.state = applyMoodPresence(p.state, presence, this.clock(), this.rules(p));
    // #8: boredom went down without a new round: the rest of this round rises no faster than the card's rate.
    if (fresh && p.state.recentEventIds.includes(presence.id)) this.boredomTiming.relieved(this.characterId);
    this.scheduleSave();
    this.publish();
    return true;
  }
  /**
   * A host-owned shift of the mood (shared/her-needs.ts, docs/claude/2026-11-03-mood-loop-design.md): she was soothed (a lift by the
   * table's amount), nobody answered (a small dip, more the more it piles up) or the user finally came (a lift, with `relief` the
   * label "释然" for a moment). Not a response from the user (the pat, snack or message already was one): no reply cue, no interaction
   * clock. Only while 自动表现 is on.
   */
  lift(lift: { id: string; delta: Partial<MoodValues>; reason: string; relief?: number; context?: MoodJudgeMoodNote['context'] }, characterId = this.characterId): void {
    // #32: I-019 recognized what she was fed (electron/feed-recognition/host.ts: id feed-taste-<session>): the next snack's sounds
    // may lean on it for a while (shared/behaviors/feed-cue/knobs.ts tasteMinutes). Only the category, never the food or the picture.
    if (typeof lift?.id === 'string' && lift.id.startsWith('feed-taste-')) {
      const taste: FeedTaste | null = lift.reason === FEED_MOOD_REASONS.loved ? 'loved' : lift.reason === FEED_MOOD_REASONS.disliked ? 'disliked'
        : lift.reason === FEED_MOOD_REASONS.notFood ? 'notFood' : null;
      if (taste) this.feedTaste = { characterId, at: this.clock(), taste };
    }
    const p = this.profiles.get(characterId);
    if (!p || !this.expressions) return;
    if (characterId === this.characterId && this.refresh()) this.publish();
    if (characterId !== this.characterId) p.state = advanceMood(p.state, this.clock(), { online: false }, p.parameters);
    const now = this.clock(), rules = characterId === this.characterId ? this.rules(p) : p.parameters;
    const journaled = this.journalObserver && !p.state.recentEventIds.includes(lift.id) ? advanceMood(p.state, now, { online: true }, rules) : null;
    const fresh = !p.state.recentEventIds.includes(lift.id);
    p.state = applyMoodLift(p.state, lift, now, rules);
    if (journaled) this.journalChange(characterId, p, journaled, lift.id, { type: 'lift', reason: lift.reason });
    if (fresh) this.noteJudge(characterId, p, { type: 'lift', id: lift.id, reason: lift.reason }, null); // I-027 (its own corrections are ignored there)
    this.scheduleSave();
    if (characterId === this.characterId) this.publish();
  }
  /**
   * M1: the user asked her to dance in chat (shared/dance-request.ts). It only marks the moment for the stage, which
   * adds it to her own want to dance for a while; it changes no mood and grants nothing.
   */
  noteDanceRequest(id: string, characterId: string): void {
    if (!this.characterId || characterId !== this.characterId || typeof id !== 'string' || !id) return;
    this.danceRequest = { id, at: this.clock(), characterId };
    this.publish();
  }
  private contacted(kind: 'touch' | 'food', amount: number, contact: HerContact): void {
    if (!this.characterId) return;
    this.contacts = [...this.contacts.filter(item => item.kind !== contact || item.characterId !== this.characterId), { kind: contact, at: this.clock(), characterId: this.characterId }].slice(-6);
    try { this.interactionObserver?.(this.characterId, kind, amount); } catch { /* Counting never blocks a touch. */ }
  }
  /** I-017: the current character's contacts of the last HER_CONTACT_RECENT_MS, newest first (kind and time only). */
  recentContacts(now = this.clock()): { kind: HerContact; at: number }[] {
    return this.contacts.filter(item => item.characterId === this.characterId && now - item.at >= -1_000 && now - item.at <= HER_CONTACT_RECENT_MS)
      .sort((a, b) => b.at - a.at).map(({ kind, at }) => ({ kind, at }));
  }
  isDeveloperMode(): boolean { return this.developerMode; }
  setDeveloperMode(value: unknown): MoodView {
    if (typeof value !== 'boolean') throw new Error('开发者模式开关不正确。');
    this.developerMode = value;
    this.publish();
    return this.get();
  }
  setExpressions(value: unknown): MoodView {
    if (typeof value !== 'boolean') throw new Error('自动表现开关不正确。');
    this.expressions = value;
    this.cancelChatGesture();
    if (this.characterId) this.profile().state = cancelMoodExpressions(this.profile().state);
    this.publish();
    return this.get();
  }
  setParameters(value: unknown): MoodView {
    if (!this.developerMode) throw new Error('请先开启开发者模式。');
    const parameters = validateMoodParameters(value);
    this.applyTemplate(this.characterId, parameters);
    return this.get();
  }
  restoreParameters(): MoodView { return this.setParameters(structuredClone(DEFAULT_MOOD_PARAMETERS)); }
  /**
   * I-022 "关应用也记": how the previous run ended (electron/app-session/ begin()), given before the first character wakes. Her rest
   * for the closed time uses this same number (the journal's 应用启动 line shows it too).
   */
  noteLastStop(value: LastStop | null): void { this.fatigue?.setLastStop(value); }
  /** Host-only current ownership; callers update priority starts without waiting for the next tick. */
  setFatigueActivity(value: SleepEntryBlockers): void {
    this.fatigue?.setBlockers(value);
    if (this.characterId) this.publish();
  }
  tick(canExpress: boolean, options: { ambientSpeech?: AmbientSpeechObservation; allowGenericSpeech?: boolean; fatigueActivity?: SleepEntryBlockers } = {}): void {
    if (options.fatigueActivity) this.fatigue?.setBlockers(options.fatigueActivity);
    if (!this.characterId) return;
    this.refresh();
    const p = this.profile(), now = p.state.updatedAt;
    if (canExpress && this.expressions && p.state.phase === 'idle') {
      const rules = this.rules(p);
      let source: AmbientSpeechObservation | undefined;
      try { if (options.ambientSpeech !== undefined) source = validateAmbientSpeechObservation(options.ambientSpeech); } catch { /* Invalid readiness grants no source exception. */ }
      const unseen = source && !this.acceptedAmbientObservations.has(JSON.stringify([this.characterId, source.sessionId, source.observationId]));
      if (unseen && canRequestAmbientSpeech(p.state, source!, now, rules))
        this.applyEvent(p, { type: 'attention', id: randomUUID(), kind: 'speech', source }, now);
      else {
        const candidate = getMoodAttentionCandidate(p.state, now, rules, options.allowGenericSpeech !== false);
        if (candidate) {
          const id = randomUUID();
          this.applyEvent(p, { type: 'attention', id, kind: candidate }, now);
          // #8: the rule's own timing really happened (the round keeps the first of each kind).
          if (p.state.cue?.id === id) this.boredomTiming.happened(this.characterId, candidate, now);
        }
      }
    }
    this.publish();
    if (now - this.lastSaveScheduledAt >= 30_000) this.scheduleSave();
  }
  /**
   * Developer test command only ("测试：给她一次说话的时机", electron/test-commands/): raises the same look-free motion or speech
   * cue the one-second tick would, without waiting for boredom or the interval (shared/mood.ts forcedAttentionAllowed). The
   * usual claimants then take it as always. False: not developer mode, no character, or the mood model refused (not idle,
   * a cue already showing, a speech quota used up).
   */
  forceAttention(kind: 'motion' | 'speech'): boolean {
    if (!this.developerMode || !this.characterId || (kind !== 'motion' && kind !== 'speech')) return false;
    this.refresh();
    const id = randomUUID();
    this.event({ type: 'attention', id, kind, force: true }, this.characterId, { expressions: this.expressions });
    return this.profile().state.cue?.id === id;
  }
  /** Inner loop only: a claimed speech cue that produced no visible line returns its quota (cooldown stays). */
  releaseSpeech(claimed: { id: string; at: number }, characterId = this.characterId): void {
    const p = this.profiles.get(characterId);
    if (!p) return;
    if (characterId === this.characterId) this.refresh();
    p.state = releaseUnspokenSpeech(p.state, claimed);
    this.scheduleSave();
  }
  /** Native blur retires the host session before a late release can settle it. */
  cancelDirectContact(): void {
    if (!this.activeSession) return;
    this.directContactCancellation = { characterId: this.characterId, token: this.token, sessionId: this.activeSession.id };
    this.cancelInteraction();
  }
  cancelInteraction(): void {
    this.refresh();
    this.retireCheekSession();
    const bodyChanged = this.body.cancel();
    this.activeSession = null;
    const p = this.profiles.get(this.characterId);
    if (!p || p.state.phase === 'idle') { if (bodyChanged && p) this.publish(); return; }
    this.applyEvent(p, { type: 'phase', phase: 'idle', id: randomUUID() }, this.clock());
    this.publish();
    this.scheduleSave();
  }
  interaction(value: unknown): MoodView {
    if (this.refresh()) this.publish();
    if (!object(value) || value.token !== this.token || !validId(value.sessionId)) throw new Error('互动已失效，请重新接触角色。');
    const input = value as unknown as MoodInput;
    if (input.type === 'wake') {
      const keys = ['token', 'sessionId', 'type', 'id'];
      if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || !validId(input.id))
        throw new Error('叫醒输入字段不正确。');
      this.fatigue?.accept(this.characterId, 'explicit-wake', input.id);
      this.publish(); this.scheduleSave(); return this.get();
    }
    if (input.type === 'cheek' || (input.type === 'phase' && input.phase === 'cheek')) {
      const keys = input.type === 'cheek' ? ['token', 'sessionId', 'type', 'id', 'activeMs'] : ['token', 'sessionId', 'type', 'phase'];
      if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)))
        throw new Error('捏脸输入字段不正确。');
    }
    const p = this.profile(), now = p.state.updatedAt;
    if (input.type === 'phase') {
      if (!phases.includes(input.phase)) throw new Error('互动阶段不正确。');
      if (input.phase === 'idle') {
        if (this.activeSession?.id === input.sessionId) this.cancelInteraction();
        return this.get();
      }
      if (!this.activeSession || this.activeSession.id !== input.sessionId) {
        if (input.phase !== 'rua' && input.phase !== 'cheek' && input.phase !== 'food-wait') throw new Error('请先开始互动。');
        if (input.phase === 'cheek' && (this.closedCheekSessions.has(input.sessionId) || p.state.recentEventIds.includes(`cheek:${input.sessionId}`)))
          throw new Error('这次捏脸已结束，请重新接触角色。');
        this.retireCheekSession();
        this.activeSession = { id: input.sessionId, mode: input.phase === 'rua' ? 'rua' : input.phase === 'cheek' ? 'cheek' : 'food', startedAt: now, lastAt: now, creditedAt: now, budget: 0, accepted: false, readyAt: null };
        // #32: a new snack was dragged in: she picks how she opens her mouth for it (published with this view, before it reaches her mouth).
        if (this.activeSession.mode === 'food') this.feedCueOpen(p, input.sessionId);
      }
      const s = this.activeSession;
      const mode = input.phase === 'rua' ? 'rua' : input.phase === 'cheek' ? 'cheek' : 'food';
      if (mode !== s.mode) throw new Error('互动类型已改变，请重新开始。');
      if (s.mode === 'cheek' && s.accepted) throw new Error('这次捏脸已接受，请重新接触角色。');
      if (s.mode === 'food' && input.phase === 'food-wait') {
        if (s.accepted) throw new Error('这份点心已接受，请重新拖入。');
        if (p.state.phase === 'food-ready') s.startedAt = now;
        s.readyAt = null;
      }
      s.lastAt = now;
      if (input.phase === 'food-ready') {
        if (s.accepted || (p.state.phase !== 'food-wait' && p.state.phase !== 'food-ready') || now - s.startedAt < 500) throw new Error('请在嘴边短暂停留，等待张嘴准备。');
        s.readyAt ??= now;
      } else if (input.phase === 'food-eating' && !this.activeSession.accepted) throw new Error('点心尚未接受。');
      this.cancelChatGesture();
      this.applyEvent(p, { type: 'phase', id: randomUUID(), phase: input.phase }, now);
    } else {
      if (!validId(input.id) || this.activeSession?.id !== input.sessionId) throw new Error('互动事件已过期。');
      const s = this.activeSession;
      if (input.type === 'rua') {
        if (p.state.phase !== 'rua' || !Number.isFinite(input.activeMs) || input.activeMs <= 0 || input.activeMs > 500) throw new Error('有效抚摸量不正确。');
        s.budget = Math.min(600, s.budget + Math.max(0, now - s.creditedAt));
        s.creditedAt = now;
        const ms = Math.min(s.budget, input.activeMs);
        s.budget -= ms;
        if (ms > 0) { this.applyEvent(p, { type: 'rua', id: input.id, effectiveMs: ms }, now); this.contacted('touch', ms, 'pat'); }
      } else if (input.type === 'cheek') {
        if (s.mode !== 'cheek' || p.state.phase !== 'cheek' || s.accepted)
          throw new Error('这次捏脸已过期或已接受。');
        if (!Number.isFinite(input.activeMs) || input.activeMs < 180 || input.activeMs > 500 || input.activeMs > now - s.startedAt)
          throw new Error('有效捏脸量不正确。');
        // A renderer can report measured movement, never channel deltas or a
        // fresh event identity per replay. Only the host names the reward.
        s.accepted = true;
        this.applyEvent(p, { type: 'rua', id: `cheek:${s.id}`, effectiveMs: input.activeMs, reason: '有效捏脸' }, now); this.contacted('touch', input.activeMs, 'pinch');
      } else if (input.type === 'food') {
        if (p.state.phase !== 'food-ready' || s.readyAt === null || s.accepted) throw new Error('请在嘴边准备好后松手交付。');
        s.accepted = true;
        const feedNow = this.expressions ? this.feedCueNowFor(p) : null; // #32: how full she was before this bite
        this.applyEvent(p, { type: 'food', id: input.id }, now); this.contacted('food', 1, 'food');
        // #32: the bite landed (#21 has just picked how much she enjoys it): the sound after it and how she chews.
        this.feedCueBite(s.id, feedNow);
        // I-019: what this bite gave her, for the shift once the picture is recognized (electron/feed-recognition/host.ts).
        const bite = [...p.state.trend].reverse().find(sample => sample.id === input.id);
        this.acceptedFood = { sessionId: s.id, characterId: this.characterId, at: this.clock(), delta: bite ? { D: bite.delta.D, E: bite.delta.E } : null };
      } else throw new Error('不支持的互动事件。');
      s.lastAt = now;
    }
    this.publish();
    this.scheduleSave();
    return this.get();
  }
  private retireCheekSession(): void {
    if (this.activeSession?.mode !== 'cheek') return;
    this.closedCheekSessions.add(this.activeSession.id);
    if (this.closedCheekSessions.size > 256) this.closedCheekSessions.delete(this.closedCheekSessions.values().next().value!);
  }
  event(event: MoodEvent, characterId = this.characterId, options: { expressions?: boolean } = {}): void {
    if (event.type === 'attention' && event.source !== undefined && characterId !== this.characterId) return;
    // #11: a look or motion the inner loop decided ("她自己选") or a test command; the one-second tick's are 'rule'.
    if (event.type === 'attention' && (event.kind === 'look' || event.kind === 'motion')) this.idleGesture.note(event.id, event.claimed ? 'inner' : event.force ? 'test' : 'rule');
    if (characterId === this.characterId && this.refresh()) this.publish();
    const p = this.profiles.get(characterId);
    if (!p) return;
    if (characterId === this.characterId && event.type === 'chat') {
      // Companion registers accepted requests before storage awaits. Direct host
      // callers still get the same cancellation boundary at the accepted event.
      if (this.pendingGestureTurn !== event.id) this.beginChatGesture(event.id, this.token);
      else if (this.gesture) { this.gesture = null; this.gestureTurn = null; }
    } else if (characterId === this.characterId && (event.type === 'rua' || event.type === 'food'
      || (event.type === 'phase' && event.phase !== 'idle'))) this.cancelChatGesture();
    if (characterId !== this.characterId) p.state = advanceMood(p.state, this.clock(), { online: false }, p.parameters);
    // I-037: with the reaction table on, her reply's tail gives only its share of the mood (MoodBlend; haiku's answer gives the rest).
    if (event.type === 'appraisal' && event.delta && this.reactionPort && characterId === this.characterId && !p.state.recentEventIds.includes(event.id)) {
      try { event = { ...event, delta: this.reactionPort.appraisal(characterId, event.responseTo, event.delta, event.context) }; } catch { /* the whole tail, as before */ }
    }
    this.applyEvent(p, event, this.clock(), options.expressions !== false, characterId);
    this.scheduleSave();
    if (characterId === this.characterId) this.publish();
  }
  /** Capture acceptance before an async archive operation can change the model generation. */
  beginChatGesture(turnId: string, expectedToken: string): void {
    this.refresh();
    if (!validId(turnId) || expectedToken !== this.token) return;
    if (this.pendingGestureTurn === turnId || this.gestureTurn === turnId || this.handledGestureTurns.has(turnId)) return;
    this.cancelChatGesture();
    this.pendingGestureTurn = turnId;
    this.body.cancel();
  }
  /** Consumes a completed reply exactly once. It does not apply a mood event or user timestamp. */
  requestChatGesture(turnId: string, appraisal: ChatGestureAppraisal, expectedToken: string): ChatGestureCue | null {
    this.refresh();
    if (!validId(turnId) || expectedToken !== this.token || this.profile().state.recentChatIds.at(-1) !== turnId
      || this.handledGestureTurns.has(turnId)) return null;
    this.rememberGestureTurn(turnId);
    if (this.pendingGestureTurn === turnId) this.pendingGestureTurn = null;
    if (!this.expressions) return null;
    const selected = selectChatGesture(appraisal, this.effectiveSnapshot());
    if (!selected) return null;
    const now = this.clock();
    const cue = { id: randomUUID(), at: now, expiresAt: now + chatGestureDurationMs(selected.intent) + 1_500, ...selected };
    this.gesture = cue;
    this.gestureTurn = turnId;
    this.publish();
    return { ...cue };
  }
  /** A scoped late cancellation cannot erase another request's cue. */
  cancelChatGesture(turnId?: string): void {
    if (turnId !== undefined && !validId(turnId)) return;
    const bodyChanged = turnId === undefined ? this.body.cancel() : false;
    const faceChanged = this.behavior.cancelReaction(turnId);
    if (turnId) this.rememberGestureTurn(turnId);
    else this.dropChatGesture();
    if (turnId && this.pendingGestureTurn === turnId) this.pendingGestureTurn = null;
    if (turnId && this.gestureTurn !== turnId) {
      if (faceChanged && this.characterId) this.publish();
      return;
    }
    const changed = this.gesture !== null;
    this.gesture = null; this.gestureTurn = null;
    if ((changed || faceChanged || bodyChanged) && this.characterId) this.publish();
  }
  private rememberGestureTurn(turnId: string): void {
    this.handledGestureTurns.add(turnId);
    if (this.handledGestureTurns.size > 256) this.handledGestureTurns.delete(this.handledGestureTurns.values().next().value!);
  }
  private dropChatGesture(): void {
    if (this.pendingGestureTurn) this.rememberGestureTurn(this.pendingGestureTurn);
    if (this.gestureTurn) this.rememberGestureTurn(this.gestureTurn);
    this.pendingGestureTurn = null;
  }
  /** Text only; never a tool instruction, memory grant or provider override. */
  chatContext(): string {
    const view = this.get(), s = view.snapshot;
    if (!view.expressions || s.intensity.text === 0) return '';
    const companions: Record<string, string> = { playful: '玩闹', close: '亲近', comfortable: '舒适', cautious: '谨慎', wistful: '想念余韵' };
    const contexts: Record<string, string> = { neutral: '中性', positive: '积极', support: '受到支持', concern: '关切用户', disappointment: '失望', offense: '感到冒犯' };
    const trend = MOOD_CHANNELS.filter(channel => Math.abs(s.trend[channel]) >= 0.05)
      .map(channel => `${channel}${s.trend[channel] > 0 ? '+' : ''}${s.trend[channel].toFixed(1)}${s.fast[channel] === 'up' ? '快速上升' : s.fast[channel] === 'down' ? '快速下降' : '缓变'}`).join('、');
    const event = s.event ? `${contexts[s.event.context]}，${MOOD_CHANNELS.filter(channel => Math.abs(s.event!.delta[channel]) >= 0.05).map(channel => `${channel}${s.event!.delta[channel] > 0 ? '+' : ''}${s.event!.delta[channel].toFixed(1)}`).join('、') || '无显著通道冲击'}` : '近期无事件冲击；自然恢复不代表新的失望或冒犯';
    const fatigue = this.fatigue?.view(this.characterId);
    const fatigueLabels = { awake: '清醒', 'light-drowsy': '轻微困倦', drowsy: '明显困倦', 'falling-asleep': '将睡未睡', asleep: '睡眠中仍可温和回应', 'micro-awake': '睡眠中轻微醒转' };
    const fatigueContext = fatigue && fatigue.phase !== 'awake'
      ? ` 当前疲倦感受：${fatigueLabels[fatigue.phase]}。保留当前角色性格，让措辞和节奏自然反映这一感受；完整回应用户，不每次主动说困，不假装没收到输入。` : '';
    // L4: once she has been missing the user, and at the moment of the reunion, she is glad to see the user (never "伤感" + "don't force cheer", which invited reproach).
    const welcome = welcomeBackLine({ longing: s.longing, longingAt: view.parameters.longing.longingAt, lastInteractionAt: s.lastInteractionAt, reunion: !!s.reunion });
    const feeling = welcome || `主感受${MOOD_LABELS[s.primary]}${s.companion ? `，伴随${companions[s.companion]}（仅修饰主感受）` : ''}`;
    return `当前角色内在状态（应用提供的模拟状态）：${feeling}；话题情境${contexts[s.context]}；最近原因：${s.reason || '自然陪伴'}。近期事件变化：${trend || '无'}；最近事件：${event}。以${s.intensity.text}/100的程度自然影响语气，认真回应当前话题；${welcome ? '' : '关切或失落时不因先前舒适而强行欢快，'}不把用户的负面心情当成对你的攻击，不声称这些数值是真实激素，不主动报数或提及调试设置。${fatigueContext}`;
  }
  private scheduleSave(): void {
    if (this.loadBlocked) return;
    if (!this.saveTimer) {
      this.lastSaveScheduledAt = this.clock();
      this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush().catch(() => { /* flush publishes the visible storage error. */ }); }, 1_000);
    }
  }
  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.loadBlocked) throw new Error(this.failure);
    const data = JSON.stringify({ version: 1, profiles: [...this.profiles].map(([characterId, p]) => ({ characterId, parameters: p.parameters, state: serializeMoodState(p.state) })) });
    const operation = async () => {
      const temp = this.file + '.tmp';
      await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.file);
    };
    this.queue = this.queue.then(operation, operation);
    try {
      await this.queue;
      const fatigueSaved = await this.fatigue?.flush();
      if (fatigueSaved === false && this.characterId) this.publish();
      if (this.failure) { this.failure = ''; if (this.characterId) this.publish(); }
    } catch (error) {
      this.failure = '心情状态保存失败，当前更改仅保留在内存。请检查本机数据目录。';
      if (this.characterId) this.publish();
      throw error;
    }
  }
}
