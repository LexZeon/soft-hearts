// A Claude stand-in for booting electron/main.ts under node (docs/claude/2026-11-17-isolation-step7.md): everything electron/brain/claude.ts
// exports, except that no Claude Code process ever starts. A chat call answers 「好哒」 at once (the app's own checks run first: a call
// that is not a plain chat, or asks for tools, is refused exactly as the real one refuses it); finding Claude names a path that is never run.
import { claudeInput, type ClaudeTask, type ClaudeUsage } from '../../../electron/brain/claude';
export * from '../../../electron/brain/claude';

/** Every call the app made, for the test to read. */
export const standInClaudeCalls: { kind: string; writable: boolean; prompt: string }[] = [];
(globalThis as Record<string, unknown>).__softHeartsClaudeCalls = standInClaudeCalls;

export async function findClaude(): Promise<string> { return 'stand-in-claude.exe'; }
export async function streamClaude(task: ClaudeTask, signal: AbortSignal, emit: (type: 'delta' | 'status' | 'thinking', text: string) => void): Promise<ClaudeUsage | null> {
  if (task.kind !== 'chat' || task.writable) throw new Error('Claude 聊天通道只支持无工具的普通聊天。');
  signal.throwIfAborted();
  claudeInput(task);
  standInClaudeCalls.push({ kind: task.kind, writable: task.writable, prompt: task.prompt });
  emit('delta', '好哒。');
  return null;
}
