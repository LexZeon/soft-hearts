// 设置's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4a.md):
// the companion commands (pin her on top, show or hide her, breath, follow the mouse, the read-aloud volume, framing, stop reading: the
// targets they check, their serialized commits and the revisions that make a stale choice expire), sync, and the whole-settings save.
// Moved from electron/main.ts; the functions' statements are the ones main.ts had, each reading what it needs from SettingsNeeds when it
// is called (getters electron/main.ts gives).
// sync and saveSettings fan a settings change out to every part. Each is now an ordered list of steps electron/main.ts gives
// (wireSettingsSync, wireSaveSettings), in the order its old body had them; the wiring golden expands the lists in place and pins them
// (tests/fixtures/wiring-golden.json order.saveSettings, order.sync). The settings part's own steps are the exported functions below.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { createHash, randomUUID } from 'node:crypto';
import { app, screen, type BrowserWindow } from 'electron';
import path from 'node:path';
import { setUiLanguage } from '../../shared/foundation/ui-language';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { compileCharacterPersona } from '../../shared/cards';
import type { AppSettings } from '../../shared/contracts';
import type { MediaOwner } from '../../shared/foundation/runtime-state';
import type { CompanionCommandAction } from '../../shared/settings';
import { sameFramingCamera } from '../../shared/stage';
import { classifyCompanionCommand, CompanionCommandHost, formatCompanionCommandReceipt, preserveStaleAssetClears, publicSettings, validateAssetBaseline,
  validateSettings, UiLanguageStore, applyFirstLanguageHint, type CommandCommitResult, type SettingsStore } from '../settings';
import type { UserProfileManagement } from '../memory';
import type { CompanionService } from '../brain';
import { applyPetTopmost, fittedPetScale, PetFramingHost, petViewSettings } from '../stage';
import type { CharacterCard } from '../../shared/cards';
import { memoryProviderScope } from '../foundation/memory-provider-scope';
import type { PartIpc } from './ipc-wiring';
import { stepAs, type PartHandle } from './parts-wiring';
import { broadcast, windows } from './shell-wiring';
import type { SensesProvides } from './senses-wiring';
import type { VoiceProvides } from './voice-wiring';
import type { ActionsNeeds } from './actions-wiring';
import type { MotionLibrary } from '../actions';
import type { CardsProvides } from './cards-wiring';

/** What the settings wiring reads from the rest of the app (electron/main.ts gives getters; each is read when it is used). */
export interface SettingsNeeds {
  readonly store: SettingsStore;
  readonly pet: BrowserWindow | null;
  readonly characterCards: { getActive(): CharacterCard };
  /** 声音: the reply being read aloud (electron/voice/completed-reply-speech.ts CompletedReplySpeech), for 「别读了」. */
  readonly completedReplySpeech: { captureReadout(scope: string): object | null; identity(): { readonly id: string } | null };
  speechScope(): string;
  cancelCompletedReply(id?: string, by?: 'stop'): boolean;
  /** Unbound: her companion window hidden only because she is out. */
  petHeld(): boolean;
  /** 舞台: the companion window's visibility as the windows see it (electron/main.ts nativeVisibility). */
  nativeVisibility(win: BrowserWindow): { readonly visible: boolean; readonly revision: number };
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  activateUserProfile(): Promise<void>;
  // What 恢复默认设置 (resetSettings) stops, clears and resets before the factory settings are written.
  readonly voiceHost: SensesProvides['voiceHost'];
  readonly speechRuntime: VoiceProvides['speechRuntime'];
  readonly motionLibrary: MotionLibrary;
  readonly pending: ReadonlyMap<string, { readonly controller: AbortController }>;
  readonly media: SensesProvides['media'];
  readonly bundledAssets: { getDefaultAssets(): Promise<Pick<AppSettings, 'model' | 'motion'>> };
  readonly assets: ActionsNeeds['assets'];
  readonly userProfileManagement: UserProfileManagement | undefined;
  readonly companion: CompanionService;
  clearVisionContext: SensesProvides['clearVisionContext'];
  setVisionSupported(value: boolean): void;
  stopSystemAudio: SensesProvides['stopSystemAudio'];
  clearReplySpeech: VoiceProvides['clearReplySpeech'];
  /** 身体动作: motion selections made for the old settings are stale. */
  noteModelSelection(): void;
  /** The session's camera permission (electron/main.ts: the window events and the permission handler read it too). */
  setCameraEnabled(value: boolean): void;
  mediaChanged: SensesProvides['mediaChanged'];
  forgetScreenSelection: SensesProvides['forgetScreenSelection'];
  adoptCharacterForModel: CardsProvides['adoptCharacterForModel'];
}
/** What the rest of the app uses from the settings part. */
export interface SettingsProvides {
  /** Every part catches up with the settings now in the store (the steps electron/main.ts gave, in order); `exclude` gets no settings broadcast. */
  sync(exclude?: number): void;
  fitSettingsScale(settings: AppSettings): AppSettings;
  companionCommandContext(sender: number): string;
  noteCompanionTopmostWrite(previous: boolean): void;
  commitCompanionVisibility(value: boolean): Promise<CommandCommitResult>;
  commitCompanionCommand(value: boolean, actionId: CompanionCommandAction['actionId']): Promise<CommandCommitResult>;
  commitCompanionReadoutVolume(percent: number): Promise<CommandCommitResult>;
  commitCompanionBreath(request: number | true): Promise<CommandCommitResult>;
  readonly companionCommandExpiry: ReturnType<typeof setTimeout> | null;
}

