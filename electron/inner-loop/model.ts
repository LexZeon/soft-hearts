import os from 'node:os';
import { streamClaude, type ClaudeTask, type ClaudeUsage } from '../claude';
import { INNER_LOOP_SYSTEM_PROMPT } from '../../shared/inner-loop';
import type { InnerLoopUsage } from './inner-loop';

/** The inner loop always asks the small model; the saved chat model (and its memory scope) is untouched. */
export const INNER_LOOP_MODEL = 'haiku';
const MAX_TEXT = 2000;

export type InnerLoopStream = (task: ClaudeTask, signal: AbortSignal, emit: (type: string, text: string) => void) => Promise<ClaudeUsage | null>;

export function innerLoopUsage(value: ClaudeUsage | null | undefined): InnerLoopUsage | null {
  if (!value) return null;
  const parts = [value.inputTokens, value.cacheReadInputTokens, value.cacheCreationInputTokens].filter((n): n is number => n !== null);
  return { inputTokens: parts.length ? parts.reduce((sum, n) => sum + n, 0) : null, outputTokens: value.outputTokens, costUsd: value.costUsd };
}

/** One tool-less Claude Code call with the inner loop's own system prompt. Overlong output is just invalid. */
export async function decideWithClaude(prompt: string, signal: AbortSignal, stream: InnerLoopStream = streamClaude): Promise<{ text: string; usage: InnerLoopUsage | null }> {
  return quickLineWithClaude(prompt, INNER_LOOP_SYSTEM_PROMPT, signal, stream);
}

/**
 * The same small, tool-less call with another short-task system prompt (G1 猜拳's one witty line per match).
 * Brain interface (docs/claude/brain-interface.md): the model tier and the call stay in this module.
 * `imageDataUrls`: pictures that go with the prompt over stdin (屏幕只读大概: one 320×200 thumbnail, electron/screen-glance.ts); none by default.
 */
export async function quickLineWithClaude(prompt: string, systemPrompt: string, signal: AbortSignal, stream: InnerLoopStream = streamClaude,
  imageDataUrls: readonly string[] = []): Promise<{ text: string; usage: InnerLoopUsage | null }> {
  let text = '', overflow = false;
  const usage = await stream({ kind: 'chat', model: INNER_LOOP_MODEL, workingDirectory: os.tmpdir(), writable: false,
    prompt, imageDataUrls: [...imageDataUrls], systemPrompt }, signal, (type, value) => {
    if (type !== 'delta' || overflow) return;
    if (text.length + value.length > MAX_TEXT) { overflow = true; return; }
    text += value;
  });
  return { text: overflow ? '' : text, usage: innerLoopUsage(usage) };
}
