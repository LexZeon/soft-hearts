// A parent Claude Code session's plumbing never reaches her processes (docs/claude/2026-11-25-claude-env-from-session.md): the
// environment rule, the one journal row (names only), every Claude Code spawn going through claudeEnvironment, and discovery
// refusing the Claude desktop app's own copy with a plain message. No real Claude Code is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { claudeEnvironment, observeClaudeEnvironment, resetClaudeEnvironmentReport } from '../electron/brain/claude-env';
import { CLAUDE_DESKTOP_BUNDLED_MESSAGE } from '../electron/brain/claude';
import { ClaudeChatProcess } from '../electron/brain/claude-process';
import { ClaudeStartGate } from '../electron/brain/claude-start-gate';
import { assistantEnvironment } from '../electron/safety/assistant/process';
import { CLAUDE_SESSION_MARKERS, CLAUDE_SESSION_PLUMBING, claudeSessionMarkers, isSessionPlumbing, sessionPlumbingToDrop } from '../shared/brain/claude-session-env';
import { classifyClaudeFailure } from '../shared/brain/claude-failure';
import { describeOutage } from '../shared/brain/chat-availability';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import { discoverClaude, isDesktopBundledClaude } from '../scripts/claude-discovery.mjs';
import { claudeNextStep } from '../scripts/setup-platform.mjs';
import { manualClock } from './helpers/manual-clock';
import { expression } from './helpers/chat-world';
import { wiringCallArguments } from './helpers/wiring-source';

const ROOT = path.resolve(import.meta.dirname, '..');
const SECRET = 'sk-ant-secret-value-never-logged';
const PROXY = 'http://127.0.0.1:61234/desktop-proxy';
/** What a Claude desktop session's shell carried on 2026-11-25 (names; values made up). */
const DESKTOP_SESSION = {
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_MESSAGING_SOCKET: 'pipe',
  CLAUDE_CODE_DESKTOP_APP_VERSION: '1.0.0', ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: SECRET, ANTHROPIC_CUSTOM_HEADERS: `x-auth: ${SECRET}`,
};
const USER_OWN = { PATH: '/bin', ANTHROPIC_API_KEY: 'user-key', ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_OAUTH_TOKEN: 'user-token', CLAUDE_CONFIG_DIR: '/cfg', ANTHROPIC_MODEL: 'sonnet', HTTPS_PROXY: 'http://corp:8080' };

// ---------------------------------------------------------------- the rule

test('markers present: the session plumbing is dropped, its other wiring too, the user\'s non-credential settings stay', (t) => {
  t.after(resetClaudeEnvironmentReport);
  const env = claudeEnvironment({ ...USER_OWN, ...DESKTOP_SESSION });
  for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', ...Object.keys(DESKTOP_SESSION)])
    assert.equal(env[name], undefined, name);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg', 'where the user\'s own Claude Code keeps its settings and sign-in');
  assert.equal(env.ANTHROPIC_MODEL, 'sonnet', 'not a credential or endpoint');
  assert.equal(env.HTTPS_PROXY, 'http://corp:8080', 'a corporate proxy is the user\'s network, not the session\'s');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.ok(!JSON.stringify(env).includes(SECRET) && !JSON.stringify(env).includes(PROXY));
});

test('each marker alone counts; an empty marker does not; names are matched in any case (Windows)', () => {
  for (const marker of CLAUDE_SESSION_MARKERS) {
    assert.equal(claudeEnvironment({ [marker]: 'x', ANTHROPIC_BASE_URL: PROXY }).ANTHROPIC_BASE_URL, undefined, marker);
    assert.equal(claudeEnvironment({ [marker.toLowerCase()]: 'x', anthropic_base_url: PROXY }).anthropic_base_url, undefined, marker.toLowerCase());
  }
  assert.equal(claudeEnvironment({ CLAUDECODE: '  ', ANTHROPIC_BASE_URL: 'https://gateway.example' }).ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.deepEqual(claudeSessionMarkers({ claudecode: '1', CLAUDE_CODE_SSE_PORT: '9', OTHER: '1' }), ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT']);
});

test('no marker: the same variables are the user\'s deliberate global setting and are kept', () => {
  const env = claudeEnvironment({ ...USER_OWN });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(env.ANTHROPIC_API_KEY, 'user-key');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'user-token');
  assert.deepEqual(sessionPlumbingToDrop({ ...USER_OWN }), []);
});

test('plumbing: the fixed list plus any ANTHROPIC_* endpoint, token, key, header or socket name; model and provider switches are not', () => {
  for (const name of CLAUDE_SESSION_PLUMBING) assert.ok(isSessionPlumbing(name), name);
  for (const name of ['ANTHROPIC_SOME_NEW_URL', 'anthropic_extra_token', 'ANTHROPIC_X_API_KEY']) assert.ok(isSessionPlumbing(name), name);
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'HTTPS_PROXY', 'PATH']) assert.ok(!isSessionPlumbing(name), name);
});

