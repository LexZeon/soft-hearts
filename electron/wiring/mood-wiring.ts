// 心情's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4f.md):
// her mood and what reacts to it. Moved from electron/main.ts; the statements are the ones main.ts had.
// - The mood publish (publishMood, the callback CompanionService is made with): an ordered step list (wireMoodPublish), each step one
//   part's reaction in the order the old callback had them (electron/main.ts gives the list). The wiring golden reads the list in place
//   (order.moodPublish), so moving a step or running one twice changes it.
// - I-136 the touch brain and where touches go (setTouchSink, in early(): set while electron/main.ts is evaluated, as before), I-027 the
//   mood judge, I-037 the reactions, blush calibration (its store is made in the ready chain: startBlush), I-112 B the 更真实的情绪 expiry
//   watcher (startRealerExpiry), her tiredness (the sleep-entry activity bridge, its sync and her completed feeling), the mood tick's own
//   automatic-expression gate (companionCanExpress: the 1-second clock and the inner loop read it), the two sync steps (syncMood,
//   syncFatigue) and the mood host's handlers (register, inside the agent channel's recorder where main.ts registered them).
// - Her needs (她也会需要你) and the mood host itself are made inside CompanionService (electron/brain/companion.ts): the brain's core;
//   tears are drawn by the stage from the published view (src/mood/procedural-tears.ts). Neither has wiring of its own here.
// - What the lines read from the rest of the app comes through MoodNeeds (getters electron/main.ts gives): `needs.<value>` or
//   `const { … } = needs; // read when called`. The state other parts read is module-level and exported (live bindings electron/main.ts
//   reads: the ready chain loads, the clock ticks and before-quit disposes them where it always did).
// What stays in electron/main.ts and why (docs/claude/2026-11-16-wiring-step-4f.md): the order of the publish steps (wireMoodPublish; the
//   steps themselves are in their parts' wiring since step 5), the mood host's setters in the ready chain that hand it the other parts' sources,
//   and the 1-second clock. The sleep-entry flag is here since step 5b (fatigueActivityReady: the ready step startFatigueActivity opens it
//   after registerIPC, the quit step releaseFatigue closes it; docs/claude/2026-11-17-wiring-step-5b.md).
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, powerMonitor, type BrowserWindow } from 'electron';
import originalFs from 'original-fs';
import path from 'node:path';
import { DEFAULT_MOOD_PARAMETERS, validateMoodParameters } from '../../shared/foundation/mood';
import type { FatiguePhase, MoodView } from '../../shared/mood';
import type { AppSettings } from '../../shared/contracts';
import { acceptPetTouch, reportTouch, BlushCalibrationStore, type StageStateHost, createTouchBrain, createTrustedPackedModel, FatigueActivityBridge, setTouchSink, startRealerExpiryWatcher, verifiedFatigueBackground } from '../mood';
import { createMoodJudge } from '../mood/mood-judge/wiring';
import { createReactions } from '../mood/reactions/wiring';
import { chatAvailability, type CompanionService } from '../brain';
import type { AppJournal } from '../memory';
import type { CharacterCardStore } from '../cards';
import type { MotionLibrary } from '../actions';
import type { SettingsStore } from '../settings';
import type { PartIpc } from './ipc-wiring';
import { startUnit, startUnitSync, stepAs, type PartHandle } from './parts-wiring';
import { broadcast } from './shell-wiring';
import { proactiveChatFor } from './proactive-chat-wiring';
import { asrTask, listenTogether, readingInputSpeech, userInputUntil, type SensesNeeds, type SensesProvides } from './senses-wiring';
import { proactiveSpeechGate, rps, senseRouter } from './initiative-wiring';
import { connectUnboundBlush, senseFeeds, unbound, unboundShowsHer } from './unbound-wiring';
import { companionFact } from './unbound-senses-wiring';
import type { SafetyProvides } from './safety-wiring';
import type { VoiceProvides } from './voice-wiring';

type ReactionsWiring = Parameters<typeof createReactions>[0];

