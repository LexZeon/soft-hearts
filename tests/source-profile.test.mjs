// The stable version keeps the real profile; tests always use an isolated temporary one. Source runs
// (start-soft-hearts.cmd's usual start, pnpm dev, pnpm start) use the development profile, seeded once from stable,
// and never write into stable. Synthetic profiles in a temporary folder only; the user's %APPDATA% is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { asciiJson, prepareSourceProfile } from '../scripts/source-profile.mjs';
import { DEVELOPMENT_PROFILE_FOLDER, PROFILE_FOLDER, prepareProfileDirectory } from '../electron/profile.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

async function snapshot(directory) {
  const rows = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name), name = path.relative(directory, file).replaceAll('\\', '/');
      if (entry.isDirectory()) { rows.push([name + '/', 'dir']); await visit(file); }
      else rows.push([name, createHash('sha256').update(await readFile(file)).digest('hex')]);
    }
  }
  await visit(directory); return rows;
}
async function fixture(body) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-source-profile-')));
  try {
    const appData = path.join(temporary, 'Roaming'), workspace = path.join(temporary, 'AI桌宠-Claude');
    const stable = path.join(appData, 'soft-hearts-claude');
    const files = {
      'settings.json': JSON.stringify({ tts: { provider: 'bailian' }, ttsApiKeyEncrypted: 'djEwc3ludGhldGlj' }),
      'Local State': JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI synthetic wrapped key').toString('base64') } }),
      'characters.json': '{"cards":["synthetic"]}', 'memories.jsonl': '{"m":1}\n',
      'user-profiles/profile-a.json': '{"points":["synthetic"]}', 'diary/2026-11-02.json': '{"text":"synthetic"}',
      'Cache/data_0': 'chromium cache',
    };
    for (const [name, bytes] of Object.entries(files)) { await mkdir(path.dirname(path.join(stable, name)), { recursive: true }); await writeFile(path.join(stable, name), bytes); }
    await mkdir(workspace, { recursive: true });
    await body({ temporary, appData, workspace, stable, environment: { APPDATA: appData } });
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('soft-hearts-source-profile-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

test('a source run gets the development profile, seeded once from stable, and stable stays byte-identical', async () => fixture(async ({ appData, workspace, stable, environment }) => {
  const before = await snapshot(stable), development = path.join(appData, 'soft-hearts-claude-dev');
  const first = await prepareSourceProfile(workspace, environment);
  assert.equal(first.directory, development);
  assert.equal(first.argument, '--user-data-dir=' + development);
  assert.ok(first.seeded.files > 0);
  assert.match(first.message, /第一次创建开发配置/); assert.ok(first.message.includes(development));
  for (const name of ['settings.json', 'Local State', 'characters.json', 'memories.jsonl', 'user-profiles/profile-a.json', 'diary/2026-11-02.json'])
    assert.deepEqual(await readFile(path.join(development, name)), await readFile(path.join(stable, name)), name);
  assert.deepEqual(await snapshot(stable), before, 'preparing the source profile writes nothing into stable');
  // She keeps living in stable; the next source run neither copies again nor writes into stable.
  await writeFile(path.join(stable, 'memories.jsonl'), '{"m":1}\n{"m":2}\n');
  const later = await snapshot(stable);
  const second = await prepareSourceProfile(workspace, environment);
  assert.equal(second.directory, development); assert.equal(second.seeded, null); assert.equal(second.message, null);
  assert.equal(await readFile(path.join(development, 'memories.jsonl'), 'utf8'), '{"m":1}\n', 'seeded once, never again');
  assert.deepEqual(await snapshot(stable), later);
  // Changes in development never travel back.
  await writeFile(path.join(development, 'settings.json'), 'changed in development');
  await prepareSourceProfile(workspace, environment);
  assert.deepEqual(await snapshot(stable), later);
}));

test('the source app resolves the development folder; the stable profile is refused outside the stable channel', async () => fixture(async ({ appData, workspace, stable, environment }) => {
  assert.equal(PROFILE_FOLDER, 'soft-hearts-claude'); assert.equal(DEVELOPMENT_PROFILE_FOLDER, 'soft-hearts-claude-dev');
  const before = await snapshot(stable);
  const { directory } = await prepareSourceProfile(workspace, environment);
  // What electron/main.ts does with the switch the launchers pass.
  assert.equal(prepareProfileDirectory(appData, directory), directory);
  // A bare `electron .` without the switch still lands in development, never in stable.
  assert.equal(prepareProfileDirectory(appData), path.join(appData, 'soft-hearts-claude-dev'));
  for (const spelling of [stable, stable + path.sep, process.platform === 'win32' ? stable.toUpperCase() : stable])
    assert.throws(() => prepareProfileDirectory(appData, spelling), /Only the installed stable channel/, spelling);
  assert.equal(prepareProfileDirectory(appData, stable, true), stable, 'the verified stable channel keeps the real profile');
  assert.deepEqual(await snapshot(stable), before);
}));

test('the command-line helper prints ASCII-only JSON that names the development folder, from a non-ASCII workspace', async () => fixture(async ({ temporary, appData, workspace, stable }) => {
  for (const file of ['scripts/source-profile.mjs', 'scripts/lib/desktop-profiles.mjs', 'scripts/lib/app-identity.mjs']) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true }); await cp(path.join(root, file), path.join(workspace, file));
  }
  const before = await snapshot(stable);
  const helper = path.join(workspace, 'scripts', 'source-profile.mjs');
  const env = { ...process.env, APPDATA: appData };
  delete env.ELECTRON_RUN_AS_NODE;
  const first = await run(process.execPath, [helper], { cwd: temporary, env, windowsHide: true });
  assert.ok([...first.stdout].every(character => character.charCodeAt(0) < 0x80), 'ASCII only');
  assert.equal(first.stdout.trim().split('\n').length, 1);
  const answer = JSON.parse(first.stdout);
  assert.equal(answer.directory, path.join(appData, 'soft-hearts-claude-dev'));
  assert.match(answer.message, /第一次创建开发配置/);
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'release', 'desktop-development-profile.json'), 'utf8')), { version: 1, directory: answer.directory });
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'release', 'desktop-profile.json'), 'utf8')), { version: 1, directory: stable });
  assert.equal(JSON.parse((await run(process.execPath, [helper], { cwd: temporary, env, windowsHide: true })).stdout).message, null);
  assert.deepEqual(await snapshot(stable), before);
}));

