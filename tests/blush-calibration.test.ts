import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlushCalibrationStore, createTrustedPackedModel, MAX_BLUSH_CALIBRATIONS } from '../electron/blush-calibration';
import { DEFAULT_BLUSH_CALIBRATION, validateBlushCalibration, type BlushCalibration } from '../shared/blush';

const key = (index: number) => index.toString(16).padStart(64, '0');
const calibration = (patch: Partial<BlushCalibration> = {}): BlushCalibration => ({ ...DEFAULT_BLUSH_CALIBRATION, ...patch });
async function withStore(run: (store: BlushCalibrationStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'soft-blush-calibration-test-'));
  try {
    const store = new BlushCalibrationStore(directory); await store.load(); await run(store, directory); await store.flush();
  } finally { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('soft-blush-calibration-test-')); await rm(directory, { recursive: true, force: true }); }
}

async function packedFixture(directory: string, synchronizedSnapshots = 0) {
  const archive = path.join(directory, 'app.asar'), entry = 'assets/bundled/reviewed/model/gene.pmx';
  const model = path.join(archive, ...entry.split('/')), body = Buffer.from('Reviewed packed model bytes');
  await writeFile(archive, 'A physical archive fixture, not an Electron process');
  let generation = 0n, inode = 100n, reads = 0, reportedFile = true;
  let reportedSize = BigInt(body.length);
  const physical = {
    realpath,
    lstat: async (file: string) => {
      const info = await lstat(file, { bigint: true });
      return file === archive ? Object.assign(Object.create(info) as BigIntStats, { ctimeNs: info.ctimeNs + generation }) : info;
    },
  };
  const expected = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const packedModel = await createTrustedPackedModel(archive, entry, expected, physical);
  const contents = new Map([[model, body]]);
  let readBody = body;
  let onRead: (() => void) | undefined;
  let snapshotsRemaining = synchronizedSnapshots;
  let releaseSnapshots!: () => void;
  const snapshotsReady = new Promise<void>(resolve => { releaseSnapshots = resolve; });
  if (snapshotsRemaining === 0) releaseSnapshots();
  const store = new BlushCalibrationStore(directory, {
    packedModel,
    modelFiles: {
      realpath: file => contents.has(path.resolve(file)) ? Promise.resolve(path.resolve(file)) : realpath(file),
      stat: async file => {
        if (!contents.has(file)) return stat(file, { bigint: true });
        const info = await stat(archive, { bigint: true });
        // Initial callers overlap after actual I/O, before starting the hash.
        // A setImmediate alone cannot order filesystem callback completion.
        if (snapshotsRemaining > 0) {
          if (--snapshotsRemaining === 0) releaseSnapshots();
          await snapshotsReady;
        }
        return Object.assign(Object.create(info) as BigIntStats,
          { size: reportedSize, ino: ++inode, mtimeNs: inode, ctimeNs: inode, isFile: () => reportedFile });
      },
      read: file => contents.has(file) ? (async function* () {
        reads++; onRead?.();
        // Keep the read pending while concurrent callers take their own snapshots.
        await new Promise<void>(resolve => setImmediate(resolve));
        yield readBody;
      })() : createReadStream(file),
    },
  });
  await store.load();
  return { archive, entry, model, body, expected, physical, store, contents,
    get reads() { return reads; },
    replaceArchive: () => { generation++; },
    setReadBody: (value: Buffer) => { readBody = value; },
    setEntrySize: (value: bigint) => { reportedSize = value; },
    setEntryFile: (value: boolean) => { reportedFile = value; },
    onRead: (value: () => void) => { onRead = value; },
  };
}

