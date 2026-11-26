// I-202 (docs/claude/2026-11-23-claude-login-race.md): the start gate for Claude Code processes. After the app starts (and after a long
// quiet stretch) only one process may be starting or making its first request until one has answered; a failure or a silent holder lets
// the next one go; a lost login pauses new starts. Fake spawns and a manual clock: no CLI, no network, no real time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ClaudeFailureError, streamClaude } from '../electron/brain/claude';
import { CLAUDE_START_GATE, ClaudeGateWatch, ClaudeStartGate, ClaudeStartPausedError, apiStreamLine, loginLost, type ClaudeGatePass } from '../electron/brain/claude-start-gate';
import { ClaudeChatProcess, ClaudeTurnError } from '../electron/brain/claude-process';
import { manualClock } from './helpers/manual-clock';

const LOGIN_LOST = 'Not logged in · Please run /login';
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function gateOn() {
  const clock = manualClock();
  const events: string[] = [];
  const gate = new ClaudeStartGate({ now: clock.now, timers: clock.timers });
  gate.observe(event => events.push(event));
  return { clock, gate, events };
}

/** Five callers at once; which of them have been let through so far. */
function five(gate: ClaudeStartGate) {
  const passes: (ClaudeGatePass | null)[] = [null, null, null, null, null];
  const errors: unknown[] = [null, null, null, null, null];
  for (let i = 0; i < 5; i++) gate.enter().then(pass => { passes[i] = pass; }, error => { errors[i] = error; });
  return { passes, errors, through: () => passes.filter(Boolean).length };
}

test('cold start with five callers: strictly one at a time until the first answer, then all the rest at once', async () => {
  const { gate } = gateOn();
  const callers = five(gate);
  await flush();
  assert.equal(callers.through(), 1, 'only the first may start while the gate is cold');
  assert.equal(callers.passes[0]!.holding, true);
  // The first one ends without an answer (closed early): the next goes, still alone.
  callers.passes[0]!.release();
  await flush();
  assert.equal(callers.through(), 2);
  assert.equal(callers.passes[1]!.holding, true);
  assert.equal(gate.snapshot().waiting, 3);
  // The second one answers: the login works, everyone else goes together.
  callers.passes[1]!.answered();
  await flush();
  assert.equal(callers.through(), 5);
  assert.deepEqual(gate.snapshot(), { state: 'warm', holding: false, waiting: 0 });
});

test('a recent success keeps the gate open (parallel as before); a long quiet stretch closes it again', async () => {
  const { gate, clock } = gateOn();
  gate.enterNow()!.answered();
  const callers = five(gate);
  await flush();
  assert.equal(callers.through(), 5, 'warm: nobody waits');
  assert.ok(callers.passes.every(pass => pass && !pass.holding));
  // Every success keeps it warm; 30 minutes without one makes it cold.
  clock.advance(CLAUDE_START_GATE.freshMs - 1);
  callers.passes[3]!.answered();
  clock.advance(CLAUDE_START_GATE.freshMs - 1);
  assert.equal(gate.warm, true);
  clock.advance(2);
  assert.equal(gate.warm, false);
  const after = five(gate);
  await flush();
  assert.equal(after.through(), 1);
});

test('the first process fails: the next one goes at once (no clock needed, nothing hangs)', async () => {
  const { gate } = gateOn();
  const callers = five(gate);
  await flush();
  callers.passes[0]!.failed('API Error: 500 {"type":"error","error":{"type":"api_error"}}');
  await flush();
  assert.equal(callers.through(), 2, 'a failed first process releases the gate');
  callers.passes[1]!.failed("Can't reach the API server");
  await flush();
  assert.equal(callers.through(), 3);
  assert.equal(gate.snapshot().state, 'cold');
});

test('a holder that says nothing is let go after the hold limit; a process with no request yet after the shorter one', async () => {
  const { gate, clock } = gateOn();
  const idle = gate.enterNow({ holdMs: CLAUDE_START_GATE.idleHoldMs })!;
  const callers = five(gate);
  await flush();
  assert.equal(callers.through(), 0);
  clock.advance(CLAUDE_START_GATE.idleHoldMs);
  await flush();
  assert.equal(idle.holding, false);
  assert.equal(callers.through(), 1);
  clock.advance(CLAUDE_START_GATE.holdMs - 1);
  await flush();
  assert.equal(callers.through(), 1);
  clock.advance(1);
  await flush();
  assert.equal(callers.through(), 2);
  // A pass that was let go may still answer later: that opens the gate for everyone.
  idle.answered();
  await flush();
  assert.equal(callers.through(), 5);
});

