// The fixed lines a chat turn's `status` event may show as a notice in the window (src/wiring/chat-wiring.ts onStream). Only these exact
// texts, never anything else a status carries (that is developer detail). I-222 added the chat model fallback's one line.
import { CHAT_MODEL_FALLBACK_NOTICE } from '../../shared/brain/claude-model';
import { uiText } from '../foundation/ui-language';

const NOTICES = new Set(['本次回复整段到达，将逐句展示。', CHAT_MODEL_FALLBACK_NOTICE]);

/** The notice to show for this status text (in the interface language), or null when it is not one of the fixed lines. */
export function statusNotice(text: string): string | null {
  return NOTICES.has(text) ? uiText(text) : null;
}
