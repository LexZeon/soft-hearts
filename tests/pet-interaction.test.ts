import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PET_INTERACTION_CONFIG, PetInteraction, PetInteractionTracker, isSnackImage, validatePetInteractionConfig, type PetHeadRegion, type PetInteractionEvent, type PetInteractionFeedback, type PetInteractionState } from "../src/ui/PetInteraction";

const head: PetHeadRegion = { x: 100, y: 100, radius: 50 };
type InputTrace = { kind: 'state'; state: PetInteractionState } | { kind: 'event'; event: PetInteractionEvent };
function harness() {
  const events: PetInteractionEvent[] = [], states: PetInteractionState[] = [], feedback: PetInteractionFeedback[] = [];
  const trace: InputTrace[] = [];
  let now = 0;
  const emittedAt: number[] = [];
  const tracker = new PetInteractionTracker({
    onEvent: event => { events.push(event); emittedAt.push(now); trace.push({ kind: 'event', event }); },
    onState: state => { states.push(state); trace.push({ kind: 'state', state }); },
    onFeedback: value => feedback.push(value),
  }, {}, "test");
  return {
    tracker, events, states, feedback, emittedAt, trace,
    time(value: number) { now = value; },
    move(x: number, y: number, at: number, region: PetHeadRegion | null = head) { now = at; tracker.pointer(x, y, at, region); },
    poll(x: number, y: number, at: number, region: PetHeadRegion | null = head) { now = at; tracker.pollPointer(x, y, at, region); },
    // A first valid sample establishes contact and the measurement origin at t=0.
    ready(x = 100, y = 100, region = head) {
      now = 0; tracker.pointer(x, y, now, region);
      assert.equal(tracker.state.phase, 'rua');
    },
    flush(at: number) { now = at; tracker.flush(at); },
  };
}
const ruaMs = (events: PetInteractionEvent[]) => events.reduce((sum, event) => sum + (event.type === "rua" ? event.activeMs : 0), 0);

test("the first valid hit establishes immediate contact while stationary input earns no activity beyond two seconds", () => {
  const h = harness();
  h.move(100, 100, 0);
  assert.equal(h.tracker.state.phase, 'rua'); assert.ok(h.tracker.state.sessionId);
  assert.equal(h.feedback.at(-1)?.contact, true);
  assert.equal(h.feedback.at(-1)?.hover, 1);
  assert.equal(h.feedback.at(-1)?.speed, 0);
  assert.deepEqual(h.events, [], 'the first sample has no elapsed motion to reward');
  for (let t = 100; t <= 5000; t += 100) {
    if (t % 500 === 0) h.move(100, 100, t); else h.poll(100, 100, t);
    h.flush(t); assert.equal(h.tracker.state.phase, 'rua');
  }
  assert.equal(h.events.length, 0);
  assert.equal(h.states.some(state => state.phase === 'rua-hover'), false);
  h.tracker.leave(5100);
  assert.equal(h.tracker.state.phase, "idle");
  assert.equal(h.feedback.at(-1)?.contact, false);
});

test('qualified real movement is measured before two seconds with no entry-time backfill', () => {
  const h = harness(); h.move(100, 100, 0);
  h.move(105, 100, 100);
  assert.equal(ruaMs(h.events), 100, 'only the actual first movement interval is credited');
  h.move(110, 100, 200); h.flush(300);
  assert.equal(ruaMs(h.events), 200);
  assert.ok(h.emittedAt.every(at => at < 2000));
  assert.ok(h.events.every(event => event.sessionId === h.tracker.state.sessionId));
});

test('a long unobserved gap and non-forward samples cannot count the intervening idle time', () => {
  const h = harness(); h.move(100, 100, 0);
  h.move(110, 100, 5_000); h.flush(5_000);
  assert.equal(ruaMs(h.events), 0, 'the long pause does not become measured contact');
  h.move(110, 100, 4_990); h.flush(5_000);
  assert.equal(ruaMs(h.events), 0);
  h.move(115, 100, 5_090); h.flush(5_300);
  assert.equal(ruaMs(h.events), 100, 'a new forward interval remains independently eligible');
  assert.equal(h.tracker.state.phase, 'rua');
});

