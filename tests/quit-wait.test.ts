// I-182 (electron/foundation/quit-wait/plan.ts): a launch that meets a quitting instance waits for it instead of exiting silently.
// A fake world stands in for Electron: one old instance moving through running → quitting (before-quit, holds the lock) → tearing
// down (Electron gave the lock back, the process lives on: measured 10–90 s on a busy computer) → gone; a fake clock that sleepSync and
// sleep advance. Nothing here starts Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QUIT_WAIT } from '../electron/foundation/quit-wait/knobs';
import { QUIT_MARKER_FILE, clearQuitMarker, encodeQuitMarker, parseQuitMarker, planStartup, quitMarkerPath, quitMarkerToWrite, quittingInstance,
  readQuitMarker, runStartupLock, tasklistImage, waitForOldExit, windowsProcessPresent, writeQuitMarker, type QuitMarker, type StartupLockSteps } from '../electron/foundation/quit-wait/plan';
import { onSecondInstance } from '../electron/graceful-quit';
import { DEVELOPMENT_PROFILE_FOLDER, PROFILE_FOLDER, profileDirectoryFor } from '../electron/profile';

const SELF = 4242, OLD = 1717;
type OldState = 'running' | 'quitting' | 'teardown' | 'gone' | 'none';

/** The old instance and the clock. `timeline` moves the old one on at given times (ms since the launch began). */
function world(start: OldState, timeline: Array<[number, OldState]> = [], options: { markerAt?: number; image?: string; liveImage?: string } = {}) {
  let now = 1_000_000, state = start;
  const begin = now;
  const marker: QuitMarker = { pid: OLD, at: options.markerAt ?? now - 500, image: options.image ?? 'soft hearts next.exe', lang: 'zh-CN' };
  const log: string[] = [];
  let ours = false;
  const advance = (ms: number) => { now += ms; for (const [at, next] of timeline) if (now - begin >= at && order(next) > order(state)) state = next; };
  const order = (s: OldState) => ['none', 'running', 'quitting', 'teardown', 'gone'].indexOf(s);
  const steps: StartupLockSteps = {
    selfPid: SELF,
    now: () => now,
    // Electron: the lock is the old one's while it runs or quits; its quit event gives it back (teardown and gone: free).
    requestLock: () => { log.push('requestLock'); if (state === 'running' || state === 'quitting') return false; ours = true; return true; },
    releaseLock: () => { log.push('releaseLock'); ours = false; },
    // The old one writes the marker when its quit begins; nobody removes it here (the next holder clears it).
    readMarker: () => (state === 'quitting' || state === 'teardown' || state === 'gone') ? marker : null,
    isAlive: (pid, image) => pid === OLD && state !== 'gone' && state !== 'none' && image.toLowerCase() === (options.liveImage ?? marker.image).toLowerCase(),
    sleepSync: ms => { log.push('sleepSync'); advance(ms); },
  };
  return { steps, log, marker, get state() { return state; }, get ours() { return ours; }, get elapsed() { return now - begin; },
    sleep: async (ms: number) => { advance(ms); }, advance };
}

test('a running instance: hand over at once (it was told and shows itself), no wait, no second ask', () => {
  const w = world('running');
  assert.deepEqual(planStartup(w.steps), { kind: 'hand-over' });
  assert.deepEqual(w.log, ['requestLock']);
});

test('no instance at all: start at once', () => {
  const w = world('none');
  assert.deepEqual(planStartup(w.steps), { kind: 'start' });
  assert.deepEqual(w.log, ['requestLock']);
});

test('a quitting instance with a live pid: wait quietly, and start as soon as it is gone', () => {
  // Idle computer: before-quit for 300 ms, Chromium teardown 200 ms. Inside the grace: no notice, no relaunch.
  const w = world('quitting', [[300, 'teardown'], [500, 'gone']]);
  assert.deepEqual(planStartup(w.steps), { kind: 'start' });
  assert.ok(w.elapsed >= 500 && w.elapsed < QUIT_WAIT.graceMs, `started after ${w.elapsed} ms`);
  assert.equal(w.log.at(-1), 'requestLock');
  assert.ok(w.ours);
});

