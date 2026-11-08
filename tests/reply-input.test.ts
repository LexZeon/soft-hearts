import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReplyUpdate } from '../electron/reply-input';

test('reply IPC accepts bounded plain text, lifecycle changes and finite local anchors', () => {
  const update = { text: '<img src=x onerror=alert(1)>', state: 'streaming' as const, anchor: { x: 230.5, y: 160, radius: 95, visible: true } };
  assert.deepEqual(validateReplyUpdate(update), update);
  assert.deepEqual(validateReplyUpdate({ state: 'hidden' }), { state: 'hidden' });
  assert.deepEqual(validateReplyUpdate({ anchor: { x: -1, y: 80, visible: false } }), { anchor: { x: -1, y: 80, visible: false } });
  for (const interactionOpacity of [0, 0.45, 1]) assert.deepEqual(validateReplyUpdate({ interactionOpacity }), { interactionOpacity });
});
test('interaction fade accepts finite unit opacity only and grants no lifecycle or CSS capability', () => {
  for (const interactionOpacity of [null, false, '0.5', NaN, Infinity, -0.01, 1.01]) assert.throws(() => validateReplyUpdate({ interactionOpacity }));
  assert.throws(() => validateReplyUpdate({ interactionOpacity: 0.5, transition: 'opacity 9s' }));
});

test('waiting is display state with no body text or extra capability', () => {
  for (const text of [undefined, '', ' \n']) {
    const update = { state: 'waiting' as const, ...(text === undefined ? {} : { text }) };
    assert.deepEqual(validateReplyUpdate(update), update);
  }
  for (const input of [{ state: 'waiting', text: 'pretend reply' }, { state: 'waiting', text: '<script>x</script>' }, { state: 'waiting', request: 'execute' }])
    assert.throws(() => validateReplyUpdate(input));
});
test('reply IPC rejects malformed, unbounded and capability-bearing input', () => {
  for (const input of [null, [], {}, { text: 'without lifecycle' }, { text: 1, state: 'complete' }, { text: 'x'.repeat(32001), state: 'complete' }, { state: 'done' }, { state: 'complete', shell: 'x' }, { anchor: {} }, { anchor: { x: Infinity, y: 0, visible: true } }, { anchor: { x: 0, y: 0, visible: 'true' } }, { anchor: { x: 0, y: 0, visible: true, radius: -1 } }, { anchor: { x: 0, y: 0, visible: true, file: 'x' } }]) assert.throws(() => validateReplyUpdate(input));
});
