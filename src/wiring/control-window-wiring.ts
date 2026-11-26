// Renderer wiring, Control window only: the control page and its language, the settings panels, the motion preview, the voice style / Claude tasks / motion library, the character tools.
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText, uiTemplate } from '../foundation/ui-language';
import { isUiLanguagePreference } from '../../shared/foundation/ui-languages';
import { fillUiLanguageSelect } from '../settings/ui-language-options';
import { SingleEmojiControls } from '../stage';
import { AgentChannelPanel, runAgentRendererAction } from '../safety';
import { mountAssistantPanel } from '../safety'; // I-071 v2 Claude 助手
import { PART_SWITCH_ELEMENTS, PartHealthNotice } from '../safety'; // overhaul step 7: one part is off
import { JournalPanel } from '../memory';
import { HerFolderPanel } from '../initiative'; // I-050 她的文件夹
import { PoseSensingPanel } from '../senses';
import { FaceCheckPanel } from '../senses'; // I-135 认出"不是你"
import { VoiceprintPanel } from '../senses'; // Unbound v1 step 3 只认你的声音
import { LocalAsrPanel } from '../senses';
import { ChatAvailabilityNotice, receiveUnboundSay } from '../brain';
import { CharacterStickerControls } from '../cards';
import { renderControls } from "../settings/layout";
import { EmotionalVoiceControls } from "../voice";
import { DEFAULT_TTS_CONFIG } from "../../shared/voice";
import { mergeSettings } from "../settings";
import { FeedRecognitionPanel } from '../senses';
import { MoodJudgePanel } from '../mood';
import { ReactionDispositionsPanel, ReactionsPanel } from '../mood'; // I-037
import { VoiceKeepPanel } from '../settings/voice-keep-panel'; // dev-only 保存她念出来的声音 (docs/claude/2026-11-24-voice-keep.md)
import { ChannelGatesPanel } from '../settings/channel-gates-panel'; // stable defaults (docs/claude/2026-11-19-stable-defaults.md)
import { SpeechBeatsSwitch } from '../settings/speech-beats-switch'; // 边说边演
import { UserActivityPanel } from '../senses'; // I-006
import { OurThingsPanel } from '../memory'; // I-086 我们的小东西
import { MovingMemoryPanel } from '../memory'; // I-139 A3 最打动她的一件事
import { PeopleThingsPanel } from '../memory'; // I-088 你生活里的人和事
import { MotionLibraryControls } from '../actions/MotionLibrary';
import { MotionPreviewSession } from '../actions';
import { CharacterCards } from '../cards';
import { CodexTasks } from '../safety';
import { CharacterPage } from '../cards';
import { ModelCapabilityPanel } from '../stage';
import { mountAboutLetter } from '../memory';
import { BlushCalibrationControls } from '../mood';
import { $, app, isPet, notify, text } from './shell-wiring';
import { bindControls, controlNavigation, hostSettings, openCodexTaskPanel, projectPetVisibility, save, setHostSettings, setSettings, settings, syncForm, updateSummary } from './settings-wiring';
import { applyBlushCalibration, applyStage, modelCapabilitySync, motionFitView, stage, syncBehaviorGate } from './stage-wiring';
import { characterVoicePorts, fishFallback, goToHerVoice, panelTtsConfig, speakingTtsConfig, speech, voiceContext } from './voice-wiring';
import { activeChat, sendChat, stopChat } from './chat-wiring';
import { applyCharacterCards, characterName, characterState } from './cards-wiring';
import { modelFormatOf } from '../../shared/foundation/model-format'; // I-152
export let characterStickerControls: CharacterStickerControls | null = null;
export let motionLibraryControls: MotionLibraryControls | null = null;
export let motionPreview: MotionPreviewSession | null = null;
export let visualPreviewUnsubscribe:(()=>void)|null=null;
export let bodyPreviewUnsubscribe:(()=>void)|null=null;
export let surprisePreviewUnsubscribe:(()=>void)|null=null;
export let characterControls: CharacterCards | null = null;
/** C2 角色页: the card wall ("换成她"), above the editor. */
export let characterPage: CharacterPage | null = null;
export let modelCapabilityPanel: ModelCapabilityPanel | null = null;
export let codexTasks: CodexTasks | null = null;
export let taskProposalUnsubscribe: (() => void) | null = null;
export let emotionalVoiceControls: EmotionalVoiceControls | null = null;
export let blushCalibrationControls: BlushCalibrationControls | null = null;
/** Control window: the control page, its language choice and the settings panels, in this order. */
export function mountControlWindow(interfaceLanguage: Awaited<ReturnType<typeof window.desktop.getUiLanguage>>): void {
    renderControls(app);
    mountAboutLetter(app); // the letter under 「关于」, opened on click
    const languageSelect = document.getElementById('ui-language') as HTMLSelectElement;
    fillUiLanguageSelect(languageSelect);
    let savedLanguagePreference = interfaceLanguage.preference;
    languageSelect.value = savedLanguagePreference;
    const languageNotice = document.getElementById('ui-language-status');
    if (languageNotice) languageNotice.textContent = uiText(interfaceLanguage.notice
      ? '无法读取已保存的界面语言，暂用系统默认；原文件已保留。'
      : '语言更改会在下次启动时生效。');
    languageSelect.addEventListener('change', () => {
      const selected = languageSelect.value;
      if (!isUiLanguagePreference(selected)) return;
      languageSelect.disabled = true;
      void window.desktop.setUiLanguage(selected).then(accepted => {
        savedLanguagePreference = accepted.preference;
        languageSelect.value = savedLanguagePreference;
        const output = document.getElementById('ui-language-status');
        if (output) output.textContent = uiText('语言已保存，下次打开应用时生效。');
      }).catch(error => {
        languageSelect.value = savedLanguagePreference;
        notify(String(error), true);
      }).finally(() => { languageSelect.disabled = false; });
    });
    new SingleEmojiControls($('single-emoji-controls'), {
      get: () => window.desktop.getSingleEmojiSettings(),
      save: value => window.desktop.setSingleEmojiSettings(value),
      preview: id => window.desktop.previewSingleEmoji(id),
      changed: callback => window.desktop.onSingleEmojiSettings(callback),
    });
    characterStickerControls=new CharacterStickerControls($('single-emoji-controls'),{
      get:()=>window.desktop.getCharacterStickers(),prepare:async()=>{const challenge=await window.desktop.beginCharacterStickerReference();try{const captured=await stage.captureCharacterStickerReference(challenge.modelUrl);return await window.desktop.acceptCharacterStickerReference({challengeId:challenge.id,...captured});}catch(error){await window.desktop.retireCharacterStickerReference({challengeId:challenge.id}).catch(()=>undefined);throw error;}},
      generate:(referenceId,intent)=>window.desktop.generateCharacterSticker({referenceId,intent}),save:resultId=>window.desktop.saveCharacterSticker({resultId}),preview:assetId=>window.desktop.previewCharacterSticker({assetId}),cancel:()=>window.desktop.cancelCharacterSticker(),changed:callback=>window.desktop.onCharacterStickers(callback),
    });
    new FeedRecognitionPanel($('feed-recognition'), { get: () => window.desktop.getFeedRecognition(), set: value => window.desktop.setFeedRecognition(value),
      changed: callback => window.desktop.onFeedRecognition(callback), error: message => notify(message, true) }); // I-019
    if (window.desktop.getChannelGates && window.desktop.setChannelGates) new ChannelGatesPanel($('channel-gates'), { get: () => window.desktop.getChannelGates!(), set: (id, on) => window.desktop.setChannelGates!(id, on), error: message => notify(message, true) }); // 还在试用的功能
    if (window.desktop.getChannelGates && window.desktop.setChannelGates) new SpeechBeatsSwitch($('speech-beats-switch'), { get: () => window.desktop.getChannelGates!(), set: (id, on) => window.desktop.setChannelGates!(id, on), error: message => notify(message, true) }); // 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md)
    if (window.desktop.voiceKeep) new VoiceKeepPanel($('voice-keep'), { call: request => window.desktop.voiceKeep!(request), error: message => notify(message, true) }); // hidden unless the host says this is a development build
    new MoodJudgePanel($('mood-judge'), { get: () => window.desktop.getMoodJudge(), set: value => window.desktop.setMoodJudge(value),
      changed: callback => window.desktop.onMoodJudge(callback), error: message => notify(message, true) }); // I-027
    new ReactionsPanel($('reactions'), { get: () => window.desktop.getReactions(), set: value => window.desktop.setReactions(value),
      changed: callback => window.desktop.onReactions(callback), error: message => notify(message, true) }); // I-037 新的反应方式
    new ReactionDispositionsPanel($('reaction-dispositions'), { get: () => window.desktop.getReactionDispositions(), set: values => window.desktop.setReactionDispositions(values),
      changed: callback => window.desktop.onReactions(callback), error: message => notify(message, true) }); // I-037: the six 反应倾向 on the 角色页
    new UserActivityPanel($('user-activity'), { get: () => window.desktop.getUserActivity(), set: value => window.desktop.setUserActivity(value),
      changed: callback => window.desktop.onUserActivity(callback), error: message => notify(message, true) }); // I-006
    new JournalPanel($('experience-journal'), { get: () => window.desktop.getJournal(), setEnabled: value => window.desktop.setExperienceJournal(value),
      changed: callback => window.desktop.onJournal(callback), error: message => notify(message, true) });
    new HerFolderPanel($('her-folder'), { get: () => window.desktop.getHerFolder(), choose: () => window.desktop.chooseHerFolder(), turnOff: () => window.desktop.turnOffHerFolder(),
      restore: id => window.desktop.restoreHerFolderItem(id), open: () => window.desktop.openHerFolder(), changed: callback => window.desktop.onHerFolder(callback), error: message => notify(message, true) }); // I-050
    new OurThingsPanel($('our-things'), { get: () => window.desktop.getOurThings(), picture: id => window.desktop.ourThingPicture(id), remove: id => window.desktop.removeOurThing(id),
      save: id => window.desktop.saveGivePicture({ id }), changed: callback => window.desktop.onOurThings(callback), recycle: window.desktop, currentCharacterId: () => characterState?.activeId ?? '', error: message => notify(message, true) }); // I-086 我们的小东西
    new MovingMemoryPanel($('moving-memory'), { get: () => window.desktop.getMovingMemory(), remove: chosenAt => window.desktop.deleteMovingMemory(chosenAt), restore: chosenAt => window.desktop.restoreMovingMemory(chosenAt), recycle: window.desktop, currentCharacterId: () => characterState?.activeId ?? '', error: message => notify(message, true) }); // I-139 A3: hidden unless the relaxed prompts are on
    new PeopleThingsPanel($('people-things'), { get: () => window.desktop.getPeopleThings(), change: op => window.desktop.changePeopleThings(op),
      changed: callback => window.desktop.onMemoryChanged(callback), error: message => notify(message, true) }); // I-088 你生活里的人和事
    mountAssistantPanel(document.getElementById('assistant-panel'), message => notify(message, true)); // I-071 v2 Claude 助手
    new AgentChannelPanel($('agent-channel'), { get: () => window.desktop.getAgentChannel(), setEnabled: value => window.desktop.setAgentChannelEnabled(value),
      changed: callback => window.desktop.onAgentChannel(callback), copy: text => navigator.clipboard.writeText(text), error: message => notify(message, true),
      setInterconnect: value => window.desktop.setAgentInterconnect(value), relink: () => window.desktop.relinkAgentClaudeCode(), undo: id => window.desktop.undoAgentAction(id),
      diagnostics: () => window.desktop.getDiagnostics() }); // I-014; I-061: 「复制诊断信息」
    new LocalAsrPanel($('local-asr'), { get: () => window.desktop.getLocalAsr(), changed: callback => window.desktop.onLocalAsr(callback),
      download: () => window.desktop.downloadLocalAsr(), cancel: () => window.desktop.cancelLocalAsrDownload(), dismiss: () => window.desktop.dismissLocalAsrPrompt(),
      importFiles: () => window.desktop.importLocalAsr(), remove: () => window.desktop.removeLocalAsr(),
      reveal: () => controlNavigation?.navigate('providers', 'voice-input-config'), error: message => notify(message, true) });
    const voiceprintBox = document.createElement('div'); voiceprintBox.id = 'voiceprint'; $('local-asr').after(voiceprintBox); // Unbound v1 step 3: beside the local recognizer it needs
    new VoiceprintPanel(voiceprintBox, { get: () => window.desktop.getVoiceprint(), changed: callback => window.desktop.onVoiceprint(callback), set: on => window.desktop.setVoiceprint(on),
      retry: () => window.desktop.retryVoiceprintDownload(), enrol: () => window.desktop.startVoiceprintEnrol(), cancelEnrol: () => window.desktop.cancelVoiceprintEnrol(),
      deleteData: () => window.desktop.deleteVoiceprint(), remove: () => window.desktop.removeVoiceprintComponent(), error: message => notify(message, true) });
    new PoseSensingPanel($('pose-sensing'), { get: () => window.desktop.getPoseSensing(), changed: callback => window.desktop.onPoseSensing(callback),
      download: () => window.desktop.downloadPoseComponents(), cancel: () => window.desktop.cancelPoseDownload(), dismiss: () => window.desktop.dismissPosePrompt(),
      importFiles: () => window.desktop.importPoseComponents(), remove: () => window.desktop.removePoseComponents(), redetect: () => window.desktop.redetectPoseHardware(),
      diagnostics: () => window.desktop.getPoseDiagnostics(), reveal: () => controlNavigation?.navigate('privacy', 'privacy-camera'), error: message => notify(message, true) }, $('runtime-camera').closest('label'));
    new FaceCheckPanel($('face-check'), { get: () => window.desktop.getFaceCheck(), changed: callback => window.desktop.onFaceCheck(callback), set: on => window.desktop.setFaceCheck(on), // I-135
      download: () => window.desktop.downloadFaceComponents(), cancelDownload: () => window.desktop.cancelFaceDownload(), enrol: () => window.desktop.startFaceEnrolment(), cancelEnrol: () => window.desktop.cancelFaceEnrolment(),
      deleteData: () => window.desktop.deleteFaceData(), importFiles: () => window.desktop.importFaceComponents(), remove: () => window.desktop.removeFaceComponents(), error: message => notify(message, true) });
    new ChatAvailabilityNotice($('chat-availability'), { get: () => window.desktop.getChatAvailability(), changed: callback => window.desktop.onChatAvailability(callback),
      retry: () => window.desktop.retryChatAvailability(), help: () => window.desktop.openClaudeHelp(), networkSettings: () => window.desktop.openNetworkSettings(), error: message => notify(message, true) });
    new PartHealthNotice($('part-health'), { get: () => window.desktop.getPartHealth(), changed: callback => window.desktop.onPartHealth(callback),
      switches: unit => (PART_SWITCH_ELEMENTS[unit] ?? []).flatMap(id => { const element = document.getElementById(id); return element ? [element] : []; }) }); // overhaul step 7
    window.desktop.onAgentChannelAction(action => runAgentRendererAction(action, { voicePreview: () => $('test-voice').click(),
      playPreview: recipe => $(recipe === 'shy' ? 'shy-preview' : 'surprise-preview').click() }));
    projectPetVisibility();
}
/** Control window only: the whole-motion preview session. */
export function createMotionPreview(): void {
  if (!isPet) motionPreview = new MotionPreviewSession({
    getSettings: () => settings,
    load: (packId, motionId) => window.desktop.previewMotion(packId, motionId),
    apply: view => stage.applySettings(view),
    onState: state => {
      syncBehaviorGate();
      motionLibraryControls?.setPreviewState(state);
      text('motion-name', state.phase === 'idle' ? settings.motion?.name ?? uiText('未载入 · 使用默认站姿') : uiTemplate`预览：${state.name ?? uiText('动作')}`);
    },
  });
}
/** Control window only: the settings form, the voice style panel, Claude tasks, Unbound's typed line and the motion library. */
export async function mountControlTools(): Promise<void> {
  if (!isPet) {
    syncForm();
    bindControls();
    emotionalVoiceControls = new EmotionalVoiceControls($('emotional-voice'), {
      getConfig: panelTtsConfig,
      getContextKey: () => JSON.stringify(voiceContext()),
      getContextLabel: () => uiTemplate`${characterName} · ${settings.model?.name ?? uiText('未选择模型')} 的专属语音风格`,
      onChange: async draft => { // 2026-11-25: no stop; a change applies from her next reply
        const current = settings.tts ?? structuredClone(DEFAULT_TTS_CONFIG);
        const context = voiceContext();
        const { voice, instruction, emotion, rate } = draft;
        const { fishVoiceId, fishActingStyle, ownProvider } = draft; // I-091: ownProvider = her own read-aloud provider (absent = follow global); // I-070 step 2: this character's own Drama 3 voice id and acting style
        settings.tts = {
          ...current, provider: draft.provider, apiHost: draft.apiHost, region: draft.region,
          model: draft.model, apiKey: draft.apiKey, introduced: draft.introduced,
          fishApiKey: draft.fishApiKey, fishMonthlyCapUsd: draft.fishMonthlyCapUsd,
          ...(context.characterId && context.modelPath ? { styleBindings: [
            ...(current.styleBindings ?? []).filter(binding => binding.characterId !== context.characterId || binding.modelPath !== context.modelPath),
            { ...context, voice, instruction, emotion, rate, fishVoiceId, ...(fishActingStyle ? { fishActingStyle } : {}), ...(ownProvider ? { provider: ownProvider } : {}) },
          ].slice(-64) } : { voice, instruction, emotion, rate, fishVoiceId, ...(fishActingStyle ? { fishActingStyle } : {}) }),
        };
        if (!fishActingStyle && !(context.characterId && context.modelPath)) delete settings.tts.fishActingStyle;
        if (!(await save())) throw new Error(uiText('语音配置未保存，请检查填写内容。'));
      },
      onPreview: text => speech.preview(text),
      onCharacterPreview: text => speakingTtsConfig().provider === 'system'
        ? speech.preview(text)
        : speech.previewCharacter(text, () => window.desktop.prepareCharacterSpeechPreview()),
      onStop: () => speech.stop(),
      onOpenConsole: () => window.desktop.openTtsConsole(),
      onOpenGuide: () => window.desktop.openTtsGuide(),
      onOpenHerVoice: goToHerVoice, // I-162 step 2
      getFishBudget: () => fishFallback.view(),
      onOpenFishKeys: () => window.desktop.openFishApiKeys(),
      onOpenFishBilling: () => window.desktop.openFishBilling(),
      onFirstUse: message => notify(message,false,'voice-setup'),
      onError: message => notify(message, true),
    });
    codexTasks = new CodexTasks($('codex-tasks'), {
      api: window.desktop,
      getSettings: () => settings,
      beforeStart: save,
      onDirectorySelected: async path => { settings.agent.workingDirectory = path; await save(); },
      onError: message => notify(message, true),
      onOpen: openCodexTaskPanel,
    });
    taskProposalUnsubscribe = window.desktop.onCodexTaskProposal(prompt => {
      if (!codexTasks?.offer(prompt)) { codexTasks?.prepare(prompt); openCodexTaskPanel(); }
    });
    // Unbound v1 step 2: a line typed in her small box goes out exactly like this window's own chat box (the same sendChat and host `chat`; a draft being typed here is put back).
    // I-177: sent while she is still answering, it stops her reply and goes out as a normal turn; the host says how far her bubble got (src/brain/pause-talk-send.ts).
    // 2026-11-22: the host hears whether it really went out (a drop opens her box again with the line; src/brain/pause-talk-send.ts receiveUnboundSay).
    window.desktop.onUnboundSay?.(said => { void receiveUnboundSay(said, { box: () => $<HTMLTextAreaElement>('chat-input'), answering: () => !!activeChat, stop: () => stopChat(), send: at => sendChat(true, false, at), ack: ack => { void window.desktop.ackUnboundSay?.(ack).catch(() => {}); } }); });
    motionLibraryControls = new MotionLibraryControls($("motion-library"), {
      getModel: () => settings.model,
      getSettings: () => settings,
      beforeInstall: () => save(),
      onPreview: (packId, motion, layer) => {stage.cancelVisualPreview();stage.cancelBodyPreview();return motionPreview!.start(packId, motion, layer);},
      onStopPreview: () => motionPreview!.stop(),
      onClearLayer: async layer => {
        await motionPreview!.stop();
        if (!(await save())) return;
        const accepted = await window.desktop.clearMotionLayer(layer);
        setSettings(mergeSettings(hostSettings, settings, accepted));
        projectPetVisibility();
        setHostSettings(accepted);
        applyStage();
        updateSummary();
      },
      onEnabled: async () => {
        const accepted = await window.desktop.getSettings();
        setSettings(mergeSettings(hostSettings, settings, accepted));
        projectPetVisibility();
        setHostSettings(accepted);
        applyStage();
        updateSummary();
      },
      onError: (message) => notify(message, true),
    });
    await motionLibraryControls.init();
    motionLibraryControls?.setMotionFit(motionFitView);
  }
}
/** Control window only: the character cards, the character page, the blush calibration and the model capability panel. */
export async function mountCharacterTools(): Promise<void> {
  if (!isPet) {
    visualPreviewUnsubscribe=window.desktop.onVisualPreviewCancelled(value=>stage.cancelVisualPreview(value.id,value.token,false));
    bodyPreviewUnsubscribe=window.desktop.onBodyPreviewCancelled(value=>stage.cancelBodyPreview(value.id,value.token,false));
    surprisePreviewUnsubscribe=window.desktop.onSurprisePreviewCancelled(value=>stage.cancelSurprisePreview(value.id));
    characterControls = new CharacterCards($('character-cards'), { onError: message => notify(message, true), onNotice: message => notify(message), onState: applyCharacterCards, expressionSupport: recipe => stage.expressionSupport(recipe),
      onVisualPreview:async view=>{if(motionPreview&&motionPreview.state.phase!=='idle')throw Error(uiText('请先停止当前完整动作预览，再预览眉眼。'));return stage.previewVisual(view);},
      onExpressionPreview:async view=>{if(motionPreview&&motionPreview.state.phase!=='idle')throw Error(uiText('请先停止当前完整动作预览，再预览眉眼。'));return stage.previewVisual(view);},
      onBodyPreview:async view=>{if(motionPreview&&motionPreview.state.phase!=='idle')throw Error(uiText('请先停止当前完整动作预览，再预览姿势。'));return stage.previewBody(view);},
      onDelete: id => characterPage?.askDelete(id),
      voice: characterVoicePorts(), // I-162 step 2: 「她的声音」
      onCreated: (card, how) => void characterPage?.discuss(card.id, how, [], card), // I-018: Claude talks a new card over (skippable)
    });
    await characterControls.init();
    characterPage = new CharacterPage($('character-page'), { api: window.desktop, onError: message => notify(message, true), onNotice: message => notify(message),
      onState: applyCharacterCards, onEdit: id => characterControls?.edit(id), onTune: id => characterControls?.edit(id, 'tune'), onBlank: () => characterControls?.newBlank(),
      capture: url => stage.captureCharacterAvatar(url), modelUrl: () => settings.model?.url ?? '' });
    await characterPage.init();
    $('goto-characters')?.addEventListener('click', () => controlNavigation?.navigate('characters'));
    const calibrationContainer = document.createElement('div'); $('character-cards').after(calibrationContainer);
    blushCalibrationControls = new BlushCalibrationControls(calibrationContainer, {
      onApply: async (modelKey, value) => { const url = settings.model?.url ?? ''; const view = await window.desktop.setBlushCalibration(modelKey, value); applyBlushCalibration(view, url); },
      onPreview: value => stage.previewBlush(value),
      onError: message => notify(message, true),
    });
    // I-024 这个模型能做什么: between the editor and the blush calibration; 试一下 plays on the companion.
    const capabilityContainer = document.createElement('div'); $('character-cards').after(capabilityContainer);
    modelCapabilityPanel = new ModelCapabilityPanel(capabilityContainer, { preview: id => window.desktop.previewModelCapability(id),
      setChoice: (modelKey, id, choice) => window.desktop.setModelCapabilityChoice(modelKey, id, choice), onError: message => notify(message, true),
      modelFormat: () => modelFormatOf(settings.model?.url ?? '') }); // I-152: a VRM's card is not there yet; the panel says why
    if (modelCapabilitySync) modelCapabilityPanel.update(modelCapabilitySync.state);
  }
}


// Writers for the other renderer wiring files (an ES module binding is written only where it is declared).
export function setVisualPreviewUnsubscribe(value: typeof visualPreviewUnsubscribe): void { visualPreviewUnsubscribe = value; }
export function setBodyPreviewUnsubscribe(value: typeof bodyPreviewUnsubscribe): void { bodyPreviewUnsubscribe = value; }
export function setSurprisePreviewUnsubscribe(value: typeof surprisePreviewUnsubscribe): void { surprisePreviewUnsubscribe = value; }
export function setModelCapabilityPanel(value: typeof modelCapabilityPanel): void { modelCapabilityPanel = value; }
