export declare const FIXTURE_CLAUDE_MODEL: string;
export declare const FIXTURE_MAX_SPAWNS: number;
export interface FixtureOwnedPaths { codexHome: string; sentinel: string; claudeHome: string; claudePlaceholder: string }
export declare function fixtureClaudeProvider(model?: string): { kind: 'claude'; model: string };
export declare function isolatedClaudeEnvironment(base: Record<string, string | undefined> | undefined, owned: FixtureOwnedPaths): Record<string, string>;
export interface FixtureConversation { opening: boolean; currentUser: string; history: Array<{ role: string; content: string }> }
export declare function readConversation(text: unknown): FixtureConversation | null;
export declare function personaPart(text: unknown): string;
export interface FixtureTurn {
  readonly index: number;
  readonly spawn: number;
  readonly seq: number;
  readonly model: string | null;
  readonly systemPrompt: string;
  readonly text: string;
  readonly conversation: FixtureConversation | null;
  readonly currentUser: string | null;
  readonly history: Array<{ role: string; content: string }>;
  readonly opening: boolean | null;
  readonly messages: Array<{ role: string; content: string }>;
  readonly images: Array<{ mediaType: string; data: string; dataUrl: string }>;
  readonly signal: AbortSignal;
  readonly closed: Promise<'done' | 'fail' | 'cancel'>;
  readonly finished: boolean;
  readonly cancelled: boolean;
  readonly cancelReason: 'interrupt' | 'closed' | null;
  nonce(kind?: 'state' | 'memorial' | 'setting'): string | null;
  delta(text: string): boolean;
  done(): boolean;
  fail(reason?: string): boolean;
  reply(...chunks: Array<string | string[]>): boolean;
  onCancel(listener: (reason: string) => void): void;
}
export interface FixtureSpawn { spawn: number; pid: number; argvOk: boolean; reason: string | null; model: string | null; systemPrompt: string; cwdEmpty: boolean | null; closed: boolean }
export interface ClaudeIsolation extends FixtureOwnedPaths {
  base: string;
  fakeLog: string;
  provider: { kind: 'claude'; model: string };
  model: string;
  environment(base?: Record<string, string | undefined>): Record<string, string>;
  claudeHomeEmpty(): Promise<boolean>;
}
/** Without `root`, an owned folder is made under the system temp folder and removed when the runner exits. */
export declare function createClaudeIsolation(options?: { root?: string; model?: string }): Promise<ClaudeIsolation>;
export interface ClaudeFixture extends ClaudeIsolation {
  turns: FixtureTurn[];
  spawns: FixtureSpawn[];
  errors: string[];
  install(instance: { evaluate(fn: Function, arg?: unknown): Promise<unknown> }): Promise<unknown>;
  evidence(instance: { evaluate(fn: Function, arg?: unknown): Promise<unknown> }): Promise<unknown>;
  waitForTurn(predicate?: (turn: FixtureTurn) => boolean, timeout?: number): Promise<FixtureTurn>;
  assertClean(models?: string[]): void;
  close(milliseconds?: number): Promise<{ fakeClaudeExited: boolean; claudeHomeEmpty: boolean }>;
}
export declare function createClaudeFixture(options?: {
  root?: string;
  respond?(turn: FixtureTurn): unknown;
  model?: string;
  maxSpawns?: number;
}): Promise<ClaudeFixture>;
