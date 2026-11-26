// 舞台's wiring (wiring rewrite step 4, docs/claude/2026-11-16-wiring-rewrite-plan.md section 2; docs/claude/2026-11-16-wiring-step-4g.md):
// what the user sees of her. Moved from electron/main.ts; the statements are the ones main.ts had.
// Split by feature (docs/claude/2026-11-17-split-stage-wiring.md); a change to one feature reads one file:
// - this file: the part's entry (wireStage(given), StageNeeds, register(ipc) calling the feature files in the old order), the state the
//   companion window is made with (pointer input, presentation, dragging, each window's visibility), the single-emoji window, its cues and
//   settings, the expression preview to every window's stage (E1), her-life motions, the reply bubble's handler (updatePetReply);
// - electron/wiring/stage-window-wiring.ts: the companion window: where she can be seen (onScreen, herOnScreen, replySurface, nativeVisibility),
//   its size, place, topness and pointer settings on every sync, dragging and resizing, showing / hiding / recovering her, keeping her off
//   the taskbar strip, and its handlers (click-through, drag, presentation samples, topmost, visibility, recover, pointer);
// - electron/wiring/stage-body-wiring.ts: her body: the body model generation, the Gene receipt (verifyVisualGeneTarget), the body pose
//   in the published mood view (withBodyPose), personalize visual and body authoring and their stores and handlers;
// - electron/wiring/stage-model-wiring.ts: what is known about the model: the model profile cache, the I-024 model check and its 试一下
//   relay, the physics settings, and their handlers.
// Everything the feature files export is re-exported below, so electron/main.ts and the other parts import from this file as before.
// - The stage's sync steps (syncBodyModel … syncWindowVisibility), its mood publish step (publishEmojiContext), its ready-chain steps
//   (startPhysicsSettings … startKeepInArea: the old lines, read in place by the wiring golden) and its handlers (register, inside the agent
//   channel's recorder where main.ts registered them).
// - The stage core (the companion window, the reply window, presentation) is one of the units step 7's isolation never switches off (plan
//   section 3): `core` below.
// What stays in electron/main.ts and why (docs/claude/2026-11-16-wiring-step-4g.md): creating the windows, secureWindow's subscriber
//   (windowEvents: the stage's lines there run in their registration order among the other parts'), loadWindow, the ready chain's order,
//   the 1-second clock, before-quit's order; the mood publish's cue step (publishCue: 主动's claim, then the windows and 感知's comment
//   engines, read with the brain's companion), the surprise preview (主动's host) and the chat lease authoring reserves.
// What the lines read from the rest of the app comes through StageNeeds (getters electron/main.ts gives): `needs.<value>` or
// `const { … } = needs; // read when called`. The feature files import `needs` and the state below as live bindings. The state other
// parts read is module-level and exported (live bindings electron/main.ts reads).
// MmdStage, stage-pace, MAX_ANIMATION_DELTA and the pose / gesture / expression channels are not touched: nothing here merges channels.
// No module-level side effects: nothing here runs before electron/main.ts has set the profile folder (app.setPath('userData')).
import { app, screen, type BrowserWindow } from 'electron';
import type { AppSettings } from '../../shared/contracts';
// 大脑's wiring (step 4h) hands the mood host the stage's visual-behavior source in the ready chain (startCompanion); it reads the Gene
// hash through here, so that wiring reaches into no other part's inside.
export { VISUAL_GENE_SHA } from '../../shared/stage/personalize-visual';
import {
  EmojiSettingsStore, herLifeMotionAllowed, PetPointerInput, PetPresentation, PetTopmostGuard, PetWindowDrag, registerSingleEmojiControls,
  relayExpressionPreview, resolveHerLifeMotionResource, SingleEmojiCues,
} from '../stage';
import { SingleEmojiWindow } from '../stage/single-emoji-window'; // direct, not via ../stage: it loads electron's BrowserWindow at import time (electron/stage/index.ts)
import type { WindowVisibility } from '../stage/window-visibility';
import type { TopmostOutcome } from '../stage/pet-topmost';
import { validateReplyUpdate, type CompanionService } from '../brain';
import type { MotionFitStore, MotionLibrary } from '../actions';
import type { SurprisePreviewHost } from '../initiative';
import type { CharacterCardStore, CharacterStickerHost } from '../cards';
import type { CompanionCommandHost, SettingsStore } from '../settings';
import type { AssetRegistry } from '../foundation/assets';
import type { ReplyProofSurface } from '../unbound';
import type { PartIpc } from './ipc-wiring';
import { startUnit, type PartHandle } from './parts-wiring';
import { broadcast } from './shell-wiring';
import { unbound } from './unbound-wiring';
import { bodyModelGeneration, registerStageAuthoringHandlers } from './stage-body-wiring';
import { registerStageModelHandlers, registerStagePhysicsHandlers } from './stage-model-wiring';
import { registerStageWindowHandlers } from './stage-window-wiring';
import { startControlAvoidance } from './stage-avoid-wiring';
export { attachPetWindow, herHereNow, herOnScreen, nativeVisibility, onScreen, replySurface, startKeepInArea, syncPetWindow, syncWindowVisibility, togglePet } from './stage-window-wiring';
export { bodyAuthoring, bodyModelGeneration, bumpBodyModelGeneration, startPersonalizeAuthoring, startPersonalizeStores, syncBodyModel, syncBodySelection,
  verifyVisualGeneTarget, visualAuthoring, visualBehaviors, visualGeneReceipt, withBodyPose } from './stage-body-wiring';
