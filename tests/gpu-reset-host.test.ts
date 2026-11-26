// 显卡重置后她自己回来 (docs/claude/2026-11-22-gpu-reset.md): the host's GPU process watch (electron/foundation/gpu-reset/), run against a
// fake app. A GPU process end is one journal row of closed words and numbers; the app is never quit, exited or relaunched; before ready the
// crash limit is lifted and WebGL's domain block is turned off (the two things the Electron 45 repro showed are needed together).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { wiringFunction } from './helpers/wiring-source';
import { installGpuReset, type GpuResetApp } from '../electron/foundation/gpu-reset/host';
import { GPU_CRASH_LIMIT_SWITCH, GPU_PROCESS_ENDS, GpuResetLog, gpuStartupPlan, webglWorks, type GpuResetRow } from '../electron/foundation/gpu-reset/plan';
import { GPU_PROCESS_ENDS as SHARED_ENDS } from '../shared/foundation/gpu-reset';
import { buildJournalEntry } from '../shared/memory/journal';

function fakeApp(status: () => Record<string, string> = () => ({ webgl: 'enabled' })) {
  const calls: string[] = [];
  let gone: ((event: unknown, details: Record<string, unknown>) => void) | null = null;
  const app = {
    commandLine: { appendSwitch: (name: string) => calls.push(`switch ${name}`) },
    disableDomainBlockingFor3DAPIs: () => calls.push('noDomainBlock'),
    on: (event: string, listener: never) => { calls.push(`on ${event}`); if (event === 'child-process-gone') gone = listener; },
    getGPUFeatureStatus: () => status(),
    // Anything that would end or restart the app fails the test.
    quit: () => { throw new Error('quit'); }, exit: () => { throw new Error('exit'); }, relaunch: () => { throw new Error('relaunch'); },
  };
  return { app: app as unknown as GpuResetApp, calls, fire: (details: Record<string, unknown>) => gone?.({}, details) };
}

test('before ready: the GPU crash limit is lifted and WebGL is not blocked after crashes', () => {
  assert.deepEqual(gpuStartupPlan(), { switches: [GPU_CRASH_LIMIT_SWITCH], disableDomainBlocking: true });
  assert.equal(GPU_CRASH_LIMIT_SWITCH, 'disable-gpu-process-crash-limit');
  const { app, calls } = fakeApp();
  installGpuReset(app, { record: () => {} });
  assert.deepEqual(calls, ['switch disable-gpu-process-crash-limit', 'noDomainBlock', 'on child-process-gone']);
});

test('a GPU process crash never ends the app: each end is one row, nothing else happens', () => {
  const { app, fire } = fakeApp();
  const rows: GpuResetRow[] = [];
  const timers: (() => void)[] = [];
  let now = 1_000_000;
  installGpuReset(app, { record: row => rows.push(row), now: () => now, setTimer: run => timers.push(run) });
  // The 20:38 evening: three driver resets about 16 s apart, then three more crashes (what Chromium gives up at by default).
  for (let index = 0; index < 6; index++) { fire({ type: 'GPU', reason: 'crashed', exitCode: -1073741819 }); now += 16_000; }
  for (const run of timers) run();
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], { event: 'gone', ended: 'crashed', exitCode: -1073741819, recent: 1, total: 1 });
  assert.deepEqual(rows[5], { event: 'gone', ended: 'crashed', exitCode: -1073741819, recent: 6, total: 6 });
  // Other child processes are not counted.
  fire({ type: 'Utility', reason: 'crashed', exitCode: 1 });
  assert.equal(rows.length, 6);
});

test('WebGL off after a crash (software compositing) is one "software" row, once', () => {
  let webgl = 'enabled';
  const { app, fire } = fakeApp(() => ({ webgl }));
  const rows: GpuResetRow[] = [];
  const timers: (() => void)[] = [];
  installGpuReset(app, { record: row => rows.push(row), now: () => 5_000, setTimer: run => timers.push(run) });
  fire({ type: 'GPU', reason: 'killed', exitCode: 1 });
  timers.shift()!();
  assert.deepEqual(rows.map(row => row.event), ['gone']);
  webgl = 'disabled_off';
  fire({ type: 'GPU', reason: 'launch-failed', exitCode: 0 });
  timers.shift()!(); fire({ type: 'GPU', reason: 'crashed', exitCode: 2 }); timers.shift()!();
  assert.deepEqual(rows.map(row => row.event), ['gone', 'gone', 'software', 'gone']);
  assert.deepEqual(rows[2], { event: 'software', ended: null, exitCode: null, recent: 2, total: 2 });
  assert.equal(webglWorks({ webgl: 'enabled_readback' }), true);
  assert.equal(webglWorks({ webgl: 'unavailable_software' }), false);
  assert.equal(webglWorks(null), null);
});

