// Renderer wiring, 大脑 · 聊天: the chat state and everything that writes it: sending, stopping, clearing, the stream, the other window's chat, reply speech in the bubbles, her own lines (look-lines, text memorials), window and page visibility (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText, uiTemplate } from '../foundation/ui-language';
import { outageDisplayText, type SendOutcome } from '../../shared/brain';
import { type CompanionCommandChoices } from '../settings/CompanionCommandChoices';
import type { VoiceConversationEvent } from '../../shared/voice';
import type { AppSettings, Attachment, ChatMessage, ChatStarted, StreamEvent, WindowVisibilityState } from "../../shared/contracts";
import { draftAfterClear, lookHint, turnAttachments } from '../senses';
import { type VisionInitiative } from '../../shared/senses';
import { TextMemorialOfferController, TextMemorialDeliveredHistory } from '../memory';
import type { AmbientComment } from '../../shared/senses';
import { mountCodexTaskOffer } from '../safety';
import { claudeTasksOffered } from '../safety';
import { renderReplyWaiting } from '../../shared/brain/reply-waiting-presentation';
import { pauseCutForSend, statusNotice, windowSendGuard } from '../brain';
import { formatReplySegments } from '../brain';
import { appendReplyHistory, appendVoiceReply, ambientCommentHistoryText, outgoingChatMessages, trimReplyHistory } from '../brain';
import { cleanChatRows, restoredChatHistory, restoredChatRows } from '../brain';
import { isTransientSwitch, TRANSIENT_SWITCH_DELAY_MS, TRANSIENT_SWITCH_RETRIES } from '../foundation/transient-switch';
import { scanBreathRequest } from '../../shared/actions';
import { scanFramingRequest } from '../../shared/stage';
import { scanStopReadoutRequest } from '../../shared/voice';
import { asksTestCommand } from '../../shared/safety';
import { replyMayRun } from '../../shared/foundation/step-away';
import { $, displayFailure, immersiveNotice, isPet, notify, text, windowKind } from './shell-wiring';
import { captureController, controlNavigation, projectPetVisibility, saveBeforeSend, settings, windowVisibility } from './settings-wiring';
import { stage, stopMotionPreview, syncBodyInputGate } from './stage-wiring';
import { immersiveDeveloperMode, moodCompanion } from './mood-wiring';
import { replySpeechQueue, speech, voicePlaybackActive } from './voice-wiring';
import { ambientAudioController, callControls, receiveVoiceConversation, voiceContinuationStatus, voiceDraftInput, voiceDraftRecords, voiceReplyIds, voiceUiGroups } from './voice-chat-wiring';
import { addMessage, chatChannel, type ChatWire, drawChatRows, endReplySpeech, prepareReplySpeechPresentation, renderAttachments, renderReadout, replyPresentation, replySpeechContext, reportReplySpeechError, setChatBusy } from './chat-view-wiring';
import { ambientDisplayedComments } from './senses-wiring';
import { testNotes } from './initiative-wiring';
import { userProfilePanel } from './memory-wiring';
import { characterName, characterState, chatContext } from './cards-wiring';
import { openingGreetingFor, presentGreeting } from './greeting-wiring'; // 2026-11-25
import { petUI } from './pet-window-wiring';
import { codexTasks } from './control-window-wiring';
import { refilledRowsFor, rememberRefilledRows, shownReplyText, speechBeats } from './speech-beats-wiring'; // 边说边演
import { bubbleFollow } from './bubble-follow-wiring'; // I-165
export let activeChat: string | null = null;
export const commandMessageRows = new Map<string, { root: HTMLElement; choices: CompanionCommandChoices | null }>();
export const readoutControlTurns = new Map<string, { user: ChatMessage; text: string; output: HTMLElement; finished: boolean }>();
export const sendGuard = windowSendGuard(() => windowKind, notify); // no silent drop
export function receiveReadoutControl(event: StreamEvent): boolean {
  const turn = readoutControlTurns.get(event.id);
  if (event.kind !== 'chat' || !turn) return false;
  if (turn.finished) return true;
  if (event.type === 'delta') { turn.text += event.text; turn.output.textContent = turn.text; }
  if (event.type === 'done' || event.type === 'error') {
    turn.finished = true;
    if (event.type === 'error') turn.output.textContent = displayFailure(event.text);
    else history = appendReplyHistory(history, turn.user, turn.text);
    sendGuard.release(event.id);
  }
  return true;
}
export function clearCommandMessageRows(cancel = true): void {
  for (const [id, row] of commandMessageRows) {
    row.choices?.dispose();
    if (isPet) row.root.remove();
    if (cancel) void window.desktop.cancel(id).catch(() => {});
  }
  commandMessageRows.clear();
  readoutControlTurns.clear(); sendGuard.release();
}
export let voiceSpeechReady: { replyId: string; epoch: string; presentationReady: boolean;
  pendingSpeech?: Extract<VoiceConversationEvent, { type: 'speech' }> } | null = null;
