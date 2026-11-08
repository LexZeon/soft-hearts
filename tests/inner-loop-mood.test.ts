import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceMood, applyMoodEvent, canRequestAmbientSpeech, createMoodState, DEFAULT_MOOD_PARAMETERS, getMoodAttentionCandidate,
  releaseUnspokenSpeech, type MoodState } from '../shared/mood';

const MINUTE = 60_000;
const p = DEFAULT_MOOD_PARAMETERS;
const source = { kind: 'ambient' as const, sessionId: 's1', observationId: 's1:1' };

/** Idle long enough for every attention kind (B reaches 100). */
function bored(now: number): MoodState {
  const start = now - 60 * MINUTE;
  let state = createMoodState(start, p);
  for (let t = start + 1_000; t <= now; t += 1_000) state = advanceMood(state, t, { online: true }, p);
  return state;
}
function accept(state: MoodState, kind: 'motion' | 'speech', id: string, now: number) {
  const next = applyMoodEvent(state, { type: 'attention', id, kind }, now, p);
  assert.equal(next.cue?.id, id);
  return next;
}

test('a claimed motion may be realized as itself or as a look; the boredom threshold is not rechecked', () => {
  const now = 10_000_000;
  let state = accept(bored(now), 'motion', 'm1', now);
  const claimed = { id: 'm1', kind: 'motion' as const, at: now };
  const motion = applyMoodEvent(state, { type: 'attention', id: 'r1', kind: 'motion', claimed }, now + 4_000, p);
  assert.equal(motion.cue?.id, 'r1'); assert.equal(motion.cue?.kind, 'motion'); assert.equal(motion.lastMotionAt, now + 4_000);
  const look = applyMoodEvent(state, { type: 'attention', id: 'r2', kind: 'look', claimed }, now + 1_000, p);
  assert.equal(look.cue?.id, 'r2'); assert.equal(look.cue?.kind, 'look'); assert.equal(look.lastLookAt, now + 1_000);
  // Even a low-boredom state: the opportunity already passed a higher threshold when it was accepted.
  state.boredom = 0;
  assert.equal(applyMoodEvent(state, { type: 'attention', id: 'r3', kind: 'look', claimed }, now + 4_000, p).cue?.id, 'r3');
});

test('a claim cannot be realized late, twice past a newer opportunity, over another cue, or as speech', () => {
  const now = 10_000_000;
  const state = accept(bored(now), 'motion', 'm1', now);
  const claimed = { id: 'm1', kind: 'motion' as const, at: now };
  assert.equal(applyMoodEvent(state, { type: 'attention', id: 'late', kind: 'motion', claimed }, now + 121_000, p).cue, null, 'older than the request window');
  const forged = { ...claimed, at: now - 1 };
  assert.notEqual(applyMoodEvent(state, { type: 'attention', id: 'forged', kind: 'motion', claimed: forged }, now + 4_000, p).cue?.id, 'forged');
  const other = { ...state, cue: { id: 'other', kind: 'look' as const, at: now, until: now + 3_000 } };
  assert.equal(applyMoodEvent(other, { type: 'attention', id: 'over', kind: 'motion', claimed }, now + 1_000, p).cue?.id, 'other');
  assert.throws(() => applyMoodEvent(state, { type: 'attention', id: 'say', kind: 'speech', claimed }, now + 1_000, p));
  assert.throws(() => applyMoodEvent(state, { type: 'attention', id: 'bad', kind: 'look', claimed: { id: 'm1', kind: 'look', at: now } as never }, now + 1_000, p));
  assert.throws(() => applyMoodEvent(state, { type: 'chat', id: 'chat', claimed } as never, now + 1_000, p));
});

test('a speech claim realized as a motion still respects the motion interval', () => {
  const now = 10_000_000;
  let state = accept(bored(now - 2 * MINUTE), 'motion', 'm0', now - 2 * MINUTE);
  state = advanceMood(state, now, { online: true }, p);
  state = accept(state, 'speech', 's1', now);
  const claimed = { id: 's1', kind: 'speech' as const, at: now };
  assert.equal(applyMoodEvent(state, { type: 'attention', id: 'mv', kind: 'motion', claimed }, now + 2_000, p).cue?.id, 's1', 'motion was 2 minutes ago');
  assert.equal(applyMoodEvent(state, { type: 'attention', id: 'lk', kind: 'look', claimed }, now + 2_000, p).cue?.id, 'lk');
});

test('an unspoken speech claim returns its hourly and unanswered quota but keeps the cooldown', () => {
  const now = 10_000_000;
  const before = bored(now);
  const state = accept(before, 'speech', 's1', now);
  assert.equal(state.speechTimes.length, 1); assert.equal(state.unansweredSpeech, 1);
  assert.equal(canRequestAmbientSpeech(state, source, now + 1_000, p), false, 'the audio comment shares the same quota');
  const released = releaseUnspokenSpeech(state, { id: 's1', at: now });
  assert.deepEqual(released.speechTimes, []); assert.equal(released.unansweredSpeech, 0);
  assert.equal(released.lastSpeechAt, now, 'cooldown stays: no retry every second');
  assert.equal(getMoodAttentionCandidate(released, now + 5_000, p), 'motion');
  assert.equal(canRequestAmbientSpeech(released, source, now + p.frequency.speechIntervalMs, p), true);
  assert.deepEqual(releaseUnspokenSpeech(released, { id: 's1', at: now }), released, 'a second release changes nothing');
  // A reply in between already reset the unanswered count; release does not go below it.
  const answered = applyMoodEvent(state, { type: 'chat', id: 'reply' }, now + 2_000, p);
  const afterReply = releaseUnspokenSpeech(answered, { id: 's1', at: now });
  assert.equal(afterReply.unansweredSpeech, 0); assert.deepEqual(afterReply.speechTimes, []);
  // A different (newer) opportunity is not refunded by an older claim.
  assert.deepEqual(releaseUnspokenSpeech(state, { id: 'old', at: now - 1 }), state);
});

test('a spoken inner line counts for every other proactive source', () => {
  const now = 10_000_000;
  const spoken = accept(bored(now), 'speech', 's1', now);
  // Gene allows one unanswered line: no more generic or audio speech until the user answers.
  const later = advanceMood(spoken, now + 2 * p.frequency.speechIntervalMs, { online: true }, p);
  assert.notEqual(getMoodAttentionCandidate(later, later.updatedAt, p), 'speech');
  assert.equal(canRequestAmbientSpeech(later, source, later.updatedAt, p), false);
});
