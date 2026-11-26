/**
 * Unbound showcase (docs/claude/2026-11-14-lapwing-showcase.md): the one Claude call — Claude writes one segment of the
 * choreography. Brain-interface module (docs/claude/brain-interface.md): a single tool-less call through `streamClaude`
 * (electron/brain/claude.ts) with this module's own system prompt; the answer is one JSON object, read and validated without the model
 * (shared/unbound/showcase.ts). Nothing private goes into the prompt: a neutral character, a sampled mood, a stock situation.
 */
import os from 'node:os';
import { streamClaude, type ClaudeUsage } from '../../brain';
import { SHOWCASE_SYSTEM_PROMPT, parseShowcaseSegment, showcasePrompt, type ShowcasePromptInput, type ShowcaseSegment } from '../../../shared/unbound/showcase';

/** Sonnet: quick enough to answer while her opening plays, good enough to compose. Low effort: no long thinking before the JSON. */
export const SHOWCASE_MODEL = 'sonnet';
export const SHOWCASE_LIMITS = { firstResponseTimeoutMs: 45_000, idleTimeoutMs: 45_000, overallTimeoutMs: 120_000 };

export interface ComposedSegment { prompt: string; text: string; ms: number; usage: ClaudeUsage | null; segment: ShowcaseSegment | null; error: string | null }

export async function composeSegment(input: ShowcasePromptInput, signal: AbortSignal): Promise<ComposedSegment> {
  const prompt = showcasePrompt(input), started = Date.now();
  let text = '';
  try {
    const usage = await streamClaude({ kind: 'chat', model: SHOWCASE_MODEL, workingDirectory: os.tmpdir(), writable: false, prompt, systemPrompt: SHOWCASE_SYSTEM_PROMPT, effort: 'low' },
      signal, (type, value) => { if (type === 'delta' && text.length < 60_000) text += value; }, undefined, [], SHOWCASE_LIMITS);
    return { prompt, text, ms: Date.now() - started, usage, segment: parseShowcaseSegment(text, input.window), error: null };
  } catch (error) {
    return { prompt, text, ms: Date.now() - started, usage: null, segment: null, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
  }
}
