import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedReplySpeech } from '../electron/completed-reply-speech';
import type { ApprovedReplySpeechSegment } from '../shared/tts';

test('each exact completed segment exposes the same full raw host body without approving it', () => {
  const plans = new CompletedReplySpeech();
  const text = '  第一句。第二句。第三句。  ';
  plans.record(7, 'reply', 'scope', text);
  let prior: number | undefined;
  for (let index = 0; index < 3; index++) {
    const lease = plans.next(7, 'reply', 'scope', prior)!;
    assert.equal(lease.index, index);
    assert.equal(plans.fullPresentationText(7, 'reply', 'scope', lease), text);
    assert.ok(text.startsWith(lease.visibleText));
    assert.equal(plans.approvedSegment(7, 'reply', 'scope', index), null);
    assert.throws(() => plans.authorizeCloud(7, 'reply', 'scope', index, lease.text));
    assert.equal(plans.approvePresentation(7, 'reply', 'scope', lease), true);
    assert.equal(plans.fullPresentationText(7, 'reply', 'scope', lease), text);
    plans.authorizeCloud(7, 'reply', 'scope', index, lease.text);
    assert.throws(() => plans.authorizeCloud(7, 'reply', 'scope', index, lease.text));
    prior = index;
  }
  assert.equal(plans.next(7, 'reply', 'scope', prior), null);
  assert.equal(plans.busy, false);
});

test('wrong identity, copied lease, prior segment and same-ID replacement cannot read the active full body', () => {
  const plans = new CompletedReplySpeech();
  plans.record(7, 'reply', 'scope', '第一句。第二句。');
  const first = plans.next(7, 'reply', 'scope')!;
  assert.equal(plans.fullPresentationText(8, 'reply', 'scope', first), null);
  assert.equal(plans.fullPresentationText(7, 'other', 'scope', first), null);
  assert.equal(plans.fullPresentationText(7, 'reply', 'other', first), null);
  assert.equal(plans.fullPresentationText(7, 'reply', 'scope', Object.freeze({ ...first })), null);
  const second = plans.next(7, 'reply', 'scope', 0)!;
  assert.equal(plans.fullPresentationText(7, 'reply', 'scope', first), null);
  assert.equal(plans.fullPresentationText(7, 'reply', 'scope', second), '第一句。第二句。');
  plans.record(7, 'reply', 'scope', '新的全文。');
  assert.equal(plans.fullPresentationText(7, 'reply', 'scope', second), null);
  const replacement = plans.next(7, 'reply', 'scope')!;
  assert.equal(plans.fullPresentationText(7, 'reply', 'scope', replacement), '新的全文。');
});

test('cancel, owner teardown, clear and expiry revoke the full-body getter with the segment signal', () => {
  for (const action of ['cancel', 'cancelReply', 'dropOwner', 'clear', 'expiry'] as const) {
    let now = 0;
    const plans = new CompletedReplySpeech(() => now);
    plans.record(7, 'reply', 'scope', '第一句。第二句。');
    const lease = plans.next(7, 'reply', 'scope')!;
    const signal = plans.presentationSignal(7, 'reply', 'scope', lease)!;
    if (action === 'cancel') plans.cancel(7, 'reply');
    if (action === 'cancelReply') plans.cancelReply('reply');
    if (action === 'dropOwner') plans.dropOwner(7);
    if (action === 'clear') plans.clear();
    if (action === 'expiry') now = 15 * 60_000;
    assert.equal(plans.fullPresentationText(7, 'reply', 'scope', lease), null, action);
    assert.equal(signal.aborted, true, action);
    assert.equal(plans.approvePresentation(7, 'reply', 'scope', lease), false, action);
  }
});

test('raw whitespace, UTF16 and structured text are preserved while only exact current slices qualify', () => {
  const text = '  你好😀。\r\n第二句。\n```ts\nconst s = "原文。";\n```\n  ';
  const plans = new CompletedReplySpeech();
  plans.record(1, 'raw', 'scope', text);
  let previous: number | undefined;
  for (;;) {
    const lease = plans.next(1, 'raw', 'scope', previous);
    if (!lease) break;
    assert.equal(plans.fullPresentationText(1, 'raw', 'scope', lease), text);
    assert.ok(text.startsWith(lease.visibleText));
    previous = lease.index;
  }
});

test('invalid current-piece bounds/source or substituted active prefix/text/context fail closed', () => {
  type Slot = { pieces: { start: number; end: number; text: string }[]; lease: ApprovedReplySpeechSegment };
  const corruptions: ((slot: Slot) => void)[] = [
    slot => { slot.pieces[0].start = -1; },
    slot => { slot.pieces[0].end = Number.NaN; },
    slot => { slot.pieces[0].end = 999; },
    slot => { slot.pieces[0].text = '别的原文。'; },
    slot => { slot.lease = Object.freeze({ ...slot.lease, visibleText: '不是全文前缀。' }); },
    slot => { slot.lease = Object.freeze({ ...slot.lease, text: '替换当前段。' }); },
    slot => { slot.lease = Object.freeze({ ...slot.lease, context: Object.freeze({ replyId: 'other', segmentIndex: 0 }) }); },
    slot => { slot.lease = Object.freeze({ ...slot.lease, context: Object.freeze({ replyId: 'reply', segmentIndex: 1 }) }); },
  ];
  for (const corrupt of corruptions) {
    const plans = new CompletedReplySpeech();
    plans.record(7, 'reply', 'scope', '第一句。第二句。');plans.next(7, 'reply', 'scope');
    // A controlled host-state corruption counterexample; this is not a renderer capability.
    const slot = (plans as unknown as { latest: Slot }).latest;
    corrupt(slot);
    assert.equal(plans.fullPresentationText(7, 'reply', 'scope', slot.lease), null);
  }
});

test('the final lease and over-limit rejected plans cannot retain a readable speech body', () => {
  const plans = new CompletedReplySpeech();plans.record(1, 'reply', 'scope', '一句。');
  const lease = plans.next(1, 'reply', 'scope')!;
  assert.equal(plans.next(1, 'reply', 'scope', 0), null);
  assert.equal(plans.fullPresentationText(1, 'reply', 'scope', lease), null);
  plans.record(1, 'long', 'scope', 'a'.repeat(6001));
  assert.equal(plans.fullPresentationText(1, 'long', 'scope', lease), null);
});
