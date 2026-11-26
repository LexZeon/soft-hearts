import test from 'node:test';
import assert from 'node:assert/strict';
import { median, summarize, processType, descendants, toSample, intervalStats, summarizeSamples, parseArgs, aggregate } from '../scripts/dev/baseline.mjs';

test('median and spread', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(summarize([10, 12, 11, NaN]), { n: 3, median: 11, min: 10, max: 12, spread: 2 });
  assert.equal(summarize([]).median, null);
});

test('process type from the command line', () => {
  assert.equal(processType('"x\\soft hearts next.exe" --user-data-dir=a', 'soft hearts next.exe'), 'main');
  assert.equal(processType('x --type=gpu-process --foo', 'x.exe'), 'gpu');
  assert.equal(processType('x --type=renderer', 'x.exe'), 'renderer');
  assert.equal(processType('x --type=utility --utility-sub-type=network.mojom.NetworkService', 'x.exe'), 'utility:NetworkService');
  assert.equal(processType('x --type=utility', 'x.exe'), 'utility');
  assert.equal(processType('node a.js', 'node.exe'), 'other');
});

const row = (id, parent, cmd, kernel, user, ws = 100 * 2 ** 20, priv = 50 * 2 ** 20) => ({ ProcessId: id, ParentProcessId: parent, Name: 'soft hearts next.exe', CommandLine: cmd, KernelModeTime: kernel, UserModeTime: user, WorkingSetSize: ws, PrivatePageCount: priv });

test('the tree is the root and its descendants only', () => {
  const rows = [row(1, 0, 'a'), row(2, 1, 'a --type=gpu-process'), row(3, 2, 'a --type=renderer'), row(4, 99, 'other'), row(5, 1, 'a --type=renderer')];
  assert.deepEqual(descendants(rows, 1).map(r => r.ProcessId).sort(), [1, 2, 3, 5]);
  assert.deepEqual(descendants(rows, 42), []);
});

test('CPU percent from cumulative times over wall time, memory summed per type', () => {
  const a = toSample([row(1, 0, 'a', 0, 0), row(2, 1, 'a --type=gpu-process', 0, 0)], 1, 0);
  // over 2 s: main used 1 s, gpu 0.5 s (100 ns ticks); a renderer new in the second sample has no baseline and adds no CPU
  const b = toSample([row(1, 0, 'a', 5e6, 5e6), row(2, 1, 'a --type=gpu-process', 0, 1e7), row(3, 1, 'a --type=renderer', 9e7, 0)], 1, 2000);
  const it = intervalStats(a, b);
  assert.equal(it.wall, 2);
  assert.equal(it.cpu.main, 50);
  assert.equal(it.cpu.gpu, 50);
  assert.equal(it.cpu.renderer, 0);
  assert.equal(it.cpu.total, 100);
  assert.equal(it.mem.total.workingSet, 300 * 2 ** 20);
  const s = summarizeSamples([a, b]);
  assert.equal(s.groups.total.cpuPercent.median, 100);
  assert.equal(s.groups.total.privateMB.median, 150);
});

test('arguments', () => {
  assert.throws(() => parseArgs([], {}), /--exe/);
  assert.equal(parseArgs([], { MMD_TEST_EXE: 'x' }).exe, 'x');
  const o = parseArgs(['--exe', 'e', '--runs', '5', '--with-chat', '--sample', '10'], {});
  assert.deepEqual([o.runs, o.withChat, o.sample, o.settle], [5, true, 10, 30]);
  assert.throws(() => parseArgs(['--exe', 'e', '--runs', '0'], {}));
  assert.throws(() => parseArgs(['--exe', 'e', '--bogus'], {}));
});

test('aggregate skips failed runs', () => {
  const ok = n => ({ error: null, coldStartMs: { petFirstFrame: n }, idle: { processCount: { median: 6 }, groups: { total: { cpuPercent: { median: n / 10 }, workingSetMB: { median: n }, privateMB: { median: n } } } } });
  const s = aggregate([ok(100), ok(300), { error: 'x' }]);
  assert.equal(s.runsOk, 2);
  assert.equal(s.runsFailed, 1);
  assert.equal(s.coldStartMs.petFirstFrame.median, 200);
  assert.equal(s.idle.total.cpuPercent.median, 20);
});
