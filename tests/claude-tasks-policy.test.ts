import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  changeSummary, classifyPermission, DENY_BACKGROUND, DENY_NETWORK, DENY_OUTSIDE, DENY_READ_ONLY, DENY_TOOL,
  isWithin, unsafePathShape, type PolicyFs,
} from '../electron/claude-tasks/policy';
import {
  TASK_PERMISSION_TOOL, TASK_SYSTEM_PROMPT, TaskStreamReader, taskArguments, taskMcpConfig, taskSettingsJson, verifyTaskInit,
} from '../electron/claude-tasks/process';
import { ClaudeStreamReader, claudeArguments } from '../electron/claude';

async function folders() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'r20-policy-')));
  const folder = path.join(root, 'work'), outside = path.join(root, 'outside');
  await mkdir(folder); await mkdir(outside);
  await writeFile(path.join(folder, 'inside.txt'), 'one\ntwo\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  return { root, folder, outside, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('read tools inside the folder are allowed without asking; outside and traversal are denied', async () => {
  const f = await folders();
  try {
    const context = { folder: f.folder, mode: 'read-only' as const };
    for (const request of [
      { tool_name: 'Read', input: { file_path: path.join(f.folder, 'inside.txt') } },
      { tool_name: 'Read', input: { file_path: 'inside.txt' } },
      { tool_name: 'Glob', input: { pattern: '**/*.ts' } },
      { tool_name: 'Grep', input: { pattern: 'x', path: f.folder } },
      { tool_name: 'Grep', input: { pattern: 'x' } },
    ]) assert.deepEqual(await classifyPermission(request, context), { kind: 'allow' }, JSON.stringify(request));
    for (const request of [
      { tool_name: 'Read', input: { file_path: path.join(f.outside, 'secret.txt') } },
      { tool_name: 'Read', input: { file_path: '../outside/secret.txt' } },
      { tool_name: 'Read', input: { file_path: `${f.folder}x/secret.txt` } },
      { tool_name: 'Read', input: {} },
      { tool_name: 'Glob', input: { pattern: '/etc/*' } },
      { tool_name: 'Glob', input: { pattern: '../**' } },
      { tool_name: 'Glob', input: { pattern: '*', path: f.outside } },
      { tool_name: 'Grep', input: { pattern: 'secret', path: f.outside } },
    ]) assert.deepEqual(await classifyPermission(request, context), { kind: 'deny', message: DENY_OUTSIDE }, JSON.stringify(request));
  } finally { await f.cleanup(); }
});

test('a symlink (or, on Windows without symlink rights, a junction) inside the folder that points outside is denied', async t => {
  const f = await folders();
  try {
    const link = path.join(f.folder, 'link');
    try { await symlink(f.outside, link); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      // Junctions need no special rights on Windows and are the escape a task could actually create there.
      try { await symlink(f.outside, link, 'junction'); }
      catch { t.skip('Windows does not permit test symlink creation'); return; }
    }
    const request = { tool_name: 'Read', input: { file_path: path.join(f.folder, 'link', 'secret.txt') } };
    assert.deepEqual(await classifyPermission(request, { folder: f.folder, mode: 'read-only' }), { kind: 'deny', message: DENY_OUTSIDE });
  } finally { await f.cleanup(); }
});

test('file changes inside the folder ask with path and a short diff; outside or read-only are denied without asking', async () => {
  const f = await folders();
  try {
    const write = { folder: f.folder, mode: 'workspace-write' as const };
    const created = await classifyPermission({ tool_name: 'Write', input: { file_path: path.join(f.folder, 'new.txt'), content: 'hello\nworld\n' } }, write);
    assert.equal(created.kind, 'ask');
    if (created.kind !== 'ask') return;
    assert.equal(created.approval.kind, 'file');
    assert.equal(created.approval.files?.[0].path, 'new.txt');
    assert.match(created.approval.files![0].diff, /新建文件，共 2 行/);
    assert.match(created.approval.files![0].diff, /\+ hello\n\+ world/);
    const overwrite = await classifyPermission({ tool_name: 'Write', input: { file_path: path.join(f.folder, 'inside.txt'), content: 'one\nTWO\n' } }, write);
    assert.ok(overwrite.kind === 'ask' && /覆盖已有文件（原 2 行 → 新 2 行）/.test(overwrite.approval.files![0].diff) && /- two\n\+ TWO/.test(overwrite.approval.files![0].diff));
    const edit = await classifyPermission({ tool_name: 'Edit', input: { file_path: path.join(f.folder, 'inside.txt'), old_string: 'two', new_string: '2' } }, write);
    assert.ok(edit.kind === 'ask' && /替换一处/.test(edit.approval.files![0].diff) && /- two\n\+ 2/.test(edit.approval.files![0].diff));
    const sensitive = await classifyPermission({ tool_name: 'Write', input: { file_path: path.join(f.folder, '.claude', 'settings.json'), content: '{}' } }, write);
    assert.ok(sensitive.kind === 'ask' && /以后在这个文件夹里运行的工具/.test(sensitive.approval.permissionWarning ?? ''));
    assert.deepEqual(await classifyPermission({ tool_name: 'Write', input: { file_path: path.join(f.outside, 'x.txt'), content: 'x' } }, write), { kind: 'deny', message: DENY_OUTSIDE });
    assert.deepEqual(await classifyPermission({ tool_name: 'Edit', input: { file_path: '../outside/secret.txt', old_string: 'a', new_string: 'b' } }, write), { kind: 'deny', message: DENY_OUTSIDE });
    assert.deepEqual(await classifyPermission({ tool_name: 'Write', input: { file_path: path.join(f.folder, 'new.txt'), content: 'x' } }, { ...write, mode: 'read-only' }), { kind: 'deny', message: DENY_READ_ONLY });
  } finally { await f.cleanup(); }
});

