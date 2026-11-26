// The packaged smoke's quit (2026-11-24, docs/claude/2026-11-24-quit-hang.md): the app's own quit keeps the 8 s cap; Electron's
// process teardown after it (slow only while the computer is busy, for every build) has its own budget and is reported.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_QUIT_CAP_MS, CLEANUP_BUDGET_MS, IDENTITY_CAP_MS, QuitError, TEARDOWN_BUDGET_MS, askQuitWithMarker, endedTracker, playwrightCollector, processRunning, quitOwnedApp } from '../scripts/lib/smoke-quit.mjs';
import { TEARDOWN_BUDGET_MS as K7_TEARDOWN_BUDGET_MS } from '../scripts/lib/quit-watch.mjs';

/** A clock the test moves by hand: sleep() resolves only when advance() passes its time. */
function fakeClock() {
  let t = 0; const timers = [];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    now: () => t,
    sleep: ms => new Promise(resolve => timers.push({ at: t + ms, resolve })),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift(); t = next.at; next.resolve();
      }
      t = end; await settle();
    },
  };
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

/** An app whose own quit finishes at `ownAt` ms and whose processes end at `endAt` ms (null: never). */
function app(clock, { ownAt, endAt }) {
  let asked = 0;
  return {
    get asked() { return asked; },
    quit: () => { asked++; },
    ownQuitDone: () => ownAt !== null && clock.now() >= ownAt,
    gone: () => endAt !== null && clock.now() >= endAt,
  };
}

test('the cap the app\'s own quit must meet is still 8 s; the teardown has K7\'s budget; the watchdog covers both and the identity', () => {
  assert.equal(APP_QUIT_CAP_MS, 8_000, 'the old SDK-close cap, not raised');
  assert.equal(TEARDOWN_BUDGET_MS, K7_TEARDOWN_BUDGET_MS);
  assert.ok(CLEANUP_BUDGET_MS >= 30_000 + TEARDOWN_BUDGET_MS + IDENTITY_CAP_MS);
});

test('own quit at once, Electron tears down for 30 s on a busy computer: a normal quit, both times reported (one 8 s cap failed it)', async () => {
  const clock = fakeClock(), a = app(clock, { ownAt: 120, endAt: 30_120 });
  const run = outcome(quitOwnedApp({ quit: a.quit, ownQuitDone: a.ownQuitDone, gone: a.gone, sleep: clock.sleep, now: clock.now }));
  await clock.advance(31_000);
  const { value, error } = await run;
  assert.equal(error, undefined);
  assert.equal(a.asked, 1, 'asked to quit once');
  assert.ok(value.appQuitMs >= 120 && value.appQuitMs <= 220, String(value.appQuitMs));
  assert.ok(value.teardownMs >= 29_900 && value.teardownMs <= 30_100, String(value.teardownMs));
});

test('a quit step that never lets go fails as the app\'s own quit, at 8 s', async () => {
  const clock = fakeClock(), a = app(clock, { ownAt: null, endAt: null });
  let settled = false;
  const run = outcome(quitOwnedApp({ quit: a.quit, ownQuitDone: a.ownQuitDone, gone: a.gone, sleep: clock.sleep, now: clock.now })).finally(() => { settled = true; });
  await clock.advance(APP_QUIT_CAP_MS - 200);
  assert.equal(settled, false, 'still waiting just before the cap');
  await clock.advance(400);
  assert.equal(settled, true, 'it failed at the cap, not later');
  const { error } = await run;
  assert.ok(error instanceof QuitError && error.part === 'app-quit', String(error));
  assert.match(error.message, /own quit did not finish within 8 s/);
});

test('own quit at 7.9 s still counts (the cap is the cap), and nothing waits for the teardown before it', async () => {
  const clock = fakeClock(), a = app(clock, { ownAt: 7_900, endAt: 7_950 });
  const run = outcome(quitOwnedApp({ quit: a.quit, ownQuitDone: a.ownQuitDone, gone: a.gone, sleep: clock.sleep, now: clock.now }));
  await clock.advance(9_000);
  const { value, error } = await run;
  assert.equal(error, undefined);
  assert.ok(value.appQuitMs >= 7_900 && value.appQuitMs < 8_000);
});

test('processes that never end fail as Electron\'s teardown, after its own budget', async () => {
  const clock = fakeClock(), a = app(clock, { ownAt: 100, endAt: null });
  let settled = false;
  const run = outcome(quitOwnedApp({ quit: a.quit, ownQuitDone: a.ownQuitDone, gone: a.gone, sleep: clock.sleep, now: clock.now })).finally(() => { settled = true; });
  await clock.advance(100 + TEARDOWN_BUDGET_MS - 500);
  assert.equal(settled, false);
  await clock.advance(1_000);
  assert.equal(settled, true, 'it failed at the budget, not later');
  const { error } = await run;
  assert.ok(error instanceof QuitError && error.part === 'teardown', String(error));
  assert.match(error.message, /own quit in \d+ ms, but its processes were still listed 180 s later/);
});

test('every process must end; one seen ended stays ended even if its number comes back for a new process', () => {
  const alive = new Set([1, 2, 3]);
  const gone = endedTracker([1, 2, 3], pid => alive.has(pid));
  assert.equal(gone(), false);
  alive.delete(1); alive.delete(2);
  assert.equal(gone(), false, 'the third still runs');
  alive.add(1); // pid 1 reused by another program
  alive.delete(3);
  assert.equal(gone(), true);
});

test('Playwright\'s close is started once (when the own quit is seen) and its error still comes out at the SDK-close step', async () => {
  let calls = 0, fail = false;
  const instance = { close: async () => { calls++; if (fail) throw new Error('close failed'); } };
  const collector = playwrightCollector(instance);
  assert.equal(collector.collected, false);
  collector.start(); collector.start();
  assert.equal(await collector.done(), true);
  assert.equal(calls, 1, 'one close');
  assert.equal(collector.collected, true);
  fail = true;
  const failing = playwrightCollector(instance);
  failing.start();
  await assert.rejects(failing.done(), /close failed/);
  assert.equal(failing.collected, true, 'a failed close still ends the wait (the SDK-close step reports it)');
});

test('the main-process hook writes its marker only on exit and quits on the next turn', async () => {
  const exits = [], writes = [];
  let quits = 0;
  const realOnce = process.once, realModule = process.getBuiltinModule;
  process.once = (name, listener) => { if (name === 'exit') { exits.push(listener); return process; } return realOnce.call(process, name, listener); };
  process.getBuiltinModule = name => name === 'node:fs' ? { writeFileSync: (file, text) => writes.push([file, text]) } : realModule.call(process, name);
  try {
    assert.equal(askQuitWithMarker({ app: { quit: () => { quits++; } } }, 'marker-file'), true);
    assert.equal(quits, 0, 'not before the answer went back');
    assert.deepEqual(writes, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quits, 1);
    exits[0]();
    assert.equal(writes.length, 1); assert.equal(writes[0][0], 'marker-file');
  } finally { process.once = realOnce; process.getBuiltinModule = realModule; }
});

test('processRunning: this process runs; a number no process has does not', () => {
  assert.equal(processRunning(process.pid), true);
  assert.equal(processRunning(2 ** 30 + 7), false);
});
