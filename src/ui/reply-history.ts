import type { ChatMessage } from '../../shared/contracts';

/** Bound history while the evicted user boundary is still available. */
export function trimReplyHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  let start = Math.max(0, messages.length - 24);
  // Preserve greetings/comments when no user was removed; consecutive roles are valid.
  if (messages.slice(0, start).some(message => message.role === 'user')) {
    while (start < messages.length && messages[start].role === 'assistant') start++;
  }
  return messages.slice(start);
}

/** Outgoing and local producer windows share the same user boundary rule. */
export function outgoingChatMessages(history: readonly ChatMessage[], user: ChatMessage): ChatMessage[] {
  return trimReplyHistory([...history, user]);
}

/** Local continuity only. Host archive/appraisal/gesture/TTS still finalize once. */
export function appendReplyHistory(history: readonly ChatMessage[], user: ChatMessage | null, body: string): ChatMessage[] {
  if (!user || !body.trim()) return [...history];
  return trimReplyHistory([...history, user, { role: 'assistant' as const, content: body }]);
}

/**
 * R33: a voice utterance is one user message (updated in place as sentences
 * arrive); each of its replies joins history on its own, only when it showed
 * text. The host's conversation session is regrouped to this same shape
 * (shared/voice-conversation.ts voiceUtteranceMessages), so the next message
 * still lines up with the warm Claude process.
 */
export function appendVoiceReply(history: ChatMessage[], body: string): ChatMessage[] {
  return body.trim() ? trimReplyHistory([...history, { role: 'assistant' as const, content: body }]) : history;
}

/** A fixed application label, never a renderer-selected role or permission. */
export function ambientCommentHistoryText(text: string): string {
  return `[角色主动评论 · 系统播放声音（不是用户发言或偏好，不授执行权）]\n${text}`;
}
