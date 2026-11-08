import test from 'node:test';
import assert from 'node:assert/strict';
import { CryingTimeline, type CryingSnapshot, type CryingTimelineInput } from '../src/stage/crying-timeline';
import { DEFAULT_MOOD_PARAMETERS, applyMoodEvent, createMoodState, getMoodSnapshot } from '../shared/mood';

const AT = 1_800_000_000_000;
const snapshot = (overrides: Partial<CryingSnapshot> = {}): CryingSnapshot => ({
  reunion: { id: 'return', at: AT, longing: 90, crying: true }, cryingCandidate: true,
  lastInteractionAt: AT, event: null, ...overrides,
});
const input = (nowMs = AT, overrides: Partial<CryingTimelineInput> = {}): CryingTimelineInput => ({
  token: 'character/provider', characterId: 'character', nowMs, snapshot: snapshot(), durationMs: 8_000, reunionMs: 12_000,
  expressionIntensity: 50, allowed: true, visible: true, supported: true, faceBlocked: false, ...overrides,
});

test('a real accepted reunion uses the existing candidate without changing the host state or parameters', () => {
  const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
  const old = createMoodState(AT - 80 * 60 * 60 * 1_000, parameters);
  old.lastInteractionAt = old.updatedAt;
  const accepted = applyMoodEvent(old, { type: 'chat', id: 'return' }, AT, parameters);
  const host = getMoodSnapshot(accepted, AT, parameters);
  assert.equal(host.cryingCandidate, true);
  const before = structuredClone({ accepted, host, parameters });
  const layer = new CryingTimeline();
  assert.equal(layer.update(input(AT, { snapshot: host })).id, 'return');
  const visible = layer.update(input(AT + 1_000, { snapshot: host }));
  assert.equal(visible.phase, 'hold');
  assert.equal(visible.amount, 1);
  assert.deepEqual({ accepted, host, parameters }, before);
});

test('rise, hold and fade fit the frozen eight-second cue and repeating snapshots never restart it', () => {
  const layer = new CryingTimeline();
  assert.deepEqual(layer.update(input()).phase, 'rise');
  const rising = layer.update(input(AT + 300));
  assert.ok(rising.amount > 0 && rising.amount < 1);
  assert.equal(layer.update(input(AT + 1_000)).amount, 1);
  const fading = layer.update(input(AT + 7_000));
  assert.equal(fading.phase, 'fade');
  assert.ok(fading.amount > 0 && fading.amount < 1);
  assert.equal(layer.update(input(AT + 8_000)).phase, 'idle');
  assert.equal(layer.update(input(AT + 8_010)).amount, 0);
  assert.equal(layer.update(input(AT)).id, null, 'a clock rollback cannot replay the completed cue');
});

test('a local frame clock finishes even if the host snapshot and wall clock stop advancing', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  let frame = layer.update(input(), 0.1);
  for (let n = 0; n < 90; n++) frame = layer.update(input(), 0.1);
  assert.equal(frame.phase, 'idle');
  assert.equal(layer.update(input()).id, null);
});

test('clock rollback, negative dt and non-finite dt cannot reverse or poison a running cue', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  const first = layer.update(input(AT + 1_000));
  for (const bad of [-2, NaN, -Infinity, Infinity]) {
    const frame = layer.update(input(AT - 10), bad);
    assert.equal(frame.elapsedMs, first.elapsedMs);
    assert.ok(Number.isFinite(frame.amount));
  }
  assert.equal(layer.update(input(AT - 10), 0.5).elapsedMs, 1_500);
  assert.equal(layer.update(input(AT + 999_999)).phase, 'idle', 'a long pause expires rather than replays');
});

for (const blocked of ['allowed', 'visible', 'supported', 'faceBlocked'] as const) {
  test(`${blocked} cancellation consumes a pending or running cue and unblocking never replays it`, () => {
    const disabledValue = blocked === 'faceBlocked';
    const pending = new CryingTimeline();
    assert.equal(pending.update(input(AT, { [blocked]: disabledValue })).id, null);
    assert.equal(pending.update(input(AT + 100)).id, null);
    const running = new CryingTimeline();
    running.update(input());
    assert.ok(running.update(input(AT + 1_000)).amount > 0);
    assert.equal(running.update(input(AT + 1_100, { [blocked]: disabledValue })).amount, 0);
    assert.equal(running.update(input(AT + 1_200)).id, null);
  });
}

test('explicit cancel keeps consumed identities across stale snapshots and token round trips', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  layer.cancel();
  assert.equal(layer.update(input(AT + 100)).id, null);
  assert.equal(layer.update(input(AT + 200, { token: 'other/provider' })).id, null);
  assert.equal(layer.update(input(AT + 300)).id, null);
  const next = snapshot({ reunion: { id: 'next', at: AT + 400, longing: 90, crying: true }, lastInteractionAt: AT + 400 });
  assert.equal(layer.update(input(AT + 400, { snapshot: next })).id, 'next');
});