test('the assistant\'s environment is the same helper\'s', () => {
  const env = assistantEnvironment({ ...DESKTOP_SESSION, PATH: '/bin' });
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
});

// ---------------------------------------------------------------- one journal row, names only

test('a drop is reported once per run with names only, also when the journal is attached after the first spawn; nothing is printed', (t) => {
  t.after(() => { observeClaudeEnvironment(null); resetClaudeEnvironmentReport(); });
  resetClaudeEnvironmentReport();
  observeClaudeEnvironment(null);
  const printed: unknown[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const key of Object.keys(saved) as (keyof typeof saved)[]) console[key] = (...args: unknown[]) => { printed.push(args); };
  try {
    claudeEnvironment({ ...DESKTOP_SESSION }); // before the journal exists (a spare at start)
    const rows: string[][] = [];
    observeClaudeEnvironment(names => rows.push(names));
    claudeEnvironment({ ...DESKTOP_SESSION });
    claudeEnvironment({ ...DESKTOP_SESSION, ANTHROPIC_API_KEY: SECRET });
    assert.deepEqual(rows, [['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS']]);
    assert.ok(!JSON.stringify(rows).includes(SECRET) && !JSON.stringify(rows).includes(PROXY));
  } finally { Object.assign(console, saved); }
  assert.deepEqual(printed, [], 'the helper never prints');
});

test('no drop, no row', (t) => {
  t.after(() => { observeClaudeEnvironment(null); resetClaudeEnvironmentReport(); });
  resetClaudeEnvironmentReport();
  const rows: string[][] = [];
  observeClaudeEnvironment(names => rows.push(names));
  claudeEnvironment({ ...USER_OWN });
  assert.deepEqual(rows, []);
});

test('the journal line holds plumbing names and nothing else; a value or another name is not written', () => {
  const line = buildJournalEntry({ type: 'claude-env-dropped', characterId: 'gene', names: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] }, Date.UTC(2026, 10, 25)) as Record<string, unknown>;
  assert.deepEqual(line.names, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.match(describeJournalEntry(line as never, (source, ...values) => source.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)]))), /ANTHROPIC_BASE_URL/);
  for (const names of [[PROXY], ['ANTHROPIC_BASE_URL=' + PROXY], ['PATH'], ['CLAUDECODE'], [], 'ANTHROPIC_BASE_URL'])
    assert.equal(buildJournalEntry({ type: 'claude-env-dropped', characterId: 'gene', names }, 0), null, JSON.stringify(names));
});

test('the wiring journals the reported names as one claude-env-dropped row for the character on stage', () => {
  // Reads as text (test-affected selects this test when it changes): 'electron/wiring/brain-wiring.ts'.
  const rows: unknown[] = [];
  const hook = expression<(names: string[]) => void>(wiringCallArguments('observeClaudeEnvironment')[0]!,
    { appJournal: { record: (row: unknown) => { rows.push(row); } }, journalCharacterId: () => 'gene' });
  hook(['ANTHROPIC_BASE_URL']);
  assert.deepEqual(rows, [{ type: 'claude-env-dropped', characterId: 'gene', names: ['ANTHROPIC_BASE_URL'] }]);
  for (const row of rows) assert.ok(buildJournalEntry(row, 0), 'the writer accepts the row');
});

// ---------------------------------------------------------------- every spawn goes through the helper

/**
 * Every place under electron/ that starts a Claude Code process, and the env expression it passes. A new file that starts a process
 * must be added here or to OTHER_PROCESSES (the scan below fails until it is).
 */
