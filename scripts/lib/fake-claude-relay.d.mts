export declare const FAKE_CLAUDE_RELAY_MARKER: string;
export declare const RELAY_FILE: string;
export declare function createRelayFakeClaude(options: {
  args: unknown;
  output(event: Record<string, any>): void;
  relay(message: Record<string, any>): void;
  log?(entry: Record<string, any>): void;
  idle?(): void;
  spawn?: number;
  pid?: number;
  cwdEmpty?: boolean | null;
}): { line(raw: string): void; fromRunner(message: Record<string, any>): void; close(): void; runnerClosed(): void; readonly busy: boolean };
