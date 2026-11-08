export const PROFILE_FOLDER: 'soft-hearts-claude';
export const PIPE_PREFIX: string;
export const LEGACY_PROTOCOL_VERSIONS: readonly string[];
export class ShimError extends Error {
  constructor(code: string, message: string);
  code: string;
}
export interface ToolCatalog {
  server?: { name?: string; title?: string };
  tools: Array<{ name: string; title: string; tier: 'read' | 'reversible' | 'confirm'; description: string; inputSchema: unknown }>;
}
export function defaultProfileDirectory(env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string): string;
export function resolveProfileDirectory(argv?: string[], env?: Record<string, string | undefined>, platform?: NodeJS.Platform, home?: string): string;
export function readCredentials(profileDirectory: string, platform?: NodeJS.Platform, read?: (file: string) => string, username?: string): { endpoint: string; token: string };
export function loadToolCatalog(here?: string, read?: (file: string) => string): ToolCatalog;
/** A wire frame answered by the app: `{ t: 'result', id, ok, result? , error? }`. */
export type ResultFrame = { t: 'result'; id: number; ok: boolean; result?: any; error?: { code: string; message: string } };
export class AppConnection {
  constructor(options?: {
    profileDirectory?: string; platform?: NodeJS.Platform; connect?: (endpoint: string) => import('node:net').Socket;
    readCredentialsFile?: (file: string) => string; handshakeTimeoutMs?: number; requestTimeoutMs?: number;
  });
  request(frame: Record<string, unknown>): Promise<ResultFrame & Record<string, any>>;
  close(): void;
}
export function toolList(catalog: ToolCatalog): Array<Record<string, unknown>>;
export function createMcpServer(options: {
  catalog?: ToolCatalog;
  connection: { request(frame: Record<string, unknown>): Promise<any> };
  respond(message: any): void;
  log?(line: string): void;
}): { handle(message: unknown): Promise<void> };
export function runStdio(options?: Record<string, unknown>): { connection: AppConnection; server: { handle(message: unknown): Promise<void> } };
