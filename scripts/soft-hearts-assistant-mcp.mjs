#!/usr/bin/env node
// soft hearts next · Claude 助手 MCP shim (I-071 v2 第二步).
//
// Claude Code launches this as the only MCP server of an assistant turn (`--mcp-config`, `--strict-mcp-config`). It asks the
// app for the tool list and forwards each tools/call, unchanged, over the agent channel's wire format to the per-turn endpoint
// named in its environment, with the per-turn token the app put there. The app decides everything (which tools exist, tiers,
// popups); this shim never reads a file, starts or signals a process, or touches the network. Without valid credentials it
// lists no tools and every call fails.
//
// Usage (written by the app into the MCP config, never typed by hand):
//   <node or electron with ELECTRON_RUN_AS_NODE=1> soft-hearts-assistant-mcp.mjs
//   env SOFT_HEARTS_ASSISTANT_ENDPOINT, SOFT_HEARTS_ASSISTANT_TOKEN
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FrameReader, WIRE_APP, clientProof, encodeFrame, nonce, proofEquals, serverProof } from './agent-channel-wire.mjs';

export const ASSISTANT_PIPE_PREFIX = '\\\\.\\pipe\\soft-hearts-next-assistant-';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_STDIN_LINE = 1024 * 1024;
const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Endpoint and token from this process's environment, or null when they are missing or malformed. */
export function readAssistantCredentials(env = process.env, platform = process.platform) {
  const endpoint = env.SOFT_HEARTS_ASSISTANT_ENDPOINT, token = env.SOFT_HEARTS_ASSISTANT_TOKEN;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const endpointOk = typeof endpoint === 'string' && (platform === 'win32'
    ? endpoint.startsWith(ASSISTANT_PIPE_PREFIX) && /^[a-f0-9]{24}$/.test(endpoint.slice(ASSISTANT_PIPE_PREFIX.length))
    : api.isAbsolute(endpoint) && api.basename(endpoint) === 'a.sock' && api.basename(api.dirname(endpoint)).startsWith('shn-assistant-'));
  if (!endpointOk || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  return { endpoint, token };
}

/** Only well-formed tool descriptors from the app pass through. */
export function validTools(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(tool => tool && typeof tool === 'object' && typeof tool.name === 'string' && NAME.test(tool.name)
    && typeof tool.description === 'string' && tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema.type === 'object')
    .slice(0, 128);
}

/** One authenticated connection; requests strictly one at a time. */
export class AssistantConnection {
  constructor({ credentials, connect = endpoint => net.createConnection(endpoint), handshakeTimeoutMs = 5000, requestTimeoutMs = 5 * 60_000 } = {}) {
    this.credentials = credentials; this.connect = connect;
    this.handshakeTimeoutMs = handshakeTimeoutMs; this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null; this.ready = null; this.pending = null; this.nextId = 1; this.chain = Promise.resolve();
  }

  request(frame) {
    const run = () => this.send(frame);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async send(frame) {
    if (!this.credentials) throw new Error('助手通道没有配置。');
    await this.open();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(new Error('soft hearts 没有及时回应。')); this.reset(); }, this.requestTimeoutMs);
      this.pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      try { this.socket.write(encodeFrame({ ...frame, id })); }
      catch { this.pending = null; clearTimeout(timer); reject(new Error('请求太大。')); }
    });
  }

  open() {
    if (this.ready) return this.ready;
    const { endpoint, token } = this.credentials;
    this.ready = new Promise((resolve, reject) => {
      const socket = this.connect(endpoint);
      const clientNonce = nonce();
      let serverNonce = null, settled = false;
      const fail = error => { if (settled) return; settled = true; clearTimeout(timer); this.reset(); reject(error); };
      const timer = setTimeout(() => fail(new Error('soft hearts 没有回应助手通道的握手。')), this.handshakeTimeoutMs);
      const reader = new FrameReader(frame => {
        if (!settled) {
          if (frame.t === 'hello' && frame.app === WIRE_APP && typeof frame.nonce === 'string' && serverNonce === null) {
            serverNonce = frame.nonce;
            socket.write(encodeFrame({ t: 'auth', nonce: clientNonce, proof: clientProof(token, serverNonce, clientNonce) }));
          } else if (frame.t === 'ready' && serverNonce && proofEquals(serverProof(token, clientNonce, serverNonce), frame.proof)) {
            settled = true; clearTimeout(timer); resolve();
          } else fail(new Error('助手通道认证失败（这一轮可能已经结束）。'));
          return;
        }
        if (frame.t === 'result' && this.pending && frame.id === this.pending.id) {
          const pending = this.pending; this.pending = null; pending.resolve(frame);
        }
      }, () => fail(new Error('助手通道数据不正确。')));
      socket.on('data', chunk => reader.push(chunk));
      socket.on('error', () => fail(new Error('连不上 soft hearts 的助手通道（这一轮可能已经结束）。')));
      socket.on('close', () => {
        if (!settled) fail(new Error('soft hearts 关闭了助手通道。'));
        if (this.socket === socket) this.reset();
      });
      this.socket = socket;
    });
    return this.ready;
  }

  reset() {
    const socket = this.socket, pending = this.pending;
    this.socket = null; this.ready = null; this.pending = null;
    if (pending) pending.reject(new Error('助手通道断开了；这次操作是否生效不确定。'));
    try { socket?.destroy(); } catch { /* Already closed. */ }
  }

  close() { this.reset(); }
}

