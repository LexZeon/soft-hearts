// I-048 step 1: the watch timeline, the haiku planner and the frame-change gate. All made-up data and a fake clock; no model, no files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchTimeline } from '../shared/behaviors/watch-timeline/timeline';
import { HaikuPlanner } from '../shared/behaviors/watch-timeline/scheduler';
import { FrameGate, changedShare } from '../shared/behaviors/watch-timeline/frame-change';
import { WATCH_TIMELINE_KNOBS } from '../shared/behaviors/watch-timeline/knobs';

const T0 = 1_800_000_000_000;
const S = 1000;
const MIN = 60_000;
const K = WATCH_TIMELINE_KNOBS;

// ---- timeline ----
test('a frame description goes in at the capture time, not when haiku finished', () => {
  const line = new WatchTimeline();
  line.addHeard('你根本不知道那天晚上发生了什么。', T0);
  const ticket = line.reserveSeen(T0 + 3 * S);
  line.addHeard('信是你寄的吧？', T0 + 7 * S);
  assert.equal(line.fillSeen(ticket, '昏暗的走廊，两个人对峙，一个人手里拿着信封。', T0 + 12 * S), true);
  const order = line.snapshot().map(entry => entry.kind);
  assert.deepEqual(order, ['heard', 'seen', 'heard']);
  const text = line.render(T0 + 12 * S).text.split('\n');
  assert.match(text[1], /^9秒前 看到：昏暗的走廊/);
  assert.match(text[2], /^5秒前 听到：信是你寄的吧/);
});

test('a frame still being described shows as a placeholder and is filled in place', () => {
  const line = new WatchTimeline();
  const ticket = line.reserveSeen(T0);
  line.addHeard('后来呢？', T0 + 2 * S);
  const before = line.render(T0 + 5 * S);
  assert.equal(before.pending, 1);
  assert.match(before.text, /看到：（画面描述中）/);
  line.fillSeen(ticket, '一个人站在雨里。', T0 + 6 * S);
  const after = line.render(T0 + 6 * S);
  assert.equal(after.pending, 0);
  assert.equal(after.seen, 1);
  assert.doesNotMatch(after.text, /画面描述中/);
  assert.equal(line.snapshot().length, 2);
});

test('a description that arrives after its slot left the window is dropped', () => {
  const line = new WatchTimeline();
  const ticket = line.reserveSeen(T0);
  assert.equal(line.fillSeen(ticket, '太晚了的描述', T0 + K.timeline.windowMinutes * MIN + S), false);
  assert.equal(line.snapshot().length, 0);
});

test('a placeholder that never got its description is not kept for ever', () => {
  const line = new WatchTimeline();
  line.reserveSeen(T0);
  assert.equal(line.render(T0 + (K.timeline.pendingSeconds + 1) * S).pending, 0);
  assert.equal(line.size, 0);
});

test('descriptions that arrive after watch off, a refusal or a new watch are never inserted', () => {
  const line = new WatchTimeline();
  const off = line.reserveSeen(T0);
  line.reset();
  assert.equal(line.fillSeen(off, '关掉以后才来的', T0 + S), false);
  const refused = line.reserveSeen(T0 + 2 * S);
  line.cancelPending();
  assert.equal(line.fillSeen(refused, '说别看以后才来的', T0 + 3 * S), false);
  const fresh = line.reserveSeen(T0 + 4 * S);
  line.reset();
  const again = line.reserveSeen(T0 + 4 * S);
  assert.equal(line.fillSeen(fresh, '上一次观看的描述', T0 + 5 * S), false, 'a ticket from before the reset cannot fill the new slot');
  assert.equal(line.fillSeen(again, '这一次的描述', T0 + 5 * S), true);
  assert.equal(line.snapshot().filter(entry => entry.text.includes('上一次')).length, 0);
});

test('cancelling waiting descriptions keeps the ones already written', () => {
  const line = new WatchTimeline();
  const done = line.reserveSeen(T0);
  line.fillSeen(done, '已经写好的', T0 + S);
  line.reserveSeen(T0 + 2 * S);
  line.cancelPending();
  assert.deepEqual(line.snapshot().map(entry => entry.text), ['已经写好的']);
});

test('the in-memory window keeps only the last ten minutes', () => {
  const line = new WatchTimeline();
  line.addHeard('很久以前的话', T0);
  line.addHeard('刚说的话', T0 + 11 * MIN);
  assert.deepEqual(line.snapshot().map(entry => entry.text), ['刚说的话']);
});

test('summaries replace the older stretch, keep waiting placeholders, and a stale summary is refused', () => {
  const line = new WatchTimeline();
  for (let i = 0; i < 8; i++) line.addHeard(`第${i}句`, T0 + i * 5 * S);
  assert.equal(line.compactPlan(T0 + 60 * S), null, 'nothing is old enough yet');
  line.reserveSeen(T0 + 200 * S);
  const now = T0 + 250 * S;
  const stale = line.compactPlan(now)!;
  assert.equal(stale.entries.length, 8, 'all eight old lines are offered');
  assert.equal(stale.entries.some(entry => entry.pending), false, 'a placeholder is never compacted');
  line.cancelPending();
  assert.equal(line.applySummary(stale, '过期的概要', now), false);
  assert.equal(line.snapshot().some(entry => entry.kind === 'summary'), false);
  line.reserveSeen(T0 + 210 * S);
  assert.equal(line.applySummary(line.compactPlan(now)!, '两个人在走廊对峙，信封是关键。', now), true);
  assert.deepEqual(line.snapshot().map(entry => entry.kind), ['summary', 'seen']);
});

