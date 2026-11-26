// Soak test, the pure parts (scripts/dev/soak-lib.mjs). The app run itself is scripts/dev/soak.mjs (not run by the test suite).
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_THRESHOLDS, FRAME_BINS, ONLY_STEPS, cpuBetween, evaluate, frameSummary, growth, histogramQuantile, memoryByType, mergeFrameWindows, olsSlope, stepRecord, summarizeSteps, parseSoakArgs, renderSoakMarkdown, seededRandom, theilSenSlope, thirds, treeSample, warmupHours } from '../scripts/dev/soak-lib.mjs';

const line = (n, from, perHour, step = 1 / 12) => Array.from({ length: n }, (_, i) => ({ tHours: i * step, v: from + perHour * i * step }));
const sampleAt = (t, extra = {}) => ({ tHours: t, mem: { total: { privateMB: 1500, handles: 4000, count: 9 }, renderer: { privateMB: 600 }, gpu: { privateMB: 300 }, main: { privateMB: 100 } },
  jsHeapMB: 80, cpuIdle: { total: 20 }, frames: { frames: 1000, p50: 16.5, p95: 18.5, p99: 25.5, over100: 0, over250: 0, longTasks: 0 }, errors: { pageErrors: 0, consoleErrors: 0, messages: [] },
  partOff: [], journalBytes: 1000, chatFirstCharMs: 300, ...extra });
const flat = n => Array.from({ length: n }, (_, i) => sampleAt(i / 12));

test('slopes: a straight line gives its slope, and one spike does not move the robust slope', () => {
  const points = line(10, 100, 30).map(p => ({ x: p.tHours, y: p.v }));
  assert.ok(Math.abs(olsSlope(points) - 30) < 1e-9);
  assert.ok(Math.abs(theilSenSlope(points) - 30) < 1e-9);
  points[5].y += 800; // a GC pause caught in one sample
  assert.ok(Math.abs(theilSenSlope(points) - 30) < 3, 'the robust slope stays near 30');
  assert.ok(olsSlope(points) > 50, 'least squares is pulled by the spike (why the verdict uses the robust one)');
  assert.equal(olsSlope(points.slice(0, 2)), null);
  assert.equal(theilSenSlope([]), null);
});

test('growth leaves out the warm-up and reports points and ends', () => {
  const samples = line(13, 1000, 0).map(s => ({ tHours: s.tHours, v: s.tHours < 0.25 ? 500 + 3000 * s.tHours : 1250 }));
  const r = growth(samples, s => s.v, { warmup: 0.25 });
  assert.equal(r.perHour, 0);
  assert.equal(r.first, 1250);
  assert.equal(warmupHours(4), 0.5);
  assert.ok(Math.abs(warmupHours(0.3333) - 0.0833) < 1e-3);
});

test('thirds compares the first and last third', () => {
  const r = thirds(Array.from({ length: 9 }, (_, i) => ({ v: i < 3 ? 10 : i < 6 ? 11 : 15 })), s => s.v);
  assert.deepEqual([r.first, r.last, r.change, r.changePercent], [10, 15, 5, 50]);
  assert.equal(thirds([{ v: 1 }], s => s.v).change, null);
});

test('frame histogram: quantiles, long frames and the summary', () => {
  const bins = new Array(FRAME_BINS).fill(0);
  bins[16] = 900; bins[33] = 80; bins[120] = 15; bins[300] = 5; // 1000 frames
  assert.equal(histogramQuantile(bins, 0.5), 16.5);
  assert.equal(histogramQuantile(bins, 0.95), 33.5);
  assert.equal(histogramQuantile(new Array(FRAME_BINS).fill(0), 0.5), null);
  const summary = frameSummary({ bins, longTasks: 3, longTaskMs: 410.4, hidden: 2 });
  assert.deepEqual([summary.frames, summary.over100, summary.over250, summary.longTasks, summary.hiddenIntervals], [1000, 20, 5, 3, 2]);
  assert.equal(frameSummary(null), null);
});

