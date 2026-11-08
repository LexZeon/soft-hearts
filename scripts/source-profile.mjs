// Source runs never use the user's real profile (only the stable
// version lives with her). start-soft-hearts.cmd's usual start, pnpm dev and pnpm start run this source folder with
// the development profile %APPDATA%\soft-hearts-claude-dev, the same one the development channel uses. It is seeded
// once from the stable profile %APPDATA%\soft-hearts-claude when it is first created (scripts/lib/desktop-profiles.mjs),
// never again, and nothing is ever written back to stable.
//   node scripts/source-profile.mjs           prepare it; print {"directory","message"} as ASCII-only JSON (setup.ps1)
//   node scripts/source-profile.mjs --start   prepare it, then run the built source with it (pnpm start)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDevelopmentProfile } from './lib/desktop-profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The seeding note the user reads once, in the double-click window or the terminal. */
export function seededMessage(directory, seeded) {
  if (!seeded) return null;
  return `第一次创建开发配置（${directory}）：已从稳定版配置只读复制一次角色、语音等设置（${seeded.files} 个文件）。源码运行和开发版用这份，稳定版的配置不会被改动，以后两边也不再同步。`
    + (seeded.secretsNeedReentry ? '稳定版配置里没有解密密钥所需的 Local State，加密保存的密钥（比如百炼语音）要在开发配置里重新填写。' : '');
}

/** Prepares the development profile for a source run. Returns its folder and the Electron switch that selects it. */
export async function prepareSourceProfile(workspaceRoot = root, environment = process.env) {
  const profile = await ensureDevelopmentProfile(workspaceRoot, environment);
  return { directory: profile.directory, seeded: profile.seeded, message: seededMessage(profile.directory, profile.seeded),
    argument: '--user-data-dir=' + profile.directory };
}

/** JSON with every non-ASCII character escaped, so Windows PowerShell reads it the same in any console code page. */
export function asciiJson(value) {
  // UTF-16 code units (no `u` flag), so characters outside the BMP become their two escaped surrogates.
  return JSON.stringify(value).replace(/[\u007f-￿]/g, unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function main() {
  const profile = await prepareSourceProfile();
  if (!process.argv.includes('--start')) { process.stdout.write(asciiJson({ directory: profile.directory, message: profile.message }) + '\n'); return; }
  if (profile.message) console.log(profile.message);
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [root, profile.argument], { stdio: 'inherit', env, windowsHide: true });
  child.on('exit', code => process.exit(code ?? 0));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { console.error('The development profile for the source app could not be prepared; nothing was started: ' + String(error?.message ?? error)); process.exitCode = 1; }
}
