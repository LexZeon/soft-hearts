import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_PIPE_PREFIX as WIRE_PIPE_PREFIX, agentPipeName } from '../../scripts/agent-channel-wire.mjs';

/** This edition only. The Codex edition ("soft hearts") never uses this prefix. */
export const AGENT_EDITION = 'soft-hearts-next';
export const AGENT_PIPE_PREFIX: string = WIRE_PIPE_PREFIX;
export const AGENT_CREDENTIALS_FILE = 'agent-channel.json';
export const AGENT_SOCKET_DIRECTORY = 'agent-channel';
export const AGENT_SOCKET_NAME = 'agent.sock';

export interface AgentCredentials { version: 1; edition: typeof AGENT_EDITION; endpoint: string; token: string; createdAt: string }

/**
 * Windows: a per-user, per-profile named pipe. Elsewhere: a socket inside a 0700
 * directory in the profile, so only this user can even reach it.
 */
export function agentEndpoint(profileDirectory: string, platform: NodeJS.Platform = process.platform,
  username: string = safeUsername()): string {
  // Same derivation as the shim (scripts/agent-channel-wire.mjs), so both name exactly one pipe per profile.
  if (platform === 'win32') return agentPipeName(username, profileDirectory);
  const socket = path.join(path.resolve(profileDirectory), AGENT_SOCKET_DIRECTORY, AGENT_SOCKET_NAME);
  // sun_path is 104 bytes on macOS and 108 on Linux, including the terminator.
  if (Buffer.byteLength(socket) > 100) throw Error('配置目录路径太长，无法创建本机通道。');
  return socket;
}

function safeUsername(): string {
  try { return os.userInfo().username; } catch { return process.env.USERNAME ?? process.env.USER ?? ''; }
}

/**
 * Only this profile's own endpoint. A token file copied from another profile (stable into
 * development) names the other profile's pipe and is ignored, so the channel is not turned on by it.
 */
export function isValidEndpoint(endpoint: unknown, profileDirectory: string, platform: NodeJS.Platform = process.platform,
  username: string = safeUsername()): endpoint is string {
  if (typeof endpoint !== 'string') return false;
  if (platform === 'win32') return endpoint === agentPipeName(username, profileDirectory);
  return endpoint === path.join(path.resolve(profileDirectory), AGENT_SOCKET_DIRECTORY, AGENT_SOCKET_NAME);
}

/** The file exists only while the channel is on; deleting it revokes the token. */
export class AgentCredentialStore {
  readonly file: string;
  constructor(readonly profileDirectory: string, private readonly platform: NodeJS.Platform = process.platform,
    private readonly username: string = safeUsername()) {
    this.file = path.join(profileDirectory, AGENT_CREDENTIALS_FILE);
  }

  async read(): Promise<AgentCredentials | null> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); } catch { return null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.version !== 1 || value.edition !== AGENT_EDITION || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
      || !isValidEndpoint(value.endpoint, this.profileDirectory, this.platform, this.username)) return null;
    return { version: 1, edition: AGENT_EDITION, endpoint: value.endpoint, token: value.token, createdAt: String(value.createdAt ?? '') };
  }

  /** A fresh random token on every enable and app start, written owner-only. */
  async issue(endpoint: string, now: Date = new Date()): Promise<AgentCredentials> {
    const credentials: AgentCredentials = { version: 1, edition: AGENT_EDITION, endpoint, token: randomBytes(32).toString('hex'), createdAt: now.toISOString() };
    await mkdir(this.profileDirectory, { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
      if (this.platform !== 'win32') await chmod(this.file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return credentials;
  }

  async revoke(): Promise<void> { await rm(this.file, { force: true }); }
}
