// Synthetic profiles in a temporary folder only; the user's %APPDATA% is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDevelopmentProfile, ensureStableProfileReference, renameNewFolder, seedProfile } from '../scripts/lib/desktop-profiles.mjs';

async function snapshot(directory) {
  const rows = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name), name = path.relative(directory, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) rows.push([name, 'link']);
      else if (entry.isDirectory()) { rows.push([name + '/', 'dir']); await visit(file); }
      else rows.push([name, createHash('sha256').update(await readFile(file)).digest('hex')]);
    }
  }
  await visit(directory); return rows;
}
async function fixture(run) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-profiles-')));
  try {
    const appData = path.join(temporary, 'Roaming'), workspace = path.join(temporary, 'workspace 中文');
    const stable = path.join(appData, 'soft-hearts-claude'), codex = path.join(appData, 'soft-hearts');
    await mkdir(workspace, { recursive: true });
    const files = {
      'settings.json': JSON.stringify({ tts: { provider: 'bailian' }, ttsApiKeyEncrypted: 'djEwc3ludGhldGlj' }),
      'Local State': JSON.stringify({ os_crypt: { encrypted_key: 'RFBBUEkgc3ludGhldGlj' } }),
      'characters.json': '{"cards":["synthetic"]}', 'memories.jsonl': '{"m":1}\n', 'codex-tasks.json': '{"tasks":["owned by stable"]}',
      'library/motions/user.vmd': 'synthetic motion', 'user-profiles/profile-a.json': '{}', 'character-stickers/index.json': '{}',
      // Chromium and developer data that must stay behind.
      'Preferences': '{}', 'lockfile': '', 'Cache/data_0': 'cache', 'GPUCache/index': 'gpu', 'Local Storage/leveldb/LOG': 'log',
      'blob_storage/x': 'blob', 'Crashpad/settings.dat': 'crash', 'chat/tmp.txt': 'chat scratch', 'dev/reply-latency.jsonl': '{}\n',
      'settings.json.1234.tmp': 'partial atomic write',
    };
    for (const [name, bytes] of Object.entries(files)) { await mkdir(path.dirname(path.join(stable, name)), { recursive: true }); await writeFile(path.join(stable, name), bytes); }
    for (const name of ['settings.json', 'secret.json']) { await mkdir(codex, { recursive: true }); await writeFile(path.join(codex, name), 'Codex edition data'); }
    await run({ temporary, appData, workspace, stable, codex, environment: { APPDATA: appData } });
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('soft-hearts-profiles-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

test('the stable reference points at the existing soft-hearts-claude profile and is never moved', async () => fixture(async ({ workspace, stable, codex, environment }) => {
  const before = await snapshot(stable);
  const reference = await ensureStableProfileReference(workspace, environment);
  assert.deepEqual(reference, { version: 1, directory: stable });
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'release', 'desktop-profile.json'), 'utf8')), reference);
  assert.deepEqual(await ensureStableProfileReference(workspace, { APPDATA: path.join(workspace, 'elsewhere') }), reference);
  assert.deepEqual(await snapshot(stable), before);
  await writeFile(path.join(workspace, 'release', 'desktop-profile.json'), JSON.stringify({ version: 1, directory: codex }));
  await assert.rejects(ensureStableProfileReference(workspace, environment), /Codex edition profile/);
  await rm(path.join(workspace, 'release'), { recursive: true });
  await assert.rejects(ensureStableProfileReference(workspace, {}), /APPDATA is unavailable/);
  await assert.rejects(readdir(path.join(workspace, 'release')), /ENOENT/);
}));

