import assert from 'node:assert/strict';
import test from 'node:test';
import { isLeakedDraft, markTimes, needsMarker, timeMarker } from '../electron/brain/long-chat/history';

test('long chat history: markers on a new local day or after 3 hours, never on the first message', () => {
  const base = new Date(2026, 10, 10, 20, 0).getTime();
  assert.equal(needsMarker(null, base), false);
  assert.equal(needsMarker(base, base + 2 * 3_600_000), false);
  assert.equal(needsMarker(base, base + 3 * 3_600_000), true);
  assert.equal(needsMarker(base, new Date(2026, 10, 11, 0, 5).getTime()), true);
  assert.equal(timeMarker(new Date(2026, 10, 5, 21, 3).getTime()), '【11月5日 21:03】');
  const marked = markTimes([
    { role: 'user' as const, content: 'a', createdAt: base },
    { role: 'assistant' as const, content: 'b', createdAt: base + 60_000 },
    { role: 'user' as const, content: 'c', createdAt: base + 4 * 3_600_000 },
  ]);
  assert.deepEqual(marked.map(m => m.content), ['a', 'b', `${timeMarker(base + 4 * 3_600_000)}c`]);
});

test('long chat history: leaked drafts are her replies with internal tags, English plans or notes to herself', () => {
  const her = (content: string) => ({ role: 'assistant' as const, content });
  assert.equal(isLeakedDraft(her('嗯，那就不说。靠垫给你。')), false);
  assert.equal(isLeakedDraft(her('OK，听你的～')), false);
  assert.equal(isLeakedDraft(her('我们看的是 Avengers 那段，好好笑')), false);
  assert.equal(isLeakedDraft(her('<reply>在呢</reply>')), true);
  assert.equal(isLeakedDraft(her('Respond shy, short. Avoid action descriptions in parentheses.\n嗯……')), true);
  assert.equal(isLeakedDraft(her('的语气重点：用户想吃甜点，回复一到三句')), true);
  assert.equal(isLeakedDraft({ role: 'user', content: 'Respond shy, short. Avoid action descriptions in parentheses.' }), false);
});
