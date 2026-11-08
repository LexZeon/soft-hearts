import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MoodHost } from '../electron/mood';
import { defaultCharacterResponseRule, type CharacterResponseProfile } from '../shared/character-response';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-response-host-'));
  const clock = { now: 100_000 };
  const host = new MoodHost(directory, () => {}, () => clock.now, {
    fatigueClock: {
      monotonicMs: () => clock.now,
      wallMs: () => clock.now,
      localMinute: wall => (wall / 60_000) % 1440,
    },
  });
  const profiles = new Map<string, CharacterResponseProfile>();
  await host.load();
  host.setResponseProfileSource(id => profiles.get(id));
  host.activate('gene');
  t.after(async () => {
    await host.flush();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('soft-response-host-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { host, directory, clock, profiles };
}

test('host response templates change final presentation without changing legacy mood bytes or granting another reward', async t => {
  const { host, profiles, directory } = await fixture(t);
  host.event({ type: 'chat', id: 'original-event', delta: { O: 10, E: 6 }, context: 'support' });
  const base = host.get();
  await host.flush();
  const file = path.join(directory, 'mood-state.json'), bytes = await readFile(file, 'utf8');
  const rule = defaultCharacterResponseRule({ mood: base.snapshot.primary });
  rule.tendencyScale.close = 0;
  rule.intensityScale.expression = 0.4;
  rule.intensityScale.text = 0;
  profiles.set('gene', { version: 1, rules: [rule] });
  host.responseProfileChanged('gene');
  const changed = host.get();
  assert.equal(changed.token, base.token);
  assert.deepEqual(changed.parameters, base.parameters);
  assert.deepEqual(changed.snapshot.values, base.snapshot.values);
  assert.deepEqual(changed.snapshot.trend, base.snapshot.trend);
  assert.equal(changed.snapshot.boredom, base.snapshot.boredom);
  assert.equal(changed.snapshot.longing, base.snapshot.longing);
  assert.equal(changed.snapshot.lastInteractionAt, base.snapshot.lastInteractionAt);
  assert.equal(changed.snapshot.primary, base.snapshot.primary);
  assert.equal(changed.snapshot.tendencies.close, 0);
  assert.equal(changed.snapshot.intensity.expression, base.snapshot.intensity.expression * 0.4);
  assert.equal(host.chatContext(), '');
  host.event({ type: 'chat', id: 'original-event', delta: { O: 10, E: 6 }, context: 'support' });
  assert.deepEqual(host.get().snapshot.values, base.snapshot.values, 'the original event is still consumed exactly once');
  await host.flush();
  assert.equal(await readFile(file, 'utf8'), bytes, 'response settings never enter the legacy mood file');
});

test('effective profiles follow character identity and inactive saves do not publish or alter the current response', async t => {
  const { host, profiles } = await fixture(t);
  const rule = defaultCharacterResponseRule({ mood: 'calm' }); rule.intensityScale.expression = 0;
  profiles.set('other', { version: 1, rules: [rule] });
  const before = host.get();
  host.responseProfileChanged('other');
  assert.deepEqual(host.get(), before);
  host.activate('other');
  assert.equal(host.get().snapshot.intensity.expression, 0);
  host.activate('gene');
  assert.equal(host.get().snapshot.intensity.expression, before.snapshot.intensity.expression);
  assert.deepEqual(host.get().snapshot.values, before.snapshot.values);
});

test('automatic gestures use effective posture and suppressed or cancelled replies cannot replay when a rule is restored', async t => {
  const { host, profiles } = await fixture(t);
  const rule = defaultCharacterResponseRule({ mood: 'calm' }); rule.intensityScale.posture = 0;
  const accept = (id: string) => {
    const token = host.get().token;
    host.beginChatGesture(id, token); host.event({ type: 'chat', id }); return token;
  };
  const appraisal = { context: 'neutral' as const, delta: {}, reason: 'Original fixture', gesture: 'explain' as const };
  profiles.set('gene', { version: 1, rules: [rule] });
  let token = accept('suppressed');
  assert.equal(host.requestChatGesture('suppressed', appraisal, token), null);
  profiles.delete('gene'); host.responseProfileChanged('gene');
  assert.equal(host.requestChatGesture('suppressed', appraisal, token), null);
  token = accept('next');
  assert.ok(host.requestChatGesture('next', appraisal, token));
  const values = host.get().snapshot.values;
  profiles.set('gene', { version: 1, rules: [rule] }); host.responseProfileChanged('gene');
  assert.equal(host.get().gesture, null);
  profiles.delete('gene'); host.responseProfileChanged('gene');
  assert.equal(host.requestChatGesture('next', appraisal, token), null);
  assert.deepEqual(host.get().snapshot.values, values);
});

test('phase-conditioned style follows accepted contact without converting phase changes into another reward', async t => {
  const { host, profiles } = await fixture(t);
  const base = host.get(), rule = defaultCharacterResponseRule({ mood: base.snapshot.primary, phase: 'rua' });
  rule.intensityScale.expression = 0;
  profiles.set('gene', { version: 1, rules: [rule] });
  assert.equal(host.get().snapshot.intensity.expression, base.snapshot.intensity.expression);
  const token = host.get().token;
  host.interaction({ token, sessionId: 'head', type: 'phase', phase: 'rua' });
  assert.equal(host.get().snapshot.intensity.expression, 0);
  assert.deepEqual(host.get().snapshot.values, base.snapshot.values);
  assert.equal(host.get().behavior?.state, null);
  host.interaction({ token, sessionId: 'head', type: 'phase', phase: 'idle' });
  assert.equal(host.get().snapshot.intensity.expression, base.snapshot.intensity.expression);
  assert.deepEqual(host.get().snapshot.values, base.snapshot.values);
});
