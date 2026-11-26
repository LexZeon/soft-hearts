// 显卡有没有用上: the app asks for the
// high-performance chip, never for software, says at start in closed words which chip draws (and says so loudly when it is the processor), and
// the full-screen page asks for the high-performance chip too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GPU_CHOICE_OPPOSITE_SWITCH, GPU_CHOICE_SWITCH, gpuChoicePlan, gpuStartLine, gpuStartRow } from '../electron/foundation/gpu-choice/plan';
import { GPU_START_DELAY_MS, installGpuChoice, type GpuChoiceApp } from '../electron/foundation/gpu-choice/host';
import { classifyRenderer, graphicsChips, vendorOfId } from '../shared/foundation/gpu-kind';
import { gpuOfContext, unboundGlOptions } from '../src/unbound/gl-options';
import { gpuLine } from '../src/unbound/debug-lines';
import { buildJournalEntry, describeJournalEntry } from '../shared/memory/journal';
import type { PerfManager } from '../src/unbound/perf';

const NVIDIA = 'ANGLE (NVIDIA, NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU) (0x00002E03) Direct3D11 vs_5_0 ps_5_0, D3D11)';
// This machine's own list (Windows on ARM, one graphics chip): the chip, Microsoft's basic render driver, and an entry with no name.
const THIS_MACHINE = [{ vendorId: 4318, deviceString: 'NVIDIA RTX Spark N1X' }, { vendorId: 5140, deviceString: 'Microsoft Basic Render Driver' }, { vendorId: 1094997582 }];
const LAPTOP = [{ vendorId: 0x8086, deviceString: 'Intel(R) Iris(R) Xe Graphics' }, { vendorId: 0x10de, deviceString: 'NVIDIA GeForce RTX 4060 Laptop GPU' }, { vendorId: 0x1414 }];

test('what the renderer string says, in closed words: hardware or software, the vendor family', () => {
  assert.deepEqual(classifyRenderer(NVIDIA), { kind: 'hardware', vendor: 'nvidia' });
  assert.deepEqual(classifyRenderer('ANGLE (AMD, AMD Radeon RX 7600 (0x00007480) Direct3D11 vs_5_0 ps_5_0, D3D11)'), { kind: 'hardware', vendor: 'amd' });
  assert.deepEqual(classifyRenderer('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'), { kind: 'hardware', vendor: 'intel' });
  assert.deepEqual(classifyRenderer('ANGLE (Qualcomm, Adreno (TM) 741 Direct3D11 vs_5_0 ps_5_0, D3D11)'), { kind: 'hardware', vendor: 'qualcomm' });
  assert.deepEqual(classifyRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), { kind: 'hardware', vendor: 'apple' });
  assert.deepEqual(classifyRenderer('ANGLE (Vivante, GC7000 Direct3D11)'), { kind: 'hardware', vendor: 'other' });
  for (const software of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)']) {
    assert.equal(classifyRenderer(software).kind, 'software', software);
  }
  for (const nothing of [null, undefined, '', '   ', 7]) assert.deepEqual(classifyRenderer(nothing), { kind: 'unknown', vendor: 'other' });
});

test('how many real graphics chips a machine lists: Microsoft\'s basic driver and nameless entries are not chips', () => {
  assert.equal(graphicsChips(THIS_MACHINE), 1);
  assert.equal(graphicsChips(LAPTOP), 2);
  assert.equal(graphicsChips([]), 0);
  assert.equal(graphicsChips(undefined), null, 'Electron could not tell');
  assert.equal(vendorOfId(0x10de), 'nvidia'); assert.equal(vendorOfId(0x1414), 'other'); assert.equal(vendorOfId('x'), 'other');
});

test('the plan: the high-performance chip is asked for; the opposite request, if someone made it, is left alone; software is never asked for', () => {
  assert.deepEqual(gpuChoicePlan(() => false).switches, [GPU_CHOICE_SWITCH]);
  assert.equal(GPU_CHOICE_SWITCH, 'force_high_performance_gpu', 'the Chromium switch (found in the Electron 45 binary)');
  assert.deepEqual(gpuChoicePlan(name => name === GPU_CHOICE_OPPOSITE_SWITCH).switches, [], 'someone chose the low-power chip on purpose');
  assert.deepEqual(gpuChoicePlan(name => name === GPU_CHOICE_SWITCH).switches, [], 'already asked');
  for (const never of ['disable-gpu', 'disable-software-rasterizer', 'use-gl=swiftshader', 'enable-unsafe-swiftshader', 'use-angle=swiftshader']) {
    assert.ok(!gpuChoicePlan(() => false).switches.some(name => name.startsWith(never.split('=')[0]!)), `never ${never}`);
  }
});