export function createAssistantMcpServer({ connection, respond }) {
  const reply = (id, result) => respond({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => respond({ jsonrpc: '2.0', id, error: { code, message } });
  const text = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
  let known = new Set();
  return {
    async handle(message) {
      if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        if (message && typeof message === 'object' && 'id' in message && !('method' in message)) return;
        error(message?.id ?? null, -32600, 'Invalid Request');
        return;
      }
      const { id, method, params } = message;
      if (id === undefined) return;
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          reply(id, { protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'soft-hearts-assistant', title: 'soft hearts', version: '0.1.0' },
            instructions: '这些工具操作用户本机的 soft hearts。需要确认的操作由 soft hearts 弹窗，用户点“允许”才执行；不要替用户确认。' });
          return;
        }
        case 'ping': reply(id, {}); return;
        case 'tools/list': {
          let tools = [];
          try { const frame = await connection.request({ t: 'list' }); tools = frame.ok ? validTools(frame.result?.tools) : []; } catch { tools = []; }
          known = new Set(tools.map(tool => tool.name));
          reply(id, { tools });
          return;
        }
        case 'tools/call': {
          const name = params?.name, args = params?.arguments ?? {};
          if (typeof name !== 'string' || !known.has(name)) { error(id, -32602, `Unknown tool: ${String(name).slice(0, 64)}`); return; }
          try {
            const frame = await connection.request({ t: 'call', tool: name, args });
            if (frame.ok) reply(id, { content: text(frame.result ?? null) });
            else reply(id, { content: text(`[${frame.error?.code ?? 'failed'}] ${frame.error?.message ?? '操作失败。'}`), isError: true });
          } catch (failure) {
            reply(id, { content: text(`[unavailable] ${failure?.message ?? '无法连接 soft hearts。'}`), isError: true });
          }
          return;
        }
        default: error(id, -32601, `Method not found: ${method.slice(0, 64)}`);
      }
    },
  };
}

export function runStdio({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const connection = new AssistantConnection({ credentials: readAssistantCredentials(env) });
  const server = createAssistantMcpServer({ connection, respond: value => stdout.write(JSON.stringify(value) + '\n') });
  let buffer = '', work = Promise.resolve();
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_STDIN_LINE && !buffer.includes('\n')) { buffer = ''; return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      const handled = server.handle(message);
      work = work.then(() => handled).catch(() => {});
    }
  });
  stdin.on('end', () => { void work.finally(() => connection.close()); });
  return { connection, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runStdio();
