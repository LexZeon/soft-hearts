export type CodexDiscovery =
  | { status: 'found'; path: string }
  | { status: 'invalid-override' | 'missing'; path: null };
export function discoverCodex(options?: {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): Promise<CodexDiscovery>;