test('polling cannot supply motion points, rebase the measured origin or restart an exited session', () => {
  const h = harness(); h.ready();
  h.poll(130, 100, 50); h.flush(50);
  assert.equal(h.events.length, 0);
  h.move(105, 100, 100);
  assert.equal(h.feedback.at(-1)?.speed, 0.5, 'the real five-pixel interval still starts at the real origin');
  assert.equal(ruaMs(h.events), 100);
  h.tracker.leave(200); h.poll(100, 100, 300); h.flush(400);
  assert.equal(h.tracker.state.phase, 'idle'); assert.equal(ruaMs(h.events), 100);
});

test("qualified motion credits each measured interval once in bounded batches", () => {
  const h = harness();
  h.ready();
  for (let t = 100; t <= 1000; t += 100) h.move(100 + (t <= 500 ? t : 1000 - t) / 20, 100, t);
  h.flush(1200); h.flush(1600); h.flush(2000);
  assert.equal(ruaMs(h.events), 1000);
  assert.equal(new Set(h.events.map(event => event.id)).size, h.events.length);
  assert.ok(h.events.every(event => event.type !== "rua" || event.activeMs <= 500));
  for (let i = 1; i < h.emittedAt.length; i++) assert.ok(h.emittedAt[i] - h.emittedAt[i - 1] >= 200);
});

test("tiny repeated jitter and an extreme swipe do not become rewards", () => {
  const jitter = harness(); jitter.ready();
  for (let t = 50; t <= 1500; t += 50) jitter.move(100 + (t % 100 ? 1 : -1), 100, t);
  jitter.flush(2000);
  assert.equal(ruaMs(jitter.events), 0);
  const fast = harness(); fast.ready();
  for (let t = 10; t <= 150; t += 10) fast.move(t % 20 ? 120 : 80, 100, t);
  fast.flush(1000);
  assert.equal(ruaMs(fast.events), 0);
});

test("model movement is not mouse velocity and reference head size stays frozen", () => {
  const h = harness(); h.ready();
  for (let t = 100; t <= 1000; t += 100) h.move(100, 100, t, { x: 100 + t / 100, y: 100, radius: 30, referenceWidth: 20 });
  assert.equal(h.tracker.state.phase, "rua");
  assert.equal(ruaMs(h.events), 0);
  assert.equal(h.feedback.at(-1)?.speed, 0);
  h.move(105, 100, 1100, { x: 110, y: 100, radius: 30, referenceWidth: 20 });
  assert.equal(h.feedback.at(-1)?.speed, 0.5, 'raw five-pixel motion still uses the original 100px reference width');
});

test("a move after a stationary pause does not count elapsed pause time", () => {
  const h = harness(); h.ready();
  h.move(110, 100, 5000); h.flush(5200);
  assert.equal(ruaMs(h.events), 0);
  h.move(115, 100, 5100); h.flush(5400);
  assert.equal(ruaMs(h.events), 100);
});

test("contact hysteresis tolerates a small exit and ordinary exit drains tail only once", () => {
  const h = harness(); h.ready(); h.move(105, 100, 100); h.move(110, 100, 200);
  h.tracker.leave(210); h.time(310); h.flush(310); h.flush(600);
  assert.equal(ruaMs(h.events), 200);
  assert.equal(h.tracker.state.phase, "idle");
  const second = harness(); second.ready(149, 100); second.move(155, 100, 100);
  assert.equal(second.tracker.state.phase, "rua");
  second.move(165, 100, 200);
  assert.equal(second.tracker.state.phase, "idle");
});