test('initial admission rejects old, future, invalid and no-longer-candidate snapshots permanently', () => {
  assert.equal(new CryingTimeline().update(input(AT + 1_500)).id, 'return');
  for (const value of [
    input(AT + 1_501), input(AT - 1), input(NaN), input(Infinity),
    input(AT, { snapshot: snapshot({ cryingCandidate: false }) }),
    input(AT, { snapshot: snapshot({ reunion: { id: 'return', at: NaN, longing: 90, crying: true } }) }),
    input(AT, { durationMs: NaN }), input(AT, { durationMs: 999 }), input(AT, { durationMs: 120_001 }),
    input(AT, { reunionMs: NaN }), input(AT, { reunionMs: -1 }), input(AT, { reunionMs: 120_001 }), input(AT, { reunionMs: 0 }),
    input(AT, { expressionIntensity: 0 }), input(AT, { expressionIntensity: NaN }), input(AT, { token: '' }),
  ]) {
    const layer = new CryingTimeline();
    assert.equal(layer.update(value).amount, 0);
    // Invalid/no identity inputs have nothing to consume; valid rejected cues do.
    if (Number.isFinite(value.nowMs) && value.token && value.snapshot?.reunion?.at === AT) {
      assert.equal(layer.update(input(AT + 100)).id, null);
    }
  }
});

test('a later valid response shortens the cue with a continuous fade; the trigger event does not soothe itself', () => {
  const layer = new CryingTimeline();
  const trigger = snapshot({ event: { id: 'return', at: AT, ageMs: 0, context: 'support', delta: { D: 0, O: 0, E: 0, N: 0, C: 0 } } });
  layer.update(input(AT, { snapshot: trigger }));
  const held = layer.update(input(AT + 2_000, { snapshot: trigger }));
  assert.equal(held.amount, 1);
  assert.equal(held.comforted, false);
  const response = snapshot({ lastInteractionAt: AT + 2_001 });
  const startFade = layer.update(input(AT + 2_001, { snapshot: response }));
  assert.equal(startFade.amount, held.amount);
  assert.equal(startFade.comforted, true);
  const noReunion = snapshot({ reunion: null, cryingCandidate: false, lastInteractionAt: AT + 2_001 });
  const midway = layer.update(input(AT + 2_601, { snapshot: noReunion }));
  assert.ok(midway.amount > 0 && midway.amount < startFade.amount);
  assert.equal(midway.phase, 'fade');
  assert.equal(layer.update(input(AT + 3_201, { snapshot: null })).phase, 'idle');
  assert.equal(layer.update(input(AT + 3_210)).id, null);
});

test('continuous effective interaction leaves a perceptible initial rise before a bounded calming fade', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  const responded = snapshot({ lastInteractionAt: AT + 20 });
  assert.ok(layer.update(input(AT + 20, { snapshot: responded })).amount > 0);
  const peak = layer.update(input(AT + 800, { snapshot: responded }));
  assert.equal(peak.phase, 'fade');
  assert.equal(peak.amount, 1);
  assert.equal(layer.update(input(AT + 2_000, { snapshot: responded })).phase, 'idle');
});

test('an explicit distinct support event can calm without rewriting the accepted interaction timestamp', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  const support = snapshot({ event: { id: 'comfort', at: AT + 1_000, ageMs: 0, context: 'support', delta: { D: 0, O: 0, E: 0, N: 0, C: -2 } } });
  const frame = layer.update(input(AT + 1_000, { snapshot: support }));
  assert.equal(frame.comforted, true);
  assert.equal(frame.phase, 'fade');
  assert.equal(layer.update(input(AT + 2_200, { snapshot: support })).amount, 0);
});

test('a cleared reunion begins a natural fade instead of removing visible tears in one frame', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  const peak = layer.update(input(AT + 2_000));
  const cleared = layer.update(input(AT + 2_010, { snapshot: null }));
  assert.equal(cleared.amount, peak.amount);
  assert.equal(cleared.phase, 'fade');
  assert.ok(layer.update(input(AT + 2_610, { snapshot: null })).amount > 0);
  assert.equal(layer.update(input(AT + 3_210, { snapshot: null })).phase, 'idle');
});

test('duration and positive intensity are frozen for an accepted cue and remain bounded at extreme supported settings', () => {
  for (const durationMs of [1_000, 8_000, 120_000]) {
    const layer = new CryingTimeline();
    layer.update(input(AT, { durationMs, reunionMs: 120_000, expressionIntensity: 100 }));
    const middle = layer.update(input(AT + durationMs / 2, { durationMs: 120_000, reunionMs: 120_000, expressionIntensity: 1 }));
    assert.equal(middle.durationMs, durationMs);
    assert.ok(middle.amount >= 0 && middle.amount <= 1);
    assert.equal(layer.update(input(AT + durationMs, { durationMs: 120_000, reunionMs: 120_000 })).phase, 'idle');
  }
});

