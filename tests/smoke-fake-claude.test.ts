// The packaging smoke's fake Claude Code (scripts/lib/fake-claude.mjs) and the harness-only interposer that
// routes the app's own Claude Code launch to it (scripts/lib/smoke-isolation.mjs installClaudeInterposer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, type Context } from 'node:vm';
import type { ChatMessage } from '../shared/contracts';
import { ClaudeStreamReader, claudeArguments, claudeInput, streamClaude } from '../electron/claude';
import { ClaudeChatProcess } from '../electron/claude-process';
import { CLAUDE_FOLLOW_UP_HEADER, CLAUDE_SESSION_SYSTEM_PROMPT, composeSessionPrompt } from '../electron/claude-session-prompt';
import { FAKE_CLAUDE_MARKER, FAKE_CLAUDE_REPLY, FOLLOW_UP_MARKER, REACTION_JUDGE_OPENING, createFakeClaude, parseConversation, readFakeClaudeLogs, verifyArguments } from '../scripts/lib/fake-claude.mjs';
import { reactionSystemPrompt } from '../shared/behaviors/reactions/choose';

const helper = await import(new URL('../scripts/lib/smoke-isolation.mjs', import.meta.url).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeScript = path.join(root, 'scripts', 'lib', 'fake-claude.mjs');
const reply = FAKE_CLAUDE_REPLY.join('');
const invoke = (context: Context, fn: Function, args = '') => runInContext(`(${fn.toString()})(${args})`, context);
const user = (content: string): ChatMessage => ({ role: 'user', content });
const opening = (text: string, history: ChatMessage[] = []) => composeSessionPrompt({ plan: { opening: true, history }, basePersona: '合成角色', turnPersona: '合成角色\n\n本轮心情', current: user(text) });
const followUp = (text: string) => composeSessionPrompt({ plan: { opening: false, history: [] }, basePersona: '合成角色', turnPersona: '合成角色\n\n本轮心情', current: user(text) });

/** The fake with manual timers, fed through the app's real stream-json reader. */
function harness(args: string[]) {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const events: Record<string, any>[] = [], entries: Record<string, any>[] = [];
  const fake = createFakeClaude({ args, output: event => events.push(event), log: entry => entries.push(entry),
    timers: { set: (fn, ms) => { const handle = { fn, ms, cleared: false }; pending.push(handle); return handle; }, clear: handle => { if (handle) (handle as { cleared: boolean }).cleared = true; } } });
  const flush = () => { while (pending.some(item => !item.cleared)) { const item = pending.find(value => !value.cleared)!; item.cleared = true; item.fn(); } };
  return { fake, events, entries, pending, flush };
}
function read(events: Record<string, any>[], verified = false) {
  const deltas: string[] = [];
  const reader = new ClaudeStreamReader((type, text) => { if (type === 'delta') deltas.push(text); }, { verified });
  const verdicts = events.map(event => reader.consumeEvent(event));
  return { reader, deltas, verdicts };
}

test('fake marks an I-037 reaction judge by the opening words of the real judge prompt, a yes/no only (the smoke counts judge launches apart)', () => {
  assert.ok(reactionSystemPrompt().startsWith(REACTION_JUDGE_OPENING), 'choose.ts and the fake agree on the opening words');
  const start = (system: string) => harness(claudeArguments({ model: 'haiku' }, system)).entries.find(entry => entry.event === 'start');
  assert.equal(start(reactionSystemPrompt())?.reactionJudge, true);
  assert.equal(start(CLAUDE_SESSION_SYSTEM_PROMPT)?.reactionJudge, false);
  assert.ok(!JSON.stringify(start(reactionSystemPrompt())).includes(REACTION_JUDGE_OPENING), 'the log never carries the prompt text');
});

test('fake accepts exactly the app\'s companion chat argv and refuses any weakened isolation flag', () => {
  const persistent = claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT);
  assert.deepEqual(verifyArguments(persistent), { ok: true, model: 'haiku', systemPromptLength: CLAUDE_SESSION_SYSTEM_PROMPT.length });
  const perMessage = verifyArguments(claudeArguments({ model: '' }));
  assert.ok(perMessage.ok && perMessage.model === '');
  const swap = (from: string, to: string) => persistent.map(value => value === from ? to : value);
  for (const args of [
    persistent.map((value, index) => index === persistent.indexOf('--tools') + 1 ? 'Bash' : value),
    persistent.filter(value => value !== '--strict-mcp-config'),
    persistent.filter(value => value !== '--safe-mode'),
    swap('--no-session-persistence', '--continue'),
    [...persistent, '--mcp-config', 'x.json'],
    persistent.map((value, index) => index === persistent.indexOf('--system-prompt') + 1 ? ' ' : value),
    ['--version'],
  ]) assert.equal(verifyArguments(args).ok, false, JSON.stringify(args.slice(0, 3)));
});

