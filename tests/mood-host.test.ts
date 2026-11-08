import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MoodHost } from '../electron/mood';
import { DEFAULT_MOOD_PARAMETERS } from '../shared/mood';
import { FixedBoredomTiming } from '../shared/behaviors/boredom-timing/fake';
import { FixedTouchFeedEffect } from '../shared/behaviors/touch-feed-effect/fake';
import { FixedBlush } from '../shared/behaviors/blush/fake';
import type { MoodInput, MoodView } from '../shared/mood-runtime';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const quota = (value: number) => -50 * Math.log((100 - value) / 50);

async function withHost(operation: (context: {
  host: MoodHost; directory: string; clock: { now: number }; updates: MoodView[];
  input: (value: Omit<MoodInput, 'token'> | Record<string, unknown>) => MoodView;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-mood-host-'));
  const clock = { now: 1_000_000 };
  const updates: MoodView[] = [];
  // The card's boredom numbers, pat and snack amounts and blush as they are (#8, #21 and #26 have their own tests): these check the mood arithmetic.
  const host = new MoodHost(directory, view => updates.push(view), () => clock.now,
    { boredomTiming: new FixedBoredomTiming(), touchFeedEffect: new FixedTouchFeedEffect(), blush: new FixedBlush() });
  try {
    await host.load();
    host.activate('gene');
    await operation({ host, directory, clock, updates, input: value => host.interaction({ token: host.get().token, ...value }) });
  } finally {
    await host.flush().catch(() => {});
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('soft-mood-host-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('atomic queued saves preserve the latest role state, then relaunch restores values and private dedup', async () => {
  await withHost(async ({ host, directory, clock }) => {
    host.event({ type: 'chat', id: 'message', delta: { O: 10 }, context: 'support' });
    const first = host.flush();
    host.event({ type: 'food', id: 'meal' });
    const latest = host.get().snapshot;
    const second = host.flush();
    await Promise.all([first, second]);
    const file = path.join(directory, 'mood-state.json');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.profiles.length, 1);
    assert.deepEqual(raw.profiles[0].state.values, latest.values);
    assert.equal(raw.profiles[0].state.phase, 'idle');
    assert.ok(raw.profiles[0].state.recentEventIds.includes('meal'));
    assert.deepEqual((await readdir(directory)).sort(), ['fatigue-state.json', 'mood-state.json']);
    const restored = new MoodHost(directory, () => {}, () => clock.now);
    await restored.load();
    restored.activate('gene');
    try {
      assert.deepEqual(restored.get().snapshot.values, latest.values);
      assert.equal(restored.get().snapshot.cue, null);
      assert.equal(restored.get().snapshot.phase, 'idle');
      restored.event({ type: 'food', id: 'meal' });
      assert.deepEqual(restored.get().snapshot.values, latest.values);
    } finally { await restored.flush(); }
  });
});

test('characters own separate parameters, state and valid renderer generations', async () => {
  await withHost(async ({ host }) => {
    host.event({ type: 'food', id: 'gene-snack' });
    const gene = host.get();
    host.activate('other');
    const other = host.get();
    assert.notEqual(other.token, gene.token);
    assert.equal(other.snapshot.values.D, 50);
    assert.throws(() => host.interaction({ token: gene.token, sessionId: 'old', type: 'phase', phase: 'rua' }), /失效/);
    host.event({ type: 'chat', id: 'other-user', delta: { C: 10 }, context: 'concern' });
    host.activate('gene');
    assert.deepEqual(host.get().snapshot.values, gene.snapshot.values);
    assert.equal(host.get().snapshot.values.C, 50);
    assert.notEqual(host.get().token, gene.token);
  });
});

test('card templates initialize new baselines, alter future events and preserve existing role experience', async () => {
  await withHost(async ({ host, clock }) => {
    const template = structuredClone(DEFAULT_MOOD_PARAMETERS);
    template.baseline.O = 60; template.sensitivity.O = 2;
    template.boredom.graceMs = 0; template.boredom.perMinute = 20;
    host.activate('numeric-role', template);
    assert.equal(host.get().snapshot.values.O, 60);
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    for (let i = 0; i < 4; i++) { clock.now += 1_000; host.tick(false); }
    const boredom = host.get().snapshot.boredom;
    host.event({ type: 'chat', id: 'friendly', delta: { O: 4 }, context: 'support' });
    const gained = host.get().snapshot.values.O;
    assert.ok(gained > 65, 'sensitivity 2 actually enters the saturation calculation');
    const before = host.get().snapshot;
    const changed = structuredClone(template); changed.baseline.O = 42; changed.sensitivity.O = 0.5;
    host.applyTemplate('numeric-role', changed);
    assert.equal(host.get().snapshot.values.O, before.values.O);
    assert.equal(host.get().snapshot.lastInteractionAt, before.lastInteractionAt);
    host.activate('gene'); host.activate('numeric-role', changed);
    assert.equal(host.get().snapshot.values.O, gained);
    assert.equal(host.get().parameters.baseline.O, 42);
    for (let i = 0; i < 4; i++) { clock.now += 1_000; host.tick(false); }
    const keptBoredom = host.get().snapshot.boredom;
    assert.ok(keptBoredom >= boredom);
    host.activate('gene'); host.activate('numeric-role', changed);
    assert.equal(host.get().snapshot.boredom, keptBoredom, 'switching cards is not a session reset');
    const detached = host.getSavedParameters('numeric-role')!; detached.baseline.O = 99;
    assert.equal(host.get().parameters.baseline.O, 42);
    assert.equal(host.getSavedParameters('never-activated'), undefined);
  });
});

test('chat context preserves concern plus comfort and distinguishes negative events from passive recovery', async () => {
  await withHost(async ({ host, clock }) => {
    host.event({ type: 'chat', id: 'comfort', delta: { E: 10, O: 10 }, context: 'support' });
    host.event({ type: 'chat', id: 'concern', delta: { C: 8, N: 8, D: -7 }, context: 'concern' });
    const context = host.chatContext();
    assert.match(context, /主感受担心/);
    assert.match(context, /D-.*快速下降|C\+|N\+/);
    assert.match(context, /关切用户/);
    clock.now += 20_000; host.get();
    assert.match(host.chatContext(), /自然恢复不代表新的失望或冒犯/);
    host.setExpressions(false); assert.equal(host.chatContext(), '');
  });
});

test('paused expressions still settle real input but cannot queue blush or spend its cooldown', async () => {
  await withHost(async ({ host, directory }) => {
    host.setExpressions(false);
    host.event({ type: 'chat', id: 'paused-care', delta: { O: 6, E: 3 }, context: 'support' });
    const paused = host.get();
    assert.ok(paused.snapshot.values.O > 50); assert.notEqual(paused.snapshot.lastInteractionAt, null);
    assert.equal(paused.snapshot.blush, null); assert.equal(paused.snapshot.cue, null);
    await host.flush();
    const saved = JSON.parse(await readFile(path.join(directory, 'mood-state.json'), 'utf8'));
    assert.equal(saved.profiles[0].state.lastBlushAt, null);
    host.setExpressions(true); assert.equal(host.get().snapshot.blush, null);
    host.event({ type: 'chat', id: 'fresh-care', delta: { O: 6, E: 3 }, context: 'support' });
    assert.equal(host.get().snapshot.blush?.id, 'fresh-care');
    host.invalidate(); assert.equal(host.get().snapshot.blush, null);
  });
});

test('stale parameter editors cannot address a different role or model generation', async () => {
  await withHost(async ({ host }) => {
    const view = host.get(), expected = { characterId: view.characterId, token: view.token };
    host.assertParameterIdentity(expected);
    host.activate('other'); assert.throws(() => host.assertParameterIdentity(expected), /重新读取/);
    const other = host.get(); host.invalidate();
    assert.throws(() => host.assertParameterIdentity({ characterId: other.characterId, token: other.token }), /重新读取/);
    assert.throws(() => host.assertParameterIdentity({ ...expected, shell: true }), /重新读取/);
  });
});

test('late old-generation appraisal cannot erase a new interaction expression', async () => {
  await withHost(async ({ host }) => {
    host.event({ type: 'chat', id: 'old-chat' }); host.invalidate();
    host.event({ type: 'rua', id: 'new-rua', effectiveMs: 5000 });
    const current = host.get().snapshot; assert.ok(current.blush);
    host.event({ type: 'appraisal', id: 'old-result', responseTo: 'old-chat', delta: { O: 4 }, context: 'support' }, 'gene', { expressions: false });
    assert.equal(host.get().snapshot.blush?.id, current.blush.id);
    assert.equal(host.get().snapshot.cue?.id, current.cue?.id);
    assert.ok(host.get().snapshot.values.O > current.values.O);
  });
});

test('get advances live reads and sleep gaps invalidate the active session with a broadcast', async () => {
  await withHost(async ({ host, clock, input, updates }) => {
    host.event({ type: 'chat', id: 'past' });
    input({ type: 'phase', sessionId: 'contact', phase: 'rua' });
    const token = host.get().token;
    const before = updates.length;
    clock.now += 32 * HOUR;
    const after = host.get();
    near(after.snapshot.longing, 30);
    assert.equal(after.snapshot.boredom, 0);
    assert.equal(after.snapshot.phase, 'idle');
    assert.notEqual(after.token, token);
    assert.ok(updates.length > before);
    assert.equal(updates.at(-1)?.token, after.token);
    assert.throws(() => host.interaction({ token, sessionId: 'contact', type: 'rua', id: 'late', activeMs: 100 }), /失效/);
    assert.throws(() => input({ type: 'rua', sessionId: 'contact', id: 'new-token-old-contact', activeMs: 100 }), /过期/);
  });
});

test('live ticks accumulate B, a suspended tick clears B and session, and static rua stays active', async () => {
  await withHost(async ({ host, clock, input }) => {
    host.setDeveloperMode(true);
    const p = structuredClone(DEFAULT_MOOD_PARAMETERS);
    p.boredom.graceMs = 0;
    p.boredom.perMinute = 20;
    host.setParameters(p);
    for (let i = 0; i < 6; i++) { clock.now += 1_000; host.tick(false); }
    near(host.get().snapshot.boredom, 2);
    input({ type: 'phase', sessionId: 'static', phase: 'rua' });
    for (let i = 0; i < 4; i++) { clock.now += 1_000; host.tick(false); }
    assert.equal(host.get().snapshot.phase, 'rua');
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    const token = host.get().token;
    clock.now += MINUTE;
    host.tick(false);
    assert.equal(host.get().snapshot.boredom, 0);
    assert.equal(host.get().snapshot.phase, 'idle');
    assert.notEqual(host.get().token, token);
  });
});

test('token bucket bounds effective rua by real arrival time and rejects malformed reports', async () => {
  await withHost(async ({ host, clock, input }) => {
    input({ type: 'phase', sessionId: 'touch', phase: 'rua' });
    input({ type: 'rua', sessionId: 'touch', id: 'instant', activeMs: 500 });
    assert.equal(host.get().snapshot.values.O, 50);
    clock.now += 100;
    input({ type: 'rua', sessionId: 'touch', id: 'first', activeMs: 500 });
    near(quota(host.get().snapshot.values.O), 0.2);
    const values = host.get().snapshot.values;
    input({ type: 'rua', sessionId: 'touch', id: 'flood', activeMs: 500 });
    assert.deepEqual(host.get().snapshot.values, values);
    assert.throws(() => input({ type: 'rua', sessionId: 'touch', id: 'nan', activeMs: NaN }), /不正确/);
    assert.throws(() => input({ type: 'rua', sessionId: 'touch', id: 'huge', activeMs: 501 }), /不正确/);
    assert.throws(() => input({ type: 'rua', sessionId: 'touch', id: '../path', activeMs: 100 }), /过期/);
    clock.now += 100;
    input({ type: 'rua', sessionId: 'touch', id: 'first', activeMs: 100 });
    assert.ok(quota(host.get().snapshot.values.O) < 0.201, 'a retried id cannot mint another reward');
  });
});

test('food must wait 500ms, cancel gives no reward, release accepts exactly once', async () => {
  await withHost(async ({ host, clock, input }) => {
    input({ type: 'phase', sessionId: 'cancelled', phase: 'food-wait' });
    assert.throws(() => input({ type: 'phase', sessionId: 'cancelled', phase: 'food-ready' }), /停留/);
    assert.throws(() => input({ type: 'food', sessionId: 'cancelled', id: 'early' }), /松手/);
    input({ type: 'phase', sessionId: 'cancelled', phase: 'idle' });
    assert.equal(host.get().snapshot.values.D, 50);
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    input({ type: 'phase', sessionId: 'meal', phase: 'food-wait' });
    clock.now += 499;
    assert.throws(() => input({ type: 'phase', sessionId: 'meal', phase: 'food-ready' }), /停留/);
    clock.now++;
    input({ type: 'phase', sessionId: 'meal', phase: 'food-ready' });
    assert.equal(host.get().snapshot.lastInteractionAt, null);
    input({ type: 'food', sessionId: 'meal', id: 'release' });
    const accepted = host.get();
    near(quota(accepted.snapshot.values.D), 12);
    assert.equal(accepted.snapshot.phase, 'food-eating');
    assert.equal(accepted.snapshot.lastInteractionAt, clock.now);
    assert.throws(() => input({ type: 'food', sessionId: 'meal', id: 'release-again' }), /松手/);
    assert.throws(() => input({ type: 'phase', sessionId: 'meal', phase: 'food-wait' }), /已接受/);
    assert.deepEqual(host.get().snapshot.values, accepted.snapshot.values);
  });
});

test('leaving a ready mouth resets dwell, and the same session cannot switch interaction types', async () => {
  await withHost(async ({ clock, input }) => {
    input({ type: 'phase', sessionId: 'food', phase: 'food-wait' });
    clock.now += 500;
    input({ type: 'phase', sessionId: 'food', phase: 'food-ready' });
    input({ type: 'phase', sessionId: 'food', phase: 'food-wait' });
    assert.throws(() => input({ type: 'phase', sessionId: 'food', phase: 'food-ready' }), /停留/);
    assert.throws(() => input({ type: 'phase', sessionId: 'food', phase: 'rua' }), /类型/);
    input({ type: 'phase', sessionId: 'touch', phase: 'rua' });
    assert.throws(() => input({ type: 'phase', sessionId: 'touch', phase: 'food-wait' }), /类型/);
  });
});

test('a delayed idle from an old session cannot cancel the new contact', async () => {
  await withHost(async ({ host, input }) => {
    input({ type: 'phase', sessionId: 'old', phase: 'rua' });
    input({ type: 'phase', sessionId: 'new', phase: 'rua' });
    input({ type: 'phase', sessionId: 'old', phase: 'idle' });
    assert.equal(host.get().snapshot.phase, 'rua');
    assert.throws(() => input({ type: 'rua', sessionId: 'old', id: 'late', activeMs: 100 }), /过期/);
    input({ type: 'phase', sessionId: 'new', phase: 'idle' });
    assert.equal(host.get().snapshot.phase, 'idle');
  });
});

test('debug/expressions toggles do not reward, parameter restore preserves state, invalid changes are atomic', async () => {
  await withHost(async ({ host }) => {
    const start = host.get().snapshot;
    assert.throws(() => host.setParameters(DEFAULT_MOOD_PARAMETERS), /开发者/);
    host.setDeveloperMode(true);
    host.setExpressions(false);
    assert.deepEqual(host.get().snapshot, start);
    assert.equal(host.chatContext(), '');
    host.setExpressions(true);
    host.event({ type: 'chat', id: 'care', delta: { O: 10, E: 6 }, context: 'support' });
    const p = structuredClone(DEFAULT_MOOD_PARAMETERS);
    p.sensitivity.O = 1.5;
    host.setParameters(p);
    const before = host.get();
    host.restoreParameters();
    assert.deepEqual(host.get().parameters, DEFAULT_MOOD_PARAMETERS);
    assert.deepEqual(host.get().snapshot.values, before.snapshot.values);
    assert.equal(host.get().snapshot.lastInteractionAt, before.snapshot.lastInteractionAt);
    assert.throws(() => host.setParameters({ ...p, shell: 'forbidden' }), /Unknown/);
    assert.deepEqual(host.get().parameters, DEFAULT_MOOD_PARAMETERS);
  });
});

test('corrupt files are preserved and load does not leave partially accepted profiles', async () => {
  await withHost(async ({ host, directory, clock }) => {
    host.event({ type: 'food', id: 'original' });
    await host.flush();
    const file = path.join(directory, 'mood-state.json');
    const good = JSON.parse(await readFile(file, 'utf8'));
    good.profiles[0].characterId = 'partial';
    good.profiles.push({ characterId: 'bad', parameters: {}, state: {} });
    const corrupt = JSON.stringify(good);
    await writeFile(file, corrupt);
    const reader = new MoodHost(directory, () => {}, () => clock.now);
    await assert.rejects(reader.load());
    assert.equal(reader.canMigrateTemplates(), false);
    assert.equal(await readFile(file, 'utf8'), corrupt);
    reader.activate('partial');
    assert.equal(reader.get().snapshot.values.D, 50);
    assert.match(reader.get().storageError ?? '', /原 mood-state.json 已保留/);
    await assert.rejects(reader.flush(), /仅保留在内存/);
    assert.equal(await readFile(file, 'utf8'), corrupt, 'fallback runtime must never overwrite unreadable private state');
  });
});

test('background save errors are visible, preserve the last good file, and a successful retry clears the error', async () => {
  await withHost(async ({ host, directory, updates }) => {
    await host.flush();
    const file = path.join(directory, 'mood-state.json');
    const original = await readFile(file, 'utf8');
    const blocked = file + '.tmp';
    await mkdir(blocked);
    host.event({ type: 'chat', id: 'unsaved', delta: { O: 10 } });
    await new Promise(resolve => setTimeout(resolve, 1_150));
    assert.match(host.get().storageError ?? '', /仅保留在内存/);
    assert.ok(updates.some(view => !!view.storageError));
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal(path.dirname(blocked), directory);
    await rm(blocked, { recursive: true, force: true });
    await host.flush();
    assert.equal(host.get().storageError, undefined);
    assert.equal(updates.at(-1)?.storageError, undefined);
    assert.ok((await readFile(file, 'utf8')).includes('unsaved'));
  });
});
