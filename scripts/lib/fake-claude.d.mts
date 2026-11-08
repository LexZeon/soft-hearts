export declare const REACTION_JUDGE_OPENING: string;
export declare const FAKE_CLAUDE_MARKER: string;
export declare const FAKE_CLAUDE_REPLY: readonly string[];
export declare const FAKE_CLAUDE_HOLD: string;
export declare const FOLLOW_UP_MARKER: string;
export declare function verifyArguments(args: unknown): { ok: true; model: string; systemPromptLength: number } | { ok: false; reason: string };
export declare function parseConversation(text: unknown): { opening: boolean; currentUser: string; historyLength: number } | null;
export interface FakeClaudeTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export declare function createFakeClaude(options: {
  args: unknown;
  output(event: Record<string, any>): void;
  log(entry: Record<string, any>): void;
  timers?: FakeClaudeTimers;
  holdMs?: number;
  gapMs?: number;
}): { line(raw: string): void; close(): void; readonly busy: boolean };
export interface FakeClaudeTurn {
  key: string; spawn: number; pid: number | null; seq: number; parsed: boolean; opening: boolean | null; currentUser: string | null;
  historyLength: number | null; imageCount: number; promptLength: number; replies: number; interrupted: boolean; refused: boolean;
}
export interface FakeClaudeSpawn {
  index: number; pid: number | null; cwdEmpty: boolean | null; stdinEnded: boolean; unexpected: number;
  start: { argvOk: boolean; model?: string; systemPromptLength?: number; reactionJudge?: boolean; reason?: string } | null;
}
export declare function readFakeClaudeLogs(directory: string): { spawns: FakeClaudeSpawn[]; turns: FakeClaudeTurn[] };
