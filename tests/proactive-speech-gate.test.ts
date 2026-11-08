import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveSpeechGate } from '../electron/proactive-speech-gate';
import { PROACTIVE_RECENT_OPPORTUNITIES, PROACTIVE_REQUEST_LIMIT_MS } from '../shared/proactive-speech';

function fixture() {
  let now = 1_000;
  const gate = new ProactiveSpeechGate(() => now);
  gate.setScope('character-provider-model-generation');
  const opportunity = (id = 'speech-cue') => ({ scope: 'character-provider-model-generation', opportunityId: id, expiresAt: now + 60_000 });
  return { gate, opportunity, setTime: (value: number) => { now = value; } };
}

test('vision and ambient contend for one accepted opportunity and one active request', () => {
  const { gate, opportunity } = fixture();
  const vision = gate.tryAcquire(opportunity(), 'vision')!;
  assert.equal(vision.source, 'vision');
  assert.equal(gate.busy, true);
  assert.equal(gate.tryAcquire(opportunity(), 'ambient'), null);
  assert.equal(gate.tryAcquire(opportunity('another-cue'), 'ambient'), null);
  assert.equal(vision.commit(), true);
  assert.equal(gate.busy, false);
  assert.equal(vision.commit(), false);
  assert.equal(gate.tryAcquire(opportunity(), 'ambient'), null);
  gate.dispose();
});

test('a cancelled request cannot deliver or be refunded to the other source', () => {
  const { gate, opportunity } = fixture();
  const cue = opportunity();
  const lease = gate.tryAcquire(cue, 'ambient')!;
  gate.cancel('user-input');
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.commit(), false);
  assert.equal(gate.tryAcquire(cue, 'vision'), null);
  assert.equal(gate.busy, false);
  gate.dispose();
});

test('scope change aborts the owner and keeps its consumed cue identity', () => {
  const { gate, opportunity } = fixture();
  const cue = opportunity();
  const lease = gate.tryAcquire(cue, 'vision')!;
  gate.setScope('new-character');
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.commit(), false);
  assert.equal(gate.tryAcquire(cue, 'ambient'), null);
  gate.setScope(cue.scope);
  assert.equal(gate.tryAcquire(cue, 'ambient'), null);
  gate.dispose();
});

test('setting unchanged scope preserves the pending owner', () => {
  const { gate, opportunity } = fixture();
  const cue = opportunity();
  const lease = gate.tryAcquire(cue, 'vision')!;
  gate.setScope(cue.scope);
  assert.equal(lease.signal.aborted, false);
  assert.equal(lease.commit(), true);
  gate.dispose();
});

test('late asynchronous results fail at commit even without another acquisition', () => {
  const { gate, opportunity, setTime } = fixture();
  const cue = opportunity();
  const lease = gate.tryAcquire(cue, 'vision')!;
  setTime(cue.expiresAt);
  assert.equal(lease.commit(), false);
  assert.equal(lease.signal.aborted, true);
  assert.equal(gate.busy, false);
  assert.equal(gate.tryAcquire(cue, 'ambient'), null);
  gate.dispose();
});

test('invalid and expired opportunities fail closed without making an active request', () => {
  const { gate, opportunity } = fixture();
  const cue = opportunity();
  for (const candidate of [
    { ...cue, scope: 'other' }, { ...cue, opportunityId: '' },
    { ...cue, opportunityId: 'path/to/file' }, { ...cue, opportunityId: 'x'.repeat(101) },
    { ...cue, expiresAt: 1_000 }, { ...cue, expiresAt: Infinity }, { ...cue, expiresAt: NaN },
    { ...cue, expiresAt: 1_000 + PROACTIVE_REQUEST_LIMIT_MS + 1 },
  ]) assert.equal(gate.tryAcquire(candidate, 'vision'), null);
  assert.equal(gate.tryAcquire(cue, 'renderer' as 'vision'), null);
  assert.equal(gate.busy, false);
  assert.equal(gate.tryAcquire(cue, 'vision')?.commit(), true);
  gate.dispose();
});

test('bounded replay history fails closed rather than evicting unexpired cue identities', () => {
  const { gate, opportunity, setTime } = fixture();
  for (let index = 0; index < PROACTIVE_RECENT_OPPORTUNITIES; index++) {
    assert.equal(gate.tryAcquire(opportunity(`cue-${index}`), index % 2 ? 'ambient' : 'vision')?.commit(), true);
  }
  assert.equal(gate.tryAcquire(opportunity('overflow'), 'vision'), null);
  assert.equal(gate.tryAcquire(opportunity('cue-0'), 'ambient'), null);
  setTime(61_000);
  assert.equal(gate.tryAcquire(opportunity('new-after-expiry'), 'ambient')?.commit(), true);
  gate.dispose();
});

test('an old lease cannot cancel or commit a newer request', () => {
  const { gate, opportunity } = fixture();
  const first = gate.tryAcquire(opportunity('first'), 'vision')!;
  first.cancel();
  const next = gate.tryAcquire(opportunity('next'), 'ambient')!;
  first.cancel();
  assert.equal(first.commit(), false);
  assert.equal(next.signal.aborted, false);
  assert.equal(next.commit(), true);
  gate.dispose();
});

test('clock reversal cannot reopen an already expired cue', () => {
  const { gate, opportunity, setTime } = fixture();
  const cue = opportunity();
  const lease = gate.tryAcquire(cue, 'vision')!;
  setTime(cue.expiresAt + 1);
  assert.equal(gate.busy, false);
  setTime(1_000);
  assert.equal(gate.tryAcquire(cue, 'ambient'), null);
  assert.equal(lease.commit(), false);
  gate.dispose();
});

test('invalid clocks abort pending work instead of treating it as a fresh opportunity', () => {
  const { gate, opportunity, setTime } = fixture();
  const cue = opportunity();
  const lease = gate.tryAcquire(cue, 'vision')!;
  setTime(NaN);
  assert.equal(gate.busy, false);
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.commit(), false);
  assert.equal(gate.tryAcquire(cue, 'ambient'), null);
  gate.dispose();
});

test('dispose aborts pending work and permanently refuses any source', () => {
  const { gate, opportunity } = fixture();
  const lease = gate.tryAcquire(opportunity(), 'vision')!;
  gate.dispose(); gate.dispose();
  gate.setScope(opportunity().scope);
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.commit(), false);
  assert.equal(gate.tryAcquire(opportunity('new'), 'ambient'), null);
});

test('gate never mutates the host opportunity or adds a mood reward', () => {
  const { gate, opportunity } = fixture();
  const cue = Object.freeze(opportunity());
  const before = structuredClone(cue);
  const lease = gate.tryAcquire(cue, 'ambient')!;
  lease.cancel();
  assert.deepEqual(cue, before);
  assert.equal(Object.keys(lease).sort().join(','), 'cancel,commit,id,signal,source');
  gate.dispose();
});
