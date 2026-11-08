// Synthetic shell only: these tests never write a real Windows link, start Electron or touch the user's desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopShortcutError, installOwnDesktopShortcut, type DesktopShortcutDetails, type DesktopShortcutShell, type VerifiedDesktopEntry } from '../electron/desktop-shortcut';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const CODEX_LINKS = ['soft hearts.lnk', 'soft hearts - 完整交付版.lnk'];
const LINKS = { stable: 'soft hearts next - 稳定版.lnk', development: 'soft hearts next - 最新开发版.lnk' } as const;
type Channel = keyof typeof LINKS;

async function fixture(run: (f: { entry: (channel: Channel) => VerifiedDesktopEntry; desktopDirectory: string; link: (channel: Channel) => string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'soft-hearts-shortcut-fixture-'));
  try {
    const desktopDirectory = path.join(root, 'desktop 中文 & spaces');
    await mkdir(desktopDirectory);
    // The Codex edition's links sit on the same desktop; they must never be read, written or removed.
    for (const name of CODEX_LINKS) await writeFile(path.join(desktopDirectory, name), 'Codex edition link: ' + name);
    const versionId = 'a'.repeat(64);
    const entry = (channel: Channel): VerifiedDesktopEntry => ({
      kind: 'verified-own-desktop-entry-v1', channel, workspaceRoot: root, desktopDirectory,
      executable: path.join(root, 'release', channel, versionId, 'win-arm64-unpacked', 'soft hearts next.exe'),
      profile: path.join(root, 'profile 中文 & spaces'), versionId, manifestSha256: 'b'.repeat(64),
      asarSha256: 'c'.repeat(64), ownerMarker: 'd'.repeat(24),
    });
    await run({ entry, desktopDirectory, link: channel => path.join(desktopDirectory, LINKS[channel]) });
    for (const name of CODEX_LINKS) assert.equal(await readFile(path.join(desktopDirectory, name), 'utf8'), 'Codex edition link: ' + name);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('soft-hearts-shortcut-fixture-'));
    await rm(root, { recursive: true, force: true });
  }
}

function fakeShell(behavior: 'success' | 'false' | 'mismatch' | 'throw' = 'success') {
  const calls: { link: string; operation: string; details: DesktopShortcutDetails }[] = [];
  let reads = 0;
  const shell: DesktopShortcutShell = {
    writeShortcutLink(link, operation, details) {
      calls.push({ link, operation, details: { ...details } });
      if (operation === 'replace' && !existsSync(link)) return false;
      if (behavior === 'throw') { writeFileSync(link, 'half-written synthetic bytes'); throw new Error('synthetic shell error'); }
      if (behavior === 'false') return false;
      writeFileSync(link, 'synthetic link -> ' + details.target + ' ' + details.args); return true;
    },
    readShortcutLink() {
      reads++; const last = calls.at(-1)!.details;
      return behavior === 'mismatch' ? { ...last, args: last.args + ' --unexpected' } : { ...last };
    },
  };
  return { shell, calls, reads: () => reads };
}

test('a missing channel link is created once with the exact verified details and nothing else on the desktop changes', async () => fixture(async ({ entry, desktopDirectory, link }) => {
  for (const channel of ['development', 'stable'] as const) {
    const fake = fakeShell();
    const before = (await readdir(desktopDirectory)).sort();
    const receipt = await installOwnDesktopShortcut(entry(channel), fake.shell);
    const executable = entry(channel).executable, args = '--soft-hearts-channel=' + channel;
    assert.deepEqual(fake.calls, [{ link: link(channel), operation: 'create', details: { target: executable, cwd: path.win32.dirname(executable), args,
      description: channel === 'stable' ? 'soft hearts next · 稳定版' : 'soft hearts next · 最新开发版', icon: executable, iconIndex: 0,
      appUserModelId: channel === 'stable' ? 'io.softhearts.next' : 'io.softhearts.next.dev' } }]);
    assert.deepEqual(receipt, { kind: `native-${channel}-shortcut-v1`, channel, manifestSha256: 'b'.repeat(64), executable, shortcutPath: link(channel),
      shortcutSha256: digest(await readFile(link(channel))), targetPath: executable, arguments: args, previous: null });
    assert.deepEqual((await readdir(desktopDirectory)).sort(), [...before, LINKS[channel]].sort());
  }
}));

test('an existing own link is replaced and its previous bytes are reported for archiving', async () => fixture(async ({ entry, link }) => {
  await writeFile(link('stable'), 'previous stable link bytes');
  const fake = fakeShell();
  const receipt = await installOwnDesktopShortcut(entry('stable'), fake.shell);
  assert.equal(fake.calls[0].operation, 'replace');
  assert.deepEqual(receipt.previous, { sha256: digest('previous stable link bytes'), bytesBase64: Buffer.from('previous stable link bytes').toString('base64') });
  assert.equal(await readFile(link('stable'), 'utf8'), `synthetic link -> ${entry('stable').executable} --soft-hearts-channel=stable`);
  assert.ok(!existsSync(link('development')));
}));

for (const behavior of ['false', 'throw', 'mismatch'] as const) test(`a failed ${behavior} write restores the previous link or removes the new one`, async () => fixture(async ({ entry, link }) => {
  await writeFile(link('stable'), 'previous stable link bytes');
  for (const channel of ['stable', 'development'] as const) {
    const fake = fakeShell(behavior);
    await assert.rejects(installOwnDesktopShortcut(entry(channel), fake.shell),
      (error: unknown) => error instanceof DesktopShortcutError && error.savedAttempted && error.restored);
    assert.equal(fake.calls.length, 1); assert.equal(fake.reads(), behavior === 'mismatch' ? 1 : 0);
  }
  assert.equal(await readFile(link('stable'), 'utf8'), 'previous stable link bytes');
  assert.ok(!existsSync(link('development')));
}));

