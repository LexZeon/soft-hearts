import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MoodHost } from '../electron/mood';
import { advanceMood, applyMoodEvent, canRequestAmbientSpeech, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodAttentionCandidate,
  getMoodSnapshot, serializeMoodState, validateAmbientSpeechObservation, type AmbientSpeechObservation, type MoodEvent, type MoodState } from '../shared/mood';

const now = 1_000_000;
const observation = (sessionId = 'session', sequence = 1): AmbientSpeechObservation => ({ kind: 'ambient', sessionId, observationId: `${sessionId}:${sequence}` });
const event = (source = observation(), id = 'attention'): MoodEvent => ({ type: 'attention', kind: 'speech', id, source });
const state = (): MoodState => createMoodState(now);

test('valid audio observation bypasses only low boredom, while ordinary speech and Gene defaults remain unchanged', () => {
  const before = structuredClone(DEFAULT_MOOD_PARAMETERS), input = state();
  assert.equal(input.boredom, 0); assert.equal(getMoodAttentionCandidate(input), null);
  assert.equal(applyMoodEvent(input, { type: 'attention', kind: 'speech', id: 'ordinary' }, now).lastSpeechAt, null);
  assert.equal(canRequestAmbientSpeech(input, observation()), true);
  assert.equal(input.lastSpeechAt, null, 'readiness is pure');
  const accepted = applyMoodEvent(input, event(), now);
  assert.equal(accepted.cue?.kind, 'speech'); assert.deepEqual(accepted.cue?.source, observation());
  assert.equal(accepted.lastSpeechAt, now); assert.deepEqual(accepted.speechTimes, [now]); assert.equal(accepted.unansweredSpeech, 1);
  const high = { ...input, boredom: 100 };
  assert.equal(getMoodAttentionCandidate(high), 'speech'); assert.equal(getMoodAttentionCandidate(high, now, undefined, false), 'motion');
  assert.deepEqual(DEFAULT_MOOD_PARAMETERS, before); assert.equal(before.boredom.speechAt, 75);
});

test('shared acceptance atomically rechecks phase, existing cues, reunion and all original speech limits', () => {
  for (const blocked of ['phase', 'cue', 'reunion', 'cooldown', 'hour', 'unanswered', 'disabled-hour', 'disabled-unanswered'] as const) {
    const input = state(), parameters = structuredClone(DEFAULT_MOOD_PARAMETERS);
    if (blocked === 'phase') input.phase = 'rua';
    if (blocked === 'cue') input.cue = { kind: 'look', id: 'existing', at: now, until: now + 1000 };
    if (blocked === 'reunion') input.reunion = { id: 'reunion', at: now, longing: 70, crying: false };
    if (blocked === 'cooldown') input.lastSpeechAt = now - 1;
    if (blocked === 'hour') input.speechTimes = [now - 100, now - 50];
    if (blocked === 'unanswered') { input.unansweredSpeech = 1; input.lastSpeechAt = now - 31 * 60_000; } // I-039: no hard stop, but 3 x the interval
    if (blocked === 'disabled-hour') parameters.frequency.speechPerHour = 0;
    if (blocked === 'disabled-unanswered') parameters.frequency.speechWithoutReply = 0;
    assert.equal(canRequestAmbientSpeech(input, observation(), now, parameters), false, blocked);
    const denied = applyMoodEvent(input, event(), now, parameters);
    assert.equal(denied.lastSpeechAt, input.lastSpeechAt, blocked);
    assert.deepEqual(denied.speechTimes, input.speechTimes, blocked); assert.equal(denied.unansweredSpeech, input.unansweredSpeech, blocked);
    assert.equal(denied.recentEventIds.includes('attention'), false, 'an unaccepted readiness does not consume its identity');
  }
  const blocked = { ...state(), phase: 'rua' as const };
  const denied = applyMoodEvent(blocked, event(), now);
  assert.equal(applyMoodEvent({ ...denied, phase: 'idle' }, event(), now).cue?.kind, 'speech');
});

test('source attention has no reward or B/M/interaction reset, and duplicate event IDs do not double-book', () => {
  const input = state(); input.values.O = 65; input.boredom = 14; input.onlineIdleMs = 100;
  input.lastInteractionAt = now - DEFAULT_MOOD_PARAMETERS.longing.graceMs - 3_600_000;
  input.longing = 1.5;
  const natural = advanceMood(input, now, { online: true }), accepted = applyMoodEvent(input, event(), now);
  for (const key of ['values', 'boredom', 'longing', 'lastInteractionAt', 'onlineIdleMs', 'freshness', 'trend', 'reason', 'lastRuaAt'] as const)
    assert.deepEqual(accepted[key], natural[key], key);
  const duplicate = applyMoodEvent(accepted, event(), now);
  assert.equal(duplicate.unansweredSpeech, 1); assert.deepEqual(duplicate.speechTimes, [now]);
});