test('every shell command asks and shows the exact command; background, network and unknown tools are denied', async () => {
  const context = { folder: '/srv/project', mode: 'workspace-write' as const };
  const bash = await classifyPermission({ tool_name: 'Bash', input: { command: 'ls -la', description: 'List files' } }, context);
  assert.deepEqual(bash.kind === 'ask' && { kind: bash.approval.kind, command: bash.approval.command, cwd: bash.approval.workingDirectory }, { kind: 'command', command: 'ls -la', cwd: '/srv/project' });
  const windows = await classifyPermission({ tool_name: 'PowerShell', input: { command: 'Get-ChildItem' } }, { ...context, folder: 'C:\\project', platform: 'win32', fs: identityFs });
  assert.ok(windows.kind === 'ask' && /Windows 上 Claude Code 没有沙箱/.test(windows.approval.permissionWarning ?? ''));
  assert.deepEqual(await classifyPermission({ tool_name: 'Bash', input: { command: 'sleep 9', run_in_background: true } }, context), { kind: 'deny', message: DENY_BACKGROUND });
  assert.deepEqual(await classifyPermission({ tool_name: 'Bash', input: { command: '' } }, context), { kind: 'deny', message: DENY_TOOL });
  for (const tool of ['WebFetch', 'WebSearch']) assert.deepEqual(await classifyPermission({ tool_name: tool, input: { url: 'https://example.com' } }, context), { kind: 'deny', message: DENY_NETWORK });
  for (const tool of ['Task', 'Agent', 'mcp__soft-hearts-task__approve', 'mcp__other__x', '']) assert.deepEqual(await classifyPermission({ tool_name: tool, input: {} }, context), { kind: 'deny', message: DENY_TOOL });
});

const identityFs: PolicyFs = { realpath: async file => file, readText: async () => null };

test('Windows paths: case-insensitive containment, UNC, device paths and alternate data streams are refused', async () => {
  assert.equal(isWithin('C:\\Users\\me\\Project', 'c:\\users\\ME\\project\\src\\a.ts', 'win32'), true);
  assert.equal(isWithin('C:\\Users\\me\\Project', 'C:\\Users\\me\\Project2\\a.ts', 'win32'), false);
  assert.equal(isWithin('/home/me/p', '/home/me/p2/a', 'linux'), false);
  assert.equal(isWithin('/home/me/p', '/home/me/p/..foo', 'linux'), true);
  for (const value of ['\\\\server\\share\\a', '\\\\?\\C:\\a', '\\\\.\\pipe\\x', 'C:\\p\\a.txt:secret', 'a\0b']) assert.equal(unsafePathShape(value, 'win32'), true, value);
  assert.equal(unsafePathShape('C:\\p\\a.txt', 'win32'), false);
  const context = { folder: 'C:\\Users\\me\\Project', mode: 'workspace-write' as const, platform: 'win32' as const, fs: identityFs };
  assert.deepEqual(await classifyPermission({ tool_name: 'Read', input: { file_path: 'C:\\Users\\me\\project\\a.ts' } }, context), { kind: 'allow' });
  assert.deepEqual(await classifyPermission({ tool_name: 'Read', input: { file_path: 'C:\\Users\\me\\Project\\a.ts:hidden' } }, context), { kind: 'deny', message: DENY_OUTSIDE });
  assert.deepEqual(await classifyPermission({ tool_name: 'Read', input: { file_path: '\\\\attacker\\share\\x' } }, context), { kind: 'deny', message: DENY_OUTSIDE });
});

test('change summaries trim the unchanged head and tail and stay short', () => {
  assert.equal(changeSummary('a\nb\nc\n', 'a\nB\nc\n'), '@@ 删除 1 行，新增 1 行 @@\n- b\n+ B');
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const summary = changeSummary('', long);
  assert.match(summary, /其余 76 行未显示/);
  assert.ok(summary.split('\n').length < 30);
});