test('the start row: this machine (one chip) and a laptop with two, closed words only', () => {
  assert.deepEqual(gpuStartRow({ renderer: NVIDIA }, THIS_MACHINE, true), { kind: 'hardware', vendor: 'nvidia', secondChip: 'no', asked: true, fellBack: false });
  assert.deepEqual(gpuStartRow({ renderer: NVIDIA }, LAPTOP, true), { kind: 'hardware', vendor: 'nvidia', secondChip: 'yes', asked: true, fellBack: false });
  assert.deepEqual(gpuStartRow(null, null, true), { kind: 'unknown', vendor: 'other', secondChip: 'unknown', asked: true, fellBack: false }, 'nothing read: said so, not guessed');
  assert.equal(gpuStartRow(null, THIS_MACHINE, false).vendor, 'nvidia', 'no renderer string but one listed chip: the vendor family is still known');
});

test('software rendering is reported, loudly when a graphics chip is listed', () => {
  const swift = { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' };
  const row = gpuStartRow(swift, LAPTOP, true);
  assert.equal(row.kind, 'software'); assert.equal(row.fellBack, true, 'a real chip is listed and the processor draws: the case nobody would see');
  assert.match(gpuStartLine(row), /SOFTWARE although a graphics chip is listed/);
  const nochip = gpuStartRow(swift, [{ vendorId: 0x1414 }], true);
  assert.equal(nochip.kind, 'software'); assert.equal(nochip.fellBack, false, 'a machine with no chip at all has nothing to fall back from');
  assert.match(gpuStartLine(nochip), /SOFTWARE/);
  assert.doesNotMatch(gpuStartLine(gpuStartRow({ renderer: NVIDIA }, THIS_MACHINE, true)), /SOFTWARE/);
  // The developer readout of the full-screen page says so.
  const perf = (gpu: { kind: string; vendor: string } | null) => ({ gpu }) as unknown as PerfManager;
  assert.match(gpuLine(perf({ kind: 'software', vendor: 'other' })), /没有用上显卡/);
  assert.match(gpuLine(perf({ kind: 'hardware', vendor: 'nvidia' })), /硬件渲染（nvidia）/);
  assert.match(gpuLine(perf(null)), /还没读到/);
  // ... and the page reads it from its own WebGL context.
  const context = (renderer: string) => ({ getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 37446 }), getParameter: () => renderer, RENDERER: 7937 }) as unknown as WebGLRenderingContext;
  assert.deepEqual(gpuOfContext(context(swift.renderer)), { kind: 'software', vendor: 'other' });
  assert.deepEqual(gpuOfContext(context(NVIDIA)), { kind: 'hardware', vendor: 'nvidia' });
  assert.deepEqual(gpuOfContext(null), { kind: 'unknown', vendor: 'other' });
  assert.deepEqual(gpuOfContext({ getExtension: () => { throw new Error('lost'); } } as unknown as WebGLRenderingContext), { kind: 'unknown', vendor: 'other' });
});

test('the full-screen page asks for the high-performance chip (not the low-power one), alpha on, antialias as the tier says', () => {
  assert.deepEqual(unboundGlOptions(true), { alpha: true, antialias: true, powerPreference: 'high-performance' });
  assert.equal(unboundGlOptions(false).antialias, false);
});

function fakeApp(order: string[]) {
  let ready!: () => void;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  const switches = new Set<string>();
  const app: GpuChoiceApp = {
    commandLine: { appendSwitch: name => { order.push(`switch ${name}`); switches.add(name); }, hasSwitch: name => switches.has(name) },
    whenReady: () => { order.push('whenReady'); return readyPromise; },
    getGPUInfo: async () => ({ gpuDevice: THIS_MACHINE }),
  };
  return { app, ready, switches };
}