test('first load returns detached defaults without creating a private adaptation file or leaking other model values', async () => {
  await withStore(async (store, directory) => {
    const empty = store.get(null);
    assert.deepEqual(empty, { modelKey: null, calibration: { ...DEFAULT_BLUSH_CALIBRATION }, revision: 0 });
    empty.calibration.eyeOffsetX = 0.5;
    assert.equal(store.get(null).calibration.eyeOffsetX, 0);
    assert.deepEqual(await readdir(directory), []);
    await store.set(key(1), calibration({ eyeOffsetX: 0.2, mouthOffsetY: -0.1 }));
    assert.deepEqual(store.get(key(2)).calibration, DEFAULT_BLUSH_CALIBRATION);
    assert.deepEqual(store.get(null).calibration, DEFAULT_BLUSH_CALIBRATION);
    assert.equal(store.get(key(1)).calibration.eyeOffsetX, 0.2);
  });
});

test('calibration validation rejects incomplete, unknown, nonfinite, private and out-of-range data', async () => {
  const invalid: unknown[] = [null, [], {}, { ...calibration(), role: 'NO' }, { ...calibration(), modelPath: 'C:/private.pmx' },
    { ...calibration(), eyeOffsetX: 0.5001 }, { ...calibration(), mouthOffsetY: -0.5001 },
    { ...calibration(), eyeSpacingScale: 0.49 }, { ...calibration(), eyeSpacingScale: 1.51 },
    { ...calibration(), eyeOffsetY: NaN }, { ...calibration(), eyeOffsetX: Infinity }, { ...calibration(), mouthOffsetX: '0' }];
  for (const value of invalid) assert.throws(() => validateBlushCalibration(value));
  assert.deepEqual(validateBlushCalibration(calibration({ eyeOffsetX: -0.5, eyeOffsetY: 0.5, eyeSpacingScale: 1.5, mouthOffsetX: 0.5, mouthOffsetY: -0.5 })), calibration({ eyeOffsetX: -0.5, eyeOffsetY: 0.5, eyeSpacingScale: 1.5, mouthOffsetX: 0.5, mouthOffsetY: -0.5 }));
  await withStore(async (store, directory) => {
    for (const value of invalid) assert.throws(() => store.set(key(1), value));
    for (const invalidKey of ['C:/private.pmx', 'https://example.invalid/model.pmx', '../model', '', 'a'.repeat(65), 'A'.repeat(64)]) assert.throws(() => store.set(invalidKey, calibration()));
    assert.deepEqual(await readdir(directory), []);
  });
});

test('model identities use actual bytes, follow content changes, share identical copies and never persist paths or copy assets', async () => {
  await withStore(async (store, directory) => {
    const models = path.join(directory, 'PRIVATE_MODEL_DIRECTORY'); await mkdir(models);
    const first = path.join(models, 'PRIVATE_MODEL_NAME.pmx'), duplicate = path.join(models, 'another.pmd');
    const body = Buffer.from('Original model bytes'); await writeFile(first, body); await writeFile(duplicate, body);
    const expected = createHash('sha256').update(body).digest('hex');
    const identities = await Promise.all(Array.from({ length: 8 }, () => store.keyForModel(first)));
    assert.ok(identities.every(value => value === expected));
    assert.equal(await store.keyForModel(duplicate), expected);
    const oldStat = await stat(first);
    await writeFile(first, Buffer.from('Changed! model bytes'));
    await utimes(first, oldStat.atime, oldStat.mtime);
    const changed = await store.keyForModel(first);
    assert.notEqual(changed, expected);
    await store.set(expected, calibration({ eyeOffsetX: 0.15 }));
    assert.equal(store.get(changed).calibration.eyeOffsetX, 0);
    const source = await readFile(path.join(directory, 'blush-calibrations.json'), 'utf8');
    assert.ok(!source.includes(directory) && !source.includes('PRIVATE_MODEL') && !source.includes('another.pmd'));
    assert.deepEqual(JSON.parse(source).profiles, [{ modelKey: expected, calibration: calibration({ eyeOffsetX: 0.15 }) }]);
    assert.deepEqual(await readFile(duplicate), body);
    assert.deepEqual((await readdir(directory)).sort(), ['PRIVATE_MODEL_DIRECTORY', 'blush-calibrations.json']);
    await assert.rejects(store.keyForModel('relative.pmx'));
    await assert.rejects(store.keyForModel('https://example.invalid/model.pmx'));
    await assert.rejects(store.keyForModel(path.join(models, 'missing.pmx')));
    await assert.rejects(store.keyForModel(path.join(models, 'data.json')));
  });
});