test('projected scalp ellipses include the crown while excluding the face and malformed shapes', () => {
  const scalp: PetHeadRegion = { x: 100, y: 60, radius: 50, axisXX: 45, axisXY: 0, axisYX: 0, axisYY: 35, referenceWidth: 100, mouthX: 100, mouthY: 120, mouthRadius: 12 };
  const h = harness(); h.ready(100, 27, scalp);
  assert.equal(h.tracker.state.phase, 'rua');
  h.move(100, 96, 100, scalp);
  assert.equal(h.tracker.state.phase, 'idle', 'the continuation margin never extends below v=1 into the face');
  for (const invalid of [
    { ...scalp, axisYY: undefined }, { ...scalp, axisYY: NaN },
    { ...scalp, axisXX: 45, axisXY: 0, axisYX: 35, axisYY: 0 },
    { ...scalp, referenceWidth: Infinity }, { ...scalp, mouthRadius: -1 },
  ]) { h.move(100, 60, 200, invalid); assert.equal(h.tracker.state.phase, 'idle'); }
});

test('inverse-axis hit testing follows rotated and translated head shapes instead of a stale contact circle', () => {
  const rotated: PetHeadRegion = { x: 100, y: 100, radius: 25, axisXX: 0, axisXY: 30, axisYX: -60, axisYY: 0, referenceWidth: 100 };
  const h = harness(); h.ready(45, 100, rotated);
  assert.equal(h.tracker.state.phase, 'rua', 'a point outside the radius circle is inside the true rotated ellipse');
  h.move(38, 100, 100, rotated);
  assert.equal(h.tracker.state.phase, 'idle', 'v>1 is rejected even within the 1.12 continuation margin');
  h.move(100, 100, 200, rotated);
  h.move(100, 100, 300, { ...rotated, x: 300 });
  assert.equal(h.tracker.state.phase, 'idle', 'head movement updates the hit shape even without mouse movement');
  assert.equal(ruaMs(h.events), 0);
});

test('ellipse continuation grace is bounded at 1.12 and does not change the frozen input unit', () => {
  const scalp: PetHeadRegion = { x: 100, y: 60, radius: 50, axisXX: 50, axisXY: 0, axisYX: 0, axisYY: 30, referenceWidth: 100 };
  const h = harness(); h.ready(149, 60, scalp); h.move(155, 60, 100, { ...scalp, referenceWidth: 20 });
  assert.equal(h.tracker.state.phase, 'rua'); assert.equal(h.feedback.at(-1)?.speed, 0.6);
  h.move(157, 60, 200, scalp); assert.equal(h.tracker.state.phase, 'idle');
});

test('food mouth radius remains independent from the larger scalp ellipse and drop rechecks the latest mouth', () => {
  const scalp: PetHeadRegion = { x: 100, y: 60, radius: 100, axisXX: 120, axisXY: 0, axisYX: 0, axisYY: 80, referenceWidth: 100, mouthX: 100, mouthY: 120, mouthRadius: 10 };
  const outside = harness(); outside.tracker.drag(111, 120, 0, scalp); outside.flush(700);
  assert.equal(outside.tracker.state.phase, 'feeding-wait'); assert.equal(outside.events.length, 0);
  const accepted = harness(); accepted.tracker.drag(109, 120, 0, scalp); accepted.flush(650);
  assert.equal(accepted.tracker.drop(109, 120, 700, true, scalp), true);
  const moved = harness(); moved.tracker.drag(100, 120, 0, scalp); moved.flush(650);
  assert.equal(moved.tracker.drop(100, 120, 700, true, { ...scalp, mouthX: 150 }), false);
  assert.equal(moved.events.filter(event => event.type === 'food').length, 0);
});

