// Renderer wiring, 大脑 · 聊天的显示: the chat's rows and readout, its busy state, the windows' chat channel and the subscriptions that feed the chat (both windows); they only read the chat state (chat-wiring.ts).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText } from '../foundation/ui-language';
import { CompanionCommandChoices } from '../settings/CompanionCommandChoices';
import type { CompanionCommandView } from '../../shared/settings';
import type { ChatMessage, ChatStarted } from "../../shared/contracts";
import type { RecentChatShown } from "../../shared/memory";
import { renderReplyWaiting } from '../../shared/brain/reply-waiting-presentation';
import { ReplyPresentationState } from '../brain';
import { formatReplySegments, labelReplySpeaker } from '../brain';
import { $, isPet, notify, text } from './shell-wiring';
import { settings } from './settings-wiring';
import { stage } from './stage-wiring';
import { replyThinking } from './voice-wiring';
import { activeChat, assistantNode, attachments, beginChat, clearChat, commandMessageRows, finishReplySpeechPresentation, hostVisible, noteProactiveInput, onStream, ordinaryReplyPresentation, readoutControlTurns, receiveChat, sendGuard, shown, speechPlaybackErrorShown } from './chat-wiring';
import { memoryPanel } from './memory-wiring';
import { characterName, characterState, chatContext } from './cards-wiring';
import { petUI } from './pet-window-wiring';
import { speechBeats } from './speech-beats-wiring'; // 边说边演
import { speechBeatShownText } from '../../shared/behaviors/speech-beats/history';
import { readingVoices } from '../voice'; // I-209 stage voice
/** Local control replies use the existing message choices without replacing the
 * native speech surface, clearing its queue or starting another spoken reply. */
export function beginReadoutControl(chat: ChatStarted): void {
  if (readoutControlTurns.has(chat.id)) return;
  while (readoutControlTurns.size >= 8) {
    const id = readoutControlTurns.keys().next().value!;
    const row = commandMessageRows.get(id); row?.choices?.dispose();
    if (isPet) row?.root.remove();
    commandMessageRows.delete(id); readoutControlTurns.delete(id);
  }
  const user = chat.messages.at(-1);
  if (user?.role !== 'user') return;
  const root = document.createElement('section');
  const literal = document.createElement('div'); literal.className = 'message-body'; literal.textContent = user.content;
  const output = document.createElement('div'); output.className = 'message-body';
  root.append(literal, output);
  (isPet ? document.querySelector('.pet-chat') : $('messages'))?.append(root);
  commandMessageRows.set(chat.id, { root, choices: null });
  readoutControlTurns.set(chat.id, { user, text: '', output, finished: false });
}
export function presentCompanionCommand(view: CompanionCommandView): void {
  sendGuard.release(view.requestId); // 2026-11-22: any result for a local control lets the next line go (src/brain/send-guard.ts)
  const row = commandMessageRows.get(view.requestId);
  if (!row) return;
  if (!row.choices) {
    if (isPet) document.querySelector('.pet-chat')?.append(row.root);
    row.choices = new CompanionCommandChoices(row.root, request => window.desktop.chooseCompanionCommand(request),
      view.owner === (isPet ? 'pet' : 'controls'));
  }
  row.choices.show(view);
}
// X1: the reply waiting for its first word drives her thinking (src/brain/reply-thinking.ts); presentation only.
export const replyPresentation = new ReplyPresentationState(undefined, id => replyThinking.waiting(id),
  { typing: () => !!(document.getElementById('chat-input') as HTMLTextAreaElement | null)?.value.trim() }); // F7 停停说说: she waits a little longer while you type
