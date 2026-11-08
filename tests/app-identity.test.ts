// soft hearts next runs beside the Codex edition on the same Windows PC. These tests prove that
// the one identity module cannot select the Codex executable, shortcuts, appId or profile, and
// that every maintainer script and desktop entry source takes its names from that module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_ID, APP_USER_MODEL_IDS, CHANNELS, CODEX_EDITION, DEVELOPMENT_PROFILE_FOLDER, EXECUTABLE_NAME, PACKAGE_NAME, PRODUCT_NAME,
  SHORTCUT_NAMES, STABLE_PROFILE_FOLDER, appUserModelId, assertNotCodexProfile, isCodexProfilePath, isOwnExecutable, isOwnShortcut,
  profileFolder, shortcutName, windowsName,
} from '../scripts/lib/app-identity.mjs';
import { PROFILE_FOLDER } from '../electron/profile';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

test('every name of this edition differs from the Codex edition, also under Windows name rules', () => {
  const ours = [PACKAGE_NAME, PRODUCT_NAME, APP_ID, EXECUTABLE_NAME, STABLE_PROFILE_FOLDER, DEVELOPMENT_PROFILE_FOLDER,
    ...Object.values(SHORTCUT_NAMES), ...Object.values(APP_USER_MODEL_IDS)].map(windowsName);
  const codex = [CODEX_EDITION.packageName, CODEX_EDITION.productName, CODEX_EDITION.appId, CODEX_EDITION.executableName,
    CODEX_EDITION.profileFolder, ...CODEX_EDITION.shortcutNames].map(windowsName);
  for (const name of ours) assert.ok(!codex.includes(name), name);
  assert.equal(new Set(Object.values(SHORTCUT_NAMES).map(windowsName)).size, CHANNELS.length);
  assert.equal(new Set(Object.values(APP_USER_MODEL_IDS)).size, CHANNELS.length);
  assert.deepEqual(CHANNELS.map(profileFolder), [STABLE_PROFILE_FOLDER, DEVELOPMENT_PROFILE_FOLDER]);
  assert.deepEqual(CHANNELS.map(appUserModelId), [APP_ID, APP_ID + '.dev']);
  assert.equal(shortcutName('development'), 'soft hearts next - 最新开发版.lnk');
  assert.equal(shortcutName('stable'), 'soft hearts next - 稳定版.lnk');
  assert.throws(() => shortcutName('delivered' as never), /Unknown desktop channel/);
});

test('executable matching is exact and never selects soft hearts.exe', () => {
  for (const file of ['C:\\x\\soft hearts next.exe', 'C:/x/SOFT HEARTS NEXT.EXE', 'soft hearts next.exe. ', '/tmp/a/soft hearts next.exe'])
    assert.ok(isOwnExecutable(file), file);
  for (const file of ['C:\\x\\soft hearts.exe', 'soft hearts.exe', 'SOFT HEARTS.EXE', 'soft hearts next.exe.lnk', 'soft hearts nextx.exe',
    'xsoft hearts next.exe', 'soft hearts next', 'soft hearts*.exe', 'C:\\soft hearts next.exe\\..\\soft hearts.exe', '', null, 7])
    assert.ok(!isOwnExecutable(file), String(file));
});

test('shortcut matching is per channel and never selects the Codex links', () => {
  const desktop = 'C:\\Users\\someone\\OneDrive\\Desktop';
  for (const channel of CHANNELS) {
    for (const codexLink of CODEX_EDITION.shortcutNames) assert.ok(!isOwnShortcut(path.win32.join(desktop, codexLink), channel), codexLink);
    assert.ok(isOwnShortcut(path.win32.join(desktop, shortcutName(channel)), channel));
    assert.ok(!isOwnShortcut(path.win32.join(desktop, 'soft hearts next.lnk'), channel));
    assert.ok(!isOwnShortcut(path.win32.join(desktop, 'soft hearts*.lnk'), channel));
  }
  assert.ok(!isOwnShortcut(path.win32.join(desktop, shortcutName('stable')), 'development'));
  assert.ok(!isOwnShortcut(path.win32.join(desktop, shortcutName('development')), 'stable'));
});

test('the Codex profile folder is refused anywhere on a path, the two own profiles are not', () => {
  for (const directory of ['C:\\Users\\a\\AppData\\Roaming\\soft-hearts', 'C:\\Users\\a\\AppData\\Roaming\\SOFT-HEARTS\\',
    'C:\\Users\\a\\AppData\\Roaming\\soft-hearts.', 'C:\\Users\\a\\AppData\\Roaming\\soft-hearts\\nested',
    'C:\\Users\\a\\AppData\\Local\\Packages\\OpenAI.Codex\\LocalCache\\Roaming\\soft-hearts', '/home/a/.config/soft-hearts']) {
    assert.ok(isCodexProfilePath(directory), directory);
    assert.throws(() => assertNotCodexProfile(directory), /Codex edition profile/);
  }
  for (const directory of ['C:\\Users\\a\\AppData\\Roaming\\soft-hearts-claude', 'C:\\Users\\a\\AppData\\Roaming\\soft-hearts-claude-dev',
    'C:\\Users\\a\\AppData\\Roaming\\soft-hearts-next', 'C:\\Users\\a\\OneDrive\\Docs\\ChatGPT\\soft-hearts-next'])
    assert.equal(assertNotCodexProfile(directory), directory);
});

