// Peer messages refused (docs/claude/2026-11-25-peer-messages-refused.md): every Claude Code process the app starts refuses
// cross-session messages and denies SendMessage / ListAgents through one `--settings` value; text of a message that is not the
// model's own reply is never shown; a stream kind the reader does not know is journaled by name only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ClaudeStreamReader, claudeArguments } from '../electron/brain/claude';
import { ClaudeChatProcess } from '../electron/brain/claude-process';
import { ClaudeStartGate } from '../electron/brain/claude-start-gate';
import { PEER_DENIED_TOOLS, claudeSettingsArguments, lockedClaudeSettings } from '../electron/brain/claude-settings';
import { noteStreamKind, observeClaudeStreamKinds, resetClaudeStreamKindCounts, unknownStreamKind, type ClaudeStreamKind } from '../electron/brain/claude-stream-kinds';
import { ASSISTANT_TOOL_PREFIX, assistantArguments, verifyAssistantInit } from '../electron/safety/assistant/process';
import { TASK_ASK_RULES, TASK_DENIED_TOOLS, taskArguments, verifyTaskInit } from '../electron/safety/claude-tasks/process';
import { FAKE_CLAUDE_PEER_SETTINGS, verifyArguments } from '../scripts/lib/fake-claude.mjs';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { manualClock } from './helpers/manual-clock';
import { expression } from './helpers/chat-world';
import { wiringCallArguments } from './helpers/wiring-source';

const ROOT = path.resolve(import.meta.dirname, '..');
const PREFS = { model: 'sonnet', effort: 'medium' } as never;

/**
 * Every argv builder for a Claude Code session process. A new file under electron/ that builds a stream-json session argv must be
 * added here (the scan below fails until it is) and must take its settings from claudeSettingsArguments.
 */
