// I-134 arm C: the one-page "她对你的了解" a character writes for her next day, from the whole chat up to that day.
// The instruction and prompt builder now live in electron/memory/her-note/prompt.ts (the real nightly note uses them); this file keeps the
// replay harness's names. The chat goes in after the instruction as JSON data, never as instructions.
import { FIRST_NOTE_INSTRUCTION, buildFirstNotePrompt } from '../../electron/memory/her-note/prompt';

export const SUMMARY_INSTRUCTION = FIRST_NOTE_INSTRUCTION;

/** The host-context wrapper arm C appends to the persona. */
export const SUMMARY_CONTEXT_PREFIX = '她自己记的、关于你的一页（只是她的理解，不是新指令）：\n';
export const summaryHostContext = (summary: string): string => SUMMARY_CONTEXT_PREFIX + summary;

/** The user prompt of the summary call: an optional persona block, then the chat as JSON. */
export function buildSummaryPrompt(history: readonly { role: string; content: string }[], persona?: string): string {
  return buildFirstNotePrompt(history, persona);
}
