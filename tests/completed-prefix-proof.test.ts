import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletedPrefixProof, type CompletedPrefixSnapshot } from '../electron/completed-prefix-proof';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let snapshot: CompletedPrefixSnapshot = { text: '', revision: 0, ready: false, ownerCurrent: true };
  let nativeCurrent = '';
  const attempts: Array<{ text: string; signal: AbortSignal; result: ReturnType<typeof deferred<boolean>> }> = [];
  const commits: string[] = [];
  const proof = new CompletedPrefixProof({
    snapshot: () => ({ ...snapshot }), current: text => nativeCurrent === text,
    waitExact: (text, signal) => { const result = deferred<boolean>(); attempts.push({ text, signal, result }); return result.promise; },
  });
  return { proof, attempts, commits, set: (value: CompletedPrefixSnapshot) => { snapshot = value; },
    native: (value: string) => { nativeCurrent = value; }, commit: (value: string) => { commits.push(value); return true; } };
}
const state = (text: string, revision: number, ready = true, ownerCurrent = true): CompletedPrefixSnapshot => ({ text, revision, ready, ownerCurrent });
async function flush() { await Promise.resolve(); await Promise.resolve(); }

test('empty and short prefixes stay pending; a stale native proof cannot approve a newer prefix', async () => {
  const f = fixture(), controller = new AbortController(); let settled = false;
  const result = f.proof.wait('第一句。第二句。', 4, controller.signal, 5000, f.commit).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false); assert.equal(f.attempts.length, 0);
  f.set(state('第一', 1)); f.proof.changed(); await flush(); assert.equal(settled, false); assert.equal(f.attempts.length, 0);
  f.set(state('第一句。', 2)); f.proof.changed(); assert.equal(f.attempts.length, 1);
  f.set(state('第一句。第二句。', 3)); f.proof.changed(); assert.equal(f.attempts.length, 2);
  assert.equal(f.attempts[0].signal.aborted, true);
  f.attempts[0].result.resolve(true); await flush(); assert.equal(settled, false); assert.deepEqual(f.commits, []);
  f.native('第一句。第二句。'); f.attempts[1].result.resolve(true);
  assert.equal(await result, true); assert.deepEqual(f.commits, ['第一句。第二句。']);
  f.proof.changed(); assert.equal(f.commits.length, 1);
});

test('a consumed but still current native proof can be reused for a new lease', async () => {
  const f = fixture(), controller = new AbortController();
  f.set(state('第一句。第二句。', 1)); f.native('第一句。第二句。');
  assert.equal(await f.proof.wait('第一句。第二句。', 4, controller.signal, 5000, f.commit), true);
  assert.equal(await f.proof.wait('第一句。第二句。', 8, controller.signal, 5000, f.commit), true);
  assert.equal(f.attempts.length, 0); assert.deepEqual(f.commits, ['第一句。第二句。', '第一句。第二句。']);
});

test('foreign text, prefix regression, lost owner, and lease abort fail without commit', async () => {
  for (const variant of ['foreign', 'regression', 'owner', 'abort'] as const) {
    const f = fixture(), controller = new AbortController(); f.set(state('第一', 1, false));
    const result = f.proof.wait('第一句。第二句。', 4, controller.signal, 5000, f.commit);
    if (variant === 'abort') controller.abort();
    else { f.set(variant === 'foreign' ? state('别的正文', 2) : variant === 'regression' ? state('第', 2) : state('第一', 2, true, false)); f.proof.changed(); }
    assert.equal(await result, false, variant); assert.deepEqual(f.commits, []);
  }
});

test('failed exact native proof and a false commit both deny the lease', async () => {
  const f = fixture(), controller = new AbortController(); f.set(state('第一句。', 1));
  const pending = f.proof.wait('第一句。第二句。', 4, controller.signal, 5000, f.commit);
  assert.equal(f.attempts.length, 1); f.attempts[0].result.resolve(false);
  assert.equal(await pending, false); assert.deepEqual(f.commits, []);
  f.native('第一句。'); let calls = 0;
  assert.equal(await f.proof.wait('第一句。第二句。', 4, controller.signal, 5000, () => { calls++; return false; }), false);
  assert.equal(calls, 1);
});

test('one waiter retains one fixed deadline, never polls and cannot commit twice', async () => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const timers = new Map<object, () => void>(); let schedules = 0;
  globalThis.setTimeout = ((callback: () => void) => {
    const token = { unref() {} }; schedules++; timers.set(token, callback); return token;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((token: object) => { timers.delete(token); }) as unknown as typeof clearTimeout;
  const f = fixture(), controller = new AbortController();
  try {
    f.set(state('第一句。', 1));
    const pending = f.proof.wait('第一句。第二句。', 4, controller.signal, 5000, f.commit);
    assert.equal(schedules, 1); assert.equal(f.attempts.length, 1);
    for (let i = 0; i < 5; i++) f.proof.changed();
    assert.equal(schedules, 1); assert.equal(f.attempts.length, 1);
    assert.equal(await f.proof.wait('第一句。第二句。', 4, controller.signal, 5000, f.commit), false);
    assert.equal(schedules, 1); assert.equal(timers.size, 1);
    [...timers.values()][0](); assert.equal(await pending, false);
    f.native('第一句。'); f.attempts[0].result.resolve(true); await flush();
    assert.deepEqual(f.commits, []); assert.equal(timers.size, 0);
  } finally { f.proof.cancel(); globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
});
