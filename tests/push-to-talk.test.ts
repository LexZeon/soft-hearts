import test from 'node:test';
import assert from 'node:assert/strict';
import { PUSH_TO_TALK_TAP_MS, PushToTalk, fieldOf } from '../src/ui/push-to-talk';

function world(on = true) {
  let now = 1000; const calls: string[] = [], typed: string[] = [];
  const media = { get canHoldToTalk() { return on; }, holdToTalk() { calls.push('hold'); }, releaseToTalk(send = true) { calls.push(send ? 'send' : 'tap'); } };
  const talk = new PushToTalk({ media: () => media, now: () => now, type: (_el, letter) => typed.push(letter) });
  return { talk, calls, typed, wait(ms: number) { now += ms; }, off() { on = false; } };
}
const T = (extra: Record<string, unknown> = {}) => ({ code: 'KeyT', key: 't', ...extra });
const field = (value: string) => ({ tagName: 'TEXTAREA', value });

test('T held outside a text field talks; letting go sends; the key repeating while held types nothing', () => {
  const w = world();
  assert.equal(w.talk.down(T({ target: null })), true);
  assert.equal(w.talk.down(T({ repeat: true })), true);
  w.wait(PUSH_TO_TALK_TAP_MS + 50);
  assert.equal(w.talk.up(T()), true);
  assert.deepEqual(w.calls, ['hold', 'send']);
});

test('voice input off: T is just a key', () => {
  const w = world(false);
  assert.equal(w.talk.down(T({ target: null })), false);
  assert.equal(w.talk.up(T()), false);
  assert.deepEqual(w.calls, []);
});

test('in a field that already has text T types; in an empty field a tap types and a hold talks', () => {
  const w = world();
  assert.equal(w.talk.down(T({ target: field('hello') })), false, 'writing: T is a letter');
  assert.equal(w.talk.down(T({ target: field('') })), true);
  w.wait(PUSH_TO_TALK_TAP_MS - 100);
  assert.equal(w.talk.up(T()), true);
  assert.deepEqual(w.calls, ['hold', 'tap']); assert.deepEqual(w.typed, ['t'], 'the tap typed its letter');
  w.talk.down(T({ target: field(''), shiftKey: true })); w.wait(PUSH_TO_TALK_TAP_MS + 10); w.talk.up(T());
  assert.deepEqual(w.calls, ['hold', 'tap', 'hold', 'send']); assert.deepEqual(w.typed, ['t'], 'a hold types nothing');
});

test('an input method composing, Ctrl/Alt/Meta + T and other keys are left alone', () => {
  const w = world();
  assert.equal(w.talk.down(T({ isComposing: true })), false);
  assert.equal(w.talk.down(T({ key: 'Process' })), false);
  assert.equal(w.talk.down(T({ ctrlKey: true })), false);
  assert.equal(w.talk.down({ code: 'KeyR', key: 'r' }), false);
  assert.deepEqual(w.calls, []);
});

test('the window losing focus with T down sends what was said (a tap sends nothing)', () => {
  const w = world();
  w.talk.down(T()); w.wait(PUSH_TO_TALK_TAP_MS + 1); w.talk.blur();
  w.talk.down(T()); w.talk.blur();
  assert.deepEqual(w.calls, ['hold', 'send', 'hold', 'tap']);
  assert.equal(w.talk.holding, false);
});

test('fieldOf tells text fields, empty fields and the rest apart', () => {
  assert.equal(fieldOf(null).kind, 'none');
  assert.equal(fieldOf({ tagName: 'BUTTON' }).kind, 'none');
  assert.equal(fieldOf({ tagName: 'INPUT', type: 'checkbox', value: 'on' }).kind, 'none');
  assert.equal(fieldOf({ tagName: 'INPUT', type: 'text', value: '' }).kind, 'empty');
  assert.equal(fieldOf({ tagName: 'DIV', isContentEditable: true, textContent: 'x' }).kind, 'text');
});