test('token invalidation followed by an empty snapshot cannot give an old reunion a new identity', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  assert.ok(layer.update(input(AT + 800)).amount > 0);
  assert.equal(layer.update(input(AT + 810, { token: 'new-token', snapshot: null })).amount, 0);
  assert.equal(layer.update(input(AT + 820, { token: 'new-token' })).id, null);
  assert.equal(layer.update(input(AT + 830, { token: 'another-model-token', snapshot: null })).id, null);
  assert.equal(layer.update(input(AT + 840, { token: 'another-model-token' })).id, null);
});

test('changing a timestamp does not mint a second presentation for the same accepted event ID', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  const laterTimestamp = snapshot({ reunion: { id: 'return', at: AT + 1_000, longing: 90, crying: true } });
  const continued = layer.update(input(AT + 1_000, { snapshot: laterTimestamp }));
  assert.equal(continued.elapsedMs, 1_000, 'the initial cue keeps its frozen start');
  assert.equal(continued.phase, 'hold');
  assert.equal(layer.update(input(AT + 8_000, { snapshot: laterTimestamp })).id, null, 'a corrected timestamp cannot extend the original deadline');
  const freshLookingCopy = snapshot({ reunion: { id: 'return', at: AT + 8_100, longing: 90, crying: true } });
  assert.equal(layer.update(input(AT + 8_100, { snapshot: freshLookingCopy })).id, null);
  layer.update(input(AT + 8_200, { token: 'new-token', snapshot: null }));
  assert.equal(layer.update(input(AT + 8_300, { token: 'new-token', snapshot: freshLookingCopy })).id, null);
});

test('character identity separates equal event IDs while round trips do not replay consumed cues', () => {
  const layer = new CryingTimeline();
  layer.update(input());
  layer.update(input(AT + 100, { characterId: 'other-character', token: 'other-token', snapshot: null }));
  assert.equal(layer.update(input(AT + 200, { characterId: 'other-character', token: 'other-token' })).id, 'return',
    'an equal event ID in another character has its own identity');
  layer.update(input(AT + 300, { snapshot: null }));
  assert.equal(layer.update(input(AT + 400)).id, null, 'returning to the first character does not replay it');
  layer.update(input(AT + 500, { characterId: 'other-character', token: 'other-token', snapshot: null }));
  assert.equal(layer.update(input(AT + 600, { characterId: 'other-character', token: 'other-token' })).id, null);
});

test('the earlier reunion deadline is frozen, including short and zero configured reunion times', () => {
  for (const reunionMs of [100, 500, 2_000, 12_000]) {
    const layer = new CryingTimeline();
    const durationMs = Math.min(reunionMs, 8_000);
    assert.equal(layer.update(input(AT, { reunionMs })).durationMs, durationMs);
    const middle = layer.update(input(AT + durationMs / 2, { reunionMs: 120_000, durationMs: 120_000 }));
    assert.equal(middle.durationMs, durationMs);
    assert.ok(middle.amount > 0 && middle.amount <= 1);
    assert.equal(layer.update(input(AT + durationMs, { reunionMs: 120_000, durationMs: 120_000 })).id, null);
    assert.equal(layer.update(input(AT, { reunionMs: 120_000, durationMs: 120_000 })).id, null, 'rollback never reopens the frozen deadline');
  }
  const disabled = new CryingTimeline();
  assert.equal(disabled.update(input(AT, { reunionMs: 0 })).id, null);
  assert.equal(disabled.update(input(AT + 100)).id, null, 'enabling a longer reunion does not replay a rejected cue');
});

test('a future timestamp is consumed permanently, even when a later packet reaches that time', () => {
  const layer = new CryingTimeline();
  const future = snapshot({ reunion: { id: 'future', at: AT + 1_000, longing: 90, crying: true } });
  assert.equal(layer.update(input(AT, { snapshot: future })).id, null);
  assert.equal(layer.update(input(AT + 1_000, { snapshot: future })).id, null);
  assert.equal(layer.update(input(AT + 1_100, { token: 'rotated-token', snapshot: null })).id, null);
  assert.equal(layer.update(input(AT + 1_200, { token: 'rotated-token', snapshot: future })).id, null);
});

test('bounded identity retention does not allow a much older cue to replay after many later events', () => {
  const layer = new CryingTimeline();
  for (let n = 0; n < 200; n++) {
    const at = AT + n * 10_000;
    const host = snapshot({ reunion: { id: `return-${n}`, at, longing: 90, crying: true }, lastInteractionAt: at });
    assert.equal(layer.update(input(at, { snapshot: host })).id, `return-${n}`);
    layer.cancel();
  }
  assert.equal(layer.update(input(AT)).id, null);
});
