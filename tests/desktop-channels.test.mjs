// End-to-end channel flows on synthetic files. The "product entry" below is the real desktop-channel and
// desktop-shortcut code with a fake Electron shell; no executable, PowerShell or real desktop is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInstalledDesktopChannel } from '../electron/desktop-channel.ts';
import { installOwnDesktopShortcut } from '../electron/desktop-shortcut.ts';
import { DesktopRefusal, installDevelopment, promoteDevelopment, readChannelPointer, refreshShortcuts, rollbackStable } from '../scripts/update-desktop.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const DEV_LINK = 'soft hearts next - 最新开发版.lnk', STABLE_LINK = 'soft hearts next - 稳定版.lnk';
const CODEX_LINKS = ['soft hearts.lnk', 'soft hearts - 完整交付版.lnk'];
const MANDATORY = ['tests/desktop-channel.test.ts', 'tests/desktop-entry-chain.test.ts', 'tests/desktop-shortcut.test.ts', 'tests/pin-delivery.test.ts'];

async function makeCandidate(workspace, name, version) {
  const candidate = path.join(workspace, '.local', 'desktop-updates', name), frozen = path.join(candidate, 'source');
  const bundle = path.join(frozen, 'release', 'win-arm64-unpacked');
  await mkdir(path.join(bundle, 'resources'), { recursive: true }); await mkdir(path.join(frozen, 'shared')); await mkdir(path.join(frozen, 'tests'));
  await writeFile(path.join(bundle, 'resources', 'app.asar'), 'validated app ' + version);
  await writeFile(path.join(bundle, 'soft hearts next.exe'), 'synthetic executable bytes, never run');
  await writeFile(path.join(frozen, 'shared', 'version.ts'), `export const version = ${version};`);
  for (const file of MANDATORY) await writeFile(path.join(frozen, file), '// synthetic frozen input, never executed');
  const inputs = ['shared/version.ts', ...MANDATORY].sort();
  const sourceHash = digest(JSON.stringify(await Promise.all(inputs.map(async file => [file, digest(await readFile(path.join(frozen, file)))]))));
  const prepared = { version: 1, entryKind: 'native-product-v1', sourceHash, asarSha256: digest(await readFile(path.join(bundle, 'resources', 'app.asar'))),
    executableSha256: digest(await readFile(path.join(bundle, 'soft hearts next.exe'))), inputs, unpacked: path.relative(workspace, bundle).replaceAll('\\', '/'),
    preparedAt: '2026-11-02T08:00:00.000Z', validationIdentity: { sourceHash, inputs, unitSummary: { tests: 4, pass: 4, fail: 0, skipped: 0 }, executedTestFiles: MANDATORY.length,
      unitPlan: { scope: 'native-product-and-existing-nonlegacy-v1', testFiles: MANDATORY, mandatoryProductTests: MANDATORY, legacyBlocked: [], originalLegacyScopePassed: false } } };
  const preparedBytes = Buffer.from(JSON.stringify({ ...prepared, smokePending: true }));
  const receiptBytes = Buffer.from(JSON.stringify({ version: 1, status: 'PASS', preparedSha256: digest(preparedBytes),
    identity: { entryKind: 'native-product-v1', sourceHash, asarSha256: prepared.asarSha256, executableSha256: prepared.executableSha256 },
    cleanup: { sdkCloseResolved: true, actualMainExited: true, fakeClaudeExited: true, profileRemoved: true, main: { absent: true } } }));
  await writeFile(path.join(candidate, 'prepared.json'), preparedBytes); await writeFile(path.join(candidate, 'smoke-result.json'), receiptBytes);
  // Each version is validated a minute after the previous one; rolling back goes to the newest older one.
  await writeFile(path.join(candidate, 'validated.json'), JSON.stringify({ ...prepared, safeSmoke: 1, preparedSha256: digest(preparedBytes), smokeReportSha256: digest(receiptBytes),
    validatedAt: new Date(Date.UTC(2026, 10, 2, 8, version)).toISOString() }));
  return { candidate, sourceHash };
}

