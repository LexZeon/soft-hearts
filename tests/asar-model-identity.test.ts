// The preinstalled Mumi and One inside the app's own app.asar get a stable content identity (keyForModel) in a packaged build
// (docs/claude/2026-11-27-model-checkup-not-saved.md, second part). Electron's asar-aware fs answers stat() for an entry inside the archive
// with the current time as mtime/ctime, so the ordinary "stat, hash, stat again and compare" rule refused every such model as
// "模型文件正在变化", and everything keyed by the model's identity (the check-up, blush calibration, motion scores, …) stayed off for them.
// The fake below behaves like that fs: entries inside the archive report a new mtime/ctime on every call; the archive file itself is a real
// file on disk, read through the physical (original-fs) seam the host gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BlushCalibrationStore } from '../electron/mood/blush-calibration';
import { createOwnAppArchive } from '../electron/mood/own-app-archive';

const MUMI = 'assets/bundled/mumi/model.pmx', ONE = 'assets/bundled/one/one.vrm';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A profile-like folder with a physical app.asar, the inner files' bytes, and an asar-like fs over them. */
async function world() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-asar-identity-')));
  const archive = path.join(root, 'resources', 'app.asar');
  await mkdir(path.dirname(archive), { recursive: true });
  await writeFile(archive, 'archive v1');
  const inner = new Map<string, Buffer>([[path.join(archive, ...MUMI.split('/')), Buffer.from('mumi pmx bytes')], [path.join(archive, ...ONE.split('/')), Buffer.from('one vrm bytes')]]);
  let clock = 1_000n, reads = 0;
  const flapping = new Set<string>(); // ordinary files whose stats change between calls (a file really being written)
  const modelFiles = {
    realpath: async (file: string) => inner.has(path.resolve(file)) ? path.resolve(file) : realpath(file),
    stat: async (file: string): Promise<BigIntStats> => {
      const bytes = inner.get(file);
      if (bytes) { // Electron's asar fs: the entry's size, and "now" as its times, on every call
        clock += 1n;
        return { size: BigInt(bytes.length), mtimeNs: clock, ctimeNs: clock, ino: 1n, dev: 0n, isFile: () => true } as unknown as BigIntStats;
      }
      const info = await stat(file, { bigint: true });
      if (!flapping.has(file)) return info;
      clock += 1n;
      return Object.assign(Object.create(info) as BigIntStats, { mtimeNs: clock, ctimeNs: clock });
    },
    read: (file: string) => (async function* () { reads++; const bytes = inner.get(file); if (bytes) yield bytes; else { const { readFile } = await import('node:fs/promises'); yield await readFile(file); } })(),
  };
  const physical = { realpath, lstat: (file: string) => lstat(file, { bigint: true }) };
  const store = async (withArchive: boolean) => {
    const appArchive = withArchive ? await createOwnAppArchive(archive, physical) : undefined;
    const made = new BlushCalibrationStore(path.join(root, 'profile'), { modelFiles, ...(appArchive ? { appArchive } : {}) });
    await made.load();
    return made;
  };
  return { root, archive, inner, modelFiles, flapping, store, reads: () => reads, close: () => rm(root, { recursive: true, force: true }) };
}

test('before: the app as wired in 0.2.0 refuses the preinstalled Mumi inside its archive ("模型文件正在变化")', async () => {
  const w = await world();
  try {
    const store = await w.store(false);
    await assert.rejects(store.keyForModel(path.join(w.archive, ...MUMI.split('/'))), /模型文件正在变化/);
  } finally { await w.close(); }
});

test('Mumi and One inside the app\'s own archive: a stable key (the content\'s sha256), across calls and restarts, different for each, hashed once per process', async () => {
  const w = await world();
  try {
    const mumi = path.join(w.archive, ...MUMI.split('/')), one = path.join(w.archive, ...ONE.split('/'));
    const store = await w.store(true);
    const first = await store.keyForModel(mumi);
    assert.equal(first, sha(w.inner.get(mumi)!), 'the key is the content hash, as for every model');
    assert.equal(await store.keyForModel(mumi), first, 'the same key on the next call (the inner times changed meanwhile)');
    assert.equal(w.reads(), 1, 'read once: the second call is answered from the identity cache');
    const oneKey = await store.keyForModel(one);
    assert.equal(oneKey, sha(w.inner.get(one)!));
    assert.notEqual(oneKey, first, 'Mumi and One differ');
    const restarted = await w.store(true);
    assert.equal(await restarted.keyForModel(mumi), first, 'the same key after a restart');
  } finally { await w.close(); }
});

test('the archive changes (an update replaced the app): refused until restart in the running app, then the new content\'s key', async () => {
  const w = await world();
  try {
    const mumi = path.join(w.archive, ...MUMI.split('/'));
    const store = await w.store(true);
    const before = await store.keyForModel(mumi);
    await writeFile(w.archive, 'archive v2, a different size');
    w.inner.set(mumi, Buffer.from('mumi pmx bytes, a newer version'));
    await assert.rejects(store.keyForModel(mumi), /重启 soft hearts/, 'the running app does not trust an archive that changed under it');
    const restarted = await w.store(true);
    const after = await restarted.keyForModel(mumi);
    assert.notEqual(after, before);
    assert.equal(after, sha(w.inner.get(mumi)!));
  } finally { await w.close(); }
});

test('only the app\'s OWN archive: a user\'s model in a folder named app.asar keeps the strict rule; so does an entry with an unpacked twin', async () => {
  const w = await world();
  try {
    const store = await w.store(true);
    // A user's folder that happens to be called app.asar, elsewhere on the disk, whose file is being written (its stats change).
    const userModel = path.join(w.root, 'models', 'app.asar', 'mine.pmx');
    await mkdir(path.dirname(userModel), { recursive: true }); await writeFile(userModel, 'user pmx');
    w.flapping.add(userModel);
    await assert.rejects(store.keyForModel(userModel), /模型文件正在变化/, 'the name "app.asar" in a path grants nothing');
    w.flapping.delete(userModel);
    assert.equal(await store.keyForModel(userModel), sha(Buffer.from('user pmx')), 'the same file, no longer changing, is read as before');
    // An entry the archive keeps unpacked on the real disk is a real file: the strict rule applies to it.
    const unpackedTwin = path.join(`${w.archive}.unpacked`, ...MUMI.split('/'));
    await mkdir(path.dirname(unpackedTwin), { recursive: true }); await writeFile(unpackedTwin, 'unpacked');
    const fresh = await w.store(true);
    await assert.rejects(fresh.keyForModel(path.join(w.archive, ...MUMI.split('/'))), /模型文件正在变化/);
  } finally { await w.close(); }
});

test('an ordinary model file that really changes between the two stats is still refused', async () => {
  const w = await world();
  try {
    const store = await w.store(true);
    const file = path.join(w.root, 'models', 'ordinary.pmx');
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'ordinary');
    w.flapping.add(file);
    await assert.rejects(store.keyForModel(file), /模型文件正在变化/);
  } finally { await w.close(); }
});

test('the archive capability is made only for a physical .asar file', async () => {
  const w = await world();
  try {
    const physical = { realpath, lstat: (file: string) => lstat(file, { bigint: true }) };
    await assert.rejects(createOwnAppArchive(path.dirname(w.archive), physical), /app archive/);
    await assert.rejects(createOwnAppArchive('relative/app.asar', physical), /app archive/);
    const other = path.join(w.root, 'not-an-archive.bin'); await writeFile(other, 'x');
    await assert.rejects(createOwnAppArchive(other, physical), /app archive/);
  } finally { await w.close(); }
});