test('a crash storm is counted but only every 20th row is written past 20 in ten minutes; old ends leave the window', () => {
  const log = new GpuResetLog();
  let written = 0;
  for (let index = 0; index < 100; index++) if (log.gone({ type: 'GPU', reason: 'crashed', exitCode: 1 }, 1_000 + index)) written++;
  assert.equal(log.total, 100);
  assert.equal(written, 20 + 4); // 1..20, then 40, 60, 80, 100
  assert.equal(log.recent(1_000 + 10 * 60_000 + 100), 0);
  // An unknown reason becomes 'unknown'; a strange exit code is dropped.
  assert.deepEqual(new GpuResetLog().gone({ type: 'GPU', reason: 'gremlins', exitCode: 1.5 }, 0), { event: 'gone', ended: 'unknown', exitCode: null, recent: 1, total: 1 });
});

test('a journal or log failure never reaches Electron', () => {
  const { app, fire } = fakeApp(() => { throw new Error('no status'); });
  const timers: (() => void)[] = [];
  installGpuReset(app, { record: () => { throw new Error('journal'); }, log: () => { throw new Error('log'); }, setTimer: run => timers.push(run) });
  assert.doesNotThrow(() => fire({ type: 'GPU', reason: 'crashed', exitCode: 1 }));
  assert.doesNotThrow(() => timers.shift()!());
});

test('the wiring: wireHealth (module top level of electron/main.ts, before ready) installs the watch first, with the real app and the journal', () => {
  const health = wiringFunction('wireHealth');
  assert.ok(health.indexOf('wireGpuReset(given)') > 0 && health.indexOf('wireGpuReset(given)') < health.indexOf('createPartRunner'), 'first thing in wireHealth');
  const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8');
  assert.ok(main.indexOf('wireHealth(parts)') > 0 && main.indexOf('wireHealth(parts)') < main.indexOf('.whenReady()'), 'wireHealth runs before the app is ready');
  // wireGpuReset's own text, run with a fake app: rows go to the journal with the character id.
  const code = ts.transpileModule(`${wiringFunction('wireGpuReset')}\nreturn wireGpuReset;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const { app, calls, fire } = fakeApp();
  const recorded: unknown[] = [];
  const wire = new Function('app', 'installGpuReset', 'console', code)(app, installGpuReset, { warn: () => {} }) as (needs: unknown) => void;
  wire({ appJournal: { record: (input: unknown) => recorded.push(input) }, journalCharacterId: () => 'c7' });
  assert.deepEqual(calls.slice(0, 2), ['switch disable-gpu-process-crash-limit', 'noDomainBlock']);
  fire({ type: 'GPU', reason: 'crashed', exitCode: 5 });
  assert.deepEqual(recorded, [{ type: 'gpu-reset', characterId: 'c7', event: 'gone', ended: 'crashed', exitCode: 5, recent: 1, total: 1 }]);
});

test('the journal line keeps only closed words and numbers', () => {
  assert.deepEqual([...GPU_PROCESS_ENDS], [...SHARED_ENDS]);
  const line = buildJournalEntry({ type: 'gpu-reset', characterId: 'c1', event: 'gone', ended: 'crashed', exitCode: -1073741819, recent: 3, total: 3 }, 0);
  assert.ok(line);
  assert.equal((line as { ended: string }).ended, 'crashed');
  assert.equal(buildJournalEntry({ type: 'gpu-reset', characterId: 'c1', event: 'gone', ended: 'C:\\Users\\x', exitCode: 1, recent: 1, total: 1 } as never, 0), null);
  assert.equal(buildJournalEntry({ type: 'gpu-reset', characterId: 'c1', event: 'software', ended: 'crashed', exitCode: null, recent: 1, total: 1 } as never, 0), null);
  assert.equal(buildJournalEntry({ type: 'gpu-reset', characterId: null, event: 'bored', ended: null, exitCode: null, recent: 1, total: 1 } as never, 0), null);
});
