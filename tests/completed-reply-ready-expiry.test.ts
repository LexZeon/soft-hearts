import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';

test('a live completed plan remains pending beyond five seconds and only full ready releases it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, settled = false;
  const plans = new CompletedReplySpeech(() => now);
  plans.record(7, 'reply', 'scope', '第一句。第二句。');
  const lease = plans.next(7, 'reply', 'scope')!;
  const waiting = plans.waitForPresentationReady(7, 'reply', 'scope', lease).then(value => { settled = true; return value; });
  now = 5001;t.mock.timers.tick(5001);await Promise.resolve();
  assert.equal(settled, false, 'readable UI progress must not hit the old fixed five-second cancellation');
  assert.equal(plans.busy, true);
  assert.equal(plans.approvedSegment(7, 'reply', 'scope', 0), null);
  assert.equal(plans.markPresentationReady('reply', 'scope'), true);
  assert.equal(await waiting, true);
  assert.equal(plans.fullPresentationText(7, 'reply', 'scope', lease), '第一句。第二句。');
  assert.equal(plans.approvedSegment(7, 'reply', 'scope', 0), null, 'Boolean readiness is still not a native presentation receipt');
  assert.throws(() => plans.authorizeCloud(7, 'reply', 'scope', 0, lease.text));
  plans.clear();
});

test('cancel and replacement abort immediately; a late waiter expires at the original plan deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['cancel', 'replacement', 'expiry'] as const) {
    let now = 0, settled = false;
    const plans = new CompletedReplySpeech(() => now);
    plans.record(7, 'reply', 'scope', '第一句。第二句。');
    if (action === 'expiry') now = 14 * 60_000;
    const lease = plans.next(7, 'reply', 'scope')!;
    const signal = plans.presentationSignal(7, 'reply', 'scope', lease)!;
    const waiting = plans.waitForPresentationReady(7, 'reply', 'scope', lease).then(value => { settled = true; return value; });
    if (action === 'cancel') plans.cancel(7, 'reply');
    if (action === 'replacement') plans.record(7, 'new_reply', 'new_scope', '新的完整正文。');
    if (action === 'expiry') {
      now = 15 * 60_000 - 1;t.mock.timers.tick(60_000 - 1);await Promise.resolve();
      assert.equal(settled, false, 'the waiter receives only the original remaining minute');
      now++;t.mock.timers.tick(1);
    }
    assert.equal(await waiting, false, action);
    assert.equal(signal.aborted, true, action);
    assert.equal(plans.fullPresentationText(7, 'reply', 'scope', lease), null, action);
    assert.equal(plans.approvePresentation(7, 'reply', 'scope', lease), false, action);
    assert.equal(plans.markPresentationReady('reply', 'scope'), false, action);
    plans.clear();
  }
});
