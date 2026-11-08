// The speech inference process ends itself without the normal exit path once it is told to stop
// (docs/claude/2026-11-03-pose-exit-hang.md: a normal exit after onnxruntime could stay stuck until a restart).
// A real child process: it must be gone soon after "stop", and not through process.exit(0).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('after "stop" the speech worker process ends itself at once, not through a normal exit', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'soft-hearts-asr-end-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = pathToFileURL(path.resolve('electron/asr/worker.ts')).href;
  const script = path.join(dir, 'child.mts');
  // No session was ever loaded; the stop path is the same one that runs after a released session.
  writeFileSync(script, `import { startAsrWorker } from ${JSON.stringify(worker)};
let listener = () => {};
startAsrWorker({ on: (_event, l) => { listener = l; }, postMessage: () => {} }, () => { throw new Error('no runtime'); });
process.on('exit', () => { process.stdout.write('normal-exit'); });
setInterval(() => {}, 1000); // keeps the process alive: only the worker can end it
listener({ data: { type: 'stop' } });
`);
  const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 10_000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.ok(ended, 'the process ended by itself after "stop"');
  assert.equal(out.includes('normal-exit'), false, 'no normal exit path (no exit handlers ran)');
  assert.notEqual(ended.code, 0, 'not a normal exit code 0');
});