test('process rows: the tree, types, memory, handles and CPU between two samples', () => {
  const row = (ProcessId, ParentProcessId, Name, CommandLine, cpu, priv, handles) => ({ ProcessId, ParentProcessId, Name, CommandLine, KernelModeTime: cpu * 5e6, UserModeTime: cpu * 5e6, WorkingSetSize: priv * 2e6, PrivatePageCount: priv * 1048576, HandleCount: handles });
  const rows = at => [row(10, 1, 'soft hearts next.exe', 'app', at, 100, 500), row(11, 10, 'soft hearts next.exe', '--type=gpu-process', at * 2, 300, 400), row(12, 10, 'soft hearts next.exe', '--type=renderer', at * 3, 600, 800),
    row(13, 10, 'soft hearts next.exe', '--type=renderer', at, 200, 300), row(99, 1, 'other.exe', 'x', 5, 9999, 9999)];
  const a = treeSample(rows(10), 10, 0), b = treeSample(rows(20), 10, 20_000);
  const mem = memoryByType(b);
  assert.equal(mem.total.count, 4);
  assert.equal(mem.total.privateMB, 1200);
  assert.equal(mem.renderer.privateMB, 800);
  assert.equal(mem.total.handles, 2000);
  assert.ok(!('other' in mem), 'a process outside the tree is not counted');
  const cpu = cpuBetween(a, b); // wall 20 s: main +10 s (=50%), gpu +20 s (=100%), renderers +30 +10 s (=200%)
  assert.equal(cpu.total, 350);
  assert.equal(cpu.gpu, 100);
  assert.equal(cpu.renderer, 200);
});

test('a flat, quiet run passes', () => {
  const result = evaluate(flat(49), { durationHours: 4, startProcessCount: 9 });
  assert.equal(result.verdict, 'PASS');
  assert.ok(result.checks.every(c => c.status !== 'fail' && c.status !== 'watch'));
});

test('a leak, a handle leak and creeping CPU are caught, each by its own check', () => {
  const leaking = Array.from({ length: 49 }, (_, i) => { const t = i / 12; return sampleAt(t, { mem: { total: { privateMB: 1500 + 120 * t, handles: 4000 + 400 * t, count: 9 }, renderer: { privateMB: 600 + 100 * t }, gpu: { privateMB: 300 }, main: { privateMB: 100 } }, cpuIdle: { total: 20 + 6 * t } }); });
  const result = evaluate(leaking, { durationHours: 4, startProcessCount: 9 });
  const status = id => result.checks.find(c => c.id === id).status;
  assert.equal(result.verdict, 'FAIL');
  assert.equal(status('memory-total'), 'fail');
  assert.equal(status('memory-renderer'), 'fail');
  assert.equal(status('handles'), 'fail');
  assert.equal(status('cpu-drift'), 'fail');
  assert.equal(status('memory-gpu'), 'pass');
  assert.equal(status('memory-main'), 'pass');
});

test('a slow rise is a WATCH, not a FAIL', () => {
  const slow = Array.from({ length: 49 }, (_, i) => { const t = i / 12; return sampleAt(t, { mem: { total: { privateMB: 1500 + 40 * t, handles: 4000, count: 9 }, renderer: { privateMB: 600 }, gpu: { privateMB: 300 }, main: { privateMB: 100 } } }); });
  const result = evaluate(slow, { durationHours: 4, startProcessCount: 9 });
  assert.equal(result.checks.find(c => c.id === 'memory-total').status, 'watch');
  assert.equal(result.verdict, 'WATCH');
});

test('stalls, errors, a part switched off and a crash each fail', () => {
  const stalls = flat(49).map((s, i) => i % 6 === 0 ? { ...s, frames: { ...s.frames, over250: 10 } } : s); // 90 in 4 h = 22 per hour
  assert.equal(evaluate(stalls, { durationHours: 4, startProcessCount: 9 }).checks.find(c => c.id === 'stalls').status, 'fail');
  const withError = flat(49); withError[30] = { ...withError[30], errors: { pageErrors: 1, pageMessages: ['TypeError: x'], consoleErrors: 0, messages: [] } };
  assert.equal(evaluate(withError, { durationHours: 4 }).checks.find(c => c.id === 'page-errors').status, 'fail');
  const off = flat(49); off[40] = { ...off[40], partOff: [{ part: 'stage', unit: 'pointer-input', reason: 'tick:TypeError' }] };
  const offResult = evaluate(off, { durationHours: 4 });
  assert.equal(offResult.checks.find(c => c.id === 'parts-off').status, 'fail');
  assert.match(offResult.checks.find(c => c.id === 'parts-off').detail, /pointer-input/);
  assert.equal(evaluate(flat(49), { durationHours: 4, crashes: ['gpu crashed'] }).verdict, 'FAIL');
  assert.equal(evaluate(flat(49), { durationHours: 4, mainExited: true }).verdict, 'FAIL');
  const consoleOnly = flat(49); consoleOnly[10] = { ...consoleOnly[10], errors: { pageErrors: 0, consoleErrors: 2, messages: ['x'] } };
  assert.equal(evaluate(consoleOnly, { durationHours: 4 }).verdict, 'WATCH');
});