test('a new development profile is seeded once from stable with settings, secrets key and app data only', async () => fixture(async ({ workspace, appData, stable, codex, environment }) => {
  const stableBefore = await snapshot(stable), codexBefore = await snapshot(codex);
  const created = await ensureDevelopmentProfile(workspace, environment);
  const development = path.join(appData, 'soft-hearts-claude-dev');
  assert.equal(created.directory, development);
  assert.deepEqual(created.seeded, { files: 7, folders: ['character-stickers', 'library', 'user-profiles'], localState: true, secretKey: true, encryptedSettings: true, secretsNeedReentry: false });
  const copied = new Map(await snapshot(development)), original = new Map(stableBefore);
  for (const name of ['settings.json', 'Local State', 'characters.json', 'memories.jsonl', 'library/motions/user.vmd', 'user-profiles/profile-a.json', 'character-stickers/index.json'])
    assert.equal(copied.get(name), original.get(name), name);
  for (const name of ['Preferences', 'lockfile', 'Cache/', 'GPUCache/', 'Local Storage/', 'blob_storage/', 'Crashpad/', 'chat/', 'dev/', 'codex-tasks.json', 'settings.json.1234.tmp'])
    assert.ok(!copied.has(name), name);
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'release', 'desktop-development-profile.json'), 'utf8')), { version: 1, directory: development });
  assert.deepEqual((await readdir(appData)).sort(), ['soft-hearts', 'soft-hearts-claude', 'soft-hearts-claude-dev']);
  // Never in the other direction, and never again.
  await writeFile(path.join(development, 'settings.json'), 'changed in development');
  await writeFile(path.join(stable, 'characters.json'), '{"cards":["changed in stable later"]}');
  const again = await ensureDevelopmentProfile(workspace, environment);
  assert.equal(again.seeded, null);
  assert.equal(await readFile(path.join(development, 'settings.json'), 'utf8'), 'changed in development');
  assert.equal(await readFile(path.join(development, 'characters.json'), 'utf8'), '{"cards":["synthetic"]}');
  assert.deepEqual((await snapshot(stable)).filter(([name]) => name !== 'characters.json'), stableBefore.filter(([name]) => name !== 'characters.json'));
  assert.deepEqual(await snapshot(codex), codexBefore);
}));

test('opt-ins and live channel secrets stay with stable: no agent-channel token or socket, no R20 task switch in development', async () => fixture(async ({ workspace, appData, stable, environment }) => {
  // What a running stable app leaves in its profile once the user turned these on there.
  const token = 'a'.repeat(64);
  await writeFile(path.join(stable, 'agent-channel.json'), JSON.stringify({ version: 1, edition: 'soft-hearts-next', endpoint: '\\\\.\\pipe\\soft-hearts-next-agent-0123456789ab', token, createdAt: 'x' }));
  await mkdir(path.join(stable, 'agent-channel')); await writeFile(path.join(stable, 'agent-channel', 'agent.sock.placeholder'), '');
  await writeFile(path.join(stable, 'claude-tasks.json'), JSON.stringify({ version: 1, enabled: true }));
  await ensureDevelopmentProfile(workspace, environment);
  const copied = new Map(await snapshot(path.join(appData, 'soft-hearts-claude-dev')));
  for (const name of ['agent-channel.json', 'agent-channel/', 'claude-tasks.json']) assert.ok(!copied.has(name), name);
  for (const [, digest] of copied) assert.notEqual(digest, createHash('sha256').update(await readFile(path.join(stable, 'agent-channel.json'))).digest('hex'));
}));

test('an existing development folder is adopted without seeding, and a deleted default folder is recreated once', async () => fixture(async ({ workspace, appData, environment }) => {
  const development = path.join(appData, 'soft-hearts-claude-dev');
  await mkdir(development); await writeFile(path.join(development, 'settings.json'), 'kept development settings');
  assert.equal((await ensureDevelopmentProfile(workspace, environment)).seeded, null);
  assert.equal(await readFile(path.join(development, 'settings.json'), 'utf8'), 'kept development settings');
  await rm(development, { recursive: true });
  const recreated = await ensureDevelopmentProfile(workspace, environment);
  assert.equal(recreated.seeded.files, 7);
  assert.ok(!(await readdir(appData)).some(name => name.startsWith('.seeding-')));
}));

