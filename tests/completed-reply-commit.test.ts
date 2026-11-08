import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';

const owner = 7, id = 'reply-1', scope = 'card-provider-conversation', full = '第一句。第二句。';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('a renderer done signal cannot issue a lease before host commits the exact body and fence', async () => {
  const plan = new CompletedReplySpeech(() => 1000), pendingFence = plan.beginCommit(owner, id, scope);
  try {
    let settled = false;
    const committed = plan.waitForCommit(owner, id, scope).then(value => { settled = true; return value; });
    await flush(); assert.equal(settled, false); assert.equal(plan.busy, true);
    assert.equal(plan.next(owner, id, scope), null); assert.equal(plan.isPrefixReply(owner, id, scope), true);
    assert.equal(plan.record(owner, id, scope, full, { prefix: true, fence: {} }), false);
    assert.equal(plan.record(owner + 1, id, scope, full, { prefix: true, fence: pendingFence }), false);
    await flush(); assert.equal(settled, false); assert.equal(plan.next(owner, id, scope), null);
    assert.equal(plan.record(owner, id, scope, full, { prefix: true, fence: pendingFence }), true);
    const committedFence = await committed; assert.ok(committedFence);
    assert.equal(plan.commitCurrent(committedFence, owner, id, scope), true);
    assert.equal(plan.commitCurrent(committedFence, owner + 1, id, scope), false);
    const lease = plan.next(owner, id, scope); assert.ok(lease); assert.equal(plan.prefixMode(owner, id, scope, lease), true);
  } finally { plan.clear(); }
});

test('prefix approval covers the exact current raw lease end and cannot accept foreign text or identity', () => {
  let now = 1000; const plan = new CompletedReplySpeech(() => now), fence = plan.beginCommit(owner, id, scope);
  try {
    assert.equal(plan.record(owner, id, scope, full, { prefix: true, fence }), true);
    const lease = plan.next(owner, id, scope); assert.ok(lease);
    assert.equal(lease.visibleText, '第一句。');
    assert.equal(plan.approvePresentation(owner, id, scope, lease, '第一'), false);
    assert.equal(plan.approvePresentation(owner, id, scope, lease, '第一句！'), false);
    assert.equal(plan.approvePresentation(owner + 1, id, scope, lease, '第一句。'), false);
    assert.equal(plan.approvePresentation(owner, id, 'other-scope', lease, '第一句。'), false);
    assert.equal(plan.approvedPresentationText(owner, id, scope, lease.index), null);
    assert.equal(plan.approvePresentation(owner, id, scope, lease, lease.visibleText), true);
    assert.equal(plan.approvedPresentationText(owner, id, scope, lease.index), '第一句。');
    assert.equal(plan.approvedSegment(owner, id, scope, lease.index), lease);
    const remaining = plan.presentationRemaining(owner, id, scope, lease); assert.ok(remaining > 0);
    now += 100; assert.equal(plan.presentationRemaining(owner, id, scope, lease), remaining - 100);
    assert.equal(plan.presentationRemaining(owner + 1, id, scope, lease), 0);
  } finally { plan.clear(); }
});

test('cancel and reuse of an id cannot revive an earlier pending fence or waiter', async () => {
  const plan = new CompletedReplySpeech(() => 1000), oldFence = plan.beginCommit(owner, id, scope);
  try {
    const oldWait = plan.waitForCommit(owner, id, scope);
    assert.equal(plan.cancel(owner, id), true); assert.equal(await oldWait, null); assert.equal(plan.busy, false);
    const newFence = plan.beginCommit(owner, id, scope), newWait = plan.waitForCommit(owner, id, scope);
    plan.cancelPending(oldFence); assert.equal(plan.busy, true);
    assert.equal(plan.record(owner, id, scope, full, { prefix: true, fence: oldFence }), false);
    assert.equal(plan.record(owner, id, scope, full, { prefix: true, fence: newFence }), true);
    const currentFence = await newWait; assert.ok(currentFence);
    assert.equal(plan.commitCurrent(currentFence, owner, id, scope), true);
    assert.equal(plan.commitCurrent(oldFence, owner, id, scope), false);
  } finally { plan.clear(); }
});

test('default completed reply requires full-body presentation instead of a prefix', () => {
  const plan = new CompletedReplySpeech(() => 1000);
  try {
    assert.equal(plan.record(owner, id, scope, full), true);
    const lease = plan.next(owner, id, scope); assert.ok(lease);
    assert.equal(plan.prefixMode(owner, id, scope, lease), false);
    assert.equal(plan.approvePresentation(owner, id, scope, lease, lease.visibleText), false);
    assert.equal(plan.approvePresentation(owner, id, scope, lease, full), true);
    assert.equal(plan.approvedPresentationText(owner, id, scope, lease.index), full);
  } finally { plan.clear(); }
});

test('one logical busy hold spans pending and all pieces, ending on plan drain or cancellation', async () => {
  const plan = new CompletedReplySpeech(() => 1000), fence = plan.beginCommit(owner, id, scope);
  try {
    assert.equal(plan.busy, true); assert.equal(plan.record(owner, id, scope, full, { prefix: true, fence }), true);
    assert.equal(plan.busy, true);
    const first = plan.next(owner, id, scope); assert.ok(first); assert.equal(plan.busy, true);
    const second = plan.next(owner, id, scope, first.index); assert.ok(second); assert.equal(plan.busy, true);
    assert.equal(plan.next(owner, id, scope, second.index), null); assert.equal(plan.busy, false);
    const other = plan.beginCommit(owner, 'reply-2', scope); assert.equal(plan.busy, true);
    const waiting = plan.waitForCommit(owner, 'reply-2', scope); plan.cancelPending(other);
    assert.equal(await waiting, null); assert.equal(plan.busy, false);
  } finally { plan.clear(); }
});
