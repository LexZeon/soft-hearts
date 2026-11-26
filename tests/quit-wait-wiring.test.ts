// I-182 wiring (electron/wiring/startup-wait-wiring.ts): takeStartupLock and noteQuitStarted's actual text, run against a fake app and
// a real temp profile folder. The holder clears the last marker only after it has the lock and writes its own when its quit begins;
// a launch that hands over or waits writes nothing into the profile of the instance it met.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { clearQuitMarker, quitMarkerPath, quitMarkerToWrite, readQuitMarker, runStartupLock, writeQuitMarker, type QuitMarker } from '../electron/foundation/quit-wait/plan';
import { wiringFunction } from './helpers/wiring-source';

const CODE = ts.transpileModule(`let holdsProfileLock = false;\n${wiringFunction('takeStartupLock')}\n${wiringFunction('noteQuitStarted')}\nreturn { takeStartupLock, noteQuitStarted };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const SELF = 9001, OLD = 1717;
const markerFiles = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, rmSync: fs.rmSync } as Parameters<typeof readQuitMarker>[0];

function fixture(profile: string, oldAlive: () => boolean) {
  const log: string[] = [];
  const quitListeners: (() => void)[] = [];
  const app = {
    getPath: (name: string) => { assert.equal(name, 'userData'); return profile; },
    once: (event: string, listener: () => void) => { assert.equal(event, 'before-quit'); log.push('once before-quit'); quitListeners.push(listener); },
    releaseSingleInstanceLock: () => log.push('releaseLock'),
    quit: () => log.push('app.quit'),
  };
  const sandbox: Record<string, unknown> = {
    app, markerFiles, runStartupLock, readQuitMarker, clearQuitMarker, writeQuitMarker, quitMarkerToWrite,
    aliveAs: (pid: number) => pid === OLD && oldAlive(), sleepSync: (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }, // the grace is real time here (1.5 s)
    waitThenRelaunch: (_profile: string, marker: QuitMarker) => log.push('wait for ' + marker.pid),
    currentUiLanguage: () => 'en', process: { pid: SELF, execPath: 'C:\\Apps\\soft hearts next\\soft hearts next.exe' }, Date,
  };
  const made = new Function(...Object.keys(sandbox), CODE)(...Object.values(sandbox)) as { takeStartupLock(request: () => boolean): boolean; noteQuitStarted(): void };
  return { ...made, log, quit: () => { for (const listener of quitListeners) listener(); } };
}

test('the lock holder clears the last marker after taking the lock, and writes its own when its quit begins', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'soft-quit-wait-wiring-'));
  try {
    // The last instance crashed while quitting: its marker is still there, its pid is gone.
    writeQuitMarker(markerFiles, profile, { pid: OLD, at: Date.now() - 1_000, image: 'soft hearts next.exe', lang: 'zh-CN' });
    const app = fixture(profile, () => false);
    let asked = 0;
    assert.equal(app.takeStartupLock(() => { asked++; assert.ok(fs.existsSync(quitMarkerPath(profile)), 'cleared before the lock was taken'); return true; }), true);
    assert.equal(asked, 1);
    assert.equal(fs.existsSync(quitMarkerPath(profile)), false);
    assert.deepEqual(app.log, ['once before-quit']);
    app.quit();
    const written = readQuitMarker(markerFiles, profile);
    assert.equal(written?.pid, SELF);
    assert.equal(written?.image, 'soft hearts next.exe');
    assert.equal(written?.lang, 'en');
    assert.ok(Math.abs((written?.at ?? 0) - Date.now()) < 5_000);
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('a launch that hands over, or waits, writes no marker into the profile it met', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'soft-quit-wait-wiring-'));
  try {
    const running = fixture(profile, () => true);
    assert.equal(running.takeStartupLock(() => false), false);
    assert.deepEqual(running.log, ['app.quit']);
    running.noteQuitStarted(); // even if its own quit ran a before-quit
    assert.equal(fs.existsSync(quitMarkerPath(profile)), false);

    const old: QuitMarker = { pid: OLD, at: Date.now() - 500, image: 'soft hearts next.exe', lang: 'zh-CN' };
    writeQuitMarker(markerFiles, profile, old);
    const waiting = fixture(profile, () => true);
    assert.equal(waiting.takeStartupLock(() => true), false); // Electron gave the lock back early; the old process lives on
    assert.deepEqual(waiting.log, ['releaseLock', 'wait for ' + OLD]);
    waiting.noteQuitStarted();
    assert.deepEqual(readQuitMarker(markerFiles, profile), old, 'the quitting instance\'s marker is left as it was');
  } finally { await rm(profile, { recursive: true, force: true }); }
});

const WAITER = ts.transpileModule(`${wiringFunction('waitThenRelaunch')}\nreturn waitThenRelaunch;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

/** waitThenRelaunch's actual text with a fake app: what it does before the app is ready, and after the wait. */
function waiter(outcome: 'gone' | 'timeout') {
  const log: string[] = [];
  let ready!: () => void;
  const whenReady = new Promise<void>(resolve => { ready = resolve; });
  let exited!: () => void;
  const done = new Promise<void>(resolve => { exited = resolve; });
  const app = {
    setPath: (name: string, value: string) => log.push(`setPath ${name} ${value}`),
    whenReady: () => { log.push('whenReady'); return whenReady.then(() => { log.push('ready'); }); },
    exit: (code: number) => { log.push('exit ' + code); exited(); },
  };
  const sandbox: Record<string, unknown> = {
    app, waitingFolder: () => 'T:\\temp\\soft-hearts-wait\\9001', QUIT_WAIT: { giveUpNoticeMs: 1 },
    QUIT_WAIT_COPY: { 'zh-CN': { waiting: 'zh waiting', gaveUp: 'zh gave up' }, en: { waiting: 'en waiting', gaveUp: 'en gave up' } },
    showNotice: (text: string) => { log.push('notice ' + text); return { say: (line: string) => log.push('say ' + line) }; },
    waitForOldExit: async () => { log.push('wait'); return outcome; },
    readQuitMarker, markerFiles, aliveAs: () => true, sleep: async () => undefined,
    spawn: (file: string, args: string[], options: { detached: boolean; stdio: string }) => {
      log.push(`spawn ${file} ${args.join(' ')} ${options.detached} ${options.stdio}`); return { unref: () => log.push('unref') }; },
    process: { pid: SELF, execPath: 'C:\\Apps\\soft hearts next.exe', argv: ['C:\\Apps\\soft hearts next.exe', '--soft-hearts-channel=stable'], cwd: () => 'C:\\Apps' },
    console, Date,
  };
  const run = new Function(...Object.keys(sandbox), WAITER)(...Object.values(sandbox)) as (profile: string, marker: QuitMarker, startedAt: number) => void;
  return { log, run, ready: () => ready(), done };
}

test('a waiting launch leaves the profile before the app is ready, then starts a fresh launch once the old one is gone', async () => {
  const w = waiter('gone');
  w.run('C:\\Users\\x\\AppData\\Roaming\\soft-hearts-claude', { pid: OLD, at: 1, image: 'soft hearts next.exe', lang: 'en' }, 1);
  // Synchronously, before ready: its own Chromium data goes to the throw-away folder (never the profile).
  assert.deepEqual(w.log, ['setPath userData T:\\temp\\soft-hearts-wait\\9001', 'setPath sessionData T:\\temp\\soft-hearts-wait\\9001', 'whenReady']);
  w.ready();
  await w.done;
  assert.deepEqual(w.log.slice(3), ['ready', 'notice en waiting', 'wait',
    'spawn C:\\Apps\\soft hearts next.exe --soft-hearts-channel=stable true ignore', 'unref', 'exit 0']);
});

test('a waiting launch that runs out of time says so and starts nothing', async () => {
  const w = waiter('timeout');
  w.run('C:\\profile', { pid: OLD, at: 1, image: 'soft hearts next.exe', lang: 'zh-CN' }, 1);
  w.ready();
  await w.done;
  assert.deepEqual(w.log.slice(3), ['ready', 'notice zh waiting', 'wait', 'say zh gave up', 'exit 0']);
  assert.ok(!w.log.some(line => line.startsWith('spawn')));
});