test("feeding prepares at the mouth and accepts exactly once on an explicit supported drop", () => {
  const h = harness();
  h.tracker.drag(100, 119, 0, head);
  assert.equal(h.tracker.state.phase, "feeding-wait");
  h.flush(649); assert.equal(h.tracker.state.phase, "feeding-wait");
  h.flush(650); assert.equal(h.tracker.state.phase, "feeding-ready");
  assert.equal(h.events.length, 0);
  assert.equal(h.tracker.drop(100, 119, 700, true), true);
  assert.equal(h.tracker.state.phase, "feeding-accepted");
  assert.equal(h.tracker.drop(100, 119, 701, true), false);
  assert.equal(h.events.filter(event => event.type === "food").length, 1);
});

test("early release, unsupported file, leaving mouth and cancel never award food", () => {
  for (const mode of ["early", "unsupported", "outside", "cancel"] as const) {
    const h = harness(); h.tracker.drag(100, 119, 0, head);
    if (mode === "early") h.tracker.drop(100, 119, 100, true);
    else {
      h.flush(700);
      if (mode === "outside") h.tracker.drag(200, 200, 710, head);
      if (mode === "cancel") h.tracker.cancel();
      h.tracker.drop(mode === "outside" ? 200 : 100, mode === "outside" ? 200 : 119, 750, mode !== "unsupported");
    }
    assert.equal(h.events.filter(event => event.type === "food").length, 0, mode);
  }
});

test("feeding excludes rua, finishes after an interval and abandoned drag expires", () => {
  const h = harness(); h.tracker.drag(100, 119, 0, head);
  h.move(105, 100, 100); h.move(110, 100, 200);
  assert.equal(ruaMs(h.events), 0);
  h.flush(650); h.tracker.drop(100, 119, 700, true);
  h.flush(1599); assert.equal(h.tracker.state.phase, "feeding-accepted");
  h.flush(1600); assert.equal(h.tracker.state.phase, "idle");
  const abandoned = harness(); abandoned.tracker.drag(100, 119, 0, head); abandoned.flush(1600);
  assert.equal(abandoned.tracker.state.phase, "idle");
  assert.equal(abandoned.events.length, 0);
});

test("context cancellation invalidates queued tail and the next contact gets a new identity", () => {
  const h = harness(); h.ready(); const session = h.tracker.state.sessionId;
  h.move(105, 100, 100); h.move(110, 100, 200);
  const alreadySent = ruaMs(h.events);
  h.tracker.cancel(); h.flush(500);
  assert.equal(ruaMs(h.events), alreadySent);
  h.move(100, 100, 600);
  assert.equal(h.tracker.state.phase, 'rua'); assert.notEqual(h.tracker.state.sessionId, session);
  assert.equal(ruaMs(h.events), alreadySent); assert.equal(h.feedback.at(-1)?.speed, 0);
  h.tracker.pointer(105, 100, 700, head, false);
  assert.equal(h.tracker.state.phase, "idle");
});

test("a new immediate session supersedes only unsubmitted old tail before publishing its identity", () => {
  const h = harness(); h.ready(); const session = h.tracker.state.sessionId;
  h.move(105, 100, 100); h.move(110, 100, 200); h.tracker.leave(210);
  const nextHead = { ...head, referenceWidth: 20 };
  h.move(100, 100, 250, nextHead);
  const nextSession = h.tracker.state.sessionId;
  assert.equal(h.tracker.state.phase, 'rua'); assert.notEqual(nextSession, session);
  assert.equal(h.feedback.at(-1)?.speed, 0);
  h.flush(300); assert.ok(h.events.every(event => event.sessionId === session));
  assert.equal(ruaMs(h.events), 100, 'already submitted activity stays; the old pending 100ms and new entry add no dose');
  h.move(105, 100, 350, nextHead);
  assert.equal(h.feedback.at(-1)?.speed, 2.5, 'the new session freezes the new 20px reference width');
  h.flush(500);
  assert.equal(h.feedback.at(-1)?.speed, 0, 'flush clears stale displayed velocity');
  assert.equal(ruaMs(h.events.filter(event => event.sessionId === nextSession)), 100);
  const entered = h.trace.findIndex(item => item.kind === 'state' && item.state.sessionId === nextSession);
  assert.ok(entered >= 0);
  assert.ok(h.trace.slice(entered + 1).some(item => item.kind === 'event' && item.event.sessionId === nextSession));
  assert.ok(h.trace.slice(entered + 1).every(item => item.kind !== 'event' || item.event.sessionId === nextSession),
    'no event from the superseded identity can follow publication of the new state');
  assert.equal(ruaMs(h.events.filter(event => event.sessionId === session)), 100, 'the old event is neither rolled back nor relabelled');
  assert.ok(h.events.every(event => /^[a-zA-Z0-9_-]{1,100}$/.test(event.id)));
});

