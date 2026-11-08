#!/usr/bin/env node
// soft hearts next · task-permission MCP shim (R20).
//
// Claude Code launches this as the only MCP server of a task process (`--mcp-config`,
// `--strict-mcp-config`) and calls its single tool through `--permission-prompt-tool`
// whenever a tool use needs approval. The shim forwards the request, unchanged, to the
// app over the agent channel's wire format on a per-run endpoint, using the per-run token
// the app put in this process's environment. It fails closed: anything other than a
// well-formed decision from the app becomes a deny.
//
// Usage (written by the app into the MCP config, never typed by hand):
//   <node or electron with ELECTRON_RUN_AS_NODE=1> soft-hearts-task-mcp.mjs
//   env SOFT_HEARTS_TASK_ENDPOINT, SOFT_HEARTS_TASK_TOKEN
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FrameReader, WIRE_APP, clientProof, encodeFrame, nonce, proofEquals, serverProof } from './agent-channel-wire.mjs';

export const TASK_PIPE_PREFIX = '\\\\.\\pipe\\soft-hearts-next-task-';
export const TOOL_NAME = 'approve';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_STDIN_LINE = 4 * 1024 * 1024;

export const TOOL = {
  name: TOOL_NAME,
  description: 'soft hearts 的审批工具，只由 Claude Code 的权限检查调用。',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
};

export function deny(message) { return { behavior: 'deny', message }; }

/** Endpoint and token from this process's environment, or null when they are missing or malformed. */
export function readTaskCredentials(env = process.env, platform = process.platform) {
  const endpoint = env.SOFT_HEARTS_TASK_ENDPOINT, token = env.SOFT_HEARTS_TASK_TOKEN;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const endpointOk = typeof endpoint === 'string' && (platform === 'win32'
    ? endpoint.startsWith(TASK_PIPE_PREFIX) && /^[a-f0-9]{24}$/.test(endpoint.slice(TASK_PIPE_PREFIX.length))
    : api.isAbsolute(endpoint) && api.basename(endpoint) === 'p.sock' && api.basename(api.dirname(endpoint)).startsWith('shn-task-'));
  if (!endpointOk || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  return { endpoint, token };
}

/** Only `{behavior:'allow', updatedInput:{...}}` or `{behavior:'deny', message}` pass through. */
export function validDecision(value) {
  if (value?.behavior === 'allow' && value.updatedInput && typeof value.updatedInput === 'object' && !Array.isArray(value.updatedInput))
    return { behavior: 'allow', updatedInput: value.updatedInput };
  if (value?.behavior === 'deny' && typeof value.message === 'string')
    return { behavior: 'deny', message: value.message.slice(0, 2000), ...(value.interrupt === true ? { interrupt: true } : {}) };
  return null;
}

/** One authenticated connection to the app; approvals are sent strictly one at a time. */
export class TaskConnection {
  constructor({ credentials, connect = endpoint => net.createConnection(endpoint), handshakeTimeoutMs = 5000, requestTimeoutMs = 5 * 60_000 } = {}) {
    this.credentials = credentials; this.connect = connect;
    this.handshakeTimeoutMs = handshakeTimeoutMs; this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null; this.ready = null; this.pending = null; this.nextId = 1; this.chain = Promise.resolve();
  }

  /** Resolves with a valid decision; never rejects. */
  approve(args) {
    const run = () => this.send(args).catch(error => deny(error?.message || '无法联系 soft hearts，已拒绝。'));
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async send(args) {
    if (!this.credentials) return deny('审批通道没有配置，已拒绝。');
    await this.open();
    const id = this.nextId++;
    const frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = null; reject(new Error('soft hearts 没有及时回应，已拒绝。')); this.reset(); }, this.requestTimeoutMs);
      this.pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      try { this.socket.write(encodeFrame({ t: 'call', id, tool: TOOL_NAME, args })); }
      catch { this.pending = null; clearTimeout(timer); reject(new Error('审批请求太大，已拒绝。')); }
    });
    if (!frame.ok) return deny(`soft hearts 拒绝了这次请求：${String(frame.error?.message ?? '未知原因').slice(0, 200)}`);
    return validDecision(frame.result) ?? deny('soft hearts 返回的审批结果无效，已拒绝。');
  }

  open() {
    if (this.ready) return this.ready;
    const { endpoint, token } = this.credentials;
    this.ready = new Promise((resolve, reject) => {
      const socket = this.connect(endpoint);
      const clientNonce = nonce();
      let serverNonce = null, settled = false;
      const fail = error => { if (settled) return; settled = true; clearTimeout(timer); this.reset(); reject(error); };
      const timer = setTimeout(() => fail(new Error('soft hearts 没有回应审批通道的握手，已拒绝。')), this.handshakeTimeoutMs);
      const reader = new FrameReader(frame => {
        if (!settled) {
          if (frame.t === 'hello' && frame.app === WIRE_APP && typeof frame.nonce === 'string' && serverNonce === null) {
            serverNonce = frame.nonce;
            socket.write(encodeFrame({ t: 'auth', nonce: clientNonce, proof: clientProof(token, serverNonce, clientNonce) }));
          } else if (frame.t === 'ready' && serverNonce && proofEquals(serverProof(token, clientNonce, serverNonce), frame.proof)) {
            settled = true; clearTimeout(timer); resolve();
          } else fail(new Error('审批通道认证失败，已拒绝。'));
          return;
        }
        if (frame.t === 'result' && this.pending && frame.id === this.pending.id) {
          const pending = this.pending; this.pending = null; pending.resolve(frame);
        }
      }, () => fail(new Error('审批通道数据不正确，已拒绝。')));
      socket.on('data', chunk => reader.push(chunk));
      socket.on('error', () => fail(new Error('无法连接 soft hearts 的审批通道，已拒绝。')));
      socket.on('close', () => {
        if (!settled) fail(new Error('soft hearts 关闭了审批通道，已拒绝。'));
        if (this.socket === socket) this.reset();
      });
      this.socket = socket;
    });
    return this.ready;
  }

  reset() {
    const socket = this.socket, pending = this.pending;
    this.socket = null; this.ready = null; this.pending = null;
    if (pending) pending.reject(new Error('审批通道断开了，已拒绝。'));
    try { socket?.destroy(); } catch { /* Already closed. */ }
  }

  close() { this.reset(); }
}

/** JSON-RPC handler with exactly one tool. */
export function createTaskMcpServer({ connection, respond }) {
  const reply = (id, result) => respond({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => respond({ jsonrpc: '2.0', id, error: { code, message } });
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
        case 'initialize':
          reply(id, { protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'soft-hearts-task', title: 'soft hearts 任务审批', version: '0.1.0' } });
          return;
        case 'ping': reply(id, {}); return;
        case 'tools/list': reply(id, { tools: [TOOL] }); return;
        case 'tools/call': {
          if (params?.name !== TOOL_NAME) { error(id, -32602, `Unknown tool: ${String(params?.name).slice(0, 64)}`); return; }
          const decision = await connection.approve(params?.arguments ?? {});
          reply(id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
          return;
        }
        default: error(id, -32601, `Method not found: ${method.slice(0, 64)}`);
      }
    },
  };
}

export function runStdio({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const connection = new TaskConnection({ credentials: readTaskCredentials(env) });
  const server = createTaskMcpServer({ connection, respond: value => stdout.write(JSON.stringify(value) + '\n') });
  let buffer = '';
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
      // Approvals queue inside the connection; other messages are answered right away.
      void server.handle(message).catch(() => {});
    }
  });
  stdin.on('end', () => connection.close());
  return { connection, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runStdio();
