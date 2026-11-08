import test from 'node:test';
import assert from 'node:assert/strict';
import { HoverVisibility } from '../src/ui/HoverVisibility';

function fixture() {
  let now = 0, serial = 0, visible = false;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const cancelled: (() => void)[] = [];
  const hover = new HoverVisibility(value => visible = value, {
    setTimeout(callback, milliseconds) { const id = ++serial; tasks.set(id, { at: now + milliseconds, callback }); return id; },
    clearTimeout(handle) { const task = tasks.get(handle as number); if (task) cancelled.push(task.callback); tasks.delete(handle as number); },
  });
  return { hover, tasks, cancelled, get visible() { return visible; }, advance(ms: number) {
    now += ms;
    for (const [id, task] of [...tasks]) if (task.at <= now) { tasks.delete(id); task.callback(); }
  } };
}
test('leaving hides at 1000 ms even after a mouse-focused button', () => {
  const f = fixture(); f.hover.enter(); f.hover.focus(false); f.hover.leave();
  f.advance(999); assert.equal(f.visible, true); f.advance(1); assert.equal(f.visible, false);
});
test('reentry cancels the deadline and a late callback cannot hide a newly hovered toolbar', () => {
  const f = fixture(); f.hover.enter(); f.hover.leave(); f.advance(900); f.hover.enter();
  f.cancelled[0](); f.advance(3000); assert.equal(f.visible, true); assert.equal(f.tasks.size, 0);
  f.hover.leave(); f.advance(1000); assert.equal(f.visible, false);
});
test('a held drag stays visible outside, then gets one full second after release', () => {
  const f = fixture(); f.hover.enter(); f.hover.hold(true); f.hover.leave(); f.advance(4000);
  assert.equal(f.visible, true); assert.equal(f.tasks.size, 0);
  f.hover.hold(false); f.hover.leave(); assert.equal(f.tasks.size, 1);
  f.advance(999); assert.equal(f.visible, true); f.advance(1); assert.equal(f.visible, false);
});
test('native hide/dispose reset cancels deadlines and keyboard focus is explicit', () => {
  const f = fixture(); f.hover.focus(true); f.hover.leave(); f.advance(2000); assert.equal(f.visible, true);
  f.hover.focus(false); assert.equal(f.tasks.size, 1); f.hover.reset();
  for (const callback of f.cancelled) callback();
  f.advance(3000); assert.equal(f.visible, false); assert.equal(f.tasks.size, 0);
  f.hover.enter(); assert.equal(f.visible, true);
});

test('one contact keeps an already visible toolbar for two seconds despite ordinary leave and pointer refresh', () => {
  const f = fixture(); f.hover.enter(); f.hover.leave(); f.advance(300); f.hover.contact(true);
  f.cancelled[0](); assert.equal(f.visible, true, 'a queued ordinary leave callback is invalid once contact owns the deadline');
  f.advance(999); assert.equal(f.visible, true, 'ordinary one-second leave must not win over contact');
  f.hover.enter(); f.hover.contact(true); f.hover.leave();
  f.advance(1000); assert.equal(f.visible, true);
  f.advance(1); assert.equal(f.visible, false, 'the same contact has one two-second deadline');
  f.hover.enter(); f.hover.contact(true); f.advance(5000); assert.equal(f.visible, false, 'continuous contact cannot flash the toolbar back');
  f.hover.contact(false); assert.equal(f.visible, false, 'contact exit is not a request to reveal a stale nearby zone');
  f.hover.enter(); assert.equal(f.visible, true);
});

test('contact does not reveal a hidden toolbar and cancelling cannot replay an old deadline', () => {
  const f = fixture(); f.hover.contact(true); f.advance(1000); assert.equal(f.visible, false);
  f.hover.contact(false); const old = f.cancelled.at(-1)!;
  f.hover.enter(); f.hover.contact(true); old(); f.advance(1999); assert.equal(f.visible, true);
  f.advance(1); assert.equal(f.visible, false);
});

test('a held window operation or keyboard focus remains available after the contact deadline', () => {
  const f = fixture(); f.hover.enter(); f.hover.contact(true); f.hover.hold(true); f.hover.leave();
  f.advance(3000); assert.equal(f.visible, true);
  f.hover.hold(false); assert.equal(f.visible, false);
  f.hover.focus(true); assert.equal(f.visible, true); f.advance(5000); assert.equal(f.visible, true);
  f.hover.focus(false); assert.equal(f.visible, false);
});

test('reset invalidates both leave and contact callbacks without resurrecting hidden UI', () => {
  const f = fixture(); f.hover.enter(); f.hover.contact(true); f.advance(800); f.hover.reset();
  for (const callback of f.cancelled) callback(); f.advance(5000);
  assert.equal(f.visible, false); assert.equal(f.tasks.size, 0);
  f.hover.enter(); f.hover.contact(true); f.advance(1999); assert.equal(f.visible, true);
  f.advance(1); assert.equal(f.visible, false);
});
