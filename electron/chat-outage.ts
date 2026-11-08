import path from 'node:path';
import type { ChatAvailabilityView } from '../shared/chat-availability';
import { ChatAvailability, chatAvailability } from './chat-availability';
import { ChatAvailabilityHost } from './chat-availability-host';
import { OutageLineBank, OutageLineScheduler, outageCardKey, type OutageLineLimits } from './outage-lines';
import type { ClaudeTask } from './claude';

export interface ChatOutageDeps {
  /** Default: the app-wide instance the inner loop and other background callers also use. */
  availability?: ChatAvailability;
  /** The profile folder (`outage-lines.json` lives in it). Read when needed, not before the profile exists. */
  directory(): string;
  provider(): { kind: string; model: string };
  /** The active character card's compiled text, or null. */
  persona(): string | null;
  /** A chat turn is running. */
  chatBusy(): boolean;
  publish(view: ChatAvailabilityView): void;
  openExternal(target: string): Promise<void> | void;
  /** streamClaude, or a stand-in in tests. */
  /** streamClaude; its resolved value (usage numbers) is not used here. */
  run(task: ClaudeTask, signal: AbortSignal, emit: (type: 'delta' | 'status' | 'done' | 'error', text: string) => void): Promise<unknown>;
  platform?: NodeJS.Platform;
  /** Test seams: how long after a working turn her lines are prepared, the clock, and the generation limits. */
  lineDelayMs?: number;
  now?: () => number;
  lineLimits?: Partial<OutageLineLimits>;
  /** Also told when chat has just worked. */
  worked?: () => void;
}

/**
 * Puts the pieces of "Claude cannot answer" together for the app: the shared availability state, the cache of
 * her own lines for the active card, the scheduler that prepares them while chat works, and the control
 * window's fixed repair operations. electron/main.ts only supplies the dependencies and registers the IPC.
 */
export function createChatOutage(deps: ChatOutageDeps) {
  const availability = deps.availability ?? chatAvailability;
  const oneShot = async (prompt: string, signal: AbortSignal): Promise<string> => {
    const provider = deps.provider();
    if (provider.kind !== 'claude') throw new Error('当前聊天连接不是 Claude。');
    let text = '';
    await deps.run({ kind: 'chat', model: provider.model, workingDirectory: path.join(deps.directory(), 'chat'), writable: false, prompt, imageDataUrls: [] },
      signal, (type, value) => { if (type === 'delta') text += value; });
    return text;
  };
  const bank = new OutageLineBank({ file: () => path.join(deps.directory(), 'outage-lines.json'), generate: oneShot,
    ...(deps.now ? { now: deps.now } : {}), ...(deps.lineLimits ? { limits: deps.lineLimits } : {}) });
  const scheduler = new OutageLineScheduler({ bank, persona: deps.persona, busy: deps.chatBusy, ...(deps.lineDelayMs !== undefined ? { delayMs: deps.lineDelayMs } : {}) });
  availability.attach({
    cardKey: () => { const persona = deps.persona(); return persona ? outageCardKey(persona) : ''; },
    line: (kind, pick) => { const persona = deps.persona(); return persona ? bank.pick(persona, kind, pick) : null; },
    changed: deps.publish,
    worked: () => { scheduler.worked(); try { deps.worked?.(); } catch { /* Best effort. */ } },
  });
  const host = new ChatAvailabilityHost({
    availability,
    // "Retry" asks one tiny question; it is not a chat turn and is not remembered anywhere.
    probe: async signal => { await oneShot('请只回复一个字：好', signal); },
    openExternal: deps.openExternal,
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  // `generate`: the same one-shot, tool-less call with the chat model, for other per-card lines.
  return { availability, bank, scheduler, host, generate: oneShot, load: () => bank.load(), dispose: () => scheduler.dispose() };
}
