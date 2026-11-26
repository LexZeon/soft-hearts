export type ClaudeDiscovery =
  | { status: 'found'; path: string }
  | { status: 'invalid-override' | 'desktop-bundled' | 'missing'; path: null };
/** Whether `file` is inside the Claude desktop app's own copy of Claude Code (never used; see claude-discovery.mjs). */
export function isDesktopBundledClaude(file: unknown): boolean;
export function discoverClaude(options?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  io?: unknown;
}): Promise<ClaudeDiscovery>;