test('the lock comes back before the process is gone: the launch still does not start on the profile', () => {
  // Busy computer: the old one gives the lock back after 400 ms, then its teardown takes 60 s.
  const w = world('teardown', [[60_000, 'gone']]);
  const plan = planStartup(w.steps);
  assert.equal(plan.kind, 'wait');
  // It had the lock (Electron gave it back early) and gave it back: two processes never use one profile folder.
  assert.deepEqual([w.log[0], w.log.at(-1)], ['requestLock', 'releaseLock']);
  assert.equal(w.ours, false);
  assert.ok(w.elapsed >= QUIT_WAIT.graceMs && w.elapsed < QUIT_WAIT.graceMs + QUIT_WAIT.pollMs);
});

test('waiting: gone after the old process ends; the whole wait stays inside the budget', async () => {
  const w = world('quitting', [[2_000, 'teardown'], [70_000, 'gone']]);
  const plan = planStartup(w.steps);
  assert.equal(plan.kind, 'wait');
  if (plan.kind !== 'wait') return;
  assert.equal(plan.marker.pid, OLD);
  const outcome = await waitForOldExit({ startedAt: plan.startedAt, readMarker: w.steps.readMarker, isAlive: w.steps.isAlive, now: w.steps.now,
    sleep: w.sleep, selfPid: SELF });
  assert.equal(outcome, 'gone');
  assert.ok(w.elapsed >= 70_000 && w.elapsed < 70_000 + QUIT_WAIT.pollMs + 1, `gone noticed at ${w.elapsed} ms`);
});

test('waiting: an old process that never ends gives up after the budget', async () => {
  const w = world('teardown');
  const plan = planStartup(w.steps);
  assert.equal(plan.kind, 'wait');
  if (plan.kind !== 'wait') return;
  const outcome = await waitForOldExit({ startedAt: plan.startedAt, readMarker: w.steps.readMarker, isAlive: w.steps.isAlive, now: w.steps.now,
    sleep: w.sleep, selfPid: SELF });
  assert.equal(outcome, 'timeout');
  assert.equal(w.elapsed, QUIT_WAIT.budgetMs);
  // A shorter budget (the knob) is honoured.
  const short = world('teardown');
  const second = planStartup(short.steps);
  if (second.kind !== 'wait') return assert.fail('expected wait');
  assert.equal(await waitForOldExit({ startedAt: second.startedAt, readMarker: short.steps.readMarker, isAlive: short.steps.isAlive, now: short.steps.now,
    sleep: short.sleep, selfPid: SELF, knobs: { budgetMs: 5_000 } }), 'timeout');
  assert.equal(short.elapsed, 5_000);
});

test('a marker whose pid is dead never makes a launch wait (a crashed instance)', () => {
  // The old one crashed while quitting: marker left behind, process gone, lock free.
  const crashed = world('gone');
  assert.deepEqual(planStartup(crashed.steps), { kind: 'start' });
  assert.deepEqual(crashed.log, ['requestLock']); // no sleep, no second ask
  // It ended between the lock request and reading the marker: ask once more, then start.
  const w = world('quitting');
  const steps: StartupLockSteps = { ...w.steps, readMarker: () => { const marker = w.steps.readMarker(); w.advance(0); return marker; },
    isAlive: () => false, requestLock: (() => { let first = true; return () => { w.log.push('requestLock'); const answer = !first; first = false; return answer; }; })() };
  assert.deepEqual(planStartup(steps), { kind: 'start' });
  assert.deepEqual(w.log, ['requestLock', 'requestLock']);
  assert.equal(quittingInstance(w.marker, { now: () => w.marker.at + 1, selfPid: SELF }, () => false), false);
});

test('a reused pid, an old marker, or our own pid never counts as a quitting instance', () => {
  const now = 5_000_000;
  const marker: QuitMarker = { pid: OLD, at: now - 1_000, image: 'soft hearts next.exe', lang: 'en' };
  const clock = { now: () => now, selfPid: SELF };
  assert.equal(quittingInstance(marker, clock, () => true), true);
  // Another program now has that pid (the wiring compares the program name on Windows).
  const reused = world('teardown', [], { liveImage: 'notepad.exe' });
  assert.deepEqual(planStartup(reused.steps), { kind: 'start' });
  // Older than staleMs: not trusted, whatever the pid.
  assert.equal(quittingInstance({ ...marker, at: now - QUIT_WAIT.staleMs - 1 }, clock, () => true), false);
  const stale = world('teardown', [], { markerAt: 1_000_000 - QUIT_WAIT.staleMs - 1 });
  assert.deepEqual(planStartup(stale.steps), { kind: 'start' });
  // Far in the future (a clock jump): not trusted either.
  assert.equal(quittingInstance({ ...marker, at: now + 120_000 }, clock, () => true), false);
  assert.equal(quittingInstance({ ...marker, pid: SELF }, clock, () => true), false);
  assert.equal(quittingInstance(null, clock, () => true), false);
});