test('renew: a first turn on a process that held the gate while idle gets the full hold', async () => {
  const { gate, clock } = gateOn();
  const pass = gate.enterNow({ holdMs: CLAUDE_START_GATE.idleHoldMs })!;
  clock.advance(CLAUDE_START_GATE.idleHoldMs - 1);
  pass.renew();
  clock.advance(CLAUDE_START_GATE.holdMs - 1);
  assert.equal(pass.holding, true);
  clock.advance(1);
  assert.equal(pass.holding, false);
});

test('a lost login: no new starts for the pause, waiters get the login failure, one journal word; then one goes alone again', async () => {
  const { gate, clock, events } = gateOn();
  const callers = five(gate);
  await flush();
  callers.passes[0]!.failed(LOGIN_LOST);
  await flush();
  assert.equal(callers.through(), 1);
  assert.ok(callers.errors.slice(1).every(error => error instanceof ClaudeStartPausedError && error.detail === LOGIN_LOST));
  assert.deepEqual(events, ['login-lost']);
  assert.throws(() => gate.enterNow(), ClaudeStartPausedError);
  await assert.rejects(gate.enter(), ClaudeStartPausedError);
  clock.advance(CLAUDE_START_GATE.loginPauseMs - 1);
  assert.throws(() => gate.enterNow(), ClaudeStartPausedError);
  clock.advance(1);
  const retry = gate.enterNow();
  assert.ok(retry?.holding, 'after the pause the gate is cold: one try alone');
  assert.equal(gate.enterNow(), null);
  // Still logged out: another pause, but no second journal row for the same lost login.
  retry!.failed(LOGIN_LOST);
  assert.deepEqual(events, ['login-lost']);
  // The user's own "Retry" lifts the pause at once.
  gate.resume();
  const lifted = gate.enterNow();
  assert.ok(lifted?.holding);
  lifted!.answered();
  assert.equal(gate.snapshot().state, 'warm');
  // A new lost login after a success is a new row.
  gate.enterNow()!.failed('OAuth token has expired. Please obtain a new token or refresh your existing token.');
  assert.deepEqual(events, ['login-lost', 'login-lost']);
});

test('a lost login while warm also pauses; other failures (quota, network) do not', () => {
  const { gate } = gateOn();
  gate.enterNow()!.answered();
  gate.enterNow()!.failed("You've hit your session limit · resets 11:59pm (please run /login to switch accounts)");
  gate.enterNow()!.failed("Can't reach the API server");
  assert.equal(gate.snapshot().state, 'warm');
  gate.enterNow()!.failed('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}');
  assert.equal(gate.snapshot().state, 'paused');
});

test('waiting can be stopped: the waiter leaves the line and the next one still goes', async () => {
  const { gate } = gateOn();
  const holder = gate.enterNow()!;
  const controller = new AbortController();
  const stopped = gate.enter({ signal: controller.signal });
  const next = gate.enter();
  controller.abort(new Error('stop'));
  await assert.rejects(stopped, /stop/);
  holder.release();
  assert.equal((await next).holding, true);
});

test('the helpers read the failure and the stream the same way the rest of the app does', () => {
  assert.equal(loginLost(LOGIN_LOST), true);
  assert.equal(loginLost('Invalid API key · Please run /login'), true);
  assert.equal(loginLost("You've hit your session limit · resets 11:59pm"), false);
  assert.equal(loginLost(''), false);
  assert.equal(apiStreamLine('{"type":"stream_event","event":{"type":"message_start"}}'), true);
  assert.equal(apiStreamLine('{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}'), false);
  assert.equal(apiStreamLine('{"type":"assistant","message":{"content":[{"type":"stream_event"}]}}'), false);
});

test('the watch the assistant and tasks use: the first streaming line answers; a failed result with a lost login pauses', () => {
  const { gate } = gateOn();
  const first = new ClaudeGateWatch(gate.enterNow()!);
  first.line('{"type":"system","subtype":"init","tools":[],"mcp_servers":[]}');
  assert.equal(gate.snapshot().state, 'cold');
  first.line('{"type":"stream_event","event":{"type":"message_start"}}');
  assert.equal(gate.snapshot().state, 'warm');
  first.end(false);
  const lost = new ClaudeGateWatch(gate.enterNow()!);
  lost.line(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: LOGIN_LOST }));
  lost.end(true, 'some stderr');
  lost.end(true, 'again');
  assert.equal(gate.snapshot().state, 'paused');
  // A failure whose only text is stderr is read too.
  const { gate: other } = gateOn();
  const viaStderr = new ClaudeGateWatch(other.enterNow()!);
  viaStderr.end(true, 'Invalid API key · Please run /login');
  assert.equal(other.snapshot().state, 'paused');
});

