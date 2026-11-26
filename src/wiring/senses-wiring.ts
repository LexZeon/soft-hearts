// Renderer wiring, 感知: the input and sharing switches, the privacy lines, screen sharing options, the look buttons and offer, her look-lines, system audio and her comments (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText, uiTemplate } from '../foundation/ui-language';
import { cameraRefusalAction, NOTICE_ACTIONS, voiceRefusalAction } from '../settings';
import type { RuntimeState, RuntimePatch } from "../../shared/contracts";
import { ScreenSharingOptions, DEFAULT_SCREEN_SHARING_OPTIONS } from '../senses';
import { LookButton, lookButtonContent } from '../senses';
import { LookOfferPrompt, lookOfferContent } from '../senses';
import { formatVisionPresentation, type VisionRuntimeState } from '../../shared/senses';
import { prepareVisionDelivery } from '../senses';
import { SystemAudioInput, switchWatchTogether } from '../senses';
import { $, isPet, notify, text } from './shell-wiring';
import { settings } from './settings-wiring';
import { cameraEditing, composing } from './stage-wiring';
import { heldLines, replySpeechQueue, speech } from './voice-wiring';
import { ambientAudioController, mediaInput } from './voice-chat-wiring';
import { activeChat, activeVisionSpeechId, clearChat, hostVisible, initiativeGeneration, provisionalInitiative, rememberAmbientComment, rememberInitiative, retractInitiative, sendChat, setActiveVisionSpeechId, setProvisionalInitiative, shownInitiatives } from './chat-wiring';
import { addMessage, endReplySpeech } from './chat-view-wiring';
import { characterName } from './cards-wiring';
import { petUI } from './pet-window-wiring';
import { clearAfterReply } from '../brain';
import { wireSources } from './sources-wiring';
export let screenSharingOptions: ScreenSharingOptions | null = null;
export let lookButton: LookButton | null = null, lookMeButton: LookButton | null = null; // I-084: 「让她看看我」
export let visionRuntime: VisionRuntimeState = { ...DEFAULT_SCREEN_SHARING_OPTIONS, supported: false, status: '' };
export let systemAudioInput: SystemAudioInput | null = null;
export const ambientDisplayedComments = new Set<string>();
export const ambientOfferedComments = new Set<string>();
export let runtime: RuntimeState = { voiceInput: false, screenSharing: false, cameraSharing: false, voiceOwner: null, cameraOwner: null };
/** System audio (companion) and her comments on what you listen to (offers on the companion, rows in the control window). */
export function wireAmbientComments(): void {
  if (isPet) systemAudioInput = new SystemAudioInput({
    onSample: sample => ambientAudioController?.captureSystemSample(sample),
    onState: state => { petUI?.setSystemAudioState(state); ambientAudioController?.captureState(state); },
    onStatus: status => petUI?.setSystemAudioState({ active: systemAudioInput?.active ?? false }, status),
    onError: message => notify(message, true),
  });
  if (isPet) window.desktop.onAmbientCommentOffer(offer => { if (!heldLines.ambient(offer)) void presentAmbientComment(offer); });

  window.desktop.onAmbientCommentCommitted(comment => {
    if (isPet || activeChat || ambientDisplayedComments.has(comment.id)) return;
    rememberAmbientComment(comment);
  });
  window.desktop.onAmbientCommentCancelled(event => {
    heldLines.cancel(event.id);
    if (isPet) petUI?.hideAnswerFor(event.id);
  });
}
/** Screen sharing options, the look buttons, the look offer (companion), the vision state and her look-lines. */
export async function wireVision(): Promise<void> {
  const sharingMount = document.createElement('div');
  sharingMount.className = isPet ? 'pet-sharing-options' : 'control-sharing-options';
  sharingMount.dataset.moodUi = 'true';
  (isPet ? $('pet-toolbar') : $('runtime-screen').closest('.settings-section')!).append(sharingMount);
  screenSharingOptions = new ScreenSharingOptions(sharingMount, patch => {
    void window.desktop.setVisionOptions(patch).then(applyVisionRuntime, error => {
      notify(String(error), true); screenSharingOptions?.update({ ...visionRuntime, ...runtime });
    });
  });
  // 识图第 1 步: "给她看看屏幕", only while screen sharing is on: sends what is typed (or "你看看我的屏幕。") with the screen (src/senses/LookButton.ts).
  const lookHost = isPet ? document.getElementById('chat-form') : document.querySelector<HTMLElement>('.composer-tools > div');
  if (lookHost) lookButton = new LookButton(lookHost, isPet ? document.getElementById('send-chat') : null, isPet, () => {
    const input = $<HTMLTextAreaElement>('chat-input'); input.value = lookButtonContent(input.value); void sendChat(true, true);
  });
  // I-084 「让她看看我」, only while 「发图片」 is on: what is typed (or "你看看我。") with one clear camera picture, like saying "看看我".
  if (lookHost) lookMeButton = new LookButton(lookHost, isPet ? document.getElementById('send-chat') : null, isPet, () => {
    const input = $<HTMLTextAreaElement>('chat-input'); input.value = lookButtonContent(input.value, 'me'); void sendChat(true, 'me');
  }, 'me');
  lookButton?.update(runtime); lookMeButton?.update(runtime);
  // 屏幕只读大概: her "要我凑近看看吗" shows "让她看清楚屏幕吗？ 看吧 / 不用" in the companion's chat (src/senses/LookOfferPrompt.ts); 看吧 sends like the
  // button above, 不用 closes her offer without a frame.
  if (isPet) {
    const lookOffer = new LookOfferPrompt({
      container: () => document.querySelector<HTMLElement>('.pet-chat'),
      look: () => { const input = $<HTMLTextAreaElement>('chat-input'); input.value = lookOfferContent(input.value); void sendChat(true, true); },
      decline: id => { void window.desktop.declineLookOffer(id).catch(() => {}); },
    });
    window.desktop.onLookOffer(offer => lookOffer.present(offer));
  }
  const visionStatus = document.createElement('output'); visionStatus.id = 'vision-runtime-status';
  visionStatus.setAttribute('role', 'status'); sharingMount.append(visionStatus);
  window.desktop.onVisionRuntime(applyVisionRuntime);
  applyVisionRuntime(await window.desktop.getVisionRuntime());
  window.desktop.onVisionContextCleared(value => { clearAfterReply(value, { active: () => activeChat ?? replySpeechQueue.replyId, clear: () => { clearChat(false, false, true); setProvisionalInitiative(null); }, keep: () => setProvisionalInitiative(null) }); }); // the user's own draft snapshots stay (src/senses/look-send.ts draftAfterClear); I-174: a step away keeps her reply; I-221: a sense off keeps the page
  window.desktop.onVisionInitiative(event => {
    if (isPet && heldLines.vision(event)) return;
    if (event.type === 'cancel') {
      if (activeVisionSpeechId === event.id) { setActiveVisionSpeechId(null); speech.stop(); petUI?.hideAnswer(); }
      retractInitiative(event.id); return;
    }
    if (!isPet) return;
    const message = event.message, silent = event.silent === true; // I-066: in a meeting her own line is never read aloud
    if (!petUI || !hostVisible || activeChat || $<HTMLTextAreaElement>('chat-input').value.trim() || shownInitiatives.has(message.id)) {
      void window.desktop.cancelVisionInitiative(); return;
    }
    speech.stop();
    const generation = initiativeGeneration;
    const displayText = formatVisionPresentation(message);
    // Keep the real reply pending while its separate window confirms display.
    // A hidden companion DOM proxy is not evidence that the user saw this body.
    const body = petUI.showAnswer(displayText, true, message.id);
    setProvisionalInitiative({ id: message.id, body });
    void prepareVisionDelivery({
      publish: () => window.desktop.updatePetReply({ text: displayText, state: 'streaming' }),
      ack: () => window.desktop.ackVisionInitiative(message.id),
      current: () => generation === initiativeGeneration && provisionalInitiative?.id === message.id
        && hostVisible && !activeChat && !$<HTMLTextAreaElement>('chat-input').value.trim()
        && !shownInitiatives.has(message.id),
      retract: () => retractInitiative(message.id),
      commit: () => {
        setProvisionalInitiative(null);
        rememberInitiative(message);
        setActiveVisionSpeechId(message.id);
        petUI?.finishAnswer(displayText, message.id, settings.voice.enabled && !silent, true);
        if (settings.voice.enabled && !silent) {
          const ended = () => { if (activeVisionSpeechId === message.id) setActiveVisionSpeechId(null); endReplySpeech(message.id); };
          void speech.speak(message.text, settings.voice, { replyId: message.id }).then(ended, ended);
        }
      },
    });
  });
  window.desktop.onVisionInitiativeDelivered(message => {
    if (isPet || shownInitiatives.has(message.id)) return;
    const body = addMessage('assistant', message.text);
    const label = body.parentElement?.querySelector('.message-label');
    if (label) label.textContent = uiTemplate`${characterName} · 主动 · ${message.origin.labels.join('、')}`;
    rememberInitiative(message);
  });
}
/** The input and sharing switches as the host has them. */
export async function wireRuntimeState(): Promise<void> {
  window.desktop.onRuntimeState(applyRuntime);
  applyRuntime(await window.desktop.getRuntimeState());
  wireSources(); // I-190: the source menus and the device lists (src/wiring/sources-wiring.ts)
}
/** A refused camera request says why, in the window where it was clicked (2026-11-03: the companion button looked dead). */
export function explainRuntimeReply(reply: RuntimeState): void { const action = cameraRefusalAction(reply) ?? voiceRefusalAction(reply); if (action) notify(uiText(NOTICE_ACTIONS[action]), false, action); }
/** I-187 和她一起看 (the companion toolbar), one switch: the screen and the dialogue on together, or both off (src/senses/watch-together-toggle.ts). */
export async function toggleWatchTogether(): Promise<void> {
  const dialogue = ambientAudioController?.readingView?.sources['system-audio'].movie.intent === true;
  try { await switchWatchTogether(window.desktop, { screen: runtime.screenSharing, dialogue }, explainRuntimeReply); }
  catch (error) { notify(String(error), true); }
}
export async function toggleRuntime(feature: keyof RuntimePatch): Promise<void> {
  try { explainRuntimeReply(await window.desktop.setRuntimeState({ [feature]: !runtime[feature] })); }
  catch (error) { notify(String(error), true); }
}
/** I-221 (2026-11-26): a sharing switch going off no longer clears or stops anything here (it cut her reply and emptied the page); the host drops what she was shown at once and tells the page (desk:vision-context-cleared { keepConversation }). */
export function applyRuntime(next: RuntimeState): void {
  runtime = next;
  screenSharingOptions?.update({ ...visionRuntime, ...next });
  lookButton?.update(next); lookMeButton?.update(next);
  petUI?.applyRuntime(next);
  void mediaInput?.applyRuntime(next);
  if (isPet) return;
  for (const [id, feature] of [['runtime-voice','voiceInput'],['runtime-screen','screenSharing'],['runtime-camera','cameraLocal'],['runtime-camera-images','cameraImages']] as const) {
    const input = $<HTMLInputElement>(id); if (input) input.checked = next[feature] === true;
  }
  const active = [next.voiceInput ? uiText('语音输入') : '', next.screenSharing ? uiText('屏幕共享') : '', next.cameraSharing ? uiText(next.cameraImages ? (next.cameraLocal ? '摄像头发图片 + 姿势识别' : '摄像头发图片') : '摄像头感知') : ''].filter(Boolean);
  text('privacy-indicator', active.length ? uiTemplate`${active.join(' · ')}已开启` : uiText('输入与共享已关闭'));
  text('privacy-state', next.screenSharing ? uiText('屏幕共享已开启 · 平时只知道你大概在做什么，叫她看才看清楚') : next.cameraImages ? uiText('摄像头发图片已开启 · 平时发消息不附图，叫她看时发清楚的一张') : next.cameraSharing ? uiText('摄像头感知开启中 · 画面只在本机处理，不保存、不上传') : uiText('屏幕与摄像头：共享关闭'));
}
export function applyVisionRuntime(state: VisionRuntimeState): void {
  visionRuntime = state;
  screenSharingOptions?.update({ ...state, ...runtime });
  text('vision-runtime-status', state.status);
}
export async function presentAmbientComment(offer: { id: string; sessionId: string; text: string }): Promise<void> {
  if (!isPet || !ambientAudioController?.active || ambientAudioController.sessionId !== offer.sessionId
    || activeChat || !hostVisible || document.hidden || composing || cameraEditing || petUI?.windowInteractionBlocked || $('chat-input').textContent?.trim()
    || ($('chat-input') as HTMLTextAreaElement).value.trim() || ambientDisplayedComments.has(offer.id) || ambientOfferedComments.has(offer.id)) return;
  ambientOfferedComments.add(offer.id);
  const body = petUI!.showAnswer(offer.text, true, offer.id);
  try {
    const accepted = await window.desktop.acknowledgeAmbientComment(offer.id);
    if (!accepted || activeChat || ambientAudioController.sessionId !== offer.sessionId || body.textContent !== offer.text) {
      petUI?.hideAnswerFor(offer.id);
      return;
    }
    rememberAmbientComment(accepted.comment);
    const expectsSpeech = settings.voice.enabled;
    petUI?.finishAnswer(offer.text, offer.id, expectsSpeech, true);
    if (expectsSpeech) {
      await speech.speak(offer.text, settings.voice, accepted.context).catch(() => {});
      petUI?.endAnswerSpeech(offer.id);
    }
  } catch (error) {
    petUI?.hideAnswerFor(offer.id);
    notify(String(error), true);
  } finally { ambientOfferedComments.delete(offer.id); }
}


// Writers for the other renderer wiring files (an ES module binding is written only where it is declared).
export function setLookButton(value: typeof lookButton): void { lookButton = value; }
export function setLookMeButton(value: typeof lookMeButton): void { lookMeButton = value; }
