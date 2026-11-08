export const TASK_PIPE_PREFIX: string;
export const TOOL_NAME: 'approve';
export const TOOL: { name: 'approve'; description: string; inputSchema: Record<string, unknown> };
export type TaskDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: true };
export function deny(message: string): TaskDecision;
export function readTaskCredentials(env?: Record<string, string | undefined>, platform?: NodeJS.Platform): { endpoint: string; token: string } | null;
export function validDecision(value: unknown): TaskDecision | null;
export class TaskConnection {
  constructor(options?: {
    credentials: { endpoint: string; token: string } | null;
    connect?: (endpoint: string) => import('node:net').Socket;
    handshakeTimeoutMs?: number; requestTimeoutMs?: number;
  });
  approve(args: unknown): Promise<TaskDecision>;
  close(): void;
}
export function createTaskMcpServer(options: {
  connection: { approve(args: unknown): Promise<TaskDecision> };
  respond(message: any): void;
}): { handle(message: unknown): Promise<void> };
export function runStdio(options?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; env?: Record<string, string | undefined> }): {
  connection: TaskConnection; server: { handle(message: unknown): Promise<void> };
};
