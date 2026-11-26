export const ASSISTANT_PIPE_PREFIX: string;
export interface AssistantMcpTool { name: string; title?: string; description: string; inputSchema: { type: 'object' } & Record<string, unknown>; annotations?: Record<string, unknown> }
export function readAssistantCredentials(env?: Record<string, string | undefined>, platform?: NodeJS.Platform): { endpoint: string; token: string } | null;
export function validTools(value: unknown): AssistantMcpTool[];
export class AssistantConnection {
  constructor(options?: {
    credentials: { endpoint: string; token: string } | null;
    connect?: (endpoint: string) => import('node:net').Socket;
    handshakeTimeoutMs?: number; requestTimeoutMs?: number;
  });
  request(frame: Record<string, unknown>): Promise<Record<string, any>>;
  close(): void;
}
export function createAssistantMcpServer(options: {
  connection: { request(frame: Record<string, unknown>): Promise<Record<string, any>> };
  respond(message: any): void;
}): { handle(message: unknown): Promise<void> };
export function runStdio(options?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; env?: Record<string, string | undefined> }): {
  connection: AssistantConnection; server: { handle(message: unknown): Promise<void> };
};
