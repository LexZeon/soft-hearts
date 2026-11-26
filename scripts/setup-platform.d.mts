// Types for TypeScript tests that import scripts/setup-platform.mjs (2026-11-25: tests/claude-env-*.test.ts).
export function platformTarget(platform: string, arch: string): { platform: string; arch: string; os: string };
export function pinnedPnpm(packageManager: string | undefined): string;
export function checkNode(version: string): void;
export function executableFile(file: string): Promise<boolean>;
export function findOnPath(name: string, env: NodeJS.ProcessEnv, isExecutable?: (file: string) => Promise<boolean>): Promise<string | null>;
export function findUnixClaude(env: NodeJS.ProcessEnv, options?: Record<string, unknown>): Promise<import('./claude-discovery.mjs').ClaudeDiscovery>;
export function claudeVersion(file: string, run?: (file: string) => Promise<string>): Promise<string>;
/** The setup check's sentence when only the Claude desktop app's own copy of Claude Code is here (scripts/setup.ps1 prints the same). */
export const CLAUDE_DESKTOP_BUNDLED_NEXT_STEP: string;
export function claudeNextStep(status: string): string;
export const OTHER_AGENTS: readonly { id: string; command: string; label: string }[];
export function findOtherAgents(env: NodeJS.ProcessEnv, isExecutable?: (file: string) => Promise<boolean>, table?: readonly { id: string; command: string; label: string }[]): Promise<{ id: string; command: string; label: string; path: string }[]>;
export function otherAgentHint(agents: readonly { label: string; path: string }[]): string;
export function setupPlan(options: { platform: string; arch: string; nodeVersion: string; packageManager: string | undefined; args: string[] }): { version: string; commands: string[][]; launch: boolean };
export function applicationEnvironment(env: NodeJS.ProcessEnv, nodeExecutable: string, claudePath?: string | null): NodeJS.ProcessEnv;
export function packagingArguments(platform: string, arch: string, args: string[]): string[];
