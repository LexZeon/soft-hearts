import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexTaskEvent } from '../shared/codex-tasks';
import { claudeEnvironment } from '../electron/claude';
import { ClaudeTaskService, TASK_NO_FOLDER, TASK_OFF, recapPrompt } from '../electron/claude-tasks/service';
import { ClaudeTaskSwitch, registerClaudeTaskIpc } from '../electron/claude-tasks/ipc';
import { openTaskPermissionEndpoint } from '../electron/claude-tasks/permission-server';
import { TASK_SYSTEM_PROMPT } from '../electron/claude-tasks/process';
import { createTaskMcpServer, readTaskCredentials, TaskConnection, validDecision } from '../scripts/soft-hearts-task-mcp.mjs';
import { FrameReader, encodeFrame } from '../scripts/agent-channel-wire.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-claude-task.mjs');
const SHIM = path.join(here, '..', 'scripts', 'soft-hearts-task-mcp.mjs');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Waits for a real condition (a task done, a process gone). 20 s: under a full parallel suite starting a task process took over 8 s. */
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(10); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface Steps { init?: Record<string, unknown>; preInit?: unknown[]; steps: unknown[]; result?: string; lateOnTerm?: boolean }

async function harness(options: { enabled?: boolean; folder?: boolean; approvalTimeoutMs?: number; surface?: () => boolean } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'r20-task-')));
  const folder = path.join(root, 'work'), outside = path.join(root, 'outside');
  await mkdir(folder); await mkdir(outside);
  await writeFile(path.join(folder, 'inside.txt'), 'one\ntwo\n');
  const record = path.join(root, 'record.json'), script = path.join(root, 'script.json'), decisions = path.join(root, 'decisions.jsonl');
  const events: CodexTaskEvent[] = [];
  const state = { enabled: options.enabled ?? true, folder: options.folder === false ? '' : folder };
  const service = new ClaudeTaskService({
    emit: event => events.push(event),
    state: () => state,
    shim: { command: process.execPath, args: [SHIM] },
    findBinary: async () => process.execPath,
    binaryArgs: [FAKE],
    environment: () => ({ ...claudeEnvironment(), FAKE_SCRIPT: script, FAKE_RECORD: record, FAKE_DECISIONS: decisions }),
    approvalTimeoutMs: options.approvalTimeoutMs ?? 5_000,
    surface: options.surface,
  });
  return {
    root, folder, outside, record, events, state, service,
    async script(value: Steps) { await writeFile(script, JSON.stringify(value)); },
    async decisions() { return existsSync(decisions) ? (await readFile(decisions, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; },
    async recorded() { return JSON.parse(await readFile(record, 'utf8')); },
    approvals() { return events.filter((event): event is Extract<CodexTaskEvent, { type: 'approval' }> => event.type === 'approval'); },
    done() { return events.filter(event => event.type === 'done'); },
    // Windows can hold the folder for a moment after the process exits, so removal retries briefly.
    async cleanup() { await service.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); },
  };
}

test('off by default: the switch starts off, nothing runs, and capabilities say so', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'r20-switch-'));
  const toggle = new ClaudeTaskSwitch(profile);
  assert.equal(await toggle.load(), false);
  const h = await harness({ enabled: false });
  try {
    await h.script({ steps: [{ text: 'should not run' }] });
    await assert.rejects(h.service.start({ prompt: '整理文件夹', workingDirectory: h.folder, mode: 'read-only' }), { message: TASK_OFF });
    assert.equal(existsSync(h.record), false, 'no Claude process was started');
    const caps = await h.service.capabilities();
    assert.equal(caps.enabled, false); assert.equal(caps.authenticated, false); assert.equal(caps.computerControl, false);
    assert.deepEqual(await h.service.list(), []);
  } finally { await h.cleanup(); await rm(profile, { recursive: true, force: true }); }
});