export let chatOwner: 'controls' | 'pet' | null = null;
export let activeUser: ChatMessage | null = null;
export let assistantNode: HTMLElement | null = null;
export let reply = "";
export let history: ChatMessage[] = [];
export let awaitingChatState = true;
export let attachments: Attachment[] = [];
export let hostVisible = false;
/** I-171, I-174: a minimize or a cover does not stop the reply; only a hide to the tray does (shared/foundation/step-away.ts herHere). */
export function shown(): boolean { return replyMayRun(hostVisible, document.hidden, windowVisibility.minimized); }
export let textMemorialOffer: TextMemorialOfferController | null = null;
export let textMemorialDeliveredUnsubscribe: (() => void) | null = null;
export let provisionalMemorialId: string | null = null;
export let activeMemorialSpeechId: string | null = null;
export const shownInitiatives = new Set<string>();
export let provisionalInitiative: { id: string; body: HTMLElement } | null = null;
export let initiativeGeneration = 0;
export let activeVisionSpeechId: string | null = null;
export let petTaskOfferCleanup: (() => void) | null = null;
export let releaseReplySpeech: (() => void) | null = null;
export let speechPlaybackErrorShown = false;
export let ordinaryVoiceConfig: AppSettings['voice'] | null = null;
export let ordinaryReplyPresentation: { id: string; text: string; context: string; index: number;
  early:boolean; kicked:boolean; ended:boolean; textDrained:boolean; streaming?:boolean; call?:boolean } | null = null;
export function finishReplySpeechPresentation(id: string, replyContext?: string): void {
  const accepted = ordinaryReplyPresentation;
  if (accepted?.id === id) {
    if (replyContext !== undefined && accepted.context !== replyContext) return;
    accepted.ended=true; bubbleFollow().over(id); // I-165: the reading is over: the rest of her bubble shows
    if(accepted.early&&!accepted.textDrained){petUI?.endAnswerSpeech(id);return;}
    ordinaryReplyPresentation = null;
    // A failed first-piece preparation still leaves one complete, readable
    // non-speaking answer. Never restore old content over a newer turn.
    if (!accepted.early && accepted.index === -1 && accepted.context === replySpeechContext() && !activeChat
      && shown()) {
      petUI?.finishAnswer(accepted.text, id, false, false, true);
      return;
    }
  }
  petUI?.endAnswerSpeech(id);
}
export function kickCompletedReply(accepted:NonNullable<typeof ordinaryReplyPresentation>):void {
  if(ordinaryReplyPresentation!==accepted||accepted.kicked||accepted.ended||(activeChat&&!accepted.streaming)
    ||accepted.context!==replySpeechContext()||!settings.voice.enabled||(isPet&&!shown()&&!(accepted.call&&callControls?.readsOut)))return; // Unbound v1 step 3: a call reply while she is out
  accepted.kicked=true;
  const release=()=>{
    if(ordinaryReplyPresentation!==accepted)return;
    if(releaseReplySpeech===release)releaseReplySpeech=null;
    endReplySpeech(accepted.id,accepted.context);
  };
  releaseReplySpeech=release;
  void replySpeechQueue.speak(accepted.id).then(release,error=>{
    if(ordinaryReplyPresentation!==accepted)return;
    reportReplySpeechError(error);release();
  });
}
/** R02: a Claude reply reads its first complete sentence as soon as its bubble shows, while the rest streams. */
export function startStreamingReplySpeech(id: string): void {
  if (ordinaryReplyPresentation?.id === id) { ordinaryReplyPresentation.text = reply; return; }
  // I-091 step 4: in a call her voice reply is read like a typed one, sentence by sentence (the host began its plan for it, electron/voice/voice-call/streaming-speech.ts).
  const call = voiceReplyIds.has(id) && !!callControls?.inCall && chatOwner === windowKind;
  if (settings.provider.kind !== 'claude' || !settings.voice.enabled || (!call && (!activeUser || voiceReplyIds.has(id)))) return;
  const accepted = ordinaryReplyPresentation = { id, text: reply, context: replySpeechContext(), index: -1, early: true, kicked: false, ended: false, textDrained: false, streaming: true, ...(call ? { call: true } : {}) };
  ordinaryVoiceConfig = { ...settings.voice }; speechPlaybackErrorShown = false; bubbleFollow().engage(id); // I-165: her bubble waits for her voice
  if (chatOwner === windowKind && (!isPet || shown() || (call && !!callControls?.readsOut))) kickCompletedReply(accepted); // Unbound v1 step 3: her companion window hidden while she is out
}
  export let lastProactiveInput = -Infinity;
  /** A press, a key, typing (I-174 item 3): her own line goes on (a message, the stop button, a clear sentence end it); the host hears of it. */
  export const noteProactiveInput = () => {
    textMemorialOffer?.invalidate();
    const now = performance.now(); if (now - lastProactiveInput < 500) return; lastProactiveInput = now;
    void window.desktop.noteVisionUserActivity().catch(() => {});
  };
