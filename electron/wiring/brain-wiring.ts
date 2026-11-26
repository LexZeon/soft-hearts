// 大脑's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-17-wiring-step-4h.md):
// her brain. Moved from electron/main.ts; the statements are the ones main.ts had.
// - Her conversation (CompanionService: the chat archive, her relationship and the mood host; the brain's core), made in the ready chain
//   (startCompanion) with the sources it is handed, and the moments the chat process follows her windows (attachChatWindows).
// - Her Claude Code chat processes (I-186: one per character, ClaudeSessionPool, electron/brain/session-pool/) and the switches they are made with: I-098 speak-only,
//   I-134 the new chat (LONG_CHAT), I-139 (i139Chat and the prompt switches), the prewarm restart log.
// - When Claude cannot answer (chatOutage), I-023 the module router, F7 停停说说 (pauseTalk), F7 her pace (replyRhythm), R27 the reply timing
//   (replyLatency), R41 chat settings (chatSettings), the chat incident log.
// - The three gates every reply passes (one reply at a time, archived and rewarded once; a stopped, late or context-changed result never
//   writes): `pending` (the tasks in flight, one chat at a time), `launchTask` (runs a task, removes it when it settles) and
//   `reserveCompanionAuthoring` (the language and visual authoring borrow the chat's one lease). The chat turn itself is in
//   electron/wiring/brain-chat-wiring.ts (registerChatTurn), which this part's register calls.
// - What the lines read from the rest of the app comes through BrainNeeds (getters electron/main.ts gives): `needs.<value>` or
//   `const { … } = needs; // read when called`. The state other parts read is module-level and exported (live bindings electron/main.ts
//   reads: the ready chain, the clock and before-quit use them where they always did).
// What stays in electron/main.ts and why (the record): the windows, secureWindow's subscriber (it aborts a closed window's tasks in
//   `pending`), the ready chain's order, the clock, before-quit's order (it aborts and waits for `pending`, disposes the chat process),
//   the reply window (built with the companion window) and the creation of her small actions (chatActions: after 身体动作, whose actions it
//   plays). Step 5 (docs/claude/2026-11-17-wiring-step-5.md) moved here the saved step savedCompanionContext and playChatAction.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '../../shared/contracts';
import { CLAUDE_MODEL_ALIASES } from '../../shared/settings';
import { getPromptSwitches, isChatActionWord, promptSwitchDefaults, promptSwitchesFromEnv, relaxedPromptsActive, setPromptSwitches } from '../../shared/brain';
import { resolveLongChatKnobs } from '../../shared/behaviors/long-chat/knobs';
import type { MemoryScope } from '../../shared/memory';
import { bubbleFollowMode } from '../../shared/voice'; // I-165
import { cardLanguageOf, compileCharacterPersona, effectiveCharacterMood } from '../../shared/cards';
import { APP_REPLY_OPENING, ChatIncidentLog, firstCharTiming, GreetingArchive, ReplyLatencyProbe, ReplyRhythmHost, SessionRestartLog, chatAvailability, chatFailureEvent, claudeStartGate,
  createChatOutage, createTurnAwareness, i139ChatEdge, observeClaudeEnvironment, observeClaudeStreamKinds, ownerSpeechScope, registerChatAvailabilityIpc, speakOnlyEnabled, streamClaude } from '../brain';
import { companionHasHistory } from '../brain/claude-session';
import { ClaudeSessionPool, poolIdentity } from '../brain/session-pool';
import { createModuleRouter } from '../brain/module-router/wiring';
import { createPauseTalk } from '../brain/pause-talk/wiring';
import { proactiveChatFor } from './proactive-chat-wiring';
import { speakOnlyAppJudge, speakOnlySessionOptions } from '../brain/speak-only/wiring';
import { longChatHistory } from '../brain/long-chat/host';
import { startOpeningInput } from '../brain/long-chat/start-opening';
import { ChatSettingProposals } from '../brain/chat-settings';
import { CompanionService, memoryProviderScope } from '../brain/companion';
import type { ChatActionHost } from '../brain/chat-actions-host';
import type { ReplyLatencyRecord } from '../brain/reply-latency';
import type { PetReplyWindow } from '../brain/reply-window';
import type { resolveInstalledDesktopChannel } from '../desktop-channel';
import { createNicknameRoute, relationshipCardOf, type AppJournal } from '../memory';
import { quickLineWithClaude } from '../initiative';
import type { CharacterCardStore, CharacterResponseStore, PersonalizeLanguageStore } from '../cards';
import type { CompanionCommandHost, SettingsStore } from '../settings';
import type { CameraLookJournal } from '../senses';
import type { createHerState } from '../mood';
import type { PartIpc } from './ipc-wiring';
import type { PartHandle } from './parts-wiring';
import { settleWhenQuiet, wireQuiet } from './quiet-wiring';
import { noteContextChatModel } from '../brain/chat-model-fallback';
import { broadcast, send, windows } from './shell-wiring';
import { asrTask, readingInputSpeech, userActivity, type SensesProvides } from './senses-wiring';
import { attachMood, publishMood, reactions, touchBrain, type MoodProvides } from './mood-wiring';
import { feeding, proactiveSpeechGate, takeMeThere } from './initiative-wiring';
import { movingMemory, herNote, textInvitationMemory, userProfileManagement } from './memory-wiring';
import { VISUAL_GENE_SHA, bodyModelGeneration, herHereNow, herOnScreen, visualBehaviors, visualGeneReceipt } from './stage-wiring';
import type { VoiceProvides } from './voice-wiring';
import type { SettingsProvides } from './settings-wiring';
import type { ActionsProvides } from './actions-wiring';
import type { SafetyProvides } from './safety-wiring';
import { registerChatTurn } from './brain-chat-wiring';
import { stageLine } from './brain-stage-chat-wiring';
import { watchChatSeen } from '../brain/chat-seen';
import { connectUnboundCardChooser, connectUnboundReplyOwner, offerUnboundCard, onUnboundModeChanged, unboundOutsideTurnLine } from './unbound-wiring';

