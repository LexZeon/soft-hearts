import os from 'node:os';
import { streamClaude } from '../claude';
import { quickLineWithClaude, type InnerLoopStream } from '../inner-loop/model';
import { SENSE_LINE_SYSTEM_PROMPT } from '../../shared/sense-router';

/**
 * I-040, brain interface (docs/claude/brain-interface.md): the Claude calls of 看一眼、听一下 and their model tiers live here.
 *  - The judgment (only when the reaction judge's call does not carry it) and the look or read: one tool-less haiku call each
 *    (quickLineWithClaude), at most one picture as a base64 JPEG over stdin (electron/claude.ts imageBlock, nothing on disk).
 *  - Her line: one tool-less call with the user's chat model (the "聊天模型" setting; '' = Claude Code's default, Opus for this
 *    user), its own short system prompt, no session: the facts go in its prompt once and are not kept.
 */
const MAX_TEXT = 3000;

export async function senseAskWithClaude(prompt: string, systemPrompt: string, images: readonly string[], signal: AbortSignal, stream: InnerLoopStream = streamClaude): Promise<string> {
  return (await quickLineWithClaude(prompt, systemPrompt, signal, stream, images.slice(0, 1))).text;
}

/** `model`: the chat model setting as stored ('' keeps Claude Code's default, like every chat turn). */
export async function senseLineWithClaude(prompt: string, model: string, signal: AbortSignal, stream: InnerLoopStream = streamClaude): Promise<string> {
  let text = '', overflow = false;
  await stream({ kind: 'chat', model, workingDirectory: os.tmpdir(), writable: false, prompt, imageDataUrls: [], systemPrompt: SENSE_LINE_SYSTEM_PROMPT }, signal, (type, value) => {
    if (type !== 'delta' || overflow) return;
    if (text.length + value.length > MAX_TEXT) { overflow = true; return; }
    text += value;
  });
  return overflow ? '' : text;
}