const CLAUDE_SPAWNS: { file: string; name: string; env: RegExp; spawns?: false }[] = [
  { file: 'electron/brain/claude.ts', name: 'one-shot chat and helpers (streamClaude)', env: /launchClaude\(binary, \[\.\.\.leadingArgs, \.\.\.args\], \{[^}]*env: claudeEnvironment\(\),/ },
  { file: 'electron/brain/claude-process.ts', name: 'long-lived chat, spare, voice', env: /\(options\.spawn \?\? launchClaude\)\([^;]*env: claudeEnvironment\(\),/ },
  { file: 'electron/safety/assistant/service.ts', name: 'Claude assistant', env: /spawn\(binary, args, \{[^}]*env: this\.options\.env\?\.\(\) \?\? assistantEnvironment\(\) \}\)/ },
  { file: 'electron/safety/assistant/process.ts', name: 'assistantEnvironment (the env the assistant spawn above uses)', spawns: false, env: /return \{ \.\.\.claudeEnvironment\(source\), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' \};/ },
  { file: 'electron/safety/claude-tasks/service.ts', name: 'task executor', env: /spawn\(binary, args, \{[^}]*env: \(this\.options\.environment \?\? claudeEnvironment\)\(\),/ },
  { file: 'electron/safety/agent-channel/electron-wiring.ts', name: 'claude mcp add/list, claude --version', env: /spawnClaudeRunner\(found\.path, claudeEnvironment\(\),/ },
  // Takes its env from the caller above; a spawn of its own with another env would fail the call check below.
  { file: 'electron/safety/agent-channel/claude-code-link.ts', name: 'the mcp runner itself', env: /spawn\(executable, \[\.\.\.prefix, \.\.\.args\], \{ env, shell: false/ },
];
/** Files that start processes that are not Claude Code (sense workers, PowerShell helpers, Codex, the relauncher). */
const OTHER_PROCESSES = [
  'electron/memory/memory-semantic/electron-wiring.ts', 'electron/memory/memory-semantic/host.ts', 'electron/memory/memory-semantic/protocol.ts', 'electron/memory/memory-semantic/worker.ts',
  'electron/mood/color-block-log.ts', 'electron/safety/claude-tasks/process.ts' /* taskkill of the task process */, 'electron/safety/codex.ts' /* Codex, frozen */,
  'electron/senses/asr/electron-wiring.ts', 'electron/senses/asr/host.ts', 'electron/senses/asr/protocol.ts', 'electron/senses/asr/worker.ts',
  'electron/senses/face/electron-wiring.ts', 'electron/senses/face/worker.ts', 'electron/senses/foreground-app.ts', 'electron/senses/now-playing/service.ts',
  'electron/senses/pose/electron-wiring.ts', 'electron/senses/pose/protocol.ts', 'electron/senses/pose/worker.ts',
  'electron/senses/voiceprint/electron-wiring.ts', 'electron/senses/voiceprint/worker.ts', 'electron/wiring/startup-wait-wiring.ts',
];

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await sourceFiles(relative));
    else if (/\.(ts|mts|cts|mjs|js)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

test('every file under electron/ that starts a process is listed, and every Claude Code spawn takes its env from claudeEnvironment', async () => {
  const starts = /from ['"](?:node:)?child_process['"]|\butilityProcess\b|\blaunchClaude\)?\(|spawnClaudeRunner\(/;
  const found: string[] = [];
  for (const file of await sourceFiles('electron')) {
    if (file.startsWith('electron/brain/claude-launch/')) continue; // the launcher: env comes from its callers, checked here
    const text = await readFile(path.join(ROOT, file), 'utf8');
    if (starts.test(text)) found.push(file);
    // Every launchClaude call and every spawnClaudeRunner call outside its definition passes the helper's env.
    const launches = (text.match(/\blaunchClaude\)?\(/g) ?? []).length;
    if (launches) assert.ok((text.match(/env: claudeEnvironment\(\)/g) ?? []).length >= launches, `${file}: a launchClaude call without env: claudeEnvironment()`);
    for (const call of text.matchAll(/spawnClaudeRunner\(([^,()]+), ([^,]+),/g))
      if (call[1] !== 'executable: string') assert.equal(call[2], 'claudeEnvironment()', `${file}: spawnClaudeRunner with another env`);
  }
  const listed = [...CLAUDE_SPAWNS.filter(spawn => spawn.spawns !== false).map(spawn => spawn.file), ...OTHER_PROCESSES];
  assert.deepEqual([...new Set(found)].sort(), [...new Set(listed)].sort(), 'a file that starts a process must be listed in CLAUDE_SPAWNS or OTHER_PROCESSES');
  for (const spawn of CLAUDE_SPAWNS) assert.match(await readFile(path.join(ROOT, spawn.file), 'utf8'), spawn.env, `${spawn.name} (${spawn.file})`);
});

test('the long-lived chat process, started where the app runs inside a Claude desktop session, gets no proxy or token', async (t) => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(DESKTOP_SESSION)) { saved[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } resetClaudeEnvironmentReport(); });
  let seen: NodeJS.ProcessEnv | undefined;
  const spawn = ((_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    seen = options.env;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { setImmediate(() => child.emit('close', null)); return true; } });
    return child;
  }) as never;
  const clock = manualClock();
  const gate = new ClaudeStartGate({ now: clock.now, timers: clock.timers });
  gate.enterNow()!.answered();
  const chat = await ClaudeChatProcess.start({ binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn, gate, timers: clock.timers });
  chat.close();
  assert.ok(seen);
  for (const name of Object.keys(DESKTOP_SESSION)) assert.equal(seen![name], undefined, name);
});

// ---------------------------------------------------------------- the desktop app's own copy

function fakeIo(files: string[], folders: string[] = []) {
  const all = new Set(files), dirs = new Set(folders);
  return {
    stat: async (file: string) => {
      if (all.has(file)) return { isFile: () => true, isDirectory: () => false };
      if (dirs.has(file)) return { isFile: () => false, isDirectory: () => true };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    access: async (file: string) => { if (!all.has(file)) throw new Error('missing'); },
  };
}
const BUNDLED = 'C:\\Users\\a\\AppData\\Roaming\\Claude\\claude-code\\2.1.330\\2b1a4f2fbd30\\claude.exe';
const OFFICIAL = 'C:\\Users\\a\\.local\\bin\\claude.exe';

test('a path inside the desktop app\'s versioned claude-code folder is the bundled copy; official installs are not', () => {
  for (const file of [BUNDLED, 'C:\\Users\\a\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code\\2.1.326\\x\\claude.exe',
    '/Users/a/Library/Application Support/Claude/claude-code/2.1.330/claude']) assert.ok(isDesktopBundledClaude(file), file);
  for (const file of [OFFICIAL, 'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
    '/home/a/.local/share/claude/versions/2.1.330', 'C:\\tools\\claude.exe', '/opt/homebrew/bin/claude']) assert.ok(!isDesktopBundledClaude(file), file);
});

test('discovery never returns the bundled copy: CLAUDE_PATH to it, PATH to it, or it being the only one gives desktop-bundled', async () => {
  const env = { USERPROFILE: 'C:\\Users\\a', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' };
  const io = fakeIo([BUNDLED]);
  assert.deepEqual(await discoverClaude({ platform: 'win32', env: { ...env, CLAUDE_PATH: BUNDLED }, io }), { status: 'desktop-bundled', path: null });
  assert.deepEqual(await discoverClaude({ platform: 'win32', env: { ...env, PATH: path.win32.dirname(BUNDLED) }, io }), { status: 'desktop-bundled', path: null });
  assert.deepEqual(await discoverClaude({ platform: 'win32', env: { ...env, PATH: '', CLAUDE_CODE_EXECPATH: BUNDLED }, io }), { status: 'desktop-bundled', path: null });
  // Launched normally (no session variables): the desktop app's folder alone says so.
  assert.deepEqual(await discoverClaude({ platform: 'win32', env: { ...env, PATH: '' }, io: fakeIo([], ['C:\\Users\\a\\AppData\\Roaming\\Claude\\claude-code']) }), { status: 'desktop-bundled', path: null });
  // An official install still wins, also when the bundled folder comes first on PATH.
  assert.deepEqual(await discoverClaude({ platform: 'win32', env: { ...env, PATH: path.win32.dirname(BUNDLED), CLAUDE_CODE_EXECPATH: BUNDLED }, io: fakeIo([BUNDLED, OFFICIAL]) }), { status: 'found', path: OFFICIAL });
  assert.deepEqual(await discoverClaude({ platform: 'win32', env: { ...env, PATH: '' }, io: fakeIo([]) }), { status: 'missing', path: null });
});

test('the app\'s message and the 连接 notice say plainly: install the official Claude Code and sign in once', () => {
  assert.match(CLAUDE_DESKTOP_BUNDLED_MESSAGE, /桌面应用自带/);
  assert.match(CLAUDE_DESKTOP_BUNDLED_MESSAGE, /官方 Claude Code（https:\/\/code\.claude\.com\/docs\/en\/setup）/);
  assert.match(CLAUDE_DESKTOP_BUNDLED_MESSAGE, /运行一次 claude 完成登录/);
  assert.equal(classifyClaudeFailure(CLAUDE_DESKTOP_BUNDLED_MESSAGE).kind, 'not-found', 'shows the not-found notice with its 说明 (setup page) button');
  const notice = describeOutage({ kind: 'not-found' });
  assert.match(notice.hint, /官方 Claude Code/);
  assert.match(notice.hint, /桌面应用自带的那一份不能单独用/);
  assert.ok(notice.actions.includes('help'));
  assert.match(claudeNextStep('desktop-bundled'), /official Claude Code \(https:\/\/code\.claude\.com\/docs\/en\/setup\)/);
});
