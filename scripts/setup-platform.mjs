import path from 'node:path';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { discoverCodex } from './codex-discovery.mjs';

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

export async function findUnixCodex(env) {
  return discoverCodex({ env });
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

export function applicationEnvironment(env, nodeExecutable, codexPath) {
  const child = { ...env, PATH: `${path.dirname(nodeExecutable)}${path.delimiter}${env.PATH ?? ''}` };
  delete child.ELECTRON_RUN_AS_NODE;
  delete child.PSExecutionPolicyPreference;
  if (codexPath) child.CODEX_PATH = codexPath;
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