/** One task in flight: a chat turn (one at a time), a Claude task (R20), or an authoring that borrowed the chat's lease. */
export interface PendingTask { controller: AbortController; owner: number; kind: "chat" | "agent"; source?: 'language-authoring' | 'visual-authoring'; /** I-209 step 2: whose chat turn (her card id) */ characterId?: string }

/** What 大脑's lines read from the rest of the app (electron/main.ts gives getters; a value is read when it is used). */
export interface BrainNeeds {
  /** The installed channel (development / stable), read once while main.ts is evaluated: the switches below depend on it. */
  readonly installedDesktopChannel: ReturnType<typeof resolveInstalledDesktopChannel>;
  /** 声音's voice call: the chat process's timing is made with it (taken once, as main.ts did). */
  readonly voiceCall: VoiceProvides['voiceCall'];
  readonly store: SettingsStore;
  readonly characterCards: CharacterCardStore;
  readonly personalizeLanguage: PersonalizeLanguageStore | undefined;
  /** The reply window (built with the companion window in electron/main.ts's ready chain). */
  readonly petReply: PetReplyWindow | null;
  readonly exiting: boolean;
  readonly appJournal: AppJournal;
  /** 体验记录's first-character line (electron/memory/journal/extras.ts). */
  readonly journalExtras: { firstChar(record: ReplyLatencyRecord): object };
  readonly cameraLookJournal: CameraLookJournal;
  readonly herState: ReturnType<typeof createHerState>;
  readonly turnAwareness: ReturnType<typeof createTurnAwareness>;
  /** 设置's companion commands (shared with electron/main.ts when 设置 is wired). */
  readonly companionCommands: CompanionCommandHost | null;
  // 感知
  readonly media: SensesProvides['media'];
  readonly lookAttachments: SensesProvides['lookAttachments'];
  readonly lookTurns: SensesProvides['lookTurns'];
  readonly visionSupport: SensesProvides['visionSupport'];
  readonly visualSelfRuntime: SensesProvides['visualSelfRuntime'];
  readonly voiceHost: SensesProvides['voiceHost'];
  readonly foregroundAsr: SensesProvides['foregroundAsr'];
  readonly proactiveVision: SensesProvides['proactiveVision'];
  readonly ambientSpeakingOwners: SensesProvides['ambientSpeakingOwners'];
  // 声音
  readonly completedReplySpeech: VoiceProvides['completedReplySpeech'];
  readonly replySpeechStyles: VoiceProvides['replySpeechStyles'];
  readonly speechRuntime: VoiceProvides['speechRuntime'];
  // the other parts' functions (electron/main.ts's wrappers)
  journalCharacterId(): string | null;
  /** 连接任务和安全: 三方互通 is on (I-137's fact line). */
  agentInterconnected(): boolean;
  syncFatigueActivity: MoodProvides['syncFatigueActivity'];
  completedFatigueFeeling: MoodProvides['completedFatigueFeeling'];
  speechScope: VoiceProvides['speechScope'];
  replySpeechBusy: VoiceProvides['replySpeechBusy'];
  cancelReplyStyle: VoiceProvides['cancelReplyStyle'];
  clearReplySpeech: VoiceProvides['clearReplySpeech'];
  revokeVoice: SensesProvides['revokeVoice'];
  noteVisionUserActivity: SensesProvides['noteVisionUserActivity'];
  roughForTurn: SensesProvides['roughForTurn'];
  lookState: SensesProvides['lookState'];
  lookScope: SensesProvides['lookScope'];
  chatContextData: SensesProvides['chatContextData'];
  publishVisionState: SensesProvides['publishVisionState'];
  suspendAmbientSpeech: SensesProvides['suspendAmbientSpeech'];
  refreshVisualSelfContext: SensesProvides['refreshVisualSelfContext'];
  stopSystemAudio: SensesProvides['stopSystemAudio'];
  clearVisionContext: SensesProvides['clearVisionContext'];
  refreshVisionContext: SensesProvides['refreshVisionContext'];
  companionCommandContext: SettingsProvides['companionCommandContext'];
  /** Her small actions (electron/brain/chat-actions-host.ts, made in electron/main.ts after 身体动作, whose actions it plays). */
  readonly chatActions: ChatActionHost;
}

