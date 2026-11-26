import os from 'node:os';
import { streamClaude, type ClaudeTask, type ClaudeUsage } from '../../brain';
import { KEEPSAKE_SYSTEM_PROMPT, KEEPSAKE_SYSTEM_PROMPT_RELAXED } from './keepsake-prompt';
import { herVoiceRelaxed } from '../../../shared/voice';

/**
 * I-050 第 2 步, brain interface (docs/claude/brain-interface.md): the keepsake's one Claude call lives here. One tool-less call with the
 * user's chat model (the "聊天模型" setting; empty = Opus (I-222): she who plays the character is the one
 * who writes the gift), its own system prompt, no session and no history. The text comes back as the answer; the parse is in keepsake-prompt.ts.
 */
export type KeepsakeStream = (task: ClaudeTask, signal: AbortSignal, emit: (type: string, text: string) => void) => Promise<ClaudeUsage | null>;
const MAX_TEXT = 16_000;

/** `model`: the chat model setting as stored ('' is Opus, like every chat turn: I-222). Overlong output is just invalid (''). */
export async function keepsakeWithClaude(prompt: string, model: string, signal: AbortSignal, stream: KeepsakeStream = streamClaude): Promise<string> {
  let text = '', overflow = false;
  await stream({ kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [], systemPrompt: herVoiceRelaxed() ? KEEPSAKE_SYSTEM_PROMPT_RELAXED : KEEPSAKE_SYSTEM_PROMPT }, signal, (type, value) => {
    if (type !== 'delta' || overflow) return;
    if (text.length + value.length > MAX_TEXT) { overflow = true; return; }
    text += value;
  });
  return overflow ? '' : text;
}
