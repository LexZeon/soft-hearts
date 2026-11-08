import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioCaptureHost } from '../electron/audio-capture-host';
import type { AudioCaptureAck, AudioCaptureDescriptor, AudioCaptureState, ReadingCaptureToken } from '../shared/audio-capture';
import type { AudioReadingSource } from '../shared/audio-reading-toggles';

type Owner = 'pet' | 'controls';
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fixture() {
  let sequence = 0;
  const available = new Set<Owner>(['pet', 'controls']);
  const published: AudioCaptureState[] = [];
  const lost: Array<{ source: AudioReadingSource; owner: Owner; ambient: ReadingCaptureToken | null }> = [];
  const host = new AudioCaptureHost({
    available: (owner: Owner) => available.has(owner),
    publish: (state: AudioCaptureState) => { published.push(structuredClone(state)); },
    lost: (source: AudioReadingSource, owner: Owner, ambient: ReadingCaptureToken | null) => {
      lost.push({ source, owner, ambient: ambient && { ...ambient } });
    },
    id: () => `capture-${++sequence}`,
  });
  const slot = (source: AudioReadingSource) => {
    const value = host.getState().slots[source];
    assert.ok(value, `Expected a live ${source} descriptor`);
    return value;
  };
  const ack = (value: AudioCaptureDescriptor, phase: AudioCaptureAck['phase'] = 'ready') =>
    host.ack(value.owner, { id: value.id, source: value.source, revision: value.revision, phase });
  // A null broadcast retires the physical identity; its ack carries the last
  // descriptor the renderer actually received, not the global null-state counter.
  const lastDescriptor = (source: AudioReadingSource) => {
    const value = [...published].reverse().find(state => state.slots[source])?.slots[source];
    assert.ok(value);
    return value;
  };
  const acquire = (source: AudioReadingSource, epoch = 1, signal = new AbortController().signal) =>
    host.acquire({ scopeId: 'reading-scope', source, epoch, signal });
  return { host, available, published, lost, slot, ack, acquire, lastDescriptor };
}

test('all sources start off; chat controls and ambient share one microphone identity', async () => {
  const f = fixture();
  assert.deepEqual(f.host.getState().slots, { 'system-audio': null, microphone: null });
  assert.equal(f.host.setChat('controls'), 'controls');
  const chat = f.slot('microphone');
  assert.equal(chat.owner, 'controls');
  assert.equal(chat.chat, true);
  assert.equal(chat.dance, false);
  assert.equal(chat.ambient, null);
  let ready = false;
  const acquiring = f.acquire('microphone').then(value => { ready = true; return value; });
  const shared = f.slot('microphone');
  assert.equal(shared.id, chat.id);
  assert.equal(shared.owner, 'controls');
  assert.deepEqual(shared.ambient, { scopeId: 'reading-scope', source: 'microphone', epoch: 1, captureId: chat.id });
  await assert.rejects(f.acquire('microphone', 2), 'one capture cannot hold a second ambient epoch');
  assert.equal(f.slot('microphone').ambient?.epoch, 1);
  await flush();
  assert.equal(ready, false, 'ambient lease must await renderer ready');
  assert.equal(f.ack(shared), true);
  const lease = await acquiring;
  assert.equal(lease.captureId, chat.id);
  await lease.release();
  const remaining = f.slot('microphone');
  assert.equal(remaining.id, chat.id);
  assert.equal(remaining.chat, true);
  assert.equal(remaining.ambient, null);
  assert.equal(new Set(f.published.flatMap(state => state.slots.microphone?.id ?? [])).size, 1);
  assert.equal(f.host.setChat('pet'), 'controls', 'an existing microphone owner is reused');
});

test('dance and ambient share pet system audio; either consumer can leave without closing the other', async () => {
  const f = fixture();
  f.host.setDance(true);
  const first = f.slot('system-audio');
  assert.equal(first.owner, 'pet');
  assert.equal(first.dance, true);
  const acquiring = f.acquire('system-audio');
  assert.equal(f.ack(f.slot('system-audio')), true);
  const lease = await acquiring;
  assert.equal(lease.captureId, first.id);
  await lease.release();
  assert.equal(f.slot('system-audio').dance, true);
  assert.equal(f.slot('system-audio').ambient, null);
  const reacquiring = f.acquire('system-audio', 2);
  assert.equal(f.ack(f.slot('system-audio')), true);
  const secondLease = await reacquiring;
  f.host.setDance(false);
  const onlyAmbient = f.slot('system-audio');
  assert.equal(onlyAmbient.id, first.id);
  assert.equal(onlyAmbient.dance, false);
  assert.equal(onlyAmbient.ambient?.epoch, 2);
  let released = false;
  const release = secondLease.release().then(() => { released = true; });
  assert.equal(f.host.getState().slots['system-audio'], null);
  await flush();
  assert.equal(released, false);
  assert.equal(f.ack(f.lastDescriptor('system-audio'), 'released'), true);
  await release;
});