export { modelCapabilities, modelPhysicsSettings, startModelCapabilities, startModelProfiles, startPhysicsSettings } from './stage-model-wiring';
export { physicsForWindows } from './physics-lab-wiring'; // R01 物理调参台: Unbound's scene gets this model's tuning too

/** What 舞台's lines read from the rest of the app (electron/main.ts gives getters; a value is read when it is used). */
export interface StageNeeds {
  readonly store: SettingsStore;
  readonly companion: CompanionService;
  readonly characterCards: CharacterCardStore;
  readonly controls: BrowserWindow | null;
  readonly pet: BrowserWindow | null;
  /** The companion's reply window (electron/brain/reply-window.ts PetReplyWindow): made with the windows in electron/main.ts's ready chain. */
  readonly petReply: ReplyWindowPort | null;
  readonly motionLibrary: MotionLibrary;
  readonly assets: AssetRegistry;
  /** 身体动作's motion fits (the model profile answers with them). */
  readonly motionFits: MotionFitStore | null;
  /** 主动's E1 surprise preview (a new body model makes its previews stale). */
  readonly surprisePreviewHost: SurprisePreviewHost | undefined;
  /** 记忆's text memorials (a shown reply bubble tells them its text). */
  readonly textMemorialHost: { displayTextChanged(text: string): void } | null;
  /** 设置's companion commands (a recovered companion makes a pending one stale). */
  readonly companionCommands: CompanionCommandHost | null;
  /** 角色卡's sticker host (the single-emoji window shows its pictures; a cue's invalidation clears its reference). */
  readonly characterStickerHost: CharacterStickerHost | null;
  // the other parts' functions (electron/main.ts's wrappers)
  speechScope(): string;
  journalCharacterId(): string | null;
  /** 记忆: the topmost guard's repair, as a journal line (electron/memory/journal/extras.ts topmostFixInput). */
  topmostJournal(outcome: TopmostOutcome, visible: boolean, nth: number): void;
  noteVisionUserActivity(): void;
  /** 大脑: authoring holds the chat lease while it researches (electron/main.ts reserveCompanionAuthoring). */
  reserveCompanionAuthoring(owner: number, id: string, controller: AbortController, source: 'language-authoring' | 'visual-authoring'): () => void;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
  sync(exclude?: number): void;
  // 设置's provides
  fitSettingsScale(settings: AppSettings): AppSettings;
  noteCompanionTopmostWrite(previousTopmost: boolean): void;
  commitCompanionVisibility(visible: boolean): Promise<{ persistence: string; presentation: string }>;
}

