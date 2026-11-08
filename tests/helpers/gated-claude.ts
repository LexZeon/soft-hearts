// A persistent Claude chat whose process start can be held open, so a test can act in the late window: after a turn was put
// together, while its message waits for the process (the same stand-in as tests/recall-late-window.test.ts). No CLI, no
// network, no model: the fake process keeps every message line it is handed and answers one short line.
import { PersistentClaudeChat } from '../../electron/claude-session';
import type { ClaudeChatProcess } from '../../electron/claude-process';

export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

export function fakeProcess(lines: string[]): ClaudeChatProcess {
  const process = {
    model: 'sonnet', turnsStarted: 0, alive: true, busy: false,
    settled: async () => {}, close: () => { process.alive = false; }, supersede: () => false,
    runTurn: async (line: string, _signal: AbortSignal, emit: (type: 'delta', text: string) => void) => {
      lines.push(line); process.turnsStarted++;
      emit('delta', '嗯。');
      return { output: '嗯。', superseded: false };
    },
  };
  return process as unknown as ClaudeChatProcess;
}

/** `starting` resolves when the process start began (the turn waits there); `open()` lets it finish. */
export function gatedChat(lines: string[]) {
  const starting = deferred<void>(), gate = deferred<void>();
  const chat = new PersistentClaudeChat({ enabled: true, binary: async () => 'claude',
    startProcess: async () => { starting.resolve(); await gate.promise; return fakeProcess(lines); } });
  return { chat, starting: starting.promise, open: () => gate.resolve(undefined) };
}

/** The text of one message line written to Claude Code's stdin. */
export function sentText(line: string): string {
  const content = JSON.parse(line).message.content as string | { type: string; text?: string }[];
  return typeof content === 'string' ? content : content.map(block => block.text ?? '').join('');
}