test('no folder means no task, and a folder other than the picked one is refused', async () => {
  const h = await harness({ folder: false });
  try {
    await h.script({ steps: [] });
    await assert.rejects(h.service.start({ prompt: '整理', workingDirectory: h.folder, mode: 'read-only' }), { message: TASK_NO_FOLDER });
    h.state.folder = h.folder;
    await assert.rejects(h.service.start({ prompt: '整理', workingDirectory: h.outside, mode: 'read-only' }), /不一致/);
    await assert.rejects(h.service.start({ prompt: '整理', workingDirectory: 'relative/path', mode: 'read-only' }), /授权任务目录/);
    assert.equal(existsSync(h.record), false);
  } finally { await h.cleanup(); }
});

test('a task runs as its own claude process in the folder: reads inside pass, outside are denied, both without a dialog', async () => {
  const h = await harness();
  try {
    await h.script({ steps: [
      { text: '我先看看。' },
      { tool: 'Read', input: { file_path: path.join(h.folder, 'inside.txt') } },
      { tool: 'Read', input: { file_path: path.join(h.outside, 'secret.txt') } },
      { tool: 'WebFetch', input: { url: 'https://example.com' } },
      { text: '看完了。' },
    ], result: '读了 inside.txt。' });
    const task = await h.service.start({ prompt: '看看这个文件夹', workingDirectory: h.folder, mode: 'read-only' });
    assert.equal(task.status, 'running');
    await until(() => h.done().length === 1);
    assert.deepEqual(h.done()[0], { type: 'done', taskId: task.id, status: 'completed', summary: '读了 inside.txt。' });
    assert.equal(h.approvals().length, 0, 'no dialog for reads or denials');
    const decisions = await h.decisions();
    assert.deepEqual(decisions.map(d => [d.tool, d.decision.behavior]), [['Read', 'allow'], ['Read', 'deny'], ['WebFetch', 'deny']]);
    const recorded = await h.recorded();
    assert.equal(recorded.cwd, h.folder);
    assert.equal(recorded.prompt, '看看这个文件夹');
    assert.equal(recorded.argv[recorded.argv.indexOf('--append-system-prompt') + 1], TASK_SYSTEM_PROMPT);
    assert.equal(recorded.env.CLAUDECODE, null, 'parent Claude Code session variables are dropped');
    const details = await h.service.read(task.id);
    assert.deepEqual(details.messages.map(m => m.role), ['user', 'assistant', 'step', 'step', 'step', 'step', 'step', 'assistant']);
    assert.equal(details.summary, '读了 inside.txt。');
    assert.equal(details.messages[2].text, '读取 inside.txt');
    assert.match(details.messages[4].text, /^↳ 没有执行：只能在你选定的文件夹里操作/);
    assert.match(details.messages[6].text, /^↳ 没有执行：桌宠任务不允许联网/);
  } finally { await h.cleanup(); }
});