async function fixture(run) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-channels-')));
  try {
    const workspace = path.join(temporary, 'AI桌宠-Claude'), desktop = path.join(temporary, 'OneDrive', 'Desktop'), appData = path.join(temporary, 'Roaming');
    const stableProfile = path.join(appData, 'soft-hearts-claude');
    for (const directory of [workspace, desktop, stableProfile, path.join(appData, 'soft-hearts')]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(stableProfile, 'settings.json'), JSON.stringify({ ttsApiKeyEncrypted: 'djEwc3ludGhldGlj' }));
    await writeFile(path.join(stableProfile, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI synthetic wrapped key').toString('base64') } }));
    await writeFile(path.join(appData, 'soft-hearts', 'settings.json'), 'Codex edition profile');
    for (const name of CODEX_LINKS) await writeFile(path.join(desktop, name), 'Codex edition link ' + name);
    const events = [], hooks = {};
    const shell = {
      writeShortcutLink(link, operation, details) { if (operation === 'replace' && !existsSync(link)) return false; writeFileSync(link, JSON.stringify(details)); return true; },
      readShortcutLink(link) { return JSON.parse(readFileSync(link, 'utf8')); },
    };
    // Stands in for "soft hearts next.exe --soft-hearts-install-desktop-entry": the same checks desktop-entry.ts runs.
    const runEntry = async (executable, args) => {
      assert.equal(args[0], '--soft-hearts-install-desktop-entry');
      const ticket = /^--soft-hearts-entry-ticket=([a-f0-9]{32})$/.exec(args[1])[1];
      const context = resolveInstalledDesktopChannel({ executable, packaged: true, platform: 'win32', defaultProfile: stableProfile });
      await mkdir(context.maintenanceProfile, { recursive: true });
      const receipt = await installOwnDesktopShortcut({ ...context, kind: 'verified-own-desktop-entry-v1', desktopDirectory: desktop }, shell);
      await writeFile(path.join(context.maintenanceProfile, `receipt-${ticket}.json`), JSON.stringify({ version: 1, ticket, processId: 4242, channel: context.channel,
        executable: context.executable, asarSha256: context.asarSha256, maintenanceProfile: context.maintenanceProfile, receipt }), { flag: 'wx' });
      await hooks.afterReceipt?.(context);
    };
    const options = { environment: { APPDATA: appData }, runEntry, log: event => events.push(event) };
    const link = name => { const file = path.join(desktop, name); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; };
    const install = async (name, version) => {
      const { candidate } = await makeCandidate(workspace, name, version);
      return installDevelopment(workspace, { ...options, sourceHash: async () => 'f'.repeat(64), prepareCandidate: async () => candidate });
    };
    await run({ workspace, desktop, appData, stableProfile, options, events, hooks, link, install });
    for (const name of CODEX_LINKS) assert.equal(await readFile(path.join(desktop, name), 'utf8'), 'Codex edition link ' + name);
    assert.equal(await readFile(path.join(appData, 'soft-hearts', 'settings.json'), 'utf8'), 'Codex edition profile');
  } finally {
    assert.equal(path.dirname(temporary), await realpath(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('soft-hearts-channels-'));
    await rm(temporary, { recursive: true, force: true });
  }
}

test('installing development creates only its own shortcut and seeds its separate profile; no stable shortcut is faked', async () => fixture(async ({ workspace, desktop, appData, stableProfile, events, link, install }) => {
  const stableSettings = await readFile(path.join(stableProfile, 'settings.json'));
  const result = await install('candidate-1', 1);
  assert.equal(result.installed, true);
  assert.deepEqual(result.refreshed.map(row => [row.channel, row.status]), [['development', 'refreshed'], ['stable', 'absent']]);
  const pointer = await readChannelPointer(workspace, 'development');
  const executable = path.join(workspace, ...pointer.manifest.executable.split('/'));
  assert.match(pointer.manifest.executable, /^release\/development\/[a-f0-9]{64}\/win-arm64-unpacked\/soft hearts next\.exe$/);
  assert.deepEqual(link(DEV_LINK), { target: executable, cwd: path.dirname(executable), args: '--soft-hearts-channel=development',
    description: 'soft hearts next · 最新开发版', icon: executable, iconIndex: 0, appUserModelId: 'io.softhearts.next.dev' });
  assert.equal(link(STABLE_LINK), null);
  assert.deepEqual((await readdir(desktop)).sort(), [...CODEX_LINKS, DEV_LINK].sort());
  assert.equal(await readChannelPointer(workspace, 'stable'), null);
  // Profiles: stable is the existing folder; development is separate and was seeded exactly once.
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'release', 'desktop-profile.json'), 'utf8')), { version: 1, directory: stableProfile });
  const developmentProfile = path.join(appData, 'soft-hearts-claude-dev');
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'release', 'desktop-development-profile.json'), 'utf8')), { version: 1, directory: developmentProfile });
  assert.deepEqual(await readFile(path.join(developmentProfile, 'settings.json')), stableSettings);
  assert.ok(existsSync(path.join(developmentProfile, 'Local State')));
  assert.deepEqual(await readFile(path.join(stableProfile, 'settings.json')), stableSettings);
  assert.deepEqual(events.map(event => event.event), ['preparing', 'seeded', 'selected']);
  assert.equal(events[1].secretKey, true); assert.equal(events[1].secretsNeedReentry, false);
}));

