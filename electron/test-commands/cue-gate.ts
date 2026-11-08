/**
 * Why a mood cue (the inner loop's small-motion / speech opportunity) cannot start right now. The same conditions the
 * automatic expression gate already uses (electron/main.ts companionCanExpress and the inner loop's `current`), as a
 * plain snapshot so the test command can wait for them and say which one it is waiting on. Returns the Chinese source
 * text of the reason (the caller translates it), or null when the cue may start.
 */
export interface CueGateState {
  /** The pet window exists, is visible and not minimized. */
  petVisible: boolean;
  /** The user is dragging the window. */
  dragging: boolean;
  /** The user sent a message a moment ago (the host's userInputUntil, 15 seconds, is still in the future). */
  userTyping: boolean;
  /** A reply is being read out, an audio comment is speaking, or another proactive line holds the speech gate. */
  speaking: boolean;
  /** An ordinary chat reply is in flight. */
  chatting: boolean;
  /** A 猜拳 match is on. */
  playing: boolean;
  /** Claude is reachable (electron/chat-availability.ts); a background call waits while it is not. */
  claudeAvailable: boolean;
  /** The mood phase is idle (not being patted, pinched or fed). */
  idle: boolean;
}

export const CUE_BLOCKERS = Object.freeze({
  hidden: '桌宠现在是隐藏的',
  dragging: '你正在拖动窗口',
  typing: '你刚刚还在和她聊天',
  speaking: '她正在说话',
  chatting: '聊天正在进行',
  playing: '正在玩猜拳',
  unavailable: 'Claude 现在不可用',
  busy: '她正在被摸或被喂',
});

export function cueBlocker(state: CueGateState): string | null {
  if (!state.petVisible) return CUE_BLOCKERS.hidden;
  if (state.dragging) return CUE_BLOCKERS.dragging;
  if (state.chatting) return CUE_BLOCKERS.chatting;
  if (state.userTyping) return CUE_BLOCKERS.typing;
  if (state.speaking) return CUE_BLOCKERS.speaking;
  if (state.playing) return CUE_BLOCKERS.playing;
  if (!state.claudeAvailable) return CUE_BLOCKERS.unavailable;
  if (!state.idle) return CUE_BLOCKERS.busy;
  return null;
}
