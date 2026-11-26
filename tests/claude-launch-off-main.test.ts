/**
 * The brain starts and ends Claude Code from a worker thread (electron/brain/claude-launch/; docs/claude/2026-11-23-unbound-step6.md,
 * section "聊天起 Claude 进程挪出主线程"), because a `spawn` or a taskkill on Electron's main thread held every mouse event and frame
 * (31-660 ms per start in step 6). What the brain sees of a process is unchanged: stdin, stdout and stderr text in order, 'error' and
 * 'close', a kill, and the tree kill on Windows. The harnesses' stand-in Claude Code comes in through the one launch hook.
 */
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { CLAUDE_LAUNCH_HOOK, claudeLaunchesSettled, launchClaude, type ClaudeChild, type ClaudeLaunchHook, type ClaudeLaunchOptions } from '../electron/brain/claude-launch';
import { OffMainChild, OffMainClaudeLauncher } from '../electron/brain/claude-launch/off-main';
import { claudeInput, streamClaude, terminateClaude } from '../electron/brain/claude';
import { ClaudeChatProcess } from '../electron/brain/claude-process';
import { CLAUDE_SESSION_SYSTEM_PROMPT } from '../electron/brain/claude-session-prompt';
import { FAKE_CLAUDE_MARKER } from '../scripts/lib/fake-claude.mjs';


const options = (env: NodeJS.ProcessEnv = process.env): ClaudeLaunchOptions => ({ cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
const closed = (child: ClaudeChild) => new Promise<number | null>(resolve => child.once('close', resolve));
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting'); await new Promise(done => setTimeout(done, 20)); }
}
const fake = path.resolve('scripts/lib/fake-claude.mjs');
const opening = (text: string) => `人设\n\n以下JSON是普通聊天输入\n<conversation-data>\n${JSON.stringify({ currentUser: text, history: [] })}\n</conversation-data>`;

/** Installs a hook for one test that records each launch and passes it on (the key is a plain global; a harness seals it, a test does not). */
function recordLaunches(t: TestContext) {
  const launched: ClaudeChild[] = [];
  const hook: ClaudeLaunchHook = (file, args, launchOptions, launch) => { const child = launch(file, args, launchOptions); launched.push(child); return child; };
  Object.defineProperty(globalThis, CLAUDE_LAUNCH_HOOK, { value: hook, configurable: true });
  t.after(() => { delete (globalThis as Record<string, unknown>)[CLAUDE_LAUNCH_HOOK]; });
  return launched;
}

test('a process started off the main thread: the call returns before it exists; stdin, stdout, stderr in order; end; close code', async () => {
  const launcher = new OffMainClaudeLauncher();
  try {
    const script = 'process.stdin.setEncoding("utf8"); let got = ""; process.stdin.on("data", c => { got += c; process.stdout.write("echo:" + c); });'
      + ' process.stdin.on("end", () => { process.stderr.write("bye"); process.exitCode = got.length; });';
    const began = performance.now();
    const child = launcher.launch(process.execPath, ['-e', script], options());
    const tookMs = performance.now() - began;
    assert.equal(child.pid, undefined, 'the main thread only posted a message: the process does not exist yet when the call returns');
    assert.ok(tookMs < 100, `the call took ${tookMs.toFixed(1)} ms`);
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    assert.equal(child.stdin.write('一\n'), true);
    child.stdin.end('二\n');
    assert.equal(child.stdin.writable, false);
    assert.equal(child.stdin.write('三\n'), false, 'nothing is written after end');
    const code = await closed(child);
    assert.ok(out.startsWith('echo:') && out.replace(/echo:/gu, '') === '一\n二\n', 'stdout came back whole and in order');
    assert.equal(err, 'bye');
    assert.equal(code, 4, 'the exit code comes back (characters read)');
    assert.ok(typeof child.pid === 'number' && child.pid > 0, 'the pid is known once it started');
    assert.equal(child.stdin.destroyed, true);
  } finally { await launcher.close(); }
});

test('a program that is not there: error (ENOENT) then close, like a ChildProcess', async () => {
  const launcher = new OffMainClaudeLauncher();
  try {
    const child = launcher.launch(path.join(os.tmpdir(), 'no-such-claude-here.exe'), [], options());
    const error = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
    assert.equal((await error).code, 'ENOENT');
    await closed(child);
  } finally { await launcher.close(); }
});

test('terminate ends the whole tree (taskkill /T /F on Windows) from the worker, and the main thread is not held', async () => {
  const launcher = new OffMainClaudeLauncher();
  try {
    // The child starts a grandchild (as Claude Code's own helpers would) and prints its pid.
    const script = 'const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }); process.stdout.write(String(c.pid) + "\\n"); setTimeout(() => {}, 60000);';
    const child = launcher.launch(process.execPath, ['-e', script], options());
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    await until(() => text.includes('\n'));
    const grandchild = Number(text.trim());
    assert.ok(grandchild > 0 && !gone(grandchild));
    const began = performance.now();
    terminateClaude(child, () => (child as OffMainChild).closed);
    assert.ok(performance.now() - began < 20, 'terminate only posts a message');
    await closed(child);
    if (process.platform === 'win32') await until(() => gone(grandchild), 10_000);
    else try { process.kill(grandchild); } catch { /* gone */ }
  } finally { await launcher.close(); }
});

test('a process the brain did not start (the Claude 助手\'s) gets its taskkill from the worker too', async () => {
  const child = nodeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let ended = false;
  const done = new Promise<void>(resolve => child.once('close', () => { ended = true; resolve(); }));
  await until(() => typeof child.pid === 'number');
  terminateClaude(child, () => ended);
  await done;
  assert.equal(await claudeLaunchesSettled(5_000), true);
});

test('quit: settled once the worker has acted on every start and end asked of it; a worker that does not answer gives up at the limit', async () => {
  const posted: unknown[] = [];
  const silent = { postMessage: (message: unknown) => { posted.push(message); }, on() {}, ref() {}, unref() {}, terminate: async () => 0 };
  const launcher = new OffMainClaudeLauncher(() => silent);
  launcher.launch('claude', ['-p'], options()).terminate!();
  const began = Date.now();
  assert.equal(await launcher.settled(150), false);
  assert.ok(Date.now() - began >= 140);
  assert.deepEqual(posted.map(message => (message as { type: string }).type), ['spawn', 'terminate']);
  const real = new OffMainClaudeLauncher();
  try {
    assert.equal(await real.settled(10), true, 'nothing asked: settled at once');
    const child = real.launch(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], options());
    child.terminate();
    assert.equal(await real.settled(10_000), true);
    await closed(child);
  } finally { await real.close(); }
});