test('an up-to-date development version is not rebuilt, and a deleted shortcut comes back', async () => fixture(async ({ workspace, desktop, options, link, install }) => {
  await install('candidate-1', 1);
  const pointer = await readChannelPointer(workspace, 'development');
  await rm(path.join(desktop, DEV_LINK));
  const result = await installDevelopment(workspace, { ...options, sourceHash: async () => pointer.manifest.buildId,
    prepareCandidate: async () => { throw Error('must not rebuild an up-to-date development version'); } });
  assert.equal(result.installed, false);
  assert.equal(link(DEV_LINK).args, '--soft-hearts-channel=development');
  assert.equal(link(STABLE_LINK), null);
}));

test('promotion refuses clearly and changes nothing without a tested development version', async () => fixture(async ({ workspace, desktop, options, install }) => {
  await assert.rejects(promoteDevelopment(workspace, options), error => error instanceof DesktopRefusal && error.code === 'NO_DEVELOPMENT');
  assert.ok(!existsSync(path.join(workspace, 'release')));
  await install('candidate-1', 1);
  const releaseBefore = (await readdir(path.join(workspace, 'release'))).sort();
  await rm(path.join(workspace, '.local', 'desktop-updates', 'candidate-1'), { recursive: true });
  await assert.rejects(promoteDevelopment(workspace, options), error => error instanceof DesktopRefusal && error.code === 'NO_CANDIDATE');
  assert.deepEqual((await readdir(path.join(workspace, 'release'))).sort(), releaseBefore);
  assert.deepEqual((await readdir(desktop)).sort(), [...CODEX_LINKS, DEV_LINK].sort());
}));

test('promotion copies the tested development build to stable with the user profile, and a later promotion archives the replaced link', async () => fixture(async ({ workspace, desktop, options, link, install }) => {
  await install('candidate-1', 1);
  const devLinkV1 = link(DEV_LINK);
  const first = await promoteDevelopment(workspace, options);
  assert.equal(first.promoted, true); assert.equal(first.selected.history, null);
  const stable = await readChannelPointer(workspace, 'stable'), development = await readChannelPointer(workspace, 'development');
  assert.match(stable.manifest.executable, /^release\/stable\/[a-f0-9]{64}\/win-arm64-unpacked\/soft hearts next\.exe$/);
  assert.equal(stable.manifest.buildId, development.manifest.buildId);
  assert.equal(link(STABLE_LINK).target, stable.executable);
  assert.equal(link(STABLE_LINK).args, '--soft-hearts-channel=stable');
  assert.equal(link(STABLE_LINK).appUserModelId, 'io.softhearts.next');
  assert.deepEqual(link(DEV_LINK), devLinkV1);
  assert.equal((await promoteDevelopment(workspace, options)).promoted, false);
  const stableLinkV1 = await readFile(path.join(desktop, STABLE_LINK));
  await install('candidate-2', 2);
  assert.notEqual(link(DEV_LINK).target, devLinkV1.target);
  assert.equal(link(STABLE_LINK).target, stable.executable, 'a development update never moves stable');
  const second = await promoteDevelopment(workspace, options);
  assert.equal(second.promoted, true);
  assert.equal(link(STABLE_LINK).target, (await readChannelPointer(workspace, 'stable')).executable);
  const history = path.join(workspace, second.selected.history.directory);
  assert.deepEqual(await readFile(path.join(history, 'desktop-delivered.json')), stable.bytes);
  assert.deepEqual(await readFile(path.join(history, 'complete-delivery.lnk')), stableLinkV1);
}));

