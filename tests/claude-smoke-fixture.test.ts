// The source smokes' synthetic Claude Code (scripts/lib/claude-smoke-fixture.mjs + fake-claude-relay.mjs):
// the relay protocol read by the app's real stream-json reader, the isolation environment, and a real
// relay process driven by the app's persistent Claude Code process through the harness interposer.
// No Electron is started here; the smokes themselves are maintainer-only and are not run by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import type { ChatMessage } from '../shared/contracts';
import { ClaudeStreamReader, claudeArguments, claudeInput, streamClaude } from '../electron/claude';
import { ClaudeChatProcess } from '../electron/claude-process';
import { CLAUDE_FOLLOW_UP_HEADER, CLAUDE_SESSION_SYSTEM_PROMPT, composeSessionPrompt } from '../electron/claude-session-prompt';
import { FAKE_CLAUDE_RELAY_MARKER, createRelayFakeClaude } from '../scripts/lib/fake-claude-relay.mjs';
import { FIXTURE_MAX_SPAWNS, createClaudeFixture, createClaudeIsolation, isolatedClaudeEnvironment, personaPart, readConversation, type FixtureTurn } from '../scripts/lib/claude-smoke-fixture.mjs';

const helper = await import(new URL('../scripts/lib/smoke-isolation.mjs', import.meta.url).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const user = (content: string): ChatMessage => ({ role: 'user', content });
const opening = (text: string, history: ChatMessage[] = []) => composeSessionPrompt({ plan: { opening: true, history }, basePersona: '合成角色', turnPersona: '合成角色\n\n本轮心情<sh-state-0123abcd>', current: user(text) });
const followUp = (text: string, history: ChatMessage[] = []) => composeSessionPrompt({ plan: { opening: false, history }, basePersona: '合成角色', turnPersona: '合成角色\n\n本轮心情', current: user(text) });
const png = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64');
// Waits for a real condition (a process started, a turn cancelled). 20 s: a kill took over 8 s once in a full suite on a busy machine.
const until = async (predicate: () => boolean, label = 'condition') => {
  const end = Date.now() + 20_000;
  while (!predicate()) { assert.ok(Date.now() < end, 'timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 20)); }
};

function relayHarness(args = claudeArguments({ model: 'haiku' }, CLAUDE_SESSION_SYSTEM_PROMPT)) {
  const events: Record<string, any>[] = [], toRunner: Record<string, any>[] = [];
  let idle = 0;
  const fake = createRelayFakeClaude({ args, output: event => events.push(event), relay: message => toRunner.push(message), idle: () => { idle++; } });
  // `verified`: this turn's init was emitted before `from` (as a long-lived process that already reported a clean init).
  const read = (from = 0, verified = false) => {
    const deltas: string[] = [];
    const reader = new ClaudeStreamReader((type, text) => { if (type === 'delta') deltas.push(text); }, { verified });
    for (const event of events.slice(from)) reader.consumeEvent(event);
    return { reader, deltas };
  };
  return { fake, events, toRunner, read, get idle() { return idle; } };
}
const userLine = (prompt: string, images: string[] = []) => claudeInput({ prompt, imageDataUrls: images });

test('relay fake: each turn goes to the runner, and the runner\'s stream reaches the app\'s reader exactly', () => {
  const rig = relayHarness();
  assert.deepEqual(rig.toRunner[0], { type: 'hello', spawn: 0, pid: 0, argvOk: true, reason: null, model: 'haiku', systemPrompt: CLAUDE_SESSION_SYSTEM_PROMPT, cwdEmpty: null });
  rig.fake.line(userLine(opening('你好'), [png]));
  const turn = rig.toRunner[1];
  assert.equal(turn.type, 'turn'); assert.equal(turn.seq, 1);
  assert.deepEqual(readConversation(turn.text), { opening: true, currentUser: '你好', history: [] });
  assert.deepEqual(turn.images, [{ mediaType: 'image/png', data: png.slice('data:image/png;base64,'.length) }]);
  rig.fake.fromRunner({ type: 'delta', seq: 1, text: '你好，' });
  rig.fake.fromRunner({ type: 'delta', seq: 2, text: 'NOT THIS TURN' });
  rig.fake.fromRunner({ type: 'delta', seq: 1, text: '我在。' });
  rig.fake.fromRunner({ type: 'done', seq: 1 });
  const { reader, deltas } = rig.read();
  assert.deepEqual(deltas, ['你好，', '我在。']); assert.equal(reader.output, '你好，我在。');
  assert.ok(reader.finished && !reader.failure && reader.initialized, 'init (no tools, no MCP) precedes the text, result ends the turn');
  assert.equal(rig.events.filter(event => event.type === 'result').length, 1);
  // Anything for a finished turn is dropped: nothing reaches the app after its result.
  const count = rig.events.length;
  rig.fake.fromRunner({ type: 'delta', seq: 1, text: 'late' }); rig.fake.fromRunner({ type: 'done', seq: 1 });
  assert.equal(rig.events.length, count);
});

test('relay fake: runner failures, interrupts, queued turns and a per-message stdin end', () => {
  const rig = relayHarness();
  rig.fake.line(userLine(followUp('坏')));
  rig.fake.fromRunner({ type: 'fail', seq: 1, message: 'SYNTHETIC_REPLY_ERROR' });
  let read = rig.read();
  assert.equal(read.reader.failure, 'SYNTHETIC_REPLY_ERROR', 'the app shows the synthetic message through claudeFailure');
  // Interrupt: control response, the cancel goes to the runner, then a closing result; late runner output is dropped.
  let from = rig.events.length;
  rig.fake.line(userLine(followUp('WAIT')));
  rig.fake.fromRunner({ type: 'delta', seq: 2, text: '部分' });
  rig.fake.line(JSON.stringify({ type: 'control_request', request_id: 'interrupt-1', request: { subtype: 'interrupt' } }));
  assert.deepEqual(rig.toRunner.at(-1), { type: 'cancel', seq: 2, reason: 'interrupt' });
  assert.deepEqual(rig.events.find(event => event.type === 'control_response')?.response, { subtype: 'success', request_id: 'interrupt-1' });
  assert.equal(rig.events.at(-1)!.type, 'result');
  from = rig.events.length;
  rig.fake.fromRunner({ type: 'delta', seq: 2, text: 'late' }); rig.fake.fromRunner({ type: 'done', seq: 2 });
  assert.equal(rig.events.length, from);
  // A second message while one is open waits its turn.
  rig.fake.line(userLine(followUp('一')));
  rig.fake.line(userLine(followUp('二')));
  assert.deepEqual(rig.toRunner.filter(message => message.type === 'turn').map(message => readConversation(message.text)?.currentUser), ['坏', 'WAIT', '一']);
  rig.fake.fromRunner({ type: 'delta', seq: 3, text: 'A' }); rig.fake.fromRunner({ type: 'done', seq: 3 });
  assert.equal(rig.toRunner.at(-1)!.seq, 4);
  // A per-message process ends stdin right after its message: the open turn still finishes, then the fake goes idle.
  rig.fake.close();
  assert.equal(rig.idle, 0);
  from = rig.events.length;
  rig.fake.fromRunner({ type: 'delta', seq: 4, text: 'B' }); rig.fake.fromRunner({ type: 'done', seq: 4 });
  read = rig.read(from, true);
  assert.equal(read.reader.output, 'B'); assert.equal(rig.idle, 1);
});

test('relay fake refuses a weakened argv like the packaging fake, and never asks the runner', () => {
  const args = claudeArguments({ model: 'haiku' }).filter(value => value !== '--safe-mode');
  const rig = relayHarness(args);
  assert.equal(rig.toRunner[0].argvOk, false);
  rig.fake.line(userLine(opening('你好')));
  assert.equal(rig.toRunner.filter(message => message.type === 'turn').length, 0);
  assert.match(rig.read().reader.failure, /claude update/);
});

test('isolation environment drops inherited Claude/Codex variables and names only owned paths', () => {
  const owned = { codexHome: 'H', sentinel: 'S', claudeHome: 'C', claudePlaceholder: 'P' };
  const env = isolatedClaudeEnvironment({ PATH: 'x', CLAUDECODE: '1', claude_code_entrypoint: 'cli', CLAUDE_CONFIG_DIR: 'real', CODEX_PATH: 'real-codex', CODEX_HOME: 'real-home',
    ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_MODEL: 'kept-not-used', MMD_DESK_USER_DATA: 'profile' }, owned);
  assert.deepEqual(env, { PATH: 'x', ANTHROPIC_MODEL: 'kept-not-used', MMD_DESK_USER_DATA: 'profile', CODEX_HOME: 'H', CODEX_PATH: 'S', CLAUDE_PATH: 'P', CLAUDE_CONFIG_DIR: 'C' });
  assert.throws(() => isolatedClaudeEnvironment({}, { ...owned, claudeHome: undefined } as never), /Owned child path/);
  assert.equal(readConversation('no data'), null);
});

function vmInstance(spawnImpl: Function) {
  const module = { spawn: spawnImpl };
  const context = createContext({ electron: {}, process: { platform: process.platform, getBuiltinModule: (name: string) =>
    name === 'node:child_process' ? module : name === 'node:path' ? path : name === 'node:module' ? { syncBuiltinESMExports() {} } : undefined } });
  // Like Playwright's evaluate: the function runs in the other realm and only serialized data comes back.
  const instance = { evaluate: async (fn: Function, arg?: unknown) => {
    (context as Record<string, unknown>).expected = arg;
    const value = runInContext(`(${fn.toString()})(electron, expected)`, context);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } };
  return { module, context, instance };
}

test('interposer launch limit: the packaging smoke keeps 8, source smokes may raise it', () => {
  const args = claudeArguments({ model: 'haiku' });
  const options = { cwd: path.join(os.tmpdir(), 'soft-hearts-claude', 'claude-chat', 'turn-x'), shell: false, windowsHide: true, env: { NO_COLOR: '1', DISABLE_AUTOUPDATER: '1' } };
  for (const [maxSpawns, allowed] of [[undefined, 8], [FIXTURE_MAX_SPAWNS, FIXTURE_MAX_SPAWNS], [0, 8], [10_000, 8]] as const) {
    let calls = 0;
    const rig = vmInstance(() => { calls++; return { pid: 1 }; });
    const placeholder = path.join(os.tmpdir(), 'soft-hearts-smoke-limit', 'claude-placeholder.exe');
    runInContext(`(${helper.installClaudeInterposer.toString()})(electron, ${JSON.stringify({ marker: 'm', claudePlaceholder: placeholder, claudeHome: 'h', fakeLog: 'l', fakeNode: 'n', fakeScript: 's', fakeMarker: 'k', maxSpawns })})`, rig.context);
    for (let index = 0; index < allowed; index++) rig.module.spawn(placeholder, args, options);
    assert.throws(() => rig.module.spawn(placeholder, args, options), /too many Claude Code processes/);
    assert.equal(calls, allowed, String(maxSpawns));
  }
});

test('a real relay process serves the app\'s persistent Claude Code process: reply, interrupt, image, failure, kill', { timeout: 30_000 }, async () => {
  const owned = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-fixture-test-')));
  const owns = (key: string) => key.toUpperCase().startsWith('CLAUDE') || key.toUpperCase().startsWith('CODEX_');
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => owns(key)));
  let chat: ClaudeChatProcess | null = null, second: ClaudeChatProcess | null = null, closed: { fakeClaudeExited: boolean; claudeHomeEmpty: boolean } | null = null;
  const fixture = await createClaudeFixture({ root: owned, respond: (turn: FixtureTurn) => {
    if (turn.currentUser === 'WAIT') return undefined;
    if (turn.currentUser === '坏') return void turn.fail('SYNTHETIC_REPLY_ERROR');
    if (turn.images.length) return [`图片${turn.images.length}`, turn.images[0].mediaType];
    if (turn.currentUser === 'THROW') throw Error('not declared');
    return ['你好，', `收到${turn.currentUser}`, turn.nonce() ?? ''];
  } });
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    Object.assign(process.env, fixture.environment({}));
    const rig = vmInstance(realSpawn);
    await fixture.install(rig.instance);
    const spawn = rig.module.spawn as typeof realSpawn;
    chat = await ClaudeChatProcess.start({ binary: fixture.claudePlaceholder, model: 'haiku', systemPrompt: CLAUDE_SESSION_SYSTEM_PROMPT, spawn });
    const deltas: string[] = [];
    const emit = (type: string, text: string) => { if (type === 'delta') deltas.push(text); };
    assert.equal(await chat.run(claudeInput({ prompt: opening('一') }), new AbortController().signal, emit), '你好，收到一0123abcd');
    assert.deepEqual(deltas, ['你好，', '收到一', '0123abcd']);
    // Held turn, interrupted by the app: the runner sees the cancel and later output is dropped.
    const stop = new AbortController();
    const held = chat.run(claudeInput({ prompt: followUp('WAIT', [{ role: 'assistant', content: '你好，收到一' }]) }), stop.signal, emit);
    const waiting = await fixture.waitForTurn(turn => turn.currentUser === 'WAIT');
    assert.deepEqual([waiting.opening, waiting.history.length, waiting.spawn], [false, 1, 0]);
    stop.abort(new Error('已停止。'));
    await assert.rejects(held, /已停止/);
    await until(() => waiting.cancelled, 'interrupt reached the runner');
    assert.equal(waiting.cancelReason, 'interrupt'); assert.equal(waiting.delta('late'), false);
    await chat.settled();
    assert.ok(chat.alive && !chat.busy, 'The interrupted turn drained; the process stays warm.');
    assert.equal(await chat.run(claudeInput({ prompt: followUp('二', []), imageDataUrls: [png] }), new AbortController().signal, emit), '图片1image/png');
    // A synthetic failure is shown as the app's error and ends that process; a respond() error is recorded.
    await assert.rejects(chat.run(claudeInput({ prompt: followUp('坏') }), new AbortController().signal, emit), /SYNTHETIC_REPLY_ERROR/);
    assert.equal(chat.alive, false);
    second = await ClaudeChatProcess.start({ binary: fixture.claudePlaceholder, model: 'haiku', systemPrompt: CLAUDE_SESSION_SYSTEM_PROMPT, spawn });
    await assert.rejects(second.run(claudeInput({ prompt: opening('THROW') }), new AbortController().signal, emit), /not declared/);
    assert.deepEqual(fixture.errors, ['respond turn 5: not declared']); fixture.errors.length = 0;
    // The app killing a process mid-turn (quit, new conversation) cancels that turn for the runner.
    const third = await ClaudeChatProcess.start({ binary: fixture.claudePlaceholder, model: 'haiku', systemPrompt: CLAUDE_SESSION_SYSTEM_PROMPT, spawn });
    const killed = third.run(claudeInput({ prompt: opening('WAIT') }), new AbortController().signal, emit).catch(error => error);
    const orphan = await fixture.waitForTurn(turn => turn.currentUser === 'WAIT' && turn.spawn === 2);
    third.close();
    await until(() => orphan.cancelled, 'killed process cancels its turn');
    assert.equal(orphan.cancelReason, 'closed'); assert.match(String(await killed), /角色或对话已改变/);
    const evidence = await fixture.evidence(rig.instance) as { spawned: Array<{ model: string; findings: Record<string, boolean> }>; denied: string[] };
    assert.deepEqual(evidence.denied, []);
    assert.equal(evidence.spawned.length, 3);
    for (const record of evidence.spawned) assert.deepEqual({ model: record.model, configDirMatches: record.findings.configDirMatches, sessionVariables: record.findings.sessionVariables },
      { model: 'haiku', configDirMatches: true, sessionVariables: 0 });
    fixture.assertClean();
    assert.equal(fixture.spawns.length, 3);
    chat.close(); second.close();
    closed = await fixture.close();
    assert.deepEqual(closed, { fakeClaudeExited: true, claudeHomeEmpty: true }, 'Every fake exited and none wrote a Claude Code config.');
    assert.ok(fixture.spawns.every(record => record.closed));
  } finally {
    chat?.close(); second?.close();
    if (!closed) await fixture.close();
    for (const key of Object.keys(process.env)) if (owns(key)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(owned, { recursive: true, force: true });
  }
});

test('the relay also serves the one-process-per-message fallback', { timeout: 20_000 }, async () => {
  const owned = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-fixture-test-')));
  const fixture = await createClaudeFixture({ root: owned, respond: turn => ['单次', turn.currentUser ?? ''] });
  try {
    // Node runs the relay directly (the test-only leading arguments), so this also runs on Windows.
    const relayScript = path.join(root, 'scripts', 'lib', 'fake-claude-relay.mjs');
    const deltas: string[] = [];
    await streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: owned, writable: false, prompt: opening('你好') }, new AbortController().signal,
      (type, text) => { if (type === 'delta') deltas.push(text); }, process.execPath,
      [relayScript, FAKE_CLAUDE_RELAY_MARKER, path.join(fixture.fakeLog, 'spawn-0.jsonl')]);
    assert.deepEqual(deltas, ['单次', '你好']);
    fixture.assertClean();
  } finally {
    assert.equal((await fixture.close()).fakeClaudeExited, true);
    await rm(owned, { recursive: true, force: true });
  }
});