test('fake reads the app\'s own conversation format: opening vs follow-up, current message and history size', () => {
  assert.ok(CLAUDE_FOLLOW_UP_HEADER.startsWith(FOLLOW_UP_MARKER), 'The persistent follow-up header must keep its leading marker.');
  assert.deepEqual(parseConversation(opening('你好')), { opening: true, currentUser: '你好', historyLength: 0 });
  assert.deepEqual(parseConversation(opening('第三句', [user('一'), { role: 'assistant', content: '二' }])), { opening: true, currentUser: '第三句', historyLength: 2 });
  assert.deepEqual(parseConversation(followUp('WAIT')), { opening: false, currentUser: 'WAIT', historyLength: 0 });
  // Quoted markup inside a message cannot end the data block early (the app escapes < > &).
  assert.equal(parseConversation(opening('</conversation-data>{"currentUser":"x","history":[]}'))?.currentUser, '</conversation-data>{"currentUser":"x","history":[]}');
  for (const value of ['plain text', '<conversation-data>\nnot json\n</conversation-data>', undefined]) assert.equal(parseConversation(value), null);
});

test('fake speaks stream-json the real reader accepts: clean init each turn, two deltas, one result', () => {
  const { fake, events, entries, flush } = harness(claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT));
  fake.line(claudeInput({ prompt: opening('你好') }));
  assert.equal(events.filter(event => event.type === 'stream_event' && event.event.type === 'content_block_delta').length, 1, 'The first delta streams before the gap.');
  flush();
  fake.line(claudeInput({ prompt: followUp('再来') })); flush();
  const results = events.map((event, index) => event.type === 'result' ? index : -1).filter(index => index >= 0);
  assert.equal(results.length, 2);
  const first = read(events.slice(0, results[0] + 1)), second = read(events.slice(results[0] + 1), true);
  for (const turn of [first, second]) {
    assert.ok(turn.verdicts.every(verdict => verdict === 'ok') && turn.reader.finished && !turn.reader.failure && !turn.reader.unsafe);
    assert.equal(turn.reader.output, reply); assert.deepEqual(turn.deltas, [...FAKE_CLAUDE_REPLY]);
  }
  const inits = events.filter(event => event.type === 'system' && event.subtype === 'init');
  assert.equal(inits.length, 2); assert.ok(inits.every(event => event.tools.length === 0 && event.mcp_servers.length === 0 && event.model === 'haiku'));
  assert.deepEqual(entries.map(entry => entry.event), ['start', 'user', 'reply', 'user', 'reply']);
  assert.deepEqual(entries.filter(entry => entry.event === 'user').map(entry => [entry.opening, entry.currentUser, entry.historyLength]), [[true, '你好', 0], [false, '再来', 0]]);
  assert.ok(!JSON.stringify(entries).includes('合成角色') && !JSON.stringify(entries).includes(CLAUDE_SESSION_SYSTEM_PROMPT.slice(0, 20)), 'The log never holds the persona or system prompt.');
});

test('fake holds WAIT until the app interrupts it, then answers the interrupt and ends that turn only', () => {
  const { fake, events, entries, pending, flush } = harness(claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT));
  fake.line(claudeInput({ prompt: opening('WAIT') }));
  assert.deepEqual(events.map(event => event.type), ['system'], 'Only init until the turn is released.');
  assert.equal(pending.length, 1); assert.ok(fake.busy);
  fake.line(JSON.stringify({ type: 'control_request', request_id: 'interrupt-1', request: { subtype: 'interrupt' } }));
  assert.deepEqual(events.slice(1).map(event => [event.type, event.response?.subtype ?? event.subtype]), [['control_response', 'success'], ['result', 'error_during_execution']]);
  assert.equal(events[1].response.request_id, 'interrupt-1'); assert.equal(pending[0].cleared, true); assert.ok(!fake.busy);
  fake.line(claudeInput({ prompt: followUp('下一句') })); flush();
  assert.equal(events.at(-1)!.subtype, 'success');
  assert.deepEqual(entries.map(entry => [entry.event, entry.seq ?? null]), [['start', null], ['user', 1], ['hold', 1], ['interrupt', 1], ['user', 2], ['reply', 2]]);
  // stdin closing drops a held turn without any further output.
  const closing = harness(claudeArguments({ model: '' }));
  closing.fake.line(claudeInput({ prompt: opening('WAIT') })); closing.fake.close();
  assert.equal(closing.events.length, 1); assert.ok(closing.entries.some(entry => entry.event === 'hold-closed')); assert.ok(!closing.fake.busy);
});

