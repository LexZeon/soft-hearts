import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareVisionDelivery } from '../src/ui/proactive-vision-delivery';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

test('body publication finishes before presentation ack, history or speech', async () => {
  const publication = deferred<void>(), ack = deferred<boolean>(), calls: string[] = [];
  const completion = prepareVisionDelivery({
    publish: () => { calls.push('publish-streaming-body'); return publication.promise; },
    ack: () => { calls.push('request-real-receipt'); return ack.promise; },
    current: () => true,
    commit: () => { calls.push('history', 'finish-answer', 'speech'); },
    retract: () => { calls.push('retract'); },
  });
  assert.deepEqual(calls, ['publish-streaming-body']);
  publication.resolve(); await flush();
  assert.deepEqual(calls, ['publish-streaming-body', 'request-real-receipt']);
  ack.resolve(true);
  assert.equal(await completion, true);
  assert.deepEqual(calls, ['publish-streaming-body', 'request-real-receipt', 'history', 'finish-answer', 'speech']);
});

test('cancellation during publication never requests an ack or commits', async () => {
  const publication = deferred<void>(), calls: string[] = [];
  let live = true;
  const completion = prepareVisionDelivery({
    publish: () => publication.promise,
    ack: async () => { calls.push('ack'); return true; },
    current: () => live,
    commit: () => { calls.push('commit'); },
    retract: () => { calls.push('scoped-retract'); },
  });
  live = false; publication.resolve();
  assert.equal(await completion, false);
  assert.deepEqual(calls, ['scoped-retract']);
});

test('late accepted ack after cancellation or scope switch cannot commit or retract a newer offer', async () => {
  for (const switched of ['cancelled', 'new-character', 'new-provider']) {
    const ack = deferred<boolean>(), calls: string[] = [];
    let currentId = 'old-offer';
    const completion = prepareVisionDelivery({
      publish: async () => {}, ack: () => ack.promise,
      current: () => currentId === 'old-offer',
      commit: () => { calls.push('history', 'speech'); },
      retract: () => { if (currentId === 'old-offer') currentId = 'none'; },
    });
    await flush(); currentId = switched; ack.resolve(true);
    assert.equal(await completion, false);
    assert.equal(currentId, switched);
    assert.deepEqual(calls, []);
  }
});

test('publication failure never acknowledges, archives or speaks', async () => {
  const calls: string[] = [];
  assert.equal(await prepareVisionDelivery({
    publish: async () => { throw new Error('host rejected body'); },
    ack: async () => { calls.push('ack'); return true; },
    current: () => true,
    commit: () => { calls.push('archive', 'speech'); },
    retract: () => { calls.push('retract'); },
  }), false);
  assert.deepEqual(calls, ['retract']);
});

test('missing or rejected presentation receipt retracts without committing', async () => {
  for (const result of [false, new Error('reply presentation unavailable')]) {
    const calls: string[] = [];
    assert.equal(await prepareVisionDelivery({
      publish: async () => { calls.push('publish'); },
      ack: async () => { calls.push('ack'); if (result instanceof Error) throw result; return result; },
      current: () => true,
      commit: () => { calls.push('commit'); },
      retract: () => { calls.push('retract'); },
    }), false);
    assert.deepEqual(calls, ['publish', 'ack', 'retract']);
  }
});

test('already invalid offer does not publish, acknowledge or commit', async () => {
  const calls: string[] = [];
  assert.equal(await prepareVisionDelivery({
    publish: async () => { calls.push('publish'); },
    ack: async () => { calls.push('ack'); return true; },
    current: () => false,
    commit: () => { calls.push('commit'); },
    retract: () => { calls.push('retract'); },
  }), false);
  assert.deepEqual(calls, []);
});