/** The window's visibility as the host last said, onto the stage. */
export function showHostVisibility(): void {
  hostVisible = windowVisibility.visible;
  stage.setVisible(hostVisible);
}
/** Text memorials: her invitation on the companion, the delivered ones in the control window's chat. */
export function wireTextMemorial(): void {
  if (isPet) textMemorialOffer = new TextMemorialOfferController(window.desktop, {
    current: () => !!petUI && hostVisible && !activeChat && !replyPresentation.readoutPending
      && !ordinaryReplyPresentation && !voicePlaybackActive && !$<HTMLTextAreaElement>('chat-input').value.trim(),
    publish: async offer => {
      speech.stop(); provisionalMemorialId = offer.id;
      petUI?.showAnswer(offer.invite, true, offer.id);
      await window.desktop.updatePetReply({ text: offer.invite, state: 'streaming' });
    },
    retract: id => { if (provisionalMemorialId === id) { provisionalMemorialId = null; petUI?.hideAnswerFor(id); } },
    cancelled: id => { if (activeMemorialSpeechId === id) { activeMemorialSpeechId = null; speech.stop(); } petUI?.hideAnswerFor(id); },
    commit: result => {
      if (provisionalMemorialId !== result.offer.id) return;
      provisionalMemorialId = null;
      history.push({ role: 'assistant', content: result.offer.invite, origin: result.origin }); history = trimReplyHistory(history);
      petUI?.finishAnswer(result.offer.invite, result.offer.id, settings.voice.enabled, true);
      if (settings.voice.enabled) {
        activeMemorialSpeechId = result.offer.id;
        const ended = () => { if (activeMemorialSpeechId === result.offer.id) activeMemorialSpeechId = null; endReplySpeech(result.offer.id); };
        void speech.speak(result.offer.invite, settings.voice, result.context).then(ended, ended);
      }
    },
  });
  else {
    const delivered = new TextMemorialDeliveredHistory(event => {
      const body = addMessage('assistant', event.offer.invite);
      body.textContent = event.offer.invite;
      const label = body.parentElement?.querySelector('.message-label');
      if (label) label.textContent = uiTemplate`${characterName} · 主动 · ${event.origin.labels.join('、')}`;
      history.push({ role: 'assistant', content: event.offer.invite, origin: event.origin }); history = trimReplyHistory(history);
    });
    textMemorialDeliveredUnsubscribe = window.desktop.onTextMemorialEvent(event => delivered.event(event));
  }
}
/** The page hidden: the waiting reply, previews and the draft's snapshots go. */
export function wireDocumentVisibility(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (isPet) void ambientAudioController?.documentHidden(hostVisible).catch(() => {}); // 再续: only when the host says she is off the screen
      // I-171, I-174: a minimize, another window or the snip overlay also hide the document; the host's word decides (only a tray hide ends the reply).
      if (hostVisible) void window.desktop.getWindowVisibility().then(acceptWindowVisibility, () => {});
      else if (!shown()) hideWaitingPresentation();
      moodCompanion?.reset('document-hidden');
      stopMotionPreview();
      if(!isPet)void window.desktop.cancelCharacterSticker().catch(()=>undefined);
      captureController?.abort();
      attachments = [];
      if (!isPet) renderAttachments();
    } else if (hostVisible && replyPresentation.canPresent(activeChat)) petUI?.refreshAnswerReader(reply, !!activeChat);
  });
}
export function showCharacterGreeting(remember: boolean): void { // src/wiring/greeting-wiring.ts
  const greeting = presentGreeting();
  if (greeting && remember) history = [{ role: 'assistant', content: greeting }];
}
export function rememberInitiative(message: VisionInitiative): void {
  if (shownInitiatives.has(message.id)) return;
  shownInitiatives.add(message.id);
  if (shownInitiatives.size > 128) shownInitiatives.delete(shownInitiatives.values().next().value!);
  history.push({ role: 'assistant', content: `[角色主动观察：${message.origin.labels.join('、')}] ${message.text}`, origin: message.origin });
  history = trimReplyHistory(history);
}
export function retractInitiative(id: string): void {
  if (provisionalInitiative?.id !== id) return;
  initiativeGeneration++;
  if (isPet) petUI?.hideAnswer(); else provisionalInitiative.body.parentElement?.remove();
  provisionalInitiative = null;
}
export function rememberAmbientComment(comment: AmbientComment): void {
  if (ambientDisplayedComments.has(comment.id)) return;
  ambientDisplayedComments.add(comment.id);
  if (ambientDisplayedComments.size > 128) ambientDisplayedComments.delete(ambientDisplayedComments.values().next().value!);
  history.push({ role: 'assistant', content: ambientCommentHistoryText(comment.text) }); history = trimReplyHistory(history);
  if (!isPet) {
    const body = addMessage('assistant', comment.text);
    const label = body.parentElement?.querySelector('.message-label');
    if (label) label.textContent = uiTemplate`${characterName} · 一起听到的声音`;
  }
}
export async function sendChat(bypassSuggestion = false, look: boolean | 'me' = false, unboundAt?: number): Promise<SendOutcome> {
  const sentAt = unboundAt ?? Date.now(); // Developer latency timing only (electron/brain/reply-latency.ts).
  const input = $<HTMLTextAreaElement>("chat-input");
  const content = input.value.trim();
  if (!content && !attachments.length) return;
  const { busy, drop, local, timed, aside, stamp } = sendGuard.begin(activeChat, content, input, sentAt, unboundAt !== undefined); if (busy) return drop(busy);
  // A local control: the host reclassifies the literal text (no action, target ID or authorization leaves this window).
  if (!attachments.length && (scanStopReadoutRequest(content) !== 'none' || scanFramingRequest(content) !== 'none' || scanBreathRequest(content).kind !== 'none'))
    return (await local(crypto.randomUUID(), id => window.desktop.chat({ id, messages: outgoingChatMessages(history, { role: 'user', content }), attachments: [] }).then(() => true)))!;
  // D2 developer test command ("测试：…"): asked only in developer mode, and the host decides whether it was one. A "no" (mode off,
  // not a command) falls through as ordinary chat, unchanged. A command is not chat: no history, no archive, no reply, no readout.
  const command = asksTestCommand(immersiveDeveloperMode, attachments.length > 0, content) ? await local(crypto.randomUUID(),
    () => window.desktop.runTestCommand(content).then(outcome => { if (outcome.handled) testNotes?.begin(outcome.id, content); return outcome.handled; }), true) : null;
  if (command) return command;
  aside(window.desktop.noteUserInput());
  // R20: an explicit file/code/command request is offered as a task; only the user's click starts one.
  if (claudeTasksOffered() && !bypassSuggestion && content) {
    const context = chatContext();
    const continueChat = () => {
      if (input.value.trim() !== content || chatContext() !== context) {
        notify(uiText('消息或角色已更改，请重新发送。')); return;
      }
      if (!isPet) controlNavigation?.navigate('chat');
      void sendChat(true);
    };
    if (!isPet && codexTasks?.offer(content, continueChat)) return;
    if (isPet) {
      petTaskOfferCleanup?.(); petTaskOfferCleanup = null;
      let container = $('pet-task-offer');
      if (!container) {
        container = document.createElement('div'); container.id = 'pet-task-offer';
        document.querySelector('.pet-chat')?.prepend(container);
      }
      petTaskOfferCleanup = mountCodexTaskOffer(container, content, {
        onTask: prompt => {
          petTaskOfferCleanup = null;
          if (input.value.trim() !== content || chatContext() !== context) { notify(uiText('消息或角色已更改，请重新发送。')); return; }
          void window.desktop.proposeCodexTask(prompt).then(() => {
            if (input.value.trim() === content && chatContext() === context) input.value = '';
          }).catch(error => notify(String(error), true));
        },
        onChat: () => { petTaskOfferCleanup = null; continueChat(); },
        onDismiss: () => { petTaskOfferCleanup = null; },
      });
      if (petTaskOfferCleanup) return;
    }
  }
  if (!history.length) {
    const greeting = characterState?.cards.find(card => card.id === characterState!.activeId)?.greeting.trim();
    if (greeting) history = [{ role: 'assistant', content: greeting }];
  }
  // The earlier reply stops where it is; if part was never shown, how far it got goes with this message (F7 on: her unsaid words; off: a plain "not seen" line).
  const pauseCut = pauseCutForSend(replyPresentation);
  const id = crypto.randomUUID();
  activeChat = id;
  syncBodyInputGate();
  reply = "";
  setChatBusy(true);
  speech.stop('new-reply');
  speech.prewarm?.(); // R02: start the cloud audio device while the reply is generated.
  const user: ChatMessage = {
    role: "user",
    content: content || "请描述这张图片。",
  };
  activeUser = user;
  let shots = attachments;
  attachments = [];
  renderAttachments();
  input.value = "";
  assistantNode = null;
  const saved = await timed('save', saveBeforeSend(), true); // ≤ saveWaitMs
  if (activeChat !== id) return drop('superseded');
  if (!saved) {
    onStream({ id, kind: "chat", type: "error", text: uiText("配置未能保存，请修正设置后重试。") });
    return drop('save-failed', null);
  }
  try {
    // 识图第 1 步: the host attaches a frame only when this message asks her to look (or the button was pressed); the window decides nothing (src/senses/look-send.ts).
    const shared = await timed('look', window.desktop.sharedAttachments(lookHint(content, look)));
    if (activeChat !== id) return drop('superseded');
    shots = turnAttachments(shots, shared);
    const profile = userProfilePanel?.messageExpectation();
    await window.desktop.chat({
      id,
      messages: outgoingChatMessages(history, user),
      attachments: shots,
      ...(profile ? { profile } : {}),
      ...(pauseCut ? { pauseCut } : {}),
      ...stamp(),
    });
    return 'sent';
  } catch (error) {
    const live = activeChat === id;
    onStream({ id, kind: "chat", type: "error", text: String(error) });
    return drop(live ? 'host-refused' : 'superseded', live ? null : undefined);
  }
}
export async function stopChat(broadcast = true): Promise<void> {
  const id = activeChat; speechBeats().cancel();
  replyPresentation.cancelReadout();
  const mayPresent = shown() && replyPresentation.canPresent(id);
  replyPresentation.close(id);
  if (id) history = voiceReplyIds.has(id)
    ? appendVoiceReply(history, reply)
    : appendReplyHistory(history, activeUser, reply);
  activeChat = null;
  syncBodyInputGate();
  activeUser = null;
  speech.stop('stop'); bubbleFollow().over(id, 'interrupted');
  if ($('send-chat')) {
    setChatBusy(false);
    if (assistantNode) renderReplyWaiting(assistantNode, false);
    if (id && assistantNode) {
      assistantNode.textContent = reply.trim() ? uiTemplate`${formatReplySegments(reply)}\n\n[已停止]` : uiText("已停止");
      if (mayPresent) petUI?.finishAnswer(reply.trim() ? uiTemplate`${reply}\n\n[已停止]` : uiText('已停止'), id, false, false, true);
    }
  }
  if (id && broadcast) chatChannel.postMessage({ type: 'stop', id, context: chatContext() });
  if (id)
    await window.desktop
      .cancel(id)
      .catch((error) => notify(String(error), true));
}
export let chatRefillGeneration = 0;
/**
 * C2/C3 (pretrial fixes 2026-11-03): after the window was cleared for a card change, fill it with her current conversation
 * from the host (electron/brain/companion.ts recentChat). Only while nothing new happened in the window since (no message, no
 * reply, no other clear) and she is still the active character; her greeting only when she has no conversation.
 */