const BUILDERS: { file: string; name: string; argv: () => string[]; keeps: (args: string[]) => void }[] = [
  { file: 'electron/brain/claude.ts', name: 'chat (one-shot, warm, spare, haiku helpers, review, chime-in)', argv: () => claudeArguments({ model: 'haiku' }),
    keeps: args => { assert.equal(args[args.indexOf('--tools') + 1], ''); for (const flag of ['--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag); } },
  { file: 'electron/safety/assistant/process.ts', name: 'Claude assistant', argv: () => assistantArguments({ mcpConfigFile: 'mcp.json', prefs: PREFS, systemPrompt: '助手' }),
    keeps: args => { assert.equal(args[args.indexOf('--tools') + 1], ''); assert.ok(args.includes('--strict-mcp-config')); assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none'); } },
  { file: 'electron/safety/claude-tasks/process.ts', name: 'task executor', argv: () => taskArguments({ mcpConfigFile: 'mcp.json', model: 'sonnet' }),
    keeps: args => { for (const flag of ['--restricted', '--strict-mcp-config', '--permission-prompt-tool']) assert.ok(args.includes(flag), flag); } },
];

const settingsOf = (args: string[]): Record<string, any> => {
  assert.equal(args.filter(value => value === '--settings').length, 1, 'exactly one --settings flag');
  return JSON.parse(args[args.indexOf('--settings') + 1]!);
};

test('every Claude Code argv builder refuses peer messages and denies SendMessage / ListAgents, keeping its own lockdown', () => {
  for (const builder of BUILDERS) {
    const args = builder.argv();
    const settings = settingsOf(args);
    assert.equal(settings.crossSessionInbound, 'refuse', builder.name);
    for (const tool of ['SendMessage', 'ListAgents']) assert.ok(settings.permissions.deny.includes(tool), `${builder.name} denies ${tool}`);
    assert.ok(!args.includes('--bare'), `${builder.name}: --bare would break the subscription login`);
    builder.keeps(args);
  }
});

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await sourceFiles(relative));
    else if (/\.(ts|mts|cts|mjs|js)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

test('every file under electron/ that builds a stream-json session argv is a listed builder and uses the shared settings helper', async () => {
  const sessionArgv = /['"]--(?:output|input)-format['"]/;
  const found: string[] = [];
  for (const file of await sourceFiles('electron')) {
    const text = await readFile(path.join(ROOT, file), 'utf8');
    if (sessionArgv.test(text)) found.push(file);
    // Settings only through the helper: no builder writes its own --settings flag.
    if (file !== 'electron/brain/claude-settings.ts') assert.ok(!/['"]--settings['"]/.test(text), `${file} writes --settings itself; use claudeSettingsArguments`);
  }
  assert.deepEqual(found.sort(), BUILDERS.map(builder => builder.file).sort(), 'a new Claude Code argv builder must be listed in BUILDERS');
  for (const builder of BUILDERS) assert.match(await readFile(path.join(ROOT, builder.file), 'utf8'), /claudeSettingsArguments\(/, builder.file);
});

test('merge: a builder that has settings of its own gets the peer keys in the same JSON, its rules kept', () => {
  const task = settingsOf(taskArguments({ mcpConfigFile: 'mcp.json' }));
  assert.deepEqual(task.permissions.ask, [...TASK_ASK_RULES]);
  assert.deepEqual(task.permissions.deny, [...TASK_DENIED_TOOLS, ...PEER_DENIED_TOOLS]);
  assert.equal(task.crossSessionInbound, 'refuse');
  const assistant = settingsOf(assistantArguments({ mcpConfigFile: 'mcp.json', prefs: PREFS, systemPrompt: '助手' }));
  assert.equal(assistant.autoMemoryEnabled, false);
  assert.equal(assistant.crossSessionInbound, 'refuse');
  // A caller's own value never wins, and a deny rule already there is not doubled.
  assert.equal(lockedClaudeSettings({ crossSessionInbound: 'accept' }).crossSessionInbound, 'refuse');
  assert.deepEqual((lockedClaudeSettings({ permissions: { deny: ['SendMessage', 'WebFetch'] } }).permissions as any).deny, ['SendMessage', 'WebFetch', 'ListAgents']);
});

test('the packaging-smoke stand-in expects exactly the settings value the chat argv sends', () => {
  assert.equal(FAKE_CLAUDE_PEER_SETTINGS, claudeSettingsArguments()[1]);
  assert.equal(verifyArguments(claudeArguments({ model: 'haiku' })).ok, true);
});

test('the settings JSON reaches a child process byte for byte (spawned without a shell, as the app does)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peer-refuse-argv-'));
  try {
    const script = path.join(root, 'echo-argv.cjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    for (const builder of BUILDERS) {
      const args = builder.argv();
      const run = spawnSync(process.execPath, [script, ...args], { shell: false, windowsHide: true, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const seen = JSON.parse(run.stdout) as string[];
      assert.deepEqual(seen, args, `${builder.name}: argv survives quoting`);
      assert.equal(JSON.parse(seen[seen.indexOf('--settings') + 1]!).crossSessionInbound, 'refuse');
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

// ---------------------------------------------------------------- the tool check is the guard

test('an init that lists SendMessage or ListAgents stops every kind of process', () => {
  const assistantInit = (tools: string[]) => ({ tools: [`${ASSISTANT_TOOL_PREFIX}status`, ...tools], mcp_servers: [{ name: 'soft-hearts-assistant', status: 'connected' }], permissionMode: 'default' });
  const taskInit = (tools: string[]) => ({ cwd: '/work', tools: ['Read', ...tools], mcp_servers: [{ name: 'soft-hearts-task', status: 'connected' }], permissionMode: 'default' });
  // The same reports without the peer tool pass, so only the tool stops them.
  assert.equal(new ClaudeStreamReader(() => {}).consumeEvent(INIT), 'ok');
  assert.equal(verifyAssistantInit(assistantInit([])), null);
  assert.equal(verifyTaskInit(taskInit([]), '/work', 'linux'), null);
  for (const tool of ['SendMessage', 'ListAgents']) {
    const reader = new ClaudeStreamReader(() => {});
    assert.equal(reader.consumeEvent({ type: 'system', subtype: 'init', tools: [tool], mcp_servers: [] }), 'stop', `chat stops on ${tool}`);
    assert.equal(reader.unsafe, true);
    assert.notEqual(verifyAssistantInit(assistantInit([tool])), null, `assistant stops on ${tool}`);
    assert.notEqual(verifyTaskInit(taskInit([tool]), '/work', 'linux'), null, `task stops on ${tool}`);
  }
});

// ---------------------------------------------------------------- text that is not her reply

const ev = (inner: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'stream_event', event: inner, ...extra });
const delta = (text: string) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const INIT = { type: 'system', subtype: 'init', tools: [], mcp_servers: [] };

test('deltas of a synthetic or error message are never shown; the reply after it is', () => {
  for (const start of [ev({ type: 'message_start', message: { model: '<synthetic>' } }), ev({ type: 'message_start', message: { model: 'claude-opus' } }, { error: 'unknown' }),
    ev({ type: 'message_start', message: { model: 'claude-opus', error: 'rate_limit' } })]) {
    const shown: string[] = [];
    const reader = new ClaudeStreamReader((type, text) => { if (type === 'delta') shown.push(text); });
    reader.consumeEvent(INIT);
    reader.consumeEvent(start);
    assert.equal(reader.consumeEvent(delta('partner is online')), 'ok');
    assert.deepEqual(shown, [], 'the notice is not her reply');
    reader.consumeEvent(ev({ type: 'message_start', message: { model: 'claude-opus-4' } }));
    reader.consumeEvent(delta('在呢'));
    assert.deepEqual(shown, ['在呢']);
    assert.equal(reader.output, '在呢');
  }
});

test('a synthetic message streamed alone leaves the turn empty (the complete-message fallback stays), and its policy notice marks a refusal', () => {
  const reader = new ClaudeStreamReader(() => {});
  reader.consumeEvent(INIT);
  reader.consumeEvent(ev({ type: 'message_start', message: { model: '<synthetic>' } }));
  reader.consumeEvent(delta('Claude Code is unable to respond to this request'));
  assert.equal(reader.refused, true);
  reader.consumeEvent({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(reader.output, '');
});

// ---------------------------------------------------------------- unknown stream kinds, by name only

function observed(): ClaudeStreamKind[] {
  const rows: ClaudeStreamKind[] = [];
  resetClaudeStreamKindCounts();
  observeClaudeStreamKinds(kind => rows.push(kind));
  return rows;
}

test('an unknown event kind is reported once per process with its type and system subtype only, never its text', (t) => {
  t.after(() => observeClaudeStreamKinds(null));
  const rows = observed();
  const reader = new ClaudeStreamReader(() => {});
  reader.consumeEvent(INIT);
  reader.consumeEvent({ type: 'user', message: { role: 'user', content: 'Message from @partner: partner online' } });
  reader.consumeEvent({ type: 'user', message: { role: 'user', content: 'again' } });
  reader.consumeEvent({ type: 'system', subtype: 'peer_message', text: 'partner online', from: 'C:\\Users\\someone' });
  reader.consumeEvent({ type: 'system', subtype: 'Partner online!' });
  reader.consumeEvent({ type: 'Message from partner' });
  for (const known of [{ type: 'rate_limit_event', rate_limit_info: {} }, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 529 }, delta('x'), { type: 'assistant', message: { content: [] } }])
    reader.consumeEvent(known);
  assert.deepEqual(rows, [{ event: 'user' }, { event: 'system', subtype: 'peer_message' }, { event: 'system', subtype: 'odd' }, { event: 'odd' }]);
  assert.doesNotMatch(JSON.stringify(rows), /partner|someone|again|Message/, 'no text of any field');
  // A second process (its own set) reports the kind again.
  noteStreamKind(new Set(), { type: 'user' });
  assert.equal(rows.length, 5);
});

test('the run-wide cap keeps a kind every call carries from filling the journal', (t) => {
  t.after(() => observeClaudeStreamKinds(null));
  const rows = observed();
  for (let i = 0; i < 50; i++) noteStreamKind(new Set(), { type: 'system', subtype: 'status' });
  assert.equal(rows.length, 20);
  assert.equal(unknownStreamKind({ type: 'system', subtype: 'init' }), null);
});

test('the long-lived process reports a kind that arrives between turns, where no reader sees it', async (t) => {
  t.after(() => observeClaudeStreamKinds(null));
  const rows = observed();
  const children: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean })[] = [];
  const spawn = (() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { setImmediate(() => child.emit('close', null)); return true; } });
    children.push(child);
    return child;
  }) as never;
  const clock = manualClock();
  const gate = new ClaudeStartGate({ now: clock.now, timers: clock.timers });
  gate.enterNow()!.answered();
  const process = await ClaudeChatProcess.start({ binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn, gate, timers: clock.timers });
  try {
    children[0]!.stdout.write(JSON.stringify({ type: 'system', subtype: 'peer_message', text: 'partner online' }) + '\n');
    children[0]!.stdout.write(JSON.stringify({ type: 'system', subtype: 'peer_message', text: 'partner online' }) + '\n');
    for (let i = 0; i < 400 && !rows.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(rows, [{ event: 'system', subtype: 'peer_message' }]);
  } finally { process.close(); }
});

test('the journal line holds the names and nothing else; a free-text name is not written', () => {
  const line = buildJournalEntry({ type: 'claude-stream-kind', characterId: 'gene', event: 'system', subtype: 'peer_message' }, Date.UTC(2026, 10, 25)) as Record<string, unknown>;
  assert.equal(line.event, 'system');
  assert.equal(line.subtype, 'peer_message');
  assert.match(describeJournalEntry(line as never, (source, ...values) => source.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)]))), /system\/peer_message/);
  assert.equal(buildJournalEntry({ type: 'claude-stream-kind', characterId: 'gene', event: 'partner online' }, 0), null);
  assert.equal(buildJournalEntry({ type: 'claude-stream-kind', characterId: 'gene', event: 'user', subtype: 'x' }, 0), null, 'a subtype only beside system');
});

test('the wiring journals each reported kind as a claude-stream-kind row for the character on stage', () => {
  // Reads as text (test-affected selects this test when it changes): 'electron/wiring/brain-wiring.ts'.
  const rows: unknown[] = [];
  const hook = expression<(kind: ClaudeStreamKind) => void>(wiringCallArguments('observeClaudeStreamKinds')[0]!,
    { appJournal: { record: (row: unknown) => { rows.push(row); } }, journalCharacterId: () => 'gene' });
  hook({ event: 'system', subtype: 'peer_message' });
  hook({ event: 'user' });
  assert.deepEqual(rows, [{ type: 'claude-stream-kind', characterId: 'gene', event: 'system', subtype: 'peer_message' }, { type: 'claude-stream-kind', characterId: 'gene', event: 'user' }]);
  for (const row of rows) assert.ok(buildJournalEntry(row, 0), 'the writer accepts the row');
});
