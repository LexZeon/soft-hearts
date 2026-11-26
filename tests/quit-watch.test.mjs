// K7 "退出再打开" (2026-11-22, docs/claude/2026-11-22-k7-quit-hang.md): the app's own quit keeps its 20 s; Electron's process
// teardown after it (slow only while the computer is busy) has its own budget and is reported, not failed at 20 s.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { APP_QUIT_BUDGET_MS, APP_QUIT_DONE_LINE, TEARDOWN_BUDGET_MS, awaitQuit, describeQuit } from '../scripts/lib/quit-watch.mjs';

/** A launched process as Playwright hands it over: 'exit', exitCode, a flowing stderr. */
function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.stderr = new PassThrough();
  child.stderr.resume();
  child.exit = (code = 0) => { child.exitCode = code; child.emit('exit', code, null); };
  return child;
}
/** A clock the test moves by hand: sleep() only resolves when advance() passes its time. */
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

test('the app finishes its own quit at once, Electron takes 30 s to tear down on a busy computer: a normal quit, both times reported', async () => {
  const child = fakeChild(), clock = fakeClock();
  const result = outcome(awaitQuit({ child, quit: async () => {}, sleep: clock.sleep, now: clock.now }));
  await clock.advance(800);
  child.stderr.write(`${APP_QUIT_DONE_LINE}\n`);
  await clock.advance(30_000); // past the old single 20 s budget that failed K7 on 37d5ce76
  child.exit(0);
  const { value, error } = await result;
  assert.equal(error, undefined);
  assert.deepEqual(value, { code: 0, signal: null, appQuitMs: 800, teardownMs: 30_000, sawQuitDone: true });
  assert.match(describeQuit(value), /应用自己的退出 800 ms，Electron 收尾 30000 ms（电脑忙时收尾慢/);
});

test('the app\'s own quit never finishes (a quit step holds it): fails at 20 s, as before', async () => {
  const child = fakeChild(), clock = fakeClock();
  const result = outcome(awaitQuit({ child, quit: async () => {}, sleep: clock.sleep, now: clock.now }));
  await clock.advance(APP_QUIT_BUDGET_MS - 1);
  child.stderr.write('some other log line\n');
  await clock.advance(2);
  const { error } = await result;
  assert.match(String(error?.message), /own quit did not finish within 20 s/);
});

test('the done line split across two stderr chunks still counts', async () => {
  const child = fakeChild(), clock = fakeClock();
  const result = outcome(awaitQuit({ child, quit: async () => {}, sleep: clock.sleep, now: clock.now }));
  await clock.advance(100);
  child.stderr.write('[pid] Waiting for the deb');
  await clock.advance(5);
  child.stderr.write('ugger to disconnect...\r\n');
  await clock.advance(25_000);
  child.exit(0);
  const { value } = await result;
  assert.equal(value.sawQuitDone, true);
  assert.equal(value.appQuitMs, 105);
});

test('the own quit finished but the process never ends: fails after the teardown budget, naming the teardown', async () => {
  const child = fakeChild(), clock = fakeClock();
  const result = outcome(awaitQuit({ child, quit: async () => {}, sleep: clock.sleep, now: clock.now }));
  await clock.advance(500);
  child.stderr.write(`${APP_QUIT_DONE_LINE}\n`);
  await clock.advance(TEARDOWN_BUDGET_MS + 1);
  const { error } = await result;
  assert.match(String(error?.message), /finished its own quit in 500 ms, but Electron's process teardown had not ended 180 s later/);
});

test('a process that exits without the line (no debugger attached) within 20 s is a normal quit; one already gone counts too', async () => {
  const child = fakeChild(), clock = fakeClock();
  const result = outcome(awaitQuit({ child, quit: async () => {}, sleep: clock.sleep, now: clock.now }));
  await clock.advance(1_200);
  child.exit(0);
  const { value } = await result;
  assert.deepEqual(value, { code: 0, signal: null, appQuitMs: 1_200, teardownMs: 0, sawQuitDone: false });
  assert.equal(describeQuit(value), '应用自己的退出 1200 ms');

  const gone = fakeChild(), later = fakeClock();
  gone.exit(0);
  const early = await awaitQuit({ child: gone, quit: async () => {}, sleep: later.sleep, now: later.now });
  assert.equal(early.code, 0);
});

test('a quit() that throws (the page went away while answering) and the stderr listener is removed afterwards', async () => {
  const child = fakeChild(), clock = fakeClock();
  const before = child.stderr.listenerCount('data');
  const result = outcome(awaitQuit({ child, quit: async () => { throw new Error('Target closed'); }, sleep: clock.sleep, now: clock.now }));
  await clock.advance(10);
  assert.equal(child.stderr.listenerCount('data'), before + 1);
  child.stderr.write(`${APP_QUIT_DONE_LINE}\n`);
  await clock.advance(10);
  child.exit(0);
  const { value } = await result;
  assert.equal(value.code, 0);
  assert.equal(child.stderr.listenerCount('data'), before);
});
