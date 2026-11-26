/**
 * I-197 (in a call: a line added before her voice started joins the one before it): the reply she had begun to write
 * for the first line was never heard, so this window does not keep it. The host marks its terminal event `dropped`; the chat page
 * removes its message row and takes it back out of the history the window would send next (so the window and her Claude process keep
 * telling the same story). Only the exact text this window just appended goes; anything else stays as it is.
 */
import type { ChatMessage } from '../../../shared/foundation/chat';

export function dropUnvoicedReply(history: readonly ChatMessage[], text: string): ChatMessage[] {
  const last = history.at(-1);
  return text.trim() && last?.role === 'assistant' && last.content === text ? history.slice(0, -1) : [...history];
}