test('a fake started with weakened argv refuses every turn with the app\'s update hint', () => {
  const args = claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT).filter(value => value !== '--strict-mcp-config');
  const { fake, events, entries } = harness(args);
  fake.line(claudeInput({ prompt: opening('你好') }));
  const { reader } = read(events);
  assert.equal(reader.output, ''); assert.match(reader.failure, /claude update/);
  assert.equal(entries[0].argvOk, false); assert.ok(entries.some(entry => entry.event === 'refused'));
});

interface InterposerRig { context: Context; module: { spawn: Function }; calls: any[][]; expected: Record<string, string> }
function interposer(original?: (...args: any[]) => unknown, overrides: Record<string, string> = {}): InterposerRig {
  const calls: any[][] = [];
  const module = { spawn: original ?? ((...args: any[]) => { calls.push(args); return { pid: 1 }; }) };
  const owned = path.join(os.tmpdir(), 'soft-hearts-smoke-synthetic');
  const expected = { marker: 'synthetic-marker', claudePlaceholder: path.join(owned, 'claude-placeholder.exe'), claudeHome: path.join(owned, 'claude-home'),
    fakeLog: path.join(owned, 'fake-claude'), fakeNode: process.execPath, fakeScript, fakeMarker: FAKE_CLAUDE_MARKER, ...overrides };
  const context = createContext({ expected, electron: {}, process: { platform: process.platform, getBuiltinModule: (name: string) =>
    name === 'node:child_process' ? module : name === 'node:path' ? path : name === 'node:module' ? { syncBuiltinESMExports() {} } : undefined } });
  invoke(context, helper.installClaudeInterposer, 'electron,expected');
  return { context, module, calls, expected };
}
const chatOptions = (env: Record<string, string> = {}) => ({ cwd: path.join(os.tmpdir(), 'soft-hearts-claude', 'claude-chat', 'session-abc'), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { PATH: 'synthetic', NO_COLOR: '1', DISABLE_AUTOUPDATER: '1', ...env } });

test('interposer routes only the placeholder\'s exact chat launch to the fake, unchanged options, sealed', () => {
  const rig = interposer();
  const args = claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT), options = chatOptions({ CLAUDE_CONFIG_DIR: rig.expected.claudeHome });
  rig.module.spawn(rig.expected.claudePlaceholder, args, options);
  assert.equal(rig.calls.length, 1);
  const [file, forwarded, forwardedOptions] = rig.calls[0];
  assert.equal(file, process.execPath);
  assert.deepEqual([...forwarded], [fakeScript, FAKE_CLAUDE_MARKER, path.join(rig.expected.fakeLog, 'spawn-0.jsonl'), ...args]);
  assert.equal(forwardedOptions, options, 'The app\'s own options (env, folder, pipes, shell:false) pass through untouched.');
  // Unrelated launches (taskkill, git, ...) go to the real spawn exactly as called.
  rig.module.spawn('taskkill.exe', ['/PID', '1', '/T', '/F'], { windowsHide: true });
  assert.deepEqual(rig.calls[1], ['taskkill.exe', ['/PID', '1', '/T', '/F'], { windowsHide: true }]);
  const evidence = runInContext('globalThis.__safeSmokeClaude', rig.context);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence.spawned)), [{ index: 0, model: 'haiku', findings: { electronRunAsNode: false, sessionVariables: 0, configDirMatches: true,
    noColor: true, noAutoUpdater: true, ownedTurnFolder: true, hidden: true } }]);
  assert.equal(evidence.passedThrough, 1); assert.deepEqual([...evidence.denied], []);
  const descriptor = Object.getOwnPropertyDescriptor(rig.module, 'spawn')!;
  assert.ok(!descriptor.writable && !descriptor.configurable, 'The app cannot restore the real spawn behind the harness.');
  assert.throws(() => invoke(rig.context, helper.installClaudeInterposer, 'electron,expected'), /already installed/);
});