/** What 心情's lines read from the rest of the app (electron/main.ts gives getters; a value is read when it is used). */
export interface MoodNeeds {
  readonly store: SettingsStore;
  readonly companion: CompanionService;
  readonly characterCards: CharacterCardStore;
  readonly pet: BrowserWindow | null;
  readonly petWindowDrag: { readonly active: boolean } | null;
  readonly pending: SensesNeeds['pending'];
  readonly exiting: boolean;
  readonly appJournal: AppJournal;
  readonly motionLibrary: MotionLibrary;
  /** 安全's help card: the reactions' haiku call carries its closed danger field (taken once, when the reactions are made). */
  readonly safety: SafetyProvides['crisisCard'];
  /** I-098 她只管说话 (taken once). */
  readonly SPEAK_ONLY_ON: boolean;
  /** Her small actions (electron/main.ts's ChatActionHost, made after this part; read when the reactions ask). */
  readonly chatActions: ReturnType<ReactionsWiring['actions']>;
  // 声音 / 感知 (听): what is speaking or listening now
  readonly speechRuntime: VoiceProvides['speechRuntime'];
  readonly speechPlaybackActivity: VoiceProvides['speechPlaybackActivity'];
  readonly ambientSpeakingOwners: SensesProvides['ambientSpeakingOwners'];
  readonly foregroundAsr: SensesProvides['foregroundAsr'];
  // the other parts' functions (electron/main.ts's wrappers)
  herOnScreen(): boolean;
  replySpeechBusy(): boolean;
  speechScope(): string;
  journalCharacterId(): string | null;
  noteVisionUserActivity(): void;
  roughForTurn(): ReturnType<SensesProvides['roughForTurn']>;
  stopSystemAudio(): void;
  clearVisionContext(): void;
  clearReplySpeech(): void;
  /** 舞台: the view with her body pose (electron/main.ts withBodyPose). */
  withBodyPose(view: MoodView): MoodView;
  /** I-017: what the stage reports (electron/mood/her-state-host.ts StageStateHost, made in electron/main.ts with the her-state sources). */
  readonly stageState: StageStateHost;
  /** I-031: the colour-block log's start line (the installed channel and the build's commit). */
  readonly installedDesktopChannel: { readonly channel: string } | null;
  readonly buildCommit: string | null;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
}

/** What electron/main.ts calls (from mood.provides, so its ready chain and clock keep them as calls). */
export interface MoodProvides {
  /** Her tiredness learns what is going on now (chat, speech, a manual motion); the clock, the windows and the voice call it. */
  syncFatigueActivity(): void;
  /** Her tiredness for a reply's voice and pace, only while that reply's scope and card are still hers. */
  completedFatigueFeeling(scope: string, cardId: string): Readonly<{ phase: FatiguePhase }> | undefined;
}

// ---- state other parts read (live bindings electron/main.ts imports) ----
/** I-027 心情调整员 (electron/mood/mood-judge/). */
export let moodJudge!: ReturnType<typeof createMoodJudge>;
/** I-037 新的反应方式 (electron/mood/reactions/). */
export let reactions!: ReturnType<typeof createReactions>;
/** I-136 (electron/mood/touch/). */
export let touchBrain!: ReturnType<typeof createTouchBrain>;
/** Her tiredness's sleep-entry blockers (electron/mood/fatigue-activity.ts). */
export let fatigueActivity!: FatigueActivityBridge;
/** The sleep-entry activity is open: the ready chain opens it after registerIPC (startFatigueActivity), quitting closes it (releaseFatigue). */
export let fatigueActivityReady = false;
/** Per-model blush calibration (made in the ready chain: startBlush). */
export let blushCalibrations!: BlushCalibrationStore;
/** The model her mood was started for (syncMood starts it over for another; electron/main.ts's syncCharacter reads it). */
export let moodModel: string | null = null;

// Set by wireMood (while electron/main.ts is evaluated, before anything below runs).
let needs!: MoodNeeds;
// The sync step below calls this (set by wireMood, long before any sync).
let syncFatigueActivity!: () => void;
function keepForSteps(sync: () => void): void { syncFatigueActivity = sync; }
// The mood publish's steps, in order (wireMoodPublish; electron/main.ts gives them).
let moodPublishSteps: readonly ((view: MoodView) => void)[] = [];

/** The mood tick's existing automatic-expression gate (canExpress); the inner loop reuses it at each cue. */
export function companionCanExpress(): boolean {
  const { petWindowDrag, ambientSpeakingOwners, pending, herOnScreen, replySpeechBusy } = needs; // read when called
  return herOnScreen()
    && !petWindowDrag?.active && Date.now() >= userInputUntil
    && !replySpeechBusy() && ambientSpeakingOwners.size === 0 && !proactiveSpeechGate.busy
    && ![...pending.values()].some(task => task.kind === 'chat')
    && !rps.host.active; // G1: while you play, no other automatic line or motion cue starts
}

