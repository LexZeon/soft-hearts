/**
 * The up gate (docs/claude/2026-11-23-unbound-step6.md, section "退出后才起来的进程不再收到请求"): since Claude Code is started from a
 * worker thread, the brain gets its process object before the process exists, and may write to it at once. If the owner lets go of it
 * before it is up (the user quits, a warm is cancelled, a replacement dropped, a call stopped, the character switched), nothing written
 * may reach it: it is ended the moment it is up with nothing on its stdin, whatever order the worker gets to things in. Losing this
 * spends the user's Claude usage after they quit (tests/start-warm-paid.test.ts "quitting while the throwaway process is still starting"
 * failed every time on main after the move to the worker).
 *
 * The first group drives the main thread's stand-in with a worker that does exactly what the test says, so every ordering is checked
 * deterministically. The second group runs the brain's own paths against the real worker and a fake Claude Code that logs every user
 * message it reads: the owner lets go in the microtask right after the write, which is always before the worker can say it is up.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import test, { type TestContext } from 'node:test';
import { CLAUDE_LAUNCH_HOOK, type ClaudeChild, type ClaudeLaunchHook, type ClaudeLaunchOptions } from '../electron/brain/claude-launch';
import { OffMainChild, OffMainClaudeLauncher } from '../electron/brain/claude-launch/off-main';
import { claudeInput, streamClaude } from '../electron/brain/claude';
import { ClaudeChatProcess } from '../electron/brain/claude-process';
import { PersistentClaudeChat, type CompanionClaudeTask } from '../electron/brain/claude-session';
import { warmOpening } from '../electron/brain/long-chat/prewarm';
import { buildCodexChatPrompt } from '../electron/brain/conversation-context';
import type { ChatMessage } from '../shared/foundation/chat';
import { fake } from './helpers/prewarm-fake-claude';

const options = (): ClaudeLaunchOptions => ({ cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting'); await wait(20); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A worker that only records what it is sent; the test plays its answers. */
function scriptedWorker() {
  const posted: Record<string, unknown>[] = [];
  let listener: (message: unknown) => void = () => {};
  const worker = {
    postMessage: (message: unknown) => { posted.push(message as Record<string, unknown>); },
    on(event: string, handler: (message: unknown) => void) { if (event === 'message') listener = handler; },
    ref() {}, unref() {}, terminate: async () => 0,
  };
  const launcher = new OffMainClaudeLauncher(() => worker);
  const answer = (message: Record<string, unknown>) => listener(message);
  const sent = () => posted.map(message => message.type === 'write' || message.type === 'end' ? `${message.type}:${message.text ?? ''}` : String(message.type));
  return { launcher, answer, sent };
}

test('up gate: stdin waits until the worker says the process is up, then goes in order; afterwards straight away', () => {
  const { launcher, answer, sent } = scriptedWorker();
  const child = launcher.launch('claude', ['-p'], options());
  assert.equal(child.stdin.write('一'), true, 'a write before it is up is accepted (held)');
  assert.equal(child.stdin.write('二'), true);
  assert.deepEqual(sent(), ['spawn'], 'nothing of stdin has left the main thread yet');
  answer({ type: 'spawned', id: child.id, pid: 4242 });
  assert.equal(child.up, true);
  assert.equal(child.pid, 4242);
  assert.deepEqual(sent(), ['spawn', 'write:一', 'write:二'], 'sent once it is up, in order');
  child.stdin.write('三');
  child.stdin.end('四');
  assert.deepEqual(sent(), ['spawn', 'write:一', 'write:二', 'write:三', 'end:四']);
  child.terminate();
  assert.deepEqual(sent().slice(-1), ['terminate']);
});

test('up gate: ended (terminate) before it is up: nothing written ever leaves, also when the worker says it is up afterwards', () => {
  const { launcher, answer, sent } = scriptedWorker();
  const child = launcher.launch('claude', ['-p'], options());
  child.stdin.write('隐藏的请求');
  child.stdin.end();
  child.terminate();
  assert.deepEqual(sent(), ['spawn', 'terminate'], 'the worker is told to start it and to end it, nothing else');
  assert.equal(child.stdin.writable, false);
  assert.equal(child.stdin.write('再来'), false, 'stdin takes nothing more');
  answer({ type: 'spawned', id: child.id, pid: 4243 }); // the process comes up after its owner let go
  assert.deepEqual(sent(), ['spawn', 'terminate'], 'still nothing written to it');
  assert.equal(child.pid, 4243, 'its pid is still known (for the record)');
  answer({ type: 'close', id: child.id, code: null });
  assert.equal(child.closed, true);
});