test("image metadata allows bounded raster types without obtaining file content or paths", () => {
  for (const name of ["snack.png", "SNACK.JPEG", "snack.webp", "snack.gif", "snack.bmp"]) assert.equal(isSnackImage({ name, type: "", size: 100 }), true);
  for (const file of [{ name: "x.svg", type: "image/svg+xml", size: 100 }, { name: "x.png", type: "application/javascript", size: 100 }, { name: "x.jpg", type: "image/jpeg", size: 0 }, { name: "x.png", type: "image/png", size: 50 * 1024 * 1024 + 1 }, { name: "x.exe", type: "image/png", size: 100 }]) assert.equal(isSnackImage(file), false);
  assert.equal(isSnackImage({ name: "x.png", type: "image/png", size: 50 * 1024 * 1024 }), true, "up to 50 MB (shrunk like any other)");
  assert.equal(isSnackImage({ name: "x.jpg", type: "image/jpeg", size: 30 * 1024 * 1024 }), true);
});

test("runtime feel configuration keeps the host preparation gate and rejects unknown or invalid fields", () => {
  assert.deepEqual(validatePetInteractionConfig(DEFAULT_PET_INTERACTION_CONFIG), DEFAULT_PET_INTERACTION_CONFIG);
  for (const patch of [{ prepareMs: 499 }, { prepareMs: 3001 }, { minSpeed: 4, maxSpeed: 3 }, { qualityWindowMs: NaN }, { minSweep: 0 }, { arbitrary: 1 }])
    assert.throws(() => validatePetInteractionConfig({ ...DEFAULT_PET_INTERACTION_CONFIG, ...patch }));
  const h = harness(); h.tracker.configure({ prepareMs: 500 });
  h.tracker.drag(100, 119, 0, head); h.flush(499); assert.equal(h.tracker.state.phase, "feeding-wait");
  h.flush(500); assert.equal(h.tracker.state.phase, "feeding-ready");
  assert.equal(h.events.length, 0);
});

test("DOM adapter cancels on blur, host hide and dispose without reading or replacing UI nodes", t => {
  let clock = 0;
  const view = new EventTarget() as EventTarget & { performance: { now(): number } }; view.performance = { now: () => clock };
  const owner = new EventTarget() as EventTarget & { defaultView: unknown; hidden: boolean }; owner.defaultView = view; owner.hidden = false;
  const surface = new EventTarget() as EventTarget & { ownerDocument: unknown; getBoundingClientRect(): object; contains(): boolean };
  surface.ownerDocument = owner; surface.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 400 }); surface.contains = () => false;
  const states: PetInteractionState[] = [], events: PetInteractionEvent[] = [];
  const input = new PetInteraction(surface as unknown as HTMLElement, { getHeadRegion: () => head, onState: state => states.push(state), onFeedback() {}, onEvent: event => { events.push(event); } });
  t.after(() => input.dispose());
  const move = () => { const event = new Event("pointermove"); Object.assign(event, { clientX: 110, clientY: 120, buttons: 0, pointerType: "mouse", isPrimary: true }); surface.dispatchEvent(event); };
  move(); assert.equal(input.state.phase, "rua");
  view.dispatchEvent(new Event("blur")); assert.equal(input.state.phase, "idle");
  clock = 100; move(); input.setHostVisible(false); assert.equal(input.state.phase, "idle");
  clock = 200; move(); assert.equal(input.state.phase, "idle");
  input.setHostVisible(true); move(); assert.equal(input.state.phase, "rua");
  input.dispose(); const count = states.length; clock = 300; move();
  assert.equal(states.length, count); assert.equal(events.length, 0);
});

