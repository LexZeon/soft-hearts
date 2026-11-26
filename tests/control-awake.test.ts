// The hidden control window is not throttled while she is out in full screen: one owner, reference-counted.
// electron/unbound/control-awake.ts; the doc is docs/claude/2026-11-23-typed-send-deep-fix.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlAwake, followUnboundMode, lineAwake, type ThrottledWindow } from '../electron/unbound/control-awake';
import { UnboundSayAcks } from '../electron/unbound/say-ack';

function fakeWindow() {
  const calls: boolean[] = []; let throttled = true; let destroyed = false;
  const win: ThrottledWindow = { isDestroyed: () => destroyed, webContents: { setBackgroundThrottling(allowed) { calls.push(allowed); throttled = allowed; } } };
  return { win, calls, get throttled() { return throttled; }, destroy() { destroyed = true; } };
}

test('awake while she answers out in full screen, from the line handed over until her reply is read out; throttled again after', () => {
  const w = fakeWindow(); const awake = createControlAwake(() => w.win);
  const mode = followUnboundMode(awake);
  mode('entering'); assert.equal(w.throttled, false, 'out: awake');
  mode('unbound'); assert.deepEqual(w.calls, [false], 'one lift for the whole stay, however the mode changes while out');
  // a line, her reply and her read-aloud all happen inside the stay: nothing is put back in between
  const line = lineAwake(awake); line(true); line(false);
  assert.equal(w.throttled, false, 'a line that ended while she is still out leaves it awake (her reply is still streaming and read aloud)');
  mode('normal'); assert.equal(w.throttled, true, 'back in the window: throttling restored'); assert.equal(awake.count, 0);
});

test('nested holds: a line in flight and a reply restore only when both have ended', () => {
  const w = fakeWindow(); const awake = createControlAwake(() => w.win);
  const lineEnds = awake.hold('line'), replyEnds = awake.hold('reply');
  assert.deepEqual(w.calls, [false], 'lifted once');
  lineEnds(); assert.equal(w.throttled, false, 'the reply still holds it');
  lineEnds(); assert.equal(w.throttled, false, 'releasing twice does not release the other hold');
  replyEnds(); assert.equal(w.throttled, true); assert.deepEqual(w.calls, [false, true]);
  const one = awake.hold('same'), two = awake.hold('same');
  one(); assert.equal(w.throttled, false, 'two holds for one reason: the first to end does not put it back'); two(); assert.equal(w.throttled, true);
});

test('outside Unbound a line alone still wakes the window and puts it back (the ledger port)', () => {
  const w = fakeWindow(); const awake = createControlAwake(() => w.win); const line = lineAwake(awake);
  line(true); line(true); assert.equal(awake.count, 1, 'any number of open lines is one hold');
  line(false); assert.equal(w.throttled, true);
  const acks = new UnboundSayAcks({ now: () => 0, setTimer: () => 1, clearTimer: () => {}, journal: () => {}, awake: line });
  const a = acks.start(() => {}); assert.equal(w.throttled, false); acks.sent(a.line); assert.equal(w.throttled, true);
});

test('quitting and a crash path: releaseAll puts throttling back whatever is held; a destroyed window is left alone', () => {
  const w = fakeWindow(); const awake = createControlAwake(() => w.win);
  awake.hold('a'); awake.hold('b'); followUnboundMode(awake)('unbound'); assert.equal(awake.count, 3);
  awake.releaseAll(); assert.equal(w.throttled, true); assert.equal(awake.count, 0);
  const d = fakeWindow(); const a2 = createControlAwake(() => d.win); d.destroy(); a2.hold('x'); assert.deepEqual(d.calls, []);
});

test('a window recreated while she is out gets the lift on refresh; a throwing window never breaks the holder', () => {
  const first = fakeWindow(), second = fakeWindow(); let current = first;
  const awake = createControlAwake(() => current.win); awake.hold('out');
  current = second; assert.equal(second.throttled, true); awake.refresh(); assert.equal(second.throttled, false);
  awake.refresh(); assert.deepEqual(second.calls, [false], 'no repeated calls');
  const bad = createControlAwake(() => ({ isDestroyed: () => false, webContents: { setBackgroundThrottling() { throw new Error('closing'); } } }));
  assert.doesNotThrow(() => { bad.hold('x')(); });
});