test('a failed stable commit puts the replaced stable link back, or removes a first one, and keeps the old pointer', async () => fixture(async ({ workspace, desktop, options, hooks, link, install }) => {
  await install('candidate-1', 1);
  const reference = path.join(workspace, 'release', 'desktop-profile.json');
  const breakCommit = async () => { await writeFile(reference, (await readFile(reference, 'utf8')) + ' '); }; // Same folder, different bytes.
  hooks.afterReceipt = breakCommit;
  await assert.rejects(promoteDevelopment(workspace, options), /normal profile reference changed/);
  assert.equal(link(STABLE_LINK), null, 'a first stable link is removed again');
  assert.equal(await readChannelPointer(workspace, 'stable'), null);
  hooks.afterReceipt = undefined;
  await promoteDevelopment(workspace, options);
  const before = await readFile(path.join(desktop, STABLE_LINK)), pointer = await readFile(path.join(workspace, 'release', 'desktop-delivered.json'));
  await install('candidate-2', 2);
  hooks.afterReceipt = breakCommit;
  await assert.rejects(promoteDevelopment(workspace, options), /normal profile reference changed/);
  assert.deepEqual(await readFile(path.join(desktop, STABLE_LINK)), before);
  assert.deepEqual(await readFile(path.join(workspace, 'release', 'desktop-delivered.json')), pointer);
  const failures = [];
  for (const name of await readdir(path.join(workspace, '.local', 'desktop-updates', 'candidate-2'))) if (name.endsWith('-failure.json'))
    failures.push(JSON.parse(await readFile(path.join(workspace, '.local', 'desktop-updates', 'candidate-2', name), 'utf8')).shortcutState);
  assert.deepEqual(failures, ['PREVIOUS_BYTES_RESTORED']);
}));

test('a broken stable version is reported on its own and never blocks the development shortcut', async () => fixture(async ({ workspace, desktop, options, link, install }) => {
  await install('candidate-1', 1);
  await promoteDevelopment(workspace, options);
  const stable = await readChannelPointer(workspace, 'stable'), stableLink = await readFile(path.join(desktop, STABLE_LINK));
  await writeFile(stable.executable, 'changed after promotion');
  await rm(path.join(desktop, DEV_LINK));
  const development = await readChannelPointer(workspace, 'development');
  const result = await installDevelopment(workspace, { ...options, sourceHash: async () => development.manifest.buildId, prepareCandidate: async () => { throw Error('no rebuild'); } });
  assert.deepEqual(result.refreshed.map(row => [row.channel, row.status]), [['stable', 'failed'], ['development', 'refreshed']]);
  assert.match(result.refreshed[0].error, /bytes changed/);
  assert.equal(link(DEV_LINK).args, '--soft-hearts-channel=development');
  assert.deepEqual(await readFile(path.join(desktop, STABLE_LINK)), stableLink);
}));

