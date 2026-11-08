import assert from 'node:assert/strict';
import test from 'node:test';
import { IDLE_CLOCK_GAP_MS, IDLE_DWELL_MAX_MS, IDLE_DWELL_MIN_MS, IDLE_MAX_RECIPES,
  IDLE_MAX_START_AGE_MS, IDLE_OWNER_MAX_LENGTH, IdleMotionScheduler, type IdleMotionCandidate, type IdleMotionCue,
  type IdleMotionDecision, type IdleMotionGates, type IdleMotionTick } from '../shared/idle-motion';

const gates = (): IdleMotionGates => ({ enabled: true, visible: true, targetVerified: true, manualPose: false, manualGesture: false, dynamicPose: false,
  manualExpression: false, manualHead: false, directContact: false, speaking: false, waitingForReply: false, music: false,
  windowCameraInput: false, preview: false });
const input = (now: number, patch: Partial<IdleMotionTick> = {}): IdleMotionTick =>
  ({ scopeToken: 'scope-1', now, intensity: 1, gates: gates(), ...patch });
const candidate = (recipeId: string, patch: Partial<IdleMotionCandidate> = {}): IdleMotionCandidate =>
  ({ recipeId, revision: 'review-1', sha256: 'a'.repeat(64), durationMs: 4_000, strength: 0.2,
    validation: 'continuous-use-verified', ...patch });
const pool = () => [candidate('idle.neutral'), candidate('idle.relaxed'), candidate('idle.shift')];
const scheduler = () => { const value = new IdleMotionScheduler('owner-1', 123); value.replaceCandidates(pool()); return value; };
function walk(value: IdleMotionScheduler, from: number, until: number, patch: Partial<IdleMotionTick> = {}): IdleMotionDecision {
  let decision = value.tick(input(from, patch));
  for (let now = from + 1_000; now <= until; now += 1_000) decision = value.tick(input(now, patch));
  return decision;
}
function issue(value: IdleMotionScheduler, from = 0): IdleMotionCue {
  const waiting = value.tick(input(from));
  assert.equal(waiting.reason, 'waiting');
  assert.ok(waiting.nextAt !== null);
  walk(value, from, waiting.nextAt - 1_000);
  const result = value.tick(input(waiting.nextAt));
  assert.equal(result.reason, 'issued');
  assert.ok(result.cue);
  return result.cue;
}

test('an empty or merely sampled pool keeps ordinary idle without scheduling a VMD', () => {
  const value = new IdleMotionScheduler('owner-1');
  assert.deepEqual(value.tick(input(0)), { cue: null, nextAt: null, reason: 'no-approved-recipes' });
  value.replaceCandidates([candidate('idle.neutral', { validation: 'sampled' }), candidate('idle.shift', { validation: 'untested' })]);
  assert.equal(value.tick(input(1_000)).reason, 'no-approved-recipes');
});

test('equal seeds and canonical reviewed pools give the same bounded variable quiet dwell and choices', () => {
  const left = scheduler(), right = new IdleMotionScheduler('owner-1', 123);
  right.replaceCandidates(pool().reverse());
  const periods: number[] = [];
  let now = 0;
  for (let round = 0; round < 5; round++) {
    const leftWait = left.tick(input(now)), rightWait = right.tick(input(now));
    assert.deepEqual(leftWait, rightWait);
    assert.ok(leftWait.nextAt !== null);
    const period = leftWait.nextAt - now;
    periods.push(period);
    assert.ok(period >= IDLE_DWELL_MIN_MS && period <= IDLE_DWELL_MAX_MS);
    walk(left, now, leftWait.nextAt - 1_000); walk(right, now, leftWait.nextAt - 1_000);
    const a = left.tick(input(leftWait.nextAt)), b = right.tick(input(leftWait.nextAt));
    assert.deepEqual(a, b);
    assert.ok(a.cue && Object.isFrozen(a.cue));
    now = a.cue.expiresAt;
    walk(left, a.cue.at, now - 1_000); walk(right, a.cue.at, now - 1_000);
  }
  assert.ok(new Set(periods).size > 1);
});

