import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHEEK_PINCH_INPUT, CheekPinchTracker, hitCheek,
  type CheekRegion, type CheekPinchEvent, type CheekPinchFeedback, type CheekPinchState,
} from '../src/ui/CheekPinch';

const left: CheekRegion = { side: 'left', x: 80, y: 100, axisXX: 10, axisXY: 0, axisYX: 0, axisYY: 8, referenceWidth: 100 };
const right: CheekRegion = { ...left, side: 'right', x: 120 };
const regions = [left, right];
function harness() {
  const states: CheekPinchState[] = [], feedback: CheekPinchFeedback[] = [], events: CheekPinchEvent[] = [];
  const trace: string[] = [];
  const tracker = new CheekPinchTracker({
    onState: state => { states.push(state); trace.push(state.phase); },
    onFeedback: value => feedback.push(value),
    onEvent: event => { events.push(event); trace.push('reward'); },
  }, 'test');
  return { tracker, states, feedback, events, trace };
}
function qualify(tracker: CheekPinchTracker, x = left.x, start = 0): void {
  tracker.move(x + 5, left.y, start + 100, 1);
  tracker.move(x + 10, left.y, start + 200, 1);
}

test('two calibrated ellipses hit independently and exclude the scalp, mouth and space between cheeks', () => {
  assert.equal(hitCheek(80, 100, regions)?.side, 'left');
  assert.equal(hitCheek(120, 100, regions)?.side, 'right');
  assert.equal(hitCheek(90, 100, regions)?.side, 'left', 'ellipse edge is included');
  for (const [x, y] of [[100, 100], [80, 80], [100, 120], [91, 100]]) assert.equal(hitCheek(x, y, regions), null);
});

test('rotated/mirrored ellipse axes work and invalid projections fail closed', () => {
  const rotated = { ...left, axisXX: 0, axisXY: 10, axisYX: -5, axisYY: 0 };
  assert.equal(hitCheek(80, 109, [rotated])?.side, 'left');
  assert.equal(hitCheek(86, 100, [rotated]), null);
  for (const region of [
    { ...left, axisYY: 0 }, { ...left, axisXX: 0.1 }, { ...left, axisXY: Infinity },
    { ...left, referenceWidth: 0 }, { ...left, x: NaN },
    { ...left, axisXX: 10, axisXY: 10, axisYX: 20, axisYY: 20 },
  ]) assert.equal(hitCheek(80, 100, [region]), null);
  assert.equal(hitCheek(NaN, 100, regions), null);
  assert.equal(hitCheek(80, 100, null), null);
  const overlap = { ...right, x: 84 };
  assert.equal(hitCheek(84, 100, [left, overlap])?.side, 'right');
});

test('hover and press change feedback immediately and never reward entry or static holding', () => {
  const h = harness();
  h.tracker.hover(80, 100, regions);
  assert.deepEqual(h.tracker.state, { phase: 'cheek-hover', sessionId: null });
  assert.equal(h.tracker.feedback.hover, true); assert.equal(h.tracker.feedback.pinching, false);
  h.tracker.hover(120, 100, regions);
  assert.equal(h.tracker.feedback.side, 'right'); assert.equal(h.events.length, 0);
  assert.equal(h.tracker.press(120, 100, 0, regions), true);
  assert.equal(h.tracker.state.phase, 'cheek'); assert.equal(h.tracker.feedback.pinching, true);
  for (let t = 100; t <= 3000; t += 100) h.tracker.move(120, 100, t, 1);
  h.tracker.release(3100);
  assert.equal(h.events.length, 0); assert.equal(h.tracker.state.phase, 'idle');
  assert.equal(h.tracker.feedback.side, null);
});

test('a valid hold emits exactly one bounded event on release before the idle callback', () => {
  const h = harness(); h.tracker.press(80, 100, 0, regions);
  const session = h.tracker.state.sessionId;
  qualify(h.tracker);
  assert.equal(h.events.length, 0, 'measuring and painting do not accept the event');
  h.tracker.release(220); h.tracker.release(300); h.tracker.move(150, 100, 400, 1);
  assert.deepEqual(h.events, [{ type: 'cheek', id: `${session}-release`, sessionId: session, activeMs: 200 }]);
  assert.deepEqual(h.trace.slice(-2), ['reward', 'idle']);
  assert.equal(h.tracker.press(120, 100, 500, regions), true);
  assert.notEqual(h.tracker.state.sessionId, session);
});

test('hold displacement uses the frozen press point and width, without model-following drift', () => {
  const h = harness(); const mutable = { ...left };
  h.tracker.press(83, 102, 0, [mutable]);
  mutable.x = 1000; mutable.y = -1000; mutable.referenceWidth = 10;
  for (let i = 1; i <= 20; i++) {
    h.tracker.hover(1000, -1000, [mutable]);
    h.tracker.move(103, 92, i * 100, 1);
    assert.deepEqual(h.tracker.feedback, { hover: false, pinching: true, side: 'left', x: 0.2, y: -0.1 });
  }
  h.tracker.move(10000, -10000, 2100, 1);
  assert.equal(h.tracker.feedback.x, 2); assert.equal(h.tracker.feedback.y, -2);
  h.tracker.cancel(); assert.equal(h.events.length, 0);
});

