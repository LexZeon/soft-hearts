// Launch hygiene in scripts/setup.ps1 (docs/claude/2026-11-25-claude-env-from-session.md): started from inside a Claude Code session,
// the app and `claude auth status` do not get that session's variables or its endpoint and credential plumbing; outside a session
// nothing is removed; the setup check says plainly what a desktop-app user needs. Runs the script's own functions and its real
// -CheckOnly entry in temp folders with synthetic variables. No real Claude Code, no app, no user or system environment change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLAUDE_SESSION_MARKERS, CLAUDE_SESSION_PLUMBING } from '../shared/brain/claude-session-env';
import { CLAUDE_DESKTOP_BUNDLED_NEXT_STEP } from '../scripts/setup-platform.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SETUP = path.join(ROOT, 'scripts', 'setup.ps1');
const windows = process.platform === 'win32';
/** By full path: some tests give the child a PATH without System32. */
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const setupText = () => readFileSync(SETUP, 'latin1');
const SECRET = 'sk-ant-launch-secret-never-printed';
/** This machine's environment without any Claude or Anthropic variable (the tests run inside Claude Code sessions too), as the base. */
const baseEnvironment = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(?:CLAUDE|ANTHROPIC)/i.test(key))) as Record<string, string>;
/** `extra` over `base`, names compared without case (Windows): a base `Path` does not survive beside an extra `PATH`. */
const overlay = (base: Record<string, string>, extra: Record<string, string | undefined>): Record<string, string> => {
  const upper = new Set(Object.keys(extra).map(key => key.toUpperCase()));
  const out = Object.fromEntries(Object.entries(base).filter(([key]) => !upper.has(key.toUpperCase())));
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value;
  return out;
};

/** The part of setup.ps1 with the two lists and the Claude Code functions, as a script to dot-source. */
function claudeFunctions(): string {
  const text = setupText();
  const start = text.indexOf("# A parent Claude Code session's variables");
  const end = text.indexOf('function Get-WindowsArch');
  assert.ok(start >= 0 && end > start, 'the Claude Code block of setup.ps1');
  return text.slice(start, end);
}
const psArray = (name: string): string[] => {
  const match = new RegExp(`\\$${name} = @\\(([^)]*)\\)`).exec(setupText());
  assert.ok(match, name);
  return [...match![1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!);
};

function runPowerShell(body: string, env: Record<string, string | undefined>): { status: number | null; stdout: string; stderr: string } {
  const folder = mkdtempSync(path.join(tmpdir(), 'sh-claude-env-launch-'));
  try {
    const script = path.join(folder, 'driver.ps1');
    writeFileSync(script, "$ErrorActionPreference = 'Stop'\r\nSet-StrictMode -Version Latest\r\n" + claudeFunctions() + '\r\n' + body + '\r\n');
    const childEnv = overlay(baseEnvironment(), env);
    const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('setup.ps1 keeps the same marker and plumbing lists as shared/brain/claude-session-env.ts, and stays ASCII', () => {
  assert.deepEqual(psArray('claudeSessionMarkers'), [...CLAUDE_SESSION_MARKERS]);
  assert.deepEqual(psArray('claudeSessionPlumbing'), [...CLAUDE_SESSION_PLUMBING]);
  assert.ok(readFileSync(SETUP).every(byte => byte < 0x80));
});

test('the app start and the sign-in check both go through Invoke-WithoutClaudeSession (its behaviour is run below)', () => {
  const text = setupText();
  assert.match(text, /\$launched = Invoke-WithoutClaudeSession \{ Start-Process -FilePath \$electronExecutable /);
  assert.equal((text.match(/Start-Process -FilePath \$electronExecutable/g) ?? []).length, 1, 'no second, unwrapped app start');
  assert.match(text, /\$raw = Invoke-WithoutClaudeSession \{ & \$Executable 'auth' 'status' 2>\$null \}/);
});

test('the setup check\'s desktop-app sentence is the one setup-platform.mjs gives other platforms', () => {
  const line = /\$claude\.Status -eq 'desktop-bundled'\) \{\n\s+Write-Warning '((?:[^']|'')+)'/.exec(setupText());
  assert.ok(line, 'the desktop-bundled warning');
  assert.equal(line![1]!.replace(/''/g, "'"), CLAUDE_DESKTOP_BUNDLED_NEXT_STEP);
});

test('inside a session: the app start and the sign-in check run without its variables, which come back afterwards', { skip: !windows }, () => {
  const run = runPowerShell([
    "Write-Output ('DROP=' + ((Get-ClaudeSessionVariables) -join ','))",
    "Write-Output ('CHILD=' + (Invoke-WithoutClaudeSession { & cmd.exe /d /c 'if defined ANTHROPIC_BASE_URL (echo base) else (echo nobase)& if defined CLAUDECODE (echo marker) else (echo nomarker)& if defined CLAUDE_PATH (echo path) else (echo nopath)' }) -join ',')",
    "Write-Output ('AFTER=' + [bool]$env:ANTHROPIC_BASE_URL + ',' + [bool]$env:CLAUDECODE + ',' + [bool]$env:CLAUDE_CODE_MESSAGING_SOCKET)",
  ].join('\r\n'), { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_MESSAGING_SOCKET: 'pipe', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/proxy',
    ANTHROPIC_AUTH_TOKEN: SECRET, CLAUDE_PATH: 'C:\\x\\claude.exe', CLAUDE_CONFIG_DIR: 'C:\\cfg', ANTHROPIC_MODEL: 'sonnet' });
  assert.equal(run.status, 0, run.stderr);
  const line = (key: string) => run.stdout.split(/\r?\n/).find(l => l.startsWith(key + '='))?.slice(key.length + 1);
  assert.equal(line('DROP'), 'ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,CLAUDE_CODE_ENTRYPOINT,CLAUDE_CODE_MESSAGING_SOCKET,CLAUDECODE');
  assert.equal(line('CHILD'), 'nobase nomarker path', 'the child misses the session\'s variables and keeps CLAUDE_PATH');
  assert.equal(line('AFTER'), 'True,True,True', 'this process gets them back');
  assert.ok(!run.stdout.includes(SECRET));
});

test('outside a session nothing is removed: a global ANTHROPIC_BASE_URL is the user\'s own', { skip: !windows }, () => {
  const run = runPowerShell("Write-Output ('DROP=' + ((Get-ClaudeSessionVariables) -join ','))\r\nWrite-Output ('CHILD=' + (Invoke-WithoutClaudeSession { & cmd.exe /d /c 'if defined ANTHROPIC_BASE_URL (echo base) else (echo nobase)' }))",
    { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_API_KEY: SECRET });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^DROP=$/m);
  assert.match(run.stdout, /^CHILD=base$/m);
});