test('trusted packed entry ignores fabricated inode/time identity, shares concurrent hashes and matches an ordinary copy', async () => {
  await withStore(async (_store, directory) => {
    const f = await packedFixture(directory, 8);
    const keys = await Promise.all(Array.from({ length: 8 }, () => f.store.keyForModel(f.model)));
    assert.ok(keys.every(value => value === f.expected.sha256));
    assert.equal(f.reads, 1);
    for (let index = 0; index < 3; index++) assert.equal(await f.store.keyForModel(f.model), f.expected.sha256);
    assert.equal(f.reads, 1, 'fake entry inodes must not invalidate a stable physical archive');
    const copy = path.join(directory, 'same-content.pmx'); await writeFile(copy, f.body);
    assert.equal(await f.store.keyForModel(copy), f.expected.sha256);
    await f.store.set(keys[0], calibration({ eyeOffsetY: 0.1 }));
    const restored = new BlushCalibrationStore(directory); await restored.load();
    assert.equal(restored.get(f.expected.sha256).calibration.eyeOffsetY, 0.1);
  });
});

test('archive baseline changes invalidate cached identities until a fresh host context is created', async () => {
  await withStore(async (_store, directory) => {
    const f = await packedFixture(directory);
    assert.equal(await f.store.keyForModel(f.model), f.expected.sha256);
    f.replaceArchive();
    await assert.rejects(f.store.keyForModel(f.model), /重启 soft hearts/);
    await assert.rejects(f.store.keyForModel(f.model), /重启 soft hearts/);
    assert.equal(f.reads, 1, 'a live archive replacement must not be rehashed through cached Electron metadata');
  });
});

test('an archive changing during a shared hash rejects every waiter and never caches the result', async () => {
  await withStore(async (_store, directory) => {
    const f = await packedFixture(directory, 8);
    f.onRead(f.replaceArchive);
    const result = await Promise.allSettled(Array.from({ length: 8 }, () => f.store.keyForModel(f.model)));
    assert.ok(result.every(value => value.status === 'rejected' && /重启 soft hearts/.test(String(value.reason))));
    assert.equal(f.reads, 1);
    await assert.rejects(f.store.keyForModel(f.model), /重启 soft hearts/);
  });
});

test('only the exact trusted entry receives the packed policy; names ending in .asar retain ordinary change checks', async () => {
  await withStore(async (_store, directory) => {
    const f = await packedFixture(directory);
    const unknown = path.join(f.archive, 'assets', 'unknown.pmx'); f.contents.set(unknown, f.body);
    await assert.rejects(f.store.keyForModel(unknown), /正在变化/);
    assert.equal(f.reads, 2, 'untrusted virtual entries keep the full-stat two-attempt policy');
    const namedDirectory = path.join(directory, 'ordinary.asar'); await mkdir(namedDirectory);
    const ordinary = path.join(namedDirectory, 'model.pmx'); await writeFile(ordinary, 'Model A');
    const oldStat = await stat(ordinary), first = await f.store.keyForModel(ordinary);
    await writeFile(ordinary, 'Model B'); await utimes(ordinary, oldStat.atime, oldStat.mtime);
    assert.notEqual(await f.store.keyForModel(ordinary), first);
    await assert.rejects(createTrustedPackedModel(namedDirectory, 'model.pmx', f.expected, f.physical), /physical regular file/);
  });
});

