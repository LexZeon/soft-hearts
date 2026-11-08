// Per-run "task-permission" endpoint. Reuses the agent channel's wire format and transport
// (HMAC handshake, one request at a time, frame limits) with a separate, short-lived
// identity: a fresh random token and a fresh private endpoint for every task process,
// one connection only, gone as soon as the process ends. The agent channel itself is not
// involved and need not be turned on.
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentChannelServer } from '../agent-channel/transport';
import type { AgentCallResult } from '../agent-channel/registry';
import { TASK_PERMISSION_TOOL_NAME, taskMcpConfig, type ShimLaunch } from './process';

export const TASK_PIPE_PREFIX = '\\\\.\\pipe\\soft-hearts-next-task-';

/** What the shim forwards: Claude Code's permission prompt input, unchanged. */
export type PermissionHandler = (request: unknown) => Promise<Record<string, unknown>>;

export interface TaskPermissionEndpoint {
  readonly endpoint: string;
  readonly mcpConfigFile: string;
  close(): Promise<void>;
}

export interface TaskPermissionOptions {
  launch: ShimLaunch;
  handle: PermissionHandler;
  platform?: NodeJS.Platform;
  tempRoot?: string;
}

/** Starts the endpoint and writes the owner-only MCP config file that carries its token. */
export async function openTaskPermissionEndpoint(options: TaskPermissionOptions): Promise<TaskPermissionEndpoint> {
  const platform = options.platform ?? process.platform;
  // mkdtemp creates the folder 0700; the token file below is 0600.
  const directory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), 'shn-task-'));
  const token = randomBytes(32).toString('hex');
  const endpoint = platform === 'win32' ? `${TASK_PIPE_PREFIX}${randomBytes(12).toString('hex')}` : path.join(directory, 'p.sock');
  let open = true;
  const server = new AgentChannelServer(endpoint, {
    token: () => open ? token : null,
    list: () => ({ tools: [TASK_PERMISSION_TOOL_NAME] }),
    call: async (tool, args): Promise<AgentCallResult> => {
      if (!open || tool !== TASK_PERMISSION_TOOL_NAME) return { ok: false, error: { code: 'unknown_tool', message: '未知工具。' } };
      return { ok: true, result: await options.handle(args) };
    },
  }, { maxConnections: 1, ratePerMinute: 240, idleTimeoutMs: 2 * 60 * 60_000 }, platform);
  const mcpConfigFile = path.join(directory, 'mcp.json');
  try {
    await server.start();
    await writeFile(mcpConfigFile, JSON.stringify(taskMcpConfig(options.launch, endpoint, token)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (platform !== 'win32') await chmod(mcpConfigFile, 0o600);
  } catch (error) {
    open = false;
    await server.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    endpoint, mcpConfigFile,
    async close() {
      if (!open) return;
      open = false;
      await server.stop().catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}
