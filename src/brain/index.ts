// 她的大脑：聊天 (part 6), window side: the public page. Other parts and the wiring import this part only through this file (overhaul
// plan section 8). Files inside src/brain/ import each other directly.
// What is here is exactly what was imported from outside on 2026-11-16 (`node scripts/dev/part-surface.mjs --part brain`). The two
// stylesheets are imported directly by src/settings/layout.ts.

// The reply reader, history, presentation, segments and the thinking look (window and stage).
export { ReplyReader } from './ReplyReader';
export { ambientCommentHistoryText, appendReplyHistory, appendVoiceReply, outgoingChatMessages, trimReplyHistory } from './reply-history';
export { ReplyPresentationState } from './reply-presentation';
export { formatReplyBubbles, formatReplySegments } from './reply-segments';
export { ReplyThinkingPresenter, systemSpeechBusy } from './reply-thinking';
export { ReplyThinking } from './reply-thinking-stage';
// Chat in the control window: continuity, the availability notice, the setting card, held lines, sending in pause talk.
export { cleanChatRows, restoredChatHistory, restoredChatRows } from './chat-continuity';
export { mayShowOpeningGreeting } from './greeting-gate';
export { presentGreetingLine, type GreetingPorts } from './greeting-presenter';
export { ChatAvailabilityNotice } from './ChatAvailabilityNotice';
export { ChatSettingCards } from './ChatSettingCard';
export { HeldLines } from './held-lines';
export { pauseCutForSend, receiveUnboundSay, sendUnboundLine, unboundSayOf } from './pause-talk-send';
export { SendGuard, sameValue, windowSendGuard } from './send-guard'; // 2026-11-22: a typed line never drops silently
export type { DropNotice, SendAttempt } from './send-guard';
// 边说边演 (docs/claude/2026-11-20-speech-beats-2-4.md): the grey line, her history's words, and the beats to the companion window's stage.
export { SpeechBeatsView, beatsStreamEvent } from './speech-beats-view';
// I-174 item 9b: a step away's camera release ends the look's context after her reply, not in the middle of it.
export { CLEAR_AFTER_REPLY, clearAfterReply, clearKeepsConversation, clearKeepsReply } from './clear-after-reply';
export { labelReplySpeaker } from './speaker-label'; // I-209 step 4: someone else on stage's reply shows her name in the chat list
export { statusNotice } from './chat-status-notice'; // I-222: the fixed status lines a chat turn may show