test('Find-ClaudeExecutable: the desktop app\'s copy is never returned; an official one still wins', { skip: !windows }, () => {
  const owned = mkdtempSync(path.join(tmpdir(), 'sh-claude-find-'));
  try {
    const roaming = path.join(owned, 'roaming');
    const bundledDir = path.join(roaming, 'Claude', 'claude-code', '2.1.330', '2b1a4f2fbd30');
    mkdirSync(bundledDir, { recursive: true });
    const bundled = path.join(bundledDir, 'claude.exe');
    writeFileSync(bundled, 'synthetic');
    const home = path.join(owned, 'home');
    const status = (env: Record<string, string>) => runPowerShell("$r = Find-ClaudeExecutable; Write-Output ('S=' + $r.Status + '|' + $r.Path)",
      { USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: path.join(owned, 'local'), ...env }).stdout.match(/^S=(.*)$/m)?.[1]?.trim();
    assert.equal(status({ CLAUDE_PATH: bundled }), 'desktop-bundled|');
    assert.equal(status({ PATH: bundledDir }), 'desktop-bundled|');
    assert.equal(status({ PATH: path.join(owned, 'none') }), 'desktop-bundled|', 'the desktop app\'s claude-code folder alone');
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    const official = path.join(home, '.local', 'bin', 'claude.exe');
    writeFileSync(official, 'synthetic');
    assert.equal(status({ PATH: bundledDir }), `found|${official}`);
  } finally { rmSync(owned, { recursive: true, force: true }); }
});

/** The real -CheckOnly entry in a disposable project (as tests/first-run-setup.test.ps1 does): reports, never installs or launches. */
function checkOnly(env: Record<string, string>, prepare: (owned: string) => Record<string, string>): string {
  const owned = mkdtempSync(path.join(tmpdir(), 'sh-claude-check-'));
  try {
    const project = path.join(owned, 'project');
    mkdirSync(path.join(project, 'scripts'), { recursive: true });
    copyFileSync(SETUP, path.join(project, 'scripts', 'setup.ps1'));
    writeFileSync(path.join(project, 'package.json'), '{"name":"soft-hearts-next","packageManager":"pnpm@11.25.0"}');
    writeFileSync(path.join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    const childEnv = overlay(baseEnvironment(), { USERPROFILE: path.join(owned, 'home'), LOCALAPPDATA: path.join(owned, 'local'), APPDATA: path.join(owned, 'roaming'),
      ProgramFiles: path.join(owned, 'pf'), 'ProgramFiles(x86)': path.join(owned, 'pf86'), PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0`,
      SystemRoot: process.env.SystemRoot!, windir: process.env.windir ?? process.env.SystemRoot!, TEMP: owned, TMP: owned, ComSpec: process.env.ComSpec ?? `${process.env.SystemRoot}\\System32\\cmd.exe`,
      ...env, ...prepare(owned) });
    const run = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'scripts', 'setup.ps1'), '-CheckOnly'],
      { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    return run.stdout + run.stderr;
  } finally { rmSync(owned, { recursive: true, force: true }); }
}

test('setup check: only the desktop app\'s copy here says plainly to install the official Claude Code and sign in once', { skip: !windows }, () => {
  const output = checkOnly({ CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/proxy', ANTHROPIC_AUTH_TOKEN: SECRET }, owned => {
    mkdirSync(path.join(owned, 'roaming', 'Claude', 'claude-code', '2.1.330', 'x'), { recursive: true });
    return {};
  });
  assert.match(output.replace(/\s+/g, ' '), /Only the Claude desktop app's own copy of Claude Code was found\..*https:\/\/code\.claude\.com\/docs\/en\/setup/);
  assert.ok(!output.includes(SECRET));
});

test('setup check: the sign-in check asks the official CLI without the session\'s proxy, so a signed-out CLI is reported as signed out', { skip: !windows }, () => {
  // The stand-in answers "signed in" only when it sees the session's proxy variable, as the desktop app's connection would.
  const output = checkOnly({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/proxy', ANTHROPIC_AUTH_TOKEN: SECRET }, owned => {
    const fake = path.join(owned, 'claude.cmd');
    writeFileSync(fake, '@echo off\r\nif defined ANTHROPIC_BASE_URL (echo {"loggedIn":true}) else (echo {"loggedIn":false})\r\n');
    return { CLAUDE_PATH: fake };
  });
  assert.match(output.replace(/\s+/g, ' '), /not signed in\. Sign in once: run "claude" in a terminal.*https:\/\/code\.claude\.com\/docs\/en\/setup/);
  assert.ok(!output.includes('reports that you are signed in'));
  assert.ok(!output.includes(SECRET));
});
