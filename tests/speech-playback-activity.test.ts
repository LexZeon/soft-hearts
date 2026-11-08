import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlaybackActivity } from '../electron/speech-playback-activity';

test('old opaque lease cannot end a reused playback ID after a scope change', () => {
  let serial = 0;
  const activity = new SpeechPlaybackActivity(() => `opaque-lease-${++serial}-value`);
  activity.setScope('character-A/model-A');
  const old = activity.begin(11, 'playback-1');
  assert.ok(old);
  activity.setScope('character-A/model-A');
  assert.equal(activity.busy, true, 'repeating the same scope preserves active playback');

  activity.setScope('character-B/model-B');
  assert.equal(activity.busy, false);
  const current = activity.begin(11, 'playback-1');
  assert.ok(current);
  assert.notEqual(current, old);
  assert.equal(activity.end(11, 'playback-1', old), false);
  assert.equal(activity.end(12, 'playback-1', current), false);
  assert.equal(activity.end(11, 'another-playback', current), false);
  assert.equal(activity.busy, true, 'stale, foreign and wrong-ID completions retain the current blocker');
  assert.equal(activity.end(11, 'playback-1', current), true);
  assert.equal(activity.end(11, 'playback-1', current), false, 'one lease ends only once');
  assert.equal(activity.busy, false);
});

test('invalid requests and duplicates do not consume capacity; four-entry cap and drop are per owner', () => {
  let generated = 0;
  const activity = new SpeechPlaybackActivity(() => `lease-${String(++generated).padStart(16, '0')}`);
  assert.equal(activity.begin(1, 'playback'), null, 'no scope grants no lease');
  activity.setScope('accepted-scope');
  for (const owner of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(activity.begin(owner, 'playback'), null);
  for (const id of ['', 'has space', '../path', 'x'.repeat(101), null, {}]) assert.equal(activity.begin(1, id), null);
  assert.equal(generated, 0);

  const firstOwner = ['one', 'two', 'three', 'four'].map(id => ({ id, lease: activity.begin(1, id) }));
  assert.ok(firstOwner.every(row => row.lease));
  assert.equal(activity.begin(1, 'one'), null);
  assert.equal(activity.begin(1, 'five'), null);
  assert.equal(generated, 4, 'rejection does not mint an opaque token');
  const secondOwner = activity.begin(2, 'one');
  assert.ok(secondOwner, 'another owner has its own capacity even with the same playback ID');
  assert.equal(activity.end(2, 'one', firstOwner[0].lease), false);
  assert.equal(activity.end(1, 'one', firstOwner[0].lease), true);
  assert.ok(activity.begin(1, 'five'), 'explicit release makes exactly one slot available');
  activity.dropOwner(1);
  assert.equal(activity.busy, true, 'dropping owner 1 cannot clear owner 2');
  assert.equal(activity.end(2, 'one', secondOwner), true);
  assert.equal(activity.busy, false);

  const badToken = new SpeechPlaybackActivity(() => 'short');
  badToken.setScope('accepted-scope');
  assert.equal(badToken.begin(1, 'one'), null);
  assert.equal(badToken.busy, false, 'invalid generated lease creates no blocker');
});

test('time alone neither releases a blocker nor reauthorizes a disposed activity', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let generated = 0;
  const activity = new SpeechPlaybackActivity(() => `held-lease-${++generated}-value`);
  activity.setScope('accepted-scope');
  const held = activity.begin(3, 'held');
  assert.ok(held);
  t.mock.timers.tick(86_400_000);
  assert.equal(activity.busy, true, 'elapsed wall time is not final PCM completion');
  assert.equal(generated, 1);

  activity.setScope('x'.repeat(8193));
  assert.equal(activity.busy, false);
  assert.equal(activity.begin(3, 'held'), null, 'oversized scope clears ownership without granting new work');
  activity.setScope('accepted-scope');
  const final = activity.begin(3, 'held');
  assert.ok(final);
  activity.dispose();
  activity.dispose();
  activity.setScope('later-scope');
  t.mock.timers.tick(86_400_000);
  assert.equal(activity.busy, false);
  assert.equal(activity.begin(3, 'new'), null);
  assert.equal(activity.end(3, 'held', final), false);
  assert.equal(activity.end(3, 'held', held), false);
  assert.equal(generated, 2, 'dispose and timers do not mint another lease');
});