test('ASCII JSON escapes every non-ASCII character and reads back unchanged', () => {
  const value = { directory: 'C:\\Users\\a\\OneDrive\\Docs\\soft-hearts-next', message: '第一次 😀 "quoted"' };
  const text = asciiJson(value);
  assert.ok([...text].every(character => character.charCodeAt(0) < 0x80));
  assert.deepEqual(JSON.parse(text), value);
});

test('the launchers pass that profile: start-soft-hearts.cmd (setup.ps1), pnpm dev and pnpm start', async () => {
  const setup = await readFile(path.join(root, 'scripts', 'setup.ps1'), 'latin1');
  assert.ok(setup.includes("& $node.Path (Join-Path $projectRoot 'scripts\\source-profile.mjs')"));
  assert.ok(setup.includes(`('"--user-data-dir=' + $sourceProfile + '"')`));
  const start = /function Start-SourceApp \{[\s\S]*?\n\}/.exec(setup)?.[0] ?? '';
  assert.ok(start.indexOf('Get-SourceProfile') > 0 && start.indexOf('Get-SourceProfile') < start.indexOf('Start-Process'), 'prepared before the app starts');
  const dev = await readFile(path.join(root, 'scripts', 'dev.mjs'), 'utf8');
  assert.ok(dev.includes('import { prepareSourceProfile } from "./source-profile.mjs";'));
  assert.match(dev, /spawn\(electron, \[root, profile\.argument\]/);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.dev, 'node scripts/dev.mjs');
  assert.equal(pkg.scripts.start, 'node scripts/source-profile.mjs --start');
});
