import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setupPlan, findUnixCodex, findOnPath, applicationEnvironment, platformTarget } from './setup-platform.mjs';
import { PACKAGE_NAME, PRODUCT_NAME } from './lib/app-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const present = file => access(path.join(root, file)).then(() => true, () => false);
function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Setup step failed (${signal ?? code}); keep the original output. No retry was attempted.`)));
  });
}

try {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== PACKAGE_NAME || !(await present('pnpm-lock.yaml')) || !(await present('START-HERE.md'))) throw new Error(`Open the complete ${PRODUCT_NAME} source folder.`);
  const plan = setupPlan({ platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, packageManager: pkg.packageManager, args: process.argv.slice(2) });
  const target = platformTarget(process.platform, process.arch);
  if (process.platform === 'darwin' && Number(os.release().split('.')[0]) < 22) throw new Error('This Electron version requires macOS 13 Ventura or later.');
  const codex = await findUnixCodex(process.env);
  const npm = await findOnPath('npm', process.env);
  console.log(`${PRODUCT_NAME} setup | ${target.os} ${target.arch} | Node ${process.versions.node} | pnpm ${plan.version}`);
  console.log(codex.path ? `Codex executable: ${codex.path}` : `Codex: ${codex.status}. Use the official CLI installation/login instructions in START-HERE.md; no credentials were read.`);
  console.log(`npm: ${npm ?? 'missing'} | dependencies: ${await present('node_modules')} | build: ${await present('dist-electron/main.cjs')}`);
  const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!hasDisplay) console.log('No Linux desktop display session detected. A real desktop is required to launch; --no-launch only prepares sources.');
  if (process.argv.includes('--check-only')) {
    console.log('Check only: no downloads, installs, builds, CLI calls, configuration writes or app launch. Login status and an actual reply remain separate checks.');
  } else {
    if (!npm) throw new Error('npm is missing. Install Node.js with npm from the official Node.js download page.');
    if (plan.launch && !hasDisplay) throw new Error('Run setup from your Linux desktop session or use --no-launch for build preparation.');
    if (codex.status === 'invalid-override') throw new Error('CODEX_PATH is invalid; correct that explicit setting before continuing. No fallback was selected.');
    const env = applicationEnvironment(process.env, process.execPath, codex.path);
    const pnpm = args => run(npm, ['exec', '--yes', `--package=pnpm@${plan.version}`, '--', 'pnpm', ...args], env);
    await pnpm(plan.commands[0]);
    // Prepare Electron's on-demand binary without opening the application.
    await run(process.execPath, ['--input-type=commonjs', '-e', "require('electron')"], env);
    await pnpm(plan.commands[1]);
    if (!plan.launch) console.log('Setup and build complete; no application launched.');
    else {
      const electron = require('electron');
      console.log(`Starting ${PRODUCT_NAME}. Verify its window, Gene (or your preserved model), and a real reply with your own Codex login.`);
      await run(electron, [root], env);
    }
  }
} catch (error) {
  console.error(`${PRODUCT_NAME} setup: ${error.message}`);
  process.exitCode = 1;
}
