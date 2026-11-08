import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyLifetime } from '../electron/reply-lifetime';
import { REPLY_LINGER_KNOBS } from '../shared/behaviors/reply-linger/knobs';

function fixture() {
  let now = 0, serial = 0, expired = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const cancelled: (() => void)[] = [];
  const lifetime = new ReplyLifetime(() => expired++, {
    setTimeout(callback, milliseconds) { const id = ++serial; tasks.set(id, { at: now + milliseconds, callback }); return id; },
    clearTimeout(handle) { const task = tasks.get(handle as number); if (task) cancelled.push(task.callback); tasks.delete(handle as number); },
  });
  return { lifetime, tasks, cancelled, get expired() { return expired; }, advance(ms: number) {
    now += ms;
    for (const [id, task] of [...tasks]) if (task.at <= now) { tasks.delete(id); task.callback(); }
  } };
}
// #5: how long is decided per reply (shared/behaviors/reply-linger/); the lifetime keeps exactly that, held to the knobs' range.
test('streaming has no expiry; completion hides exactly the decided time later', () => {
  const f = fixture();
  f.lifetime.streaming(); f.advance(12000); assert.equal(f.expired, 0); assert.equal(f.tasks.size, 0);
  f.lifetime.complete(7300); f.advance(7299); assert.equal(f.expired, 0);
  f.advance(1); assert.equal(f.expired, 1); assert.equal(f.tasks.size, 0);
});
test('a decided time outside the range is held to it; a non-number stays the longest', () => {
  const [low, high] = REPLY_LINGER_KNOBS.range;
  for (const [asked, kept] of [[10, low], [low, low], [high + 60_000, high], [NaN, high], [Infinity, high]] as const) {
    const f = fixture(); f.lifetime.complete(asked);
    f.advance(kept - 1); assert.equal(f.expired, 0, `${asked}`); f.advance(1); assert.equal(f.expired, 1, `${asked}`);
  }
});
test('new streaming content cancels the old deadline, including a late cancelled callback', () => {
  const f = fixture();
  f.lifetime.complete(5000); f.advance(4000); f.lifetime.streaming();
  f.cancelled[0](); f.advance(2000); assert.equal(f.expired, 0); assert.equal(f.tasks.size, 0);
  f.lifetime.complete(5000); f.advance(5000); assert.equal(f.expired, 1);
});
test('repeated terminal events replace one timer; clear cancels it without a later hide', () => {
  const f = fixture();
  f.lifetime.complete(5000); f.advance(3000); f.lifetime.complete(5000);
  assert.equal(f.tasks.size, 1); f.cancelled[0](); f.advance(4999); assert.equal(f.expired, 0);
  f.lifetime.cancel(); for (const callback of f.cancelled) callback();
  f.advance(10000); assert.equal(f.expired, 0); assert.equal(f.tasks.size, 0);
});