test('resize, blur and reserved UI clear old movement origins and reentry cannot send a superseded tail', async t => {
  for (const mode of ['resize', 'blur', 'ui-point', 'ui-focus'] as const) await t.test(mode, child => {
    let clock = 0, timer = () => {}, blocked = false;
    let liveHead: PetHeadRegion = { ...head };
    const rect = { left: 10, top: 20, width: 300, height: 400 };
    child.mock.method(globalThis, 'setInterval', (callback: () => void) => { timer = callback; return 1; });
    child.mock.method(globalThis, 'clearInterval', () => {});
    const view = Object.assign(new EventTarget(), { performance: { now: () => clock } });
    const owner = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
    const surface = Object.assign(new EventTarget(), { ownerDocument: owner,
      getBoundingClientRect: () => ({ ...rect }), contains: () => false });
    const feedback: PetInteractionFeedback[] = [], events: PetInteractionEvent[] = [], trace: InputTrace[] = [];
    const input = new PetInteraction(surface as unknown as HTMLElement, {
      getHeadRegion: () => liveHead, blocksPoint: () => blocked,
      onState: state => { trace.push({ kind: 'state', state }); }, onFeedback: value => feedback.push(value),
      onEvent: event => { events.push(event); trace.push({ kind: 'event', event }); },
    });
    child.after(() => input.dispose());
    const move = (x: number, at: number) => {
      clock = at;
      const event = new Event('pointermove');
      Object.assign(event, { clientX: rect.left + x, clientY: rect.top + 100, buttons: 0, pointerType: 'mouse', isPrimary: true });
      surface.dispatchEvent(event);
    };
    move(100, 0); const oldSession = input.state.sessionId;
    move(105, 100); move(110, 200);
    assert.equal(ruaMs(events), 100, 'one measured interval is pending behind the 5Hz flush');
    clock = 210;
    if (mode === 'ui-point') { blocked = true; move(110, 210); }
    else if (mode === 'ui-focus') {
      blocked = true;
      const event = new Event('focusin');
      Object.defineProperty(event, 'target', { value: { getBoundingClientRect: () => ({ left: 30, top: 30, width: 30, height: 30 }) } });
      owner.dispatchEvent(event);
    } else view.dispatchEvent(new Event(mode));
    assert.equal(input.state.phase, 'idle'); assert.equal(feedback.at(-1)?.contact, false);
    if (mode === 'resize') { rect.left = 30; rect.top = 40; rect.width = 400; }
    blocked = false; liveHead = { ...head, referenceWidth: 20 };
    move(100, 250); const newSession = input.state.sessionId;
    assert.equal(input.state.phase, 'rua'); assert.notEqual(newSession, oldSession);
    assert.equal(feedback.at(-1)?.speed, 0); assert.equal(ruaMs(events), 100, 'the new first point adds no cross-boundary movement');
    clock = 300; timer();
    const expectedOld = 100;
    assert.equal(ruaMs(events.filter(event => event.sessionId === oldSession)), expectedOld,
      'context cancellation or the immediate new session discards only the unsubmitted old tail');
    move(105, 350);
    assert.equal(feedback.at(-1)?.speed, 2.5);
    clock = 500; timer();
    assert.equal(ruaMs(events.filter(event => event.sessionId === newSession)), 100);
    assert.equal(ruaMs(events), expectedOld + 100);
    const entered = trace.findIndex(item => item.kind === 'state' && item.state.sessionId === newSession);
    assert.ok(entered >= 0);
    assert.ok(trace.slice(entered + 1).every(item => item.kind !== 'event' || item.event.sessionId === newSession));
  });
});