export let chatChannel: BroadcastChannel;
/** The windows' chat channel (the other window's chat state and speech-ended). */
export function openChatChannel(): void {
chatChannel = new BroadcastChannel('soft-hearts-chat');
}
export async function prepareReplySpeechPresentation(accepted: NonNullable<typeof ordinaryReplyPresentation>): Promise<void> {
  const current = () => ordinaryReplyPresentation === accepted && accepted.context === replySpeechContext()
    && !activeChat && settings.voice.enabled && shown(); // I-174: covered she reads on
  try {
    if (!petUI) return;
    await petUI.flushReplyPublication();
    if (!current()) return;
    const ready = await window.desktop.acknowledgeReplySpeechReady(accepted.id);
    if (!ready && current()) finishReplySpeechPresentation(accepted.id, accepted.context);
  } catch (error) {
    if (!current()) return;
    void window.desktop.cancelReplySpeech(accepted.id).catch(() => {});
    reportReplySpeechError(error);
    finishReplySpeechPresentation(accepted.id, accepted.context);
  }
}
export function reportReplySpeechError(error: unknown): void {
  if (speechPlaybackErrorShown) return;
  const message = error instanceof Error ? error.message : String(error);
  notify(message.includes('6000字符限制') ? uiText('这条回复超过自动朗读的6000字符限制，完整文字仍可查看。')
    : message.includes('无法安全分段') ? uiText('这条回复无法安全分段朗读，完整文字仍可查看。')
    : message.includes('气泡尚未确认显示') ? uiText('回复气泡尚未确认显示，本段未开始朗读。')
    : uiText('本次朗读未完成，完整文字仍可查看。'), true);
}
/** A chat reset from the host clears this window's chat and memory list. */
export function wireChatReset(): void {
  window.desktop.onChatReset(() => { clearChat(false); memoryPanel?.reset(); });
}
/** Any input in this window counts as the user being here (her own lines step back). */
export function wireProactiveInput(): void {
  document.addEventListener('pointerdown', noteProactiveInput, true);
  document.addEventListener('pointermove', event => { if (event.buttons) noteProactiveInput(); }, true);
  document.addEventListener('keydown', noteProactiveInput, true);
  document.addEventListener('input', noteProactiveInput, true);
}
/** The chat stream and what comes with a reply (both windows). */
export function wireChatStream(): void {
  window.desktop.onStream(onStream);
  window.desktop.onChatStarted(chat => { if (chat.readoutControl) return beginReadoutControl(chat); readingVoices.own(chat.id, chat.speakerId); /* I-209 stage voice: her reply, her voice */ beginChat(chat); if (!isPet && chat.speaker) labelReplySpeaker(document.getElementById('messages'), chat.speaker); }); // I-209 step 4: someone else on stage: her name (no-pet-ok: the companion window flag)
  window.desktop.onReplyRhythm(pacing => replyPresentation.setRhythm(pacing.id, pacing)); // F7 说话节奏: this reply's pace for the bubbles after the first
  window.desktop.onPauseTalk(cue => replyPresentation.setPausePlan(cue.id, cue)); // F7 停停说说: haiku's plan, for the bubbles not yet shown
  window.desktop.onCompanionCommandView(presentCompanionCommand);
}
/** Typing in the chat box: the user is here, and (L2) she is lifted out of her own thing. */
export function wireChatTyping(): void {
  $('chat-input').addEventListener('compositionstart', noteProactiveInput);
  // L2 (pretrial issue 6): typing to her lifts her out of her own thing (the host decides; no text leaves, one note a second at most).
  let lastTypingNote = -Infinity;
  const noteChatTyping = () => { const now = performance.now(); if (now - lastTypingNote < 1_000) return; lastTypingNote = now; void window.desktop.noteChatTyping().catch(() => {}); };
  $('chat-input').addEventListener('compositionstart', noteChatTyping);
  $('chat-input').addEventListener('input', noteChatTyping);
  $('chat-input').addEventListener('focus', noteProactiveInput);
}
/** The other window's chat, through the windows' chat channel. */
export function connectChatChannel(): void {
  chatChannel.onmessage = event => receiveChat(event.data);
  chatChannel.postMessage({ type: 'request-state', context: chatContext() });
}
export function replySpeechContext(): string {
  return JSON.stringify([characterState?.activeId ?? '', settings.model?.url ?? '', settings.provider.kind, settings.provider.baseUrl, settings.provider.memoryModel ?? settings.provider.model]); // I-222: the memory pin (shared/foundation/memory-connection.ts memoryScopeModel): a chat model change does not drop her reading
}
export function renderAttachments(): void {
  const element = $("attachments");
  element.replaceChildren();
  attachments.forEach((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment";
    const image = document.createElement("img");
    image.src = attachment.dataUrl;
    image.alt =
      attachment.source === "screen"
        ? uiText("待发送的屏幕快照")
        : uiText("待发送的摄像头照片");
    const label = document.createElement("span");
    label.textContent =
      attachment.source === "screen" ? uiText("屏幕快照") : uiText("摄像头照片");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", uiText("移除快照"));
    remove.onclick = () => {
      attachments.splice(index, 1);
      renderAttachments();
    };
    chip.append(image, label, remove);
    element.append(chip);
  });
}
export function addMessage(role: "user" | "assistant", content: string, performedLine?: string): HTMLElement {
  // 边说边演: her words from history never show a marker; a performance-only reply of hers is its grey line, small (`performedLine`: the line the host kept for a reply that has no words in the archive).
  const shown = performedLine ? { text: '', performed: performedLine } : role === 'assistant' ? speechBeatShownText(content) : null;
  if (isPet) return performedLine ? document.createElement('div') : role === 'assistant' ? petUI!.showAnswer(shown!.text) : document.createElement('div'); // no-pet-ok: the companion window flag; it draws no row for a grey line, live either
  const messages = $("messages");
  messages.querySelector(".welcome")?.remove();
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? uiText("你") : characterName;
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = shown?.performed ?? (shown ? formatReplySegments(shown.text) : content);
  if (shown?.performed) row.classList.add('message-performed');
  row.append(label, body);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
  return body;
}
/** 边说边演: the rows of a reloaded conversation, the grey lines of performance-only replies among them (display only, never her history). */
export function drawChatRows(rows: readonly RecentChatShown[]): void {
  for (const row of rows) {
    const body = addMessage(row.role, row.content, row.performed ? row.content : undefined);
    if (row.cut && row.role === 'assistant' && !row.performed && !isPet) drawCutMarker(body, row.content, row.cut); // no-pet-ok: the companion window flag; it draws no history rows
  }
}
/** 2026-11-23: her reply whose words were cut short, with a thin quiet line (the marker's words) at the cut point; display only, never her words (shared/foundation/reply-cut.ts). */
function drawCutMarker(body: HTMLElement, content: string, cut: { at: number; label: string }): void {
  const before = content.slice(0, cut.at).replace(/\s+$/u, ''), after = content.slice(cut.at).replace(/^\s+/u, '');
  const mark = document.createElement('div'); mark.className = 'message-cut'; mark.textContent = cut.label;
  body.textContent = before ? formatReplySegments(before) : '';
  body.append(mark);
  if (after) { const rest = document.createElement('div'); rest.textContent = formatReplySegments(after); body.append(rest); }
}
export function setChatBusy(busy: boolean): void {
  $<HTMLButtonElement>("send-chat").disabled = busy;
  $("send-chat").classList.toggle("hidden", busy);
  $("stop-chat").classList.toggle("hidden", !busy);
  text("chat-state", busy ? uiText("正在回复…") : uiText("Enter 发送 · Shift + Enter 换行"));
}
export function renderReadout(id: string, prefix: string, full: string, sentenceEnds?: readonly number[]): void {
  if (!assistantNode || (isPet && !shown()) || (activeChat && activeChat !== id)) return;
  renderReplyWaiting(assistantNode, false);
  if (isPet && !settings.voice.enabled) stage?.speechFaceCue?.({ kind: 'start', key: `${id}#shown`, text: prefix, voiced: false }); // I-073 part 3: no voice, an accent as it shows
  speechBeats().shown(id, prefix, full); // 边说边演: read-aloud off, a beat plays as its sentence shows (only the companion window performs)
  if (isPet) { petUI?.showAnswer(prefix, true, id, false, sentenceEnds); petUI?.refreshAnswerReader(full, true); }
  else assistantNode.textContent = formatReplySegments(prefix);
  $('messages').scrollTop = $('messages').scrollHeight;
}
export type ChatWire =
  | { type: 'request-state'; context: string }
  | { type: 'state'; context: string; history: ChatMessage[]; shown?: RecentChatShown[]; activeChat: string | null; activeUser: ChatMessage | null; reply: string; chatOwner: 'controls' | 'pet' | null }
  | { type: 'stop'; id: string; context: string }
  | { type: 'speech-ended'; id: string; context: string; replyContext?: string }
  | { type: 'clear'; greeting?: boolean; cancelledId?: string | null; context: string; keepDraft?: true };
export function endReplySpeech(id: string, replyContext?: string): void {
  const current = !replyContext || ordinaryReplyPresentation?.id !== id || ordinaryReplyPresentation.context === replyContext;
  if (current) finishReplySpeechPresentation(id, replyContext);
  void window.desktop.noteReplySpeechHeard?.(id, -1, 'over')?.catch(() => {}); // I-165: full-screen Unbound's bubble shows the rest
  try { chatChannel.postMessage({ type: 'speech-ended', id, context: chatContext(), ...(replyContext ? { replyContext } : {}) }); }
  catch { /* Playback may finish while its window is unloading. */ }
}