test('refreshing never creates a stable shortcut that has no stable version', async () => fixture(async ({ workspace, options, link, install }) => {
  assert.deepEqual(await refreshShortcuts(workspace, { runEntry: options.runEntry }), [{ channel: 'stable', status: 'absent' }, { channel: 'development', status: 'absent' }]);
  await install('candidate-1', 1);
  const rows = await refreshShortcuts(workspace, { runEntry: options.runEntry });
  assert.deepEqual(rows.map(row => [row.channel, row.status]), [['stable', 'absent'], ['development', 'refreshed']]);
  assert.equal(link(STABLE_LINK), null);
}));

// Rolling back: no rebuild, no profile change.
async function snapshot(directory) {
  const rows = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name), name = path.relative(directory, file).replaceAll('\\', '/');
      if (entry.isDirectory()) { rows.push([name + '/', 'dir']); await visit(file); } else rows.push([name, digest(await readFile(file))]);
    }
  }
  await visit(directory); return rows;
}
const refused = code => error => error instanceof DesktopRefusal && error.code === code;

test('rolling back points stable and its shortcut at the previous archived version; profiles stay byte-identical', async () => fixture(async ({ workspace, desktop, appData, stableProfile, options, events, link, install }) => {
  await install('candidate-1', 1); await promoteDevelopment(workspace, options);
  const v1 = await readChannelPointer(workspace, 'stable'), v1Link = await readFile(path.join(desktop, STABLE_LINK));
  await install('candidate-2', 2); await promoteDevelopment(workspace, options);
  const v2 = await readChannelPointer(workspace, 'stable'), development = await readChannelPointer(workspace, 'development');
  assert.notEqual(v2.manifest.versionId, v1.manifest.versionId);
  // Only the stable channel program uses the real profile; the development one uses soft-hearts-claude-dev.
  const developmentProfile = path.join(appData, 'soft-hearts-claude-dev');
  const resolve = executable => resolveInstalledDesktopChannel({ executable, packaged: true, platform: 'win32', defaultProfile: stableProfile }).profile;
  assert.equal(resolve(v2.executable), stableProfile);
  assert.equal(resolve(development.executable), developmentProfile);
  const devLink = await readFile(path.join(desktop, DEV_LINK)), reference = await readFile(path.join(workspace, 'release', 'desktop-profile.json'));
  const profiles = [await snapshot(stableProfile), await snapshot(developmentProfile)];
  const result = await rollbackStable(workspace, options);
  const now = await readChannelPointer(workspace, 'stable');
  assert.deepEqual(now.bytes, v1.bytes);
  assert.equal(result.rolledBackFrom, v2.manifest.versionId);
  assert.equal(link(STABLE_LINK).target, v1.executable);
  assert.equal(link(STABLE_LINK).args, '--soft-hearts-channel=stable');
  assert.deepEqual(await readFile(path.join(desktop, STABLE_LINK)), v1Link);
  assert.equal(resolve(now.executable), stableProfile, 'the previous version keeps the same real profile');
  assert.deepEqual(await readFile(path.join(desktop, DEV_LINK)), devLink, 'the development shortcut is not touched');
  assert.deepEqual(await readFile(path.join(workspace, 'release', 'desktop-profile.json')), reference);
  assert.deepEqual([await snapshot(stableProfile), await snapshot(developmentProfile)], profiles);
  // The version it left is archived like a promotion would, so going forward again stays possible.
  assert.deepEqual(await readFile(path.join(workspace, result.history.directory, 'desktop-delivered.json')), v2.bytes);
  assert.equal(events.at(-1).event, 'rolled-back');
  // Nothing older than the first version: refused, nothing changed.
  const before = [await snapshot(path.join(workspace, 'release')), await snapshot(desktop)];
  await assert.rejects(rollbackStable(workspace, options), refused('NO_PREVIOUS'));
  assert.deepEqual([await snapshot(path.join(workspace, 'release')), await snapshot(desktop)], before);
  // Promoting again returns to the tested development version.
  assert.equal((await promoteDevelopment(workspace, options)).promoted, true);
  assert.deepEqual((await readChannelPointer(workspace, 'stable')).bytes, v2.bytes);
  assert.equal(link(STABLE_LINK).target, v2.executable);
}));