test('a cue lease is stable and preserves source duration separately from its bounded loading margin', () => {
  const value = scheduler(), cue = issue(value);
  const result = value.tick(input(cue.at + 1_000, { intensity: 0.5 }));
  assert.equal(result.reason, 'playing');
  assert.ok(result.cue);
  assert.equal(result.cue, cue);
  assert.equal(result.cue.strength, 0.2);
  assert.equal(result.cue.durationMs, 4_000);
  assert.equal(result.cue.expiresAt - result.cue.at, IDLE_MAX_START_AGE_MS + result.cue.durationMs);
});

test('multiple reviewed choices avoid immediate repetition across source passes', () => {
  const value = scheduler(); let now = 0; let previous: string | null = null;
  for (let round = 0; round < 6; round++) {
    const cue = issue(value, now);
    assert.notEqual(cue.recipeId, previous);
    previous = cue.recipeId;
    walk(value, cue.at, cue.expiresAt - 1_000);
    now = cue.expiresAt;
  }
});

test('a one-item pool never turns into a repeated idle loop', () => {
  const value = new IdleMotionScheduler('owner-1'); value.replaceCandidates([candidate('idle.neutral')]);
  const cue = issue(value);
  walk(value, cue.at, cue.expiresAt - 1_000);
  assert.equal(value.tick(input(cue.expiresAt)).reason, 'no-alternative');
  assert.equal(walk(value, cue.expiresAt, cue.expiresAt + 180_000).cue, null);
});

test('every occupancy gate revokes a current cue and requires a fresh quiet dwell', () => {
  for (const key of Object.keys(gates()) as (keyof IdleMotionGates)[]) {
    const value = scheduler(), cue = issue(value);
    const blocked = { ...gates(), [key]: key === 'enabled' || key === 'visible' || key === 'targetVerified' ? false : true };
    assert.equal(value.tick(input(cue.at + 100, { gates: blocked })).reason, 'blocked', key);
    assert.equal(value.canStart(cue.id, cue.scopeToken, cue.at + 100), false, key);
    const resume = value.tick(input(cue.at + 200));
    assert.equal(resume.reason, 'waiting', key);
    assert.ok(resume.nextAt! >= cue.at + 200 + IDLE_DWELL_MIN_MS, key);
    assert.equal(resume.cue, null, key);
  }
});

test('time spent blocked does not accumulate a scheduled opportunity', () => {
  const value = scheduler();
  const blocked = { ...gates(), directContact: true };
  const end = walk(value, 0, 300_000, { gates: blocked });
  assert.deepEqual(end, { cue: null, nextAt: null, reason: 'blocked' });
  const result = value.tick(input(301_000));
  assert.ok(result.nextAt! >= 301_000 + IDLE_DWELL_MIN_MS);
});

test('scope changes revoke old ownership and restart dwell without replay', () => {
  const value = scheduler(), cue = issue(value);
  const result = value.tick(input(cue.at + 100, { scopeToken: 'scope-2' }));
  assert.equal(result.reason, 'waiting');
  assert.equal(result.cue, null);
  assert.equal(value.ownsCue(cue.id, 'scope-1', cue.at + 100), false);
  assert.ok(result.nextAt! >= cue.at + 100 + IDLE_DWELL_MIN_MS);
});

test('sleep gaps and backward time cancel instead of replaying missed opportunities', () => {
  for (const getNow of [(at: number) => at + IDLE_CLOCK_GAP_MS + 1, (at: number) => at - 1]) {
    const value = scheduler(), cue = issue(value);
    const now = getNow(cue.at);
    const result = value.tick(input(now));
    assert.equal(result.reason, 'waiting');
    assert.equal(result.cue, null);
    assert.equal(value.canStart(cue.id, cue.scopeToken, now), false);
    assert.ok(result.nextAt! >= now + IDLE_DWELL_MIN_MS);
  }
});