/** The interface language (its own small store in the profile); made in the ready chain (startUiLanguage). */
export let uiLanguage: UiLanguageStore;

/** Ready-chain step (设置): the interface language, right after the settings load and before the cards (an English interface starts with English Gene). */
export async function startUiLanguage(store: SettingsStore): Promise<void> {
  uiLanguage = new UiLanguageStore(path.join(store.directory, 'ui-language-settings.json'), app.getLocale());
  await applyFirstLanguageHint(app.getAppPath(), store.directory, uiLanguage); // I-219: a first-install language choice becomes the saved preference, once
  setUiLanguage((await uiLanguage.load()).language);
}

/** One step of saving the whole settings form, before it is written: it may change the form or stop what the change ends. */
export type SavePrepareStep = (next: AppSettings, baseline: unknown, store: SettingsStore) => void;
/** One step after the form is written. */
export type SaveAppliedStep = () => void | Promise<void>;
/** One part catching up in sync with the settings now in the store. */
export type SyncStep = (s: AppSettings, exclude?: number) => void;

let savePrepare: readonly SavePrepareStep[] = [];
let saveApplied: readonly SaveAppliedStep[] = [];
let syncSteps: readonly SyncStep[] = [];

/** electron/main.ts gives the save's steps once, in the order the old saveSettings had them. */
export function wireSaveSettings(prepare: readonly SavePrepareStep[], applied: readonly SaveAppliedStep[]): void {
  savePrepare = Object.freeze([...prepare]);
  saveApplied = Object.freeze([...applied]);
}
/** electron/main.ts gives sync's steps once, in the order the old sync had them. */
export function wireSettingsSync(steps: readonly SyncStep[]): void { syncSteps = Object.freeze([...steps].map(step => stepAs(step, 'cleanup'))); } // step 7: each its unit's cleanup

/** Save step (settings): the form never overwrites what has its own intent (shown, on top, the inner loop, the journal, the size). */
export function keepHostIntents(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  // Visibility is an explicit host intent, never a stale whole-form field.
  next.pet.visible = store.current.pet.visible;
  // Topness is a dedicated intent from either window, not a stale form field.
  next.pet.alwaysOnTop = store.current.pet.alwaysOnTop;
  // The inner-loop switch is a dedicated intent (setInnerLoop), never a stale form field.
  next.innerLoop = store.current.innerLoop;
  // 体验记录: its own intent (setExperienceJournal), never a stale form field.
  next.experienceJournal = store.current.experienceJournal === true;
  // Independent dimensions belong to the host gesture, not a stale full
  // settings form queued while a corner was held. Legacy scale is explicit.
  next.pet.size = next.pet.scale === store.current.pet.scale ? store.current.pet.size : undefined;
}
/** Save step (settings): an asset the form cleared while it was stale stays (the window's baseline). */
export function keepStaleAssetClears(next: AppSettings, baseline: unknown, store: SettingsStore): void {
  if (baseline !== undefined) {
    preserveStaleAssetClears(next, store.current, validateAssetBaseline(baseline));
  }
}
/** Save step (settings): another model drops the motion picked for the old one. */
export function modelChangeClearsMotion(next: AppSettings, _baseline: unknown, store: SettingsStore): void {
  if (next.model?.path !== store.current.model?.path) { next.motion = null; next.motionLayers = undefined; }
}
/** Sync step (settings): every window but the one that saved gets the public settings. */
export function broadcastSettings(s: AppSettings, exclude?: number): void {
  broadcast("desk:settings", publicSettings(s), exclude);
}
/** The companion commands' host (made when register runs, in registerIPC): the chat turn, the window steps and quitting use it. */
export let companionCommands: CompanionCommandHost | null = null;
/** The open command choices expire after a minute (this timer refreshes the host); quitting clears it. */
let companionCommandExpiry: ReturnType<typeof setTimeout> | null = null;
/** Visibility step (wiring rewrite step 5b; electron/main.ts's wireWindowEvents gives the order): open command choices are re-checked. */
export function refreshCompanionCommands(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  companionCommands?.refresh();
}
/** Window step: a page that is new or gone ends the open command choices. */
export function invalidateCompanionCommands(win: BrowserWindow, owner: MediaOwner, windowId: number): void {
  companionCommands?.invalidate();
}
/** Before quit (settings): the open command choices end; their expiry timer goes. */
export function releaseCompanionCommands(): void {
  companionCommands?.invalidate();
  if (companionCommandExpiry) clearTimeout(companionCommandExpiry);
}

