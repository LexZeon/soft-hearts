export type ClaudeDiscovery =
  | { status: 'found'; path: string }
  | { status: 'invalid-override' | 'missing'; path: null };
export function discoverClaude(options?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  io?: unknown;
}): Promise<ClaudeDiscovery>;
