// 正常退出开关 (electron/graceful-quit.ts): the asking process and the running instance, driven through a fake
// per-profile single-instance lock that behaves like Electron's (one holder per profile folder, case-insensitive on
// Windows, the second launch's argv and additionalData delivered to the holder). Nothing here starts Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInstalledDesktopChannel } from '../electron/desktop-channel';
import { QUIT_EXIT, QUIT_REQUEST, QUIT_SWITCH, onSecondInstance, quitTargetProfile, runQuitProcess, secondInstanceAction } from '../electron/graceful-quit';
import { prepareProfileDirectory, startupProfileOverride } from '../electron/profile';

const key = (directory: string) => path.resolve(directory).toLowerCase();
/** One instance per profile, like app.requestSingleInstanceLock(); the holder reacts as main.ts's second-instance does. */
class FakeLocks {
  readonly holders = new Map<string, { quits: number; shows: number; owner: string }>();
  run(profile: string, owner = '') { const instance = { quits: 0, shows: 0, owner }; this.holders.set(key(profile), instance); return instance; }
  /** The asking process: argv as the program was started, additionalData as it passed it. */
  asker(profile: string, argv = ['soft hearts next.exe', `--${QUIT_SWITCH}`]) {
    const calls: string[] = [];
    return { calls, steps: {
      profile: () => profile,
      profileExists: (directory: string) => { try { return statSync(directory).isDirectory(); } catch { return false; } },
      setProfile: (directory: string) => { calls.push('setProfile ' + directory); },
      requestLock: (request: typeof QUIT_REQUEST) => {
        calls.push('requestLock');
        const holder = this.holders.get(key(profile));
        if (!holder) { this.holders.set(key(profile), { quits: 0, shows: 0, owner: 'asker' }); return true; }
        // main.ts: secondInstanceAction(...) === 'quit' ? app.quit() : showControls()
        if (secondInstanceAction({ argv, additionalData: request, desktopOwner: holder.owner }) === 'quit') holder.quits++; else holder.shows++;
        return false;
      },
      releaseLock: () => { calls.push('releaseLock'); if (this.holders.get(key(profile))?.owner === 'asker') this.holders.delete(key(profile)); },
    } };
  }
}

async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-graceful-quit-'));
  const stable = path.join(root, 'appdata', 'soft-hearts-claude'), development = path.join(root, 'appdata', 'soft-hearts-claude-dev');
  await mkdir(stable, { recursive: true }); await mkdir(development, { recursive: true });
  return { root, appData: path.join(root, 'appdata'), stable, development, close: () => rm(root, { recursive: true, force: true }) };
}

test('the running instance quits through the same path as the tray only for a quit request', () => {
  assert.equal(secondInstanceAction({ argv: ['x.exe'], additionalData: QUIT_REQUEST, desktopOwner: '' }), 'quit');
  assert.equal(secondInstanceAction({ argv: ['x.exe', '--SOFT-HEARTS-QUIT'], additionalData: null, desktopOwner: '' }), 'quit');
  // A plain second launch (double-clicking the shortcut again) still only shows the controls.
  assert.equal(secondInstanceAction({ argv: ['x.exe', '--soft-hearts-channel=stable'], additionalData: {}, desktopOwner: 'a'.repeat(24) }), 'show');
  for (const data of [{ softHeartsQuit: '1' }, { softHeartsQuit: true }, 'softHeartsQuit', null, undefined])
    assert.equal(secondInstanceAction({ argv: ['x.exe', '--soft-hearts-quitx', 'soft-hearts-quit'], additionalData: data, desktopOwner: '' }), 'show');
  // The older owner-bound stop switch keeps working, and only for this installation's own marker.
  assert.equal(secondInstanceAction({ argv: ['x.exe', `--soft-hearts-stop=${'a'.repeat(24)}`], desktopOwner: 'a'.repeat(24) }), 'quit');
  assert.equal(secondInstanceAction({ argv: ['x.exe', `--soft-hearts-stop=${'b'.repeat(24)}`], desktopOwner: 'a'.repeat(24) }), 'show');
  assert.equal(secondInstanceAction({ argv: ['x.exe', '--soft-hearts-stop='], desktopOwner: '' }), 'show');
});