/** electron/main.ts gives the mood publish's steps once, in the order the old callback ran them (each step is one part's reaction). */
export function wireMoodPublish(steps: readonly ((view: MoodView) => void)[]): void { moodPublishSteps = Object.freeze([...steps].map(step => stepAs(step, 'callback'))); } // step 7: skipped while its unit is off
/** One mood publish: CompanionService calls it with each new view; every step, in order (a step that throws stops the rest, as before). */
export function publishMood(view: MoodView): void {
  for (const step of moodPublishSteps) step(view);
}
/** Mood publish step (心情): the mood judge sees the view as it is (falling asleep, waking, long silences, the user back…); it never applies anything here. */
export function judgeMood(view: MoodView): void {
  moodJudge.watch(view); // I-027
}

/** Ready-chain step: the per-model blush calibration store, with the reviewed packed Gene entry when the app is packed. */
export async function startBlush(store: SettingsStore, bundledAssetManifest: { readonly root: string; readonly model: { readonly relativePath: string; readonly bytes: number; readonly sha256: string } }): Promise<void> {
  await startUnit('mood', 'blush-calibration', async () => { // overhaul step 7: this unit's start, through the part runner
  // Only this app's reviewed packed Gene entry may use ASAR's size/type stats.
  // The backing archive is checked through original-fs for the process lifetime.
  const packedBlushModel = app.isPackaged && path.extname(app.getAppPath()).toLowerCase() === '.asar'
    ? await createTrustedPackedModel(app.getAppPath(),
      `assets/bundled/${bundledAssetManifest.root}/${bundledAssetManifest.model.relativePath}`,
      bundledAssetManifest.model, {
        realpath: file => originalFs.promises.realpath(file),
        lstat: file => originalFs.promises.lstat(file, { bigint: true }),
      })
    : undefined;
  blushCalibrations = new BlushCalibrationStore(store.directory, { packedModel: packedBlushModel });
  await blushCalibrations.load();
  });
}

/** Ready-chain step (I-112 B): 更真实的情绪 that ran out while closed was turned off inside load(); while running a short poll + resume does it (electron/mood/realer-expiry.ts). */
export function startRealerExpiry(characterCards: CharacterCardStore, mutate: MoodNeeds['mutate'], syncCharacter: (applyModel: boolean, previous: ReturnType<CharacterCardStore['getActive']>) => Promise<unknown>): void {
  startUnitSync('mood', 'realer-expiry', () => { // overhaul step 7: this unit's start, through the part runner
  const realerExpiry = startRealerExpiryWatcher({ expire: now => characterCards.expireRealerEmotions(now), next: () => characterCards.nextRealerExpiry(), now: Date.now, onExpired: () => mutate(async () => { await syncCharacter(false, characterCards.getActive()); }) });
  powerMonitor.on('resume', () => { void realerExpiry.wake(); });
  });
}

/** Ready-chain step: the mood host's developer line and observer for the mood judge, and the reactions' port. */
export function attachMood(companion: CompanionService): void {
  companion.mood.setMoodJudgeSource(() => moodJudge.host.view()); // I-027: the developer panel's 心情调整员 line
  companion.mood.setJudgeObserver(note => moodJudge.noteMood(note)); // I-027: each accepted pat, snack, message, Opus tail and lift
  reactions.attach(); // I-037: MoodHost holds the reaction port only while 新的反应方式 is on
}

/** Sync step (心情): her body shows with the companion; another model starts her mood over and stops what spoke for the old one. */
export function syncMood(s: AppSettings): void {
  const { companion, pet, speechRuntime, stopSystemAudio, clearVisionContext, clearReplySpeech } = needs; // read when called
  companion?.mood.setBodyVisible(!!pet && !pet.isDestroyed() && s.pet.visible);
  if (companion && (s.model?.path ?? null) !== moodModel) {
    stopSystemAudio();
    clearVisionContext();
    speechRuntime.stop();
    clearReplySpeech();
    moodModel = s.model?.path ?? null;
    companion.mood.invalidate();
  }
}
/**
 * Ready step (心情), right after registerIPC: sleep entry stayed failed closed (as if a chat, speech and a manual motion were always on)
 * until renderer playback reported its own lifetime. It does now (begin/endSpeechPlaybackActivity from src/voice/VoiceOutput.ts), so the
 * real state counts from here. Without this she could only ever get drowsy and never fall asleep (found 2026-11-09).
 */
