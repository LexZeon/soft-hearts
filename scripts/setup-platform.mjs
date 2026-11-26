import path from 'node:path';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { discoverClaude } from './claude-discovery.mjs';

export function platformTarget(platform, arch) {
  const supported = { win32: ['x64', 'arm64'], darwin: ['x64', 'arm64'], linux: ['x64'] };
  if (!supported[platform]?.includes(arch)) throw new Error(`Unsupported target: ${platform}/${arch}. Use Windows x64, macOS x64/arm64 or Linux x64. Windows arm64 is additional.`);
  return { platform, arch, os: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] };
}

export function pinnedPnpm(packageManager) {
  const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-fA-F0-9]+)?$/.exec(packageManager ?? '');
  if (!match) throw new Error('package.json must pin an exact pnpm version.');
  return match[1];
}

export function checkNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 12)) {
    throw new Error('Install Node.js 22.12+ with npm from https://nodejs.org/en/download before running setup.');
  }
}

export async function executableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch { return false; }
}

export async function findOnPath(name, env, isExecutable = executableFile) {
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    // Never implicitly search the working directory through an empty PATH item.
    if (!directory) continue;
    const file = path.resolve(directory.replace(/^"|"$/g, ''), name);
    if (await isExecutable(file)) return file;
  }
  return null;
}

// Reference for other platforms: same rules as the Windows side (scripts/claude-discovery.mjs):
// CLAUDE_PATH override (a wrong one stops, no fallback), then PATH, then a finite list of
// official install locations. Metadata only; nothing is executed here.
export async function findUnixClaude(env, options = {}) {
  return discoverClaude({ env, ...options });
}

// Installed and which version, nothing else: runs `claude --version` only. No login check,
// no account files, no model call. A failure is reported as 'unknown', never retried.
export function claudeVersion(file, run = defaultVersionRunner) {
  return run(file).then(
    out => (/\d+\.\d+\.\d+\S*/.exec(String(out)) ?? [null])[0] ?? 'unknown',
    () => 'unknown',
  );
}
function defaultVersionRunner(file) {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { timeout: 10000, windowsHide: true, env: { ...process.env, NO_COLOR: '1', DISABLE_AUTOUPDATER: '1' } },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// Only the Claude desktop app's own copy of Claude Code is here (scripts/claude-discovery.mjs 'desktop-bundled'). scripts/setup.ps1
// prints the same sentence (tests/claude-env-launch.test.ts compares them).
export const CLAUDE_DESKTOP_BUNDLED_NEXT_STEP = "Only the Claude desktop app's own copy of Claude Code was found. soft hearts cannot use it: it is not signed in on its own, and soft hearts never uses the desktop app's connection or sign-in. Install the official Claude Code (https://code.claude.com/docs/en/setup) and sign in once by running \"claude\" in a terminal; then chat will work.";

// What the next agent should do when Claude Code is not usable. Written for an agent that
// adapts this script to its own platform; safety floor: docs/PORTING.md section 5.
export function claudeNextStep(status) {
  if (status === 'invalid-override') return 'CLAUDE_PATH points at something that is not an executable file. Fix or unset it; no fallback was selected.';
  if (status === 'desktop-bundled') return CLAUDE_DESKTOP_BUNDLED_NEXT_STEP;
  return 'Claude Code was not found on CLAUDE_PATH, PATH or the usual install folders (~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin). Install it from https://code.claude.com/docs/en/setup, or set CLAUDE_PATH to the executable. If you are adapting this script for another platform or model, edit scripts/claude-discovery.mjs and keep the safety floor in docs/PORTING.md section 5. The user logs in themselves by running claude once in a terminal; this script never does.';
}

// Other agents' command lines the install script can recognise (hint only; the app's chat connects to Claude Code).
// To recognise another one, add a row: { id, command, label }.
export const OTHER_AGENTS = Object.freeze([
  { id: 'codex', command: 'codex', label: 'Codex' },
  { id: 'deepseek-harness', command: 'dsh', label: 'DeepSeek Harness' },
]);

// Which of those are on PATH. Only looks up files, never runs them.
export async function findOtherAgents(env, isExecutable = executableFile, table = OTHER_AGENTS) {
  const found = [];
  for (const agent of table) {
    const file = await findOnPath(agent.command, env, isExecutable);
    if (file) found.push({ ...agent, path: file });
  }
  return found;
}

// Plain-words hint for when Claude Code is not found. Never an error: setup goes on either way.
export function otherAgentHint(agents) {
  if (!agents.length) return 'No agent command line was found. Install Claude Code (https://code.claude.com/docs/en/setup), or read docs/PORTING.md to connect another one.';
  const names = agents.map(a => a.label).join(', ');
  return `Found ${names} (${agents.map(a => a.path).join(', ')}). soft hearts chat only connects to Claude Code; to use ${names} instead, follow docs/PORTING.md to swap the interface. Setup continues with the rest.`;
}

export function setupPlan({ platform, arch, nodeVersion, packageManager, args }) {
  platformTarget(platform, arch);
  if (platform === 'win32') throw new Error('On Windows use scripts/setup.ps1 under the current permitted policy. This entry cannot replace a refused PowerShell operation.');
  checkNode(nodeVersion);
  if (args.some(arg => !['--check-only', '--no-launch'].includes(arg))) throw new Error('Usage: node scripts/setup.mjs [--check-only] [--no-launch]');
  const version = pinnedPnpm(packageManager);
  if (args.includes('--check-only')) return { version, commands: [], launch: false };
  return {
    version,
    commands: [
      ['install', '--frozen-lockfile'],
      ['run', 'build'],
    ],
    launch: !args.includes('--no-launch'),
  };
}

export function applicationEnvironment(env, nodeExecutable, claudePath) {
  const child = { ...env, PATH: `${path.dirname(nodeExecutable)}${path.delimiter}${env.PATH ?? ''}` };
  delete child.ELECTRON_RUN_AS_NODE;
  delete child.PSExecutionPolicyPreference;
  if (claudePath) child.CLAUDE_PATH = claudePath;
  return child;
}

export function packagingArguments(platform, arch, args) {
  platformTarget(platform, arch);
  if (args.length === 1 && args[0] === '--dir') return ['--dir', `--${arch}`, '--publish', 'never'];
  const flag = { win32: '--win', darwin: '--mac', linux: '--linux' }[platform];
  const format = { win32: 'portable', darwin: 'zip', linux: 'tar.gz' }[platform];
  if (args.length !== 3 || args[0] !== flag || args[1] !== format || args[2] !== `--${arch}`) {
    throw new Error(`Package on the native target with: node scripts/package.mjs ${flag} ${format} --${arch}. Cross-platform/architecture builds are outside this entry.`);
  }
  return [...args, '--publish', 'never'];
}
