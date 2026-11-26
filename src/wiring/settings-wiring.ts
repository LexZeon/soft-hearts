// Renderer wiring, 设置: the settings this window holds, saving, always-on-top, the settings form (bindControls), page navigation, the companion's show/hide request, settings broadcasts and the companion window's recovery.
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText, uiTemplate } from '../foundation/ui-language';
import { announceUnsaved, watchWindowForUnsaved } from '../foundation/unsaved-sign'; // 2026-11-24: leaving a page or closing the window with unsaved changes says so once (never blocks)
import { ControlNavigation, CONTROL_PAGE_TITLES, type ControlNavigationLocation } from '../settings';
import type { AppSettings } from "../../shared/contracts";
import { DEFAULT_SETTINGS } from "../../shared/foundation/defaults"; // direct, not via ../shared/settings: through the page the window bundle would take the host-only capability table (docs/claude/2026-11-16-overhaul-parts-4.md)
import { icon } from "../foundation/icons";
import { cameraSnapshot } from "../senses";
import { mergeSettings, settingsStartup, type SettingsStartup } from "../settings";
import { clearAfterReply, sameValue } from '../brain'; // 2026-11-23 saveBeforeSend
import { mountCrisisRegionSelect } from '../safety'; // I-117 the help card outside her role, and 所在地区（求助信息用）
import { motionAssetBaseline } from '../../shared/actions';
import { speechLanguage, systemVoiceLine } from '../voice';
import { settingsSaveCutsReading } from '../../shared/voice/interrupt-policy';
import { PetVisibilityIntent, WindowVisibilityTracker } from '../stage/window-visibility';
import { checkPetPresentation } from '../stage';
import { latchSignal } from '../stage';
import { bindPreviewCardButtons } from '../stage';
import { $, isPet, notify, text } from './shell-wiring';
import { chatModelBadge, chosenChatModel, syncChatModelSelect } from '../settings/chat-model-select';
import { memoryConnectionChanged as memoryConnectionMoved } from '../../shared/foundation/memory-connection';
import { applyStage, bindModelPhysicsControls, bindMusicSettingsControls, cameraEditing, stage, stopMotionPreview } from './stage-wiring';
import { moodCompanion } from './mood-wiring';
import { currentTtsConfig, feedCuePrefetch, replySpeechQueue, speech } from './voice-wiring';
import { acceptWindowVisibility, activeChat, attachments, clearChat, clearCommandMessageRows, hostVisible, refillChat, sendChat, stopChat } from './chat-wiring';
import { renderAttachments } from './chat-view-wiring';
import { explainRuntimeReply, runtime } from './senses-wiring';
import { ambientTranscriptHistory, memoryPanel } from './memory-wiring';
import { petFramingController, petUI } from './pet-window-wiring';
import { characterPage, codexTasks, emotionalVoiceControls, motionLibraryControls, motionPreview } from './control-window-wiring';
export let settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
export let hostSettings: AppSettings = structuredClone(DEFAULT_SETTINGS);
export let alwaysOnTopPending = false;
export let settingsBroadcastEpoch = 0;
export let saveQueue: Promise<boolean> = Promise.resolve(true);
export let saveTimer: ReturnType<typeof setTimeout>;
export let captureController: AbortController | null = null;
export const windowVisibility = new WindowVisibilityTracker();
export let petVisibilityIntent: PetVisibilityIntent | null = null;
export let pendingPetVisibility = false;
export let petVisibilityRequest = 0;
export let recoveringPetView = false;
export let petRecoveryGeneration = 0;
export let controlNavigation: ControlNavigation | null = null;
/** 2026-11-25: 'desk:settings' is listened to from before the first read (src/settings/startup-updates.ts); wireSettingsUpdates attaches the handler. */
let settingsUpdates: SettingsStartup<AppSettings> | null = null;
const hostSettingsStartup = () => settingsUpdates ??= settingsStartup<AppSettings>({ subscribe: callback => window.desktop.onSettings(callback), read: () => window.desktop.getSettings(), onError: error => notify(String(error), true) });
export function save(): Promise<boolean> {
  clearTimeout(saveTimer);
  const operation = async () => {
    const sent = structuredClone(settings);
    try {
      const accepted = isPet
        ? await window.desktop.savePetView({ camera: sent.camera, scale: sent.pet.scale ?? 1 })
        : await window.desktop.saveSettings(sent, motionAssetBaseline(hostSettings));
      const memoryConnectionChanged = memoryConnectionMoved(hostSettings.provider, accepted.provider); // I-222: a chat model change keeps the page
      settings = mergeSettings(sent, settings, accepted);
      projectPetVisibility();
      hostSettings = accepted;
      if (memoryConnectionChanged) { memoryPanel?.reset(); clearChat(false); }
      applyStage();
      if (!isPet) syncForm();
      updateSummary();
      return true;
    } catch (error) {
      notify(String(error), true);
      return false;
    }
  };
  saveQueue = saveQueue.then(operation, operation);
  return saveQueue;
}
/**
 * The save a typed line makes before it goes (src/wiring/chat-wiring.ts sendChat). 2026-11-23: none when the host already has exactly what
 * this window would send (the full-screen box's line and most lines change no setting); the host queues a save behind her other writes
 * (I-191: the voice capture's), which held every line up to SEND_DROP_KNOBS.saveWaitMs.
 */