test('frame time drift and chat latency drift are measured last third against first', () => {
  const drifting = Array.from({ length: 48 }, (_, i) => sampleAt(i / 12, { frames: { frames: 1000, p50: 16.5, p95: 18 + (i >= 32 ? 30 : 0), p99: 30, over100: 0, over250: 0, longTasks: 0 }, chatFirstCharMs: 300 + (i >= 32 ? 2000 : 0) }));
  const result = evaluate(drifting, { durationHours: 4, startProcessCount: 9 });
  assert.equal(result.checks.find(c => c.id === 'frame-drift').status, 'fail');
  assert.equal(result.checks.find(c => c.id === 'chat-latency').status, 'fail');
});

test('too few samples: inconclusive, and the note says the run only proves the script', () => {
  const result = evaluate(flat(4), { durationHours: 0.33 });
  assert.equal(result.verdict, 'INCONCLUSIVE');
  assert.match(result.note, /proves the script/);
  assert.equal(result.checks.find(c => c.id === 'memory-total').value, null);
});

test('arguments: hours, minutes, validation, seed', () => {
  assert.equal(parseSoakArgs([]).hours, 4);
  assert.ok(Math.abs(parseSoakArgs(['--minutes', '20']).hours - 1 / 3) < 1e-9);
  assert.equal(parseSoakArgs(['--hours', '6', '--tick-seconds', '120', '--seed', '7', '--unbound']).unbound, true);
  assert.throws(() => parseSoakArgs(['--hours', '0']), /positive/);
  assert.throws(() => parseSoakArgs(['--tick-seconds', '30', '--idle-probe-seconds', '20']), /third/);
  assert.throws(() => parseSoakArgs(['--nope']), /Unknown/);
  assert.equal(parseSoakArgs([], { MMD_TEST_EXE: 'x.exe' }).exe, 'x.exe');
  // 2026-11-23 (step 6): a development build of a commit, and the companion window's engine (unbound unless asked).
  assert.equal(parseSoakArgs([]).engine, 'unbound');
  assert.equal(parseSoakArgs(['--commit', 'abc123', '--engine', 'mmd']).commit, 'abc123');
  assert.equal(parseSoakArgs(['--engine', 'mmd']).engine, 'mmd');
  assert.throws(() => parseSoakArgs(['--engine', 'old']), /unbound or mmd/);
  assert.throws(() => parseSoakArgs(['--commit', 'abc', '--exe', 'x.exe']), /two different builds/);
  const a = seededRandom(5), b = seededRandom(5);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('every threshold has watch below fail, and the report renders the verdict, checks and the not-covered list', () => {
  for (const [name, limit] of Object.entries(DEFAULT_THRESHOLDS)) assert.ok(limit.watch < limit.fail, name);
  const samples = flat(8).map((s, i) => ({ ...s, cpuInterval: { total: 21 }, gpuDedicatedMB: 250 + i }));
  const report = { startedAt: 't', exe: 'x.exe', exeBytes: 1, exeModified: 'm', durationHours: 0.5, options: { tickSeconds: 300 }, samples, machine: { cpu: 'cpu', cores: 20, memGB: 32 }, presenceAtStart: 'away',
    claude: { spawned: 4, denied: 0 }, evaluation: evaluate(samples, { durationHours: 0.5 }), interactions: [{ kind: 'pull', ok: false, note: 'no usable point', tHours: 0.2 }], unbound: { note: 'n' }, notCovered: ['a thing'] };
  const text = renderSoakMarkdown(report);
  assert.match(text, /\*\*Verdict: (PASS|WATCH|FAIL|INCONCLUSIVE)\*\*/);
  assert.match(text, /Memory, all processes/);
  assert.match(text, /- a thing/);
  assert.match(text, /pull: no usable point/);
});

test('--only and --long-chat: one kind of step, validated', () => {
  assert.equal(parseSoakArgs([]).only, null);
  for (const kind of ONLY_STEPS) assert.equal(parseSoakArgs(['--only', kind]).only, kind);
  assert.deepEqual([...ONLY_STEPS], ['chat', 'hide', 'touch', 'pinch', 'pull']);
  assert.throws(() => parseSoakArgs(['--only', 'dance']), /--only needs one of/);
  assert.equal(parseSoakArgs(['--long-chat', '0']).longChat, '0');
  assert.throws(() => parseSoakArgs(['--long-chat', 'yes']), /0 or 1/);
});

test('per-step record: frame windows add up, deltas and counts come from the two readings', () => {
  const a = new Array(FRAME_BINS).fill(0), b = new Array(FRAME_BINS).fill(0);
  a[16] = 100; b[16] = 50; b[150] = 2; b[400] = 1;
  const merged = mergeFrameWindows({ bins: a, longTasks: 1, longTaskMs: 60, hidden: 0 }, { bins: b, longTasks: 2, longTaskMs: 100, hidden: 1 });
  assert.equal(merged.bins[16], 150);
  assert.deepEqual([merged.longTasks, merged.hidden], [3, 1]);
  assert.equal(mergeFrameWindows(null, null), null);
  assert.equal(mergeFrameWindows(null, merged), merged);
  const step = stepRecord({ kind: 'chat', tHours: 0.1234567, ms: 4321.7, before: { mainPrivateMB: 120, heapUsedMB: 30, rssMB: 200, spawned: 3 },
    after: { mainPrivateMB: 125.5, heapUsedMB: 30.4, rssMB: 203, spawned: 6 }, window: merged, loop: { maxMs: 312.34, p99Ms: 20 } });
  assert.deepEqual([step.mainPrivateDeltaMB, step.heapUsedDeltaMB, step.rssDeltaMB, step.spawned], [5.5, 0.4, 3, 3]);
  assert.deepEqual([step.frames.over100, step.frames.over250, step.loopMaxMs, step.ms], [3, 1, 312.3, 4322]);
  const blind = stepRecord({ kind: 'pull', before: {}, after: {} });
  assert.deepEqual([blind.mainPrivateDeltaMB, blind.spawned, blind.frames, blind.loopMaxMs], [null, null, null, null]);
});

test('step summary: per kind, the warm-up round is left out, and the report shows the table', () => {
  const read = (mainPrivateMB, spawned) => ({ mainPrivateMB, heapUsedMB: 10, rssMB: 100, spawned });
  const rec = (kind, extra) => stepRecord({ kind, before: read(100, 0), after: read(100, 0), ...extra });
  const slow = new Array(FRAME_BINS).fill(0); slow[300] = 1;
  const steps = [rec('chat', { warmup: true, after: read(140, 3) }), rec('chat', { after: read(110, 3), window: { bins: slow }, spawnedInStep: 1 }), rec('chat', { after: read(110, 2), tail: { bins: slow } }), rec('hide-show', {})];
  const groups = summarizeSteps(steps), chat = groups.find(g => g.kind === 'chat');
  assert.deepEqual([chat.count, chat.spawned, chat.spawnedPerStep, chat.over250, chat.stepsWithOver250, chat.privateDeltaSumMB], [2, 5, 2.5, 1, 1, 20]);
  assert.equal(groups.find(g => g.kind === 'hide-show').spawned, 0);
  const samples = flat(8);
  const report = { startedAt: 't', exe: 'x.exe', exeBytes: 1, exeModified: 'm', durationHours: 0.5, options: { tickSeconds: 300, only: 'chat' }, samples, machine: { cpu: 'cpu', cores: 20, memGB: 32 }, presenceAtStart: 'x',
    claude: { spawned: 4, denied: 0 }, evaluation: evaluate(samples, { durationHours: 0.5 }), interactions: [], steps, unbound: null, notCovered: [] };
  const text = renderSoakMarkdown(report);
  assert.match(text, /## Steps \(before and after each scripted step; only chat\)/);
  assert.match(text, /\| chat \| 2 \(0 failed\) \| 1 \| 1 \| 1 \| 1 \| 0 \| 1 \| 5 \(2\.5\)/);
  const late = new Array(FRAME_BINS).fill(0); late[500] = 2;
  const withTail = stepRecord({ kind: 'chat', before: read(100, 0), after: read(100, 3), spawnedInStep: 1, tail: { bins: late }, measure: { bins: late } });
  assert.deepEqual([withTail.spawnedInStep, withTail.spawned, withTail.tailOver250, withTail.measureOver250], [1, 3, 2, 2]);
});