test('rolling back is refused, with nothing changed and no program run, unless the archive and the old version check out', async () => fixture(async ({ workspace, desktop, options, install }) => {
  const runs = [];
  const watched = { ...options, runEntry: async (...args) => { runs.push(args[0]); return options.runEntry(...args); } };
  const state = async () => [await snapshot(path.join(workspace, 'release')), await snapshot(desktop)];
  const refusedUnchanged = async code => { const before = await state(); await assert.rejects(rollbackStable(workspace, watched), refused(code)); assert.deepEqual(await state(), before); assert.deepEqual(runs, []); };
  await assert.rejects(rollbackStable(workspace, watched), refused('NO_STABLE'));
  await install('candidate-1', 1); await promoteDevelopment(workspace, options);
  await refusedUnchanged('NO_PREVIOUS'); // One stable version only.
  const v1 = await readChannelPointer(workspace, 'stable');
  await install('candidate-2', 2); await promoteDevelopment(workspace, options);
  const historyRoot = path.join(workspace, 'release', 'stable-history'), [archive] = await readdir(historyRoot), history = path.join(historyRoot, archive);
  const tampered = async (file, bytes, code) => { const original = await readFile(file); await writeFile(file, bytes); await refusedUnchanged(code); await writeFile(file, original); };
  const pointer = JSON.parse(await readFile(path.join(history, 'desktop-delivered.json'), 'utf8'));
  await tampered(path.join(history, 'desktop-delivered.json'), JSON.stringify({ ...pointer, validatedAt: '2026-11-01T00:00:00.000Z' }), 'BROKEN_ARCHIVE');
  await tampered(path.join(history, 'complete-delivery.lnk'), 'a different link', 'BROKEN_ARCHIVE');
  await tampered(v1.executable, 'changed program bytes', 'BROKEN_VERSION');
  await tampered(path.join(path.dirname(v1.executable), 'resources', 'app.asar'), 'changed archive', 'BROKEN_VERSION');
  await tampered(path.join(workspace, 'release', 'stable', v1.manifest.versionId, 'stable-manifest.json'), JSON.stringify({ ...pointer, arch: 'x64' }), 'BROKEN_VERSION');
  const versionRoot = path.join(workspace, 'release', 'stable', v1.manifest.versionId);
  await rename(versionRoot, versionRoot + '-moved'); await refusedUnchanged('BROKEN_VERSION'); await rename(versionRoot + '-moved', versionRoot);
  await rename(historyRoot, historyRoot + '-moved'); await refusedUnchanged('NO_PREVIOUS'); await rename(historyRoot + '-moved', historyRoot);
  // Everything put back: the same rollback now goes through, running only the previous version's own entry.
  await rollbackStable(workspace, watched);
  assert.deepEqual(runs, [v1.executable]);
  assert.deepEqual((await readChannelPointer(workspace, 'stable')).bytes, v1.bytes);
}));

test('a failed rollback commit puts the stable shortcut back and keeps the current stable version', async () => fixture(async ({ workspace, desktop, options, hooks, install }) => {
  await install('candidate-1', 1); await promoteDevelopment(workspace, options);
  await install('candidate-2', 2); await promoteDevelopment(workspace, options);
  const link = await readFile(path.join(desktop, STABLE_LINK)), pointer = await readFile(path.join(workspace, 'release', 'desktop-delivered.json'));
  const reference = path.join(workspace, 'release', 'desktop-profile.json'), referenceBytes = await readFile(reference);
  hooks.afterReceipt = async () => { await writeFile(reference, referenceBytes.toString('utf8') + ' '); };
  await assert.rejects(rollbackStable(workspace, options), error => /normal profile reference changed/.test(error.message) && error.shortcutState === 'PREVIOUS_BYTES_RESTORED');
  assert.deepEqual(await readFile(path.join(desktop, STABLE_LINK)), link);
  assert.deepEqual(await readFile(path.join(workspace, 'release', 'desktop-delivered.json')), pointer);
  hooks.afterReceipt = undefined; await writeFile(reference, referenceBytes);
}));