export function saveBeforeSend(): Promise<boolean> {
  const view = (value: AppSettings) => isPet ? { camera: value.camera, scale: value.pet.scale ?? 1 } : value; // no-pet-ok: the existing flag and settings key names (what savePetView saves)
  return sameValue(view(settings), view(hostSettings)) ? Promise.resolve(true) : save();
}
export function queueSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 240);
}
export async function requestAlwaysOnTop(enabled: boolean): Promise<void> {
  if (alwaysOnTopPending) return;
  alwaysOnTopPending = true;
  const input = document.getElementById('always-on-top') as HTMLInputElement | null;
  if (input) input.disabled = true;
  petUI?.setAlwaysOnTopPending(true);
  const epoch = settingsBroadcastEpoch;
  try {
    const accepted = await window.desktop.setPetAlwaysOnTop(enabled);
    // A newer broadcast wins over a delayed return. Preserve all unrelated drafts.
    if (epoch === settingsBroadcastEpoch) {
      settings.pet.alwaysOnTop = accepted.pet.alwaysOnTop;
      hostSettings.pet.alwaysOnTop = accepted.pet.alwaysOnTop;
    }
  } catch (error) { notify(String(error), true); }
  finally {
    alwaysOnTopPending = false;
    if (input) { input.disabled = false; input.checked = settings.pet.alwaysOnTop; }
    petUI?.setAlwaysOnTopPending(false);
    petUI?.applySettings(settings);
  }
}
/** The host's settings, before anything is drawn. */
export async function loadSettings(): Promise<void> {
  settings = await hostSettingsStartup().load(); // listens before it reads: a change made while this window starts is not lost
  projectPetVisibility();
}
/** The settings the host has, and (control window) the show/hide-the-companion request queue. */
export function wirePetVisibilityIntent(): void {
  hostSettings = structuredClone(settings);
  if (!isPet) petVisibilityIntent = new PetVisibilityIntent(async visible => {
    const sent = structuredClone(settings);
    const accepted = await window.desktop.setPetVisible(visible);
    settings = mergeSettings(sent, settings, accepted);
    projectPetVisibility();
    hostSettings = accepted;
  }, async error => {
    projectPetVisibility(); notify(String(error), true);
  });
}
/** R37: the companion window put back in view re-reads the host's settings and frames her again. */
export function wirePetRecovery(petRecovered: ReturnType<typeof latchSignal>): void {
  petRecovered.attach(() => {
    if (!isPet) return;
    const generation = ++petRecoveryGeneration;
    recoveringPetView = true;
    clearTimeout(saveTimer);
    stage.setCameraEditMode(false);
    petUI?.setWindowAdjusting(false);
    void (async () => {
      // R37: resume drawing from the host's current native truth before re-framing.
      await window.desktop.getWindowVisibility().then(acceptWindowVisibility, () => {});
      await saveQueue;
      if (generation !== petRecoveryGeneration) return;
      settings = await window.desktop.getSettings();
      projectPetVisibility();
      hostSettings = structuredClone(settings);
      await stage.applySettings(settings);
      if (generation !== petRecoveryGeneration) return;
      stage.frame('full');
      const accepted = await window.desktop.savePetView({ camera: settings.camera, scale: DEFAULT_SETTINGS.pet.scale ?? 1 });
      if (generation !== petRecoveryGeneration) return;
      settings = accepted;
      projectPetVisibility();
      hostSettings = structuredClone(accepted);
      applyStage();
      updateSummary();
    })().catch(error => notify(String(error), true)).finally(() => {
      if (generation === petRecoveryGeneration) recoveringPetView = false;
      if (generation === petRecoveryGeneration) void checkPetPresentation({ document, hostVisible: () => hostVisible, reason: 'restore',
        report: sample => window.desktop.reportPetPresentation(sample), reload: () => location.reload() });
    });
  });
}
/** Settings broadcasts from the host (both windows). */
export function wireSettingsUpdates(): void {
  hostSettingsStartup().attach((next) => {
    if (next.pet.alwaysOnTop !== hostSettings.pet.alwaysOnTop) settingsBroadcastEpoch++;
    const changedVoiceContext = settingsSaveCutsReading(settings, next); // 2026-11-25: only another model; a voice, rate or switch change applies from her next reply
    const changedProvider = memoryConnectionMoved(settings.provider, next.provider); // I-222: another chat model alone is not another connection
    const changedPersona = next.persona !== settings.persona;
    const changedModel = next.model?.path !== settings.model?.path;
    if (changedModel || changedProvider || changedPersona) { petFramingController?.invalidate(); clearCommandMessageRows(); }
    if (changedModel || changedProvider || changedPersona) moodCompanion?.reset('context');
    settings = mergeSettings(hostSettings, settings, next);
    hostSettings = next;
    projectPetVisibility();
    if (changedVoiceContext) speech.stop('switch');
    applyStage();
    updateSummary();
    if (!isPet) {
      syncForm();
    }
    // 2026-11-25: a new connection or card text starts a new conversation view, but only once her reply and its voice are over (the host waits too: electron/wiring/quiet-wiring.ts).
    if (changedProvider || changedPersona) clearAfterReply({ afterReply: true }, { active: () => activeChat ?? replySpeechQueue.replyId, clear: () => {
      clearChat(false); memoryPanel?.reset(); ambientTranscriptHistory?.reset(); void ambientTranscriptHistory?.refresh();
      // C2/C3: a new persona for the same connection is her card changing; the window shows her current conversation again.
      if (changedPersona && !changedProvider) refillChat(false);
    } });
    if (!settings.voice.enabled) speech.stop('switch');
    feedCuePrefetch.voiceContextChanged();
  });
}