// ---------------------------------------------------------------- one-shot calls (streamClaude) with a stand-in Claude Code script

async function fakeOneShot(lines: string[]): Promise<{ script: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-gate-fake-'));
  const script = path.join(root, 'fake-claude.cjs');
  await writeFile(script, `process.stdin.resume(); process.stdin.on('end', () => { for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + '\\n'); });`);
  return { script, root };
}
const task = { kind: 'chat' as const, model: '', workingDirectory: os.tmpdir(), writable: false, prompt: '你好' };

test('a one-shot call waits at a cold gate held by another process, and goes when that one lets go', async () => {
  const { gate } = gateOn();
  const fake = await fakeOneShot([INIT, DELTA('好'), RESULT]);
  try {
    const holder = gate.enterNow()!;
    let done = false;
    const call = streamClaude(task, new AbortController().signal, () => {}, process.execPath, [fake.script], { gate }).finally(() => { done = true; });
    await pause(400);
    assert.equal(done, false, 'no process may start while another holds the cold gate');
    holder.release();
    await call;
    assert.equal(gate.snapshot().state, 'warm', 'its answer opened the gate');
  } finally { await rm(fake.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('a one-shot call that finds the login gone pauses the gate; the next call fails with the same text without starting', async () => {
  const { gate, events } = gateOn();
  const fake = await fakeOneShot([INIT, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: LOGIN_LOST })]);
  try {
    await assert.rejects(streamClaude(task, new AbortController().signal, () => {}, process.execPath, [fake.script], { gate }), /未登录/);
    assert.deepEqual(events, ['login-lost']);
    await assert.rejects(streamClaude(task, new AbortController().signal, () => {}, process.execPath, [path.join(fake.root, 'missing.cjs')], { gate }),
      (error: unknown) => error instanceof ClaudeFailureError && error.detail === LOGIN_LOST, 'refused at the gate: the missing script was never run');
  } finally { await rm(fake.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

// ---------------------------------------------------------------- the persistent process (ClaudeChatProcess) with fake spawns

const INIT = JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
const START = JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } });
const DELTA = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false });

interface FakeChild extends EventEmitter { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; written: string[]; kill(): boolean }

function fakeSpawns() {
  const children: FakeChild[] = [];
  const spawn = (() => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.written = [];
    child.stdin.on('data', chunk => child.written.push(String(chunk)));
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
    children.push(child);
    return child;
  }) as unknown as NonNullable<Parameters<typeof ClaudeChatProcess.start>[0]['spawn']>;
  const say = (child: FakeChild, ...lines: string[]) => { for (const line of lines) child.stdout.write(line + '\n'); };
  return { children, spawn, say };
}

const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => new Promise(resolve => setImmediate(resolve));
/** Real I/O (the temp folder) sits between the gate and the spawn: wait for what the test expects, then a little longer for what it must not see. */
async function until(check: () => boolean, extraMs = 60): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, extraMs));
}

test('five chat processes at a cold start: one spawns and asks first; the rest spawn only after its first answer', async () => {
  const { gate, clock } = gateOn();
  const fake = fakeSpawns();
  const options = { binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn: fake.spawn, gate, timers: clock.timers };
  const turns = Array.from({ length: 5 }, () => ClaudeChatProcess.start(options).then(process =>
    process.run(JSON.stringify({ type: 'user', message: { role: 'user', content: '在吗' } }) + '\n', new AbortController().signal, () => {})));
  await until(() => fake.children.length >= 1 && fake.children[0]!.written.length >= 1);
  assert.equal(fake.children.length, 1, 'cold: only one Claude Code process is started');
  assert.equal(fake.children[0]!.written.length, 1, 'and it asks');
  fake.say(fake.children[0]!, INIT, START);
  await until(() => fake.children.length === 5 && fake.children.every(child => child.written.length === 1), 0);
  assert.equal(fake.children.length, 5, 'its first answer lets all the others start at once');
  for (const child of fake.children.slice(1)) assert.equal(child.written.length, 1);
  for (const child of fake.children) fake.say(child, INIT, DELTA('在'), RESULT);
  assert.deepEqual(await Promise.all(turns), Array(5).fill('在'));
});

test('a chat process whose first turn fails lets the next one go; nothing hangs', async () => {
  const { gate, clock } = gateOn();
  const fake = fakeSpawns();
  const options = { binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn: fake.spawn, gate, timers: clock.timers };
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content: '在吗' } }) + '\n';
  const first = ClaudeChatProcess.start(options).then(process => process.run(input, new AbortController().signal, () => {}));
  const second = ClaudeChatProcess.start(options);
  await until(() => fake.children.length >= 1 && fake.children[0]!.written.length >= 1);
  assert.equal(fake.children.length, 1);
  fake.say(fake.children[0]!, INIT, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 500 overloaded server' }));
  await assert.rejects(first, ClaudeTurnError);
  await until(() => fake.children.length >= 2, 0); // the manual clock never moves: only the failure can let it go
  assert.equal(fake.children.length, 2, 'the failure released the gate');
  (await second).close();
});

