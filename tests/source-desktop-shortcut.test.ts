// The install makes one desktop shortcut (scripts/desktop-shortcut.ps1, also reachable as setup.ps1 -DesktopShortcut).
// Every test writes into a temporary folder passed as -DesktopFolder: no real desktop is read or written.
// A .lnk is read back through the same WScript.Shell COM object the script uses; where it is unavailable the tests skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_EDITION, SOURCE_SHORTCUT_NAME, windowsName } from '../scripts/lib/app-identity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const script = path.join(root, 'scripts', 'desktop-shortcut.ps1');
const setup = path.join(root, 'scripts', 'setup.ps1');
const windows = process.platform === 'win32';
const powershell = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const skip = !windows || !existsSync(powershell);

const run = (file: string, args: string[]) => spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', timeout: 90000 });
const create = (folder: string, extra: string[] = []) => run(script, ['-Action', 'Create', '-DesktopFolder', folder, '-ProjectRoot', root, ...extra]);
const remove = (folder: string) => run(script, ['-Action', 'Remove', '-DesktopFolder', folder, '-ProjectRoot', root]);

/** Reads a .lnk back through COM (written to a temp .ps1 so no quoting of a path with spaces is needed). */
function readLink(file: string): { target: string; workingDirectory: string; description: string; icon: string; windowStyle: number } | null {
  const reader = path.join(path.dirname(file), '..', 'read-link.ps1');
  const out = reader + '.json';
  // The answer goes through a UTF-8 file: the console code page would garble the Chinese in a path.
  writeFileSync(reader, "param([string]$File, [string]$Out)\n$l = (New-Object -ComObject WScript.Shell).CreateShortcut($File)\n$json = [pscustomobject]@{target=$l.TargetPath;workingDirectory=$l.WorkingDirectory;description=$l.Description;icon=$l.IconLocation;windowStyle=$l.WindowStyle} | ConvertTo-Json -Compress\n[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding $false))\n");
  const result = run(reader, [file, out]);
  return result.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null;
}
function withDesktop(body: (folder: string) => void) {
  const outer = mkdtempSync(path.join(tmpdir(), 'sh shortcut 测试 '));
  const folder = path.join(outer, 'Desktop');
  mkdirSync(folder);
  try { body(folder); } finally { rmSync(outer, { recursive: true, force: true }); }
}

test('the script spells the same name as the identity module, and never a Codex shortcut name', () => {
  const text = readFileSync(script, 'latin1');
  assert.ok(text.includes(`[string]$Name = '${SOURCE_SHORTCUT_NAME}'`));
  assert.ok(!CODEX_EDITION.shortcutNames.map(windowsName).includes(windowsName(SOURCE_SHORTCUT_NAME)));
  assert.ok(readFileSync(script).every(byte => byte < 0x80), 'desktop-shortcut.ps1 must stay ASCII for Windows PowerShell 5.1');
});

const ICON = path.join(root, 'assets', 'icons', 'soft-hearts.ico');

test('the placeholder icon is a real .ico with 16, 32, 48 and 256 px images, opaque black, and the script regenerates the same bytes', async () => {
  const bytes = readFileSync(ICON);
  assert.equal(bytes.readUInt16LE(0), 0); assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i, size = bytes[at] || 256;
    sizes.push(size);
    const image = bytes.subarray(bytes.readUInt32LE(at + 12), bytes.readUInt32LE(at + 12) + bytes.readUInt32LE(at + 8));
    assert.equal(image.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image[25], 6, 'RGBA');
  }
  assert.deepEqual(sizes, [16, 32, 48, 256]);
  const { placeholderIco, blackPng } = await import('../scripts/make-placeholder-icon.mjs');
  assert.deepEqual(bytes, placeholderIco());
  const raw = inflateSync(Buffer.concat(pngIdat(blackPng(16))));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) assert.deepEqual([...raw.subarray(y * 65 + 1 + x * 4, y * 65 + 5 + x * 4)], [0, 0, 0, 255]);
});
function pngIdat(png: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 8; at < png.length;) { const length = png.readUInt32BE(at); if (png.subarray(at + 4, at + 8).toString('ascii') === 'IDAT') out.push(png.subarray(at + 8, at + 8 + length)); at += 12 + length; }
  return out;
}

