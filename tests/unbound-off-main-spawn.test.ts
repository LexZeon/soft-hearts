/**
 * Unbound v1 step 6 (docs/claude/2026-11-23-unbound-step6.md): Unbound's helper processes start from a worker thread
 * (electron/unbound/off-main-spawn.ts), because a `spawn` on the main thread held every mouse event (802 ms the first time she went full
 * screen, 26-152 ms each time after). The helpers' behaviour is unchanged: output, end, kill, a helper that cannot start.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readMonitorSizes } from '../electron/unbound/display-size';
import { WindowsFullscreenProbe, type FullscreenReading } from '../electron/unbound/fullscreen-watch';
import { OffMainSpawner, type HelperProcess, type HelperSpawn } from '../electron/unbound/off-main-spawn';

const ended = (child: HelperProcess) => new Promise<number | null>(resolve => child.onExit(resolve));

test('a helper started off the main thread: its output, its end, and a kill', async () => {
  const spawner = new OffMainSpawner();
  try {
    const child = spawner.spawn(process.execPath, ['-e', 'process.stdout.write("one\\n"); setTimeout(() => process.stdout.write("two\\n"), 50)']);
    let text = '';
    child.onData(chunk => { text += chunk; });
    assert.equal(await ended(child), 0);
    assert.equal(text, 'one\ntwo\n');
    assert.equal(child.ended, true);
    assert.equal(await ended(child), 0, 'asking after the end still answers');

    const long = spawner.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    const began = Date.now();
    long.kill();
    const code = await ended(long);
    assert.ok(Date.now() - began < 10_000, 'killed, not waited out');
    assert.notEqual(code, 0);

    const missing = spawner.spawn(path.join(process.cwd(), 'no-such-helper.exe'), []);
    assert.equal(await ended(missing), null, 'a helper that cannot start ends with null');
  } finally { await spawner.close(); }
});

test('the call on the calling thread only posts a message: it returns before the helper has started', async () => {
  const spawner = new OffMainSpawner();
  try {
    const began = performance.now();
    const children = Array.from({ length: 4 }, () => spawner.spawn(process.execPath, ['-e', '']));
    const tookMs = performance.now() - began;
    assert.ok(children.every(child => !child.ended), 'none has started yet when the calls return');
    assert.ok(tookMs < 200, `four calls took ${tookMs.toFixed(1)} ms (the first makes the worker)`);
    await Promise.all(children.map(ended));
  } finally { await spawner.close(); }
});

test('the worker going away ends every helper it ran; the next spawn makes a new one', async () => {
  const spawner = new OffMainSpawner();
  const child = spawner.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
  await new Promise(resolve => setTimeout(resolve, 200));
  await (spawner as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
  assert.equal(await ended(child), null);
  const again = spawner.spawn(process.execPath, ['-e', 'process.stdout.write("ok")']);
  let text = ''; again.onData(chunk => { text += chunk; });
  assert.equal(await ended(again), 0);
  assert.equal(text, 'ok');
  await spawner.close();
});

/** A helper whose output the test writes. */
function scripted(lines: string[], code: number | null | 'never' = 0) {
  const started: { command: string; args: readonly string[] }[] = [];
  let killed = 0;
  const spawn: HelperSpawn = (command, args) => {
    started.push({ command, args });
    const data: ((chunk: string) => void)[] = [], exits: ((code: number | null) => void)[] = [];
    let done = false;
    const end = (value: number | null) => { if (done) return; done = true; for (const listener of exits) listener(value); };
    setTimeout(() => { for (const line of lines) for (const listener of data) listener(line); if (code !== 'never') end(code); }, 5);
    return { onData: l => data.push(l), onExit: l => exits.push(l), kill: () => { killed++; end(null); }, get ended() { return done; } };
  };
  return { spawn, started, killed: () => killed };
}

test('the monitor sizes: read from the helper as before; a helper killed or not started tells nothing; not Windows: nothing started', async () => {
  const ok = scripted(['{"ew":34,"eh":22,"t":11}']);
  assert.deepEqual(await readMonitorSizes(8_000, ok.spawn, 'win32'), [{ widthCm: 34, heightCm: 22, source: 'edid', internal: true }]);
  assert.match(ok.started[0].command, /powershell/iu);
  const killed = scripted([], null);
  assert.equal(await readMonitorSizes(8_000, killed.spawn, 'win32'), null);
  const slow = scripted(['{"ew":34,"eh":22}'], 'never');
  assert.equal(await readMonitorSizes(30, slow.spawn, 'win32'), null, 'the timeout gives up');
  assert.equal(slow.killed(), 1, 'and ends the helper');
  const other = scripted(['{}']);
  assert.equal(await readMonitorSizes(8_000, other.spawn, 'linux'), null);
  assert.equal(other.started.length, 0);
});

test('the full-screen watch: readings from the helper (each change once), stop kills it, not Windows: nothing started', async () => {
  const helper = scripted(['5\n', '5\n2\n', '3\n5\n'], 'never'); // SHQueryUserNotificationState numbers: 5 accepts notifications, 2/3 busy or full-screen
  const probe = new WindowsFullscreenProbe(helper.spawn, 'win32');
  const seen: FullscreenReading[] = [];
  probe.start(value => seen.push(value));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(seen, ['clear', 'fullscreen', 'clear']);
  probe.stop();
  assert.equal(helper.killed(), 1);
  const elsewhere = scripted(['2\n']);
  new WindowsFullscreenProbe(elsewhere.spawn, 'darwin').start(() => assert.fail('no reading off Windows'));
  assert.equal(elsewhere.started.length, 0);
});

test('nothing in electron/unbound starts a process on the main thread (only off-main-spawn.ts imports child_process, inside its worker)', () => {
  const folder = path.join(process.cwd(), 'electron', 'unbound');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.ts$/u.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      if (/^\s*import[^;]*['"](?:node:)?child_process['"]/mu.test(text) || /require\(\s*['"](?:node:)?child_process['"]\s*\)/u.test(text.replace(/`[\s\S]*?`/gu, ''))) offenders.push(path.relative(folder, full));
    }
  };
  walk(folder);
  assert.deepEqual(offenders, []);
});
