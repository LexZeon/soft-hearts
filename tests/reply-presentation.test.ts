import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyPresentationState } from '../src/ui/reply-presentation';
import { ReplyPresentation, type ReplyPresentationClock } from '../electron/reply-presentation';
import { getEventListeners } from 'node:events';

test('only an accepted ID enters waiting; whitespace does not finish it', () => {
  const state = new ReplyPresentationState();
  assert.equal(state.isWaiting(null), false);
  assert.equal(state.isWaiting('chat-a'), false);
  assert.equal(state.begin(''), false);
  assert.equal(state.begin('chat-a', ' \n\t'), true);
  assert.equal(state.isWaiting('chat-a'), true);
  state.content('chat-a', '\r\n ');
  assert.equal(state.isWaiting('chat-a'), true);
});

test('the first visible body permanently replaces waiting for that request', () => {
  const state = new ReplyPresentationState();
  state.begin('chat-a'); state.content('chat-a', '  正文');
  assert.equal(state.isWaiting('chat-a'), false);
  state.content('chat-a', ''); state.content('chat-a', ' \n');
  assert.equal(state.isWaiting('chat-a'), false);
  assert.equal(state.begin('chat-a'), false, 'duplicate start does not reset visible text');
  assert.equal(state.isWaiting('chat-a'), false);
});

test('hydration with existing visible content does not flash a waiting indicator', () => {
  const state = new ReplyPresentationState();
  assert.equal(state.begin('hydrated', '\n已收到正文'), true);
  assert.equal(state.isWaiting('hydrated'), false);
});

test('a new accepted request retires the previous ID and ignores its late events', () => {
  const state = new ReplyPresentationState();
  state.begin('old'); assert.equal(state.begin('new'), true);
  state.content('old', '迟到正文'); state.close('old');
  assert.equal(state.isWaiting('new'), true);
  assert.equal(state.begin('old'), false);
  assert.equal(state.isWaiting('new'), true);
  state.content('new', '新正文'); assert.equal(state.isWaiting('new'), false);
});

test('a cross-window stop before start remembers the terminated ID', () => {
  const state = new ReplyPresentationState();
  state.close('not-started-yet'); state.content('not-started-yet', '迟到正文');
  assert.equal(state.begin('not-started-yet'), false);
  assert.equal(state.isWaiting('not-started-yet'), false);
  assert.equal(state.begin('next'), true); assert.equal(state.isWaiting('next'), true);
});

test('completion or clear removes waiting without allowing the same ID to restart', () => {
  const state = new ReplyPresentationState();
  state.begin('done'); state.close('done');
  assert.equal(state.isWaiting('done'), false); assert.equal(state.begin('done'), false);
  state.begin('cleared'); state.clear(); state.clear(); state.close(null);
  state.content('cleared', '迟到');
  assert.equal(state.isWaiting('cleared'), false); assert.equal(state.begin('cleared'), false);
  assert.equal(state.begin('fresh'), true);
});

test('hide suppresses only current waiting until a genuinely new accepted ID', () => {
  const state = new ReplyPresentationState();
  state.suppressWaiting(); state.begin('chat-a');
  assert.equal(state.isWaiting('chat-a'), true, 'a previous idle hide cannot suppress a new request');
  state.suppressWaiting(); state.content('chat-a', ' \n');
  assert.equal(state.isWaiting('chat-a'), false);
  assert.equal(state.begin('chat-a'), false);
  assert.equal(state.isWaiting('chat-a'), false, 'restored duplicate start cannot revive waiting');
  state.content('chat-a', '正文仍可到达');
  assert.equal(state.isWaiting('chat-a'), false);
  assert.equal(state.begin('chat-b'), true); assert.equal(state.isWaiting('chat-b'), true);
});

test('closing an unrelated future ID never clears the current request', () => {
  const state = new ReplyPresentationState();
  state.begin('current'); state.close('future'); state.close('future');
  assert.equal(state.isWaiting('current'), true);
  assert.equal(state.begin('future'), false); assert.equal(state.isWaiting('current'), true);
});

