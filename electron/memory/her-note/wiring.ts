// I-134 step 3: the host's one construction point for her note (electron/main.ts calls createHerNote once, next to the diary writer).
import os from 'node:os';
import { streamClaude } from '../../brain';
import type { UserProfileScope } from '../user-profile';
import { HerNoteStore } from './store';
import { HerNoteWriter, type HerNoteAskInput, type HerNoteWriterOptions } from './writer';

/** The app's adapter: the user's own Claude Code, one headless tool-free process in a temp folder, the chat model as saved. */
export async function askHerNoteWithClaude(input: HerNoteAskInput, signal: AbortSignal, run: typeof streamClaude = streamClaude): Promise<string> {
  let output = '';
  await run({ kind: 'chat', model: input.model, workingDirectory: os.tmpdir(), writable: false, prompt: input.prompt, systemPrompt: input.system }, signal,
    (type, text) => { if (type === 'delta') output += text; });
  return output;
}

export interface HerNoteHost {
  store: HerNoteStore;
  writer: HerNoteWriter;
  /** For the chat session's `openingNote`: her current page for this scope, or '' (never throws). */
  noteFor(scope: UserProfileScope): string;
}

export function createHerNote(directory: string, options: Omit<HerNoteWriterOptions, 'store' | 'ask'> & { ask?: HerNoteWriterOptions['ask'] }): HerNoteHost {
  const store = new HerNoteStore(directory);
  const writer = new HerNoteWriter({ ...options, store, ask: options.ask ?? ((input, signal) => askHerNoteWithClaude(input, signal)) });
  return { store, writer, noteFor: scope => { try { return store.current(scope)?.text ?? ''; } catch { return ''; } } };
}