export function startFatigueActivity(store: SettingsStore): void {
  startUnitSync('mood', 'fatigue-activity', () => { // overhaul step 7: this unit's start, through the part runner
  fatigueActivityReady = true;
  fatigueActivity.setSelection(store.current);
  syncFatigueActivity();
  });
}
/** Quit step (心情; electron/main.ts's wireQuit gives the order): sleep entry closes; the activity bridge ends. */
export function releaseFatigue(): void {
  fatigueActivityReady = false;
  fatigueActivity.dispose();
}
/** Quit step (心情): the mood judge and the reactions end. */
export function disposeMoodJudges(): void {
  void moodJudge.dispose();
  void reactions.dispose();
}
/** Sync step (心情): tiredness follows the selection. */
export function syncFatigue(s: AppSettings): void {
  fatigueActivity.setSelection(s);
  syncFatigueActivity();
}

/** electron/main.ts calls this once, while it is evaluated, where it made the reactions (after 安全's help card and 主动's sense router, before 感知 takes the judge and the reactions). */
export function wireMood(given: MoodNeeds): PartHandle<MoodProvides> & { early(): void; register(ipc: PartIpc): void } {
  needs = given;
  const { replySpeechBusy, speechScope, journalCharacterId, noteVisionUserActivity, roughForTurn, withBodyPose, mutate } = given;
  // I-027 心情调整员 (electron/mood/mood-judge/): default off. On, what happens to her still takes effect at once; a minute or two later haiku
  // adjusts her five mood numbers a little (bounded, at most knobs.callsPerDay calls a day). Never while she sleeps, the companion is hidden, Claude
  // is down, 自动表现 is off or a test mood holds; only categories, numbers and the user's own message (cut short) go to haiku.
  const judgeChat = proactiveChatFor(() => needs.companion ? { companion: needs.companion, characterCards: needs.characterCards } : null, Date.now, 'judge'); // I-205: the same recent chat the inner loop reads, for the three small judges
  moodJudge = createMoodJudge({ recentChat: judgeChat, directory: () => needs.store ? needs.store.directory : null, mood: () => needs.companion?.mood ?? null,
    persona: () => { const card = needs.characterCards.getActive(); return `${card.personality} ${card.description}`; },
    petVisible: () => needs.herOnScreen() /* 2026-11-21: she is seen in the companion window or out in Unbound; the judge only nudges numbers */, available: () => chatAvailability.isAvailable(),
    busy: () => [...needs.pending.values()].some(task => task.kind === 'chat'), developerMode: () => !!needs.companion?.mood.isDeveloperMode(),
    changed: () => needs.companion?.mood.moodJudgeChanged(), broadcast: view => broadcast('desk:mood-judge', view),
    screen: () => roughForTurn() ?? null, songs: () => listenTogether ? listenTogether.counts.segment : null, skipMessages: () => reactions.on() });
  // I-037 新的反应方式 (electron/mood/reactions/): on by default in every version (stable was off before). On, each user message also asks haiku once,
  // after her first character, for 0–2 reactions from the reaction table and the message's mood (0.7; her tail 0.3).
  reactions = createReactions({ recentChat: judgeChat, played: entry => touchBrain?.reactionPlayed(entry), /* I-136 */ safety: needs.safety.reactionPort, senses: senseRouter.host.port, directory: () => needs.store ? needs.store.directory : null, defaultEnabled: true, speakOnly: needs.SPEAK_ONLY_ON, mood: () => needs.companion?.mood ?? null,
    persona: () => { const card = needs.characterCards.getActive(); return `${card.personality} ${card.description}`; }, petVisible: () => { const { pet } = needs; /* read when called */ return !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized(); },
    available: () => chatAvailability.isAvailable(), actions: () => needs.chatActions, journal: entry => { needs.appJournal.record(entry); }, broadcast: view => broadcast('desk:reactions', view),
    chatBusy: () => [...needs.pending.values()].some(task => task.kind === 'chat'), // the warm haiku is never started or rebuilt while her reply runs
    stage: cue => { const { pet } = needs; /* read when called */ if (!pet || pet.isDestroyed() || !pet.isVisible() || pet.isMinimized()) return false; pet.webContents.send('desk:reaction', cue); return true; },
    petSender: () => needs.pet && !needs.pet.isDestroyed() ? needs.pet.webContents.id : null });
  // I-136 (Unbound v1 step 2, docs/claude/2026-11-15-unbound-v1-step2-touch.md): a click (later a pull) from Unbound or the companion window → her face and a reaction
  // picked locally, a small nudge to her mood, and maybe a word through the inner loop (companion: the usual caps; Unbound: none). Every reader is lazy.
  touchBrain = createTouchBrain({ mood: () => needs.companion?.mood ?? null, dispositions: view => reactions.dispositionsFor(view), reactions: () => reactions.host,
    place: () => unbound && unbound.state !== 'normal' ? 'unbound' : 'pet', journal: row => { needs.appJournal.record({ type: 'touch', ...row }); } });
  // Her tiredness: what blocks falling asleep (a chat, speech, a manual motion), published to the mood host.
  fatigueActivity = new FatigueActivityBridge(
    value => needs.companion?.mood.setFatigueActivity(value),
    asset => verifiedFatigueBackground(asset, needs.motionLibrary),
  );
  function syncFatigueActivity(): void {
    const { companion, store, speechPlaybackActivity, exiting, pending, foregroundAsr, ambientSpeakingOwners } = needs; // read when called
    let currentScope='';
    try { if(companion && store)currentScope=speechScope(); } catch { /* Context transition stays unbound. */ }
    speechPlaybackActivity.setScope(currentScope);
    fatigueActivity.setActivity({initialized:fatigueActivityReady && !exiting,
      chat:Date.now() < userInputUntil || [...pending.values()].some(task => task.kind === 'chat')
        || !!asrTask || foregroundAsr.foregroundBusy || readingInputSpeech,
      tts:replySpeechBusy() || ambientSpeakingOwners.size > 0 || speechPlaybackActivity.busy});
  }
  function completedFatigueFeeling(scope: string, cardId: string): Readonly<{phase:FatiguePhase}> | undefined {
    const { characterCards, companion } = needs; // read when called
    if(scope !== speechScope() || cardId !== characterCards.getActive().id)return undefined;
    const view=companion.mood.get(),phase=view.fatigue?.phase;
    if(view.characterId !== cardId || !phase || !['awake','light-drowsy','drowsy','falling-asleep','asleep','micro-awake'].includes(phase))return undefined;
    return Object.freeze({phase});
  }
  keepForSteps(syncFatigueActivity);

  return {
    id: 'mood',
    units: ['mood-judge', 'reactions', 'touch', 'fatigue-activity', 'blush-calibration', 'realer-expiry'],
    /** Overhaul step 7: the handlers of each unit that can be switched off (they answer PART_OFF while it is off). */
    ipc: { 'mood-judge': ['getMoodJudge', 'setMoodJudge'], reactions: ['getReactions', 'reactionResult', 'setReactions', 'getReactionDispositions', 'setReactionDispositions'],
      'blush-calibration': ['getBlushCalibration', 'setBlushCalibration'] },
    /** I-136: where touches go is set while electron/main.ts is evaluated, as before (the touch brain reads everything lazily). */
    early(): void { setTouchSink(event => touchBrain.touch(event)); },
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      host('getMood', () => { const { companion } = needs; /* read when called */ return withBodyPose(companion.mood.get()); }, false);
      host('setMoodDeveloperMode', enabled => needs.companion.mood.setDeveloperMode(enabled), false);
      host('setMoodExpressions', enabled => {
        const { companion } = needs; // read when called
        const view = companion.mood.setExpressions(enabled);
        if (!view.expressions) noteVisionUserActivity();
        return view;
      }, false);
      // Her music tier (src/stage/MmdStage.ts onMusicTier): from the companion window only; a closed tier and a score.
      scopedHost('noteMusicTier', (sender, value) => { const { pet, companion, appJournal } = needs; /* read when called */ if (!companionFact('music-tier', sender === pet?.webContents.id)) return false; companion?.mood.moments.musicTier(value); return appJournal.musicTier(value, journalCharacterId()); }, false); // 心情第二批: a dance or a song she nodded to that ended lifts her a little
      senseFeeds.tier = value => { const { companion, appJournal } = needs; /* read when called */ companion?.mood.moments.musicTier(value); return appJournal.musicTier(value, journalCharacterId()); }; // batch F: her full-screen page's tier, the same path (not twice: the companion window's is not taken while she is out)
      const saveActiveMoodParameters = (value: unknown, expected: unknown) => mutate(async () => {
        const { companion, characterCards } = needs; // read when called
        companion.mood.assertParameterIdentity(expected);
        if (!companion.mood.isDeveloperMode()) throw new Error('请先开启开发者模式。');
        const parameters = validateMoodParameters(value);
        const id = characterCards.getActive().id;
        // The card is the durable template; mood-state keeps only this role's
        // private simulation and a compatible parameter cache for older versions.
        const state = await characterCards.saveMoodParameters(id, parameters);
        companion.mood.applyTemplate(id, parameters);
        broadcast('desk:characters', state);
        return companion.mood.get();
      });
      host('setMoodParameters', (parameters, expected) => saveActiveMoodParameters(parameters, expected), false);
      host('restoreMoodParameters', expected => saveActiveMoodParameters(DEFAULT_MOOD_PARAMETERS, expected), false);
      host('getBlushCalibration', async () => {
        const { store } = needs; // read when called
        const model = store.current.model?.path;
        const key = model ? await blushCalibrations.keyForModel(model) : null;
        if (model !== store.current.model?.path) throw new Error('模型已切换，请重新读取红晕校准。');
        return blushCalibrations.get(key);
      }, false);
      // Batch A (docs/claude/2026-11-21-unbound-full-ACH.md): her full-screen blush reads the same calibration, by the same rule as the handler above (read only).
      connectUnboundBlush(async () => {
        const model = needs.store.current.model?.path;
        const key = model ? await blushCalibrations.keyForModel(model) : null;
        if (model !== needs.store.current.model?.path) throw new Error('模型已切换，请重新读取红晕校准。');
        return blushCalibrations.get(key);
      });
      host('setBlushCalibration', (expectedKey, value) => mutate(async () => {
        const { store } = needs; // read when called
        const model = store.current.model?.path;
        const key = model ? await blushCalibrations.keyForModel(model) : null;
        if (!key || key !== expectedKey) throw new Error('模型已切换，请重新读取红晕校准。');
        const view = await blushCalibrations.set(key, value);
        broadcast('desk:blush-calibration', view);
        return view;
      }));
      scopedHost('moodInteraction', (sender, value) => {
        const { pet, petWindowDrag, store, companion } = needs; // read when called
        const ending = value?.type === 'phase' && value?.phase === 'idle';
        if (sender !== pet?.webContents.id || !pet.isVisible() || pet.isMinimized() || (petWindowDrag?.active && !ending) || !store.current.model)
          throw new Error('只有可交互的桌宠窗口可以提交直接互动。');
        const view = companion.mood.interaction(value);
        noteVisionUserActivity();
        return view;
      }, false);
      moodJudge.register(scopedHost); // I-027: the 心情调整员 switch (control window; the agent channel calls the same operation)
      reactions.register(scopedHost); // I-037: the switch (隐私与设置) and the six 反应倾向 (角色页); the agent channel calls the same operations
      { // I-017 her state and I-031 the colour-block log, moved from electron/main.ts's registerIPC (wiring rewrite step 5); what they read is set
        // before registerIPC and not replaced later.
        const { pet, stageState, installedDesktopChannel, buildCommit } = needs;
        scopedHost('noteStageState', (sender, value) => sender === pet?.webContents.id && stageState.accept(value), false); // I-017: only the companion window
        stageState.followOut(unboundShowsHer); senseFeeds.stage = value => stageState.acceptOut(value); // 2026-11-24: while she is out, her full-screen page says what her body does
        scopedHost('petTouch', (sender, value) => acceptPetTouch(sender, pet, value, reportTouch), false); // I-136 5a 拉她: only the shown companion window
        // I-031 色块诊断日志 (temporary, local only): companion window only; electron/mood/color-block-log.ts checks, caps and writes it under
        // %LOCALAPPDATA%\soft-hearts-diagnostics, never into a profile. Loaded here so removing it later is this block and that module.
        const colorBlockLog = import('../mood/color-block-log').then(m => m.createColorBlockLog({ channel: installedDesktopChannel?.channel, version: app.getVersion(), commit: buildCommit }));
        scopedHost('noteColorBlock', (sender, value) => colorBlockLog.then(log => log.note(sender, pet?.webContents.id, value), () => false), false);
      }
    },
    provides: { syncFatigueActivity, completedFatigueFeeling },
  };
}
