import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAtomicFileWriter, type AtomicFileDependencies } from '../electron/atomic-file';

const failure = (code: string) => Object.assign(new Error(`Original synthetic ${code}`), { code });
const target = path.resolve('synthetic-atomic-directory', 'settings.json');

function harness(options: { platform?: NodeJS.Platform; errors?: Error[]; cleanupError?: Error; writeError?: NodeJS.ErrnoException } = {}) {
  const files = new Map([[target, 'old complete target'], [`${target}.unrelated.tmp`, 'unrelated temporary']]);
  const writes: string[] = [], moves: string[] = [], removals: string[] = [], waits: number[] = [];
  const dependencies: AtomicFileDependencies = {
    platform: options.platform ?? 'win32',
    writeFile: async (file, data, writeOptions) => {
      assert.equal(typeof file, 'string'); assert.equal(typeof data, 'string');
      const temporary = String(file); writes.push(temporary);
      assert.equal(path.dirname(temporary), path.dirname(target));
      assert.match(path.basename(temporary), /^settings\.json\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/);
      assert.deepEqual(writeOptions, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (options.writeError?.code === 'EEXIST') {
        files.set(temporary, 'pre-existing foreign temporary'); throw options.writeError;
      }
      files.set(temporary, String(data));
      if (options.writeError) throw options.writeError;
    },
    rename: async (source, destination) => {
      assert.equal(destination, target); assert.equal(source, writes.at(-1)); moves.push(String(source));
      assert.equal(files.get(target), 'old complete target', 'a failed rename must not delete or overwrite the destination');
      assert.equal(files.get(String(source)), 'new complete target');
      const error = options.errors?.[moves.length - 1]; if (error) throw error;
      files.set(target, files.get(String(source))!); files.delete(String(source));
    },
    rm: async (file, removeOptions) => {
      assert.equal(file, writes[0]); assert.notEqual(file, target); assert.deepEqual(removeOptions, { force: true });
      removals.push(String(file)); if (options.cleanupError) throw options.cleanupError;
      files.delete(String(file));
    },
    wait: async ms => {
      waits.push(ms);
      assert.equal(files.get(target), 'old complete target', 'backoff preserves the original target');
      assert.equal(files.get(writes[0]), 'new complete target', 'retry reuses the fully written temporary');
    },
  };
  return { write: createAtomicFileWriter(dependencies), files, writes, moves, removals, waits };
}

test('Windows transient sharing locks retry only rename while the old target stays complete', async () => {
  const h = harness({ errors: [failure('EPERM'), failure('EACCES'), failure('EBUSY')] });
  await h.write(target, 'new complete target');
  assert.equal(h.writes.length, 1); assert.equal(h.moves.length, 4);
  assert.deepEqual(h.waits, [25, 50, 100]); assert.deepEqual(h.removals, []);
  assert.equal(h.files.get(target), 'new complete target'); assert.equal(h.files.has(h.writes[0]), false);
  assert.equal(h.files.get(`${target}.unrelated.tmp`), 'unrelated temporary');
});

test('a persistent Windows lock makes at most six rename attempts and 775 ms of backoff then cleans only its temporary', async () => {
  const locked = failure('EPERM'), h = harness({ errors: Array(8).fill(locked) });
  await assert.rejects(h.write(target, 'new complete target'), error => error === locked);
  assert.equal(h.writes.length, 1); assert.equal(h.moves.length, 6);
  assert.deepEqual(h.waits, [25, 50, 100, 200, 400]); assert.equal(h.waits.reduce((sum, ms) => sum + ms, 0), 775);
  assert.deepEqual(h.removals, h.writes); assert.equal(h.files.has(h.writes[0]), false);
  assert.equal(h.files.get(target), 'old complete target');
  assert.equal(h.files.get(`${target}.unrelated.tmp`), 'unrelated temporary');
});

test('non-lock errors and non-Windows platforms fail immediately without delaying or rewriting data', async () => {
  for (const [platform, code] of [['win32', 'ENOENT'], ['win32', 'EIO'], ['linux', 'EPERM'], ['darwin', 'EACCES']] as const) {
    const original = failure(code), h = harness({ platform, errors: [original] });
    await assert.rejects(h.write(target, 'new complete target'), error => error === original);
    assert.equal(h.writes.length, 1); assert.equal(h.moves.length, 1); assert.deepEqual(h.waits, []);
    assert.deepEqual(h.removals, h.writes); assert.equal(h.files.get(target), 'old complete target');
  }
});

test('cleanup failure never replaces the original rename error or removes the destination', async () => {
  const original = failure('EIO'), h = harness({ errors: [original], cleanupError: failure('EACCES') });
  await assert.rejects(h.write(target, 'new complete target'), error => error === original);
  assert.equal(h.files.get(target), 'old complete target'); assert.deepEqual(h.removals, h.writes);
  assert.equal(h.files.has(h.writes[0]), true, 'an unsuccessful cleanup is not reported as successful');
});

test('an incomplete temporary write is never renamed or retried and leaves the prior target intact', async () => {
  const original = failure('EIO'), h = harness({ writeError: original });
  await assert.rejects(h.write(target, 'new complete target'), error => error === original);
  assert.equal(h.writes.length, 1); assert.deepEqual(h.moves, []); assert.deepEqual(h.waits, []);
  assert.deepEqual(h.removals, h.writes); assert.equal(h.files.has(h.writes[0]), false);
  assert.equal(h.files.get(target), 'old complete target');
});

test('an exclusive-open collision never deletes a temporary file that this call did not create', async () => {
  const original = failure('EEXIST'), h = harness({ writeError: original });
  await assert.rejects(h.write(target, 'new complete target'), error => error === original);
  assert.deepEqual(h.moves, []); assert.deepEqual(h.removals, []); assert.deepEqual(h.waits, []);
  assert.equal(h.files.get(h.writes[0]), 'pre-existing foreign temporary'); assert.equal(h.files.get(target), 'old complete target');
});

test('successful writes use distinct same-directory UUID temporaries without a delay or target deletion', async () => {
  const h = harness({ platform: 'linux' });
  await h.write(target, 'new complete target');
  h.files.set(target, 'old complete target');
  await h.write(target, 'new complete target');
  assert.equal(new Set(h.writes).size, 2); assert.equal(h.moves.length, 2);
  assert.deepEqual(h.waits, []); assert.deepEqual(h.removals, []);
  assert.equal(h.files.get(target), 'new complete target');
});