test('last release waits for the exact released ack and blocks a new physical capture', async () => {
  const f = fixture();
  const acquiring = f.acquire('microphone');
  const original = f.slot('microphone');
  assert.equal(original.owner, 'pet');
  assert.equal(f.ack(original), true);
  const lease = await acquiring;
  let released = false;
  const release = lease.release().then(() => { released = true; });
  const retired = f.lastDescriptor('microphone');
  const revision = retired.revision;
  assert.equal(f.host.getState().slots.microphone, null);
  assert.notEqual(f.host.getState().revision, revision);
  assert.throws(() => f.host.setChat('controls'));
  await assert.rejects(f.acquire('microphone', 2));
  assert.equal(f.host.ack('controls', { id: original.id, source: 'microphone', revision, phase: 'released' }), false);
  assert.equal(f.host.ack('pet', { id: original.id, source: 'microphone', revision: revision - 1, phase: 'released' }), false);
  assert.equal(f.host.ack('pet', { id: original.id, source: 'microphone', revision: f.host.getState().revision, phase: 'released' }), false);
  assert.equal(f.ack(original), false, 'late ready cannot cancel retirement');
  await flush();
  assert.equal(released, false);
  assert.equal(f.host.ack('pet', { id: original.id, source: 'microphone', revision, phase: 'released' }), true);
  await release;
  assert.equal(released, true);
  const next = f.acquire('microphone', 3);
  const replacement = f.slot('microphone');
  assert.notEqual(replacement.id, original.id);
  assert.equal(f.host.ack('pet', { id: original.id, source: 'microphone', revision, phase: 'released' }), false);
  assert.equal(f.ack(replacement), true);
  const nextLease = await next;
  const done = nextLease.release();
  assert.equal(f.ack(f.lastDescriptor('microphone'), 'released'), true);
  await done;
});

test('aborting an awaiting acquire retires it; a late ready cannot revive its epoch', async () => {
  const f = fixture(), controller = new AbortController();
  const acquiring = f.acquire('microphone', 1, controller.signal);
  const rejection = assert.rejects(acquiring);
  const pending = f.slot('microphone');
  controller.abort();
  await rejection;
  assert.equal(f.host.getState().slots.microphone, null);
  assert.equal(f.ack(pending), false);
  assert.throws(() => f.host.setChat('pet'));
  assert.equal(f.ack(f.lastDescriptor('microphone'), 'released'), true);
  const next = f.acquire('microphone', 2);
  const fresh = f.slot('microphone');
  assert.notEqual(fresh.id, pending.id);
  assert.equal(fresh.ambient?.epoch, 2);
  assert.equal(f.ack(fresh), true);
  await next;
  f.available.delete('pet');
  f.host.dropOwner('pet');
  assert.equal(f.host.getState().slots.microphone, null);
});

test('ack rejects wrong owner, stale revision and extra IPC capabilities without reading accessors', async () => {
  const f = fixture();
  const acquiring = f.acquire('microphone');
  const current = f.slot('microphone');
  const ready: AudioCaptureAck = { id: current.id, source: current.source, revision: current.revision, phase: 'ready' };
  assert.equal(f.host.ack('controls', ready), false);
  assert.equal(f.host.ack('pet', { ...ready, revision: ready.revision + 1 }), false);
  assert.equal(f.host.ack('pet', { ...ready, deviceId: 'arbitrary-device' }), false);
  assert.equal(f.host.ack('pet', { ...ready, path: 'arbitrary-path', execute: true }), false);
  let reads = 0;
  const accessor = { ...ready };
  Object.defineProperty(accessor, 'phase', { enumerable: true, get() { reads++; return 'ready'; } });
  assert.equal(f.host.ack('pet', accessor), false);
  assert.equal(reads, 0);
  assert.equal(f.host.ack('pet', ready), true);
  await acquiring;
  assert.equal(f.host.ack('pet', { ...ready, phase: 'lost', revision: ready.revision - 1 }), false);
  assert.equal(f.slot('microphone').id, current.id);
  assert.equal(f.host.ack('pet', { ...ready, phase: 'lost' }), true);
  assert.equal(f.host.getState().slots.microphone, null);
  assert.deepEqual(f.lost, [{ source: 'microphone', owner: 'pet', ambient: current.ambient }]);
});

test('a destroyed renderer clears its real owner refs and settles release without affecting another source', async () => {
  const f = fixture();
  f.host.setChat('controls');
  const acquiring = f.acquire('microphone');
  assert.equal(f.ack(f.slot('microphone')), true);
  await acquiring;
  f.host.setDance(true);
  const system = f.slot('system-audio');
  const microphone = f.slot('microphone');
  f.available.delete('controls');
  f.host.dropOwner('controls');
  assert.equal(f.host.getState().slots.microphone, null);
  assert.equal(f.slot('system-audio').id, system.id);
  assert.equal(f.slot('system-audio').dance, true);
  assert.deepEqual(f.lost, [{ source: 'microphone', owner: 'controls', ambient: microphone.ambient }]);
  assert.equal(f.ack(microphone), false);
  assert.throws(() => f.host.setChat('controls'));
  const next = f.acquire('microphone', 2);
  assert.equal(f.slot('microphone').owner, 'pet');
  assert.equal(f.ack(f.slot('microphone')), true);
  const lease = await next;
  const release = lease.release();
  f.available.delete('pet');
  f.host.dropOwner('pet');
  await release;
  assert.deepEqual(f.host.getState().slots, { 'system-audio': null, microphone: null });
});

test('clear withdraws both consumers and awaiting ambient without assuming renderer release', async () => {
  const f = fixture();
  f.host.setChat('controls');
  f.host.setDance(true);
  const acquiring = f.acquire('microphone');
  const rejected = assert.rejects(acquiring);
  const mic = f.slot('microphone'), system = f.slot('system-audio');
  f.host.clear();
  await rejected;
  assert.deepEqual(f.host.getState().slots, { 'system-audio': null, microphone: null });
  assert.equal(f.ack(mic), false);
  assert.equal(f.ack(system), false);
  assert.throws(() => f.host.setChat('pet'));
  assert.throws(() => f.host.setDance(true));
  assert.equal(f.ack(f.lastDescriptor('microphone'), 'released'), true);
  assert.equal(f.ack(f.lastDescriptor('system-audio'), 'released'), true);
  assert.equal(f.host.setChat('pet'), 'pet');
  assert.notEqual(f.slot('microphone').id, mic.id);
});
