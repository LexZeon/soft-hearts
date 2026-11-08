import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorMotionController, type BehaviorBindingSource } from '../electron/behavior-motion';
import { MoodHost } from '../electron/mood';
import { createMoodState, getMoodSnapshot, type MoodSnapshot } from '../shared/mood';
import type { BehaviorMotionCue, BehaviorMotionPlan } from '../shared/behavior-motion';

function snapshot(cue = true): MoodSnapshot {
  const value = getMoodSnapshot(createMoodState(1_000), 1_000);
  value.primary = 'content'; value.context = 'neutral'; value.phase = 'idle'; value.companion = null;
  value.intensity.expression = 50;
  value.cue = cue ? { id: 'accepted-one', kind: 'satisfied', at: 1_000, until: 5_000 } : null;
  return value;
}
function controller(clock: () => number, mapping?: BehaviorBindingSource) {
  let ids = 0; return new BehaviorMotionController(clock, () => `cue-${++ids}`, mapping);
}
function identity(cue: BehaviorMotionCue | null) {
  if (!cue) return null;
  const { bindingId: _binding, strength: _strength, ...remaining } = cue;
  return remaining;
}

test('absent or undefined optional mapping preserves original cue identities and consumed behavior', () => {
  let now = 1_000;
  const plain = controller(() => now), optional = controller(() => now, () => undefined);
  const view = snapshot();
  const first = plain.update(view, 'scope', true);
  assert.equal(first.state?.bindingId, 'face.smile'); assert.equal(first.reaction?.semantic, 'cue.satisfied');
  assert.deepEqual(optional.update(view, 'scope', true), first);
  now = 1_100; view.intensity.expression = 20;
  assert.deepEqual(optional.update(view, 'scope', true), plain.update(view, 'scope', true));
  plain.cancelReaction('accepted-one'); optional.cancelReaction('accepted-one');
  assert.deepEqual(optional.update(view, 'scope', true), plain.update(view, 'scope', true));
  assert.equal(optional.update(view, 'scope', true).reaction, null);
});

test('valid semantic mapping changes only binding and bounded strength, never timing or cue identity', () => {
  let now = 1_000;
  const calls: unknown[] = [];
  let cap = 0.1;
  const mapped = controller(() => now, (semantic, binding, strength) => {
    calls.push({ semantic, binding, strength }); return { bindingId: 'face.compassion', strength: cap };
  });
  const plain = controller(() => now), view = snapshot();
  const before = plain.update(view, 'scope', true), after = mapped.update(view, 'scope', true);
  assert.equal(after.state?.bindingId, 'face.compassion'); assert.equal(after.reaction?.bindingId, 'face.compassion');
  assert.equal(after.state?.strength, 0.1); assert.equal(after.reaction?.strength, 0.1);
  assert.deepEqual(identity(after.state), identity(before.state));
  assert.deepEqual(identity(after.reaction), identity(before.reaction));
  assert.deepEqual(calls.map(value => (value as { semantic: string }).semantic), ['mood.content', 'cue.satisfied']);
  now = 1_050; cap = 0.7; view.intensity.expression = 10;
  const lowOriginal = plain.update(view, 'scope', true), limited = mapped.update(view, 'scope', true);
  assert.equal(limited.state?.strength, lowOriginal.state?.strength);
  assert.equal(limited.reaction?.strength, lowOriginal.reaction?.strength);
  assert.deepEqual(identity(limited.state), identity(after.state));
  assert.deepEqual(identity(limited.reaction), identity(after.reaction));
});