/** What the stage uses of the reply window (its own module is 大脑's: electron/brain/reply-window.ts). */
export type ReplyWindowPort = ReplyProofSurface & {
  sync(): void;
  emojiExclusions(): Array<{ x: number; y: number; width: number; height: number }>;
  setEmojiLayoutListener(listener: () => void): void;
  /** T-253: the rectangle the bubble keeps clear of (the control window while shown; electron/wiring/stage-avoid-wiring.ts). */
  setAvoidSource(source: (() => ReadonlyArray<{ x: number; y: number; width: number; height: number }> | null) | null): void;
  /** A completion answers with its lifetime (#5). */
  update(value: unknown): unknown;
};

// ---- state other parts read (live bindings electron/main.ts imports; the feature files import them too) ----
export let singleEmojiWindow: SingleEmojiWindow | null = null;
export let singleEmojiCues: SingleEmojiCues | null = null;
let observedEmojiContext = '';
export let petWindowDrag: PetWindowDrag | null = null;
/** Click-through: only the transparent space around her lets the mouse through (electron/stage/pet-pointer-input.ts; made by wireStage). */
export let petPointerInput!: PetPointerInput;
/** R37: keep an explicitly requested companion presentation true for a short settle window. Developer log is off by default (made by wireStage). */
export let petPresentation!: PetPresentation;
// Each window's native visibility as it was last told (made by wireStage).
export let windowVisibility!: WeakMap<BrowserWindow, WindowVisibility>;
// Body pose cues an edit retired (made by wireStage; stage-body-wiring.ts's withBodyPose and body authoring read and fill it).
export let retiredBodyPoseCues!: Set<string>;
let singleEmojiSettings: EmojiSettingsStore;

// Set by wireStage (while electron/main.ts is evaluated, before anything below runs).
export let needs!: StageNeeds; // (the feature files read it as a live binding)
// The mood publish step and the sync step below call this (set by wireStage; not a top-level function, so the wiring golden keeps the
// call as it is written).
let refreshSingleEmojiContext!: () => void;
function keepForSteps(refresh: () => void): void { refreshSingleEmojiContext = refresh; }

export function singleEmojiContext(): string {
  const { speechScope, store, companion } = needs; // read when called
  try { return JSON.stringify([speechScope(), store.current.model?.url ?? null, bodyModelGeneration, companion.mood.get().token]); }
  catch { return ''; }
}
/** Mood publish step (舞台): the single emoji follows the context. */
export function publishEmojiContext(): void {
  refreshSingleEmojiContext();
}
/** E1 惊喜 / 害羞 on any model: either window's 「预览」 (or the D2 command) goes to every window's stage (electron/stage/expression-preview-host.ts). */
export function playExpressionPreview(recipe: unknown) {
  const { pet } = needs; // read when called
  return relayExpressionPreview(recipe, { send: value => broadcast('desk:expression-preview', value),
    petVisible: () => !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized() });
}
/** Sync step (舞台): the single emoji follows the context. */
export function syncSingleEmoji(): void {
  refreshSingleEmojiContext();
}