test('a due opportunity missed within the ordinary tick gap is skipped without catch-up', () => {
  const value = scheduler(); const first = value.tick(input(0)); const due = first.nextAt!;
  walk(value, 0, due - 1_000);
  const late = value.tick(input(due + IDLE_MAX_START_AGE_MS + 1));
  assert.equal(late.reason, 'waiting'); assert.equal(late.cue, null);
  assert.ok(late.nextAt! >= due + IDLE_MAX_START_AGE_MS + 1 + IDLE_DWELL_MIN_MS);
});

test('late async loads, wrong scopes and expiry cannot start a consumed cue', () => {
  const value = scheduler(), cue = issue(value);
  assert.equal(value.canStart(cue.id, cue.scopeToken, cue.at), true);
  assert.equal(value.canStart(cue.id, 'scope-2', cue.at), false);
  assert.equal(value.canStart(cue.id, cue.scopeToken, cue.at - 1), false);
  assert.equal(value.canStart(cue.id, cue.scopeToken, cue.at + IDLE_MAX_START_AGE_MS + 1), false);
  assert.equal(value.ownsCue(cue.id, cue.scopeToken, cue.at + IDLE_MAX_START_AGE_MS + 1), true);
  assert.equal(value.ownsCue(cue.id, cue.scopeToken, cue.expiresAt), false);
});

test('the latest permitted accepted start retains one complete original source pass', () => {
  const value = scheduler(), cue = issue(value);
  const acceptedStartAt = cue.at + IDLE_MAX_START_AGE_MS;
  assert.equal(value.canStart(cue.id, cue.scopeToken, acceptedStartAt), true);
  assert.equal(cue.expiresAt - acceptedStartAt, cue.durationMs);
  assert.equal(value.ownsCue(cue.id, cue.scopeToken, acceptedStartAt + cue.durationMs - 1), true);
  assert.equal(value.canStart(cue.id, cue.scopeToken, acceptedStartAt + 1), false);
  assert.equal(cue.durationMs, 4_000);
  assert.equal(value.ownsCue(cue.id, cue.scopeToken, acceptedStartAt + cue.durationMs), false);
});

test('allowlist replacement revokes synchronously, while identical copies do not reset a cue', () => {
  const value = scheduler(), cue = issue(value);
  value.replaceCandidates(pool().reverse());
  assert.equal(value.canStart(cue.id, cue.scopeToken, cue.at + 10), true);
  value.replaceCandidates(pool().map(item => item.recipeId === cue.recipeId ? { ...item, revision: 'review-2' } : item));
  assert.equal(value.ownsCue(cue.id, cue.scopeToken, cue.at + 10), false);
  const result = value.tick(input(cue.at + 20));
  assert.equal(result.reason, 'waiting'); assert.equal(result.cue, null);
});

test('input candidate mutation cannot alter a previously approved identity or cue', () => {
  const value = new IdleMotionScheduler('owner-1'); const mutable = pool(); value.replaceCandidates(mutable);
  mutable[0] = candidate('arbitrary.changed', { sha256: 'b'.repeat(64) });
  const cue = issue(value);
  assert.ok(pool().some(item => item.recipeId === cue.recipeId));
  assert.equal(cue.sha256, 'a'.repeat(64));
});

