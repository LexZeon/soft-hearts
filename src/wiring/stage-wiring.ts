// Renderer wiring, 舞台: the stage and its callbacks, the behaviour and input gates, hair/chest physics, music strength, blush calibration, model capabilities and the cursor tick (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText, uiTemplate } from '../foundation/ui-language';
import { conciseFailure } from '../settings';
import type { ModelPhysicsSettingsPatch } from "../../shared/contracts";
import { applyBehaviorGates } from "../stage";
import type { StageOptions, StageSurface } from '../stage';
import { createWindowStage, followWindowStyle, pageStorage, UnboundWindowStage } from '../unbound/window-mode'; // I-154 / I-176 (not via ../unbound: see its index.ts)
import { petSayPorts } from '../initiative';
import { showSleepMurmur } from '../voice';
import { type MotionLibraryControls } from '../actions/MotionLibrary';
import { ModelCapabilitySync, bindCapabilityPreview } from '../stage';
import { onStageModelProfile } from '../stage';
import type { BlushCalibrationView } from '../../shared/mood';
import { normalizeModelPhysicsSettings, type ModelPhysicsSettings, type ModelPhysicsState, type PhysicsQuality } from '../../shared/stage';
import { normalizeMusicSettings, type MusicSettings } from '../../shared/senses';
import { musicTasteOf } from '../../shared/senses'; // I-077 step 2: her taste (card trait)
import { $, isPet, notify, text, updateStageStatus } from './shell-wiring';
import { queueSave, recoveringPetView, save, settings, syncCamera, syncCameraMode } from './settings-wiring';
import { immersiveDeveloperMode, moodCompanion } from './mood-wiring';
import { speech } from './voice-wiring';
import { activeChat, hostVisible } from './chat-wiring';
import { attentionPollWanted, noteUserGaze } from './user-attention-wiring'; // I-189
import { rpsOverlay } from './initiative-wiring';
import { characterState } from './cards-wiring';
import { petFramingController, petPointer, petUI } from './pet-window-wiring';
import { blushCalibrationControls, characterPage, modelCapabilityPanel, motionLibraryControls, motionPreview } from './control-window-wiring';
export let stage: StageSurface;
export let cameraEditing = false;
export let pointerTimer: ReturnType<typeof setInterval> | null = null;
/** Latest per-model motion fit from the stage (adaptation layer step 2); the library may be created after it arrives. */
export let motionFitView: Parameters<MotionLibraryControls['setMotionFit']>[0] = null;
/** I-024 模型体检: this window's capability card for its stage, and (control window) the character page's 「这个模型能做什么」. */
export let modelCapabilitySync: ModelCapabilitySync | null = null;
export let blushCalibrationView: BlushCalibrationView | null = null;
export let blushCalibrationUrl = '';
export let blushCalibrationGeneration = 0;
export let blushCalibrationUnsubscribe: (() => void) | null = null;
export let modelPhysicsSettings = normalizeModelPhysicsSettings(undefined);
export let modelPhysicsState: ModelPhysicsState | null = null;
export let modelPhysicsSettingsReady = false;
export let modelPhysicsSaving = false;
export let modelPhysicsEventVersion = 0;
export let modelPhysicsUnsubscribe: (() => void) | null = null;
export let musicSettings = normalizeMusicSettings(undefined);
export let musicSettingsReady = false;
export let musicSettingsSaving = false;
export let musicSettingsEventVersion = 0;
export let musicSettingsUnsubscribe: (() => void) | null = null;
export let composing = false;
export function applyStage(): void {
  syncBehaviorGate();
  void stage
    .applySettings(motionPreview?.view(settings) ?? settings)
    .then(() => {
      if ((settings.model?.url ?? '') !== blushCalibrationUrl) void refreshBlushCalibration();
      if ((settings.model?.url ?? '') !== physicsTuningUrl) void refreshPhysicsTuning(); // R01: this model's lab tuning
      if (!isPet) void characterPage?.modelShown(settings.model?.url ?? ''); // C2: her small picture, once posed
    })
    .catch((error) => notify(String(error), true));
}
export function syncBehaviorGate(): void {
  // R29b: typing is not a window/camera adjustment; it only pauses new automatic behaviour.
  applyBehaviorGates(stage, { cameraEditing, composing, windowInteraction: !!petUI?.windowInteractionBlocked,
    clickThrough: settings.pet.clickThrough, preview: !!(motionPreview && motionPreview.state.phase !== 'idle' && motionPreview.state.local!=='surprise') });
  syncBodyInputGate(); petPointer?.refresh();
}
export function syncBodyInputGate(): void {
  const focused = document.activeElement;
  const editable = focused instanceof HTMLElement && (focused.matches('input, textarea, select') || focused.isContentEditable);
  stage?.setBodyInputBlocked(!!activeChat || editable);
}
export function syncModelPhysicsSupport(): void {
  if (isPet) return;
  for (const part of ['hair', 'chest'] as const) {
    const support = modelPhysicsState?.support[part];
    const enabled = $<HTMLInputElement>(`physics-${part}-enabled`);
    const strength = $<HTMLInputElement>(`physics-${part}-strength`);
    // An unsupported model must still let the user cancel a saved request.
    if (enabled) enabled.disabled = !modelPhysicsSettingsReady || modelPhysicsSaving
      || (!support?.supported && !modelPhysicsSettings[part].enabled);
    if (strength) strength.disabled = !modelPhysicsSettingsReady || modelPhysicsSaving || !support?.supported;
    text(`physics-${part}-support`, !settings.model ? uiText('载入模型后检查结构')
      : !support ? uiText('正在检查模型结构…')
      : support.supported ? uiText('当前模型支持此效果')
      : uiTemplate`当前模型不可用：${support.reason ?? uiText('缺少可靠的局部物理结构')}`);
  }
  const quality = $<HTMLSelectElement>('physics-quality');
  if (quality) quality.disabled = !modelPhysicsSettingsReady || modelPhysicsSaving;
}
export function syncModelPhysicsForm(): void {
  if (isPet) return;
  for (const part of ['hair', 'chest'] as const) {
    const enabled = $<HTMLInputElement>(`physics-${part}-enabled`);
    const strength = $<HTMLInputElement>(`physics-${part}-strength`);
    if (enabled) enabled.checked = modelPhysicsSettings[part].enabled;
    if (strength) strength.value = String(modelPhysicsSettings[part].strength);
    text(`physics-${part}-strength-value`, String(modelPhysicsSettings[part].strength));
  }
  const quality = $<HTMLSelectElement>('physics-quality');
  if (quality) quality.value = modelPhysicsSettings.quality;
  syncModelPhysicsSupport();
}
export function applyModelPhysicsSettings(next: ModelPhysicsSettings): void {
  modelPhysicsSettings = normalizeModelPhysicsSettings(next, modelPhysicsSettings);
  modelPhysicsSettingsReady = true;
  stage.setPhysicsSettings(modelPhysicsSettings);
  syncModelPhysicsForm();
}
/** R01 物理调参台: the model changed, so ask again for the switches with this model's tuning (the host keys it by content hash). */
let physicsTuningUrl = '';
async function refreshPhysicsTuning(): Promise<void> {
  physicsTuningUrl = settings.model?.url ?? '';
  const version = modelPhysicsEventVersion;
  try {
    const next = await window.desktop.getModelPhysicsSettings();
    if (version === modelPhysicsEventVersion && physicsTuningUrl === (settings.model?.url ?? '')) applyModelPhysicsSettings(next);
  } catch { /* The switches stay as they are; the stage ignores a tuning made for another model. */ }
}
export async function initModelPhysicsSettings(): Promise<void> {
  modelPhysicsUnsubscribe = window.desktop.onModelPhysicsSettings(next => {
    modelPhysicsEventVersion++;
    applyModelPhysicsSettings(next);
  });
  const version = modelPhysicsEventVersion;
  try {
    const initial = await window.desktop.getModelPhysicsSettings();
    if (version === modelPhysicsEventVersion) applyModelPhysicsSettings(initial);
    text('physics-save-state', uiText('设置保存在本机 · 两项默认关闭'));
  } catch {
    text('physics-save-state', uiText('物理设置暂时无法读取，请重新打开设置窗口'));
  }
  syncModelPhysicsSupport();
}
export async function saveModelPhysicsSettings(patch: ModelPhysicsSettingsPatch): Promise<void> {
  if (isPet || !modelPhysicsSettingsReady || modelPhysicsSaving) { syncModelPhysicsForm(); return; }
  const version = modelPhysicsEventVersion;
  modelPhysicsSaving = true;
  syncModelPhysicsSupport();
  text('physics-save-state', uiText('正在保存…'));
  try {
    const accepted = await window.desktop.setModelPhysicsSettings(patch);
    // The commit broadcast may have arrived first, including a newer update.
    if (version === modelPhysicsEventVersion) applyModelPhysicsSettings(accepted);
    text('physics-save-state', uiText('已保存 · 效果在桌宠窗口生效'));
  } catch {
    text('physics-save-state', uiText('未能保存，已恢复上次设置'));
    notify(uiText('物理设置未保存，请重试。'), true);
  } finally {
    modelPhysicsSaving = false;
    syncModelPhysicsForm();
  }
}
export function bindModelPhysicsControls(): void {
  for (const part of ['hair', 'chest'] as const) {
    const enabled = $<HTMLInputElement>(`physics-${part}-enabled`);
    const strength = $<HTMLInputElement>(`physics-${part}-strength`);
    if (enabled) enabled.onchange = () => {
      if (enabled.checked && !modelPhysicsState?.support[part].supported) { syncModelPhysicsForm(); return; }
      void saveModelPhysicsSettings({ [part]: { enabled: enabled.checked } });
    };
    if (strength) {
      strength.oninput = () => text(`physics-${part}-strength-value`, strength.value);
      strength.onchange = () => {
        if (!Number.isFinite(strength.valueAsNumber) || !strength.checkValidity()) { syncModelPhysicsForm(); return; }
        void saveModelPhysicsSettings({ [part]: { strength: strength.valueAsNumber } });
      };
    }
  }
  const quality = $<HTMLSelectElement>('physics-quality');
  if (quality) quality.onchange = () => {
    if (!['low', 'standard', 'high'].includes(quality.value)) { syncModelPhysicsForm(); return; }
    void saveModelPhysicsSettings({ quality: quality.value as PhysicsQuality });
  };
  syncModelPhysicsForm();
}
export function syncMusicSettingsForm(): void {
  if (isPet) return;
  const strength = $<HTMLInputElement>('music-strength');
  if (strength) { strength.value = String(musicSettings.strength); strength.disabled = !musicSettingsReady || musicSettingsSaving; }
  text('music-strength-value', String(musicSettings.strength));
  const always = $<HTMLInputElement>('music-always-dance');
  if (always) { always.checked = musicSettings.alwaysDance; always.disabled = !musicSettingsReady || musicSettingsSaving; }
}
export function applyMusicSettings(next: MusicSettings): void {
  musicSettings = normalizeMusicSettings(next, musicSettings);
  musicSettingsReady = true;
  stage.setMusicSettings(musicSettings);
  syncMusicSettingsForm();
}
export async function initMusicSettings(): Promise<void> {
  musicSettingsUnsubscribe = window.desktop.onMusicSettings(next => {
    musicSettingsEventVersion++;
    applyMusicSettings(next);
  });
  const version = musicSettingsEventVersion;
  try {
    const initial = await window.desktop.getMusicSettings();
    if (version === musicSettingsEventVersion) applyMusicSettings(initial);
    text('music-save-state', uiText('强度保存在本机 · 请在桌宠上单独开启音乐按钮'));
  } catch { text('music-save-state', uiText('音乐强度暂时无法读取，请重新打开设置窗口')); }
  syncMusicSettingsForm();
}
export async function saveMusicSettings(change: number | Partial<MusicSettings>): Promise<void> {
  const patch = typeof change === 'number' ? { strength: change } : change;
  if (isPet || !musicSettingsReady || musicSettingsSaving) { syncMusicSettingsForm(); return; }
  const version = musicSettingsEventVersion;
  musicSettingsSaving = true;
  syncMusicSettingsForm();
  text('music-save-state', uiText('正在保存…'));
  try {
    const accepted = await window.desktop.setMusicSettings(patch);
    if (version === musicSettingsEventVersion) applyMusicSettings(accepted);
    text('music-save-state', uiText('已保存 · 音乐按钮保持独立控制'));
  } catch {
    text('music-save-state', uiText('未能保存，已恢复上次强度'));
    notify(uiText('音乐强度未保存，请重试。'), true);
  } finally { musicSettingsSaving = false; syncMusicSettingsForm(); }
}
export function bindMusicSettingsControls(): void {
  const strength = $<HTMLInputElement>('music-strength');
  if (strength) {
    strength.oninput = () => text('music-strength-value', strength.value);
    strength.onchange = () => {
      if (!Number.isFinite(strength.valueAsNumber) || !strength.checkValidity()) { syncMusicSettingsForm(); return; }
      void saveMusicSettings(strength.valueAsNumber);
    };
  }
  const always = $<HTMLInputElement>('music-always-dance');
  if (always) always.onchange = () => { void saveMusicSettings({ alwaysDance: always.checked }); };
  syncMusicSettingsForm();
}
export function applyBlushCalibration(view: BlushCalibrationView, url = settings.model?.url ?? ''): void {
  if (url !== (settings.model?.url ?? '')) return;
  blushCalibrationView = view; blushCalibrationUrl = url;
  stage.setBlushCalibration(view.calibration, url);
  blushCalibrationControls?.update(view, stage.getBlushSupport());
}
export async function refreshBlushCalibration(): Promise<void> {
  const generation = ++blushCalibrationGeneration, url = settings.model?.url ?? '';
  try {
    const view = await window.desktop.getBlushCalibration();
    if (generation === blushCalibrationGeneration && url === (settings.model?.url ?? '')) applyBlushCalibration(view, url);
  } catch (error) { if (generation === blushCalibrationGeneration) notify(String(error), true); }
}
export function stopMotionPreview(): void {
  void motionPreview?.stop().catch(error => notify(String(error), true));
}
/** I-024: the stage's capability card (both windows); 试一下 plays on the companion. */
export function wireModelCapabilities(): void {
  // I-024: the stage gets its capability card from its profile, haiku's checked matches and the user's choices (both windows).
  modelCapabilitySync = new ModelCapabilitySync({ api: window.desktop, apply: card => stage?.setModelCapabilities(card), onChange: state => modelCapabilityPanel?.update(state) });
  onStageModelProfile(profile => modelCapabilitySync?.profileBuilt(profile));
  window.desktop.onModelCapabilities(update => modelCapabilitySync?.receive(update));
  if (isPet) bindCapabilityPreview(window.desktop, () => stage); // 试一下 from the character page plays on the companion's own stage
}
/** The stage and its callbacks (both windows; the companion's own reports are guarded inside). */
export function createStage(): void {
  const options: StageOptions = {
    transparent: isPet,
    // P4: companion framing keeps the model below the hover toolbar and frames a never-framed camera.
    framingTop: isPet ? () => petUI?.toolbarReach() ?? 0 : undefined,
    frameUnframed: isPet,
    // 体验记录 (E2): her music tier, from the companion window only (the host ignores it unless the switch is on).
    onMusicTier: (tier, score) => { if (isPet) void window.desktop.noteMusicTier({ tier, score }).catch(() => {}); },
    onMusicVerdict: flip => { if (isPet) void window.desktop.noteJournalFact('music-verdict', flip).catch(() => {}); }, // I-053: the fast verdict flipped (numbers and a closed reason)
    onGazeAttention: event => { if (isPet) void window.desktop.noteJournalFact('gaze', event).catch(() => {}); }, // I-081: she started / stopped looking at you, eye contact, a shy look-away (closed words)
    onMusicReaction: (intent, scale) => { if (isPet) void window.desktop.noteJournalFact('music-reaction', scale === 1 ? { intent } : { intent, scale }).catch(() => {}); }, // I-077: a reaction to the song comes back to her mood (host gates it)
    musicTaste: () => musicTasteOf(characterState?.cards.find(card => card.id === characterState!.activeId)), // I-077 step 2: the active card's music taste (neutral when none)
    songMemory: isPet ? { match: sketch => window.desktop.songMemory({ op: 'match', characterId: characterState?.activeId ?? '', sketch }).then(r => r && 'id' in r ? r : null), learn: sketch => window.desktop.songMemory({ op: 'learn', characterId: characterState?.activeId ?? '', sketch }) } : undefined, // I-077 step 2: numbers to the host and back
    onBlushCue: stage => { if (isPet) void window.desktop.noteJournalFact('blush-stage', stage).catch(() => {}); }, onFirstShown: () => { if (isPet) void window.desktop.noteJournalFact('launch', null).catch(() => {}); }, onMotionGlitch: glitch => { if (isPet) void window.desktop.noteMotionGlitch(glitch).catch(() => {}); }, // 动作跳变记录 → 体验记录 (only while it is on)
    onMouthReading: reading => { if (isPet) void window.desktop.noteJournalFact('mouth-reading', reading).catch(() => {}); }, // 2026-11-22 嘴型记录 → 体验记录 (the host writes it only while it is on) // no-pet-ok: the companion window flag
    onSurprisePreviewState: state=>{if(!isPet){text('surprise-preview-status',state==='playing'?uiText('正在预览表情与头身 · 手暂未加入'):state==='partial'?uiText('部分效果受当前状态影响 · 手暂未加入'):state==='unsupported'?uiText('当前模型暂不支持表情试作'):uiText('试作已结束 · 原动作继续'));if(state==='idle')motionPreview?.finishLocal();}},
    onPhysicsState: state => { modelPhysicsState = state; syncModelPhysicsSupport(); },
    onMotionFit: view => { motionFitView = view; motionLibraryControls?.setMotionFit(view); if (!view) modelCapabilitySync?.modelCleared(); },
    onFramingStateChange: () => { if (!petFramingController?.applying) queueMicrotask(() => petFramingController?.report()); },
    onCameraEditChange: enabled => {
      petFramingController?.invalidate();
      void window.desktop.noteManualCameraChange().catch(() => {});
      cameraEditing = enabled;
      syncBehaviorGate();
      if (enabled) moodCompanion?.reset('camera-edit');
      if (isPet) petUI?.setEditing(enabled); else syncCameraMode();
      if (!enabled && !recoveringPetView) void save();
    },
    onFaceAnchor: point => { petUI?.setFaceAnchor(point); rpsOverlay?.place(point, window.innerWidth, window.innerHeight); },
    onSleepMurmur: murmur => { if (isPet) showSleepMurmur(petSayPorts({ ui: () => petUI, speech, voice: () => settings.voice, free: () => hostVisible && !document.hidden && !activeChat && !composing && !$<HTMLTextAreaElement>('chat-input').value.trim() }), murmur); }, // I-078: a rare silent "zzz…" while she sleeps (bubble only, no voice)
    onCameraChange: (camera) => {
      settings.camera = camera;
      if (!isPet) syncCamera();
      if (!recoveringPetView && !petFramingController?.applying) {
        void window.desktop.noteManualCameraChange().catch(() => {});
        queueSave();
      }
    },
    onStatus: (message) => {
      updateStageStatus(message);
    },
    onError: (message) => {
      text(isPet ? "pet-status" : "stage-status", immersiveDeveloperMode ? message : conciseFailure(message));
      notify(message, true);
    },
  };
  // I-154 / I-176: both windows draw her with Unbound's engine (src/unbound/window-mode/; the control window's preview with its own narrow ports).
  const made = createWindowStage<StageSurface>({ isPet, storage: pageStorage(), desktop: window.desktop },
    (host, style, grants) => new UnboundWindowStage($("stage"), options, host, style, Math.random, grants));
  stage = made.stage;
  followWindowStyle(made.style, value => { if (stage instanceof UnboundWindowStage) stage.setStyle(value); });
}
/** R29b: typing pauses new automatic behaviour; a focused field blocks body input. */
export function wireInputGates(): void {
  document.addEventListener('compositionstart', () => { composing = true; moodCompanion?.reset('composition'); syncBehaviorGate(); });
  document.addEventListener('compositionend', () => { composing = false; syncBehaviorGate(); });
  document.addEventListener('focusin', syncBodyInputGate);
  document.addEventListener('focusout', () => queueMicrotask(syncBodyInputGate));
}
/** The blush calibration of the shown model. */
export async function wireBlushCalibration(): Promise<void> {
  blushCalibrationUnsubscribe = window.desktop.onBlushCalibration(view => {
    if ((settings.model?.url ?? '') === blushCalibrationUrl && view.modelKey === blushCalibrationView?.modelKey) applyBlushCalibration(view);
    else void refreshBlushCalibration();
  });
  await refreshBlushCalibration();
}
/** Every 100 ms: where pose sensing says you are (companion) and the cursor (follow-mouse). */
export function startPointerFollow(): void {
  pointerTimer = setInterval(() => {
    // I-081: where pose sensing says you are, for her gaze (companion window only; null while sensing gives nothing). Memory only.
    // I-189 #1, #2: the same answer carries the attention reading; while hidden it is still asked when her voice or a call needs it.
    if (isPet && ((hostVisible && !document.hidden) || attentionPollWanted())) void window.desktop.userGaze().then(reading => { stage.setUserGaze(reading); noteUserGaze(reading); }).catch(() => {});  // no-pet-ok: the existing companion window flag
    if (!settings.pet.followMouse || !hostVisible || document.hidden) return;
    void window.desktop
      .pointer()
      .then((pointer) => stage.setPointer(pointer))
      .catch(() => {});
  }, 100);
}