test('the listener answers the asking launch before it quits, and a plain relaunch still shows the controls', () => {
  const calls: string[] = [], queued: (() => void)[] = [];
  const listener = (argv: string[], additionalData?: unknown) => onSecondInstance({ argv, additionalData, desktopOwner: '',
    quit: () => calls.push('app.quit'), show: () => calls.push('showControls'), later: run => { queued.push(run); } });
  assert.equal(listener(['x.exe', '--soft-hearts-quit'], QUIT_REQUEST), 'quit');
  // Electron reports "not delivered" when the app is already shutting down as the listener returns, so the quit waits.
  assert.deepEqual(calls, []); assert.equal(queued.length, 1);
  queued.shift()!(); assert.deepEqual(calls, ['app.quit']);
  assert.equal(listener(['x.exe']), 'show'); assert.deepEqual(calls, ['app.quit', 'showControls']); assert.equal(queued.length, 0);
});

test('without a scheduler the quit runs on the next turn of the event loop', async () => {
  let quits = 0;
  onSecondInstance({ argv: [], additionalData: QUIT_REQUEST, desktopOwner: '', quit: () => { quits++; }, show: () => assert.fail('no controls') });
  assert.equal(quits, 0); await new Promise(resolve => setImmediate(resolve)); assert.equal(quits, 1);
});

test('a quit switch reaches the instance on its own profile once and the asking process holds nothing afterwards', async () => {
  const t = await temporary();
  try {
    const locks = new FakeLocks(), stable = locks.run(t.stable);
    const asker = locks.asker(t.stable);
    assert.deepEqual(runQuitProcess(asker.steps), { outcome: 'forwarded', exitCode: QUIT_EXIT.forwarded, profile: t.stable });
    assert.deepEqual(stable, { quits: 1, shows: 0, owner: '' });
    assert.deepEqual(asker.calls, ['setProfile ' + t.stable, 'requestLock']);
    // The lock is matched like Windows matches folder names: the case of the path does not matter.
    const shouting = locks.asker(t.stable.toUpperCase());
    assert.equal(runQuitProcess(shouting.steps).outcome, 'forwarded'); assert.equal(stable.quits, 2);
  } finally { await t.close(); }
});

test('with nothing running the asking process gives the lock straight back and starts nothing', async () => {
  const t = await temporary();
  try {
    const locks = new FakeLocks(), asker = locks.asker(t.stable);
    assert.deepEqual(runQuitProcess(asker.steps), { outcome: 'not-running', exitCode: QUIT_EXIT.notRunning, profile: t.stable });
    assert.deepEqual(asker.calls, ['setProfile ' + t.stable, 'requestLock', 'releaseLock']);
    assert.equal(locks.holders.size, 0);
    // A profile folder that does not exist has no instance: no lock is taken (Electron would create the folder).
    const missing = path.join(t.root, 'appdata', 'never-created'), early = locks.asker(missing);
    assert.deepEqual(runQuitProcess(early.steps), { outcome: 'not-running', exitCode: QUIT_EXIT.notRunning, profile: missing });
    assert.deepEqual(early.calls, []); assert.equal(existsSync(missing), false);
    // A program that may not use the profile it was pointed at asks nobody.
    const refused = locks.asker(t.stable); refused.steps.profile = () => { throw new Error('The supplied profile conflicts with this installed channel.'); };
    assert.deepEqual(runQuitProcess(refused.steps), { outcome: 'unavailable', exitCode: QUIT_EXIT.unavailable, reason: 'The supplied profile conflicts with this installed channel.' });
    assert.deepEqual(refused.calls, []);
  } finally { await t.close(); }
});