test('illegal pair, invalid strength or throwing mapping falls back to accepted selector; calm has no invented binding', () => {
  const invalid: unknown[] = [
    { bindingId: 'face.convinced', strength: 0.2 }, // not valid for mood.content
    { bindingId: '../foreign.vmd', strength: 0.2 },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.71].map(strength => ({ bindingId: 'face.compassion', strength })),
  ];
  const view = snapshot(false), expected = controller(() => 1_000).update(view, 'scope', true);
  for (const value of invalid) {
    const c = controller(() => 1_000, () => value as ReturnType<BehaviorBindingSource>);
    assert.deepEqual(c.update(view, 'scope', true), expected);
  }
  assert.deepEqual(controller(() => 1_000, () => { throw Error('optional failure'); }).update(view, 'scope', true), expected);
  let calls = 0; const calm = snapshot(false); calm.primary = 'calm';
  const result = controller(() => 1_000, () => { calls++; return { bindingId: 'face.smile', strength: 0.2 }; }).update(calm, 'scope', true);
  assert.deepEqual(result, { state: null, reaction: null }); assert.equal(calls, 0);
});

test('saving a mapping and cancelling presentation cannot replay old state or consumed reaction; new semantics still work', () => {
  let now = 1_000, custom = false;
  const c = controller(() => now, () => custom ? { bindingId: 'face.compassion', strength: 0.1 } : undefined);
  const view = snapshot(), first = c.update(view, 'scope', true);
  assert.ok(first.state); assert.ok(first.reaction);
  custom = true; c.cancelPresentation();
  now = 1_050;
  assert.deepEqual(c.update(view, 'scope', true), { state: null, reaction: null });
  now = 1_100; view.primary = 'happy';
  const nextState = c.update(view, 'scope', true);
  assert.equal(nextState.state?.semantic, 'mood.happy'); assert.equal(nextState.state?.bindingId, 'face.compassion');
  assert.notEqual(nextState.state?.id, first.state?.id); assert.equal(nextState.reaction, null);
  view.cue = { id: 'accepted-two', kind: 'satisfied', at: now, until: 4_000 };
  const nextReaction = c.update(view, 'scope', true).reaction;
  assert.ok(nextReaction); assert.notEqual(nextReaction.id, first.reaction?.id);
  assert.equal(nextReaction.at, 1_100); assert.equal(nextReaction.expiresAt, 4_000);
  assert.equal(nextReaction.stateKey, 'reaction:accepted-two:1100');
  c.cancelPresentation(); assert.equal(c.update(view, 'scope', true).reaction, null);
  now = 4_001; assert.equal(c.update(view, 'scope', true).reaction, null);
});

test('actual MoodHost visualBehaviorChanged cancels and publishes only the current card without an event or storage path', () => {
  const view = snapshot(), behavior = controller(() => 1_000);
  assert.ok(behavior.update(view, 'scope', true).reaction);
  const outputs: BehaviorMotionPlan[] = []; let refreshes = 0;
  const host = Object.assign(Object.create(MoodHost.prototype), {
    characterId: 'card-A', behavior, revision: 4,
    refresh: () => { refreshes++; return false; },
    view: () => behavior.update(view, 'scope', true),
    changed: (plan: BehaviorMotionPlan) => outputs.push(plan),
  });
  const allowed = new Set(['characterId', 'behavior', 'revision', 'refresh', 'view', 'changed', 'publish']);
  const bounded = new Proxy(host, {
    get(target, key, receiver) { assert.ok(typeof key === 'string' && allowed.has(key), `unexpected host path ${String(key)}`); return Reflect.get(target, key, receiver); },
    set(target, key, value, receiver) { assert.equal(key, 'revision'); return Reflect.set(target, key, value, receiver); },
  });
  MoodHost.prototype.visualBehaviorChanged.call(bounded, 'card-B');
  assert.equal(refreshes, 0); assert.equal(outputs.length, 0); assert.equal(host.revision, 4);
  MoodHost.prototype.visualBehaviorChanged.call(bounded, 'card-A');
  assert.equal(refreshes, 1); assert.equal(outputs.length, 1); assert.equal(host.revision, 5);
  assert.deepEqual(outputs[0], { state: null, reaction: null });
  assert.equal(behavior.update(view, 'scope', true).reaction, null);
});
