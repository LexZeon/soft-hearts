/**
 * I-209 step 4, brain interface (docs/claude/brain-interface.md): the two Claude calls of a chime-in on the full-screen stage live here.
 *  - The decision: one tool-less call, haiku tier, its own short system prompt; the answer is one JSON object {"speak":true|false}.
 *  - Her line: one tool-less call with the user's chat model (the "聊天模型" setting; '' keeps Claude Code's default), its own short system
 *    prompt, no session: the facts go in its prompt once and are not kept; the answer is {"text":…} (the sense line's parser).
 * Nothing else in electron/brain/stage-chat/ knows Claude's arguments or events.
 */
import os from 'node:os';
import { streamClaude, type ClaudeTask, type ClaudeUsage } from '../claude';

/** The decision always asks the small model. */
export const CHIME_DECISION_MODEL = 'haiku';
const MAX_TEXT = 3000;

export const CHIME_DECISION_SYSTEM_PROMPT =
  '你在一个桌面陪伴应用里，扮演用户消息中描述的角色。几位角色和用户在同一个画面里，你刚听见台上有人说了话。你没有任何工具，也不能读写文件或执行命令。'
  + '只输出用户消息要求的那一个 JSON 对象，不输出任何其他文字、解释、标签或代码块。';
export const CHIME_LINE_SYSTEM_PROMPT =
  '你在一个桌面陪伴应用里，扮演用户消息中描述的角色。几位角色和用户在同一个画面里，你刚听见台上有人说了话，现在可以用角色自己的口吻接一句，也可以不说。你没有任何工具，也不能读写文件或执行命令。'
  + '只输出用户消息要求的那一个 JSON 对象，不输出任何其他文字、解释、标签或代码块；不提及自己是 Claude、AI 或编程助手，也不提工具、会话或设置。';

export type ChimeStream = (task: ClaudeTask, signal: AbortSignal, emit: (type: string, text: string) => void) => Promise<ClaudeUsage | null>;

async function once(model: string, systemPrompt: string, prompt: string, signal: AbortSignal, stream: ChimeStream): Promise<string> {
  let text = '', overflow = false;
  await stream({ kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [], systemPrompt }, signal, (type, value) => {
    if (type !== 'delta' || overflow) return;
    if (text.length + value.length > MAX_TEXT) { overflow = true; return; }
    text += value;
  });
  return overflow ? '' : text;
}

/** Her decision's raw answer (electron/brain/stage-chat/facts.ts parseChimeDecision reads it). */
export function chimeDecisionWithClaude(prompt: string, signal: AbortSignal, stream: ChimeStream = streamClaude): Promise<string> {
  return once(CHIME_DECISION_MODEL, CHIME_DECISION_SYSTEM_PROMPT, prompt, signal, stream);
}

/** Her line's raw answer (shared/senses/sense-router.ts parseSenseLine reads it). `model`: the chat model setting as stored. */
export function chimeLineWithClaude(prompt: string, model: string, signal: AbortSignal, stream: ChimeStream = streamClaude): Promise<string> {
  return once(model, CHIME_LINE_SYSTEM_PROMPT, prompt, signal, stream);
}
