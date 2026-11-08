// 2026-11-07: a zip downloaded in a browser leaves every file marked "from the internet" (Zone.Identifier), and the
// RemoteSigned launch of setup.ps1 is refused; and the first double-click used to build the development desktop channel.
// These tests run the real start-soft-hearts.cmd in a temp copy (path with a space and Chinese characters) with a stub
// setup.ps1 that only records its arguments, so nothing is installed and no desktop shortcut is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';

function marked(file) {
  try { return readFileSync(file + ':Zone.Identifier', 'utf8').includes('ZoneId=3'); } catch { return false; }
}
function mark(file) { writeFileSync(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n'); }

/** A temp project folder with the real cmd and gate and a stub setup.ps1. */
function project({ channel = false, markFiles = false } = {}) {
  const outer = mkdtempSync(path.join(tmpdir(), 'sh gate 测试 '));
  const root = path.join(outer, 'soft hearts 项目');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  copyFileSync(path.join(repo, 'start-soft-hearts.cmd'), path.join(root, 'start-soft-hearts.cmd'));
  copyFileSync(path.join(repo, 'scripts', 'start-gate.ps1'), path.join(root, 'scripts', 'start-gate.ps1'));
  writeFileSync(path.join(root, 'scripts', 'setup.ps1'),
    "param([switch]$UpdateDesktop)\r\nSet-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'ran.txt') -Value ('ran UpdateDesktop=' + $UpdateDesktop.IsPresent)\r\n");
  writeFileSync(path.join(root, 'scripts', 'other.mjs'), '// stub\r\n');
  writeFileSync(path.join(outer, 'outside.ps1'), '# not ours\r\n');
  if (channel) { mkdirSync(path.join(root, 'release')); writeFileSync(path.join(root, 'release', 'desktop-current.json'), '{}'); }
  if (markFiles) {
    for (const file of ['start-soft-hearts.cmd', 'scripts/setup.ps1', 'scripts/other.mjs', 'scripts/start-gate.ps1']) mark(path.join(root, file));
    mark(path.join(outer, 'outside.ps1'));
  }
  return { outer, root, ran: path.join(root, 'ran.txt'), outside: path.join(outer, 'outside.ps1') };
}
function runCmd(root, input, args = []) {
  const cmd = path.join(root, 'start-soft-hearts.cmd');
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `""${cmd}" ${args.join(' ')}"`], { input, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 90000 });
}

test('a folder whose scripts carry the internet mark: answering N stops before setup.ps1 and changes nothing', { skip: !windows }, () => {
  const p = project({ markFiles: true });
  try {
    const result = runCmd(p.root, 'N\r\n');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /downloaded from the internet/);
    assert.match(result.stdout, /Nothing was changed/);
    assert.ok(!existsSync(p.ran), 'the blocked setup.ps1 must not be started');
    assert.ok(marked(path.join(p.root, 'scripts', 'setup.ps1')), 'N must leave the mark alone');
  } finally { rmSync(p.outer, { recursive: true, force: true }); }
});

test('answering Y removes the mark only from files under the project folder, then setup runs', { skip: !windows }, () => {
  const p = project({ markFiles: true });
  try {
    const result = runCmd(p.root, 'Y\r\n');
    assert.ok(existsSync(p.ran), result.stdout + result.stderr);
    for (const file of ['start-soft-hearts.cmd', 'scripts/setup.ps1', 'scripts/other.mjs', 'scripts/start-gate.ps1'])
      assert.ok(!marked(path.join(p.root, file)), file);
    assert.ok(marked(p.outside), 'a file outside the project folder must keep its mark');
  } finally { rmSync(p.outer, { recursive: true, force: true }); }
});

test('an unmarked folder is not asked anything', { skip: !windows }, () => {
  const p = project();
  try {
    const result = runCmd(p.root, '');
    assert.ok(existsSync(p.ran), result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /\[Y\/N\]/);
  } finally { rmSync(p.outer, { recursive: true, force: true }); }
});

test('first run (no development channel here): setup starts without -UpdateDesktop and says how to ask for the shortcuts', { skip: !windows }, () => {
  const p = project();
  try {
    const result = runCmd(p.root, '');
    assert.equal(readFileSync(p.ran, 'utf8').trim(), 'ran UpdateDesktop=False', result.stdout);
    assert.match(result.stdout, /start-soft-hearts\.cmd desktop/);
  } finally { rmSync(p.outer, { recursive: true, force: true }); }
});

test('an existing development channel keeps the old behaviour: setup starts with -UpdateDesktop', { skip: !windows }, () => {
  const p = project({ channel: true });
  try {
    const result = runCmd(p.root, '');
    assert.equal(readFileSync(p.ran, 'utf8').trim(), 'ran UpdateDesktop=True', result.stdout);
  } finally { rmSync(p.outer, { recursive: true, force: true }); }
});

test('"start-soft-hearts.cmd desktop" asks for the desktop channel even on a first run', { skip: !windows }, () => {
  const p = project();
  try {
    const result = runCmd(p.root, '', ['desktop']);
    assert.equal(readFileSync(p.ran, 'utf8').trim(), 'ran UpdateDesktop=True', result.stdout);
  } finally { rmSync(p.outer, { recursive: true, force: true }); }
});

test('the committed cmd stays ASCII with CRLF and the gate never changes an execution policy or uses Bypass', () => {
  const cmd = readFileSync(path.join(repo, 'start-soft-hearts.cmd'));
  assert.ok(cmd.every(byte => byte < 0x80));
  assert.ok(!/(?<!\r)\n/.test(cmd.toString('latin1')));
  const gate = readFileSync(path.join(repo, 'scripts', 'start-gate.ps1'));
  assert.ok(gate.every(byte => byte < 0x80), 'start-gate.ps1 stays ASCII');
  for (const text of [cmd.toString('latin1'), gate.toString('latin1')]) assert.ok(!/bypass|Set-ExecutionPolicy|-Scope/i.test(text));
});
