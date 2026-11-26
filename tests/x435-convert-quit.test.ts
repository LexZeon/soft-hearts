// Codex X-435 (I-071 v2 第三步 转换): quitting while a conversion runs. before-quit holds the quit once, cancels the conversion the
// way the user's 「取消」 does (abort → the call's own stop → its process ends) and lets the quit go on when it has ended or after
// CONVERSION_QUIT_LIMIT_MS. What it leaves is what fix 8's recovery expects. A fake Claude call with a fake child process stands in
// for streamClaude (the same abort listener → stop → close order); real conversion service and stores; synthetic cards only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createConversionQuitGate, CONVERSION_QUIT_LIMIT_MS, type ConversionQuitTarget } from '../electron/cards/character-convert/quit';
import { conversionModel, type ConversionStream } from '../electron/cards/character-convert/model';
import { createConversion } from '../electron/cards/character-convert/electron-wiring';
import { ALL_KEPT, filesOf, makeFixture, withDirectory, type Fixture } from './helpers/convert-fixture';

const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async (check: () => boolean, ms = 3_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const listOf = (folder: string) => readdir(folder).catch(() => [] as string[]);

/** Fake timers: the limit fires only when the test says so. */
function timers() {
  const pending: { callback: () => void; ms: number }[] = [];
  return { pending, setTimer: (callback: () => void, ms: number) => { pending.push({ callback, ms }); }, fire: () => { for (const item of pending.splice(0)) item.callback(); } };
}
function fakeTarget(running = true) {
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const target: ConversionQuitTarget = { get running() { return running; }, cancel: () => { calls.push('cancel'); return true; }, idle: () => { calls.push('idle'); return settled; } };
  return { target, calls, release };
}

// ---- the gate --------------------------------------------------------------------------------------------------------------------------

test('quit while converting: cancel once, the quit is held, and it goes on (once) when the conversion has ended', async () => {
  const t = timers(), f = fakeTarget();
  let quits = 0;
  const gate = createConversionQuitGate(() => f.target, () => { quits++; }, t.setTimer);
  assert.equal(gate.hold(), true, 'held');
  assert.deepEqual(f.calls, ['cancel', 'idle']);
  assert.deepEqual(t.pending.map(item => item.ms), [CONVERSION_QUIT_LIMIT_MS]);
  assert.equal(CONVERSION_QUIT_LIMIT_MS, 3_000);
  assert.equal(gate.hold(), true, 'a second before-quit while it ends is held too');
  assert.deepEqual(f.calls, ['cancel', 'idle'], 'cancelled only once');
  await tick();
  assert.equal(quits, 0);
  f.release(); await tick(); await tick();
  assert.equal(quits, 1);
  await gate.ended();
  t.fire();
  assert.equal(quits, 1, 'the limit after the end does not quit again');
  assert.equal(gate.hold(), false, 'the quit that follows is not held');
});

test('quit while converting: a conversion that never settles holds the quit only until the limit', async () => {
  const t = timers(), f = fakeTarget();
  let quits = 0, ended = false;
  const gate = createConversionQuitGate(() => f.target, () => { quits++; }, t.setTimer);
  const started = Date.now();
  assert.equal(gate.hold(), true);
  assert.ok(Date.now() - started < 50, 'hold returns at once: nothing in before-quit waits on it');
  void gate.ended().then(() => { ended = true; });
  await tick(); await tick();
  assert.equal(quits, 0); assert.equal(ended, false);
  t.fire(); await tick();
  assert.equal(quits, 1); assert.equal(ended, true, 'the flush that waits on it goes on at the limit too');
  assert.equal(gate.hold(), false);
});

test('quit with no conversion running: nothing is cancelled, nothing is held, nothing waits', async () => {
  for (const target of [null, fakeTarget(false).target]) {
    const t = timers();
    let quits = 0;
    const gate = createConversionQuitGate(() => target, () => { quits++; }, t.setTimer);
    assert.equal(gate.hold(), false);
    assert.equal(t.pending.length, 0);
    await gate.ended();
    assert.equal(quits, 0);
  }
  const idle = fakeTarget(false);
  createConversionQuitGate(() => idle.target, () => {}).hold();
  assert.deepEqual(idle.calls, []);
});

// ---- with the real conversion service and a fake child process --------------------------------------------------------------------------

/** streamClaude's shape for one call: a child process; abort → stop (terminate) → the child closes → the call rejects. */
function fakeChildren(endsOnKill: boolean) {
  const children: { alive: boolean; killed: number }[] = [];
  let unstick: (() => void)[] = [];
  const stream: ConversionStream = (_task, signal) => new Promise((resolve, reject) => {
    const child = { alive: true, killed: 0 };
    children.push(child);
    const close = () => { child.alive = false; reject(new Error('Claude Code 已停止。')); };
    signal.addEventListener('abort', () => {
      child.killed++; // terminateClaude: taskkill /T /F on Windows
      if (endsOnKill) setTimeout(close, 20);
    }, { once: true });
    unstick.push(close);
  });
  return { stream, children, release: () => { for (const close of unstick) close(); unstick = []; } };
}
function restart(fixture: Fixture) {
  return createConversion({ profileDirectory: fixture.directory, wiring: fixture.wiring, settings: () => structuredClone(fixture.settings.current),
    saveSettings: async next => { fixture.settings.current = structuredClone(next); }, modelChoice: () => ({ model: 'sonnet', effort: 'low' }),
    emit: () => {}, register: () => {}, send: async () => null, uiLanguage: () => 'zh-CN' }, fixture.model.current);
}
const convertFolder = (fixture: Fixture, ...parts: string[]) => path.join(fixture.directory, 'character-convert', ...parts);

test('quitting while it translates: the call is cancelled like 取消, its process ends, the quit goes on; nothing of it is left', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const fake = fakeChildren(true);
  fixture.model.current = conversionModel(() => ({ model: 'sonnet', effort: 'low' }), fake.stream);
  const before = await filesOf(directory);
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await waitFor(() => fake.children.length === 1);
  assert.equal((await listOf(convertFolder(fixture, 'backups'))).length, 1, 'it is past its backup');
  let quits = 0;
  const gate = createConversionQuitGate(() => fixture.service, () => { quits++; });
  const started = Date.now();
  assert.equal(gate.hold(), true);
  await gate.ended();
  assert.equal(quits, 1);
  assert.ok(Date.now() - started < CONVERSION_QUIT_LIMIT_MS, 'it ended before the limit');
  assert.deepEqual(fake.children, [{ alive: false, killed: 1 }], 'the running Claude process was stopped and has ended');
  assert.equal(fixture.service.running, false);
  assert.equal(fixture.service.view()!.state, 'cancelled');
  // Exactly what a user cancel leaves: nothing (no marker, no backup, no folder of its own); the rest is byte for byte as before.
  const after = await filesOf(directory);
  assert.deepEqual([...after.keys()].filter(file => file.startsWith('character-convert/')), []);
  for (const [file, bytes] of before) if (!file.startsWith('character-convert/')) assert.ok(bytes.equals(after.get(file)!), `${file} changed`);
  assert.equal(await restart(fixture).ensureRecovered(), 0, 'the next start finds nothing to recover');
}));