/** What electron/main.ts calls (from brain.provides). */
export interface BrainProvides {
  /** I-134 step 3: her own page about the user, for the new chat's opening message only (none yet, or the new chat off: null). */
  longChatNote(scope: MemoryScope): string | null;
}

// ---- state other parts read (live bindings electron/main.ts imports) ----
/** Her conversation (electron/brain/companion.ts): the chat archive, her relationship and the mood host. Made in the ready chain (startCompanion). */
export let companion!: CompanionService;
/** I-098 她只管说话: development channel and source runs on, stable off. */
export let SPEAK_ONLY_ON = false;
/** I-134 新聊天 (shared/behaviors/long-chat/knobs.ts): development channel and source runs on, stable off; SOFT_HEARTS_LONG_CHAT=0|1 forces it. */
export let LONG_CHAT!: ReturnType<typeof resolveLongChatKnobs>;
/** I-139 (electron/brain/i139-chat.ts): the card's name and language while its switch is on, the window's labels, the stranger line. */
export let i139Chat!: ReturnType<typeof i139ChatEdge>;
/** F7 说话节奏 (electron/brain/reply-rhythm-host.ts). */
export let replyRhythm!: ReplyRhythmHost;
/** R27 / F7 the reply's timing, numbers only (electron/brain/reply-latency.ts). */
export let replyLatency!: ReplyLatencyProbe;
/** Ordinary chat keeps one Claude Code process per conversation, one per character (I-186, electron/brain/session-pool/). */
export let claudeChat!: ClaudeSessionPool;
/** What the internal channel's get_diagnostics reads about her chat (2026-11-26): the recent reply timings, and the model her current Claude Code process reported. */
export const chatDiagnosticFacts = () => ({ replyLatency: () => replyLatency.recent(), chatModel: () => claudeChat.reportedModel() });
/** When Claude cannot answer (electron/brain/chat-outage.ts). */
export let chatOutage!: ReturnType<typeof createChatOutage>;
/** I-023 haiku 调度台 (electron/brain/module-router/). */
export let moduleRouter!: ReturnType<typeof createModuleRouter>;
/** F7 停停说说 (electron/brain/pause-talk/). */
export let pauseTalk!: ReturnType<typeof createPauseTalk>;
/** R41 chat settings (electron/brain/chat-settings.ts). */
export let chatSettings!: ChatSettingProposals;
/** Developer-mode log of chat turns that ended without a usable reply (electron/brain/chat-incident-log.ts). */
export let chatIncidents!: ChatIncidentLog;
/** The tasks in flight (a chat turn, a Claude task, an authoring's lease), by request id. */
export let pending!: Map<string, PendingTask>;

// Set by wireBrain (while electron/main.ts is evaluated, before anything below runs).
let needs!: BrainNeeds;

/** I-134 step 3: her own page about the user (electron/memory/her-note/), opening message only; none yet: nothing. */
export function longChatNote(scope: MemoryScope): string | null {
  return herNote?.noteFor(scope) || null;
}

/**
 * The authoring's lease (language research, personalize visual and body authoring): it takes the chat's one slot, so nothing else that talks
 * or listens can run beside it; refused (never queued) while anything is in flight. The release frees only its own lease.
 */
export function reserveCompanionAuthoring(owner:number,id:string,controller:AbortController,source:'language-authoring'|'visual-authoring'):()=>void {
  const { exiting, foregroundAsr, voiceHost, proactiveVision, replySpeechBusy, ambientSpeakingOwners, syncFatigueActivity } = needs; // read when called
  if (exiting || pending.size || asrTask || foregroundAsr.foregroundBusy || readingInputSpeech
    || voiceHost.busy || proactiveVision.pendingId || replySpeechBusy() || ambientSpeakingOwners.size)
    throw Error('当前对话、语音或任务仍在进行，请结束后再研究；不会打断或排队。');
  pending.set(id,{owner,controller,kind:'chat',source});syncFatigueActivity();
  return()=>{if(pending.get(id)?.controller===controller)pending.delete(id);syncFatigueActivity();};
}