export function updateSummary(): void {
  if (isPet) {
    $("pet-empty").classList.toggle("hidden", !!settings.model);
    petUI?.applySettings(settings);
    return;
  }
  text("model-name", settings.model?.name ?? uiText("尚未载入模型"));
  text(
    "footer-model",
    settings.model ? uiTemplate`${settings.model.name} · 本地模型` : uiText("等待载入模型"),
  );
  text(
    "model-path",
    settings.model?.path ?? uiText("选择 .pmx、.pmd 或 .vrm；MMD 模型保留原贴图目录"),
  );
  const preview = motionPreview?.state;
  text("motion-name", preview && preview.phase !== 'idle'
    ? uiTemplate`预览：${preview.name ?? uiText('动作')}`
    : settings.motion?.name ?? uiText("未载入 · 使用默认站姿"));
  motionLibraryControls?.refresh();
  text("fps-label", `${settings.pet.fps} FPS`);
  $("preview-empty").classList.toggle("hidden", !!settings.model);
  text("provider-badge", chatModelBadge(settings.provider.model)); // I-222
}
export function syncCameraMode(): void {
  const button = $<HTMLButtonElement>('camera-edit');
  button?.setAttribute('aria-pressed', String(cameraEditing));
  if (button) button.innerHTML = `${icon('sliders')}<span>${cameraEditing ? uiText('完成调整') : uiText('调整模式')}</span>`;
  $('preview-camera-help')?.classList.toggle('hidden', !cameraEditing);
  document.querySelector('.preview-card')?.classList.toggle('camera-editing', cameraEditing);
  text('preview-camera-hint', cameraEditing ? uiText('调整后自动保存 · Esc 完成') : uiText('点击「调整模式」控制镜头 · 构图同步至桌宠'));
}
/** 识别方式: the local recognizer's panel or the compatible address fields (control window). */
export function syncAsrEngine(): void {
  const local = settings.voiceInput?.engine !== 'compatible', localFields = $('asr-local-fields'), compatibleFields = $('asr-compatible-fields');
  if (localFields) localFields.hidden = !local;
  if (compatibleFields) compatibleFields.hidden = local;
}
export function syncCamera(): void {
  for (const key of [
    "yaw",
    "pitch",
    "distance",
    "fov",
    "targetX",
    "targetY",
  ] as const) {
    const input = $<HTMLInputElement>(`camera-${key}`);
    if (input && document.activeElement !== input)
      input.value = String(Number(settings.camera[key].toFixed(2)));
  }
}
export function syncForm(): void {
  syncCamera();
  const values: Record<string, string | number> = {
    "pet-fps": settings.pet.fps,
    breath: settings.pet.breath,
    "voice-rate": settings.voice.rate,
    "voice-volume": settings.voice.volume,
    "voice-mood": settings.voice.moodInfluence ?? DEFAULT_SETTINGS.voice.moodInfluence!,
    "voice-first-chunk": settings.voice.firstChunk === 'comma' ? 'comma' : 'sentence',
    "proactive-talk": settings.proactiveTalk === 'less' || settings.proactiveTalk === 'more' ? settings.proactiveTalk : 'normal',
    "crisis-region": settings.crisisRegion ?? 'auto', // I-117
    'asr-url': settings.voiceInput?.baseUrl ?? DEFAULT_SETTINGS.voiceInput!.baseUrl,
    'asr-model': settings.voiceInput?.model ?? DEFAULT_SETTINGS.voiceInput!.model,
    'asr-language': settings.voiceInput?.language ?? 'zh',
    'asr-key': settings.voiceInput?.apiKey ?? '',
    'asr-engine': settings.voiceInput?.engine === 'compatible' ? 'compatible' : 'local',
  };
  syncAsrEngine();
  syncChatModelSelect($<HTMLSelectElement>("provider-model"), settings.provider.model); // I-222: the four choices (src/settings/chat-model-select.ts)
  for (const [id, value] of Object.entries(values)) {
    const input = $<HTMLInputElement>(id);
    if (document.activeElement !== input) input.value = String(value);
    if ($(`${id}-value`)) text(`${id}-value`, String(value));
  }
  const toggles: Record<string, boolean> = {
    "follow-mouse": settings.pet.followMouse,
    "voice-enabled": settings.voice.enabled,
    "voice-pause-talk": settings.voice.pauseTalk === true,
    "always-on-top": settings.pet.alwaysOnTop,
    "click-through": settings.pet.clickThrough,
    "self-look": settings.selfLook !== false, // I-085 她自己看一眼 (absent: on)
  };
  for (const [id, value] of Object.entries(toggles))
    $<HTMLInputElement>(id).checked = value;
  populateVoices();
  $('system-voice-options').classList.toggle('hidden', currentTtsConfig().provider !== 'system');
  emotionalVoiceControls?.refresh();
  codexTasks?.syncSettings();
  updateSummary();
}
export function openCodexTaskPanel(): void {
  controlNavigation?.navigate('agent');
}
export function showControlLocation(location: ControlNavigationLocation, previous: ControlNavigationLocation | null): void {
  const panel = $(`tab-${location.page}`);
  const changedPage = previous?.page !== location.page;
  if (changedPage) {
    announceUnsaved(message => notify(message));
    document.querySelectorAll('.tab-panel').forEach(item => item.classList.toggle('active', item === panel));
    text('page-title', uiText(CONTROL_PAGE_TITLES[location.page]));
    if (location.page === 'agent') void codexTasks?.init();
    if (location.page === 'memory') void memoryPanel?.refresh();
    if (location.page === 'characters') void characterPage?.refresh();
    if (location.page !== 'characters') stage.clearBlushPreview(); // C2: the blush calibration moved with the character cards
    if (location.page !== 'appearance') {
      stopMotionPreview();
      if (cameraEditing) stage.setCameraEditMode(false);
    }
  }
  let target = document.getElementById(location.target);
  if (!target || (!panel.contains(target) && location.target !== 'frame-full')) return;
  // Navigation reveals existing controls; it never invokes their actions.
  for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    if (ancestor === panel) break;
  }
  const requestedTarget = target;
  while (target !== panel && target.getClientRects().length === 0 && target.parentElement)
    target = target.parentElement;
  if (target !== requestedTarget) notify(uiText('当前配置未显示此项，已定位到所属设置。'));
  if (!target.matches('button, input, select, textarea, a[href], [tabindex]')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
export function populateVoices(): void {
  const select = $<HTMLSelectElement>("voice-select");
  if (!select) return;
  select.replaceChildren(new Option(uiText("系统默认中文声音"), ""));
  for (const voice of speech.voices())
    select.add(new Option(`${voice.name} · ${voice.lang}`, voice.voiceURI));
  const plan = currentTtsConfig().voicePlan, voiceURI = plan?.wanted === 'system' ? plan.systemVoiceURI : settings.voice.voiceURI; // I-162: hers when the system voice is her voice
  select.value = voiceURI;
  text('voice-select-line', systemVoiceLine(speech.voices(), voiceURI, speechLanguage()));
}
export function bindControls(): void {
  // E1: the preview card's buttons play the model-agnostic 惊喜 / 害羞 on every window (the companion first of all); missing parts are skipped.
  bindPreviewCardButtons({ button: id => $(id), support: recipe => stage.expressionSupport(recipe), play: recipe => window.desktop.playExpressionPreview(recipe),
    status: line => text('surprise-preview-status', line), error: message => notify(message, true) });
  $('surprise-stop').onclick=()=>{void motionPreview?.stop().catch(error=>notify(String(error),true));};
  bindModelPhysicsControls();
  bindMusicSettingsControls();
  $('show-pet').onclick = () => { requestPetVisibility(true); };
  $('recover-pet').onclick = () => void (async () => {
    const button = $<HTMLButtonElement>('recover-pet');
    button.disabled = true;
    const label = button.querySelector('span');
    if (label) label.textContent = uiText('正在恢复…');
    recoveringPetView = true;
    try {
      await motionPreview?.stop();
      clearTimeout(saveTimer);
      stage.setCameraEditMode(false);
      await saveQueue;
      const sent = structuredClone(settings);
      const accepted = await window.desktop.recoverPet();
      settings = mergeSettings(sent, settings, accepted);
      hostSettings = structuredClone(accepted);
      projectPetVisibility();
      applyStage();
      syncForm();
      updateSummary();
      notify(accepted.model ? uiText('桌宠已恢复到显示器中央，正在自动取景') : uiText('桌宠窗口已恢复，请先载入 MMD 模型'));
    } catch (error) { notify(String(error), true); }
    finally {
      recoveringPetView = false;
      button.disabled = false;
      if (label) label.textContent = uiText('一键恢复桌宠');
    }
  })();
  controlNavigation = new ControlNavigation($('control-navigation'), { onNavigate: showControlLocation });
  watchWindowForUnsaved(message => notify(message)); // the window was closed (hidden) and is back: the changes were kept
  const importModel = async () => {
    try {
      await motionPreview?.stop();
      const asset = await window.desktop.selectAsset("model");
      if (asset) {
        settings.model = asset;
        settings.motion = null;
        delete settings.motionLayers;
        await stage.applySettings(settings);
        updateSummary();
        stage.frame("portrait");
        notify(uiText("模型已载入，贴图从原目录读取"));
      }
    } catch (error) {
      notify(String(error), true);
    }
  };
  $("empty-import").onclick = $("import-model").onclick = () =>
    void importModel();
  $("use-bundled-model").onclick = () => void (async () => {
    const button = $<HTMLButtonElement>("use-bundled-model");
    button.disabled = true;
    try {
      await motionPreview?.stop();
      if (!(await save())) return;
      const accepted = await window.desktop.useBundledModel();
      settings = mergeSettings(hostSettings, settings, accepted);
      projectPetVisibility();
      hostSettings = accepted;
      await stage.applySettings(settings);
      updateSummary();
      notify(uiText("已启用预装 Gene 与 Stand 动作"));
    } catch (error) {
      notify(String(error), true);
    } finally {
      button.disabled = false;
    }
  })();
  $("import-motion").onclick = () => void (async () => {
    try {
      await motionPreview?.stop();
      if (!(await save())) return;
      const asset = await window.desktop.selectAsset("motion", motionLibraryControls?.selectedLayer ?? 'pose');
      if (asset) {
        const accepted = await window.desktop.getSettings();
        settings = mergeSettings(hostSettings, settings, accepted);
        projectPetVisibility();
        hostSettings = accepted;
        applyStage();
        updateSummary();
      }
    } catch (error) { notify(String(error), true); }
  })();
  $("clear-motion").onclick = () => void (async () => {
    try {
      await motionPreview?.stop();
      if (!(await save())) return;
      const accepted = await window.desktop.clearMotionLayer(motionLibraryControls?.selectedLayer ?? 'pose');
      settings = mergeSettings(hostSettings, settings, accepted);
      projectPetVisibility();
      hostSettings = accepted;
      applyStage();
      updateSummary();
    } catch (error) { notify(String(error), true); }
  })();
  $("frame-portrait").onclick = () => stage.frame("portrait");
  $("frame-full").onclick = () => stage.frame("full");
  $('camera-edit').setAttribute('aria-pressed', 'false');
  $('camera-edit').onclick = () => stage.setCameraEditMode(!cameraEditing);
  for (const [id, feature] of [['runtime-voice','voiceInput'],['runtime-screen','screenSharing'],['runtime-camera','cameraLocal'],['runtime-camera-images','cameraImages']] as const)
    $<HTMLInputElement>(id).onchange = event => void window.desktop.setRuntimeState({ [feature]: (event.target as HTMLInputElement).checked })
      // A refused switch flips back (no state change is broadcast for it) and says why.
      .then(reply => { (event.target as HTMLInputElement).checked = reply[feature] === true; explainRuntimeReply(reply); }, error => notify(String(error), true));
  $<HTMLSelectElement>('asr-engine').onchange = event => {
    settings.voiceInput ??= structuredClone(DEFAULT_SETTINGS.voiceInput!);
    settings.voiceInput.engine = (event.target as HTMLSelectElement).value === 'compatible' ? 'compatible' : 'local';
    syncAsrEngine();
    if (runtime.voiceInput) void window.desktop.setRuntimeState({ voiceInput: false });
    void save();
  };
  for (const [id, key] of [['asr-url','baseUrl'],['asr-model','model'],['asr-language','language'],['asr-key','apiKey']] as const)
    $<HTMLInputElement>(id).onchange = event => {
      settings.voiceInput ??= structuredClone(DEFAULT_SETTINGS.voiceInput!);
      const value = (event.target as HTMLInputElement).value.trim();
      if (key === 'baseUrl' && settings.voiceInput.baseUrl !== value) settings.voiceInput.apiKey = '';
      settings.voiceInput[key] = value;
      if (runtime.voiceInput) void window.desktop.setRuntimeState({ voiceInput: false });
      void save();
    };
  for (const key of [
    "yaw",
    "pitch",
    "distance",
    "fov",
    "targetX",
    "targetY",
  ] as const)
    $<HTMLInputElement>(`camera-${key}`).onchange = (event) => {
      const input = event.target as HTMLInputElement;
      const value = input.valueAsNumber;
      if (!Number.isFinite(value) || !input.checkValidity()) {
        syncCamera();
        return;
      }
      settings.camera[key] = value;
      applyStage();
      queueSave();
    };
  const toggles: Record<string, (value: boolean) => void> = {
    "follow-mouse": (v) => (settings.pet.followMouse = v),
    "voice-enabled": (v) => {
      settings.voice.enabled = v;
      if (!v) speech.stop('switch');
    },
    "voice-pause-talk": (v) => (settings.voice.pauseTalk = v), // F7 停停说说: from the next message
    "click-through": (v) => (settings.pet.clickThrough = v),
    "self-look": (v) => (settings.selfLook = v), // I-085: the host reads it at her next minute's decision
  };
  for (const [id, update] of Object.entries(toggles))
    $<HTMLInputElement>(id).onchange = (e) => {
      update((e.target as HTMLInputElement).checked);
      applyStage();
      void save();
    };
  $<HTMLInputElement>('always-on-top').onchange = event => {
    const input = event.target as HTMLInputElement;
    const desired = input.checked;
    input.checked = settings.pet.alwaysOnTop;
    void requestAlwaysOnTop(desired);
  };
  $<HTMLInputElement>('pet-visible').onchange = event => {
    requestPetVisibility((event.target as HTMLInputElement).checked);
  };
  for (const [id, update] of Object.entries({
    breath: (v: number) => (settings.pet.breath = v),
    "voice-rate": (v: number) => (settings.voice.rate = v),
    "voice-volume": (v: number) => (settings.voice.volume = v),
    "voice-mood": (v: number) => (settings.voice.moodInfluence = v),
  }))
    $<HTMLInputElement>(id).oninput = (e) => {
      const value = Number((e.target as HTMLInputElement).value);
      update(value);
      text(`${id}-value`, String(value));
      applyStage();
      queueSave();
    };
  $<HTMLSelectElement>("pet-fps").onchange = (e) => {
    settings.pet.fps = Number((e.target as HTMLSelectElement).value);
    applyStage();
    void save();
  };
  $<HTMLSelectElement>("provider-model").onchange = (e) => {
    // I-222: another chat model keeps the chat page and her memory; her process restarts with it after her reply.
    settings.provider.model = chosenChatModel((e.target as HTMLSelectElement).value, settings.provider.model);
    void save();
  };
  $<HTMLSelectElement>("voice-select").onchange = (e) => {
    settings.voice.voiceURI = (e.target as HTMLSelectElement).value;
    void save();
  };
  // I-029: where reading aloud starts; the host freezes it per reply, so it applies from the next reply.
  $<HTMLSelectElement>("voice-first-chunk").onchange = (e) => {
    settings.voice.firstChunk = (e.target as HTMLSelectElement).value === 'comma' ? 'comma' : 'sentence';
    void save();
  };
  // 她主动找你说话: the host reads it from the saved settings on its next opportunity.
  $<HTMLSelectElement>("proactive-talk").onchange = (e) => {
    const value = (e.target as HTMLSelectElement).value;
    settings.proactiveTalk = value === 'less' || value === 'more' ? value : 'normal';
    void save();
  };
  mountCrisisRegionSelect($<HTMLSelectElement>("crisis-region"), { set: value => { settings.crisisRegion = value; void save(); } }); // I-117 所在地区（求助信息用）
  speechSynthesis.onvoiceschanged = populateVoices;
  $("test-voice").onclick = () => void (currentTtsConfig().provider === 'system'
    ? speech.preview('你好，我会在这里，陪你度过平常的一天。')
    : speech.previewCharacter('你好，我会在这里，陪你度过平常的一天。', () => window.desktop.prepareCharacterSpeechPreview()))
    .catch(error => notify(String(error), true));
  $<HTMLFormElement>("chat-form").onsubmit = (e) => {
    e.preventDefault();
    void sendChat();
  };
  $<HTMLTextAreaElement>("chat-input").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void sendChat();
    }
  };
  $("new-chat").onclick = () => {
    clearChat(true, true);
    void window.desktop.newConversation().catch(error => notify(String(error), true));
  };
  $("stop-chat").onclick = () => void stopChat();
  document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach(
    (button) =>
      (button.onclick = () => {
        $<HTMLTextAreaElement>("chat-input").value =
          button.dataset.prompt ?? "";
        void sendChat();
      }),
  );
  $("attach-screen").onclick = () => void chooseScreen();
  $("close-screen").onclick = () => {
    captureController?.abort();
    $<HTMLDialogElement>("screen-dialog").close();
  };
  $("attach-camera").onclick = async () => {
    if (attachments.length >= 2) return notify(uiText("每次最多附带两张快照"));
    const button = $<HTMLButtonElement>("attach-camera");
    button.disabled = true;
    captureController?.abort();
    const controller = new AbortController();
    captureController = controller;
    try {
      const shot = await cameraSnapshot(controller.signal);
      if (!controller.signal.aborted) {
        attachments.push(shot);
        renderAttachments();
        notify(uiText("已拍摄，摄像头已释放。发送后才交给模型。"));
      }
    } catch (error) {
      notify(String(error), true);
    } finally {
      button.disabled = false;
    }
  };
  $("reset-settings").onclick = () =>
    $<HTMLDialogElement>("reset-dialog").showModal();
  $("cancel-reset").onclick = () =>
    $<HTMLDialogElement>("reset-dialog").close();
  $("confirm-reset").onclick = async () => {
    try {
      await stopChat();
      await codexTasks?.interruptActive();
      captureController?.abort();
      clearTimeout(saveTimer);
      await saveQueue;
      settings = await window.desktop.resetSettings();
      hostSettings = structuredClone(settings);
      syncForm();
      applyStage();
      clearChat();
      $<HTMLDialogElement>("reset-dialog").close();
      notify(uiText("已重置应用设置"));
    } catch (error) {
      notify(String(error), true);
    }
  };
  $("quit-app").onclick = () => void window.desktop.quit();
}
export async function chooseScreen(): Promise<void> {
  if (attachments.length >= 2) return notify(uiText("每次最多附带两张快照"));
  const dialog = $<HTMLDialogElement>("screen-dialog");
  const list = $("screen-sources");
  list.textContent = uiText("正在读取可选屏幕…");
  dialog.showModal();
  captureController?.abort();
  const controller = new AbortController();
  captureController = controller;
  try {
    const sources = await window.desktop.screenSources();
    if (controller.signal.aborted) return;
    list.replaceChildren();
    for (const source of sources) {
      const button = document.createElement("button");
      button.className = "screen-source";
      const image = document.createElement("img");
      image.src = source.thumbnail;
      image.alt = "";
      const label = document.createElement("span");
      label.textContent = source.name;
      button.append(image, label);
      button.onclick = async () => {
        try {
          const shot = await window.desktop.captureScreen(source.id);
          if (controller.signal.aborted) return;
          attachments.push(shot);
          renderAttachments();
          dialog.close();
        } catch (error) {
          notify(String(error), true);
        }
      };
      list.append(button);
    }
  } catch (error) {
    list.textContent = String(error);
  }
}
export function projectPetVisibility(): void {
  const visible = windowVisibility.petVisible;
  if (visible !== null) settings.pet.visible = visible;
  const input = document.getElementById('pet-visible') as HTMLInputElement | null;
  const button = document.getElementById('show-pet') as HTMLButtonElement | null;
  if (input) { input.disabled = visible === null; if (visible !== null && !pendingPetVisibility) input.checked = visible; }
  if (button) button.disabled = visible === null;
}
export function requestPetVisibility(desired: boolean): void {
  if (!petVisibilityIntent || windowVisibility.petVisible === null) { projectPetVisibility(); return; }
  const request = ++petVisibilityRequest;
  pendingPetVisibility = true;
  const input = document.getElementById('pet-visible') as HTMLInputElement | null;
  if (input) input.checked = desired;
  void petVisibilityIntent.request(desired).finally(async () => {
    if (request !== petVisibilityRequest) return;
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fresh = await Promise.race([
        window.desktop.getWindowVisibility(),
        new Promise<never>((_, reject) => { queryTimer = setTimeout(() => reject(new Error('窗口可见性状态查询超时')), 2000); }),
      ]);
      if (request === petVisibilityRequest) acceptWindowVisibility(fresh);
    } catch (error) { if (request === petVisibilityRequest) notify(String(error), true); }
    finally { if (queryTimer !== undefined) clearTimeout(queryTimer); }
    if (request === petVisibilityRequest) {
      pendingPetVisibility = false;
      projectPetVisibility();
    }
  });
}


// Writers for the other renderer wiring files (an ES module binding is written only where it is declared).
export function setSettings(value: typeof settings): void { settings = value; }
export function setHostSettings(value: typeof hostSettings): void { hostSettings = value; }
