import os from 'node:os';
import { streamClaude, type ClaudeCallLimits, type ClaudeTask, type ClaudeUsage } from '../../brain';
import type { ConversionModel } from './translate';

/**
 * I-071 v2 第三步 转换, brain interface (docs/claude/brain-interface.md): the conversion's Claude calls live here. Each is one
 * tool-less call (`streamClaude`, its own system prompt, no session, no history) with the Claude 助手's model and thinking effort
 * (`--model`, `--effort`), on the user's own Claude Code. The answer is plain text; translate.ts reads it as JSON data.
 */
export type ConversionStream = (task: ClaudeTask, signal: AbortSignal, emit: (type: string, text: string) => void) => Promise<ClaudeUsage | null>;
const MAX_TEXT = 400_000;

/**
 * Fix 6 (sixth test: a memory batch of 81 s, then over 120 s, voided the conversion): the conversion's own calls are cut by
 * silence, not by a fixed 120 s. A call that keeps writing may run up to the overall cap; one that goes quiet for the idle time
 * is stopped (and retried once, translate.ts). These are safety floors (a stuck process must end), not a pacing rule; chat and
 * every other caller keep their own caps.
 */
export const CONVERSION_CLAUDE_LIMITS: Readonly<Required<Pick<ClaudeCallLimits, 'idleTimeoutMs' | 'overallTimeoutMs'>>> = Object.freeze({ idleTimeoutMs: 60_000, overallTimeoutMs: 6 * 60_000 });

const conversionStream: ConversionStream = (task, signal, emit) => streamClaude(task, signal, emit, undefined, [], { ...CONVERSION_CLAUDE_LIMITS });

export function conversionModel(choice: () => { model: string; effort: 'low' | 'medium' | 'high' }, stream: ConversionStream = conversionStream): ConversionModel {
  return async (prompt, systemPrompt, signal) => {
    const { model, effort } = choice();
    let text = '', overflow = false;
    await stream({ kind: 'chat', model, effort, workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [], systemPrompt }, signal, (type, value) => {
      if (type !== 'delta' || overflow) return;
      if (text.length + value.length > MAX_TEXT) { overflow = true; return; }
      text += value;
    });
    if (overflow) throw new Error('翻译的回答太长了。');
    return text;
  };
}