test('quitting while a process ignores the stop: the quit goes on at the limit; the marker it leaves is rolled back at the next start', async () => withDirectory(async directory => {
  const fixture = await makeFixture(directory);
  const fake = fakeChildren(false);
  fixture.model.current = conversionModel(() => ({ model: 'sonnet', effort: 'low' }), fake.stream);
  await fixture.service.start({ characterId: fixture.sourceId, language: 'en', names: ALL_KEPT });
  await waitFor(() => fake.children.length === 1);
  let quits = 0;
  const limit = 60;
  const gate = createConversionQuitGate(() => fixture.service, () => { quits++; }, undefined, limit);
  const started = Date.now();
  assert.equal(gate.hold(), true);
  await gate.ended();
  const waited = Date.now() - started;
  assert.equal(quits, 1);
  assert.ok(waited >= limit - 5 && waited < 1_000, `bounded (${waited} ms)`);
  assert.equal(fake.children[0]!.killed, 1, 'the stop was sent');
  // The app is gone here: its marker (job.json naming its backup) and the backup are left, as after a crash during translation.
  const staged = await listOf(convertFolder(fixture, 'staging'));
  assert.equal(staged.length, 1);
  assert.deepEqual(await listOf(convertFolder(fixture, 'staging', staged[0]!)), ['job.json']);
  assert.equal((await listOf(convertFolder(fixture, 'backups'))).length, 1);
  await restart(fixture).ensureRecovered();
  assert.deepEqual(await listOf(convertFolder(fixture, 'backups')), []);
  assert.deepEqual(await listOf(convertFolder(fixture, 'staging')), []);
  fake.release();
  await fixture.service.idle();
}));
