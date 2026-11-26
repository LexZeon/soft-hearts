// Renderer wiring, 声音 · 语音对话: the microphone, push-to-talk, calls, listening together and the voice conversation's rows in the chat (both windows).
// Moved out of src/main.ts as it was (overhaul step 5: docs/claude/2026-11-16-src-main-split.md); src/main.ts calls the steps in order.
// Nothing here runs on import (tests/renderer-golden.test.mjs).
import { uiText } from '../foundation/ui-language';
import { NOTICE_ACTIONS, readingRefusalAction, voiceFailureAction, voiceUnheardLine } from '../settings';
import type { VoiceConversationEvent } from '../../shared/voice';
import { VoiceDraftInput } from '../voice';
import { VoiceContinuationStatus } from '../voice';
import type { ChatMessage } from "../../shared/contracts";
import { MediaInput } from '../senses';
import type { StageSurface } from '../stage';
import { hearingReceiver } from '../senses'; // 2026-11-22: a frame stall is not a capture stop (docs/claude/2026-11-22-music-cut-every-10s.md)
import { CallControls } from '../voice/voice-call/call-controls'; // I-091 像打语音电话一样和她聊天
import { mountCallDevicesPanel } from '../settings/call-devices-panel'; // I-177: 通话用的声音设备
import { CallVadStream } from '../voice'; // I-099: the call's Silero VAD (local, offline)
import { CallTurnStream } from '../voice'; // I-099/I-100: Smart Turn in a call
import { wirePushToTalk } from '../voice';
import { sinkSupported } from '../voice'; // I-177 batch 2: the 「听」 list routes her voice where the window can
import { AudioReadingClient } from '../voice/AudioReadingClient';
import { beatsStreamEvent, trimReplyHistory } from '../brain';
import { $, isPet, notify, text, windowKind } from './shell-wiring';
import { settings } from './settings-wiring';
import { stage } from './stage-wiring';
import { fillerMouth, replySpeechQueue, speech, speechPreparing, voicePlaybackActive, windowAudio } from './voice-wiring';
import { dropUnvoicedReply, reportReadingDropped, speechDropWhy } from '../voice'; // I-197; 2026-11-24: a reading dropped before it began says why
import { activeChat, assistantNode, beginChat, history, hostVisible, onStream, reply, ordinaryReplyPresentation, sendChat, setHistory, setVoiceSpeechReady, shown, voiceSpeechReady } from './chat-wiring';
import { addMessage, endReplySpeech, replyPresentation } from './chat-view-wiring';
import { runtime, systemAudioInput } from './senses-wiring';
import { petUI } from './pet-window-wiring';
import { bubbleFollow } from './bubble-follow-wiring'; // I-165
import { overHerHeld } from './user-attention-wiring'; // I-189 #2
export const voiceUiGroups = new Map<string, { epoch: string; seq: number; message: ChatMessage; node: HTMLElement }>();
export let voiceContinuationStatus: VoiceContinuationStatus | null = null;
export const voiceReplyIds = new Set<string>();
export const voiceDraftInput = new VoiceDraftInput();
export const voiceDraftRecords = new Map<string, { root: HTMLElement; text: HTMLTextAreaElement }>();
export let mediaInput: MediaInput | null = null;
export let callControls: CallControls | null = null;
export let ambientAudioController: AudioReadingClient | null = null;
/** Microphone, push-to-talk, calls, voice conversation events, listening together and the continuation status (both windows). */
export async function startVoiceInput(): Promise<void> {
  mediaInput = new MediaInput({
    windowKind,
    pushToTalk: true, // hold T to talk: the microphone counts only while T is held in this window
    onCallEvent: event => callControls?.heard(event), // I-091: a call listens without T (src/voice/voice-call/)
    callVad: new CallVadStream(() => window.desktop), // I-099: in a call, a neural voice detector decides start, end and talking over her
    callTurn: new CallTurnStream(() => window.desktop), // I-099/I-100: in a call, Smart Turn says whether you have finished or only paused
    canStartVoice: () => voiceDraftRecords.size === 0,
    overHerHeld, // I-189 #2: your face turned from the screen (sure): what you say is not talking over her (src/wiring/user-attention-wiring.ts)
    onUnheard: failure => { const line = voiceUnheardLine(failure); if (line) notify(uiText(line)); }, // 在听但不出字: say it, voice input stays on
    onTranscript: transcript => {
      if (!runtime.voiceInput || runtime.voiceOwner !== windowKind || !transcript.trim()) return;
      $<HTMLTextAreaElement>('chat-input').value = transcript;
      if (activeChat) notify(uiText('已识别，当前回复结束后可发送')); else void sendChat();
    },
    onError: (message, feature, explained) => {
      if (!explained) notify(message, true); // a recognition failure was already said in her words, in both windows
      const owner = feature === 'voiceInput' ? runtime.voiceOwner : runtime.cameraOwner;
      if (owner === windowKind) void window.desktop.setRuntimeState({ [feature]: false }).catch(() => {});
    },
    onStatus: message => text('chat-state', message),
    onVoiceStatus: message => {
      text(isPet ? 'pet-voice-state' : 'voice-input-state', message);
      $(isPet ? 'pet-voice-state' : 'voice-input-state')?.classList.toggle('hidden', !message);
    },
  });
  wirePushToTalk(window, () => mediaInput);
  callControls = new CallControls({ windowKind, api: window.desktop, audio: windowAudio, voice: () => settings.voice, media: () => mediaInput,
    replyBusy: () => voicePlaybackActive || speechPreparing, mouth: shape => fillerMouth(shape), notify,
    askDevices: devices => window.desktop.callDevicesAsk(devices) }); // I-177 batch 2: Claude's judgement of a new device set (host: electron/voice/call-device-judge.ts)
  void callControls.init($('voice-action-slot'));
  if (!isPet) mountCallDevicesPanel(document.getElementById('providers-voice'), callControls.advisor, message => notify(message), sinkSupported()); // I-177: the two priority lists (batch 2: the output one routes her voice) // no-pet-ok: isPet is the window-kind flag
  window.desktop.onVoiceConversation(receiveVoiceConversation);
  window.desktop.onAudioReadingRefused(reason => { const action = readingRefusalAction(reason); if (action) notify(uiText(NOTICE_ACTIONS[action]), false, action); }); // why a listening/watching switch stayed off
  window.desktop.onVoiceReadingStop(mode => {
    setVoiceSpeechReady(null); callControls?.readingStopped(); // I-177 batch 2: a ducked voice that was stopped
    // Microphone on mid-reading: this sentence plays out, the rest of the reply is not read; its bubbles still show.
    if (mode === 'sentence') replySpeechQueue.finishCurrent(ordinaryReplyPresentation?.id); else speech.stop('voice-input');
    bubbleFollow().over(ordinaryReplyPresentation?.id, 'interrupted'); // I-165: interrupted: the rest of her bubble shows now
  });
  // Her hearing holds through a frame stall while 「和她一起听」 is on; the switch off or a lost capture still ends it at once.
  const heard = hearingReceiver<Parameters<StageSurface['setMusicSample']>[0]>({ setMusicEnabled: on => stage.setMusicEnabled(on), setMusicSample: sample => stage.setMusicSample(sample) }, // the stage read when called (it can be remade)
    () => ambientAudioController?.listening === true);
  ambientAudioController = new AudioReadingClient(isPet ? $('ambient-audio-controls') : null, {
    api: window.desktop, owner: windowKind, media: mediaInput, system: systemAudioInput,
    onMusicEnabled: enabled => { if (isPet) heard.enabled(enabled); },
    onMusicSample: sample => { if (isPet) heard.sample(sample); },
    micChoice: () => callControls?.micChoice() ?? Promise.resolve({ deviceId: null, labelsKnown: true }), // I-177: a call's microphone from the user's priority list
    onDanceStatus: (active, status) => { if (isPet) petUI?.setAudioDanceState(active, status); },
    onError: message => notify(message, true),
    onExpanded: expanded => { if(isPet)petUI?.setSystemAudioExpanded(expanded); },
    onView: view => { if (isPet) petUI?.watchButton.setView(view); }, keepDialogue: () => petUI?.watchButton.look.seeing === true, // I-187: the eye button; 一起听 off keeps 一起看's dialogue // no-pet-ok: existing element ids and names
  });
  await ambientAudioController.init();
  const voiceStatus = $(isPet ? 'pet-voice-state' : 'voice-input-state');
  if (voiceStatus) {
    const output = document.createElement('small');
    output.style.flexBasis = '100%';
    $('voice-action-slot').append(output);
    voiceContinuationStatus = new VoiceContinuationStatus(output);
  }
}
export function receiveVoiceConversation(event: VoiceConversationEvent): void {
  voiceContinuationStatus?.receive(event);
  if (event.owner === windowKind) { if (event.type === 'row') callControls?.text(); else if (event.type === 'delta') callControls?.firstChar(); else if (event.type === 'terminal') callControls?.replyDone(); } // I-091 turn timing
  if (event.owner === windowKind && (event.type === 'held' || event.type === 'unheard' || event.type === 'fault')) callControls?.overHerHeld(); // I-177 batch 2: not a sentence: her voice comes back
  const key = event.epoch + '\0' + ('groupId' in event ? event.groupId : '');
  if (event.type === 'row') {
    if (voiceSpeechReady) reportReadingDropped(window.desktop, 'chat-busy'); // a newer line of yours arrived before her reading began
    setVoiceSpeechReady(null);
    let group = voiceUiGroups.get(key);
    if (group && event.seq <= group.seq) return;
    if (!group) {
      const message: ChatMessage = { role: 'user', content: event.text };
      group = { epoch: event.epoch, seq: event.seq, message, node: addMessage('user', event.text) };
      voiceUiGroups.set(key, group); setHistory(trimReplyHistory([...history, message]));
      if (voiceUiGroups.size > 128) voiceUiGroups.delete(voiceUiGroups.keys().next().value!);
    } else { group.seq = event.seq; group.message.content = event.text; group.node.textContent = event.text; }
    text('chat-state', event.seq === 1 ? uiText('这段话已收到，仍可继续说') : uiText('补充已收到，仍可继续说'));
    return;
  }
  if (event.type === 'start') {
    if (voiceSpeechReady) reportReadingDropped(window.desktop, 'chat-busy'); // a new turn began before her reading did
    setVoiceSpeechReady(null);
    if (!voiceUiGroups.has(key)) return;
    voiceReplyIds.add(event.replyId); if (voiceReplyIds.size > 128) voiceReplyIds.delete(voiceReplyIds.values().next().value!);
    beginChat({ id: event.replyId, owner: event.owner, messages: [] }, true); return;
  }
  if (event.type === 'beats') { const stream = beatsStreamEvent(event); if (stream && voiceReplyIds.has(event.replyId)) onStream(stream); return; } // 边说边演 in a call: the same receive as typed chat
  if (event.type === 'delta') { if (voiceReplyIds.has(event.replyId)) onStream({ id: event.replyId, kind: 'chat', type: 'delta', text: event.text }); return; }
  if (event.type === 'terminal') {
    const readyNow = event.complete && activeChat === event.replyId && shown() && replyPresentation.canPresent(event.replyId);
    setVoiceSpeechReady(readyNow ? { replyId: event.replyId, epoch: event.epoch, presentationReady: false } : null);
    if (!readyNow && event.complete && voiceReplyIds.has(event.replyId)) reportReadingDropped(window.desktop, shown() ? 'not-ready' : 'not-shown'); // 2026-11-24: the reading cannot begin; the host files the word if the voice is never asked
    // R33: a reply stopped to merge the user's addition keeps what it showed (or disappears if it showed nothing); it is not a failure.
    const ended = event.complete || event.superseded;
    // I-197: in a call, one dropped before her voice started was never heard: its row and its place in the history go too.
    const unvoiced = event.dropped && voiceReplyIds.has(event.replyId) && activeChat === event.replyId ? { node: assistantNode, text: reply } : null;
    if (voiceReplyIds.has(event.replyId)) onStream({ id: event.replyId, kind: 'chat', type: ended ? 'done' : 'error', text: ended ? '' : uiText('本次续接未完成，已保留原文。') });
    if (unvoiced) { unvoiced.node?.closest('.message')?.remove(); setHistory(dropUnvoicedReply(history, unvoiced.text)); petUI?.hideAnswer(); } // no-pet-ok: petUI is the companion window UI's existing name
    return;
  }
  if (event.type === 'speech') {
    if (event.owner === windowKind && voiceUiGroups.has(key) && voiceReplyIds.has(event.replyId)
      && voiceSpeechReady?.replyId === event.replyId && voiceSpeechReady.epoch === event.epoch) {
      const ready = voiceSpeechReady;
      const dropWhy = speechDropWhy({ chatBusy: !!activeChat, shown: shown(), voiceOn: settings.voice.enabled });
      if (dropWhy) { setVoiceSpeechReady(null); reportReadingDropped(window.desktop, dropWhy); return; }
      // This completed event cannot replace an earlier paced prefix with the full
      // body. Retain it once until that same reply's existing readout drains.
      if (!ready.presentationReady) { ready.pendingSpeech ??= { ...event }; return; }
      setVoiceSpeechReady(null);
      petUI?.finishAnswer(event.text, event.replyId, true, false, true);
      void speech.speak(event.text, settings.voice, { replyId: event.replyId }).then(() => endReplySpeech(event.replyId), () => endReplySpeech(event.replyId));
    }
    return;
  }
  if (event.type === 'cancelled') {
    setVoiceSpeechReady(null);
    if (event.replyId && activeChat === event.replyId) onStream({ id: event.replyId, kind: 'chat', type: 'error', text: uiText('已停止。') });
    speech.stop(); return;
  }
  if (event.type === 'draft' && event.owner === windowKind) {
    const input = $<HTMLTextAreaElement>('chat-input');
    if (voiceDraftInput.place(input, key, event.text)) {
      notify(uiText('部分语音未完成处理，原文已保留在输入框。'), true);
    } else if (!isPet && event.groupId && voiceUiGroups.get(key)?.message.content === event.text) {
      const original = voiceUiGroups.get(key)!;
      const label = original.node.parentElement?.querySelector('.message-label');
      if (label) label.textContent = uiText('你 · 语音未完成处理');
      notify(uiText('输入框已有草稿；语音原文保留在本轮用户消息中。'), true);
    } else {
      // At most four accepted groups plus one rejected ASR final per capture.
      // Pending copies gate the next capture until explicitly handled.
      let record = voiceDraftRecords.get(key);
      if (!record && voiceDraftRecords.size < 5) {
        const root = document.createElement('details'); root.open = true;
        const title = document.createElement('summary'); title.textContent = uiText('未完成处理的语音原文');
        const text = document.createElement('textarea'); text.readOnly = true; text.rows = 3; text.setAttribute('aria-label', uiText('保留的语音原文'));
        const select = document.createElement('button'); select.type = 'button'; select.textContent = uiText('选中原文'); select.onclick = () => { text.focus(); text.select(); };
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = uiText('已处理，关闭');
        dismiss.onclick = () => { root.remove(); voiceDraftRecords.delete(key); };
        root.append(title, text, select, dismiss); input.after(root);
        record = { root, text }; voiceDraftRecords.set(key, record);
      }
      if (record) record.text.value = event.text;
      notify(uiText('输入框已有草稿；语音原文保留在聊天区的语音原文栏中。'), true);
    }
  } else if (event.type === 'unheard') {
    if (event.owner === windowKind) mediaInput?.noteUnheard(event.failure);
  } else if (event.type === 'fault') {
    // Recognition failed: every window says why, in her words (never a silent switch-off).
    const action = voiceFailureAction(event.failure);
    if (action) notify(uiText(NOTICE_ACTIONS[action]), false, action);
    if (event.owner === windowKind) mediaInput?.receiveVoiceFault(event, !!action);
  }
}
