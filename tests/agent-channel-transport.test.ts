import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { INTERCONNECT_FILE } from '../electron/agent-channel/interconnect';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentChannelHost } from '../electron/agent-channel/host';
import { AgentChannelServer } from '../electron/agent-channel/transport';
import { AGENT_CREDENTIALS_FILE, agentEndpoint } from '../electron/agent-channel/credentials';
import { argsObject, noArgs } from '../electron/agent-channel/validate';
import type { AgentConfirmRequest, AgentToolDefinition } from '../electron/agent-channel/registry';
import type { AgentChannelNotice, AgentChannelView } from '../shared/agent-channel';
import { FrameReader, clientProof, encodeFrame, nonce, serverProof } from '../scripts/agent-channel-wire.mjs';
import { AppConnection, createMcpServer, readCredentials } from '../scripts/soft-hearts-mcp.mjs';

const posix = process.platform !== 'win32';
const shimPath = fileURLToPath(new URL('../scripts/soft-hearts-mcp.mjs', import.meta.url));

async function profile(t: test.TestContext): Promise<string> {
  // Short base: a Unix socket path must stay under ~100 bytes.
  const directory = await mkdtemp(path.join(posix ? '/tmp' : tmpdir(), 'sh-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeTools(log: string[]): AgentToolDefinition[] {
  return [
    { name: 'get_status', title: '读取状态', tier: 'read', validate: noArgs, run: () => { log.push('get_status'); return { app: 'fake', apiKey: 'sk-never' }; } },
    { name: 'show_pet', title: '显示桌宠', tier: 'reversible', validate: noArgs, run: () => { log.push('show_pet'); return { shown: true }; } },
    { name: 'voice_preview', title: '试听语音', tier: 'confirm', validate: noArgs, confirmation: () => ({ title: '试听？', detail: '会付费' }),
      run: () => { log.push('voice_preview'); return { requested: true }; } },
    { name: 'slow', title: '慢', tier: 'read', validate: raw => argsObject(raw, ['ms']),
      run: (input: { ms?: number }) => new Promise(resolve => setTimeout(() => resolve({ slept: input.ms }), Number(input.ms) || 0)) },
  ];
}

/**
 * I-014: the tests below pin the opt-in channel as it is with 三方互通 off (the user's remembered choice); the default
 * (on) has its own tests in tests/three-way-interconnect.test.ts. `interconnect: 'default'` leaves the profile untouched.
 */
function hostFixture(directory: string, options: { allow?: boolean | 'never'; limits?: Record<string, number>; interconnect?: 'off' | 'default' } = {}) {
  const log: string[] = [], views: AgentChannelView[] = [], notices: AgentChannelNotice[] = [], asked: AgentConfirmRequest[] = [];
  if ((options.interconnect ?? 'off') === 'off') writeFileSync(path.join(directory, INTERCONNECT_FILE), JSON.stringify({ version: 1, chosen: true, enabled: false, autoRegistered: [] }));
  const host = new AgentChannelHost({
    profileDirectory: directory, tools: fakeTools(log),
    confirm: async request => { asked.push(request); if (options.allow === 'never') return new Promise<boolean>(() => {}); return options.allow ?? false; },
    publishView: view => views.push(view), publishNotice: notice => notices.push(notice),
    setup: () => ({ claudeCode: 'claude mcp add …', desktopConfig: '{}' }),
    confirmTimeoutMs: 80, limits: options.limits, // Real user name: the shim derives the same pipe from it.
  });
  return { host, log, views, notices, asked };
}

/** A raw client that speaks the wire format, for checks the shim would never do. */
function rawClient(endpoint: string) {
  const socket = net.createConnection(endpoint);
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  const reader = new FrameReader(frame => { frames.push(frame); waiters.splice(0).forEach(wake => wake()); }, () => {});
  socket.on('data', chunk => reader.push(chunk));
  socket.on('close', () => { closed = true; waiters.splice(0).forEach(wake => wake()); });
  socket.on('error', () => {});
  const next = async (count: number) => {
    while (frames.length < count && !closed) await new Promise<void>(resolve => waiters.push(resolve));
    return frames[count - 1];
  };
  return { socket, frames, next, isClosed: () => closed, write: (value: string) => socket.write(value) };
}

test('with 三方互通 off, the channel is off by default: no token file, nothing listening, and the shim says how to turn it on', async t => {
  const directory = await profile(t);
  const f = hostFixture(directory);
  const view = await f.host.init();
  assert.deepEqual({ enabled: view.enabled, listening: view.listening, connections: view.connections }, { enabled: false, listening: false, connections: 0 });
  assert.equal(view.setup, undefined);
  await assert.rejects(stat(path.join(directory, AGENT_CREDENTIALS_FILE)));
  assert.throws(() => readCredentials(directory), (error: any) => error.code === 'channel_off' && /允许 Claude 通过内部通道操作/.test(error.message));
  const refused = await f.host.registry.call('get_status', {});
  assert.equal(!refused.ok && refused.error.code, 'channel_off');
  assert.deepEqual(f.log, []);
  await assert.rejects(f.host.setEnabled('yes' as any));
  await f.host.dispose();
});

test('socket round trip: enable, authenticate, list, call each tier through the real shim connection, then disable', async t => {
  const directory = await profile(t);
  const f = hostFixture(directory, { allow: true });
  t.after(() => f.host.dispose());
  const view = await f.host.setEnabled(true);
  assert.equal(view.enabled, true); assert.equal(view.listening, true); assert.ok(view.setup);
  const credentials = JSON.parse(await readFile(path.join(directory, AGENT_CREDENTIALS_FILE), 'utf8'));
  assert.match(credentials.token, /^[a-f0-9]{64}$/);
  if (posix) {
    assert.equal((await stat(path.join(directory, AGENT_CREDENTIALS_FILE))).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(credentials.endpoint))).mode & 0o777, 0o700);
    assert.equal((await stat(credentials.endpoint)).mode & 0o777, 0o600);
  } else assert.match(credentials.endpoint, /^\\\\\.\\pipe\\soft-hearts-next-agent-[a-f0-9]{12}$/);

  const connection = new AppConnection({ profileDirectory: directory });
  t.after(() => connection.close());
  const listed = await connection.request({ t: 'list' });
  // The host adds its own two (I-014): undo_last_action and set_interconnect.
  assert.deepEqual(listed.result.tools.map((item: { name: string }) => item.name), ['get_status', 'show_pet', 'undo_last_action', 'voice_preview', 'set_interconnect'],
    'the host lists catalog descriptors for its exposed tools only');
  const status = await connection.request({ t: 'call', tool: 'get_status', args: {} });
  assert.deepEqual(status.result, { app: 'fake' }, 'secret-named fields never cross the wire');
  const shown = await connection.request({ t: 'call', tool: 'show_pet', args: {} });
  assert.equal(shown.ok, true);
  assert.deepEqual(f.notices.map(notice => notice.title), ['显示桌宠']);
  const confirmed = await connection.request({ t: 'call', tool: 'voice_preview', args: {} });
  assert.equal(confirmed.ok, true); assert.equal(f.asked[0].detail, '会付费');
  const unknown = await connection.request({ t: 'call', tool: 'delete_memories', args: {} });
  assert.equal(unknown.error?.code, 'unknown_tool');
  assert.deepEqual(f.log, ['get_status', 'show_pet', 'voice_preview']);
  assert.equal(f.host.view().connections, 1);
  assert.equal(f.host.view().lastAction?.tool, 'voice_preview');

  const audit = await f.host.audit.flush().then(() => readFile(f.host.audit.file, 'utf8'));
  assert.equal(audit.trim().split('\n').length, 4);
  assert.ok(!audit.includes(credentials.token) && !audit.includes('sk-never') && !audit.includes('delete_memories'));

  const off = await f.host.setEnabled(false);
  assert.equal(off.enabled, false); assert.equal(off.listening, false);
  await assert.rejects(stat(path.join(directory, AGENT_CREDENTIALS_FILE)), 'turning it off deletes the token');
  await assert.rejects(connection.request({ t: 'call', tool: 'get_status', args: {} }), (error: any) => error.code === 'channel_off');
  assert.deepEqual(f.log, ['get_status', 'show_pet', 'voice_preview']);
});

