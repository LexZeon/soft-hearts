import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MoodHost } from '../electron/mood';
import { DEFAULT_MOOD_PARAMETERS, restoreMoodState } from '../shared/mood';
import type { MoodView } from '../shared/mood-runtime';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';

async function withHost(run: (context: {
  host: MoodHost; directory: string; clock: { now: number };
  input(value: Record<string, unknown>): MoodView;
  begin(sessionId: string): MoodView;
  release(sessionId: string, activeMs?: number): MoodView;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-cheek-host-'));
  const clock = { now: 1_000_000 };
  // The card's fixed pat amounts (#21's own effect is random by design and has its own tests): these check the credit arithmetic.
  const host = new MoodHost(directory, () => {}, () => clock.now, { touchFeedEffect: new FixedTouchFeedEffect() });
  const input = (value: Record<string, unknown>) => host.interaction({ token: host.get().token, ...value });
  try {
    await host.load(); host.activate('gene');
    await run({ host, directory, clock, input,
      begin: sessionId => input({ type: 'phase', phase: 'cheek', sessionId }),
      release: (sessionId, activeMs = 500) => input({ type: 'cheek', sessionId, id: `${sessionId}-release`, activeMs }),
    });
  } finally {
    await host.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('soft-cheek-host-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('cheek entry and repeated phase are immediate context only, with no reward', async () => {
  await withHost(async ({ host, clock, begin }) => {
    const initial = host.get().snapshot;
    assert.equal(begin('hold').snapshot.phase, 'cheek');
    clock.now += 500;
    const held = begin('hold').snapshot;
    assert.deepEqual(held.values, initial.values);
    assert.equal(held.lastInteractionAt, null);
    assert.equal(held.cue, null);
    host.cancelInteraction();
    assert.equal(host.get().snapshot.phase, 'idle');
    assert.deepEqual(host.get().snapshot.values, initial.values);
  });
});

test('one normal release credits at most half a second and uses a host event identity', async () => {
  await withHost(async ({ host, clock, begin, release, input }) => {
    begin('hold'); clock.now += 500;
    const accepted = release('hold');
    assert.ok(accepted.snapshot.values.O > 50);
    assert.ok(accepted.snapshot.values.E > 50);
    assert.equal(accepted.snapshot.reason, '有效捏脸');
    assert.equal(accepted.snapshot.event?.id, 'cheek:hold');
    assert.equal(accepted.snapshot.phase, 'cheek');
    assert.equal(accepted.snapshot.lastInteractionAt, clock.now);
    assert.throws(() => release('hold'), /过期或已接受/);
    assert.throws(() => input({ type: 'cheek', sessionId: 'hold', id: 'another-renderer-id', activeMs: 500 }), /过期或已接受/);
    assert.throws(() => begin('hold'), /已接受/);
    assert.deepEqual(host.get().snapshot.values, accepted.snapshot.values);
    input({ type: 'phase', sessionId: 'hold', phase: 'idle' });
    assert.throws(() => begin('hold'), /已结束/);
    assert.deepEqual(host.get().snapshot.values, accepted.snapshot.values);
  });
});

test('the host clock bounds new cheek credit and a repeated phase cannot reset its origin', async () => {
  await withHost(async ({ host, clock, begin, release }) => {
    begin('time');
    assert.throws(() => release('time', 180), /捏脸量不正确/);
    clock.now += 179;
    assert.throws(() => release('time', 180), /捏脸量不正确/);
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    begin('time'); clock.now += 1;
    assert.ok(release('time', 180).snapshot.values.O > 50);
  });
});

test('new cheek input rejects unknown, missing, non-finite and out of range fields before acceptance', async () => {
  await withHost(async ({ host, clock, input, begin, release }) => {
    assert.throws(() => input({ type: 'phase', phase: 'cheek', sessionId: 'strict', path: 'x' }), /字段/);
    begin('strict'); clock.now += 500;
    for (const activeMs of [NaN, Infinity, -1, 0, 179, 501, '500'])
      assert.throws(() => input({ type: 'cheek', sessionId: 'strict', id: 'invalid', activeMs }), /捏脸量不正确/);
    assert.throws(() => input({ type: 'cheek', sessionId: 'strict', id: 'invalid' }), /字段/);
    assert.throws(() => input({ type: 'cheek', sessionId: 'strict', id: 'invalid', activeMs: 500, delta: { O: 20 } }), /字段/);
    assert.throws(() => input({ type: 'cheek', sessionId: 'strict', id: '../arbitrary', activeMs: 500 }), /过期/);
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    assert.ok(release('strict').snapshot.values.O > 50);
  });
});

test('cancel and stale idle retire their own cheek session without settling or touching a new one', async () => {
  await withHost(async ({ host, clock, input, begin, release }) => {
    begin('cancelled'); clock.now += 500;
    input({ type: 'phase', sessionId: 'cancelled', phase: 'idle' });
    assert.throws(() => release('cancelled'), /过期/);
    assert.throws(() => begin('cancelled'), /已结束/);
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    begin('new');
    input({ type: 'phase', sessionId: 'cancelled', phase: 'idle' });
    assert.equal(host.get().snapshot.phase, 'cheek');
    clock.now += 500;
    assert.ok(release('new').snapshot.values.O > 50);
  });
});

test('cheek cannot be credited as food or rua, and replacement retires the old contact', async () => {
  await withHost(async ({ host, clock, input, begin, release }) => {
    begin('cheek'); clock.now += 500;
    assert.throws(() => input({ type: 'food', sessionId: 'cheek', id: 'food' }), /准备/);
    assert.throws(() => input({ type: 'rua', sessionId: 'cheek', id: 'rua', activeMs: 500 }), /抚摸量/);
    assert.throws(() => input({ type: 'phase', sessionId: 'cheek', phase: 'food-wait' }), /类型已改变/);
    input({ type: 'phase', sessionId: 'scalp', phase: 'rua' });
    assert.throws(() => release('cheek'), /过期/);
    assert.throws(() => begin('cheek'), /已结束/);
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    input({ type: 'phase', sessionId: 'food', phase: 'food-wait' });
    assert.throws(() => release('food'), /过期或已接受/);
  });
});

test('model invalidation and character changes reject old tokens and preserve separate state', async () => {
  await withHost(async ({ host, clock, begin, release }) => {
    begin('model'); const oldToken = host.get().token; clock.now += 500;
    host.invalidate();
    assert.throws(() => host.interaction({ type: 'cheek', token: oldToken, sessionId: 'model', id: 'late', activeMs: 500 }), /失效/);
    assert.throws(() => begin('model'), /已结束/);
    begin('role'); clock.now += 500;
    const geneToken = host.get().token;
    host.activate('other');
    assert.throws(() => host.interaction({ type: 'cheek', token: geneToken, sessionId: 'role', id: 'late', activeMs: 500 }), /失效/);
    assert.equal(host.get().snapshot.values.O, 50);
    host.activate('gene');
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    assert.throws(() => release('role'), /过期/);
  });
});

test('suspension invalidates the cheek generation and drops the unaccepted hold', async () => {
  await withHost(async ({ host, clock, begin, release }) => {
    begin('sleep'); const token = host.get().token;
    clock.now += 5_001;
    assert.notEqual(host.get().token, token);
    assert.equal(host.get().snapshot.phase, 'idle');
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    assert.throws(() => release('sleep'), /过期/);
    assert.throws(() => begin('sleep'), /已结束/);
  });
});

test('cheek and rua share persistent diminishing freshness across contact ids and sides', async () => {
  await withHost(async ({ host, directory, clock, begin, release, input }) => {
    host.event({ type: 'rua', id: 'previous-scalp', effectiveMs: 5_000 });
    const increments: number[] = [];
    for (const side of ['left', 'right']) {
      begin(side); clock.now += 500;
      const before = host.get().snapshot.values.O;
      const after = release(side).snapshot.values.O;
      // Invert headroom saturation to observe the shared 0.6 freshness band.
      increments.push(-50 * Math.log((100 - after) / (100 - before)));
      input({ type: 'phase', sessionId: side, phase: 'idle' });
    }
    assert.ok(increments.every(delta => Math.abs(delta - 0.6) < 1e-9));
    await host.flush();
    const saved = JSON.parse(await readFile(path.join(directory, 'mood-state.json'), 'utf8'));
    const profile = saved.profiles[0];
    assert.deepEqual(Object.keys(profile.state.freshness), ['rua']);
    assert.deepEqual(profile.parameters, DEFAULT_MOOD_PARAMETERS);
    assert.equal(profile.state.phase, 'idle');
    assert.ok(profile.state.recentEventIds.includes('cheek:left'));
    assert.doesNotThrow(() => restoreMoodState(profile.state, clock.now, profile.parameters));
  });
});

test('existing sensitivity tunes cheek credit without changing parameters or creating a new source', async () => {
  await withHost(async ({ host, clock, begin, release }) => {
    const template = structuredClone(DEFAULT_MOOD_PARAMETERS);
    template.sensitivity.O = 0; template.sensitivity.E = 2;
    host.applyTemplate('gene', template);
    begin('sensitive'); clock.now += 500;
    const result = release('sensitive');
    assert.equal(result.snapshot.values.O, 50);
    assert.ok(result.snapshot.values.E > 50.7);
    assert.deepEqual(result.parameters, template);
  });
});

test('host restart retains canonical reward dedup and the previous version-one state shape', async () => {
  await withHost(async ({ host, directory, clock, begin, release }) => {
    begin('restored'); clock.now += 500; release('restored'); await host.flush();
    const restored = new MoodHost(directory, () => {}, () => clock.now);
    try {
      await restored.load(); restored.activate('gene');
      const token = restored.get().token;
      const before = restored.get().snapshot.values;
      assert.throws(() => restored.interaction({ type: 'phase', phase: 'cheek', sessionId: 'restored', token }), /已结束/);
      assert.throws(() => restored.interaction({ type: 'cheek', sessionId: 'restored', id: 'new-renderer-id', activeMs: 180, token }), /过期/);
      assert.deepEqual(restored.get().snapshot.values, before, 'canonical persisted identity prevents re-opening and re-credit');
    } finally { await restored.flush(); }
  });
});
