// I-174 item 7 (docs/claude/2026-11-21-i174-parity-fixes.md): "may she be touched now" was written twice (the companion window's wiring and
// the full-screen page) and still agreed. One rule now (src/mood/touchable.ts); this feeds both surfaces the same situations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fullTouchable, touchable, windowTouchable } from '../src/mood/touchable';
import { herTouchable } from '../src/unbound/her';

test('the window and full-screen answer the same for the same situation (shown, hidden, the pointer owned by the surface)', () => {
  for (const shown of [true, false]) for (const hidden of [true, false]) for (const blocked of [true, false]) {
    const expected = shown && !hidden && !blocked;
    const window = windowTouchable({ model: true, hostVisible: shown, hidden, cameraEditing: blocked, interactionBlocked: false, composing: false });
    const full = fullTouchable({ peekForcing: blocked, presence: shown ? 1 : 0, hidden });
    assert.equal(window, expected, `window shown=${shown} hidden=${hidden} blocked=${blocked}`);
    assert.equal(full, window, `full-screen agrees: shown=${shown} hidden=${hidden} blocked=${blocked}`);
  }
});

test('each surface\'s own owners of the pointer block it; no model blocks the window; full-screen needs her half faded in', () => {
  const base = { model: true, hostVisible: true, hidden: false, cameraEditing: false, interactionBlocked: false, composing: false };
  assert.equal(windowTouchable(base), true);
  assert.equal(windowTouchable({ ...base, composing: true }), false, 'an input method composing');
  assert.equal(windowTouchable({ ...base, interactionBlocked: true }), false, 'the window\'s own interaction block');
  assert.equal(windowTouchable({ ...base, model: false }), false);
  assert.equal(fullTouchable({ peekForcing: false, presence: 0.49, hidden: false }), false);
  assert.equal(fullTouchable({ peekForcing: false, presence: 0.5, hidden: false }), true);
  assert.equal(herTouchable, fullTouchable, 'the page\'s rule is the shared one');
  assert.equal(touchable({ model: true, shown: true, hidden: false, blocked: false }), true);
});