/** One task (a chat turn): one of its kind at a time; its events go to the window that asked; it leaves `pending` when it settles. */
export function launchTask(
  id: string,
  kind: "chat" | "agent",
  owner: number,
  operation: (
    signal: AbortSignal,
    emit: (type: StreamEvent["type"], text: string) => void,
  ) => Promise<void>,
  onStarted?: () => void,
): void {
  const { syncFatigueActivity } = needs; // read when called
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("请求编号不正确。");
  if (pending.has(id) || [...pending.values()].some((t) => t.kind === kind))
    throw new Error("上一项任务仍在进行，请等待或停止。");
  const controller = new AbortController();
  pending.set(id, { controller, owner, kind });
  syncFatigueActivity();
  onStarted?.();
  const emit = (type: StreamEvent["type"], text: string) =>
    send(owner, { id, kind, type, text });
  void (async () => {
    try {
      await operation(controller.signal, emit);
      emit("done", "");
    } catch (error) {
      // Her own line instead of a technical error, and a category-only note for the developer log (electron/brain/chat-failure-event.ts).
      send(owner, chatFailureEvent({ id, kind, error, aborted: controller.signal.aborted, availability: chatAvailability, incidents: chatIncidents }));
    } finally {
      pending.delete(id);
      syncFatigueActivity();
    }
  })();
}

/** Ready-chain step (大脑): her conversation (the brain's core) and the sources it is handed, in the order the ready chain had them. */
export async function startCompanion(store: SettingsStore, characterCards: CharacterCardStore, appJournal: AppJournal,
  appSession: { begin(): Parameters<CompanionService['mood']['noteLastStop']>[0] }, characterResponses: CharacterResponseStore,
  safety: SafetyProvides['crisisCard'], watchAlong: SensesProvides['watchAlong'], herActions: ActionsProvides['herActions'], chatActions: ChatActionHost): Promise<void> {
  // The mood publish (electron/wiring/mood-wiring.ts publishMood): its steps in the order the old callback ran them (wireMoodPublish in electron/main.ts).
  companion = new CompanionService(store.directory, view => publishMood(view), { journal: appJournal });
  await companion.load();
  companion.mood.setTouchPort(touchBrain.moodPort); // I-136: her face for a pinch, and what to remember of each contact
  companion.mood.noteLastStop(appSession.begin()); // I-022: before she wakes, so her rest and the journal's 应用启动 line use one closed time
  companion.mood.setReplyRhythmSource(id => replyRhythm.view(id)); // F7: the developer panel's pace line
  companion.mood.setModuleRouterSource(() => moduleRouter.recent()); // I-023: the developer panel's 调度台 line
  companion.mood.setPauseTalkSource(() => pauseTalk.view()); // F7: the developer panel's 停停说说 lines
  companion.setWatchSource(() => watchAlong.kind()); // I-006 step 3
  companion.mood.setProactiveTalkSource(() => store?.current.proactiveTalk); // I-039: 少一点 = no busy-chat boost
  companion.setUserActivitySource(() => userActivity?.view() ?? null); // I-006: her boredom rises slower and her own life weighs by it while the user is absorbed
  companion.pose.setCoverYawn(() => herActions.issue('cover-yawn')); // I-006 第 2 步: a breather's sleepy yawn behind her hand (whole-body framing only, the stage decides)
  companion.setChatActions(chatActions); // skeleton step 5: the small actions this model can do join her reply's gesture words; the stage decides
  companion.setDraftFill(true); // F4: a reply the draft filter emptied gets one short line of her own (electron/brain/draft-fill.ts)
  companion.setSpeakOnly(speakOnlyAppJudge(SPEAK_ONLY_ON, async (prompt, system, signal) => (await quickLineWithClaude(prompt, system, signal)).text, () => reactions.speakOnlyWarm())); // I-098 speak-only (electron/brain/speak-only/rules.ts): the mood book is a second step on the reactions' warm haiku when it is there
  companion.setReplyOpening(APP_REPLY_OPENING); // I-046: only what she writes after the turn's opening marker is shown, read aloud and archived (electron/brain/reply-opening.ts)
  attachMood(companion); // 心情 (electron/wiring/mood-wiring.ts): I-027 the mood judge's developer line and observer, I-037 the reactions' port
  // 熟悉度: the active card decides whether she gets familiar slowly and how fast (its reaction tendencies).
  companion.setNicknameRoute(createNicknameRoute({ verdict: (requestId, moduleId) => moduleRouter.verdict(requestId, moduleId), relationship: companion.relationship, cardName: id => characterCards.publicState().cards.find(item => item.id === id)?.name ?? null })); // nicknames on the I-023 router
  companion.setLanguageSource(owner => cardLanguageOf(owner ? characterCards.getCard(owner) : characterCards.getActive())); // I-209 step 2: a turn's own card // I-071 v2: an English card adds one line to the session opening and is English chat to the draft guard
  companion.memory.setSpeakerSource(id => { try { return { characterId: id, name: characterCards.getCard(id).name }; } catch { return undefined; } }); // I-209 step 2: every line she says is archived as hers
  companion.memory.onStageLine(event => stageLine(event)); // I-209 step 4: on stage every said line is heard by the others and may be answered (electron/wiring/brain-stage-chat-wiring.ts)
  companion.stageMoods.setTemplateSource(id => effectiveCharacterMood(characterCards.getCard(id))); // I-209 step 2: someone on stage without a mood yet starts from her card
  companion.relationship.setCardSource(id => relationshipCardOf(characterCards.publicState().cards.find(item => item.id === id))); // on unless the card saved an explicit off
  // F6 "更真实的情绪": the card decides whether its paragraph joins the chat's opening block (electron/brain/companion.ts).
  companion.setRealerEmotionsSource(id => characterCards.publicState().cards.find(item => item.id === id)?.realerEmotions === true);
  companion.setSafety(safety.chat); // I-117: each message is read for danger signals (nothing kept): the card and her private lines
  companion.mood.setVisualBehaviorSource((id,semantic,_original,strength)=>{
    const model=store.current.model,receipt=visualGeneReceipt,profile=visualBehaviors?.effectiveProfile(id);
    if(!model||!receipt||receipt.generation!==bodyModelGeneration||receipt.path!==model.path||receipt.url!==model.url
      ||!profile?.enabled||profile.targetModelSha!==VISUAL_GENE_SHA||profile.semantic!==semantic||!profile.bindingId)return undefined;
    return {bindingId:profile.bindingId,strength:Math.min(strength,profile.strength)};
  });
  companion.mood.setResponseProfileSource(id => characterResponses.effectiveProfile(id));
  companion.mood.setFeedLineSource(() => feeding.host.lineMayFollow()); // #32: her I-019 line follows this bite: the sound after it stays a sound
  if (companion.mood.canMigrateTemplates()) await characterCards.ensureMoodTemplates(id => companion.mood.getSavedParameters(id));
  noteContextChatModel(store.current.provider.model); // I-222: what savedCompanionContext compares a saved chat model with
  await companion.context(characterCards.getActive().id, store.current.provider, store.current.persona, effectiveCharacterMood(characterCards.getActive()));
}