test('the token is required: wrong proofs, skipped auth and a stale token are refused before any tool runs', async t => {
  const directory = await profile(t);
  const f = hostFixture(directory);
  t.after(() => f.host.dispose());
  await f.host.setEnabled(true);
  const { endpoint, token } = JSON.parse(await readFile(path.join(directory, AGENT_CREDENTIALS_FILE), 'utf8'));
  const wrong = rawClient(endpoint);
  const hello = await wrong.next(1) as { t: string; app: string; nonce: string };
  assert.equal(hello.t, 'hello'); assert.equal(hello.app, 'soft-hearts-next');
  const clientNonce = nonce();
  wrong.write(encodeFrame({ t: 'auth', nonce: clientNonce, proof: clientProof('0'.repeat(64), hello.nonce, clientNonce) }));
  assert.deepEqual(await wrong.next(2), { t: 'error', code: 'auth_failed' });
  const skipped = rawClient(endpoint);
  await skipped.next(1);
  skipped.write(encodeFrame({ t: 'call', id: 1, tool: 'get_status', args: {} }));
  assert.deepEqual(await skipped.next(2), { t: 'error', code: 'auth_failed' });
  // A token from before a restart (or a re-enable) no longer works.
  await f.host.setEnabled(false); await f.host.setEnabled(true);
  const stale = rawClient(JSON.parse(await readFile(path.join(directory, AGENT_CREDENTIALS_FILE), 'utf8')).endpoint);
  const staleHello = await stale.next(1) as { nonce: string };
  stale.write(encodeFrame({ t: 'auth', nonce: clientNonce, proof: clientProof(token, staleHello.nonce, clientNonce) }));
  assert.deepEqual(await stale.next(2), { t: 'error', code: 'auth_failed' });
  assert.deepEqual(f.log, []);
  for (const client of [wrong, skipped, stale]) client.socket.destroy();
  await f.host.audit.flush();
  assert.equal((await readFile(f.host.audit.file, 'utf8')).match(/"auth_failed"/g)?.length, 3);
});