test('the host: the switch goes on before the app is ready, the row a few seconds after, and nothing it does can end the app', async () => {
  const order: string[] = [], rows: unknown[] = [], logs: string[] = [], timers: { run: () => void; ms: number }[] = [];
  const { app, ready } = fakeApp(order);
  const applied = installGpuChoice(app, { probe: async () => ({ renderer: NVIDIA }), record: row => { rows.push(row); }, log: line => logs.push(line), setTimer: (run, ms) => { timers.push({ run, ms }); return 1; } });
  assert.deepEqual(applied, [GPU_CHOICE_SWITCH]);
  assert.deepEqual(order, [`switch ${GPU_CHOICE_SWITCH}`, 'whenReady'], 'the switch first: Chromium only reads it before the app is ready');
  assert.equal(rows.length, 0, 'no row before the app is up');
  ready(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 1); assert.equal(timers[0]!.ms, GPU_START_DELAY_MS, 'a few seconds after ready: the launch is not slowed');
  timers[0]!.run(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rows, [{ kind: 'hardware', vendor: 'nvidia', secondChip: 'no', asked: true, fellBack: false }]);
  assert.equal(logs.length, 1);
});

test('the host: a probe or a device read that fails still writes a row (unknown), and a journal that throws changes nothing', async () => {
  const { app, ready } = fakeApp([]);
  const rows: unknown[] = [], timers: (() => void)[] = [];
  app.getGPUInfo = async () => { throw new Error('no info'); };
  installGpuChoice(app, { probe: async () => { throw new Error('no page'); }, record: row => { rows.push(row); throw new Error('journal off'); }, setTimer: run => { timers.push(run); return 1; } });
  ready(); await new Promise(resolve => setImmediate(resolve));
  timers[0]!(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rows, [{ kind: 'unknown', vendor: 'other', secondChip: 'unknown', asked: true, fellBack: false }]);
});

test('the opposite request on the command line is left alone, and the row says no high-performance chip was asked for', async () => {
  const { app, ready, switches } = fakeApp([]);
  switches.add(GPU_CHOICE_OPPOSITE_SWITCH);
  const rows: unknown[] = [], timers: (() => void)[] = [];
  assert.deepEqual(installGpuChoice(app, { probe: async () => ({ renderer: NVIDIA }), record: row => { rows.push(row); }, setTimer: run => { timers.push(run); return 1; } }), []);
  ready(); await new Promise(resolve => setImmediate(resolve));
  timers[0]!(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal((rows[0] as { asked: boolean }).asked, false);
});

// ---- the journal rows --------------------------------------------------------------------------------------------------------------

const AT = Date.parse('2026-11-24T10:00:00Z');
test('the gpu-start row: closed words only, never a driver string, a path or a name', () => {
  const entry = buildJournalEntry({ type: 'gpu-start', characterId: null, kind: 'software', vendor: 'other', secondChip: 'yes', asked: true, fellBack: true, renderer: NVIDIA, path: 'C:\\x' } as never, AT)!;
  assert.ok(entry);
  const text = JSON.stringify(entry);
  assert.doesNotMatch(text, /RTX|ANGLE|C:\\\\|renderer|path/);
  assert.match(describeJournalEntry(entry, (s, ...v) => s.replace(/\{(\d)\}/g, (_m, i) => String(v[Number(i)]))), /处理器/);
  for (const bad of [{ kind: 'nvidia' }, { vendor: 'ANGLE' }, { secondChip: 'maybe' }, { asked: 'yes' }, { fellBack: 1 }]) {
    assert.equal(buildJournalEntry({ type: 'gpu-start', characterId: null, kind: 'hardware', vendor: 'nvidia', secondChip: 'no', asked: true, fellBack: false, ...bad } as never, AT), null, JSON.stringify(bad));
  }
});

test('the frame-time row: numbers and one tier word; nothing else gets through', () => {
  const entry = buildJournalEntry({ type: 'frame-time', characterId: 'gene', tier: 'high', onStage: 3, withYou: false, fps: 30.04, medianMs: 33.34, p95Ms: 34.9, frames: 1802, idlePct: 97, text: '你好' } as never, AT)!;
  assert.ok(entry);
  assert.doesNotMatch(JSON.stringify(entry), /你好|text/);
  assert.equal((entry as { fps: number }).fps, 30);
  for (const bad of [{ tier: 'ultra' }, { onStage: 0 }, { onStage: 4 }, { fps: -1 }, { fps: 1000 }, { medianMs: 'x' }, { idlePct: 101 }, { withYou: 'no' }]) {
    assert.equal(buildJournalEntry({ type: 'frame-time', characterId: 'gene', tier: 'high', onStage: 3, withYou: false, fps: 30, medianMs: 33, p95Ms: 34, frames: 100, idlePct: 50, ...bad } as never, AT), null, JSON.stringify(bad));
  }
});