test('runStartupLock: the marker is cleared only once the lock is ours; waiting never reports the lock as held', () => {
  const run = (w: ReturnType<typeof world>) => {
    const calls: string[] = [];
    const steps = { ...w.steps, requestLock: () => { calls.push('requestLock'); return w.steps.requestLock(); },
      releaseLock: () => { calls.push('releaseLock'); w.steps.releaseLock(); } };
    const hasLock = runStartupLock(steps, { clearMarker: () => calls.push('clearMarker'), handOver: () => calls.push('handOver'),
      enterWaiting: marker => calls.push('enterWaiting ' + marker.pid) });
    return { hasLock, calls };
  };
  const fresh = run(world('gone'));
  assert.deepEqual(fresh, { hasLock: true, calls: ['requestLock', 'clearMarker'] });
  assert.deepEqual(run(world('running')), { hasLock: false, calls: ['requestLock', 'handOver'] });
  const waiting = run(world('teardown'));
  assert.equal(waiting.hasLock, false);
  assert.deepEqual(waiting.calls, ['requestLock', 'releaseLock', 'enterWaiting ' + OLD]);
  assert.ok(!waiting.calls.includes('clearMarker'), 'a waiting launch never clears the quitting instance\'s marker');
});

test('every moment of an old instance\'s life: a new launch never starts on the profile while the old process lives', () => {
  for (const start of ['running', 'quitting', 'teardown', 'gone', 'none'] as const) {
    for (const goneAt of [100, 1_400, 1_600, 30_000]) {
      const w = world(start, start === 'running' || start === 'none' ? [] : [[50, 'teardown'], [goneAt, 'gone']]);
      const plan = planStartup(w.steps);
      if (plan.kind === 'start') assert.ok(w.state === 'gone' || w.state === 'none', `${start}/${goneAt}: started while the old one was ${w.state}`);
      if (plan.kind !== 'start') assert.equal(w.ours, false, `${start}/${goneAt}: kept a lock it does not start with`);
      if (start === 'running') assert.equal(plan.kind, 'hand-over');
    }
  }
});

test('the marker: what the lock holder writes, read back, cleared; a broken file is no marker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-quit-wait-'));
  try {
    const files = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, rmSync: fs.rmSync } as Parameters<typeof readQuitMarker>[0];
    // Only the instance that holds the lock writes one (a launch that handed over and quits must not plant one in the live profile).
    assert.equal(quitMarkerToWrite({ holdsLock: false, pid: 1, now: 2, executable: 'C:\\x\\soft hearts next.exe', lang: 'zh-CN' }), null);
    assert.equal(writeQuitMarker(files, root, null), false);
    assert.equal(existsSync(quitMarkerPath(root)), false);
    const marker = quitMarkerToWrite({ holdsLock: true, pid: 321, now: 1_794_000_000_000, executable: 'C:\\Program Files\\soft hearts next\\soft hearts next.exe', lang: 'en' });
    assert.deepEqual(marker, { pid: 321, at: 1_794_000_000_000, image: 'soft hearts next.exe', lang: 'en' });
    assert.equal(writeQuitMarker(files, root, marker), true);
    assert.equal(path.basename(quitMarkerPath(root)), QUIT_MARKER_FILE);
    assert.deepEqual(readQuitMarker(files, root), marker);
    assert.match(await readFile(quitMarkerPath(root), 'utf8'), /"state":"quitting"/);
    clearQuitMarker(files, root);
    assert.equal(existsSync(quitMarkerPath(root)), false);
    assert.equal(readQuitMarker(files, root), null);
    clearQuitMarker(files, root); // twice is fine
    for (const text of ['', 'not json', '[]', 'null', JSON.stringify({ version: 2, state: 'quitting', pid: 1, at: 1, image: 'a.exe' }),
      JSON.stringify({ version: 1, state: 'running', pid: 1, at: 1, image: 'a.exe' }), JSON.stringify({ version: 1, state: 'quitting', pid: 0, at: 1, image: 'a.exe' }),
      JSON.stringify({ version: 1, state: 'quitting', pid: 1.5, at: 1, image: 'a.exe' }), JSON.stringify({ version: 1, state: 'quitting', pid: 1, at: 1, image: '..\\a.exe' }),
      JSON.stringify({ version: 1, state: 'quitting', pid: 1, at: 'x', image: 'a.exe' }), ' '.repeat(5_000)]) {
      await writeFile(quitMarkerPath(root), text);
      assert.equal(readQuitMarker(files, root), null, text.slice(0, 60));
    }
    assert.deepEqual(parseQuitMarker(encodeQuitMarker({ pid: 9, at: 10, image: 'electron.exe', lang: 'zh-CN' })), { pid: 9, at: 10, image: 'electron.exe', lang: 'zh-CN' });
    // Any other language falls back to Chinese.
    assert.equal(parseQuitMarker(JSON.stringify({ version: 1, state: 'quitting', pid: 1, at: 1, image: 'a.exe', lang: 'fr' }))?.lang, 'zh-CN');
    // A write that fails (folder gone) does not throw: the quit goes on.
    assert.equal(writeQuitMarker(files, path.join(root, 'missing', 'deeper'), marker), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the marker lives in whichever profile the instance runs on (stable and development alike)', () => {
  const appData = path.join(os.tmpdir(), 'soft-quit-wait-appdata');
  const development = profileDirectoryFor(appData);
  const stable = profileDirectoryFor(appData, path.join(appData, PROFILE_FOLDER), true);
  assert.equal(quitMarkerPath(development), path.join(appData, DEVELOPMENT_PROFILE_FOLDER, QUIT_MARKER_FILE));
  assert.equal(quitMarkerPath(stable), path.join(appData, PROFILE_FOLDER, QUIT_MARKER_FILE));
});