test('too few old lines are not worth a summary', () => {
  const line = new WatchTimeline();
  line.addHeard('一句', T0);
  line.addHeard('两句', T0 + S);
  assert.equal(line.compactPlan(T0 + 6 * MIN), null);
});

test('render gives the last 90 seconds plus summaries, newest kept first within the character budget', () => {
  const tight = { ...K.timeline, blockChars: 120 };
  const line = new WatchTimeline(tight);
  line.addHeard('一'.repeat(60), T0);
  line.addHeard('二'.repeat(60), T0 + 30 * S);
  line.addHeard('三'.repeat(60), T0 + 60 * S);
  const block = line.render(T0 + 70 * S);
  assert.ok(block.chars <= 120, `block is ${block.chars} chars`);
  assert.match(block.text, /三{60}/);
  assert.doesNotMatch(block.text, /一{10}/, 'the oldest line is the one that goes');
});

test('render leaves out lines older than the recent window unless there is room, and keeps summaries', () => {
  const line = new WatchTimeline();
  for (let i = 0; i < 6; i++) line.addHeard(`旧话${i}`, T0 + i * S);
  const plan = line.compactPlan(T0 + 4 * MIN)!;
  line.applySummary(plan, '开头的剧情概要', T0 + 4 * MIN);
  line.addHeard('现在这句', T0 + 4 * MIN);
  const text = line.render(T0 + 4 * MIN + 5 * S).text;
  assert.match(text, /概要：开头的剧情概要/);
  assert.match(text, /听到：现在这句/);
  assert.doesNotMatch(text, /旧话/);
});

test('an empty timeline renders nothing', () => {
  assert.deepEqual(new WatchTimeline().render(T0), { text: '', heard: 0, seen: 0, pending: 0, summaries: 0, chars: 0 });
});

// ---- haiku planner ----
function planner(overrides: Partial<typeof K.haiku> = {}) {
  const clock = { now: T0 };
  const plan = new HaikuPlanner(() => clock.now, { ...K.haiku, ...overrides });
  return { clock, plan };
}
const on = { watch: true, screen: true };
const accepted = (result: ReturnType<HaikuPlanner['enqueue']>) => { assert.ok(result.accepted); return result.job; };

test('nothing is scheduled while watch is off or the screen is off', () => {
  const { plan } = planner();
  assert.deepEqual(plan.enqueue('frame'), { accepted: false, reason: 'screen-off' });
  plan.setConditions({ watch: false, screen: true });
  assert.deepEqual(plan.enqueue('frame'), { accepted: false, reason: 'watch-off' });
  assert.deepEqual(plan.enqueue('summary'), { accepted: false, reason: 'watch-off' });
  assert.equal(plan.next(), null);
});

test('the look decision goes first, then a frame, then a summary, whatever the order they were asked in', () => {
  const { plan } = planner({ parallel: 3 });
  plan.setConditions(on);
  accepted(plan.enqueue('summary'));
  accepted(plan.enqueue('frame'));
  accepted(plan.enqueue('look'));
  assert.deepEqual([plan.next()!.kind, plan.next()!.kind, plan.next()!.kind], ['look', 'frame', 'summary']);
});

test('only the configured number of jobs run at once', () => {
  const { plan } = planner();
  plan.setConditions(on);
  accepted(plan.enqueue('frame'));
  accepted(plan.enqueue('frame'));
  const first = plan.next()!;
  assert.equal(plan.next(), null);
  plan.finish(first);
  assert.equal(plan.next()!.kind, 'frame');
});

test('frame descriptions stop at the hourly budget and come back when the hour has moved on', () => {
  const { clock, plan } = planner();
  plan.setConditions(on);
  for (let i = 0; i < K.haiku.framesPerHour; i++) {
    const job = accepted(plan.enqueue('frame'));
    assert.equal(plan.next()!.id, job.id);
    plan.finish(job);
    clock.now += 60 * S;
  }
  assert.equal(plan.stats.framesLastHour, 30);
  assert.deepEqual(plan.enqueue('frame'), { accepted: false, reason: 'frame-budget' });
  clock.now += 31 * MIN;
  assert.ok(plan.enqueue('frame').accepted, 'the earliest ones are more than an hour old now');
});

test('waiting frames count against the hourly budget too', () => {
  const { plan } = planner({ framesPerHour: 2, queuedFrames: 5 });
  plan.setConditions(on);
  accepted(plan.enqueue('frame'));
  accepted(plan.enqueue('frame'));
  assert.deepEqual(plan.enqueue('frame'), { accepted: false, reason: 'frame-budget' });
});