test('termination memory holds only the latest 24 distinct IDs', () => {
  const retained = new ReplyPresentationState();
  for (let i = 0; i < 25; i++) retained.close(`closed-${i}`);
  assert.equal(retained.begin('closed-1'), false);
  assert.equal(retained.begin('closed-24'), false);
  assert.equal(retained.begin('closed-0'), true, 'the oldest ID is evicted to bound transient memory');
  const repeated = new ReplyPresentationState();
  for (let i = 0; i < 24; i++) repeated.close(`closed-${i}`);
  repeated.close('closed-0');
  assert.equal(repeated.begin('closed-1'), false, 'a repeated termination does not consume another cache slot');
  assert.equal(repeated.begin('fresh'), true);
});

function receiptFixture() {
  let id = 0, token = 0;
  const timers = new Map<number, { run(): void; milliseconds: number }>();
  const clock: ReplyPresentationClock = {
    setTimeout(run, milliseconds) { const handle = ++id; timers.set(handle, { run, milliseconds }); return handle; },
    clearTimeout(handle) { timers.delete(handle as number); },
  };
  const recipient = {}, other = {};
  const presentation = new ReplyPresentation({ clock, createToken: () => `receipt-nonce-${String(++token).padStart(12, '0')}` });
  return { presentation, recipient, other, timers, expire() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) timer.run(); } };
}

test('host receipt needs exact existing full text, one trusted recipient, nonce and visible paint', async () => {
  const f = receiptFixture();
  assert.equal(await f.presentation.waitForPresentation('not-existing'), false);
  const token = f.presentation.begin('前缀：完整正文', f.recipient)!;
  assert.equal(await f.presentation.waitForPresentation('完整正文'), false, 'raw text cannot substitute for host-prefixed display text');
  const pending = f.presentation.waitForPresentation('前缀：完整正文');
  assert.equal(await f.presentation.waitForPresentation('前缀：完整正文'), false, 'one revision has only one waiter');
  assert.equal(f.presentation.acknowledge(token, f.other, true), false);
  assert.equal(f.presentation.acknowledge('stale-nonce-000000000000', f.recipient, true), false);
  assert.equal(f.presentation.acknowledge(token, f.recipient, true), true);
  assert.equal(await pending, true); assert.equal(f.timers.size, 0);
  assert.equal(await f.presentation.waitForPresentation('前缀：完整正文'), false, 'successful receipt is consumed, never replayed');
  assert.equal(f.presentation.acknowledge(token, f.recipient, true), false);
});

test('an explicit identical text update cancels its old waiter and mints a new revision, anchor reads do not', async () => {
  const f = receiptFixture();
  const old = f.presentation.begin('相同文字', f.recipient)!;
  const first = f.presentation.waitForPresentation('相同文字');
  assert.equal(f.presentation.currentToken(f.recipient), old);
  assert.equal(f.presentation.currentToken(f.recipient), old, 'layout/anchor reads do not mint another revision');
  const next = f.presentation.begin('相同文字', f.recipient)!;
  assert.notEqual(next, old); assert.equal(await first, false);
  const second = f.presentation.waitForPresentation('相同文字');
  assert.equal(f.presentation.acknowledge(old, f.recipient, true), false);
  assert.equal(f.presentation.acknowledge(next, f.recipient, true), true);
  assert.equal(await second, true);
});