test('the worker going away ends every process it ran with close (null); the next launch makes a new worker', async () => {
  const launcher = new OffMainClaudeLauncher();
  try {
    const child = launcher.launch(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], options());
    await until(() => typeof child.pid === 'number');
    const pid = child.pid!;
    const ending = closed(child);
    await (launcher as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    assert.equal(await ending, null);
    try { process.kill(pid); } catch { /* its pipes closed with the worker; it may be gone already */ }
    const again = launcher.launch(process.execPath, ['-e', 'process.stdout.write("ok")'], options());
    let text = ''; again.stdout.on('data', chunk => { text += chunk; });
    assert.equal(await closed(again), 0);
    assert.equal(text, 'ok');
  } finally { await launcher.close(); }
});

test('the app\'s persistent process and one-shot call go through the launch hook, off the main thread, and still chat', { timeout: 30_000 }, async (t: TestContext) => {
  const launched = recordLaunches(t);
  const logs = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-launch-'));
  t.after(() => rm(logs, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const chat = await ClaudeChatProcess.start({ binary: process.execPath, binaryArgs: [fake, FAKE_CLAUDE_MARKER, path.join(logs, 'spawn-0.jsonl')], model: 'haiku',
    systemPrompt: CLAUDE_SESSION_SYSTEM_PROMPT });
  assert.equal(launched.length, 1, 'the persistent process came in through the hook');
  assert.ok(launched[0] instanceof OffMainChild, 'given the off-main launch');
  assert.equal(launched[0].pid, undefined, 'start() returned before the process existed: nothing was started on this thread');
  assert.match(await chat.run(claudeInput({ prompt: opening('你好') }), new AbortController().signal, () => {}), /桌面伙伴已连接/);
  const child = launched[0] as OffMainChild;
  chat.close();
  await until(() => child.closed);
  await streamClaude({ kind: 'chat', model: 'haiku', workingDirectory: '', writable: false, prompt: opening('你好') }, new AbortController().signal, () => {},
    process.execPath, [fake, FAKE_CLAUDE_MARKER, path.join(logs, 'oneshot.jsonl')]);
  assert.equal(launched.length, 2, 'the one-shot call too');
  assert.ok(launched[1] instanceof OffMainChild);
});

test('without a hook the app\'s launch is the off-main one', async () => {
  assert.equal((globalThis as Record<string, unknown>)[CLAUDE_LAUNCH_HOOK], undefined);
  const child = launchClaude(process.execPath, ['-e', ''], options());
  assert.ok(child instanceof OffMainChild);
  assert.equal(await closed(child), 0);
});

test('nothing in electron/brain starts or ends a process on the main thread: only claude-launch/off-main.ts names child_process, inside its worker', async () => {
  const folder = path.join(process.cwd(), 'electron', 'brain');
  const offenders: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!/\.(?:ts|mts|js|mjs|cjs)$/u.test(entry.name)) continue;
      // The worker's own program is a template string (it runs on the worker thread); everything else runs on the main thread.
      const code = (await readFile(full, 'utf8')).replace(/`[\s\S]*?`/gu, '``');
      if (/child_process|\b(?:spawnSync|execSync|execFileSync)\b/u.test(code)) offenders.push(path.relative(folder, full));
    }
  };
  await walk(folder);
  assert.deepEqual(offenders, []);
  // And the worker does name it (the guard above is not vacuous).
  assert.match(await readFile(path.join(folder, 'claude-launch', 'off-main.ts'), 'utf8'), /require\('node:child_process'\)/u);
});