/** Saved step (大脑): the conversation takes the saved provider and persona (wireSaveSettings in electron/main.ts gives the order). */
export async function savedCompanionContext(): Promise<void> {
  const { store, characterCards } = needs; // read when called
  const change = companion.contextChange(characterCards.getActive().id, store.current.provider, store.current.persona);
  const restart = () => companion.context(characterCards.getActive().id, needs.store.current.provider, needs.store.current.persona);
  // 2026-11-25 (only the user cutting in interrupts her): a new connection or card text restarts her chat process, so it waits until her reply and its voice are done.
  if (change === 'connection' || change === 'persona') await settleWhenQuiet(change, restart); else await restart();
  // I-222: another chat model keeps her memory and conversation (not a context change); her process restarts with it once she is done.
  if (noteContextChatModel(store.current.provider.model) && change === 'same') await settleWhenQuiet('connection', () => claudeChat.close('context'));
}

/** Ready-chain step (大脑): her chat process follows a context change and her windows (closed on a new context, kept warm while she is seen). */
export function attachChatWindows(pet: BrowserWindow, controls: BrowserWindow): void {
  companion.onContextChange(() => { claudeChat.close('context'); chatSettings.invalidate(); takeMeThere.invalidate(); }); // I-186: closes only what the change concerns (session-pool/pool.ts close)
  companion.memory.onTurnsRemoved(scope => claudeChat.forgetCharacter(companion.memory.characterOfScope(scope))); // I-186: a deleted chat leaves her warm process, on stage or not
  const petForChat = pet;
  watchChatSeen(petForChat, seen => claudeChat.noteVisible(seen)); // I-171: a minimize counts as seen (the 10-minute idle rule); a tray hide stays the 3-minute one
  controls.on('show', () => claudeChat.prewarm('visible'));
  onUnboundModeChanged(state => { if (state !== 'normal') claudeChat.prewarm('fullscreen'); }); // 2026-11-22: out in full-screen: a spare is ready for her first line there (spawn only)
  claudeChat.prewarm('start'); // 2026-11-22: the ready chain runs once the active card is known: a spare for her first line, with no chat yet in this run
}