test('the shim refuses a server that cannot prove the token, before sending any request', async t => {
  const directory = await profile(t);
  // A process squatting on this profile's own pipe/socket name (the shim only connects to that one).
  const endpoint = agentEndpoint(directory);
  const requests: unknown[] = [];
  const impostor = new AgentChannelServer(endpoint, { token: () => 'f'.repeat(64), list: () => { requests.push('list'); return {}; },
    call: async () => { requests.push('call'); return { ok: true, result: null }; } });
  await impostor.start();
  t.after(() => impostor.stop());
  await writeFile(path.join(directory, AGENT_CREDENTIALS_FILE), JSON.stringify({ version: 1, edition: 'soft-hearts-next', endpoint, token: 'a'.repeat(64) }));
  const connection = new AppConnection({ profileDirectory: directory, handshakeTimeoutMs: 1000 });
  t.after(() => connection.close());
  await assert.rejects(connection.request({ t: 'list' }), (error: any) => ['auth_failed', 'unavailable'].includes(error.code));
  assert.deepEqual(requests, []);
});

test('limits: one request at a time per connection, a per-minute rate limit, and oversized frames close the connection', async t => {
  const directory = await profile(t);
  const f = hostFixture(directory, { limits: { ratePerMinute: 2 } });
  t.after(() => f.host.dispose());
  await f.host.setEnabled(true);
  const { endpoint, token } = JSON.parse(await readFile(path.join(directory, AGENT_CREDENTIALS_FILE), 'utf8'));
  const client = rawClient(endpoint);
  const hello = await client.next(1) as { nonce: string };
  const clientNonce = nonce();
  client.write(encodeFrame({ t: 'auth', nonce: clientNonce, proof: clientProof(token, hello.nonce, clientNonce) }));
  const ready = await client.next(2) as { t: string; proof: string };
  assert.equal(ready.t, 'ready'); assert.equal(ready.proof, serverProof(token, clientNonce, hello.nonce));
  client.write(encodeFrame({ t: 'call', id: 1, tool: 'slow', args: { ms: 150 } }) + encodeFrame({ t: 'call', id: 2, tool: 'get_status', args: {} }));
  const busy = await client.next(3) as any;
  assert.equal(busy.id, 2); assert.equal(busy.error.code, 'busy');
  assert.equal(((await client.next(4)) as any).id, 1);
  client.write(encodeFrame({ t: 'list', id: 3 }));
  assert.equal(((await client.next(5)) as any).ok, true, 'a refused busy request does not count against the rate');
  client.write(encodeFrame({ t: 'list', id: 4 }));
  const limited = await client.next(6) as any;
  assert.equal(limited.id, 4); assert.equal(limited.error.code, 'rate_limited');
  client.write('{"t":"call","id":5,"tool":"get_status","args":{"x":"' + 'x'.repeat(70 * 1024));
  assert.deepEqual(await client.next(7), { t: 'error', code: 'too_large' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(client.isClosed(), true);
});

test('a confirm request that nobody answers is denied after the timeout', async t => {
  const directory = await profile(t);
  const f = hostFixture(directory, { allow: 'never' });
  t.after(() => f.host.dispose());
  await f.host.setEnabled(true);
  const connection = new AppConnection({ profileDirectory: directory });
  t.after(() => connection.close());
  const result = await connection.request({ t: 'call', tool: 'voice_preview', args: {} });
  assert.equal(result.error?.code, 'confirm_timeout');
  assert.deepEqual(f.log, []);
});

test('MCP JSON-RPC: handshake, catalog listing, argument errors and forwarded results', async () => {
  const responses: any[] = [], frames: unknown[] = [];
  const server = createMcpServer({
    catalog: { server: { name: 'soft-hearts-next', title: 'x' }, tools: [
      { name: 'get_status', title: '读取状态', tier: 'read', description: 'd', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'voice_preview', title: '试听', tier: 'confirm', description: 'd', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] },
    connection: { request: async (frame: any) => { frames.push(frame); return frame.tool === 'get_status' ? { ok: true, result: { a: 1 } } : { ok: false, error: { code: 'denied_by_user', message: '用户拒绝了这个请求。' } }; } },
    respond: value => responses.push(value),
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(responses[0].result.capabilities, { tools: { listChanged: false } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(responses.length, 1, 'notifications get no response');
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(responses[1].result.tools.map((item: any) => [item.name, item.annotations.readOnlyHint]), [['get_status', true], ['voice_preview', false]]);
  assert.match(responses[1].result.tools[1].description, /允许/);
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
  assert.deepEqual(JSON.parse(responses[2].result.content[0].text), { a: 1 });
  await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'voice_preview' } });
  assert.equal(responses[3].result.isError, true); assert.match(responses[3].result.content[0].text, /denied_by_user/);
  await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_shell', arguments: { cmd: 'rm -rf /' } } });
  assert.equal(responses[4].error.code, -32602);
  await server.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(responses[5].error.code, -32601);
  await server.handle({ id: 7, method: 'tools/list' });
  assert.equal(responses[6].error.code, -32600);
  assert.equal(frames.length, 2, 'unknown tools are never forwarded to the app');
});

function runShim(t: test.TestContext, directory: string) {
  const child = spawn(process.execPath, [shimPath, '--profile', directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines: any[] = [], waiters: Array<() => void> = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    waiters.splice(0).forEach(wake => wake());
  });
  const send = async (message: unknown) => {
    const before = lines.length;
    child.stdin.write(JSON.stringify(message) + '\n');
    while (lines.length === before) await new Promise<void>(resolve => waiters.push(resolve));
    return lines[lines.length - 1];
  };
  return { child, send };
}

test('the stdio shim end to end: clear errors when the channel is off or the app is not running, real calls when it is on', async t => {
  const directory = await profile(t);
  const shim = runShim(t, directory);
  const init = await shim.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  assert.equal(init.result.serverInfo.name, 'soft-hearts-next');
  const listed = await shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(listed.result.tools.some((item: any) => item.name === 'get_status'));
  const off = await shim.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
  assert.equal(off.result.isError, true); assert.match(off.result.content[0].text, /channel_off.*允许 Claude 通过内部通道操作/s);

  const f = hostFixture(directory);
  t.after(() => f.host.dispose());
  await f.host.setEnabled(true);
  const on = await shim.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
  assert.equal(on.result.isError, undefined); assert.deepEqual(JSON.parse(on.result.content[0].text), { app: 'fake' });

  await f.host.dispose(); // App quits: the token file stays (the user's choice), but nothing listens.
  const gone = await shim.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
  assert.equal(gone.result.isError, true); assert.match(gone.result.content[0].text, /没有运行|关闭|退出/);
  shim.child.stdin.end();
  const code = await new Promise(resolve => shim.child.once('exit', resolve));
  assert.equal(code, 0, 'the shim exits on its own when the client closes stdin; it never starts or stops the app');
});
