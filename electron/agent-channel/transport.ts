import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { FrameReader, MAX_FRAME_BYTES, WIRE_APP, WIRE_VERSION, clientProof, encodeFrame, nonce, proofEquals, serverProof } from '../../scripts/agent-channel-wire.mjs';
import type { AgentCallResult } from './registry';

export interface AgentServerHandlers {
  /** Current token, or null when the channel is off (every login then fails). */
  token(): string | null;
  list(): unknown;
  call(tool: unknown, args: unknown): Promise<AgentCallResult>;
  authFailed?(): void;
  connections?(count: number): void;
}

export interface AgentServerLimits {
  maxConnections: number;
  /** Requests per connection per rolling minute. */
  ratePerMinute: number;
  authTimeoutMs: number;
  idleTimeoutMs: number;
  maxFrameBytes: number;
}
export const DEFAULT_AGENT_LIMITS: Readonly<AgentServerLimits> = Object.freeze({
  maxConnections: 4, ratePerMinute: 60, authTimeoutMs: 5_000, idleTimeoutMs: 30 * 60_000, maxFrameBytes: MAX_FRAME_BYTES,
});

const REQUEST_ID = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && value.length <= 64);

/** Owner-only directory for the Unix socket; refuses links and foreign owners. */
async function prepareSocketPath(endpoint: string): Promise<void> {
  const directory = path.dirname(endpoint);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('本机通道目录不正确。');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw Error('本机通道目录不属于当前用户。');
  await chmod(directory, 0o700);
  const existing = await lstat(endpoint).catch(() => null);
  if (existing && !existing.isSocket()) throw Error('本机通道路径被其他文件占用。');
  // The single-instance lock guarantees a leftover socket belongs to a previous run of this profile.
  if (existing) await rm(endpoint, { force: true });
}

/** Local-only JSON line server: authenticate, then one request at a time, rate limited. */
export class AgentChannelServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private authenticated = 0;
  private readonly limits: AgentServerLimits;
  constructor(readonly endpoint: string, private readonly handlers: AgentServerHandlers,
    limits: Partial<AgentServerLimits> = {}, private readonly platform: NodeJS.Platform = process.platform) {
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...limits };
  }

  get listening(): boolean { return !!this.server?.listening; }
  get connections(): number { return this.authenticated; }

  async start(): Promise<void> {
    if (this.server) return;
    if (this.platform !== 'win32') await prepareSocketPath(this.endpoint);
    const server = net.createServer(socket => this.accept(socket));
    server.maxConnections = this.limits.maxConnections;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // readableAll/writableAll stay false: no access is widened beyond the creating user.
      server.listen({ path: this.endpoint, readableAll: false, writableAll: false }, () => { server.off('error', reject); resolve(); });
    });
    server.on('error', () => { /* Accept errors close single sockets only. */ });
    this.server = server;
    if (this.platform !== 'win32') await chmod(this.endpoint, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.setAuthenticated(0);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (this.platform !== 'win32') await rm(this.endpoint, { force: true }).catch(() => {});
  }

  private setAuthenticated(count: number): void {
    if (this.authenticated === count) return;
    this.authenticated = count;
    try { this.handlers.connections?.(count); } catch { /* Status only. */ }
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    const serverNonce = nonce();
    let state: 'auth' | 'ready' | 'closed' = 'auth';
    let busy = false;
    const recent: number[] = [];
    const send = (value: unknown) => { if (state !== 'closed' && !socket.destroyed) socket.write(encodeFrame(value)); };
    const close = (frame?: unknown) => {
      if (state === 'closed') return;
      if (frame) send(frame);
      if (state === 'ready') this.setAuthenticated(Math.max(0, this.authenticated - 1));
      state = 'closed';
      socket.end();
      setTimeout(() => socket.destroy(), 200).unref?.();
    };
    const authTimer = setTimeout(() => close({ t: 'error', code: 'auth_timeout' }), this.limits.authTimeoutMs);
    authTimer.unref?.();
    socket.setTimeout(this.limits.idleTimeoutMs, () => close({ t: 'error', code: 'idle' }));
    socket.on('close', () => { clearTimeout(authTimer); this.sockets.delete(socket); if (state === 'ready') this.setAuthenticated(Math.max(0, this.authenticated - 1)); state = 'closed'; });
    socket.on('error', () => socket.destroy());

    const reader = new FrameReader(frame => {
      if (state === 'auth') {
        clearTimeout(authTimer);
        const token = this.handlers.token();
        const clientNonce = frame.nonce;
        if (frame.t !== 'auth' || typeof clientNonce !== 'string' || clientNonce.length < 16 || clientNonce.length > 128 || !token
          || !proofEquals(clientProof(token, serverNonce, clientNonce), frame.proof)) {
          try { this.handlers.authFailed?.(); } catch { /* Audit only. */ }
          close({ t: 'error', code: 'auth_failed' });
          return;
        }
        state = 'ready';
        this.setAuthenticated(this.authenticated + 1);
        send({ t: 'ready', proof: serverProof(token, clientNonce, serverNonce) });
        return;
      }
      if (state !== 'ready') return;
      const id = frame.id;
      if (!REQUEST_ID(id) || (frame.t !== 'list' && frame.t !== 'call')) { close({ t: 'error', code: 'malformed' }); return; }
      if (busy) { send({ t: 'result', id, ok: false, error: { code: 'busy', message: '上一个请求还没完成。' } }); return; }
      const now = Date.now();
      while (recent.length && now - recent[0] > 60_000) recent.shift();
      if (recent.length >= this.limits.ratePerMinute) { send({ t: 'result', id, ok: false, error: { code: 'rate_limited', message: '请求太频繁，请稍后再试。' } }); return; }
      recent.push(now);
      if (frame.t === 'list') { send({ t: 'result', id, ok: true, result: this.handlers.list() }); return; }
      busy = true;
      void this.handlers.call(frame.tool, frame.args).catch((): AgentCallResult => ({ ok: false, error: { code: 'failed', message: '操作失败。' } }))
        .then(result => {
          busy = false;
          try { send({ t: 'result', id, ...result }); }
          catch { send({ t: 'result', id, ok: false, error: { code: 'too_large', message: '结果太大，未返回。' } }); }
        });
    }, reason => close({ t: 'error', code: reason }), this.limits.maxFrameBytes);
    socket.on('data', chunk => reader.push(chunk));
    send({ t: 'hello', v: WIRE_VERSION, app: WIRE_APP, nonce: serverNonce });
  }
}
