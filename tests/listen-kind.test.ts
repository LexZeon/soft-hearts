// I-016's shared contract between "is it music" and "listen together" (shared/listen-kind.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { isListenKind, ListenKindHost, LISTEN_KINDS } from '../shared/listen-kind';

test('only the five kinds are accepted', () => {
  for (const kind of LISTEN_KINDS) assert.equal(isListenKind(kind), true);
  for (const bad of ['Music', 'song', '', null, 1, {}]) assert.equal(isListenKind(bad), false);
});

test('a newer revision replaces the view; an older or repeated one is ignored; listeners hear only real changes', () => {
  const host = new ListenKindHost();
  const heard: string[] = [];
  const stop = host.subscribe(view => heard.push(view.kind));
  assert.equal(host.current().kind, 'quiet');
  assert.equal(host.set({ kind: 'music', confidence: 0.8, since: 1000, revision: 1 }), true);
  assert.equal(host.set({ kind: 'show', confidence: 0.9, since: 900, revision: 1 }), false, 'same revision');
  assert.equal(host.set({ kind: 'music', confidence: 0.9, since: 1000, revision: 2 }), true, 'newer, same kind');
  assert.equal(host.set({ kind: 'talk', confidence: 2, since: 1, revision: 3 }), false, 'confidence out of range');
  assert.equal(host.set({ kind: 'show', confidence: 0.7, since: 5000, revision: 4 }), true);
  assert.deepEqual(heard, ['music', 'show']);
  stop();
  host.set({ kind: 'quiet', confidence: 1, since: 9000, revision: 5 });
  assert.deepEqual(heard, ['music', 'show'], 'unsubscribed');
  assert.deepEqual(host.current(), { kind: 'quiet', confidence: 1, since: 9000, revision: 5 });
});