export function wireSettings(needs: SettingsNeeds): PartHandle<SettingsProvides> & { register(ipc: PartIpc): void } {
  let petFraming: PetFramingHost | null = null;
  let companionCommandRevision = 0;
  let companionCommandObservedTop: boolean | undefined;
  let companionVisibilityRevision = 0;
  let companionVisibilityObserved: boolean | undefined;
  let companionBreathRevision = 0;
  let companionBreathObserved: number | undefined;
  let companionFollowMouseRevision = 0;
  let companionFollowMouseObserved: boolean | undefined;
  let companionReadoutVolumeRevision = 0;
  let companionReadoutVolumeObserved: number | undefined;
  function noteCompanionTopmostWrite(previous: boolean): void {
    const { store } = needs; // read when called
    if (previous !== store.current.pet.alwaysOnTop) companionCommandRevision++;
    companionCommandObservedTop = store.current.pet.alwaysOnTop;
  }
  function noteCompanionVisibilityWrite(previous: boolean): void {
    const { store } = needs; // read when called
    if (previous !== store.current.pet.visible) companionVisibilityRevision++;
    companionVisibilityObserved = store.current.pet.visible;
  }
  function noteCompanionBreathWrite(previous: number): void {
    const { store } = needs; // read when called
    if (previous !== store.current.pet.breath) companionBreathRevision++;
    companionBreathObserved = store.current.pet.breath;
  }
  function noteCompanionFollowMouseWrite(previous: boolean): void {
    const { store } = needs; // read when called
    if (previous !== store.current.pet.followMouse) companionFollowMouseRevision++;
    companionFollowMouseObserved = store.current.pet.followMouse;
  }
  function noteCompanionReadoutVolumeWrite(previous: number): void {
    const { store } = needs; // read when called
    if (previous !== store.current.voice.volume) companionReadoutVolumeRevision++;
    companionReadoutVolumeObserved = store.current.voice.volume;
  }
  function companionCommandContext(sender: number): string {
    const { store, pet, characterCards } = needs; // read when called
    return createHash('sha256').update(JSON.stringify([sender, pet?.webContents.id ?? null,
      characterCards.getActive().id, store.current.model?.path ?? '', store.current.model?.url ?? '',
      memoryProviderScope(store.current.provider)])).digest('hex');
  }
  function companionCommandTarget(sender: number, actionId: CompanionCommandAction['actionId'] = 'pet.set-always-on-top', completingOwnHide = false) {
    const { store, pet, nativeVisibility } = needs; // read when called
    const caller = windows().find(win => win.webContents.id === sender);
    if (actionId === 'pet.set-visible') {
      if (!caller || !pet || pet.isDestroyed()) return null;
      // An issued hide may hide its own companion sender, but cannot excuse lost controls,
      // navigation, changed targets or a different operation's cancellation.
      const ownHiddenPet = completingOwnHide && caller === pet;
      if ((!caller.isVisible() || caller.isMinimized()) && !ownHiddenPet) return null;
      const view = nativeVisibility(pet);
      return { contextId: companionCommandContext(sender), value: store.current.pet.visible,
        revision: companionVisibilityRevision + view.revision };
    }
    if (actionId !== 'pet.set-always-on-top' && actionId !== 'pet.set-follow-mouse') return null;
    if (!caller || !caller.isVisible() || caller.isMinimized() || !pet || pet.isDestroyed()
      || !pet.isVisible() || pet.isMinimized() || !store.current.pet.visible) return null;
    return actionId === 'pet.set-follow-mouse'
      ? { contextId: companionCommandContext(sender), value: store.current.pet.followMouse, revision: companionFollowMouseRevision }
      : { contextId: companionCommandContext(sender), value: store.current.pet.alwaysOnTop, revision: companionCommandRevision };
  }
  function companionBreathTarget(sender: number) {
    const { store, pet } = needs; // read when called
    const caller = windows().find(win => win.webContents.id === sender), value = store.current.pet.breath;
    if (!caller || !caller.isVisible() || caller.isMinimized() || !pet || pet.isDestroyed()
      || !Number.isFinite(value) || value < 0 || value > 1) return null;
    // Saving an existing setting does not require or restore visible animation.
    return { contextId: companionCommandContext(sender), value, revision: companionBreathRevision };
  }
  function companionFramingTarget(sender: number) {
    const caller = windows().find(win => win.webContents.id === sender);
    if (!caller || !caller.isVisible() || caller.isMinimized()) return null;
    const target = petFraming?.target();
    return target ? { ...target, contextId: companionCommandContext(sender) + ':' + target.contextId } : null;
  }
  function companionReadoutVolumeTarget(sender: number) {
    const { store } = needs; // read when called
    const caller = windows().find(win => win.webContents.id === sender);
    const value = store.current.voice.volume;
    if (!caller || !caller.isVisible() || caller.isMinimized() || !Number.isFinite(value) || value < 0 || value > 1) return null;
    return { contextId: companionCommandContext(sender), value, revision: companionReadoutVolumeRevision };
  }
  function companionReadoutStopTarget(sender: number) {
    const { completedReplySpeech, speechScope } = needs; // read when called
    const caller = windows().find(win => win.webContents.id === sender);
    if (!caller || !caller.isVisible() || caller.isMinimized()) return null;
    return { contextId: companionCommandContext(sender), value: false as const, revision: 0 as const,
      identity: completedReplySpeech.captureReadout(speechScope()) };
  }
  function stopCompanionReadout(identity: object | null): 'stopped' | 'no-current' | 'unknown' {
    const { completedReplySpeech, speechScope, cancelCompletedReply } = needs; // read when called
    const live = completedReplySpeech.captureReadout(speechScope());
    if (live !== identity) return 'unknown';
    if (!live) return 'no-current';
    const current = completedReplySpeech.identity();
    if (!current) return 'unknown';
    return cancelCompletedReply(current.id, 'stop') ? 'stopped' : 'unknown';
  }
  async function commitCompanionTopmost(value: boolean): Promise<CommandCommitResult> {
    const { store } = needs; // read when called
    const target = needs.pet;
    if (!target || target.isDestroyed()) return { persistence: 'not-committed', presentation: 'not-requested' };
    const previous = store.current.pet.alwaysOnTop;
    const persistence = previous === value ? 'unchanged' : 'saved';
    if (previous !== value) {
      try { await store.persist({ ...store.current, pet: { ...store.current.pet, alwaysOnTop: value } }); }
      catch { return { persistence: 'unknown', presentation: 'not-requested' }; }
      noteCompanionTopmostWrite(previous);
    }
    let presentation: CommandCommitResult['presentation'] = 'failed';
    try {
      if (target === needs.pet && !target.isDestroyed()) {
        applyPetTopmost(target, value);
        presentation = target.isAlwaysOnTop() === value ? 'applied' : 'failed';
      }
    } catch { /* The successful persist above must not be rolled back. */ }
    // No whole-settings normalization, visibility, geometry or other media/presentation sync.
    try { broadcast('desk:settings', publicSettings(store.current)); }
    catch { presentation = 'unknown'; }
    return { persistence, presentation, value: store.current.pet.alwaysOnTop };
  }
  /** The same serialized visibility intent serves manual controls and text commands.
   * Desired persistence and actual native visibility remain separate observations. */
  async function commitCompanionVisibility(value: boolean): Promise<CommandCommitResult> {
    const { store, nativeVisibility, petHeld } = needs; // read when called
    const target = needs.pet;
    if (!target || target.isDestroyed()) return { persistence: 'not-committed', presentation: 'not-requested' };
    const previous = store.current.pet.visible;
    const persistence = previous === value ? 'unchanged' : 'saved';
    if (previous !== value) {
      try { await store.persist({ ...store.current, pet: { ...store.current.pet, visible: value } }); }
      catch { return { persistence: 'unknown', presentation: 'not-requested' }; }
      noteCompanionVisibilityWrite(previous);
    }
    if (target !== needs.pet || target.isDestroyed()) return { persistence, presentation: 'failed', value };
    try {
      // Desired=true alone does not restore a minimized/native-hidden window.
      if (value && target.isMinimized()) target.restore();
      sync();
    } catch { /* Retain the acknowledged save; observe the actual native result below. */ }
    try {
      if (target !== needs.pet || target.isDestroyed()) return { persistence, presentation: 'failed', value };
      const nativeValue = nativeVisibility(target).visible && !petHeld(); // Unbound: her window is really hidden
      return { persistence, presentation: nativeValue === value ? 'applied' : 'failed', value, nativeValue };
    } catch { return { persistence, presentation: 'unknown', value }; }
  }
  /** This action confirms the existing setting only, not physical gaze actuation. */
  async function commitCompanionFollowMouse(value: boolean): Promise<CommandCommitResult> {
    const { store, pet } = needs; // read when called
    if (!pet || pet.isDestroyed()) return { persistence: 'not-committed', presentation: 'not-requested' };
    const previous = store.current.pet.followMouse;
    const persistence = previous === value ? 'unchanged' : 'saved';
    if (previous !== value) {
      try { await store.persist({ ...store.current, pet: { ...store.current.pet, followMouse: value } }); }
      catch { return { persistence: 'unknown', presentation: 'not-requested' }; }
      noteCompanionFollowMouseWrite(previous);
    }
    try { broadcast('desk:settings', publicSettings(store.current)); }
    catch { return { persistence, presentation: 'unknown', value: store.current.pet.followMouse }; }
    return { persistence, presentation: 'not-requested', value: store.current.pet.followMouse };
  }
  /** Fixed existing numeric strength only; true retains an already-positive exact value. */
  async function commitCompanionBreath(request: number | true): Promise<CommandCommitResult> {
    const { store, pet } = needs; // read when called
    if (!pet || pet.isDestroyed()) return { persistence: 'not-committed', presentation: 'not-requested' };
    const previous = store.current.pet.breath;
    if (!Number.isFinite(previous) || previous < 0 || previous > 1
      || (request === true ? previous === 0 : !Number.isInteger(request) || request < 0 || request > 100))
      return { persistence: 'not-committed', presentation: 'not-requested' };
    const value = request === true ? previous : request / 100;
    const persistence = previous === value ? 'unchanged' : 'saved';
    if (previous !== value) {
      try { await store.persist({ ...store.current, pet: { ...store.current.pet, breath: value } }); }
      catch { return { persistence: 'unknown', presentation: 'not-requested' }; }
      noteCompanionBreathWrite(previous);
    }
    if (store.current.pet.breath !== value) return { persistence: 'unknown', presentation: 'not-requested' };
    try { broadcast('desk:settings', publicSettings(store.current)); }
    catch { return { persistence, presentation: 'unknown', value }; }
    return { persistence, presentation: 'not-requested', value };
  }
  function commitCompanionCommand(value: boolean, actionId: CompanionCommandAction['actionId']): Promise<CommandCommitResult> {
    if (actionId === 'pet.set-always-on-top') return commitCompanionTopmost(value);
    if (actionId === 'pet.set-visible') return commitCompanionVisibility(value);
    if (actionId === 'pet.set-follow-mouse') return commitCompanionFollowMouse(value);
    return Promise.resolve({ persistence: 'not-committed', presentation: 'not-requested' });
  }
  /** Serialized minimal save only: later readouts use the setting; no speech or media operation. */
  async function commitCompanionReadoutVolume(percent: number): Promise<CommandCommitResult> {
    const { store } = needs; // read when called
    if (!Number.isInteger(percent) || percent < 0 || percent > 100)
      return { persistence: 'not-committed', presentation: 'not-requested' };
    const value = percent / 100, previous = store.current.voice.volume;
    const persistence = previous === value ? 'unchanged' : 'saved';
    if (previous !== value) {
      try { await store.persist({ ...store.current, voice: { ...store.current.voice, volume: value } }); }
      catch { return { persistence: 'unknown', presentation: 'not-requested' }; }
      noteCompanionReadoutVolumeWrite(previous);
    }
    if (store.current.voice.volume !== value) return { persistence: 'unknown', presentation: 'not-requested' };
    try { broadcast('desk:settings', publicSettings(store.current)); }
    catch { return { persistence, presentation: 'unknown', value: percent }; }
    return { persistence, presentation: 'not-requested', value: percent };
  }
  function sync(exclude?: number): void {
    const { store } = needs; // read when called
    const s = store.current;
    if (companionCommandObservedTop !== undefined && companionCommandObservedTop !== s.pet.alwaysOnTop)
      companionCommandRevision++;
    companionCommandObservedTop = s.pet.alwaysOnTop;
    if (companionVisibilityObserved !== undefined && companionVisibilityObserved !== s.pet.visible)
      companionVisibilityRevision++;
    companionVisibilityObserved = s.pet.visible;
    if (companionBreathObserved !== undefined && companionBreathObserved !== s.pet.breath) companionBreathRevision++;
    companionBreathObserved = s.pet.breath;
    if (companionFollowMouseObserved !== undefined && companionFollowMouseObserved !== s.pet.followMouse)
      companionFollowMouseRevision++;
    companionFollowMouseObserved = s.pet.followMouse;
    if (companionReadoutVolumeObserved !== undefined && companionReadoutVolumeObserved !== s.voice.volume)
      companionReadoutVolumeRevision++;
    companionReadoutVolumeObserved = s.voice.volume;
    companionCommands?.refresh();
    for (const step of syncSteps) step(s, exclude); // each part's reaction, in the order electron/main.ts gave (wireSettingsSync)
  }
  function fitSettingsScale(settings: AppSettings): AppSettings {
    const { pet } = needs; // read when called
    const area =
      pet && !pet.isDestroyed()
        ? screen.getDisplayMatching(pet.getBounds()).workArea
        : screen.getPrimaryDisplay().workArea;
    return {
      ...settings,
      pet: {
        ...settings.pet,
        scale: fittedPetScale(settings.pet.scale ?? 1, area),
      },
    };
  }
  return {
    id: 'settings',
    units: ['companion-commands', 'framing', 'sync', 'save', 'ui-language'],
    /** Overhaul step 7: the interface language stays fatal (the card store reads it right after it starts). */
    core: ['ui-language'],
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      // What the handlers read: each is set before the ready chain registers (registerIPC) and not replaced later.
      const { store, pet, mutate, activateUserProfile } = needs;
      companionBreathObserved = store.current.pet.breath;
      companionCommandObservedTop = store.current.pet.alwaysOnTop;
      companionVisibilityObserved = store.current.pet.visible;
      companionFollowMouseObserved = store.current.pet.followMouse;
      companionReadoutVolumeObserved = store.current.voice.volume;
      petFraming = new PetFramingHost({ now: Date.now, id: randomUUID,
        authorize: sender => !!pet && !pet.isDestroyed() && sender === pet.webContents.id,
        context: () => pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized() && store.current.pet.visible
          ? companionCommandContext(pet.webContents.id) : null,
        modelUrl: () => store.current.model?.url ?? '', camera: () => store.current.camera,
        send: request => { if (!pet || pet.isDestroyed()) throw Error('桌宠窗口未就绪。'); pet.webContents.send('desk:pet-framing', request); },
        save: async (camera, current) => {
          if (!current()) return 'not-committed';
          const validated = petViewSettings(store.current, { camera, scale: store.current.pet.scale ?? 1 }).camera;
          const persistence = sameFramingCamera(store.current.camera, validated) ? 'unchanged' : 'saved';
          if (persistence === 'saved') await store.persist({ ...store.current, camera: validated });
          // Do not broadcast a late camera over a later manual edit. No geometry/media sync.
          if (current()) broadcast('desk:settings', publicSettings(store.current));
          return persistence;
        },
      });
      scopedHost('reportPetFramingState', (sender, ...args) => { if (args.length !== 1) throw Error('取景状态参数不正确。'); return petFraming!.report(sender, args[0]); }, false);
      scopedHost('beginPetFraming', (sender, ...args) => { if (args.length !== 1) throw Error('取景请求参数不正确。'); return petFraming!.begin(sender, args[0]); }, false);
      scopedHost('completePetFraming', (sender, ...args) => { if (args.length !== 1) throw Error('取景回执参数不正确。'); return petFraming!.complete(sender, args[0]); }, false);
      scopedHost('noteManualCameraChange', (sender, ...args) => { if (args.length) throw Error('镜头通知参数不正确。'); if (windows().some(win => win.webContents.id === sender)) petFraming!.manual(); }, false);
      companionCommands = new CompanionCommandHost({ now: Date.now, id: randomUUID,
        target: companionCommandTarget, classify: classifyCompanionCommand, format: formatCompanionCommandReceipt,
        volumeTarget: companionReadoutVolumeTarget, commitVolume: commitCompanionReadoutVolume,
        breathTarget: companionBreathTarget, commitBreath: commitCompanionBreath,
        framingTarget: companionFramingTarget, cancelFrame: () => petFraming?.cancel(), frame: (preset, identity, current) => petFraming!.frame(preset, identity, current),
        readoutTarget: companionReadoutStopTarget, stopReadout: stopCompanionReadout,
        enqueue: mutate, commit: commitCompanionCommand, publish: view => {
          if (companionCommandExpiry) clearTimeout(companionCommandExpiry);
          companionCommandExpiry = view.choices.length ? setTimeout(() => companionCommands?.refresh(), 60_010) : null;
          broadcast('desk:companion-command', view);
        } });
      scopedHost('chooseCompanionCommand', (sender, request) => companionCommands!.choose(sender, request), false);
      host("getSettings", () => publicSettings(store.current), false);
      host("saveSettings", (value, baseline) =>
        mutate(async () => {
          const next = validateSettings(value, store.current);
          for (const step of savePrepare) step(next, baseline, store); // before the save is written, in order (wireSaveSettings)
          try {
            const saved = await store.persist(fitSettingsScale(next));
            for (const step of saveApplied) await step(); // after it is written, in order (wireSaveSettings)
            return saved;
          } finally { await activateUserProfile(); }
        }),
      );
      // The interface language (its own small store) and 恢复默认设置, moved from electron/main.ts's registerIPC (wiring rewrite step 5).
      host('getUiLanguage', () => uiLanguage.current, false);
      host('setUiLanguage', preference => uiLanguage.persist(preference), true);
      host('resetSettings', () =>
        mutate(async () => {
          const { voiceHost, clearVisionContext, setVisionSupported, stopSystemAudio, speechRuntime, clearReplySpeech, noteModelSelection, motionLibrary, pending,
            setCameraEnabled, media, mediaChanged, forgetScreenSelection, bundledAssets, assets, userProfileManagement, characterCards, adoptCharacterForModel,
            companion } = needs; // read when called
          voiceHost.history = null;
          clearVisionContext();
          setVisionSupported(false);
          stopSystemAudio();
          speechRuntime.stop();
          clearReplySpeech();
          noteModelSelection();
          motionLibrary.cancel();
          for (const task of pending.values()) task.controller.abort();
          setCameraEnabled(false);
          const previous = { ...media.state };
          media.reset();
          mediaChanged(previous);
          forgetScreenSelection();
          // Check the factory assets before revoking previous local file grants.
          await bundledAssets.getDefaultAssets();
          assets.clear();
          const defaults = await bundledAssets.getDefaultAssets();
          userProfileManagement?.suspendScope();
          try {
            await store.persist(fitSettingsScale({ ...structuredClone(DEFAULT_SETTINGS), ...defaults, persona: compileCharacterPersona(characterCards.getActive()) }));
            await adoptCharacterForModel(store.current.model); // C1: the factory Gene model goes with the Gene card
            await companion.context(characterCards.getActive().id, store.current.provider, store.current.persona);
            broadcast('desk:chat-reset', undefined);
            sync();
            return publicSettings(store.current);
          } finally { await activateUserProfile(); }
        }),
      );
    },
    provides: { sync, fitSettingsScale, companionCommandContext, noteCompanionTopmostWrite, commitCompanionVisibility, commitCompanionCommand,
      commitCompanionReadoutVolume, commitCompanionBreath, get companionCommandExpiry() { return companionCommandExpiry; } },
  };
}