test('up gate: a plain kill before it is up drops what was held the same way', () => {
  const { launcher, answer, sent } = scriptedWorker();
  const child = launcher.launch('claude', ['-p'], options());
  child.stdin.write('x');
  child.kill();
  answer({ type: 'spawned', id: child.id, pid: 4244 });
  assert.deepEqual(sent(), ['spawn', 'kill']);
});

test('up gate: a start that failed (error and close, never up) sends nothing held; a stray "spawned" after close changes nothing', () => {
  const { launcher, answer, sent } = scriptedWorker();
  const child = launcher.launch('claude', ['-p'], options());
  child.stdin.write('x');
  let failed: NodeJS.ErrnoException | null = null;
  child.once('error', error => { failed = error; });
  answer({ type: 'error', id: child.id, code: 'ENOENT', message: 'spawn claude ENOENT' });
  answer({ type: 'close', id: child.id, code: null });
  answer({ type: 'spawned', id: child.id, pid: 4245 });
  assert.equal((failed as NodeJS.ErrnoException | null)?.code, 'ENOENT');
  assert.deepEqual(sent(), ['spawn']);
});

test('up gate: the worker going away before it is up: nothing held is sent to the next worker', () => {
  const { launcher, sent } = scriptedWorker();
  const child = launcher.launch('claude', ['-p'], options());
  child.stdin.write('x');
  (launcher as unknown as { gone(): void }).gone();
  assert.equal(child.closed, true);
  assert.equal(child.stdin.write('y'), false);
  assert.deepEqual(sent(), ['spawn']);
});

// ---- The brain's own paths, real worker, fake Claude Code that logs every user message it reads ----

/** Runs `letGo` in the microtask after the first write to the `nth` process launched (1-based): before the worker can say it is up. */
function letGoAfterFirstWrite(t: TestContext, nth: number, letGo: () => void) {
  const launched: OffMainChild[] = [];
  const writtenBeforeUp: boolean[] = [];
  const hook: ClaudeLaunchHook = (file, args, launchOptions, launch) => {
    const child = launch(file, args, launchOptions) as OffMainChild;
    launched.push(child);
    if (launched.length === nth) {
      // A message goes in with write (the persistent process) or with end(text) (a one-shot call).
      const write = child.stdin.write.bind(child.stdin), end = child.stdin.end.bind(child.stdin);
      let first = true;
      const written = () => { if (first) { first = false; writtenBeforeUp.push(!child.up); queueMicrotask(letGo); } };
      child.stdin.write = (text: string) => { const accepted = write(text); written(); return accepted; };
      child.stdin.end = (text?: string) => { const result = end(text); if (typeof text === 'string') written(); return result; };
    }
    return child;
  };
  Object.defineProperty(globalThis, CLAUDE_LAUNCH_HOOK, { value: hook, configurable: true });
  t.after(() => { delete (globalThis as Record<string, unknown>)[CLAUDE_LAUNCH_HOOK]; });
  return { launched, writtenBeforeUp };
}

/** The process came up (or was never needed) and is gone again; give a reader that got anything time to log it. */
async function endedAndQuiet(child: ClaudeChild & { closed: boolean }) {
  await until(() => child.closed);
  if (typeof child.pid === 'number') await until(() => !alive(child.pid!));
  await wait(300);
}

const persona = '你是测试角色小桃，说话温柔。';
let replyCount = 0;
function task(messages: ChatMessage[]): CompanionClaudeTask {
  return { kind: 'chat', model: 'haiku', workingDirectory: os.tmpdir(), writable: false, get prompt() { return buildCodexChatPrompt(persona, messages); },
    imageDataUrls: [], replyId: `up-${++replyCount}`,
    session: { key: 'conversation-up', basePersona: persona, persona, messages, data: () => null } };
}
function chatFor(script: string, chattedBefore = false) {
  return new PersistentClaudeChat({ enabled: true, binary: async () => process.execPath, binaryArgs: [script], provider: () => ({ kind: 'claude', model: 'haiku' }),
    chattedBefore: () => chattedBefore, interruptGraceMs: 300, log: () => {} });
}
const messages = [{ role: 'user', content: '早' }, { role: 'assistant', content: '早呀。' }, { role: 'user', content: '在吗' }] as ChatMessage[];

