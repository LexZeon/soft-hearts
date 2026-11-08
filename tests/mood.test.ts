import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MOOD_PARAMETERS,
  MOOD_CHANNELS,
  advanceMood,
  applyMoodEvent,
  cancelMoodExpressions,
  createMoodState,
  getMoodSnapshot,
  getBlushAmount,
  restoreMoodState,
  serializeMoodState,
  validateMoodParameters,
  type MoodParameters,
  type MoodState,
} from "../shared/mood";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const params = (): MoodParameters => structuredClone(DEFAULT_MOOD_PARAMETERS);
const near = (actual: number, expected: number, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const quota = (value: number) => -50 * Math.log((100 - value) / 50);
const food = (state: MoodState, id: string, now = state.updatedAt, p = DEFAULT_MOOD_PARAMETERS) => applyMoodEvent(state, { type: "food", id }, now, p);

test("Gene starts quietly without inventing a past relationship", () => {
  const state = createMoodState(100);
  assert.deepEqual(state.values, { D: 50, O: 50, E: 50, N: 50, C: 50 });
  assert.equal(advanceMood(state, 100 * HOUR, { online: false }).longing, 0);
  assert.equal(getMoodSnapshot(state).primary, "calm");
  assert.equal(getMoodSnapshot(state).attentionCandidate, null);
});

test("recovery halves distance above and below even at an extreme character baseline", () => {
  const p = params();
  p.baseline.O = 95;
  p.baseline.C = 5;
  const state = createMoodState(0, p);
  state.values.O = 75;
  state.values.C = 25;
  state.values.D = 70;
  state.values.E = 30;
  near(advanceMood(state, p.halfLifeMs.O, { online: true }, p).values.O, 85);
  near(advanceMood(state, p.halfLifeMs.C, { online: true }, p).values.C, 15);
  near(advanceMood(state, p.halfLifeMs.D, { online: true }, p).values.D, 60);
  near(advanceMood(state, p.halfLifeMs.E, { online: true }, p).values.E, 40);
});

test("online B crosses the accepted baseline times and never adds offline boredom", () => {
  const state = createMoodState(0);
  near(advanceMood(state, 20 * MINUTE, { online: true }).boredom, 30);
  near(advanceMood(state, 32.5 * MINUTE, { online: true }).boredom, 55);
  near(advanceMood(state, 42.5 * MINUTE, { online: true }).boredom, 75);
  const offline = advanceMood(state, 100 * HOUR, { online: false });
  assert.equal(offline.boredom, 0);
  assert.equal(advanceMood(offline, 100 * HOUR + 5 * MINUTE, { online: true }).boredom, 0);
});

test("time partition and backwards clocks do not duplicate recovery or B", () => {
  const state = food(createMoodState(0), "meal");
  const one = advanceMood(state, 30 * MINUTE, { online: true });
  let many = state;
  for (let at = MINUTE; at <= 30 * MINUTE; at += MINUTE) many = advanceMood(many, at, { online: true });
  for (const channel of MOOD_CHANNELS) near(one.values[channel], many.values[channel]);
  near(one.boredom, many.boredom);
  const backwards = advanceMood(one, MINUTE, { online: true });
  assert.deepEqual(backwards, one);
});

test("M uses real elapsed time, preserves reunion once, and self attention is not a response", () => {
  let state = applyMoodEvent(createMoodState(0), { type: "chat", id: "first" }, 0);
  state = advanceMood(state, 68 * HOUR + 40 * MINUTE, { online: false });
  near(state.longing, 85);
  const waitingTime = state.lastInteractionAt;
  const self = applyMoodEvent(state, { type: "attention", id: "self", kind: "speech" }, state.updatedAt);
  assert.equal(self.lastInteractionAt, waitingTime);
  state = food(self, "reunion");
  assert.equal(state.longing, 0);
  assert.equal(state.reunion?.longing, 85);
  assert.equal(getMoodSnapshot(state).primary, "relieved");
  assert.equal(getMoodSnapshot(state).cryingCandidate, true);
  const repeat = applyMoodEvent(state, { type: "rua", id: "comfort", effectiveMs: 1_000 }, state.updatedAt + 1_000);
  assert.deepEqual(repeat.reunion, state.reunion);
  assert.equal(repeat.cue?.id, "reunion");
});

test("new user events, repeated deliveries, windows and phase callbacks cannot double reward", () => {
  const state = createMoodState(0);
  const accepted = food(state, "one");
  assert.deepEqual(food(accepted, "one"), accepted);
  const phase = applyMoodEvent(accepted, { type: "phase", id: "closed", phase: "idle" }, 0);
  assert.deepEqual(phase.values, accepted.values);
  assert.equal(phase.lastInteractionAt, accepted.lastInteractionAt);
  assert.deepEqual(state, createMoodState(0), "pure transitions never mutate the previous state");
});

test("partial rua doses and grouped doses produce the same gain and diminishing progress", () => {
  const whole = applyMoodEvent(createMoodState(0), { type: "rua", id: "whole", effectiveMs: 5_000 }, 0);
  let pieces = createMoodState(0);
  for (let i = 0; i < 10; i++) pieces = applyMoodEvent(pieces, { type: "rua", id: `part-${i}`, effectiveMs: 500 }, 0);
  near(whole.values.O, pieces.values.O);
  near(whole.values.E, pieces.values.E);
  near(quota(whole.values.O), 10);
  near(pieces.freshness.rua.doses, 1);
  assert.equal(pieces.cue?.id, "part-0", "continuous input does not replay a full confirmation every part");
});

test("same-source quota uses 100,60,36,21.6,20 percent and other sources do not reset it", () => {
  let state = createMoodState(0);
  for (let i = 0; i < 5; i++) state = food(state, `meal-${i}`);
  near(quota(state.values.D), 12 * (1 + 0.6 + 0.36 + 0.216 + 0.2));
  const before = state.freshness.food.doses;
  state = applyMoodEvent(state, { type: "phase", id: "end", phase: "idle" }, 0);
  state = applyMoodEvent(state, { type: "rua", id: "pet", effectiveMs: 5_000 }, 0);
  assert.equal(state.freshness.food.doses, before);
  near(quota(state.values.O), 10);
});

test("freshness recovers gradually after quiet and fully at its configured time", () => {
  let state = createMoodState(0);
  for (let i = 0; i < 5; i++) state = food(state, `meal-${i}`);
  const depth = state.freshness.food.doses;
  const half = advanceMood(state, 1_000 + 15 * MINUTE, { online: true });
  near(half.freshness.food.doses, depth / 2);
  const end = advanceMood(half, 1_000 + 30 * MINUTE, { online: true });
  assert.equal(end.freshness.food.doses, 0);
  assert.ok(half.freshness.food.doses > 0);
});

test("rua affects only O/E, zero activity and waiting food never count as user responses", () => {
  const p = params();
  p.sensitivity.D = 4;
  let state = createMoodState(0, p);
  state = applyMoodEvent(state, { type: "phase", id: "head", phase: "rua" }, 0, p);
  state = applyMoodEvent(state, { type: "rua", id: "static", effectiveMs: 0 }, 0, p);
  assert.equal(state.lastInteractionAt, null);
  assert.equal(state.values.O, 50);
  state = applyMoodEvent(state, { type: "rua", id: "move", effectiveMs: 5_000 }, 0, p);
  assert.equal(state.values.D, 50);
  assert.equal(state.values.N, 50);
  assert.equal(state.values.C, 50);
  let waiting = applyMoodEvent(createMoodState(0), { type: "phase", id: "wait", phase: "food-ready" }, 0);
  waiting = applyMoodEvent(waiting, { type: "rua", id: "over-head", effectiveMs: 5_000 }, 0);
  assert.equal(waiting.lastInteractionAt, null);
  assert.equal(waiting.values.O, 50);
});

test("B relief follows actual attention, does not use reward diminishing, and has no stored credit", () => {
  let state = advanceMood(createMoodState(0), 42.5 * MINUTE, { online: true });
  const now = state.updatedAt;
  state = applyMoodEvent(state, { type: "rua", id: "pet1", effectiveMs: 5_000 }, now);
  near(state.boredom, 55);
  state = applyMoodEvent(state, { type: "rua", id: "pet2", effectiveMs: 5_000 }, now);
  near(state.boredom, 35);
  for (let i = 3; i < 9; i++) state = applyMoodEvent(state, { type: "rua", id: `pet${i}`, effectiveMs: 5_000 }, now);
  assert.equal(state.boredom, 0);
  const later = advanceMood(state, now + 6 * MINUTE, { online: true });
  near(later.boredom, 2);
});

test("zero sensitivity preserves recovery and human confirmation; zero rates and quotas stay disabled", () => {
  const p = params();
  p.sensitivity = { D: 0, O: 0, E: 0, N: 0, C: 0 };
  p.boredom.graceMs = 0;
  p.boredom.perMinute = 0;
  p.longing.graceMs = 0;
  p.longing.perHour = 0;
  p.frequency.speechPerHour = 0;
  p.frequency.speechWithoutReply = 0;
  p.weights = { playful: 0, close: 0, comfortable: 0, cautious: 0 };
  const state = food(createMoodState(0, p), "snack", 0, p);
  assert.deepEqual(state.values, p.baseline);
  assert.equal(state.lastInteractionAt, 0);
  assert.equal(state.cue?.kind, "satisfied");
  const later = advanceMood(state, 100 * HOUR, { online: true }, p);
  assert.equal(later.boredom, 0);
  assert.equal(later.longing, 0);
  later.boredom = 100;
  assert.notEqual(getMoodSnapshot(later, later.updatedAt, p).attentionCandidate, "speech");
});

test("zero and one repeat retention/floor have defined finite behavior", () => {
  for (const [retention, floor, expected] of [[0, 0, 12], [0, 1, 36], [1, 0, 36], [1, 1, 36]]) {
    const p = params();
    p.freshness.retention = retention;
    p.freshness.floor = floor;
    let state = createMoodState(0, p);
    for (let i = 0; i < 3; i++) state = food(state, `${retention}-${floor}-${i}`, 0, p);
    near(quota(state.values.D), expected);
  }
});

test("trends contain accepted event changes, never natural recovery", () => {
  const state = food(createMoodState(0), "meal");
  assert.equal(getMoodSnapshot(state).fast.D, "up");
  const later = advanceMood(state, 20_000, { online: true });
  assert.deepEqual(getMoodSnapshot(later).trend, { D: 0, O: 0, E: 0, N: 0, C: 0 });
  assert.equal(getMoodSnapshot(later).fast.D, "steady");
});

test("appraisal only follows the latest accepted chat and never invents a second human response", () => {
  let state = applyMoodEvent(createMoodState(0), { type: "chat", id: "user" }, 0);
  const invalid = applyMoodEvent(state, { type: "appraisal", id: "bad", responseTo: "foreign", delta: { D: 10 } }, 1_000);
  assert.equal(invalid.values.D, 50);
  state = applyMoodEvent(state, { type: "appraisal", id: "meaning", responseTo: "user", delta: { O: 10, E: 4 }, context: "support", reason: "友好鼓励" }, 2_000);
  assert.equal(state.lastInteractionAt, 0);
  assert.equal(state.onlineIdleMs, 2_000);
  assert.ok(state.values.O > 50);
  assert.deepEqual(applyMoodEvent(state, { type: "appraisal", id: "meaning", responseTo: "user", delta: { O: 10 } }, 2_000), state);
  const regeneration = applyMoodEvent(state, { type: "appraisal", id: "regenerated-meaning", responseTo: "user", delta: { O: 10 } }, 2_000);
  assert.deepEqual(regeneration.values, state.values, "regeneration with a fresh transport id still cannot reappraise the same user turn");
  const second = applyMoodEvent(state, { type: "chat", id: "next" }, 3_000);
  const late = applyMoodEvent(second, { type: "appraisal", id: "old-meaning", responseTo: "user", delta: { C: 20 } }, 3_000);
  assert.equal(late.values.C, 50);
});

test("concern is addressed to the situation, old offense context expires, and pressure does not cancel expectation", () => {
  let state = applyMoodEvent(createMoodState(0), { type: "chat", id: "work", delta: { C: 20, N: 20 }, context: "concern", reason: "用户谈工作烦恼" }, 0);
  assert.equal(getMoodSnapshot(state).primary, "concerned");
  assert.notEqual(getMoodSnapshot(state).primary, "upset");
  state = applyMoodEvent(state, { type: "chat", id: "offense", context: "offense" }, 0);
  assert.equal(getMoodSnapshot(state).primary, "upset");
  assert.notEqual(getMoodSnapshot(advanceMood(state, 31_000, { online: true })).primary, "upset");
  state.values.D = 90;
  state = applyMoodEvent(state, { type: "chat", id: "hope", context: "positive" }, 0);
  assert.equal(getMoodSnapshot(state).primary, "tense-expectation");
});

test("active interaction blocks automatic attention and direct satisfaction ignores proactive cooldowns", () => {
  let state = advanceMood(createMoodState(0), HOUR, { online: true });
  assert.equal(getMoodSnapshot(state).attentionCandidate, "speech");
  state = applyMoodEvent(state, { type: "phase", id: "start", phase: "rua" }, state.updatedAt);
  assert.equal(getMoodSnapshot(state).attentionCandidate, null);
  state = applyMoodEvent(state, { type: "attention", id: "blocked", kind: "speech" }, state.updatedAt);
  assert.equal(state.lastSpeechAt, null);
  state.lastSpeechAt = state.updatedAt;
  state = applyMoodEvent(state, { type: "rua", id: "direct", effectiveMs: 500 }, state.updatedAt);
  assert.equal(state.cue?.kind, "satisfied");
});

test("look has a real cooldown and speech uses rolling-hour plus unanswered budgets across restart", () => {
  let state = advanceMood(createMoodState(0), 20 * MINUTE, { online: true });
  state = applyMoodEvent(state, { type: "attention", id: "look", kind: "look" }, state.updatedAt);
  state = advanceMood(state, state.updatedAt + 4_000, { online: true });
  assert.equal(getMoodSnapshot(state).attentionCandidate, null);
  state = advanceMood(state, HOUR, { online: true });
  state = applyMoodEvent(state, { type: "attention", id: "say", kind: "speech" }, state.updatedAt);
  assert.equal(state.unansweredSpeech, 1);
  state = restoreMoodState(serializeMoodState(state), HOUR + 30 * MINUTE);
  state = advanceMood(state, HOUR + 80 * MINUTE, { online: true });
  assert.notEqual(getMoodSnapshot(state).attentionCandidate, "speech", "I-039: an unanswered line waits 3 x the interval (90 min), no longer forever");
  assert.equal(getMoodSnapshot(advanceMood(state, HOUR + 95 * MINUTE, { online: true })).attentionCandidate, "speech");
  assert.equal(state.unansweredSpeech, 1);
  state = applyMoodEvent(state, { type: "chat", id: "answer" }, state.updatedAt);
  assert.equal(state.unansweredSpeech, 0);
});

test("persistent state never replays runtime gestures, reunion or old trends; dedup survives", () => {
  let state = applyMoodEvent(createMoodState(0), { type: "chat", id: "first" }, 0);
  state = advanceMood(state, 70 * HOUR, { online: false });
  state = food(state, "reunion");
  const saved = serializeMoodState(state);
  assert.equal(saved.phase, "idle");
  assert.equal(saved.reunion, null);
  assert.equal(saved.cue, null);
  assert.equal(saved.trend.length, 0);
  const restored = restoreMoodState(JSON.parse(JSON.stringify(saved)), state.updatedAt + 1_000);
  assert.equal(restored.phase, "idle");
  assert.equal(restored.reunion, null);
  assert.equal(restored.boredom, 0);
  const replay = food(restored, "reunion");
  assert.deepEqual(replay.values, restored.values);
  assert.equal(replay.lastInteractionAt, restored.lastInteractionAt);
  assert.equal(replay.cue, null);
});

test("parameter validation rejects unknown fields, nonfinite values, bad order and invalid units", () => {
  assert.deepEqual(validateMoodParameters(params()), DEFAULT_MOOD_PARAMETERS);
  const p = params();
  p.boredom.lookAt = 90;
  assert.throws(() => validateMoodParameters(p), /order/);
  assert.throws(() => validateMoodParameters({ ...params(), shell: "cmd" }), /Unknown/);
  const bad = params();
  bad.halfLifeMs.D = 0;
  assert.throws(() => validateMoodParameters(bad), /range/);
  bad.halfLifeMs.D = Infinity;
  assert.throws(() => validateMoodParameters(bad), /Invalid/);
  assert.throws(() => validateMoodParameters({ sensitivity: { D: 1 } }), /missing/);
});

test("malformed events and persisted arithmetic are rejected rather than poisoning values", () => {
  const state = createMoodState(0);
  assert.throws(() => applyMoodEvent(state, { type: "rua", id: "bad", effectiveMs: Infinity }, 0), /duration/);
  assert.throws(() => applyMoodEvent(state, { type: "chat", id: "bad", delta: { C: 21 } }, 0), /±20/);
  assert.throws(() => applyMoodEvent(state, { type: "chat", id: "bad", delta: { C: NaN } }, 0), /finite/);
  assert.throws(() => createMoodState(NaN), /time/);
  const saved = serializeMoodState(state);
  saved.values.D = NaN;
  assert.throws(() => restoreMoodState(saved, 1), /persisted/);
  assert.throws(() => restoreMoodState({ version: 100 }, 1), /version/);
});

test("dedup, semantic sources and trend samples have bounded memory", () => {
  let state = createMoodState(0);
  for (let i = 0; i < 500; i++) state = applyMoodEvent(state, { type: "chat", id: `chat-${i}`, topic: `topic-${i}`, delta: { O: 0.01 } }, 0);
  assert.equal(state.recentEventIds.length, 256);
  assert.equal(state.recentChatIds.length, 64);
  assert.equal(state.appraisedChatIds.length, 64);
  assert.equal(state.trend.length, 128);
  assert.equal(Object.keys(state.freshness).length, 32);
  assert.ok(MOOD_CHANNELS.every(c => Number.isFinite(state.values[c]) && state.values[c] >= 0 && state.values[c] <= 100));
});

test("legacy complete parameters normalize only the new blush group and keep strict shapes", () => {
  const legacy = structuredClone(DEFAULT_MOOD_PARAMETERS) as unknown as Record<string, unknown>;
  delete legacy.blush;
  assert.deepEqual(validateMoodParameters(legacy), DEFAULT_MOOD_PARAMETERS);
  assert.equal(Object.hasOwn(legacy, "blush"), false, "migration does not mutate an imported template");
  const previousBlush = structuredClone(DEFAULT_MOOD_PARAMETERS) as unknown as Record<string, unknown>;
  delete (previousBlush.blush as Record<string, unknown>).size;
  assert.equal(validateMoodParameters(previousBlush).blush.size, 50);
  assert.equal(Object.hasOwn(previousBlush.blush as object, "size"), false);
  const missing = { ...legacy }; delete missing.boredom;
  assert.throws(() => validateMoodParameters(missing), /missing/);
  assert.throws(() => validateMoodParameters({ ...legacy, arbitrary: 1 }), /Unknown/);
  assert.throws(() => validateMoodParameters({ ...params(), blush: {} }), /missing/);
  assert.throws(() => validateMoodParameters({ ...params(), blush: { ...params().blush, enabled: "true" } }), /Invalid/);
  assert.throws(() => validateMoodParameters({ ...params(), blush: { ...params().blush, extra: 1 } }), /Unknown/);
  const invalid = params(); invalid.blush.fadeMs = 0;
  assert.throws(() => validateMoodParameters(invalid), /range/);
  for (const size of [-1, 101, NaN]) {
    const invalidSize = params(); invalidSize.blush.size = size;
    assert.throws(() => validateMoodParameters(invalidSize), /range|Invalid/);
  }
});

test("semantic closeness creates one causal blush envelope without an extra reward", () => {
  const state = applyMoodEvent(createMoodState(0), { type: "chat", id: "praise", context: "support", delta: { O: 10, E: 4 }, reason: "用户表达感谢与亲近" }, 0);
  const disabled = params(); disabled.blush.enabled = false;
  const sameValues = applyMoodEvent(createMoodState(0, disabled), { type: "chat", id: "praise", context: "support", delta: { O: 10, E: 4 }, reason: "用户表达感谢与亲近" }, 0, disabled);
  assert.deepEqual(state.values, sameValues.values);
  assert.equal(state.lastInteractionAt, sameValues.lastInteractionAt);
  assert.equal(state.blushCue?.id, "praise");
  assert.equal(state.blushCue?.reason, "semantic");
  near(getMoodSnapshot(state, 0).blush!.amount, 0);
  near(getMoodSnapshot(state, 450).blush!.amount, 0.35);
  near(getMoodSnapshot(state, 2550).blush!.amount, 0.175);
  assert.equal(getMoodSnapshot(state, 3600).blush, null);
  assert.deepEqual(applyMoodEvent(state, { type: "chat", id: "praise", context: "support", delta: { O: 10 } }, 0), state);
});

test("O being high, ordinary food and a small rua sample never imply blushing", () => {
  const high = createMoodState(0); high.values.O = 99;
  assert.equal(getMoodSnapshot(high).blush, null);
  assert.equal(advanceMood(high, 1000, { online: true }).blushCue, null);
  assert.equal(food(createMoodState(0), "meal").blushCue, null);
  const reward = applyMoodEvent(createMoodState(0), { type: "chat", id: "achievement", context: "positive", delta: { D: 12, E: 6 } }, 0);
  assert.equal(reward.blushCue, null);
  const short = applyMoodEvent(createMoodState(0), { type: "rua", id: "short", effectiveMs: 500 }, 0);
  assert.equal(short.blushCue, null);
  const neutral = applyMoodEvent(createMoodState(0), { type: "chat", id: "neutral", delta: { O: 10 }, context: "neutral" }, 0);
  assert.equal(neutral.blushCue, null);
});

test("only a fresh actual closeness rise crossing the event threshold can blush during rua", () => {
  let state = createMoodState(0), observed = "";
  for (let i = 0; i < 10; i++) {
    state = applyMoodEvent(state, { type: "rua", id: `real-${i}`, effectiveMs: 500 }, i * 200);
    if (state.blushCue) {
      observed ||= state.blushCue.id;
      assert.equal(state.blushCue.id, observed, "continued input cannot renew the expression");
    }
  }
  assert.ok(observed);
  assert.equal(state.blushCue?.reason, "closeness");
  const saturated = createMoodState(0); saturated.values.O = 99.9;
  assert.equal(applyMoodEvent(saturated, { type: "rua", id: "saturated", effectiveMs: 5000 }, 0).blushCue, null);
});

test("blush disabled or intensity zero closes only the optional expression", () => {
  for (const mode of ["enabled", "intensity"] as const) {
    const p = params(); if (mode === "enabled") p.blush.enabled = false; else p.blush.intensity = 0;
    const state = applyMoodEvent(createMoodState(0, p), { type: "chat", id: mode, context: "support", delta: { O: 10 } }, 0, p);
    assert.ok(state.values.O > 50); assert.equal(state.lastInteractionAt, 0);
    assert.equal(state.blushCue, null); assert.equal(getMoodSnapshot(state, 500, p).blush, null);
  }
});

test("blush cancellation and restart retain the cooldown without replaying the event", () => {
  const original = applyMoodEvent(createMoodState(0), { type: "chat", id: "once", context: "support", delta: { O: 10 } }, 0);
  const cancelled = cancelMoodExpressions(original);
  assert.equal(cancelled.blushCue, null); assert.equal(cancelled.cue, null);
  assert.deepEqual(cancelled.values, original.values); assert.equal(cancelled.lastInteractionAt, original.lastInteractionAt);
  assert.equal(cancelled.lastBlushAt, 0);
  const restored = restoreMoodState(serializeMoodState(original), 1000);
  assert.equal(restored.blushCue, null); assert.equal(restored.lastBlushAt, 0);
  const early = applyMoodEvent(restored, { type: "chat", id: "early", context: "support", delta: { O: 10 } }, 2000);
  assert.equal(early.blushCue, null);
  const later = applyMoodEvent(early, { type: "chat", id: "later", context: "support", delta: { O: 10 } }, 61_000);
  assert.equal(later.blushCue?.id, "later");
  const legacy = serializeMoodState(createMoodState(0)) as unknown as Record<string, unknown>;
  delete legacy.lastBlushAt; delete legacy.blushCue;
  assert.equal(restoreMoodState(legacy, 1000).lastBlushAt, null);
  legacy.lastBlushAt = NaN;
  assert.throws(() => restoreMoodState(legacy, 1000), /persisted/);
});

test("snapshot carries signed accepted-event evidence, while natural recovery has no new event", () => {
  const before = createMoodState(0); before.values.D = 70;
  const state = applyMoodEvent(before, { type: "chat", id: "setback", delta: { D: -10 }, context: "disappointment" }, 0);
  const snapshot = getMoodSnapshot(state, 500);
  assert.equal(snapshot.context, "disappointment"); assert.equal(snapshot.event?.id, "setback");
  assert.equal(snapshot.event?.ageMs, 500); assert.ok(snapshot.event!.delta.D < 0);
  assert.equal(snapshot.fast.D, "down");
  const settled = getMoodSnapshot(advanceMood(state, 12_000, { online: true }));
  assert.equal(settled.event, null); assert.equal(settled.fast.D, "steady");
  assert.equal(settled.trend.D, 0);
});

test("comfortable companion does not turn an explicit concern into a playful primary", () => {
  const state = createMoodState(0); state.values.E = 90; state.values.D = 90;
  const concern = applyMoodEvent(state, { type: "chat", id: "concern", context: "concern", delta: { C: 10, N: 10 } }, 0);
  const snapshot = getMoodSnapshot(concern);
  assert.equal(snapshot.primary, "concerned"); assert.equal(snapshot.companion, "comfortable");
  assert.equal(snapshot.tendencies.playful, 0);
  assert.equal(getBlushAmount(NaN, 1, params().blush), 0);
  assert.equal(getBlushAmount(200, 1, { ...params().blush, fadeMs: 0 }), 0);
});