test('a spare that is started and asked nothing holds a cold gate only for the short limit', async () => {
  const { gate, clock } = gateOn();
  const fake = fakeSpawns();
  const options = { binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn: fake.spawn, gate, timers: clock.timers };
  const spare = await ClaudeChatProcess.start(options);
  const next = ClaudeChatProcess.start(options);
  await pause();
  assert.equal(fake.children.length, 1);
  clock.advance(CLAUDE_START_GATE.idleHoldMs);
  await until(() => fake.children.length >= 2, 0);
  assert.equal(fake.children.length, 2);
  // The spare's first turn later, while the second process holds the cold gate: it waits (writes nothing) until that one answers.
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content: '在吗' } }) + '\n';
  const turn = spare.run(input, new AbortController().signal, () => {});
  await pause();
  assert.equal(fake.children[0]!.written.length, 0, 'cold and held by another: the message waits at the gate');
  assert.equal(spare.busy, true);
  (await next).close();
  await until(() => fake.children[0]!.written.length >= 1, 0);
  assert.equal(fake.children[0]!.written.length, 1, 'the holder let go: the spare goes');
  fake.say(fake.children[0]!, INIT, DELTA('嗯'), RESULT);
  assert.equal(await turn, '嗯');
  spare.close();
});

test('warm: a turn is written at once, in the same call, exactly as before the gate', async () => {
  const { gate, clock } = gateOn();
  gate.enterNow()!.answered();
  const fake = fakeSpawns();
  const process = await ClaudeChatProcess.start({ binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn: fake.spawn, gate, timers: clock.timers });
  const child = fake.children[0]!;
  let writes = 0;
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = ((...args: Parameters<typeof write>) => { writes++; return write(...args); }) as typeof child.stdin.write;
  const turn = process.run('{"type":"user"}\n', new AbortController().signal, () => {});
  assert.equal(writes, 1, 'written synchronously inside runTurn, no wait at all');
  await settle();
  assert.equal(child.written.length, 1);
  fake.say(fake.children[0]!, INIT, DELTA('好'), RESULT);
  assert.equal(await turn, '好');
  process.close();
});

test('a turn stopped while it waits at the gate writes nothing and leaves the process usable', async () => {
  const { gate, clock } = gateOn();
  const fake = fakeSpawns();
  const holder = gate.enterNow()!; // someone else holds the cold gate
  const spareStart = ClaudeChatProcess.start({ binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn: fake.spawn, gate, timers: clock.timers });
  holder.release();
  const spare = await spareStart;
  clock.advance(CLAUDE_START_GATE.idleHoldMs); // the spare's idle hold ends
  const other = gate.enterNow()!; // another process holds it now
  const controller = new AbortController();
  const turn = spare.run('{"type":"user"}\n', controller.signal, () => {});
  controller.abort(new Error('停'));
  await assert.rejects(turn, /停/);
  await settle();
  assert.equal(fake.children[0]!.written.length, 0, 'no message and no interrupt request were written');
  assert.equal(spare.busy, false);
  assert.equal(spare.alive, true);
  other.release();
  spare.close();
});

test('a lost login: a chat process start fails with the login text and spawns nothing during the pause', async () => {
  const { gate, clock, events } = gateOn();
  const fake = fakeSpawns();
  const options = { binary: 'claude', model: 'sonnet', systemPrompt: '你好', spawn: fake.spawn, gate, timers: clock.timers };
  const first = await ClaudeChatProcess.start(options);
  const turn = first.run('{"type":"user"}\n', new AbortController().signal, () => {});
  await settle();
  fake.say(fake.children[0]!, INIT, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: LOGIN_LOST }));
  await assert.rejects(turn, (error: unknown) => error instanceof ClaudeTurnError && /未登录/.test(error.message) && error.detail === LOGIN_LOST);
  assert.deepEqual(events, ['login-lost']);
  await assert.rejects(ClaudeChatProcess.start(options), (error: unknown) => error instanceof ClaudeTurnError && error.kind === 'failed' && error.detail === LOGIN_LOST);
  assert.equal(fake.children.length, 1, 'no new process during the pause');
  clock.advance(CLAUDE_START_GATE.loginPauseMs);
  const later = await ClaudeChatProcess.start(options);
  assert.equal(fake.children.length, 2, 'after the pause one may try again');
  later.close();
});