// ---- ready-chain steps (electron/main.ts calls each where its lines ran; the wiring golden reads the body in place) ----
/** Ready-chain step: the single emoji's settings (unreadable: the file is kept and the emoji stays off). */
export async function startEmojiSettings(store: SettingsStore): Promise<void> {
  await startUnit('stage', 'single-emoji', async () => { // overhaul step 7: this unit's start, through the part runner
  singleEmojiSettings = new EmojiSettingsStore(store.directory);
  await singleEmojiSettings.load().catch(() => console.warn('表情设置暂不可读；保留原文件并默认关闭。'));
  });
}
/** Ready-chain step, right after the windows and the reply window are made: the single-emoji window and its cues, dragging, the topmost guard (I-062). */
export function startStageWindows(pet: BrowserWindow, petReply: ReplyWindowPort): void {
      singleEmojiWindow = new SingleEmojiWindow(pet, () => petReply?.emojiExclusions() ?? [], singleEmojiContext,Date.now,id=>needs.characterStickerHost?.imageFor(id)??Promise.resolve(null));
      singleEmojiCues = new SingleEmojiCues({
        context: singleEmojiContext, settings: () => singleEmojiSettings.current,
        available: () => { const { store } = needs; /* read when called */ return !!pet && !pet.isDestroyed() && pet.isVisible() && !pet.isMinimized()
          && !!store.current.model && !petWindowDrag?.active; },
        show: cue => singleEmojiWindow?.show(cue) ?? false,
        hide: () => singleEmojiWindow?.clear(),
        onInvalidate:()=>needs.characterStickerHost?.invalidate(),
      });
      petReply.setEmojiLayoutListener(() => singleEmojiWindow?.sync());
      pet.on('hide', () => singleEmojiCues?.invalidate());
      pet.on('minimize', () => singleEmojiCues?.invalidate());
      petWindowDrag = new PetWindowDrag(pet, screen);
      // I-062: she stays above ordinary windows and never fights a topmost window shown after her. The 2 s check only reads the style and
      // repairs a lost one with back-off; she goes to the top of the band only at her own moments: shown, restored, focused (click, drag, touch).
      const topmostGuard = new PetTopmostGuard({ window: () => pet ?? null, wanted: () => needs.store.current.pet.alwaysOnTop, journal: (outcome, visible, nth) => { needs.topmostJournal(outcome, visible, nth); } });
      const ownMoment = () => { topmostGuard.ownMoment(); };
      topmostGuard.start(); pet.on('show', ownMoment); pet.on('restore', ownMoment); pet.on('focus', ownMoment); pet.on('closed', () => topmostGuard.stop());
      startControlAvoidance(pet, petReply); // no-pet-ok: startStageWindows' own parameter names. T-253: the bubble keeps clear of the control window; she steps aside from its input area (electron/wiring/stage-avoid-wiring.ts)
}

