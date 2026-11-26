// I-137: every turn she is told, in one short line, whether 三方互通 is on, so "它开没开、管什么" has a true answer
// (on 11-15 she could not tell whether it was on). A fact only, never an instruction; typed chat, calls and her own proactive turns.
// I-139 (plan 六 item 3): under its switch the chat's line is shared/foundation/i139-texts.ts interconnectLineRelaxed, said on a Claude process's
// first turn and when it changes (electron/brain/i139-chat.ts once-lines); `relaxed` below picks it.
import { interconnectLineRelaxed, type I139Language } from '../../shared/foundation/i139-texts';
import { ASSISTANT_NAME } from '../../shared/foundation/assistant-name';

/** The one private line for this turn. A failing reader counts as off (as everywhere else for 三方互通). */
export function interconnectTurnLine(on: boolean | (() => boolean), relaxed?: { language?: I139Language | null } | null): string {
  let value = false;
  try { value = (typeof on === 'function' ? on() : on) === true; } catch { value = false; }
  if (relaxed) return interconnectLineRelaxed(value, relaxed.language);
  return `三方互通现在${value ? '开着' : '关着'}（用户自己的 ${ASSISTANT_NAME}、和你的聊天、设置三边互通；开关在控制窗口「${ASSISTANT_NAME} 内部通道」）。`;
}
