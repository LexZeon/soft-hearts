import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraSampleBroker } from '../electron/camera-sample';

const jpeg = 'data:image/jpeg;base64,YQ==';

test('camera samples require the exact live request identity and consent owner', async () => {
  const sent: { owner: number; id: string }[] = [];
  const broker = new CameraSampleBroker((owner, id) => sent.push({ owner, id }));
  const sample = broker.request(71, new AbortController().signal);
  assert.equal(sent.length, 1); assert.equal(sent[0].owner, 71);
  assert.match(sent[0].id, /^camera-[a-f0-9-]+$/);
  assert.equal(broker.accept(72, sent[0].id, jpeg), false);
  assert.equal(broker.accept(71, 'another-id', jpeg), false);
  assert.equal(broker.accept(71, sent[0].id, jpeg), true);
  assert.deepEqual(await sample, { source: 'camera', dataUrl: jpeg });
  assert.equal(broker.accept(71, sent[0].id, jpeg), false);
});

test('camera broker stores no unsolicited frame and rejects invalid or oversized payloads', async () => {
  let id = '';
  const broker = new CameraSampleBroker((_owner, request) => { id = request; });
  assert.equal(broker.accept(71, 'unsolicited', jpeg), false);
  const sample = broker.request(71, new AbortController().signal);
  for (const data of [null, jpeg.replace('jpeg', 'png'), 'file:///private.png', 'data:image/jpeg;base64,!', 'data:image/jpeg;base64,' + 'A'.repeat(4_000_000)])
    assert.equal(broker.accept(71, id, data), false);
  assert.equal(broker.accept(71, id, jpeg), true); assert.ok(await sample);
});

test('camera acquisition has a two-second deadline and late pixels cannot fulfill the next request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ids: string[] = [];
  const broker = new CameraSampleBroker((_owner, id) => ids.push(id));
  const first = broker.request(71, new AbortController().signal);
  let complete = false; void first.then(() => { complete = true; });
  t.mock.timers.tick(1999); await Promise.resolve(); assert.equal(complete, false);
  t.mock.timers.tick(1); assert.equal(await first, null);
  const second = broker.request(71, new AbortController().signal);
  assert.notEqual(ids[1], ids[0]);
  assert.equal(broker.accept(71, ids[0], jpeg), false);
  assert.equal(broker.accept(71, ids[1], jpeg), true); assert.ok(await second);
});

test('camera broker never overlaps or queues multiple sampling requests', async () => {
  let count = 0, id = '';
  const broker = new CameraSampleBroker((_owner, next) => { count++; id = next; });
  const first = broker.request(71, new AbortController().signal);
  assert.equal(await broker.request(71, new AbortController().signal), null);
  assert.equal(await broker.request(72, new AbortController().signal), null); assert.equal(count, 1);
  broker.accept(71, id, jpeg); assert.ok(await first);
});

test('caller abort and context cancellation immediately release sampling without late reuse', async () => {
  for (const reason of ['caller', 'context'] as const) {
    let id = '', count = 0;
    const broker = new CameraSampleBroker((_owner, next) => { id = next; count++; });
    const controller = new AbortController(); const first = broker.request(71, controller.signal), oldId = id;
    if (reason === 'caller') controller.abort(); else broker.cancel();
    assert.equal(await first, null); assert.equal(broker.accept(71, oldId, jpeg), false);
    const second = broker.request(72, new AbortController().signal); assert.equal(count, 2);
    assert.equal(broker.accept(71, oldId, jpeg), false); assert.equal(broker.accept(72, id, jpeg), true); assert.ok(await second);
  }
});

test('already-aborted requests and unavailable windows do not hang or initiate a retry', async () => {
  let sends = 0;
  const broker = new CameraSampleBroker(() => { sends++; throw new Error('window gone'); });
  const controller = new AbortController(); controller.abort();
  assert.equal(await broker.request(71, controller.signal), null); assert.equal(sends, 0);
  assert.equal(await broker.request(71, new AbortController().signal), null); assert.equal(sends, 1);
  broker.cancel();
});
