import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioCaptureHost } from '../electron/audio-capture-host';

test('navigation revokes consumers but cannot resolve physical release or create a replacement', async () => {
  const states: import('../shared/audio-capture').AudioCaptureState[] = [], lost: string[] = [];
  const host = new AudioCaptureHost({ available: () => true, publish: state => { states.push(state); }, lost: source => { lost.push(source); } });
  host.setChat('controls'); const first = host.getState().slots.microphone!;
  assert.equal(host.ack('controls', { source: first.source, id: first.id, revision: first.revision, phase: 'ready' }), true);
  const lease = await host.acquire({ scopeId: 'nav-revoke', source: 'microphone', epoch: 1, signal: new AbortController().signal });
  host.revokeOwner('controls');
  let done = false; const release = lease.release().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  assert.equal(host.getState().slots.microphone, null); assert.deepEqual(lost, ['microphone']);
  assert.throws(() => host.setChat('pet'), /release is still pending/);
  const final = [...states].reverse().find(state => state.slots.microphone)?.slots.microphone!;
  assert.equal(final.chat, false); assert.equal(final.ambient, null);
  assert.equal(host.ack('controls', { source: first.source, id: first.id, revision: final.revision, phase: 'released' }), true);
  await release; assert.equal(done, true);
  host.setChat('pet'); assert.notEqual(host.getState().slots.microphone!.id, first.id);
  host.revokeOwner('pet'); assert.throws(() => host.setChat('pet'), /release is still pending/);
  host.dropOwner('pet'); host.setChat('pet');
  assert.equal(host.getState().slots.microphone!.chat, true);
  host.clear(); host.dropOwner('pet');
});

test('a delayed physical-loss receipt survives metadata/off edits and releases only its own lifetime', async () => {
  const publications: unknown[] = [], losses: string[] = [];
  const host = new AudioCaptureHost({ available: () => true,
    publish: value => { publications.push(value); }, lost: source => { losses.push(source); } });
  host.setChat('pet');
  const first = host.getState().slots.microphone!;
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: first.revision, phase: 'ready' }), true);
  const lease = await host.acquire({ scopeId: 'reading-race', source: 'microphone', epoch: 1, signal: new AbortController().signal });
  host.touch('microphone'); host.setChat(null);
  assert.equal(host.getState().slots.microphone?.id, first.id, 'ambient reference still owns the same physical microphone');
  let released = false;
  const completion = lease.release().then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false); assert.equal(host.getState().slots.microphone, null);
  assert.throws(() => host.setChat('pet'), /release is still pending/);
  assert.equal(host.ack('controls', { id: first.id, source: 'microphone', revision: first.revision, phase: 'lost' }), false);
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: first.revision, phase: 'lost' }), true);
  await completion;
  assert.equal(released, true); assert.deepEqual(losses, [], 'an already-retired lease does not revoke a new logical consumer');
  host.setChat('pet');
  const replacement = host.getState().slots.microphone!;
  assert.notEqual(replacement.id, first.id);
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: first.revision, phase: 'lost' }), false);
  assert.equal(host.getState().slots.microphone!.id, replacement.id);
  assert.ok(publications.length > 2);
  host.clear(); host.dropOwner('pet');
});

test('same physical ready facts tolerate permission metadata edits, but never future or older-lifetime revisions', () => {
  const published: import('../shared/audio-capture').AudioCaptureState[] = [];
  const host = new AudioCaptureHost({ available: () => true, publish: state => { published.push(state); }, lost: () => {}, id: () => 'fixed-synthetic-id' });
  host.setChat('pet'); const first = host.getState().slots.microphone!;
  host.touch('microphone'); const latest = host.getState().slots.microphone!;
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: first.revision, phase: 'ready' }), true);
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: latest.revision + 1, phase: 'ready' }), false);
  host.setChat(null);
  const finalDescriptor = [...published].reverse().find(state => state.slots.microphone)?.slots.microphone!;
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: latest.revision, phase: 'released' }), false);
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: finalDescriptor.revision, phase: 'released' }), true);
  host.setChat('pet'); const replacement = host.getState().slots.microphone!;
  assert.equal(replacement.id, first.id, 'deliberately reused fixture ID still has a distinct revision lifetime');
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: first.revision, phase: 'ready' }), false);
  assert.equal(host.ack('pet', { id: first.id, source: 'microphone', revision: first.revision, phase: 'lost' }), false);
  assert.equal(host.getState().slots.microphone!.revision, replacement.revision);
  host.clear(); host.dropOwner('pet');
});