export function refillChat(greeting: boolean): void {
  const generation = ++chatRefillGeneration, requestedFor = characterState?.activeId ?? null;
  const settle = (messages: ChatMessage[], rows: ReturnType<typeof restoredChatRows> = null, recent?: Parameters<typeof openingGreetingFor>[0]) => {
    if (generation !== chatRefillGeneration || history.length || activeChat || (characterState?.activeId ?? null) !== requestedFor) return;
    if (!messages.length && !rows) { if (greeting && openingGreetingFor(recent, requestedFor)) showCharacterGreeting(true); return; }
    history = messages; rememberRefilledRows(history, rows); // 边说边演: the grey lines of performance-only replies are drawn again (display only; `history` stays clean)
    $('messages').replaceChildren();
    if (isPet) petUI?.refreshAnswerReader(shownReplyText([...history].reverse().find(item => item.role === 'assistant')?.content ?? ''), false);
    else if (rows) drawChatRows(rows);
    else for (const item of history) addMessage(item.role, item.content);
    text('chat-state', uiText('Enter 发送 · Shift + Enter 换行'));
  };
  const attempt = (left: number): void => {
    void window.desktop.getRecentChat().then(recent => settle(restoredChatHistory(recent, requestedFor, characterState?.activeId ?? null), restoredChatRows(recent, requestedFor, characterState?.activeId ?? null), recent), error => {
      if (generation !== chatRefillGeneration) return;
      if (left > 0 && isTransientSwitch(error)) setTimeout(() => attempt(left - 1), TRANSIENT_SWITCH_DELAY_MS);
      else settle([]);
    });
  };
  attempt(TRANSIENT_SWITCH_RETRIES);
}
export function clearChat(broadcast = true, greeting = false, keepDraft = false): void {
  chatRefillGeneration++; speechBeats().cancel();
  textMemorialOffer?.invalidate(); activeMemorialSpeechId = null;
  clearCommandMessageRows();
  ordinaryReplyPresentation = null;
  for (const record of voiceDraftRecords.values()) record.root.remove();
  voiceDraftRecords.clear();
  voiceDraftInput.clear($<HTMLTextAreaElement>('chat-input'));
  voiceUiGroups.clear(); voiceReplyIds.clear(); voiceSpeechReady = null;
  voiceContinuationStatus?.clear();
  initiativeGeneration++; provisionalInitiative = null; activeVisionSpeechId = null;
  const cancelledId = activeChat;
  awaitingChatState = false;
  replyPresentation.clear();
  petTaskOfferCleanup?.(); petTaskOfferCleanup = null;
  codexTasks?.dismissOffer();
  void stopChat(false);
  if (!keepDraft) captureController?.abort();
  attachments = draftAfterClear(attachments, keepDraft);
  history = [];
  reply = "";
  assistantNode = null;
  petUI?.hideAnswer();
  renderAttachments();
  $("messages").replaceChildren();
  text("chat-state", uiText("新对话已开始"));
  if (greeting) showCharacterGreeting(true);
  if (broadcast) chatChannel.postMessage({ type: 'clear', greeting, cancelledId, context: chatContext(), ...(keepDraft ? { keepDraft: true as const } : {}) });
}
export function beginChat(chat: ChatStarted, voice = false): void {
  textMemorialOffer?.invalidate();
  if (activeMemorialSpeechId) { activeMemorialSpeechId = null; speech.stop(); }
  clearCommandMessageRows(false);
  ordinaryReplyPresentation = null;
  voiceSpeechReady = null;
  initiativeGeneration++; provisionalInitiative = null; activeVisionSpeechId = null;
  if (!replyPresentation.begin(chat.id)) return;
  awaitingChatState = false;
  petTaskOfferCleanup?.(); petTaskOfferCleanup = null;
  codexTasks?.dismissOffer();
  activeChat = chat.id;
  syncBodyInputGate();
  chatOwner = chat.owner;
  if (chat.owner === windowKind) speech.wake?.(); // I-150: her reply is coming: wake this window's output
  activeUser = voice ? null : chat.messages.at(-1) ?? null;
  if (!voice) history = trimReplyHistory(chat.messages.slice(0, -1));
  reply = ''; speechBeats().begin(chat.id);
  petUI?.beginAnswer(chat.id);
  speech.stop('new-reply');
  if (activeUser) {
    const body = addMessage('user', activeUser.content);
    const root = isPet ? document.createElement('section') : body.parentElement!;
    if (isPet) {
      root.setAttribute('data-mood-ui', '');
      const literal = document.createElement('div');
      literal.className = 'message-body'; literal.textContent = activeUser.content.slice(0, 300);
      root.append(literal);
    }
    commandMessageRows.set(chat.id, { root, choices: null });
  }
  assistantNode = isPet ? petUI!.showWaiting(chat.id) : addMessage('assistant', '');
  renderReplyWaiting(assistantNode, true);
  replyPresentation.startReadout(chat.id, (prefix, full, ends) => renderReadout(chat.id, prefix, full, ends));
  if (!shown()) hideWaitingPresentation();
  setChatBusy(true);
}
export function hideWaitingPresentation(): void {
  if (isPet) replyPresentation.cancelReadout();
  voiceSpeechReady = null;
  const waiting = replyPresentation.isWaiting(activeChat);
  replyPresentation.suppressWaiting();
  if (waiting && assistantNode) renderReplyWaiting(assistantNode, false);
  petUI?.hideAnswer();
  // A companion-owned stream hidden before completion must not start late speech.
  // Hiding the controls window alone still permits its visible companion companion.
  if (isPet) { speech.stop('hidden'); releaseReplySpeech?.(); }
}
export function receiveChat(message: ChatWire): void {
  if (!message || typeof message !== 'object') return;
  // A global card revision can change while the active character keeps speaking.
  // Unique reply IDs already reject older playback after clear/new replies.
  if (message.type === 'speech-ended') {
    if (ordinaryReplyPresentation?.id === message.id && message.replyContext !== undefined
      && ordinaryReplyPresentation.context !== message.replyContext) return;
    if (typeof message.id === 'string' && message.id.length <= 128) finishReplySpeechPresentation(message.id, message.replyContext);
    return;
  }
  if (message.context !== chatContext()) return;
  if (message.type === 'request-state') {
    chatChannel.postMessage({ type: 'state', context: chatContext(), history, shown: refilledRowsFor(history), activeChat, activeUser, reply, chatOwner });
  } else if (message.type === 'state') {
    if (!awaitingChatState || history.length || activeChat) return;
    awaitingChatState = false;
    if (!message.history.length && !message.activeChat) return;
    history = trimReplyHistory(message.history); rememberRefilledRows(history, cleanChatRows(message.shown)); // 边说边演: as drawn in the other window
    $('messages').replaceChildren();
    if (isPet) {
      // Restore old text to the manual reader without replaying a bubble
      // whose original completed speech identity belongs to another window.
      const lastAnswer = [...history].reverse().find(item => item.role === 'assistant');
      petUI?.refreshAnswerReader(shownReplyText(lastAnswer?.content ?? ''), false);
    } else if (refilledRowsFor(history)) drawChatRows(refilledRowsFor(history)!);
    else for (const item of history) addMessage(item.role, item.content);
    if (message.activeChat && message.activeUser && replyPresentation.begin(message.activeChat, message.reply)) {
      const hydratedId = message.activeChat;
      activeChat = message.activeChat; activeUser = message.activeUser; reply = message.reply; chatOwner = message.chatOwner;
      syncBodyInputGate();
      addMessage('user', activeUser.content);
      petUI?.beginAnswer(message.activeChat);
      assistantNode = isPet ? petUI!.showWaiting(message.activeChat) : addMessage('assistant', '');
      renderReplyWaiting(assistantNode, replyPresentation.isWaiting(message.activeChat));
      replyPresentation.startReadout(hydratedId, (prefix, full, ends) => renderReadout(hydratedId, prefix, full, ends));
      if (!shown()) hideWaitingPresentation();
      if (reply.trim()) {
        replyPresentation.readoutContent(message.activeChat, reply);
        if (isPet && shown() && replyPresentation.canPresent(message.activeChat)) petUI?.refreshAnswerReader(reply, true);
      }
      setChatBusy(true);
    }
  } else if (message.type === 'stop') {
    if (message.id === activeChat) void stopChat(false);
    else replyPresentation.close(message.id);
  }
  else if (message.type === 'clear') {
    if (typeof message.cancelledId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(message.cancelledId))
      replyPresentation.close(message.cancelledId);
    clearChat(false, message.greeting, message.keepDraft === true);
  }
}
export function onStream(event: StreamEvent): void {
  if (event.type === 'beats') { speechBeats().receive(event); return; } // 边说边演: never text
  if (receiveReadoutControl(event)) return;
  if (event.kind === "chat" && event.id === activeChat) {
    if (event.type === "delta") {
      reply += event.text;
      startStreamingReplySpeech(event.id);
      replyPresentation.content(event.id, reply);
      if (assistantNode && reply.trim()) replyPresentation.readoutContent(event.id, reply);
      if (isPet && shown() && replyPresentation.canPresent(event.id)) petUI?.refreshAnswerReader(reply, true);
      text('chat-state', uiText('正在生成回复…'));
      $("messages").scrollTop = $("messages").scrollHeight;
    }
    if (event.type === "status") {
      const notice = statusNotice(event.text); if (notice) immersiveNotice?.publishAction(notice); // I-222: fixed lines only
      text("chat-state", immersiveDeveloperMode ? event.text : uiText("正在回复…"));
    }
    if (event.type === "done" || event.type === "error") {
      if (event.type === 'error') { replyPresentation.cancelReadout(); bubbleFollow().over(event.id, 'error'); }
      // Claude unavailable (login, allowance, offline...): her own words, once; developer mode keeps the raw error.
      const outage=event.type==='error'&&!immersiveDeveloperMode ? outageDisplayText(event.outage) : null;
      const failure=event.type==='error' ? (outage ?? displayFailure(event.text)) : '';
      if(event.type==='error'&&outage===null)notify(event.text,true);
      const hasBody = !!reply.trim();
      const quietRepeat=event.type==='error'&&outage===''&&!hasBody; // already said once: nothing new on screen, the draft comes back
      const callStreamed = ordinaryReplyPresentation?.id === event.id && ordinaryReplyPresentation.call === true; // I-091 step 4: read while it streamed
      // no-pet-ok: isPet is the existing flag for the companion window
      const expectsSpeech = event.type === 'done' && hasBody && (!!activeUser || callStreamed) && settings.voice.enabled; // I-174 item 9: read through a minimize too
      const segmentedSpeech = expectsSpeech && (!voiceReplyIds.has(event.id) || callStreamed);
      const earlyCompletedSpeech=segmentedSpeech&&settings.provider.kind==='claude';
      let completedPresentation:NonNullable<typeof ordinaryReplyPresentation>|null=null;
      const streamed=ordinaryReplyPresentation?.id===event.id&&ordinaryReplyPresentation.streaming?ordinaryReplyPresentation:null;
      if (streamed && !segmentedSpeech) { if (replySpeechQueue.replyId === event.id) speech.stop('superseded'); ordinaryReplyPresentation = null; }
      if (streamed && segmentedSpeech) { streamed.text = reply; streamed.streaming = false; completedPresentation = streamed; } // R02: already speaking
      else if (segmentedSpeech) {
        ordinaryReplyPresentation = { id: event.id, text: reply, context: replySpeechContext(), index: -1,
          early:earlyCompletedSpeech,kicked:false,ended:false,textDrained:false };
        completedPresentation=ordinaryReplyPresentation;
        ordinaryVoiceConfig = { ...settings.voice };
        speechPlaybackErrorShown = false;
      }
      const mayPresent = shown() && replyPresentation.canPresent(event.id);
      if (mayPresent) petUI?.refreshAnswerReader(reply, false);
      if (event.type === 'error' && (!replyPresentation.has(event.id) || quietRepeat)) {
        // Save/attachment/host-validation failures happened before acceptance.
        // Show the actual local failure without inventing a host reply identity.
        const input = $<HTMLTextAreaElement>('chat-input');
        if (!input.value && activeUser) input.value = activeUser.content;
      }
      if (event.type === 'error') speechBeats().cancel(event.id); else speechBeats().done(event.id, reply.length);
      history = voiceReplyIds.has(event.id)
        ? appendVoiceReply(history, reply)
        : appendReplyHistory(history, activeUser, speechBeats().historyText(event.id, reply));
      replyPresentation.close(event.id);
      if (assistantNode) renderReplyWaiting(assistantNode, false);
      if (quietRepeat) {
        assistantNode?.closest('.message')?.remove();
        assistantNode = null;
      } else if (event.type === "error") {
        assistantNode ??= addMessage('assistant', '');
        if (assistantNode) {
          assistantNode.textContent = hasBody
            ? `${isPet ? reply : formatReplySegments(reply)}\n\n${failure}`
            : failure;
          assistantNode.classList.add("message-error");
        }
      }
      const completedReply = reply, ownsSpeech = (!!activeUser || callStreamed) && chatOwner === windowKind && (!isPet || mayPresent);
      activeUser = null;
      activeChat = null;
      syncBodyInputGate();
      if (event.type === 'done' && !hasBody) {
        if (isPet || !assistantNode || !speechBeats().showPerformed(event.id, assistantNode)) assistantNode?.closest('.message')?.remove(); // 边说边演: the grey line (no-pet-ok: the companion window flag)
        assistantNode = null;
        reply = '';
        petUI?.hideAnswer();
      } else if (quietRepeat) petUI?.hideAnswer();
      else if (event.type === 'error' && mayPresent) petUI?.finishAnswer(hasBody ? `${reply}\n\n${failure}` : failure, event.id, false, false, true);
      if(earlyCompletedSpeech&&completedPresentation&&isPet){
        petUI?.expectAnswerSpeech(event.id);
        void prepareReplySpeechPresentation(completedPresentation);
      }
      if (event.type === 'done' && hasBody) replyPresentation.finishReadout(event.id, () => {
        if ((isPet && (!shown())) || activeChat) return;
        if(earlyCompletedSpeech&&completedPresentation&&ordinaryReplyPresentation!==completedPresentation)return;
        if (isPet) {
          petUI?.refreshAnswerReader(completedReply, false);
          if (!segmentedSpeech) petUI?.finishAnswer(completedReply, event.id, expectsSpeech, true, false);
          else if(earlyCompletedSpeech&&completedPresentation){
            completedPresentation.textDrained=true;
            // Full text has now naturally drained. Never expect speech a second time.
            petUI?.finishAnswer(completedReply,event.id,false,true,false);
            if(completedPresentation.ended&&ordinaryReplyPresentation===completedPresentation)ordinaryReplyPresentation=null;
          }
          else if (ordinaryReplyPresentation?.id === event.id) {
            // Normalize the already-visible full body to the host's raw receipt
            // mode even if voice was switched on during this streamed reply.
            petUI?.showAnswer(completedReply, true, event.id, false);
            petUI?.refreshAnswerReader(completedReply, false);
            void prepareReplySpeechPresentation(ordinaryReplyPresentation);
          }
        }
        if(earlyCompletedSpeech&&completedPresentation){
          completedPresentation.textDrained=true;
          if(completedPresentation.ended&&ordinaryReplyPresentation===completedPresentation)ordinaryReplyPresentation=null;
        }
        const voiceReady = voiceSpeechReady;
        if (voiceReady?.replyId === event.id) {
          voiceReady.presentationReady = true;
          const pendingSpeech = voiceReady.pendingSpeech;
          voiceReady.pendingSpeech = undefined;
          if (pendingSpeech) receiveVoiceConversation(pendingSpeech);
        }
        if (ownsSpeech && !earlyCompletedSpeech) {
          const acceptedReplyContext = segmentedSpeech ? replySpeechContext() : undefined;
          const release = () => { if (releaseReplySpeech === release) releaseReplySpeech = null; endReplySpeech(event.id, acceptedReplyContext); };
          releaseReplySpeech = release;
          if (segmentedSpeech) void replySpeechQueue.speak(event.id).then(release, error => { reportReplySpeechError(error); release(); });
          else void speech.speak(completedReply, settings.voice, { replyId: event.id }).then(release, release);
        }
      });
      setChatBusy(false);
      text(
        "chat-state",
        event.type === "error" ? uiText("本次请求未完成") : hasBody || speechBeats().performed(event.id) ? uiText("回复完成") : uiText("本次未返回回复正文"),
      );
      if(earlyCompletedSpeech&&ownsSpeech&&completedPresentation)kickCompletedReply(completedPresentation);
    }
  }
}
export function acceptWindowVisibility(value: WindowVisibilityState): void {
  if (!windowVisibility.accept(value)) return;
  hostVisible = windowVisibility.visible;
  projectPetVisibility();
  petUI?.setHostVisible(hostVisible, windowVisibility.minimized);
  moodCompanion?.setHostVisible(hostVisible);
  stage?.setVisible(hostVisible);
  if (!hostVisible) {
    textMemorialOffer?.invalidate();
    if (activeMemorialSpeechId && !windowVisibility.minimized) { activeMemorialSpeechId = null; speech.stop(); } // I-174: covered, she finishes it
    userProfilePanel?.close();
    if (isPet) void ambientAudioController?.stop().catch(() => {});
    if (!windowVisibility.minimized) hideWaitingPresentation(); /* I-171 */ stopMotionPreview(); captureController?.abort(); attachments = [];
    if (!isPet && document.getElementById('attachments')) renderAttachments();
  } else if (replyPresentation.canPresent(activeChat)) petUI?.refreshAnswerReader(reply, !!activeChat);
}


// Writers for the other renderer wiring files (an ES module binding is written only where it is declared).
export function setSpeechPlaybackErrorShown(value: typeof speechPlaybackErrorShown): void { speechPlaybackErrorShown = value; }
export function setProvisionalInitiative(value: typeof provisionalInitiative): void { provisionalInitiative = value; }
export function setActiveVisionSpeechId(value: typeof activeVisionSpeechId): void { activeVisionSpeechId = value; }
export function setHistory(value: typeof history): void { history = value; }
export function setVoiceSpeechReady(value: typeof voiceSpeechReady): void { voiceSpeechReady = value; }
export function setTextMemorialOffer(value: typeof textMemorialOffer): void { textMemorialOffer = value; }
export function setTextMemorialDeliveredUnsubscribe(value: typeof textMemorialDeliveredUnsubscribe): void { textMemorialDeliveredUnsubscribe = value; }