test('only bounded ambient session:sequence identities qualify; neither vision nor non-speech events can borrow them', () => {
  const invalid: unknown[] = [null, {}, { ...observation(), kind: 'vision' }, { ...observation(), path: '/private' },
    observation('bad/session'), { ...observation(), observationId: 'other:1' }, { ...observation(), observationId: 'session:0' },
    { ...observation(), observationId: 'session:01' }, { ...observation(), observationId: 'session:1:2' },
    { ...observation(), observationId: 'session:9007199254740992' }, observation('x'.repeat(101))];
  for (const source of invalid) {
    assert.throws(() => validateAmbientSpeechObservation(source));
    assert.equal(canRequestAmbientSpeech(state(), source as AmbientSpeechObservation), false);
    assert.throws(() => applyMoodEvent(state(), event(source as AmbientSpeechObservation), now));
  }
  assert.deepEqual(validateAmbientSpeechObservation(observation('safe-session', Number.MAX_SAFE_INTEGER)), observation('safe-session', Number.MAX_SAFE_INTEGER));
  for (const kind of ['look', 'motion'] as const) assert.throws(() => applyMoodEvent(state(), { type: 'attention', kind, id: 'bad', source: observation() }, now));
  assert.throws(() => applyMoodEvent(state(), { type: 'food', id: 'bad', source: observation() } as MoodEvent, now));
});

test('cue and snapshot copy their source marker, while persistence drops all transient source selection', () => {
  const source = observation(), accepted = applyMoodEvent(state(), event(source), now);
  source.observationId = 'session:2'; assert.equal(accepted.cue?.source?.observationId, 'session:1');
  const snapshot = getMoodSnapshot(accepted); snapshot.cue!.source!.observationId = 'session:3';
  assert.equal(accepted.cue?.source?.observationId, 'session:1');
  const saved = serializeMoodState(accepted); assert.equal(saved.cue, null);
  assert.equal(JSON.stringify(saved).includes('observationId'), false); assert.equal(JSON.stringify(saved).includes('session:1'), false);
  assert.equal(saved.lastSpeechAt, now); assert.equal(saved.unansweredSpeech, 1, 'persistence keeps actual speech accounting');
});

async function withHost(run: (host: MoodHost, clock: { now: number }, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-ambient-attention-')), clock = { now };
  const host = new MoodHost(directory, () => {}, () => clock.now);
  try { await host.load(); host.activate('card'); await run(host, clock, directory); }
  finally {
    await host.flush(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-ambient-attention-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('host unready, disabled expression and active interaction do not consume an observation', async () => {
  await withHost(async host => {
    const source = observation(); host.tick(false, { ambientSpeech: source, allowGenericSpeech: false }); assert.equal(host.get().snapshot.cue, null);
    host.setExpressions(false); host.tick(true, { ambientSpeech: source }); assert.equal(host.get().snapshot.cue, null);
    host.setExpressions(true); host.event({ type: 'phase', id: 'phase', phase: 'rua' });
    host.tick(true, { ambientSpeech: source }); assert.equal(host.get().snapshot.cue, null);
    host.cancelInteraction(); host.tick(true, { ambientSpeech: source, allowGenericSpeech: false });
    assert.equal(host.get().snapshot.cue?.source?.observationId, source.observationId);
  });
});

test('host consumes accepted observations once, with no refund after quiet/cancel or after a later real reply', async () => {
  await withHost(async (host, clock, directory) => {
    const parameters = structuredClone(DEFAULT_MOOD_PARAMETERS); parameters.frequency.speechIntervalMs = 30_000; host.applyTemplate('card', parameters);
    const source = observation(); host.tick(true, { ambientSpeech: source, allowGenericSpeech: false });
    assert.ok(host.get().snapshot.cue?.source); host.invalidate();
    host.tick(true, { ambientSpeech: observation('session', 2), allowGenericSpeech: false }); assert.equal(host.get().snapshot.cue, null, 'cancel did not refund cooldown/unanswered budget');
    for (let i = 0; i < 31; i++) { clock.now += 1000; host.tick(false); }
    host.event({ type: 'chat', id: 'actual-user-reply' }); host.invalidate();
    host.tick(true, { ambientSpeech: source, allowGenericSpeech: false }); assert.equal(host.get().snapshot.cue, null, 'same observation cannot be offered again after quiet or a real reply');
    host.event(event(source, 'different-event-id')); assert.equal(host.get().snapshot.cue, null, 'direct host events share the same observation ledger');
    host.tick(true, { ambientSpeech: observation('session', 2), allowGenericSpeech: false }); assert.equal(host.get().snapshot.cue?.source?.observationId, 'session:2');
    await host.flush(); const raw = JSON.parse(await readFile(path.join(directory, 'mood-state.json'), 'utf8'));
    assert.equal(raw.profiles[0].state.speechTimes.length, 2); assert.equal(raw.profiles[0].state.unansweredSpeech, 1);
    assert.equal(raw.profiles[0].state.cue, null); assert.equal(JSON.stringify(raw).includes('observationId'), false);
  });
});

test('host seen identities are isolated by character and session, and invalid source cannot grant a low-B cue', async () => {
  await withHost(async host => {
    host.tick(true, { ambientSpeech: { ...observation(), kind: 'vision' } as never, allowGenericSpeech: false }); assert.equal(host.get().snapshot.cue, null);
    host.tick(true, { ambientSpeech: observation(), allowGenericSpeech: false }); assert.ok(host.get().snapshot.cue?.source);
    host.activate('other-card'); host.tick(true, { ambientSpeech: observation(), allowGenericSpeech: false }); assert.ok(host.get().snapshot.cue?.source, 'another character has its own speech accounting and accepted observations');
  });
});