test('Create makes the shortcut in the given folder with the launcher as target and the project folder as working directory', { skip }, () => {
  withDesktop(folder => {
    const result = create(folder);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const link = readLink(path.join(folder, SOURCE_SHORTCUT_NAME));
    if (!link) return;
    assert.equal(link.target.toLowerCase(), path.join(root, 'start-soft-hearts.cmd').toLowerCase());
    assert.equal(link.workingDirectory.toLowerCase(), root.toLowerCase());
    assert.equal(link.windowStyle, 7, 'starts minimised: no console window in front of her');
    assert.equal(link.icon.replace(/,\d+$/, '').toLowerCase(), ICON.toLowerCase(), 'the shortcut uses the project icon');
    assert.match(link.description, /desktop-shortcut\.ps1/);
  });
});

test('Create again from another folder repoints its own shortcut (an update keeps it working)', { skip }, () => {
  withDesktop(folder => {
    assert.equal(create(folder).status, 0);
    const other = path.join(path.dirname(folder), 'new folder');
    mkdirSync(other);
    writeFileSync(path.join(other, 'start-soft-hearts.cmd'), '@echo off\r\n');
    const result = run(script, ['-Action', 'Create', '-DesktopFolder', folder, '-ProjectRoot', other]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const link = readLink(path.join(folder, SOURCE_SHORTCUT_NAME));
    if (!link) return;
    assert.equal(link.workingDirectory.toLowerCase(), other.toLowerCase());
  });
});

test('a different shortcut of the same name is not overwritten: exit 2, bytes unchanged; -Force replaces it', { skip }, () => {
  withDesktop(folder => {
    const file = path.join(folder, SOURCE_SHORTCUT_NAME);
    // Make a foreign shortcut (no marker) through the same COM object.
    const maker = path.join(path.dirname(folder), 'make.ps1');
    writeFileSync(maker, "param([string]$File)\n$l = (New-Object -ComObject WScript.Shell).CreateShortcut($File)\n$l.TargetPath = $env:WINDIR + '\\notepad.exe'\n$l.Description = 'someone else'\n$l.Save()\n");
    assert.equal(run(maker, [file]).status, 0);
    const before = readFileSync(file);
    const refused = create(folder);
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /Nothing was changed/);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(remove(folder).status, 0);
    assert.deepEqual(readFileSync(file), before, 'Remove must leave a shortcut it did not make');
    assert.equal(create(folder, ['-Force']).status, 0);
    const link = readLink(file);
    if (link) assert.match(link.description, /desktop-shortcut\.ps1/);
  });
});

test('Remove deletes its own shortcut and only that file', { skip }, () => {
  withDesktop(folder => {
    const bystander = path.join(folder, 'another.lnk');
    writeFileSync(bystander, 'not ours');
    assert.equal(create(folder).status, 0);
    assert.equal(remove(folder).status, 0);
    assert.ok(!existsSync(path.join(folder, SOURCE_SHORTCUT_NAME)));
    assert.ok(existsSync(bystander));
    assert.equal(remove(folder).status, 0, 'removing twice is harmless');
  });
});

test('setup.ps1 -DesktopShortcut and -RemoveDesktopShortcut call the script, alone and without installing anything', { skip }, () => {
  withDesktop(folder => {
    const made = run(setup, ['-DesktopShortcut', '-DesktopFolder', folder]);
    assert.equal(made.status, 0, made.stdout + made.stderr);
    assert.ok(existsSync(path.join(folder, SOURCE_SHORTCUT_NAME)));
    const gone = run(setup, ['-RemoveDesktopShortcut', '-DesktopFolder', folder]);
    assert.equal(gone.status, 0, gone.stdout + gone.stderr);
    assert.ok(!existsSync(path.join(folder, SOURCE_SHORTCUT_NAME)));
    const mixed = run(setup, ['-DesktopShortcut', '-CheckOnly', '-DesktopFolder', folder]);
    assert.notEqual(mixed.status, 0);
    assert.ok(!existsSync(path.join(folder, SOURCE_SHORTCUT_NAME)));
  });
});