test('a write asks once with path and diff; allow applies exactly the shown change, deny and timeout do not', async () => {
  const h = await harness({ approvalTimeoutMs: 300 });
  try {
    const target = path.join(h.folder, 'note.txt');
    await h.script({ steps: [
      { tool: 'Write', input: { file_path: target, content: 'allowed\n' } },
      { tool: 'Write', input: { file_path: path.join(h.folder, 'declined.txt'), content: 'no\n' } },
      { tool: 'Write', input: { file_path: path.join(h.folder, 'timeout.txt'), content: 'late\n' } },
    ] });
    const task = await h.service.start({ prompt: '写个文件', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.approvals().length === 1);
    const first = h.approvals()[0].approval;
    assert.deepEqual([first.kind, first.files?.[0].path, first.decisions], ['file', 'note.txt', ['accept', 'decline', 'cancel']]);
    assert.match(first.files![0].diff, /\+ allowed/);
    assert.throws(() => h.service.respondApproval(task.id, 'not-this-one', 'accept'), /失效/);
    h.service.respondApproval(task.id, first.approvalId, 'accept');
    assert.throws(() => h.service.respondApproval(task.id, first.approvalId, 'accept'), /失效/, 'an approval answers once');
    await until(() => h.approvals().length === 2);
    h.service.respondApproval(task.id, h.approvals()[1].approval.approvalId, 'decline');
    await until(() => h.approvals().length === 3);
    // Third one is left alone: 300 ms later it counts as a denial.
    await until(() => h.done().length === 1);
    assert.equal(await readFile(target, 'utf8'), 'allowed\n');
    assert.equal(existsSync(path.join(h.folder, 'declined.txt')), false);
    assert.equal(existsSync(path.join(h.folder, 'timeout.txt')), false);
    const decisions = await h.decisions();
    assert.deepEqual(decisions[0].decision, { behavior: 'allow', updatedInput: { file_path: target, content: 'allowed\n' } });
    assert.match(decisions[1].decision.message, /用户拒绝/);
    assert.match(decisions[2].decision.message, /没有在 0 秒内回应|没有在 \d+ 秒内回应/);
    assert.equal(h.events.filter(e => e.type === 'approval-resolved').length, 3);
  } finally { await h.cleanup(); }
});

test('every Bash command asks and shows the exact command; read-only tasks still cannot write', async () => {
  const h = await harness();
  try {
    await h.script({ steps: [
      { tool: 'Bash', input: { command: 'git status', description: '查看状态' } },
      { tool: 'Write', input: { file_path: path.join(h.folder, 'x.txt'), content: 'x' } },
    ] });
    const task = await h.service.start({ prompt: '看看状态', workingDirectory: h.folder, mode: 'read-only' });
    await until(() => h.approvals().length === 1);
    const approval = h.approvals()[0].approval;
    assert.deepEqual([approval.kind, approval.command, approval.workingDirectory], ['command', 'git status', h.folder]);
    assert.match(approval.reason, /查看状态/);
    h.service.respondApproval(task.id, approval.approvalId, 'decline');
    await until(() => h.done().length === 1);
    assert.equal(h.approvals().length, 1, 'the read-only write was denied without a dialog');
    assert.equal(existsSync(path.join(h.folder, 'x.txt')), false);
  } finally { await h.cleanup(); }
});

test('only one approval is on screen at a time, even when Claude asks for two at once', async () => {
  const h = await harness();
  try {
    await h.script({ steps: [{ parallel: [
      { tool: 'Bash', input: { command: 'echo one' } },
      { tool: 'Bash', input: { command: 'echo two' } },
    ] }] });
    const task = await h.service.start({ prompt: '两条命令', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.approvals().length === 1);
    await wait(300);
    assert.equal(h.approvals().length, 1, 'the second request waits');
    h.service.respondApproval(task.id, h.approvals()[0].approval.approvalId, 'accept');
    await until(() => h.approvals().length === 2);
    const open = () => h.approvals().length - h.events.filter(e => e.type === 'approval-resolved').length;
    assert.equal(open(), 1);
    h.service.respondApproval(task.id, h.approvals()[1].approval.approvalId, 'accept');
    await until(() => h.done().length === 1);
    assert.deepEqual(h.approvals().map(a => a.approval.command).sort(), ['echo one', 'echo two']);
  } finally { await h.cleanup(); }
});

test('no visible approval surface means deny, not a silent allow', async () => {
  const h = await harness({ surface: () => false });
  try {
    await h.script({ steps: [{ tool: 'Bash', input: { command: 'rm -rf build' } }] });
    await h.service.start({ prompt: '清理', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.done().length === 1);
    assert.equal(h.approvals().length, 0);
    assert.match((await h.decisions())[0].decision.message, /看不到 soft hearts 的控制窗口/);
  } finally { await h.cleanup(); }
});

test('cancel ends the whole process tree and drops anything it says afterwards', async () => {
  const h = await harness();
  try {
    const pidFile = path.join(h.root, 'child.pid');
    await h.script({ lateOnTerm: true, steps: [{ text: '开始。' }, { spawnChild: pidFile }, { tool: 'Bash', input: { command: 'sleep 100' } }] });
    const task = await h.service.start({ prompt: '跑个长命令', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.approvals().length === 1 && existsSync(pidFile));
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    assert.equal(alive(grandchild), true);
    const before = h.events.length;
    await h.service.interrupt(task.id);
    const after = h.events.slice(before);
    assert.deepEqual(after.filter(e => e.type === 'done'), [{ type: 'done', taskId: task.id, status: 'interrupted' }]);
    await until(() => !alive(grandchild), 4_000);
    await wait(300);
    const late = h.events.slice(before).filter(e => e.type === 'delta' || (e.type === 'done' && e.status !== 'interrupted'));
    assert.deepEqual(late, [], 'late text and results are dropped');
    assert.equal(h.done().length, 1);
    assert.equal((await h.service.list())[0].status, 'interrupted');
    assert.throws(() => h.service.respondApproval(task.id, h.approvals()[0].approval.approvalId, 'accept'), /失效/);
    // The cancel decision (deny + interrupt) is what the fake saw, if it saw anything.
    for (const decision of await h.decisions()) assert.equal(decision.decision.behavior, 'deny');
  } finally { await h.cleanup(); }
});

test('the "cancel task" button on an approval stops the task', async () => {
  const h = await harness();
  try {
    await h.script({ steps: [{ tool: 'Bash', input: { command: 'make' } }, { text: 'should not continue' }] });
    const task = await h.service.start({ prompt: '构建', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.approvals().length === 1);
    h.service.respondApproval(task.id, h.approvals()[0].approval.approvalId, 'cancel');
    await until(() => h.done().length === 1);
    assert.equal((h.done()[0] as any).status, 'interrupted');
  } finally { await h.cleanup(); }
});

test('a process that reports a different permission mode or extra MCP server is stopped before it does anything', async () => {
  for (const init of [{ permissionMode: 'acceptEdits' }, { mcp_servers: [{ name: 'soft-hearts-task', status: 'connected' }, { name: 'evil', status: 'connected' }] }, { tools: ['Read', 'WebFetch'] }]) {
    const h = await harness();
    try {
      await h.script({ init, steps: [{ text: 'hello' }, { tool: 'Bash', input: { command: 'echo' } }] });
      await h.service.start({ prompt: '试试', workingDirectory: h.folder, mode: 'workspace-write' });
      await until(() => h.done().length === 1);
      assert.equal((h.done()[0] as any).status, 'failed');
      assert.equal(h.events.some(e => e.type === 'delta' || e.type === 'approval'), false, JSON.stringify(init));
    } finally { await h.cleanup(); }
  }
});

test('start gate: permission asks before a verified init are denied outright, never allowed or queued (X-090)', async () => {
  const h = await harness({ approvalTimeoutMs: 1_000 });
  try {
    await h.script({
      // The endpoint is open before spawn; these reach the app before its init report does.
      preInit: [
        { tool: 'Read', input: { file_path: path.join(h.folder, 'inside.txt') } },
        { tool: 'Write', input: { file_path: path.join(h.folder, 'early.txt'), content: 'early\n' } },
        { tool: 'Bash', input: { command: 'echo early' } },
      ],
      steps: [{ tool: 'Read', input: { file_path: path.join(h.folder, 'inside.txt') } }],
    });
    await h.service.start({ prompt: '看看', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.done().length === 1);
    const decisions = await h.decisions();
    const early = decisions.filter(d => d.preInit);
    assert.deepEqual(early.map(d => [d.tool, d.decision.behavior]), [['Read', 'deny'], ['Write', 'deny'], ['Bash', 'deny']]);
    for (const d of early) assert.match(d.decision.message, /启动核对/);
    assert.equal(h.approvals().length, 0, 'nothing before init reaches the user as an approval');
    assert.equal(existsSync(path.join(h.folder, 'early.txt')), false);
    // The same Read after a verified init passes as usual.
    assert.deepEqual(decisions.filter(d => !d.preInit).map(d => [d.tool, d.decision.behavior]), [['Read', 'allow']]);
    assert.equal((h.done()[0] as any).status, 'completed');
  } finally { await h.cleanup(); }
});

test('start gate: accepting re-checks at the last moment that the same run is still verified and open', async () => {
  const h = await harness();
  try {
    await h.script({ steps: [{ tool: 'Write', input: { file_path: path.join(h.folder, 'late.txt'), content: 'x' } }] });
    const task = await h.service.start({ prompt: '写', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.approvals().length === 1);
    // Simulates a broken invariant: the shown approval's run is no longer verified (no real path
    // gets here today, because finish() resolves the shown approval). Accept must still not allow.
    const run = (h.service as any).active;
    run.reader.initialized = false;
    assert.throws(() => h.service.respondApproval(task.id, h.approvals()[0].approval.approvalId, 'accept'), /失效/);
    run.reader.initialized = true;
    await until(() => h.done().length === 1);
    assert.equal(existsSync(path.join(h.folder, 'late.txt')), false);
    const [decision] = await h.decisions();
    assert.equal(decision.decision.behavior, 'deny');
  } finally { await h.cleanup(); }
});

test('continue starts a new process with a bounded recap instead of a saved Claude session', async () => {
  const h = await harness();
  try {
    await h.script({ steps: [{ text: '好的。' }], result: '第一轮：列出了文件。' });
    const task = await h.service.start({ prompt: '列出文件', workingDirectory: h.folder, mode: 'read-only' });
    await until(() => h.done().length === 1);
    await h.script({ steps: [], result: '第二轮完成。' });
    await h.service.continue({ taskId: task.id, prompt: '再数一下行数', mode: 'read-only' });
    await until(() => h.done().length === 2);
    const recorded = await h.recorded();
    assert.equal(recorded.prompt, recapPrompt([{ prompt: '列出文件', result: '第一轮：列出了文件。' }], '再数一下行数'));
    assert.ok(recorded.argv.includes('--no-session-persistence') && !recorded.argv.includes('--resume') && !recorded.argv.includes('--continue'));
    await assert.rejects(h.service.continue({ taskId: 'not-owned', prompt: 'x', mode: 'read-only' }), /只能读取或继续/);
  } finally { await h.cleanup(); }
});

test('the permission endpoint requires its per-run token; the shim fails closed', async () => {
  const seen: unknown[] = [];
  const endpoint = await openTaskPermissionEndpoint({ launch: { command: process.execPath, args: [SHIM] },
    handle: async request => { seen.push(request); return { behavior: 'allow', updatedInput: {} }; } });
  try {
    const config = JSON.parse(await readFile(endpoint.mcpConfigFile, 'utf8'));
    const env = config.mcpServers['soft-hearts-task'].env;
    const credentials = readTaskCredentials(env, process.platform);
    assert.ok(credentials);
    // Wrong token: the handshake fails and nothing reaches the handler.
    const wrong = new TaskConnection({ credentials: { endpoint: credentials!.endpoint, token: 'f'.repeat(64) }, handshakeTimeoutMs: 1_000 });
    const refused = await wrong.approve({ tool_name: 'Bash', input: { command: 'x' } });
    assert.equal(refused.behavior, 'deny');
    wrong.close();
    // Skipping authentication entirely: the server closes the socket without answering calls.
    const raw = net.createConnection(credentials!.endpoint);
    const frames: any[] = [];
    const reader = new FrameReader(frame => frames.push(frame), () => {});
    raw.on('data', chunk => reader.push(chunk));
    await new Promise(resolve => raw.once('connect', resolve));
    raw.write(encodeFrame({ t: 'call', id: 1, tool: 'approve', args: {} }));
    await new Promise(resolve => raw.once('close', resolve));
    assert.ok(frames.some(frame => frame.t === 'error' && frame.code === 'auth_failed'));
    assert.deepEqual(seen, []);
    // Right token works.
    const right = new TaskConnection({ credentials: credentials! });
    assert.deepEqual(await right.approve({ tool_name: 'Read', input: {} }), { behavior: 'allow', updatedInput: {} });
    right.close();
    assert.equal(seen.length, 1);
  } finally { await endpoint.close(); }
  // Missing or malformed credentials never reach anything.
  assert.equal(readTaskCredentials({}, 'linux'), null);
  assert.equal(readTaskCredentials({ SOFT_HEARTS_TASK_ENDPOINT: '/tmp/shn-task-x/p.sock', SOFT_HEARTS_TASK_TOKEN: 'short' }, 'linux'), null);
  assert.equal(readTaskCredentials({ SOFT_HEARTS_TASK_ENDPOINT: '\\\\.\\pipe\\soft-hearts-next-agent-0123456789ab', SOFT_HEARTS_TASK_TOKEN: 'a'.repeat(64) }, 'win32'), null);
  const offline = new TaskConnection({ credentials: null });
  assert.deepEqual(await offline.approve({}), { behavior: 'deny', message: '审批通道没有配置，已拒绝。' });
  // Only well-formed decisions pass the shim.
  assert.equal(validDecision({ behavior: 'allow' }), null);
  assert.equal(validDecision({ behavior: 'maybe' }), null);
  // The shim exposes exactly one tool and refuses others.
  const replies: any[] = [];
  const server = createTaskMcpServer({ connection: offline, respond: message => replies.push(message) });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'other', arguments: {} } });
  assert.deepEqual(replies[0].result.tools.map((tool: any) => tool.name), ['approve']);
  assert.equal(replies[1].error.code, -32602);
});

test('switch IPC: turning on needs the first-run notice, off stops tasks, and the pet can only offer', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'r20-ipc-'));
  const h = await harness();
  const handlers = new Map<string, { op: (...args: any[]) => unknown; controlOnly: boolean }>();
  const toggle = new ClaudeTaskSwitch(profile);
  let answer = false, notices = 0;
  const opened: unknown[] = [], broadcasts: unknown[] = [];
  h.state.enabled = false;
  Object.defineProperty(h.state, 'enabled', { get: () => toggle.enabled });
  registerClaudeTaskIpc((method, op, controlOnly = true) => handlers.set(method, { op, controlOnly }), {
    service: h.service, toggle, confirmEnable: async () => { notices++; return answer; },
    openTaskConfirmation: prompt => opened.push(prompt), broadcast: state => broadcasts.push(state),
  });
  const call = (method: string, ...args: unknown[]) => handlers.get(method)!.op(...args) as Promise<any>;
  try {
    assert.equal(handlers.get('setClaudeTasksEnabled')!.controlOnly, true);
    assert.equal(handlers.get('startCodexTask')!.controlOnly, true);
    assert.equal(handlers.get('respondCodexApproval')!.controlOnly, true);
    assert.equal(handlers.get('proposeCodexTask')!.controlOnly, false);
    assert.throws(() => handlers.get('proposeCodexTask')!.op('帮我改代码'), { message: TASK_OFF });
    assert.throws(() => handlers.get('setClaudeTasksEnabled')!.op('yes'), /不正确/);
    assert.equal((await call('setClaudeTasksEnabled', true)).enabled, false, 'declined notice keeps it off');
    assert.equal(notices, 1);
    answer = true;
    const on = await call('setClaudeTasksEnabled', true);
    assert.equal(on.enabled, true); assert.equal(notices, 2);
    assert.equal(await call('claudeTasksEnabled'), true);
    assert.equal(handlers.get('claudeTasksEnabled')!.controlOnly, false, 'the pet may ask whether to offer');
    const restarted = new ClaudeTaskSwitch(profile);
    const pending = restarted.load();
    assert.equal(await restarted.loaded(), true, 'persisted for the next start; readers wait for the file');
    await pending;
    handlers.get('proposeCodexTask')!.op('帮我改代码');
    assert.deepEqual(opened, ['帮我改代码']);
    assert.equal(existsSync(h.record), false, 'an offer never starts a task');
    await h.script({ steps: [{ tool: 'Bash', input: { command: 'sleep 1' } }] });
    await call('startCodexTask', { prompt: '跑', workingDirectory: h.folder, mode: 'workspace-write' });
    await until(() => h.approvals().length === 1);
    assert.equal((await call('setClaudeTasksEnabled', false)).enabled, false);
    assert.equal((h.done()[0] as any).status, 'interrupted');
    assert.equal(await new ClaudeTaskSwitch(profile).load(), false);
    assert.deepEqual(broadcasts, [{ enabled: true }, { enabled: false }], 'a declined notice changes nothing');
  } finally { await h.cleanup(); await rm(profile, { recursive: true, force: true }); }
});

test('close() gives up waiting for a process tree that never reports its exit (it once held a full suite for 33 minutes)', { timeout: 5_000 }, async () => {
  const service = new ClaudeTaskService({ emit: () => {}, state: () => ({ enabled: false, folder: '' }), shim: { command: process.execPath, args: [SHIM] }, stopWaitMs: 150 });
  (service as unknown as { exiting: Set<Promise<void>> }).exiting.add(new Promise<void>(() => {}));
  const started = Date.now();
  await service.close();
  const took = Date.now() - started;
  assert.ok(took >= 100 && took < 2_000, `close() took ${took} ms`);
});