test('control: the same cold turn with nobody letting go is read by the fake Claude Code (the checks below are not vacuous)', async () => {
  const f = await fake();
  const chat = chatFor(f.script);
  try {
    assert.equal(await (async () => { let text = ''; await chat.stream(task(messages), new AbortController().signal, (type, value) => { if (type === 'delta') text += value; }); return text; })(), '第1轮回复。');
    assert.equal((await f.inputs()).length, 1);
  } finally { chat.dispose(); await f.cleanup(); }
});

test('a hidden warm request (the paid start warm and the I-134 replacement both use warmOpening): its owner lets go before the process is up: nothing arrives', async (t: TestContext) => {
  const f = await fake();
  let warmer: ClaudeChatProcess | null = null;
  const { launched, writtenBeforeUp } = letGoAfterFirstWrite(t, 1, () => warmer?.close('closed')); // StartWarmer.cancel / dropPrepared
  try {
    warmer = await ClaudeChatProcess.start({ binary: process.execPath, binaryArgs: [f.script], model: 'haiku', systemPrompt: 'x' });
    const done = warmOpening(warmer, claudeInput({ prompt: persona }), { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as NodeJS.Timeout) });
    assert.equal(await done, false);
    assert.deepEqual(writtenBeforeUp, [true], 'the request was written while the process did not exist yet');
    await endedAndQuiet(launched[0]);
    assert.deepEqual(await f.inputs(), [], 'nothing reached Claude Code');
  } finally { warmer?.close(); await f.cleanup(); }
});

test('a one-shot call stopped right after it was started (inner loop, mood, reactions on quit): nothing arrives', async (t: TestContext) => {
  const f = await fake();
  const controller = new AbortController();
  const { launched, writtenBeforeUp } = letGoAfterFirstWrite(t, 1, () => controller.abort());
  try {
    await assert.rejects(streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: '', writable: false, prompt: '在吗' }, controller.signal, () => {},
      process.execPath, [f.script]));
    assert.deepEqual(writtenBeforeUp, [true]);
    await endedAndQuiet(launched[0]);
    assert.deepEqual(await f.inputs(), []);
  } finally { await f.cleanup(); }
});

test('her turn on a process still starting, and she is switched (a context change): the turn ends, the message never reaches Claude Code', async (t: TestContext) => {
  const f = await fake();
  const chat = chatFor(f.script);
  const { launched, writtenBeforeUp } = letGoAfterFirstWrite(t, 1, () => chat.close('context'));
  try {
    await assert.rejects(chat.stream(task(messages), new AbortController().signal, () => {}), /角色或对话已改变/u);
    assert.deepEqual(writtenBeforeUp, [true]);
    await endedAndQuiet(launched[0]);
    assert.deepEqual(await f.inputs(), []);
  } finally { chat.dispose(); for (const child of launched) await until(() => child.closed); await f.cleanup(); }
});

test('her turn on a process still starting, and the user quits: the message never reaches Claude Code', async (t: TestContext) => {
  const f = await fake();
  const chat = chatFor(f.script);
  const { launched, writtenBeforeUp } = letGoAfterFirstWrite(t, 1, () => chat.dispose());
  try {
    await assert.rejects(chat.stream(task(messages), new AbortController().signal, () => {}));
    assert.deepEqual(writtenBeforeUp, [true]);
    await endedAndQuiet(launched[0]);
    assert.deepEqual(await f.inputs(), []);
    assert.equal(launched.length, 1, 'no spare after the quit');
  } finally { chat.dispose(); await f.cleanup(); }
});

test('warm reuse: her turn takes the spare while it is still starting, and she is switched: the message never reaches the spare', async (t: TestContext) => {
  const f = await fake();
  const chat = chatFor(f.script, true);
  const { launched, writtenBeforeUp } = letGoAfterFirstWrite(t, 1, () => chat.close('context'));
  try {
    chat.prewarm('start'); // the free spare starts (spawn only)
    await assert.rejects(chat.stream(task(messages), new AbortController().signal, () => {}), /角色或对话已改变/u);
    assert.deepEqual(writtenBeforeUp, [true], 'the turn went to the spare before it was up');
    await endedAndQuiet(launched[0]);
    assert.deepEqual(await f.inputs(), []);
  } finally { chat.dispose(); for (const child of launched) await until(() => child.closed); await f.cleanup(); }
});