test('interposer refuses every other Claude Code launch and records leaked session variables', () => {
  const rig = interposer();
  const args = claudeArguments({ model: '' });
  const refused: Array<[string, string[], Record<string, unknown>]> = [
    [process.platform === 'win32' ? 'C:\\Users\\someone\\.local\\bin\\claude.exe' : '/usr/local/bin/claude', args, chatOptions()],
    ['claude.cmd', args, { ...chatOptions(), shell: true }],
    [rig.expected.claudePlaceholder, ['--version'], chatOptions()],
    [rig.expected.claudePlaceholder, args.map((value, index) => index === args.indexOf('--tools') + 1 ? 'Bash' : value), chatOptions()],
    [rig.expected.claudePlaceholder, args.filter(value => value !== '--strict-mcp-config'), chatOptions()],
    [rig.expected.claudePlaceholder, args, { ...chatOptions(), shell: true }],
    [process.execPath, ['some-cli.js', '-p', '--output-format', 'stream-json'], chatOptions()],
  ];
  for (const [file, list, options] of refused) assert.throws(() => rig.module.spawn(file, list, options), /refused a Claude Code launch/);
  assert.equal(rig.calls.length, 0, 'A refused launch never reaches the real spawn.');
  assert.equal(runInContext('globalThis.__safeSmokeClaude', rig.context).denied.length, refused.length);
  // A launch whose environment still carries a parent session is routed to the fake but flagged for the smoke.
  rig.module.spawn(rig.expected.claudePlaceholder, args, chatOptions({ CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1' }));
  const [record] = runInContext('globalThis.__safeSmokeClaude', rig.context).spawned;
  assert.deepEqual({ ...record.findings }, { electronRunAsNode: true, sessionVariables: 1, configDirMatches: false, noColor: true, noAutoUpdater: true, ownedTurnFolder: true, hidden: true });
});

test('the app\'s persistent Claude Code process drives the real fake through the interposer: reuse, interrupt, drain', { timeout: 20_000 }, async () => {
  const owned = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-smoke-fake-')));
  // Like the smoke's whitelisted app environment: no inherited Claude variables except the owned folder and decoys.
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith('CLAUDE')));
  const claudeHome = path.join(owned, 'claude-home'), fakeLog = path.join(owned, 'fake-claude');
  let chat: ClaudeChatProcess | null = null;
  try {
    await mkdir(claudeHome); await mkdir(fakeLog);
    for (const key of Object.keys(saved)) delete process.env[key];
    Object.assign(process.env, { CLAUDE_CONFIG_DIR: claudeHome, ...helper.CLAUDE_SESSION_DECOYS });
    const rig = interposer(realSpawn, { claudePlaceholder: path.join(owned, 'claude-placeholder.exe'), claudeHome, fakeLog });
    chat = await ClaudeChatProcess.start({ binary: rig.expected.claudePlaceholder, model: 'haiku', systemPrompt: CLAUDE_SESSION_SYSTEM_PROMPT, spawn: rig.module.spawn as typeof realSpawn });
    const deltas: string[] = [];
    const emit = (type: string, text: string) => { if (type === 'delta') deltas.push(text); };
    assert.equal(await chat.run(claudeInput({ prompt: opening('你好') }), new AbortController().signal, emit), reply);
    assert.deepEqual(deltas, [...FAKE_CLAUDE_REPLY]); assert.ok(chat.verified);
    const stop = new AbortController();
    const held = chat.run(claudeInput({ prompt: followUp('WAIT') }), stop.signal, emit);
    const until = async (predicate: () => boolean) => { const end = Date.now() + 20_000; // a real condition; 20 s of margin on a busy machine
      while (!predicate()) { assert.ok(Date.now() < end, 'timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
    await until(() => readFakeClaudeLogs(fakeLog).turns.length === 2);
    stop.abort(new Error('已停止。'));
    await assert.rejects(held, /已停止/);
    await chat.settled();
    assert.ok(chat.alive && !chat.busy, 'The interrupted turn drained; the process stays warm.');
    assert.equal(await chat.run(claudeInput({ prompt: followUp('新的一句') }), new AbortController().signal, emit), reply);
    // The fake appends its "reply" log line just after it writes the result to stdout; under load the
    // app can read the result first, so wait for the line rather than racing it.
    await until(() => readFakeClaudeLogs(fakeLog).turns.at(-1)?.replies === 1);
    const logs = readFakeClaudeLogs(fakeLog);
    assert.equal(logs.spawns.length, 1);
    assert.ok(logs.spawns[0].start?.argvOk && logs.spawns[0].start.model === 'haiku' && logs.spawns[0].cwdEmpty === true && logs.spawns[0].unexpected === 0);
    assert.deepEqual(logs.turns.map(turn => [turn.opening, turn.currentUser, turn.replies, turn.interrupted]), [[true, '你好', 1, false], [false, 'WAIT', 0, true], [false, '新的一句', 1, false]]);
    const [record] = runInContext('globalThis.__safeSmokeClaude', rig.context).spawned;
    assert.deepEqual({ ...record.findings }, { electronRunAsNode: false, sessionVariables: 0, configDirMatches: true, noColor: true, noAutoUpdater: true, ownedTurnFolder: true, hidden: true },
      'The app\'s real environment sanitizer dropped the parent-session decoys and kept the owned config folder.');
    const pid = logs.spawns[0].pid!;
    chat.close();
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    assert.deepEqual(await readdir(claudeHome), [], 'The fake never writes a Claude Code config.');
  } finally {
    chat?.close();
    for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('CLAUDE')) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(owned, { recursive: true, force: true });
  }
});

test('the same fake also serves the one-process-per-message fallback (SOFT_HEARTS_CLAUDE_PERSISTENT=0)', { timeout: 20_000 }, async () => {
  const owned = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-smoke-fake-')));
  try {
    const log = path.join(owned, 'spawn-0.jsonl');
    const deltas: string[] = [];
    await streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: owned, writable: false, prompt: opening('你好') }, new AbortController().signal,
      (type, text) => { if (type === 'delta') deltas.push(text); }, process.execPath, [fakeScript, FAKE_CLAUDE_MARKER, log]);
    assert.deepEqual(deltas, [...FAKE_CLAUDE_REPLY]);
    const logs = readFakeClaudeLogs(owned);
    assert.ok(logs.spawns[0].start?.argvOk && logs.spawns[0].stdinEnded);
    assert.deepEqual(logs.turns.map(turn => [turn.currentUser, turn.replies]), [['你好', 1]]);
  } finally { await rm(owned, { recursive: true, force: true }); }
});

test('only the harness can install the fake: no product source, bundle input or packaged file refers to it', async () => {
  const product: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative); else if (/\.(?:ts|mts|js|mjs|html|css)$/.test(entry.name)) product.push(relative);
    }
  };
  for (const directory of ['electron', 'src', 'shared']) await walk(directory);
  assert.ok(product.includes('electron/claude.ts') && product.includes('electron/claude-process.ts'));
  for (const file of product) {
    const text = await readFile(path.join(root, file), 'utf8');
    for (const needle of ['fake-claude', FAKE_CLAUDE_MARKER, '__safeSmokeClaude', 'installClaudeInterposer', 'smoke-isolation']) assert.ok(!text.includes(needle), `${file} mentions ${needle}`);
  }
  const build = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).build;
  const shipped = [...build.files, ...build.extraResources.map((entry: { from: string }) => entry.from)];
  assert.ok(shipped.every((entry: string) => !entry.startsWith('scripts/lib') && !entry.includes('fake-claude') && entry !== 'scripts/**/*'), 'The fake is never packaged.');
  // The harness itself is pinned to the trusted updater's bytes, and changing it never counts as a production change.
  assert.deepEqual(helper.SMOKE_HARNESS_FILES, ['scripts/smoke.mjs', 'scripts/lib/smoke-isolation.mjs', 'scripts/lib/fake-claude.mjs']);
  const rows = [['electron/claude.ts', 'a'.repeat(64)], ['scripts/lib/fake-claude.mjs', 'b'.repeat(64)]];
  helper.assertRuntimeSourceEquivalence(rows, [rows[0], ['scripts/lib/fake-claude.mjs', 'c'.repeat(64)]]);
  assert.throws(() => helper.assertRuntimeSourceEquivalence(rows, [['electron/claude.ts', 'd'.repeat(64)], rows[1]]));
  // Importing the module (as this test and the harness do) starts nothing: it only runs behind its marker argument.
  assert.notEqual(process.argv[2], FAKE_CLAUDE_MARKER);
});