/** electron/main.ts calls this once, while it is evaluated, where it made her chat process (after 声音, whose voice call times it). */
export function wireBrain(given: BrainNeeds): PartHandle<BrainProvides> & { register(ipc: PartIpc): void } {
  needs = given;
  wireQuiet({ replying: () => [...pending.values()].some(task => task.kind === 'chat'), speaking: () => given.replySpeechBusy(),
    record: (what, during) => { given.appJournal.record({ type: 'setting-deferred', characterId: given.journalCharacterId(), what, during }); } }); // 2026-11-25
  const { installedDesktopChannel, voiceCall } = given; // taken once, as main.ts did
  // F7 说话节奏 (electron/brain/reply-rhythm-host.ts): one pace per reply, frozen with its voice; to the windows, the journal (E2) and the developer panel.
  replyRhythm = new ReplyRhythmHost({ send: pacing => broadcast('desk:reply-rhythm', pacing), journal: input => { needs.appJournal.record(input); },
    changed: id => companion?.mood.replyRhythmChanged(id) });
  // R27 developer-mode timing only: numbers, never text (see electron/brain/reply-latency.ts). F7: also while the experience journal is on, which
  // keeps each reply's first visible character (a number, the 停停说说 switch, whether background was carried); the dev log stays developer-only.
  replyLatency = new ReplyLatencyProbe({ enabled: () => !!companion?.mood.isDeveloperMode() || needs.store?.current.experienceJournal === true,
    heldForVoice: () => needs.store?.current.voice.enabled === true && bubbleFollowMode() !== 'off', // I-165: her bubble waits for her voice (the first character counts from the text's arrival)
    file: () => needs.store && companion?.mood.isDeveloperMode() ? path.join(needs.store.directory, 'dev', 'reply-latency.jsonl') : null, surface: () => needs.petReply,
    onRecord: record => {
      const first = firstCharTiming(record); // I-165: when the text arrived (a bubble that waited for her voice also says when it showed)
      if (record.status !== 'complete' || first === null || record.pauseTalk === undefined) return;
      pauseTalk.noteFirstChar(first.ms, record.pauseTalk, record.carried === true);
      needs.appJournal.record({ type: 'first-char', characterId: record.characterId ?? needs.journalCharacterId(), ms: first.ms, pauseTalk: record.pauseTalk, carried: record.carried === true, ...needs.journalExtras.firstChar(record), ...(first.shownMs === undefined ? {} : { shownMs: first.shownMs }) });
    } });
  SPEAK_ONLY_ON = speakOnlyEnabled(installedDesktopChannel?.channel, app.isPackaged); // I-098 她只管说话: development channel and source runs on, stable off
  LONG_CHAT = resolveLongChatKnobs(installedDesktopChannel?.channel, app.isPackaged, process.env); // I-134 新聊天 (shared/behaviors/long-chat/knobs.ts): development channel and source runs on, stable off; SOFT_HEARTS_LONG_CHAT=0|1 forces it
  i139Chat = i139ChatEdge({ on: () => getPromptSwitches().relaxed === true, card: () => needs.characterCards?.getActive(), openingMemory: scope => movingMemory?.openingFor(scope as MemoryScope) ?? null }); // I-139 (electron/brain/i139-chat.ts): the card's name and language while its switch is on, the window's labels, the stranger line; layer 2's slot (A3 supplies the thing that moved her most; null until then)
  { const switches = promptSwitchesFromEnv(promptSwitchDefaults(installedDesktopChannel?.channel, app.isPackaged), process.env); setPromptSwitches({ ...switches, relaxed: relaxedPromptsActive(switches, SPEAK_ONLY_ON) }); } // I-112 / I-115 (shared/brain/prompt-switches.ts): the prompt changes, on in the development channel and source runs, off in stable. I-139: getPromptSwitches().relaxed is true only when speak-only is on too
  const sessionRestarts = new SessionRestartLog({ enabled: () => !!companion?.mood.isDeveloperMode(), file: () => needs.store ? path.join(needs.store.directory, 'dev', 'session-restarts.jsonl') : null }); // prewarm (docs/claude/2026-11-15-prewarm-restart.md): one line per restart, numbers only
  const openingWindow = () => longChatHistory({ knobs: LONG_CHAT, archives: [companion.memory, textInvitationMemory], scope: companion.currentScope(), labels: i139Chat.labels(), language: i139Chat.cardLanguage() });
  claudeChat = new ClaudeSessionPool({ ...poolIdentity({ scope: owner => companion.ownerScope(owner), conversationId: owner => (owner && companion.conversationOf(owner)) || companion.conversationId, accepted: owner => ownerSpeechScope(companion, owner, needs.speechScope), // I-186: whose turn, who is on stage; I-209 step 2: the turn's own (task.session.owner)
    activeCharacter: () => needs.characterCards.getActive().id, providerScope: () => memoryProviderScope(needs.store.current.provider) }), provider: () => needs.store?.current.provider, chattedBefore: () => companionHasHistory(companion), onSpare: why => { needs.appJournal.record({ type: 'spare-process', characterId: needs.journalCharacterId(), why }); } /* free prewarm: one closed-words row per spare spawned */, timing: voiceCall.timing(replyLatency.claudeTiming()), availability: chatAvailability, longChat: LONG_CHAT, seenElsewhere: () => herHereNow() /* out in full-screen Unbound, or only covered (I-174: minimized): no 'hidden' close */, ...speakOnlySessionOptions(SPEAK_ONLY_ON),
    ...(LONG_CHAT.enabled ? { openingWindow, restartLog: entry => sessionRestarts.record(entry),
      // 2026-11-23 the paid prewarm step (docs/claude/2026-11-23-prewarm-paid.md): the opening as it is for the character on stage, read when a spare comes up for 'start' / 'switch'
      startOpening: () => startOpeningInput({ persona: () => needs.store?.current.persona, relationship: () => companion.relationship.opening(needs.characterCards.getActive().id, { firstTurn: false })?.text,
        note: () => longChatNote(companion.currentScope()), window: openingWindow, relaxed: () => i139Chat.relaxed(), openingMemory: () => i139Chat.openingMemory(companion.currentScope()) }) } : {}),
    ...(getPromptSwitches().relaxed === true && LONG_CHAT.enabled ? { onNewProcess: () => movingMemory?.handoff.noteNewProcess(), openingMemory: () => movingMemory?.openingFor(companion.currentScope()) ?? null } : {}) }); // prewarm: her archive's window for a replacement prepared while she is idle (off: nothing) // I-098 speak-only (off: the default system prompt) // I-139 A3: handoff of her most moving thing when a new process starts; a prepared opening reads the store as it is then (only where the new chat is on: typed chat reads it only then)
  claudeStartGate.observe(event => needs.appJournal.record({ type: 'claude-gate', characterId: needs.journalCharacterId(), event })); // I-202: one closed-word row per lost login
  observeClaudeStreamKinds(kind => needs.appJournal.record({ type: 'claude-stream-kind', characterId: needs.journalCharacterId(), ...kind })); // 2026-11-25: an unknown stream kind, names only
  observeClaudeEnvironment(names => needs.appJournal.record({ type: 'claude-env-dropped', characterId: needs.journalCharacterId(), names })); // 2026-11-25: started from a Claude Code session, its endpoint/credential names left out (once per run, never a value)
  // When Claude cannot answer (electron/brain/chat-outage.ts): her own words, the control window's status, and its fixed repair buttons.
  chatOutage = createChatOutage({ directory: () => needs.store.directory, provider: () => needs.store.current.provider, persona: () => compileCharacterPersona(needs.characterCards.getActive()),
    chatBusy: () => [...pending.values()].some(task => task.kind === 'chat'), publish: view => broadcast('desk:chat-availability', view), openExternal: target => shell.openExternal(target), run: streamClaude });
  // I-023 haiku 调度台 (electron/brain/module-router/): each user message is also read by haiku, in parallel with Opus (never before her first
  // character); modules act on its verdict after her reply. Only the message itself goes to haiku; the panel keeps names and times only.
  moduleRouter = createModuleRouter({ available: () => chatAvailability.isAvailable(), developerMode: () => !!companion?.mood.isDeveloperMode(),
    changed: () => companion?.mood.moduleRouterChanged() });
  // F7 停停说说 (electron/brain/pause-talk/): default off. On, each reply also asks haiku once, in parallel with Opus and never before her first
  // character, where she pauses and whether she stops to wait for the user; the windows apply it to the bubbles not shown yet.
  pauseTalk = createPauseTalk({ recentChat: proactiveChatFor(() => companion ? { companion, characterCards: needs.characterCards } : null, Date.now, 'judge'), /* I-205 */ enabled: () => needs.store?.current.voice.pauseTalk === true, available: () => chatAvailability.isAvailable(),
    mood: () => companion?.mood.get() ?? null, persona: () => { const card = needs.characterCards.getActive(); return `${card.personality} ${card.description}`; },
    send: cue => broadcast('desk:pause-talk', cue), developerMode: () => !!companion?.mood.isDeveloperMode(), changed: () => companion?.mood.pauseTalkChanged(),
    budget: () => companion?.budget ?? null }); // I-010: a quiet card asks haiku less often; going on alone after a wait draws from the budget
  // R41 chat settings: Claude may propose one change per reply; only a tap in the owning window applies it (electron/brain/chat-settings.ts).
  chatSettings = new ChatSettingProposals({ settings: () => needs.store.current, cards: () => needs.characterCards.publicState(), outside: () => unboundOutsideTurnLine() !== '', // I-159: out in Unbound the senses stay on (no card to turn one off)
    send: (owner, card) => { windows().find(win => win.webContents.id === owner)?.webContents.send('desk:chat-setting-card', card); offerUnboundCard(card); } }); // I-159 C: the same card beside her while she is out
  connectUnboundCardChooser(request => chatSettings.chooseMirrored(request)); // its tap goes through the same live card
  // Developer-mode log of chat turns that ended without a usable reply: time and category only (electron/brain/chat-incident-log.ts).
  chatIncidents = new ChatIncidentLog({ enabled: () => !!companion?.mood.isDeveloperMode(),
    file: () => needs.store ? path.join(needs.store.directory, 'dev', 'chat-incidents.jsonl') : null });
  pending = new Map<string, PendingTask>();
  connectUnboundReplyOwner(id => pending.get(id)?.characterId ?? null); // I-209 step 3: her reply's bubble goes to her own full-screen window

  return {
    id: 'brain',
    units: ['companion', 'claude-chat', 'chat-turn', 'chat-outage', 'module-router', 'pause-talk', 'reply-rhythm', 'reply-latency', 'chat-settings', 'chat-incidents', 'greeting-archive'],
    /**
     * Plan section 3: step 7's isolation never switches these off; their failure stays fatal. Her conversation (CompanionService, with the
     * chat archive and the mood host), her chat process, and the chat turn with its gates (pending / launchTask: one reply at a time,
     * archived once, a stopped or stale result never writes): switched off, she could neither answer nor be kept from answering twice.
     */
    core: ['companion', 'claude-chat', 'chat-turn'],
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      scopedHost('chooseChatSetting', (sender, request) => chatSettings.choose(sender, request), false);
      // Her small actions in a reply (skeleton step 5, electron/brain/chat-actions-host.ts; moved from electron/main.ts's registerIPC, step 5):
      // the agent channel's play_her_action plays one of the words she may pick, nothing else.
      host('playChatAction', word => { const { chatActions } = needs; /* read when called */ if (!isChatActionWord(word)) throw new Error('不是她会做的小动作。'); return chatActions.perform(word); }); // internal channel: play_her_action
      // C2/C3 (pretrial fixes 2026-11-03): either window refills its chat with her current conversation (electron/brain/companion.ts recentChat).
      host('getRecentChat', () => companion.recentChat(), false);
      host('newConversation', async () => {
        const { companionCommands, voiceHost, revokeVoice, stopSystemAudio, clearVisionContext, speechRuntime, clearReplySpeech, refreshVisionContext } = needs; // read when called
        companionCommands?.invalidate();
        userProfileManagement?.cancelPending();
        voiceHost.history = null;
        revokeVoice('scope-change');
        stopSystemAudio(); proactiveSpeechGate.cancel('conversation');
        clearVisionContext();
        speechRuntime.stop();
        clearReplySpeech();
        for (const task of pending.values()) if (task.kind === 'chat') task.controller.abort();
        await companion.newConversation();
        refreshVisionContext();
      }, false);
      // F7 developer listening trial (this run only): a slow reply's later system-voice sentences start after a short silence.
      host('setReplyRhythmVoiceTrial', on => {
        if (!companion?.mood.isDeveloperMode()) throw Error('只有开发者模式可以试听句间停顿。');
        const value = replyRhythm.setVoiceTrial(on === true, true); companion.mood.replyRhythmChanged(companion.mood.get().characterId); return value;
      }, false);
      registerChatAvailabilityIpc(host, chatOutage.host); // four fixed operations, no arguments (electron/brain/chat-availability-host.ts)
      const { speechScope } = needs; // made before the ready chain registers and never replaced
      const greetingArchive = new GreetingArchive({ enabled: LONG_CHAT.enabled, memory: () => companion?.memory ?? null, scope: () => companion.currentScope(), greeting: () => needs.characterCards.getActive().greeting ?? '', identity: speechScope, id: () => 'greeting-' + randomUUID(), journal: (characterId, why) => needs.appJournal.record({ type: 'character', characterId, event: why === 'first' ? 'greeting-first' : 'greeting-new-chat' }) }); scopedHost('rememberGreeting', () => greetingArchive.remember(), false); // I-134 step 1: her greeting, once shown, joins her archive (the text is the card's own; off: nothing)
      host("listModels", () => [...CLAUDE_MODEL_ALIASES]); // Claude-only: Claude Code's own aliases.
      registerChatTurn(ipc, needs); // the chat turn and its cancel (electron/wiring/brain-chat-wiring.ts)
    },
    provides: { longChatNote },
  };
}