test('DOM polling rechecks actual contact without creating movement or restarting from idle', t => {
  let clock = 0, timer = () => {}, blocked = false, eligible = true;
  let liveHead: PetHeadRegion = { ...head };
  t.mock.method(globalThis, 'setInterval', (callback: () => void) => { timer = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const view = Object.assign(new EventTarget(), { performance: { now: () => clock } });
  const owner = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
  const surface = Object.assign(new EventTarget(), { ownerDocument: owner,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 400 }), contains: () => false });
  const feedback: PetInteractionFeedback[] = [], events: PetInteractionEvent[] = [];
  const input = new PetInteraction(surface as unknown as HTMLElement, {
    getHeadRegion: () => liveHead, blocksPoint: () => blocked, canInteract: () => eligible,
    onState() {}, onFeedback: value => feedback.push(value), onEvent: value => { events.push(value); },
  });
  t.after(() => input.dispose());
  const point = (type = 'pointermove') => {
    const event = new Event(type); Object.assign(event, { clientX: 110, clientY: 120, buttons: 0, pointerType: 'mouse', isPrimary: true });
    surface.dispatchEvent(event);
  };
  const advance = (to: number) => { while (clock < to) { clock = Math.min(clock + 100, to); timer(); } };
  point(); advance(1900);
  assert.equal(input.state.phase, 'rua'); assert.equal(feedback.at(-1)?.contact, true);
  assert.equal(feedback.at(-1)?.speed, 0); assert.equal(events.length, 0);
  liveHead = { ...head, x: 300 }; advance(2000);
  assert.equal(input.state.phase, 'idle'); assert.equal(feedback.at(-1)?.hover, 0);
  liveHead = { ...head }; advance(5000);
  assert.equal(input.state.phase, 'idle', 'the head cannot move back under a still pointer and start itself');
  point(); assert.equal(input.state.phase, 'rua'); advance(7000);
  assert.equal(input.state.phase, 'rua', 'stationary contact needs no separate maturity timer');
  assert.equal(events.length, 0, 'neither timer samples nor model motion create activity');
  blocked = true; advance(7100); assert.equal(input.state.phase, 'idle');
  blocked = false; point(); advance(8100); point('pointerdown'); advance(10_100);
  assert.equal(input.state.phase, 'idle', 'pressing down without moving cancels contact');
  point(); advance(11_100); eligible = false; advance(12_100);
  assert.equal(input.state.phase, 'idle'); assert.equal(feedback.at(-1)?.hover, 0);
  eligible = true; point(); advance(13_100); blocked = true;
  const focused = new Event('focusin');
  Object.defineProperty(focused, 'target', { value: { getBoundingClientRect: () => ({ left: 40, top: 40, width: 40, height: 30 }) } });
  owner.dispatchEvent(focused);
  assert.equal(input.state.phase, 'idle', 'keyboard focus entering reserved UI cancels contact immediately');
  assert.equal(events.length, 0);
});

test('B06: feeding feedback reports display-only mouth proximity; acceptance still needs the mouth radius and dwell', () => {
  const scalp: PetHeadRegion = { x: 100, y: 60, radius: 50, axisXX: 45, axisXY: 0, axisYX: 0, axisYY: 35, referenceWidth: 100, mouthX: 100, mouthY: 120, mouthRadius: 12 };
  const h = harness();
  const nears = [180, 160, 150, 140, 130, 120].map((y, i) => { h.tracker.drag(100, y, i * 50, scalp); return h.feedback.at(-1)!.near!; });
  assert.ok(nears[0] === 0 && nears.every((value, i) => i === 0 || value >= nears[i - 1]) && nears.at(-1)! === 1, nears.join(' '));
  assert.equal(h.feedback.at(-1)!.prepared, false, 'proximity grants nothing by itself');
  assert.equal(h.tracker.drop(100, 125, 260, true, scalp), false, 'no early acceptance');
});