test('unbounded, conflicting or invalid recipe identities are excluded without clipping source duration', () => {
  const bad: Partial<IdleMotionCandidate>[] = [{ recipeId: '../file.vmd' }, { revision: 'file:///motion' }, { sha256: 'bad' },
    { durationMs: Infinity }, { durationMs: 30_001 }, { durationMs: 0 }, { strength: NaN }, { strength: 0.31 }, { strength: 0 }];
  for (const patch of bad) {
    const value = new IdleMotionScheduler('owner-1'); value.replaceCandidates([candidate('idle.neutral', patch)]);
    assert.equal(value.tick(input(0)).reason, 'no-approved-recipes');
  }
  const duplicate = new IdleMotionScheduler('owner-1');
  duplicate.replaceCandidates([candidate('idle.neutral'), candidate('idle.neutral', { revision: 'other-review' })]);
  assert.equal(duplicate.tick(input(0)).reason, 'no-approved-recipes');
  duplicate.replaceCandidates(Array.from({ length: IDLE_MAX_RECIPES + 1 }, (_, index) => candidate(`idle.${index}`)));
  assert.equal(duplicate.tick(input(0)).reason, 'no-approved-recipes');
});

test('invalid time, identity, intensity and gate values clear active presentation', () => {
  const patches: Partial<IdleMotionTick>[] = [{ now: NaN }, { now: Infinity }, { now: -1 }, { now: Number.MAX_VALUE },
    { scopeToken: '../private' }, { intensity: NaN }, { intensity: -1 }, { intensity: 1.1 }, { intensity: 0 },
    { gates: { ...gates(), music: 'false' as unknown as boolean } }];
  for (const patch of patches) {
    const value = scheduler(), cue = issue(value);
    const result = value.tick(input(cue.at + 10, patch));
    assert.equal(result.cue, null);
    assert.equal(result.nextAt, null);
    assert.equal(value.canStart(cue.id, cue.scopeToken, cue.at + 10), false);
  }
});

test('cancel/dispose are immediate and discarded cue identities are never reused in one runtime', () => {
  const value = scheduler(), first = issue(value);
  value.cancel(); assert.equal(value.ownsCue(first.id, first.scopeToken, first.at + 10), false);
  const next = issue(value, first.at + 100);
  assert.notEqual(next.id, first.id);
  value.dispose(); value.replaceCandidates(pool());
  assert.deepEqual(value.tick(input(next.at + 10)), { cue: null, nextAt: null, reason: 'disposed' });
  assert.equal(value.canStart(next.id, next.scopeToken, next.at + 10), false);
});

test('constructor rejects identities and seeds that would blur host ownership or determinism', () => {
  for (const owner of ['', '../motion', 'x'.repeat(IDLE_OWNER_MAX_LENGTH + 1)]) assert.throws(() => new IdleMotionScheduler(owner), TypeError);
  for (const seed of [NaN, Infinity, -1, 1.5, 0x1_0000_0000]) assert.throws(() => new IdleMotionScheduler('owner-1', seed), TypeError);
});

test('fresh per-instance host owners keep otherwise identical cue sequences distinct and bounded', () => {
  const left = new IdleMotionScheduler('instance-a', 123), right = new IdleMotionScheduler('instance-b', 123);
  left.replaceCandidates(pool()); right.replaceCandidates(pool());
  const a = issue(left), b = issue(right);
  assert.equal(a.at, b.at); assert.equal(a.recipeId, b.recipeId);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[A-Za-z0-9_-]{1,160}$/);
  assert.equal(left.ownsCue(b.id, b.scopeToken, b.at), false);
  assert.equal(right.ownsCue(a.id, a.scopeToken, a.at), false);
  const longest = new IdleMotionScheduler('x'.repeat(IDLE_OWNER_MAX_LENGTH), 123);
  longest.replaceCandidates(pool());
  assert.ok(issue(longest).id.length <= 160);
});

test('legacy gate snapshots missing manualPose, waitingForReply or targetVerified fail closed', () => {
  for (const key of ['manualPose', 'waitingForReply', 'targetVerified'] as const) {
    const value = scheduler(), cue = issue(value);
    const legacy = { ...gates() } as Partial<IdleMotionGates>;
    delete legacy[key];
    assert.equal(value.tick(input(cue.at + 10, { gates: legacy as IdleMotionGates })).reason, 'blocked');
    assert.equal(value.ownsCue(cue.id, cue.scopeToken, cue.at + 10), false);
  }
});