test('too many frames waiting: the new one is skipped', () => {
  const { plan } = planner();
  plan.setConditions(on);
  for (let i = 0; i < K.haiku.queuedFrames; i++) accepted(plan.enqueue('frame'));
  assert.deepEqual(plan.enqueue('frame'), { accepted: false, reason: 'queue-full' });
});

test('a summary at most once per five minutes, and never two at once', () => {
  const { clock, plan } = planner();
  plan.setConditions(on);
  const job = accepted(plan.enqueue('summary'));
  assert.deepEqual(plan.enqueue('summary'), { accepted: false, reason: 'already-queued' });
  plan.next();
  plan.finish(job);
  clock.now += 4 * MIN;
  assert.deepEqual(plan.enqueue('summary'), { accepted: false, reason: 'summary-gap' });
  clock.now += 2 * MIN;
  assert.ok(plan.enqueue('summary').accepted);
});

test('watch off cancels the waiting and running jobs; their results are no longer current', () => {
  const { plan } = planner();
  plan.setConditions(on);
  accepted(plan.enqueue('frame'));
  accepted(plan.enqueue('summary'));
  const running = plan.next()!;
  const cancelled = plan.setConditions({ watch: false, screen: true });
  assert.equal(cancelled.length, 2);
  assert.equal(plan.next(), null);
  assert.equal(plan.isCurrent(running), false);
  plan.setConditions(on);
  const fresh = accepted(plan.enqueue('frame'));
  plan.next();
  assert.equal(plan.isCurrent(fresh), true);
  assert.equal(plan.isCurrent(running), false, 'an old job stays stale after watch comes back');
});

test('screen off and a refusal cancel everything too', () => {
  const { plan } = planner();
  plan.setConditions(on);
  accepted(plan.enqueue('frame'));
  assert.equal(plan.setConditions({ watch: true, screen: false }).length, 1);
  plan.setConditions(on);
  accepted(plan.enqueue('look'));
  const running = plan.next()!;
  assert.equal(plan.cancelAll().length, 1);
  assert.equal(plan.isCurrent(running), false);
  assert.equal(plan.next(), null);
});

test('switching something on does not cancel anything', () => {
  const { plan } = planner();
  plan.setConditions({ watch: false, screen: true });
  assert.deepEqual(plan.setConditions(on), []);
});

// ---- frame change ----
const thumb = (value: number, size = 32 * 18) => new Uint8Array(size).fill(value);
function withChanged(base: Uint8Array, count: number, value: number): Uint8Array {
  const copy = Uint8Array.from(base);
  for (let i = 0; i < count; i++) copy[i] = value;
  return copy;
}

test('changedShare counts the points that moved more than the delta', () => {
  assert.equal(changedShare(thumb(100), thumb(100), 40), 0);
  assert.equal(changedShare(thumb(100), thumb(120), 40), 0, 'a small brightness wobble is not a change');
  assert.equal(changedShare(thumb(100), thumb(200), 40), 1);
  assert.equal(changedShare(thumb(100, 10), thumb(100, 20), 40), 1, 'a different size counts as changed');
});

test('the first frame is described, a near copy is not, a scene change is', () => {
  const gate = new FrameGate();
  const scene = thumb(90);
  assert.equal(gate.check(scene, T0).describe, true);
  gate.commit(scene, T0);
  assert.deepEqual(gate.check(withChanged(scene, 20, 255), T0 + 30 * S), { describe: false, reason: 'small-change', share: 20 / 576 });
  assert.equal(gate.check(withChanged(scene, 300, 250), T0 + 30 * S).describe, true);
});

test('the same frame is never described twice, even after a different one in between', () => {
  const gate = new FrameGate();
  const a = thumb(20), b = thumb(200);
  gate.commit(a, T0);
  gate.commit(b, T0 + 30 * S);
  const verdict = gate.check(a, T0 + 60 * S);
  assert.equal(verdict.describe, false);
  assert.equal(!verdict.describe && verdict.reason, 'same-as-before');
});

test('a big change right after a description waits for the minimum gap', () => {
  const gate = new FrameGate();
  gate.commit(thumb(20), T0);
  const quick = gate.check(thumb(220), T0 + 2 * S);
  assert.equal(!quick.describe && quick.reason, 'too-soon');
  assert.equal(gate.check(thumb(220), T0 + (K.frame.minGapSeconds + 1) * S).describe, true);
});

test('a slow fade adds up against the last described frame', () => {
  const gate = new FrameGate();
  gate.commit(thumb(200), T0);
  assert.equal(gate.check(thumb(180), T0 + 20 * S).describe, false);
  assert.equal(gate.check(thumb(120), T0 + 40 * S).describe, true);
});

test('an empty thumbnail is refused and a reset makes the next frame a first frame', () => {
  const gate = new FrameGate();
  const verdict = gate.check(new Uint8Array(0), T0);
  assert.equal(!verdict.describe && verdict.reason, 'invalid');
  gate.commit(thumb(50), T0);
  gate.reset();
  assert.equal(gate.check(thumb(50), T0 + S).describe, true);
});