test('hidden, cleared or changed text never becomes a later visible receipt for the old revision', async () => {
  const f = receiptFixture();
  const hidden = f.presentation.begin('hidden', f.recipient)!;
  const pending = f.presentation.waitForPresentation('hidden');
  assert.equal(f.presentation.acknowledge(hidden, f.recipient, false), false); assert.equal(await pending, false);
  assert.equal(f.presentation.acknowledge(hidden, f.recipient, true), false);
  const cleared = f.presentation.begin('cleared', f.recipient)!, waiting = f.presentation.waitForPresentation('cleared');
  f.presentation.clear(); assert.equal(await waiting, false); assert.equal(f.presentation.acknowledge(cleared, f.recipient, true), false);
  const cached = f.presentation.begin('cached paint', f.recipient)!;
  assert.equal(f.presentation.acknowledge(cached, f.recipient, true), true);
  assert.equal(await f.presentation.waitForPresentation('cached paint'), true, 'first exact waiter may use this current already-painted revision');
  f.presentation.begin('changed', f.recipient); assert.equal(await f.presentation.waitForPresentation('cached paint'), false);
});

test('abort, bounded deadline and teardown cancel receipt and clean listeners without late success', async () => {
  const f = receiptFixture(), abort = new AbortController();
  const token = f.presentation.begin('abort', f.recipient)!;
  const task = f.presentation.waitForPresentation('abort', abort.signal);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  abort.abort(); assert.equal(await task, false); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.presentation.acknowledge(token, f.recipient, true), false);
  const timed = f.presentation.begin('deadline', f.recipient)!, timeout = f.presentation.waitForPresentation('deadline');
  assert.equal([...f.timers.values()][0].milliseconds, 5000); f.expire(); assert.equal(await timeout, false);
  assert.equal(f.presentation.acknowledge(timed, f.recipient, true), false);
  f.presentation.begin('dispose', f.recipient); const disposed = f.presentation.waitForPresentation('dispose');
  f.presentation.dispose(); assert.equal(await disposed, false); assert.equal(f.timers.size, 0);
  assert.equal(f.presentation.begin('cannot reopen', f.recipient), null);
});

test('receipt success is rechecked against the same revision after its continuation resumes', async () => {
  for (const change of ['invalidate', 'clear', 'same-text', 'different-text', 'dispose', 'abort'] as const) {
    const f = receiptFixture(), controller = new AbortController();
    const token = f.presentation.begin('exact display text', f.recipient)!;
    const pending = f.presentation.waitForPresentation('exact display text', controller.signal);
    assert.equal(f.presentation.acknowledge(token, f.recipient, true), true);
    assert.equal(f.presentation.isCurrent(token, f.recipient), true, 'consumption does not erase a legitimate currently painted revision');
    if (change === 'invalidate') f.presentation.invalidate();
    if (change === 'clear') f.presentation.clear();
    if (change === 'same-text') f.presentation.begin('exact display text', f.recipient);
    if (change === 'different-text') f.presentation.begin('another display text', f.recipient);
    if (change === 'dispose') f.presentation.dispose();
    if (change === 'abort') controller.abort();
    assert.equal(await pending, false, change);
    assert.equal(f.timers.size, 0, change);
  }
});

test('already-painted fast receipts also await a continuation and current proofs are nonce/recipient specific', async () => {
  const f = receiptFixture();
  const old = f.presentation.begin('same text', f.recipient)!;
  f.presentation.acknowledge(old, f.recipient, true);
  const fast = f.presentation.waitForPresentation('same text');
  const current = f.presentation.begin('same text', f.recipient)!;
  assert.equal(await fast, false, 'cached paint cannot cross a same-turn same-text revision change');
  const pending = f.presentation.waitForPresentation('same text'); f.presentation.acknowledge(current, f.recipient, true);
  assert.equal(await pending, true);
  assert.equal(f.presentation.currentToken(f.recipient), null, 'the wait is consumed');
  assert.equal(f.presentation.isCurrent(current, f.recipient), true, 'the successful painted revision remains usable for a synchronous host guard');
  assert.equal(f.presentation.isCurrent(current, f.other), false); assert.equal(f.presentation.isCurrent(old, f.recipient), false);
  f.presentation.invalidate(); assert.equal(f.presentation.isCurrent(current, f.recipient), false);
});