test('package metadata, the default profile and the PowerShell spellings agree with the identity module', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.build.appId, APP_ID);
  assert.equal(pkg.build.productName, PRODUCT_NAME);
  assert.ok(pkg.build.artifactName.startsWith(PACKAGE_NAME + '-'));
  // The user's settings live in this folder; the rename must never move them.
  assert.equal(PROFILE_FOLDER, STABLE_PROFILE_FOLDER);
  assert.equal(STABLE_PROFILE_FOLDER, 'soft-hearts-claude');
  assert.ok(read('electron/desktop-entry.ts').includes(`'${STABLE_PROFILE_FOLDER}'`));
  assert.ok(read('scripts/setup.ps1').includes(`$package.name -ne '${PACKAGE_NAME}'`));
  assert.ok(read('scripts/start-latest.ps1').includes(`-Filter "Name = '${EXECUTABLE_NAME}'"`));
  // PowerShell 5.1 reads these ASCII files in the ANSI code page, so they spell the Chinese names with char codes.
  const spelled = (name: string) => {
    const [prefix, suffix] = [name.slice(0, name.indexOf(' - ') + 3), name.slice(name.indexOf(' - ') + 3, -4)];
    return `'${prefix}' + (-join ([char[]]@(${[...suffix].map(c => '0x' + c.codePointAt(0)!.toString(16).toUpperCase()).join(',')}))) + '.lnk'`;
  };
  const refresher = read('scripts/refresh-desktop-shortcuts.ps1');
  for (const channel of CHANNELS) assert.ok(refresher.includes(spelled(shortcutName(channel))), channel);
});

test('the double-click launchers stay ASCII with CRLF and go through setup.ps1 and the existing desktop:update path', () => {
  for (const [file, switches] of [['start-soft-hearts.cmd', '-UpdateDesktop'], ['promote-to-stable.cmd', '-PromoteStable']] as const) {
    const bytes = readFileSync(path.join(root, file));
    assert.ok(bytes.every(byte => byte < 0x80), file + ' must be ASCII');
    assert.ok(!/(?<!\r)\n/.test(bytes.toString('latin1')), file + ' must use CRLF');
    assert.ok(bytes.toString('latin1').includes(`-File "%~dp0scripts\\setup.ps1" ${switches}\r\n`), file);
  }
  const setup = readFileSync(path.join(root, 'scripts/setup.ps1'));
  assert.ok(setup.every(byte => byte < 0x80), 'setup.ps1 must stay ASCII for Windows PowerShell 5.1');
  assert.ok(setup.toString('latin1').includes("Join-Path $projectRoot 'scripts\\update-desktop.mjs') $Mode"));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['desktop:update'], 'node scripts/update-desktop.mjs --install');
  assert.equal(pkg.scripts['desktop:promote'], 'node scripts/update-desktop.mjs --promote');
});

// A literal Codex artifact in any maintainer script or desktop entry source would be a lookup that can reach the Codex edition.
const codexPatterns: [string, RegExp][] = [
  ['Codex executable', /soft hearts\.exe/i], ['escaped Codex executable', /soft hearts\\+\.exe/i],
  ['Codex development link', /soft hearts\.lnk/i], ['Codex stable link', /soft hearts - 完整交付版/],
  ['Codex stable link spelled with char codes', /0x5B8C\s*,\s*0x6574/i], ['Codex appId', /io\.softhearts\.app\b/i],
  ['name glob', /soft hearts\*/i], ['Codex package or profile literal', /['"]soft-hearts['"]/],
];
function guardedFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory + '/' + entry.name;
      if (entry.isDirectory()) walk(relative);
      else if (/\.(?:mjs|mts|js|ps1|cmd)$/i.test(entry.name)) files.push(relative);
    }
  };
  walk('scripts');
  for (const entry of readdirSync(path.join(root, 'electron'))) if (entry.endsWith('.ts')) files.push('electron/' + entry);
  for (const entry of readdirSync(root)) if (entry.toLowerCase().endsWith('.cmd')) files.push(entry);
  // The identity module names the Codex edition once, only so that guards can refuse it.
  return files.filter(file => file !== 'scripts/lib/app-identity.mjs');
}

test('the static guard recognises each Codex artifact spelling', () => {
  const samples = ["Name = 'soft hearts.exe'", "unpacked/soft hearts\\.exe$", "'soft hearts.lnk'", 'soft hearts - 完整交付版.lnk',
    '@(0x5B8C,0x6574,0x4EA4,0x4ED8,0x7248)', "appId: 'io.softhearts.app'", "Get-ChildItem 'soft hearts*.lnk'", "Join-Path $appData 'soft-hearts'"];
  for (const sample of samples) assert.ok(codexPatterns.some(([, pattern]) => pattern.test(sample)), sample);
  for (const sample of ["'soft hearts next.exe'", 'soft hearts next - 稳定版.lnk', "'soft-hearts-claude'", 'io.softhearts.next', "'soft-hearts-next'"])
    assert.ok(!codexPatterns.some(([, pattern]) => pattern.test(sample)), sample);
});

test('no maintainer script, launcher or electron source spells a Codex edition artifact', () => {
  const files = guardedFiles();
  for (const required of ['scripts/update-desktop.mjs', 'scripts/pin-delivery.mjs', 'scripts/start-latest.ps1', 'scripts/refresh-desktop-shortcuts.ps1',
    'scripts/setup.ps1', 'scripts/lib/smoke-isolation.mjs', 'scripts/lib/desktop-profiles.mjs', 'electron/desktop-channel.ts', 'electron/desktop-shortcut.ts',
    'electron/desktop-entry.ts', 'start-soft-hearts.cmd', 'promote-to-stable.cmd'])
    assert.ok(files.includes(required), required);
  assert.ok(!files.includes('scripts/lib/app-identity.mjs'));
  const findings = files.flatMap(file => {
    const text = read(file);
    return codexPatterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${file}: ${label}`);
  });
  assert.deepEqual(findings, []);
});