test('task argv is assembled exactly (snapshot), with the prompt kept off the command line', () => {
  assert.deepEqual(taskArguments({ mcpConfigFile: '/tmp/shn-task-x/mcp.json', model: ' sonnet ' }), [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--restricted',
    '--tools', 'Read,Glob,Grep,Edit,Write,NotebookEdit,Bash,PowerShell',
    '--disallowedTools', 'WebFetch,WebSearch',
    '--settings', '{"permissions":{"ask":["Bash","PowerShell","Edit","Write","MultiEdit","NotebookEdit"],"deny":["WebFetch","WebSearch"]}}',
    '--setting-sources', '',
    '--mcp-config', '/tmp/shn-task-x/mcp.json',
    '--strict-mcp-config',
    '--permission-prompt-tool', 'mcp__soft-hearts-task__approve',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--append-system-prompt', TASK_SYSTEM_PROMPT,
    '--model', 'sonnet',
  ]);
  const plain = taskArguments({ mcpConfigFile: 'cfg.json' });
  assert.ok(!plain.includes('--model'));
  assert.ok(!plain.some(arg => /dangerously|bypass|--add-dir|--safe-mode|--allowed-?tools|--permission-mode/i.test(arg)), 'no flag widens or skips permissions');
  assert.equal(TASK_PERMISSION_TOOL, 'mcp__soft-hearts-task__approve');
  assert.deepEqual(JSON.parse(taskSettingsJson()).permissions.deny, ['WebFetch', 'WebSearch']);
  const config = taskMcpConfig({ command: '/app/electron', args: ['/app/shim.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }, '/tmp/shn-task-x/p.sock', 'a'.repeat(64)) as any;
  assert.deepEqual(Object.keys(config.mcpServers), ['soft-hearts-task']);
  assert.deepEqual(config.mcpServers['soft-hearts-task'].env, { ELECTRON_RUN_AS_NODE: '1', SOFT_HEARTS_TASK_ENDPOINT: '/tmp/shn-task-x/p.sock', SOFT_HEARTS_TASK_TOKEN: 'a'.repeat(64) });
});

test('chat stays tool-free: chat argv is unchanged and never carries task permissions', () => {
  // Per-reply chat and the persistent chat process (same builder, its own system prompt).
  for (const args of [claudeArguments({ model: '' }), claudeArguments({ model: 'haiku' }, 'persistent chat prompt')]) {
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--safe-mode') && args.includes('--strict-mcp-config'));
    assert.ok(!args.some(arg => /--permission-prompt-tool|--mcp-config|--restricted|--settings$|--add-dir|Bash|Write/.test(arg)), args.join(' '));
  }
  // A chat process that reports tools is still stopped, whatever the task feature is doing.
  const reader = new ClaudeStreamReader(() => {});
  assert.equal(reader.consume(JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read'], mcp_servers: [] })), 'stop');
  assert.equal(reader.unsafe, true);
});

test('task init is verified before any output is accepted', () => {
  const good = { type: 'system', subtype: 'init', cwd: '/srv/p', tools: ['Read', 'Write', 'Bash'], mcp_servers: [{ name: 'soft-hearts-task', status: 'connected' }],
    permissionMode: 'default', additional_directories: [], plugins: [{ name: 'a', path: 'builtin' }] };
  assert.equal(verifyTaskInit(good, '/srv/p', 'linux'), null);
  assert.equal(verifyTaskInit({ ...good, cwd: 'C:\\SRV\\P' }, 'c:\\srv\\p', 'win32'), null);
  for (const bad of [
    { ...good, tools: ['Read', 'WebFetch'] }, { ...good, tools: ['Read', 'Task'] }, { ...good, tools: [] },
    { ...good, mcp_servers: [] }, { ...good, mcp_servers: [{ name: 'soft-hearts-task', status: 'failed' }] },
    { ...good, mcp_servers: [{ name: 'soft-hearts-task', status: 'connected' }, { name: 'evil', status: 'connected' }] },
    { ...good, permissionMode: 'acceptEdits' }, { ...good, permissionMode: 'bypassPermissions' }, { ...good, permissionMode: undefined },
    { ...good, cwd: '/srv/other' }, { ...good, additional_directories: ['/'] }, { ...good, plugins: [{ name: 'x', path: '/home/u/.claude/plugins/x' }] },
  ]) assert.notEqual(verifyTaskInit(bad, '/srv/p', 'linux'), null, JSON.stringify(bad));
  const texts: string[] = [];
  const reader = new TaskStreamReader({ text: t => texts.push(t), step: () => {} }, '/srv/p', 'linux');
  assert.equal(reader.consume(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'early' } } })), 'stop');
  assert.deepEqual(texts, []);
});