test('isolation-only folders and the Chat Completions-style view used by migrated smokes', async () => {
  const isolation = await createClaudeIsolation();
  try {
    assert.ok(path.basename(path.dirname(isolation.base)).startsWith('soft-hearts-claude-fixture-'), 'an owned temp root is created when none is given');
    assert.equal(await readFile(isolation.claudePlaceholder, 'utf8'), helper.CLAUDE_PLACEHOLDER_TEXT, 'the inert CLAUDE_PATH placeholder');
    assert.deepEqual(await readdir(isolation.claudeHome), []); assert.equal(await isolation.claudeHomeEmpty(), true);
    await assert.rejects(readFile(isolation.sentinel), { code: 'ENOENT' }, 'CODEX_PATH names a file that does not exist');
    const env = isolation.environment({ PATH: 'p', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    assert.deepEqual(env, { PATH: 'p', CODEX_HOME: isolation.codexHome, CODEX_PATH: isolation.sentinel, CLAUDE_PATH: isolation.claudePlaceholder, CLAUDE_CONFIG_DIR: isolation.claudeHome });
    assert.deepEqual(isolation.provider, { kind: 'claude', model: 'haiku' });
  } finally { await rm(path.dirname(isolation.base), { recursive: true, force: true }); }
  const history: ChatMessage[] = [{ role: 'assistant', content: '问候' }];
  const text = opening('现在', history);
  assert.equal(personaPart(text), '合成角色\n\n本轮心情<sh-state-0123abcd>');
  assert.equal(personaPart(followUp('再来')).startsWith(CLAUDE_FOLLOW_UP_HEADER), true);
  assert.deepEqual(readConversation(text), { opening: true, currentUser: '现在', history });
});

test('every source smoke uses the Claude-only isolation; none drives the retired OpenAI-compatible fixture', async () => {
  const scripts = (await readdir(path.join(root, 'scripts'))).filter(name => name.endsWith('-smoke.mjs'));
  assert.ok(scripts.length >= 30);
  for (const name of scripts) {
    const text = await readFile(path.join(root, 'scripts', name), 'utf8');
    if (name === 'motion-library-smoke.mjs') { assert.match(text, /import\('\.\/bundled-assets-smoke\.mjs'\)/); continue; }
    assert.ok(text.includes('./lib/claude-smoke-fixture.mjs'), `${name} sets CODEX_PATH/CLAUDE_PATH/CLAUDE_CONFIG_DIR through claude-smoke-fixture`);
    assert.doesNotMatch(text, /kind: ['"](?:openai|ollama)['"]|\/v1\/chat\/completions['"]|['"]\/v1\/models['"]/, `${name} still uses the retired OpenAI-compatible chat fixture`);
    if (text.includes('createClaudeFixture(')) assert.match(text, /\.install\((?:instance|app)\)/, `${name} installs the fake Claude Code into the app it launched`);
  }
  for (const retired of ['codex-tasks-smoke.mjs', 'model-physics-persistence-smoke.mjs', 'conversation-experience-smoke.mjs']) assert.ok(!scripts.includes(retired), retired);
});

test('the relay fake and its fixture stay maintainer-only: no product file or packaged path refers to them', async () => {
  const product: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative); else if (/\.(?:ts|mts|js|mjs|html|css)$/.test(entry.name)) product.push(relative);
    }
  };
  for (const directory of ['electron', 'src', 'shared']) await walk(directory);
  for (const file of product) {
    const text = await readFile(path.join(root, file), 'utf8');
    for (const needle of ['fake-claude-relay', 'claude-smoke-fixture', FAKE_CLAUDE_RELAY_MARKER]) assert.ok(!text.includes(needle), `${file} mentions ${needle}`);
  }
  assert.notEqual(process.argv[2], FAKE_CLAUDE_RELAY_MARKER);
});