test('repress and crossing to another cheek cannot change the held side or session budget', () => {
  const h = harness(); h.tracker.press(80, 100, 0, regions);
  const id = h.tracker.state.sessionId;
  assert.equal(h.tracker.press(120, 100, 50, regions), false);
  qualify(h.tracker);
  h.tracker.hover(120, 100, regions);
  h.tracker.move(120, 100, 300, 1);
  assert.equal(h.tracker.state.sessionId, id); assert.equal(h.tracker.feedback.side, 'left');
  h.tracker.release(350); assert.equal(h.events.length, 1);
});

test('long gaps, stationary time, fast jumps and stale samples do not become activity', () => {
  const h = harness(); h.tracker.press(80, 100, 0, regions);
  h.tracker.move(85, 100, 5000, 1);
  h.tracker.move(90, 100, 4900, 1);
  h.tracker.move(90, 100, 5000, 1);
  h.tracker.move(90, 100, 5100, 1);
  assert.equal(h.tracker.feedback.x, 0.1);
  h.tracker.move(90, 100, 5200, 1);
  h.tracker.move(500, 100, 5300, 1);
  h.tracker.release(5400);
  assert.equal(h.events.length, 0, 'only one valid 100ms segment preceded the stationary/fast samples');
});

test('small oscillation cannot bank time for one later larger sweep', () => {
  const h = harness(); h.tracker.press(80, 100, 0, regions);
  for (let t = 100; t <= 2000; t += 100) h.tracker.move(80 + (t % 200 ? 1 : -1), 100, t, 1);
  h.tracker.move(90, 100, 2100, 1);
  h.tracker.release(2200);
  assert.equal(h.events.length, 0, 'the last 100ms sweep cannot validate two seconds of jitter');
});

test('each valid interval counts once, with a per-hold cap and no release-time backfill', () => {
  const h = harness(); h.tracker.press(80, 100, 0, regions);
  for (let t = 100; t <= 3000; t += 100) h.tracker.move(80 + t / 20, 100, t, 1);
  h.tracker.release(10000);
  assert.equal(h.events.length, 1); assert.equal(h.events[0].activeMs, CHEEK_PINCH_INPUT.maxActiveMs);
});

test('loss of the left-button bit, non-finite input and explicit cancellation discard pending rewards', () => {
  for (const end of [
    (tracker: CheekPinchTracker) => tracker.move(95, 100, 300, 0),
    (tracker: CheekPinchTracker) => tracker.move(95, 100, 300, 2),
    (tracker: CheekPinchTracker) => tracker.move(95, 100, 300, -1),
    (tracker: CheekPinchTracker) => tracker.move(NaN, 100, 300, 1),
    (tracker: CheekPinchTracker) => tracker.move(95, 100, Infinity, 1),
    (tracker: CheekPinchTracker) => tracker.cancel(),
    (tracker: CheekPinchTracker) => tracker.release(NaN),
  ]) {
    const h = harness(); h.tracker.press(80, 100, 0, regions); qualify(h.tracker);
    end(h.tracker); h.tracker.release(400);
    assert.equal(h.events.length, 0); assert.equal(h.tracker.state.phase, 'idle');
    assert.deepEqual(h.tracker.feedback, { hover: false, pinching: false, side: null, x: 0, y: 0 });
  }
});

test('invalid presses and stale release cannot start or finish a later session', () => {
  const h = harness();
  assert.equal(h.tracker.press(100, 100, 0, regions), false);
  assert.equal(h.tracker.press(80, 100, NaN, regions), false);
  assert.equal(h.tracker.press(80, 100, 1000, regions), true);
  h.tracker.release(200);
  assert.equal(h.tracker.state.phase, 'cheek'); assert.equal(h.events.length, 0);
  qualify(h.tracker, 80, 1000); h.tracker.cancel();
  h.tracker.move(120, 100, 1300, 1); h.tracker.release(1400);
  assert.equal(h.events.length, 0);
});

test('snapshot mutation and reentrant release cannot alter or replay a consumed hold', () => {
  const events: CheekPinchEvent[] = [];
  const tracker = new CheekPinchTracker({
    onState: () => {}, onFeedback: () => {},
    onEvent: event => { events.push(event); tracker.release(300); },
  }, 'reentrant');
  tracker.press(80, 100, 0, regions);
  tracker.state.phase = 'idle'; tracker.feedback.x = 100;
  assert.equal(tracker.state.phase, 'cheek'); assert.equal(tracker.feedback.x, 0);
  qualify(tracker); tracker.release(250);
  assert.equal(events.length, 1); assert.equal(tracker.state.phase, 'idle');
});