test('unpacked counterparts are excluded at context creation and invalidate a previously cached packed identity', async () => {
  await withStore(async (_store, directory) => {
    const f = await packedFixture(directory);
    assert.equal(await f.store.keyForModel(f.model), f.expected.sha256);
    const unpacked = path.join(`${f.archive}.unpacked`, ...f.entry.split('/'));
    await mkdir(path.dirname(unpacked), { recursive: true }); await writeFile(unpacked, f.body);
    await assert.rejects(f.store.keyForModel(f.model), /重启 soft hearts/);
    await assert.rejects(createTrustedPackedModel(f.archive, f.entry, f.expected, f.physical), /重启 soft hearts/);
    assert.equal(f.reads, 1);
  });
});

test('packed type, size, byte counts and reviewed digests are checked; failed hashes are not retained', async () => {
  await withStore(async (_store, directory) => {
    const f = await packedFixture(directory);
    f.setEntrySize(BigInt(f.body.length + 1));
    await assert.rejects(f.store.keyForModel(f.model), /无法读取/);
    f.setEntrySize(BigInt(f.body.length)); f.setEntryFile(false);
    await assert.rejects(f.store.keyForModel(f.model), /无法读取/);
    assert.equal(f.reads, 0, 'wrong entry type or manifest size must be rejected before reading');
    f.setEntryFile(true);
    f.setReadBody(f.body.subarray(1));
    await assert.rejects(f.store.keyForModel(f.model), /正在变化/);
    assert.equal(f.reads, 2, 'a truncated read gets the same bounded retry as a changing file');
    f.setReadBody(Buffer.alloc(f.body.length, 0x58));
    await assert.rejects(f.store.keyForModel(f.model), /无法读取/);
    assert.equal(f.reads, 3);
    f.setReadBody(f.body);
    assert.equal(await f.store.keyForModel(f.model), f.expected.sha256);
    assert.equal(f.reads, 4);
  });
});

test('serialized atomic saves preserve distinct models and the latest update with detached inputs and outputs', async () => {
  await withStore(async (store, directory) => {
    const input = calibration({ eyeOffsetY: 0.12 });
    const first = store.set(key(1), input); input.eyeOffsetY = 0.4;
    const second = store.set(key(2), calibration({ mouthOffsetX: -0.2 }));
    const third = store.set(key(1), calibration({ eyeOffsetY: 0.25 }));
    const [view1, view2, view3] = await Promise.all([first, second, third]);
    assert.equal(view1.calibration.eyeOffsetY, 0.12); assert.equal(view2.calibration.mouthOffsetX, -0.2); assert.equal(view3.revision, 3);
    view3.calibration.eyeOffsetY = 0;
    assert.equal(store.get(key(1)).calibration.eyeOffsetY, 0.25);
    assert.equal(store.get(key(2)).calibration.mouthOffsetX, -0.2);
    const restored = new BlushCalibrationStore(directory); await restored.load();
    assert.deepEqual(restored.get(key(1)), store.get(key(1)));
    assert.deepEqual(restored.get(key(2)), store.get(key(2)));
    const unchanged = await readFile(path.join(directory, 'blush-calibrations.json'), 'utf8');
    await restored.set(key(1), calibration({ eyeOffsetY: 0.25 }));
    assert.equal(restored.get(key(1)).revision, 3);
    assert.equal(await readFile(path.join(directory, 'blush-calibrations.json'), 'utf8'), unchanged);
    assert.deepEqual(await readdir(directory), ['blush-calibrations.json']);
  });
});

test('known v1 files without revision load read-only and gain a revision only upon the next explicit save', async () => {
  await withStore(async (_store, directory) => {
    const source = JSON.stringify({ version: 1, profiles: [{ modelKey: key(1), calibration: calibration({ eyeSpacingScale: 1.2 }) }] });
    const file = path.join(directory, 'blush-calibrations.json'); await writeFile(file, source);
    const restored = new BlushCalibrationStore(directory); await restored.load();
    assert.equal(restored.get(key(1)).revision, 0); assert.equal(restored.get(key(1)).calibration.eyeSpacingScale, 1.2);
    assert.equal(await readFile(file, 'utf8'), source);
    await restored.set(key(1), calibration({ eyeSpacingScale: 1.1 }));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1);
  });
});

