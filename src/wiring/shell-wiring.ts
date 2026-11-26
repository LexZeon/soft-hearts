// Renderer wiring, Window choice, DOM helpers, notices, the start-up failure page and unload (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText, uiMarkup } from '../foundation/ui-language';
import { agentNoticeText } from '../safety';
import { ImmersiveNotice } from '../stage';
import { conciseFailure, NOTICE_ACTIONS, type NoticeAction } from '../settings';
import { watchClaudeTasks } from '../safety';
import { renderReplyWaiting } from '../../shared/brain/reply-waiting-presentation';
import { captureController, controlNavigation, saveTimer } from './settings-wiring';
import { blushCalibrationUnsubscribe, modelCapabilitySync, modelPhysicsUnsubscribe, musicSettingsUnsubscribe, pointerTimer, stage } from './stage-wiring';
import { immersiveDeveloperMode, moodCompanion } from './mood-wiring';
import { speech, speechChannel } from './voice-wiring';
import { ambientAudioController, mediaInput } from './voice-chat-wiring';
import { assistantNode, petTaskOfferCleanup, releaseReplySpeech, setTextMemorialDeliveredUnsubscribe, setTextMemorialOffer, textMemorialDeliveredUnsubscribe, textMemorialOffer } from './chat-wiring';
import { chatChannel, replyPresentation } from './chat-view-wiring';
import { lookButton, lookMeButton, screenSharingOptions, setLookButton, setLookMeButton, systemAudioInput } from './senses-wiring';
import { r20ProactiveOfferUI, setR20ProactiveOfferUI } from './initiative-wiring';
import { ambientTranscriptHistory, closeProfileForNotice, memoryPanel, setUserProfilePanel, userProfilePanel } from './memory-wiring';
import { petUI } from './pet-window-wiring';
import { blushCalibrationControls, bodyPreviewUnsubscribe, characterControls, characterPage, characterStickerControls, codexTasks, emotionalVoiceControls, modelCapabilityPanel, motionLibraryControls, motionPreview, setBodyPreviewUnsubscribe, setModelCapabilityPanel, setSurprisePreviewUnsubscribe, setVisualPreviewUnsubscribe, surprisePreviewUnsubscribe, taskProposalUnsubscribe, visualPreviewUnsubscribe } from './control-window-wiring';
export let app: HTMLDivElement;
export let isPet = false;
export let windowKind: 'pet' | 'controls' = 'controls';
/** The renderer entry picks the window first (`?pet`: the companion window; otherwise the control window); nothing else runs before it. */
export function pickWindow(pet: boolean): void {
  app = document.querySelector<HTMLDivElement>("#app")!;
  isPet = pet;
  windowKind = isPet ? 'pet' : 'controls';
}
export let immersiveNotice: ImmersiveNotice | null = null;
export let pendingNotice: {message:string;error:boolean;action?:NoticeAction} | null = null;
export let lastStageStatus = '';
export const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export function text(id: string, value: string): void {
  const element = $(id);
  if (element) element.textContent = value;
}
export function notify(message: string, error = false, action?: NoticeAction): void {
  const value=String(message).slice(0,4000);
  if(!immersiveNotice){
    if(!pendingNotice?.error || error)pendingNotice={message:value,error,action};
    return;
  }
  if(action)immersiveNotice.publishAction(uiText(NOTICE_ACTIONS[action]));
  else immersiveNotice.publish(value,error,error ? conciseFailure(value) : undefined);
}
/** A fixed, authored line that is also one click to a page (I-162 step 2); before the notice is mounted it waits as an ordinary line. */
export function notifyLink(message: string, go: () => void): void {
  if(!immersiveNotice){ pendingNotice={message:String(message).slice(0,4000),error:false}; return; }
  immersiveNotice.publishLink(String(message).slice(0,400), go);
}
export function mountImmersiveNotice(): void {
  immersiveNotice?.dispose();
  immersiveNotice=new ImmersiveNotice(document,{quietOrdinaryFailures:isPet}); // no failure notices on the companion outside developer mode
  immersiveNotice.setDeveloperMode(immersiveDeveloperMode);
  const pending=pendingNotice;pendingNotice=null;
  if(pending)notify(pending.message,pending.error,pending.action);
}
export function displayFailure(message:string):string{
  return immersiveDeveloperMode ? String(message).slice(0,4000) : conciseFailure(message,'chat');
}
export function updateStageStatus(message:string):void{
  lastStageStatus=message;
  const visible=immersiveDeveloperMode ? message : /模型已就绪|VMD 播放中/.test(message)
    ? uiText('模型已就绪') : /读取|加载|准备/.test(message) ? uiText('正在准备角色…') : '';
  text(isPet ? 'pet-status' : 'stage-status',visible);
}
export function showStartupFailure(error:unknown):void{
  const recovery=uiMarkup('<section id="startup-recovery" role="alert"><h1>暂时未能启动</h1><p>可以查看问题详情，或重试启动。</p><button id="startup-retry" type="button">重试</button><button id="startup-controls" type="button">打开设置</button><button id="startup-quit" type="button">退出</button></section>');
  if(!document.getElementById('notice-details')){
    app.innerHTML=recovery+uiMarkup('<button id="notice-details" type="button" hidden>查看问题详情</button><section id="notice-detail-panel" class="notice-detail-panel" hidden><button id="notice-detail-close" type="button">关闭详情</button><pre id="notice-detail-text"></pre></section><div id="toast" class="toast" role="status"></div>');
  }else if(!document.getElementById('startup-recovery')){
    // Keep any initialized scene and its owners intact until explicit retry/exit.
    app.insertAdjacentHTML('afterbegin',recovery);
  }
  if(!immersiveNotice)mountImmersiveNotice();
  $('startup-retry').onclick=()=>location.reload();
  $('startup-controls').onclick=()=>void window.desktop.openControls().catch(problem=>notify(String(problem),true));
  $('startup-quit').onclick=()=>void window.desktop.quit();
  immersiveNotice!.publish(String(error),true,conciseFailure(error,'startup'));
}
/** "由 Claude 操作" notices and R20's task switch watch (both windows). */
export function wireAgentNotices(): void {
  window.desktop.onAgentChannelNotice(notice => notify(agentNoticeText(notice))); // "由 Claude 操作" in both windows.
  watchClaudeTasks(window.desktop); // R20: chat offers a task only while the user's switch is on.
}
/** The window closing: everything this window made is disposed, in this order. */
export function wireUnload(): void {
  window.addEventListener("beforeunload", () => {
    characterStickerControls?.dispose();
    if(!isPet)void window.desktop.cancelCharacterSticker().catch(()=>undefined);
    visualPreviewUnsubscribe?.();setVisualPreviewUnsubscribe(null);
    bodyPreviewUnsubscribe?.();setBodyPreviewUnsubscribe(null);
    surprisePreviewUnsubscribe?.();setSurprisePreviewUnsubscribe(null);
    textMemorialOffer?.dispose(); setTextMemorialOffer(null);
    r20ProactiveOfferUI?.dispose(); setR20ProactiveOfferUI(null);
    textMemorialDeliveredUnsubscribe?.(); setTextMemorialDeliveredUnsubscribe(null);
    replyPresentation.clear();
    if (assistantNode) renderReplyWaiting(assistantNode, false);
    if(pointerTimer)clearInterval(pointerTimer);
    immersiveNotice?.dispose();
    $('notice-details')?.removeEventListener('click', closeProfileForNotice);
    userProfilePanel?.dispose(); setUserProfilePanel(null);
    clearTimeout(saveTimer);
    captureController?.abort();
    releaseReplySpeech?.();
    speech.stop('window');
    speech.dispose();
    emotionalVoiceControls?.dispose();
    speechChannel.close();
    chatChannel.close();
    mediaInput?.dispose();
    ambientAudioController?.dispose(); ambientTranscriptHistory?.dispose();
    screenSharingOptions?.dispose();
    lookButton?.dispose(); setLookButton(null); lookMeButton?.dispose(); setLookMeButton(null);
    systemAudioInput?.dispose();
    motionLibraryControls?.dispose();
    motionPreview?.dispose();
    characterControls?.dispose();
    characterPage?.dispose();
    modelCapabilityPanel?.dispose(); setModelCapabilityPanel(null);
    modelCapabilitySync?.dispose();
    blushCalibrationControls?.dispose();
    blushCalibrationUnsubscribe?.();
    codexTasks?.dispose();
    controlNavigation?.dispose();
    taskProposalUnsubscribe?.();
    modelPhysicsUnsubscribe?.();
    musicSettingsUnsubscribe?.();
    petTaskOfferCleanup?.();
    petUI?.dispose();
    moodCompanion?.dispose();
    memoryPanel?.dispose();
    stage.dispose();
  });
}
