import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BehaviorMotionController } from '../electron/behavior-motion';
import { MoodHost } from '../electron/mood';
import { createMoodState, getMoodSnapshot, type MoodSnapshot } from '../shared/mood';

const start = 1_000_000;
const snapshot = (): MoodSnapshot => ({ ...getMoodSnapshot(createMoodState(start)), primary: 'happy' });
function fixture() {
  let now = start, sequence = 0;
  return { engine: new BehaviorMotionController(() => now, () => `plan-${++sequence}`),
    advance(ms: number) { now += ms; }, get now() { return now; } };
}

test('state refresh and intensity tuning retain one source clock; expiry never restarts the same state', () => {
  const f = fixture(), s = snapshot(), before = structuredClone(s);
  const first = f.engine.update(s, 'scope-a', true).state!;
  f.advance(600);
  s.intensity.expression = 80;
  const updated = f.engine.update(s, 'scope-a', true).state!;
  assert.equal(updated.id, first.id); assert.equal(updated.at, first.at);
  assert.ok(updated.strength > first.strength);
  f.advance(12_000);
  assert.equal(f.engine.update(s, 'scope-a', true).state, null);
  assert.equal(f.engine.update(s, 'scope-a', true).state, null);
  s.primary = 'sad';
  assert.notEqual(f.engine.update(s, 'scope-a', true).state?.id, first.id);
  s.primary = before.primary; s.intensity.expression = before.intensity.expression;
  assert.deepEqual(s, before, 'presentation does not mutate channels, history or response evidence');
});

test('calm can receive a neutral acknowledgement without inventing a reset background', () => {
  const f = fixture(), s = snapshot(); s.primary = 'calm';
  s.cue = { id: 'response', kind: 'satisfied', at: f.now, until: f.now + 4000 };
  const p = f.engine.update(s, 'scope-a', true);
  assert.equal(p.state, null); assert.equal(p.reaction?.bindingId, 'face.convinced');
});

test('contact, disabled and zero-intensity source cues are consumed and cannot replay on release', () => {
  for (const block of ['contact', 'disabled', 'zero']) {
    const f = fixture(), s = snapshot();
    s.cue = { id: block, kind: 'satisfied', at: f.now, until: f.now + 4000 };
    if (block === 'contact') s.phase = 'rua';
    if (block === 'zero') s.intensity.expression = 0;
    assert.equal(f.engine.update(s, 'scope-a', block !== 'disabled').reaction, null);
    s.phase = 'idle'; s.intensity.expression = 50; f.advance(300);
    assert.equal(f.engine.update(s, 'scope-a', true).reaction, null);
  }
});

test('scope cancellation, expiry and late callbacks do not resurrect a reaction or erase another source', () => {
  const f = fixture(), s = snapshot();
  s.cue = { id: 'old', kind: 'reunion', at: f.now, until: f.now + 12_000 };
  const first = f.engine.update(s, 'scope-a', true).reaction!;
  assert.equal(first.expiresAt - first.at, 11_500);
  assert.equal(f.engine.cancelReaction('other'), false);
  assert.equal(f.engine.cancelReaction('old'), true);
  assert.equal(f.engine.update(s, 'scope-a', true).reaction, null);
  f.engine.invalidate();
  assert.equal(f.engine.update(s, 'scope-b', true).reaction, null);
  f.advance(100);
  s.cue = { id: 'new', kind: 'satisfied', at: f.now, until: f.now + 4000 };
  const current = f.engine.update(s, 'scope-b', true).reaction!;
  assert.equal(f.engine.cancelReaction('old'), false);
  assert.equal(f.engine.update(s, 'scope-b', true).reaction?.id, current.id);
  f.advance(4001);
  assert.equal(f.engine.update(s, 'scope-b', true).reaction, null);
});