test('corrupt, future, private-field and duplicate profiles preserve the source, report a notice and block all saves until repaired', async () => {
  await withStore(async (_store, directory) => {
    const file = path.join(directory, 'blush-calibrations.json');
    const valid = { version: 1, profiles: [{ modelKey: key(1), calibration: calibration() }] };
    const invalid = ['BROKEN JSON', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, modelPath: 'PRIVATE_PATH' }),
      JSON.stringify({ ...valid, profiles: [...valid.profiles, ...valid.profiles] }),
      JSON.stringify({ ...valid, profiles: [{ modelKey: key(1), calibration: { ...calibration(), eyeOffsetX: null } }] }),
      JSON.stringify({ ...valid, profiles: [{ ...valid.profiles[0], characterId: 'private-role' }] })];
    for (const source of invalid) {
      await writeFile(file, source);
      const broken = new BlushCalibrationStore(directory); await broken.load();
      assert.ok(broken.get(key(1)).storageError?.includes('禁止保存'));
      assert.ok(!broken.get(key(1)).storageError?.includes('PRIVATE_PATH'));
      await assert.rejects(broken.set(key(2), calibration()));
      assert.equal(await readFile(file, 'utf8'), source);
      await writeFile(file, JSON.stringify(valid)); await broken.load();
      assert.equal(broken.get(key(1)).storageError, undefined);
      await broken.set(key(2), calibration({ mouthOffsetY: 0.1 }));
      assert.equal(broken.get(key(2)).calibration.mouthOffsetY, 0.1);
    }
  });
});

test('the 64-profile bound rejects another model without evicting old calibration or changing the file', async () => {
  await withStore(async (_store, directory) => {
    const file = path.join(directory, 'blush-calibrations.json');
    await writeFile(file, JSON.stringify({ version: 1, revision: 4, profiles: Array.from({ length: MAX_BLUSH_CALIBRATIONS }, (_, index) => ({ modelKey: key(index + 1), calibration: calibration() })) }));
    const store = new BlushCalibrationStore(directory); await store.load();
    await store.set(key(1), calibration({ mouthOffsetX: 0.2 }));
    const before = await readFile(file, 'utf8');
    await assert.rejects(store.set(key(MAX_BLUSH_CALIBRATIONS + 1), calibration()), /64/);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(store.get(key(1)).calibration.mouthOffsetX, 0.2);
    assert.equal(JSON.parse(before).profiles.length, MAX_BLUSH_CALIBRATIONS);
  });
});

test('failed replacement keeps the previous in-memory revision, cleans temporary files and permits a later retry', async () => {
  await withStore(async (store, directory) => {
    await store.set(key(1), calibration({ eyeOffsetX: 0.1 }));
    const file = path.join(directory, 'blush-calibrations.json'), preserved = path.join(directory, 'preserved-calibration.json');
    await rename(file, preserved); await mkdir(file);
    await assert.rejects(store.set(key(1), calibration({ eyeOffsetX: 0.3 })), /保存失败/);
    assert.equal(store.get(key(1)).calibration.eyeOffsetX, 0.1); assert.equal(store.get(key(1)).revision, 1);
    assert.ok(store.get(key(1)).storageError);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
    await rmdir(file); await rename(preserved, file);
    const saved = await store.set(key(1), calibration({ eyeOffsetX: 0.3 }));
    assert.equal(saved.calibration.eyeOffsetX, 0.3); assert.equal(saved.revision, 2); assert.equal(saved.storageError, undefined);
  });
});