test('a link held open for a moment right after the shell saved it (2026-11-06 real desktop) is read back again; the shell write is never repeated', async () => fixture(async ({ entry, link }) => {
  const fake = fakeShell();
  const original = fake.shell.readShortcutLink;
  let failures = 2;
  // Electron's readShortcutLink throws a plain Error, no code, when the file cannot be opened.
  fake.shell.readShortcutLink = actual => { if (failures-- > 0) throw new Error('Failed to read shortcut link'); return original(actual); };
  const receipt = await installOwnDesktopShortcut(entry('development'), fake.shell);
  assert.equal(fake.calls.length, 1, 'one shell write');
  assert.equal(failures, -1, 'read back three times');
  assert.equal(receipt.shortcutPath, link('development'));
}));

test('a restore that meets a briefly locked link waits for it; a link that never frees up gives up with the reason', async () => fixture(async ({ entry, link }) => {
  await writeFile(link('stable'), 'previous stable link bytes');
  const fake = fakeShell('mismatch');
  const save = fake.shell.writeShortcutLink;
  // Read-only for ~250 ms right after the save: writing the previous bytes back fails with EPERM/EACCES at first.
  fake.shell.writeShortcutLink = (target, operation, details) => {
    const ok = save(target, operation, details); chmodSync(target, 0o444); setTimeout(() => chmodSync(target, 0o666), 250); return ok;
  };
  await assert.rejects(installOwnDesktopShortcut(entry('stable'), fake.shell),
    (error: unknown) => error instanceof DesktopShortcutError && error.savedAttempted && error.restored);
  assert.equal(fake.reads(), 1, 'a mismatch is not retried');
  assert.equal(await readFile(link('stable'), 'utf8'), 'previous stable link bytes');
  const stuck = fakeShell();
  stuck.shell.readShortcutLink = () => { throw new Error('Failed to read shortcut link'); };
  const started = Date.now();
  await assert.rejects(installOwnDesktopShortcut(entry('development'), stuck.shell),
    (error: unknown) => error instanceof DesktopShortcutError && error.restored && /could not be verified \(READBACK\)/u.test(error.message));
  assert.ok(Date.now() - started < 6_000, 'bounded wait');
  assert.equal(stuck.calls.length, 1);
  assert.ok(!existsSync(link('development')), 'the new link is removed');
}));

test('a long verified profile never expands launch arguments or relaxes their exact readback', async () => fixture(async ({ entry }) => {
  const longEntry = { ...entry('stable'), profile: entry('stable').profile + path.sep + 'x'.repeat(300) };
  const fake = fakeShell();
  const receipt = await installOwnDesktopShortcut(longEntry, fake.shell);
  assert.equal(receipt.arguments, '--soft-hearts-channel=stable');
  assert.ok(fake.calls[0].details.args.length < 260);
  const original = fake.shell.readShortcutLink;
  fake.shell.readShortcutLink = actual => ({ ...original(actual), args: `--soft-hearts-channel=stable "--user-data-dir=${longEntry.profile}"` });
  await assert.rejects(installOwnDesktopShortcut(longEntry, fake.shell), (error: unknown) => error instanceof DesktopShortcutError && error.savedAttempted);
}));

test('a linked or oversized fixed link is left unchanged before any shell call', async t => fixture(async ({ entry, link, desktopDirectory }) => {
  await writeFile(link('stable'), Buffer.alloc(64 * 1024));
  const fake = fakeShell();
  await assert.rejects(installOwnDesktopShortcut(entry('stable'), fake.shell), (error: unknown) => error instanceof DesktopShortcutError && !error.savedAttempted);
  await rm(link('stable'));
  try { await symlink(path.join(desktopDirectory, CODEX_LINKS[1]), link('stable')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('link creation unavailable'); return; } throw error; }
  await assert.rejects(installOwnDesktopShortcut(entry('stable'), fake.shell), (error: unknown) => error instanceof DesktopShortcutError && !error.savedAttempted);
  assert.deepEqual(fake.calls, []);
  await rm(link('stable'));
}));

test('malformed identity, the Codex executable, the other channel and traversal are rejected before any write', async () => fixture(async ({ entry, desktopDirectory }) => {
  const fake = fakeShell();
  const stable = entry('stable'), bundle = path.dirname(stable.executable);
  const bad: VerifiedDesktopEntry[] = [
    { ...stable, versionId: '../other' }, { ...stable, asarSha256: 'c'.repeat(63) },
    { ...stable, ownerMarker: 'x'.repeat(24) }, { ...stable, profile: stable.profile + '" --extra' },
    { ...stable, profile: stable.profile + path.sep }, { ...stable, executable: path.join(stable.workspaceRoot, 'other.exe') },
    { ...stable, executable: path.join(bundle, 'soft hearts.exe') }, { ...stable, executable: entry('development').executable },
    { ...stable, channel: 'delivered' as Channel }, { ...stable, kind: 'verified-own-stable-entry-v1' as never },
    { ...stable, desktopDirectory: 'relative' }, { ...stable, desktopDirectory: '//?/C:/outside' },
  ];
  for (const candidate of bad) await assert.rejects(installOwnDesktopShortcut(candidate, fake.shell), (error: unknown) => error instanceof DesktopShortcutError && !error.savedAttempted);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual((await readdir(desktopDirectory)).sort(), [...CODEX_LINKS].sort());
}));