/** electron/main.ts calls this once, while it is evaluated, where it made the companion's pointer input (before Unbound, the IPC guard and the shell are wired). */
export function wireStage(given: StageNeeds): PartHandle<Record<string, never>> & { register(ipc: PartIpc): void } {
  needs = given;
  windowVisibility = new WeakMap<BrowserWindow, WindowVisibility>();
  retiredBodyPoseCues = new Set<string>();
  petPointerInput = new PetPointerInput({ window: () => needs.pet, cursor: () => screen.getCursorScreenPoint() });
  petPresentation = new PetPresentation({ window: () => needs.pet, screen: () => screen, intent: () => { const { store } = needs; /* read when called */ return store ? unbound?.petSettings(store.current.pet) ?? store.current.pet : null; }, busy: () => !!petWindowDrag?.active, echo: line => console.info(line),
    diagnostics: () => app.commandLine.hasSwitch('pet-window-diagnostics') || process.env.SOFT_HEARTS_PET_DIAGNOSTICS === '1' || !!needs.companion?.mood.isDeveloperMode(),
    giveUp: reason => { const { controls } = needs; /* read when called */ if (reason === 'startup' && controls && !controls.isDestroyed() && !controls.isVisible()) controls.show(); } });
  function refreshSingleEmojiContext(): void {
    const next = singleEmojiContext();
    if (next !== observedEmojiContext) singleEmojiCues?.invalidate();
    observedEmojiContext = next;
  }
  keepForSteps(refreshSingleEmojiContext);

  return {
    id: 'stage',
    units: ['pet-window', 'reply-window', 'presentation', 'pointer-input', 'window-drag', 'topmost', 'single-emoji', 'body-pose', 'personalize-authoring',
      'expression-preview', 'her-life-motion', 'model-profile', 'model-capability', 'physics-settings'],
    /** Plan section 3: the stage core is never switched off by step 7's isolation; its failure stays fatal. */
    core: ['pet-window', 'reply-window', 'presentation'],
    /** Overhaul step 7: the handlers of each unit that can be switched off (they answer PART_OFF while it is off). */
    ipc: { 'physics-settings': ['getModelPhysicsSettings', 'setModelPhysicsSettings', 'openPhysicsLab'], 'single-emoji': ['getSingleEmojiSettings', 'setSingleEmojiSettings', 'previewSingleEmoji'],
      'personalize-authoring': ['getVisualAuthoring', 'chooseVisualMaterial', 'researchVisual', 'researchExpression', 'editExpression', 'previewExpression', 'resolveExpressionPreview', 'previewVisualBinding', 'visualPreviewReceipt', 'resolveVisualPreview', 'saveVisualBehavior', 'changeVisualBehavior', 'cancelVisualAuthoring', 'getBodyAuthoring', 'chooseBodyMaterial', 'researchBody', 'discardBodyAdvice', 'consumeBodyAdvice', 'previewBodyBinding', 'previewFixedBodyBinding', 'bodyPreviewReceipt', 'resolveBodyPreview', 'saveBodyBehavior', 'changeBodyBehavior', 'cancelBodyAuthoring'],
      'model-profile': ['getModelProfile', 'saveModelProfile'],
      'model-capability': ['getModelCapabilities', 'askModelCapabilityNames', 'saveModelCapabilityCheck', 'setModelCapabilityChoice', 'previewModelCapability', 'reportModelCapabilityPreview'] },
    register(ipc: PartIpc): void {
      const { host, scopedHost } = ipc;
      registerSingleEmojiControls(host, { store: singleEmojiSettings, cues: () => singleEmojiCues,
        context: singleEmojiContext, publish: value => broadcast('desk:single-emoji-settings', value) });
      host('playExpressionPreview', recipe => playExpressionPreview(recipe), false); // E1: both windows; a closed recipe only.
      host('resolveHerLifeMotion', async (motionId, token) => {
        const { companion, motionLibrary, assets } = needs; // read when called
        // Only the pinned motion of the state she is in now, for the current character and token.
        const current = () => { const view = companion.mood.get(); if (typeof token !== 'string' || view.token !== token || !herLifeMotionAllowed(motionId, view)) throw new Error('这段动作已结束或角色已切换。'); };
        current();
        const resource = await resolveHerLifeMotionResource(motionLibrary, motionId);
        current();
        const asset = await assets.register(resource.path);
        current();
        const { path: _localPath, ...metadata } = resource;
        return { ...metadata, url: asset.url };
      }, false);
      registerStageModelHandlers(host, scopedHost); // the Gene check, the model profile, the I-024 model check (electron/wiring/stage-model-wiring.ts)
      scopedHost('updatePetReply', (sender, value) => {
        const { pet, petReply, textMemorialHost } = needs; // read when called
        if (sender !== pet?.webContents.id) throw new Error('只有桌宠窗口可以显示回答气泡。');
        const patch=validateReplyUpdate(value);
        const linger=petReply?.update(patch); // #5: a completion answers with its lifetime (src/stage/PetUI.ts keeps the same deadline)
        if((patch.state==='streaming'||patch.state==='complete')&&patch.text?.trim())textMemorialHost?.displayTextChanged(patch.text);return linger;
      }, false);
      const { mutate } = needs;
      registerStageAuthoringHandlers(scopedHost, mutate); // personalize visual and body authoring (electron/wiring/stage-body-wiring.ts)
      registerStagePhysicsHandlers(host); // the physics switches (electron/wiring/stage-model-wiring.ts)
      registerStageWindowHandlers(host, scopedHost, mutate); // the companion window (electron/wiring/stage-window-wiring.ts)
    },
    provides: {},
  };
}
