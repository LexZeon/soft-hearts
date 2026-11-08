import os from 'node:os';
import { streamClaude, type ClaudeTask, type ClaudeUsage } from '../claude';
import { INNER_LOOP_MODEL } from '../inner-loop/model';
import { FEED_LINE_SYSTEM_PROMPT, FEED_RECOGNITION_SYSTEM_PROMPT } from '../../shared/feed-recognition';

/**
 * I-019, brain interface (docs/claude/brain-interface.md): the two Claude calls of a feed, and their model tiers, live here.
 *  - The look: one tool-less call with the small model (the inner loop's tier, haiku), this one picture attached as a
 *    base64 JPEG over stdin (electron/claude.ts imageBlock), the strict-JSON system prompt.
 *  - Her line: one tool-less call with the user's chat model (the "聊天模型" setting; empty = Claude Code's default,
 *    Opus for this user), its own short system prompt. No session, no history: the archive keeps the result.
 */
export type FeedStream = (task: ClaudeTask, signal: AbortSignal, emit: (type: string, text: string) => void) => Promise<ClaudeUsage | null>;
const MAX_TEXT = 3000;

async function collect(task: ClaudeTask, signal: AbortSignal, stream: FeedStream): Promise<string> {
  let text = '', overflow = false;
  await stream(task, signal, (type, value) => {
    if (type !== 'delta' || overflow) return;
    if (text.length + value.length > MAX_TEXT) { overflow = true; return; }
    text += value;
  });
  return overflow ? '' : text;
}

export function recognizeWithClaude(prompt: string, imageDataUrl: string, signal: AbortSignal, stream: FeedStream = streamClaude): Promise<string> {
  return collect({ kind: 'chat', model: INNER_LOOP_MODEL, workingDirectory: os.tmpdir(), writable: false, prompt,
    imageDataUrls: [imageDataUrl], systemPrompt: FEED_RECOGNITION_SYSTEM_PROMPT }, signal, stream);
}

/** `model`: the chat model setting as stored ('' keeps Claude Code's default, like every chat turn). */
export function feedLineWithClaude(prompt: string, model: string, signal: AbortSignal, stream: FeedStream = streamClaude): Promise<string> {
  return collect({ kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [], systemPrompt: FEED_LINE_SYSTEM_PROMPT }, signal, stream);
}