test('late first observations are discarded and returned plans cannot mutate host identity', () => {
  const f = fixture(), s = snapshot();
  s.cue = { id: 'late', kind: 'satisfied', at: f.now - 1600, until: f.now + 2000 };
  const plan = f.engine.update(s, 'scope-a', true);
  assert.equal(plan.reaction, null);
  const id = plan.state!.id;
  plan.state!.id = 'renderer-forgery';
  assert.equal(f.engine.update(s, 'scope-a', true).state?.id, id);
});

test('unscoped conversation cancellation clears reaction immediately before asynchronous work', () => {
  const f = fixture(), s = snapshot();
  s.cue = { id: 'conversation-old', kind: 'satisfied', at: f.now, until: f.now + 4000 };
  const plan = f.engine.update(s, 'scope-a', true);
  assert.ok(plan.reaction);
  assert.equal(f.engine.cancelReaction(), true);
  assert.equal(f.engine.update(s, 'scope-a', true).reaction, null);
  assert.equal(f.engine.update(s, 'scope-a', true).state?.id, plan.state?.id);
});

test('a neutral acceptance cannot retain its old reaction over a later serious appraisal', () => {
  const f = fixture(), s = snapshot(); s.primary = 'calm';
  s.cue = { id: 'one-source', kind: 'satisfied', at: f.now, until: f.now + 4000 };
  assert.equal(f.engine.update(s, 'scope-a', true).reaction?.bindingId, 'face.convinced');
  f.advance(100); s.primary = 'concerned'; s.context = 'concern';
  const appraised = f.engine.update(s, 'scope-a', true);
  assert.equal(appraised.reaction, null); assert.equal(appraised.state?.bindingId, 'face.compassion');
  s.primary = 'calm'; s.context = 'neutral';
  assert.equal(f.engine.update(s, 'scope-a', true).reaction, null, 'the same source cannot reopen after its meaning changes');
});

test('an active source loses eligibility on contact while matching strength changes retain its clock', () => {
  const f = fixture(), s = snapshot();
  s.cue = { id: 'same-source', kind: 'satisfied', at: f.now, until: f.now + 4000 };
  const first = f.engine.update(s, 'scope-a', true).reaction!;
  f.advance(200); s.intensity.expression = 80;
  const tuned = f.engine.update(s, 'scope-a', true).reaction!;
  assert.equal(tuned.id, first.id); assert.equal(tuned.at, first.at); assert.equal(tuned.expiresAt, first.expiresAt);
  assert.ok(tuned.strength > first.strength);
  s.phase = 'rua';
  assert.equal(f.engine.update(s, 'scope-a', true).reaction, null);
  s.phase = 'idle';
  assert.equal(f.engine.update(s, 'scope-a', true).reaction, null);
});

test('MoodHost shares one transient plan across windows and never persists presentation choices', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-behavior-host-'));
  let now = start;
  const host = new MoodHost(directory, () => {}, () => now);
  try {
    await host.load(); host.activate('gene');
    host.event({ type: 'chat', id: 'chat-a', delta: { D: 20, E: 20 }, context: 'positive' });
    const a = host.get(), b = host.get();
    assert.ok(a.behavior?.state); assert.ok(a.behavior?.reaction);
    assert.deepEqual(a.behavior, b.behavior);
    host.cancelChatGesture('unrelated');
    assert.equal(host.get().behavior?.reaction?.id, a.behavior?.reaction?.id);
    host.cancelChatGesture('chat-a');
    assert.equal(host.get().behavior?.reaction, null);
    assert.deepEqual(host.get().snapshot.values, a.snapshot.values);
    await host.flush();
    const saved = JSON.parse(await readFile(path.join(directory, 'mood-state.json'), 'utf8'));
    assert.equal(JSON.stringify(saved).includes('face.'), false);
    assert.equal(JSON.stringify(saved).includes('behavior'), false);
    const oldToken = host.get().token;
    now += 100; host.invalidate();
    assert.notEqual(host.get().token, oldToken);
    assert.equal(host.get().behavior?.reaction, null);
  } finally {
    await host.flush();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('soft-behavior-host-'));
    await rm(directory, { recursive: true, force: true });
  }
});