test('the development switch never reaches the stable instance and the stable switch never reaches development', async () => {
  const t = await temporary();
  try {
    const locks = new FakeLocks(), stable = locks.run(t.stable), development = locks.run(t.development);
    assert.equal(runQuitProcess(locks.asker(t.development).steps).outcome, 'forwarded');
    assert.deepEqual([stable.quits, development.quits], [0, 1]);
    locks.holders.delete(key(t.development)); // development has quit
    assert.equal(runQuitProcess(locks.asker(t.development).steps).outcome, 'not-running');
    assert.equal(stable.quits, 0); assert.ok(locks.holders.has(key(t.stable)));
    assert.equal(runQuitProcess(locks.asker(t.stable).steps).outcome, 'forwarded'); assert.equal(stable.quits, 1);
  } finally { await t.close(); }
});

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function installs(root: string, profiles: { stable: string; development: string }) {
  const workspace = path.join(root, 'project 中文');
  await mkdir(path.join(workspace, 'release'), { recursive: true });
  await writeFile(path.join(workspace, 'release', 'desktop-profile.json'), JSON.stringify({ version: 1, directory: profiles.stable }));
  await writeFile(path.join(workspace, 'release', 'desktop-development-profile.json'), JSON.stringify({ version: 1, directory: profiles.development }));
  const install = async (channel: 'stable' | 'development', versionId: string) => {
    const bundle = path.join(workspace, 'release', channel, versionId, 'win-arm64-unpacked');
    await mkdir(path.join(bundle, 'resources'), { recursive: true });
    const executable = path.join(bundle, 'soft hearts next.exe'), asar = path.join(bundle, 'resources', 'app.asar');
    await writeFile(executable, 'synthetic executable bytes, never run'); await writeFile(asar, 'synthetic raw archive bytes');
    await writeFile(path.join(workspace, 'release', channel, versionId, channel + '-manifest.json'), JSON.stringify({ version: 1, entryKind: 'native-product-v1',
      channel, versionId, platform: 'win32', arch: 'arm64', executable: path.relative(workspace, executable).replaceAll('\\', '/'),
      exeSha256: hash(await readFile(executable)), asarSha256: hash(await readFile(asar)) }));
    return executable;
  };
  return { stable: await install('stable', 'a'.repeat(64)), development: await install('development', 'b'.repeat(64)) };
}

test('each installed program asks only on its own channel profile, and cannot be pointed at the other one', async () => {
  const t = await temporary();
  try {
    const programs = await installs(t.root, t);
    const target = (executable: string, userDataSwitch = '') => quitTargetProfile({ appData: t.appData, userDataSwitch, packaged: true, environment: {},
      channel: resolveInstalledDesktopChannel({ executable, packaged: true, platform: 'win32', defaultProfile: t.stable, explicitProfile: userDataSwitch }) });
    assert.equal(target(programs.stable), t.stable);
    assert.equal(target(programs.development), t.development);
    // `"…development…\soft hearts next.exe" --soft-hearts-quit --user-data-dir=<stable>` is refused before any lock.
    assert.throws(() => target(programs.development, t.stable), /conflicts/);
    const locks = new FakeLocks(), stable = locks.run(t.stable);
    const pointed = locks.asker(t.stable); pointed.steps.profile = () => target(programs.development, t.stable);
    assert.equal(runQuitProcess(pointed.steps).exitCode, QUIT_EXIT.unavailable);
    assert.deepEqual(pointed.calls, []); assert.equal(stable.quits, 0);
    // A source run may not name the stable profile either.
    assert.throws(() => quitTargetProfile({ appData: t.appData, channel: null, userDataSwitch: t.stable, packaged: false, environment: {} }), /stable channel/);
    assert.throws(() => quitTargetProfile({ appData: t.appData, channel: null, userDataSwitch: 'relative\\profile', packaged: false, environment: {} }), /absolute/);
  } finally { await t.close(); }
});

test('the asking process looks for exactly the profile a normal startup with the same switches uses, creating nothing', async () => {
  const t = await temporary();
  try {
    const custom = path.join(t.root, 'custom profile');
    const cases = [
      { channel: { channel: 'stable', profile: t.stable }, userDataSwitch: '', packaged: true, environment: {} },
      { channel: { channel: 'development', profile: t.development }, userDataSwitch: '', packaged: true, environment: { MMD_DESK_USER_DATA: custom } },
      { channel: null, userDataSwitch: custom, packaged: false, environment: {} },
      { channel: null, userDataSwitch: '', packaged: false, environment: { MMD_DESK_USER_DATA: custom } },
      { channel: null, userDataSwitch: '', packaged: true, environment: { MMD_DESK_USER_DATA: custom } }, // packaged ignores the variable
      { channel: null, userDataSwitch: '', packaged: false, environment: {} },
    ];
    for (const input of cases) {
      const fresh = path.join(t.root, 'fresh-appdata-' + cases.indexOf(input));
      const asked = quitTargetProfile({ ...input, appData: fresh });
      assert.equal(existsSync(fresh), false, 'the quit target is computed without creating folders');
      const started = prepareProfileDirectory(fresh, startupProfileOverride(input.channel?.profile ?? input.userDataSwitch, input.packaged, input.environment),
        input.channel?.channel === 'stable');
      assert.equal(asked, started);
    }
  } finally { await t.close(); }
});