test('overlapping, linked or Codex development profiles are refused before anything is copied', async t => fixture(async ({ workspace, appData, stable, codex, environment }) => {
  const reference = path.join(workspace, 'release', 'desktop-development-profile.json');
  await mkdir(path.dirname(reference), { recursive: true });
  for (const [directory, pattern] of [[stable, /must be separate/], [path.join(stable, 'nested'), /must be separate/], [codex, /Codex edition profile/], [path.join(codex, 'dev'), /Codex edition profile/]]) {
    await writeFile(reference, JSON.stringify({ version: 1, directory }));
    await assert.rejects(ensureDevelopmentProfile(workspace, environment), pattern);
  }
  await writeFile(reference, JSON.stringify({ version: 1, directory: 'relative-profile' }));
  await assert.rejects(ensureDevelopmentProfile(workspace, environment), /Invalid desktop profile reference/);
  await rm(reference);
  try { await symlink(codex, path.join(appData, 'soft-hearts-claude-dev'), 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('link creation unavailable'); return; } throw error; }
  await assert.rejects(ensureDevelopmentProfile(workspace, environment), /real folder|Codex edition profile/);
  assert.equal((await lstat(path.join(appData, 'soft-hearts-claude-dev'))).isSymbolicLink(), true);
  await assert.rejects(readFile(reference), /ENOENT/);
}));

test('encrypted settings without the Local State key are reported as needing re-entry', async () => fixture(async ({ temporary, stable }) => {
  const seed = async (name, localState) => {
    if (localState === null) await rm(path.join(stable, 'Local State'), { force: true }); else await writeFile(path.join(stable, 'Local State'), localState);
    const target = path.join(temporary, name); await mkdir(target);
    return seedProfile(stable, target);
  };
  const missing = await seed('no-local-state', null);
  assert.deepEqual([missing.localState, missing.secretKey, missing.encryptedSettings, missing.secretsNeedReentry], [false, false, true, true]);
  // A Local State without Chromium's DPAPI-wrapped key cannot decrypt the copied fields either.
  for (const [name, bytes] of [['no-key', '{"os_crypt":{}}'], ['not-dpapi', JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('v10 not wrapped').toString('base64') } })], ['broken', '{']]) {
    const summary = await seed(name, bytes);
    assert.deepEqual([summary.localState, summary.secretKey, summary.secretsNeedReentry], [true, false, true], name);
  }
  await writeFile(path.join(stable, 'settings.json'), JSON.stringify({ tts: { provider: 'system' } }));
  const plain = await seed('no-secrets', null);
  assert.deepEqual([plain.encryptedSettings, plain.secretsNeedReentry], [false, false]);
}));

test('the seeded folder rename waits out a briefly busy folder but never retries over an existing one', async () => fixture(async ({ temporary }) => {
  const target = path.join(temporary, 'target'), calls = [];
  const busy = (codes) => async (from, to) => { calls.push(to); const code = codes.shift(); if (code) throw Object.assign(Error(code), { code }); };
  await renameNewFolder('from', target, { pause: () => 0, move: busy(['EPERM', 'EBUSY', 'EACCES']) });
  assert.equal(calls.length, 4);
  calls.length = 0;
  await assert.rejects(renameNewFolder('from', target, { pause: () => 0, move: busy(['ENOENT']) }), /ENOENT/);
  assert.equal(calls.length, 1, 'other errors are not retried');
  calls.length = 0;
  await assert.rejects(renameNewFolder('from', target, { attempts: 3, pause: () => 0, move: busy(['EPERM', 'EPERM', 'EPERM', 'EPERM']) }), /EPERM/);
  assert.equal(calls.length, 3, 'gives up after the attempt limit');
  calls.length = 0;
  await mkdir(target);
  await assert.rejects(renameNewFolder('from', target, { pause: () => 0, move: busy(['EPERM']) }), /EPERM/);
  assert.equal(calls.length, 1, 'a folder that appeared meanwhile is never replaced');
}));