test('a running instance that is already quitting neither reopens its windows nor quits again', () => {
  const calls: string[] = [];
  const later = (run: () => void) => run();
  assert.equal(onSecondInstance({ argv: ['x.exe'], desktopOwner: '', quitting: true, quit: () => calls.push('quit'), show: () => calls.push('show'), later }), 'ignore');
  assert.equal(onSecondInstance({ argv: ['x.exe', '--soft-hearts-quit'], desktopOwner: '', quitting: true, quit: () => calls.push('quit'), show: () => calls.push('show'), later }), 'ignore');
  assert.equal(calls.length, 0);
  assert.equal(onSecondInstance({ argv: ['x.exe'], desktopOwner: '', quitting: false, quit: () => calls.push('quit'), show: () => calls.push('show'), later }), 'show');
  assert.deepEqual(calls, ['show']);
});

test('tasklist output: the image name of exactly that pid', () => {
  const out = '"soft hearts next.exe","1717","Console","2","180,000 K"\r\n"electron.exe","17170","Console","2","1 K"\r\n';
  assert.equal(tasklistImage(out, 1717), 'soft hearts next.exe');
  assert.equal(tasklistImage(out, 17170), 'electron.exe');
  assert.equal(tasklistImage(out, 171), null);
  assert.equal(tasklistImage('INFO: No tasks are running which match the specified criteria.\r\n', 1717), null);
});

test('Windows: a process whose exit code is set but which tasklist still lists is still there (Chromium is still ending)', () => {
  const image = 'soft hearts next.exe';
  // Real check 2026-11-22 under load: the exit code was set at +80 s, the process ended at +157 s; until then it still counts.
  assert.equal(windowsProcessPresent({ exitCodeSet: true, listedImage: 'Soft Hearts Next.exe', image }), true);
  assert.equal(windowsProcessPresent({ exitCodeSet: true, listedImage: null, image }), false);
  assert.equal(windowsProcessPresent({ exitCodeSet: false, listedImage: image, image }), true);
  // A pid another program reused, running or not.
  assert.equal(windowsProcessPresent({ exitCodeSet: false, listedImage: 'notepad.exe', image }), false);
  assert.equal(windowsProcessPresent({ exitCodeSet: true, listedImage: 'notepad.exe', image }), false);
  // tasklist could not be asked: the exit code decides.
  assert.equal(windowsProcessPresent({ exitCodeSet: true, listedImage: undefined, image }), false);
  assert.equal(windowsProcessPresent({ exitCodeSet: false, listedImage: undefined, image }), true);
});
