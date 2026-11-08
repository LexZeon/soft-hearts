// Runs one source smoke with a deadline that cannot orphan its Electron window.
//   node scripts/smoke-runner.mjs reply [--timeout 300]
// Use this instead of an outer `timeout 300 node scripts/<name>-smoke.mjs`: that kills only node and
// leaves the Playwright-launched Electron on the desktop. On expiry this ends the smoke's whole own
// process tree (node and the Electron it started). Afterwards it lists any Playwright-launched
// electron.exe created during the run that is still alive; it never ends processes it did not start.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [name, ...rest] = process.argv.slice(2);
const flag = rest.indexOf('--timeout');
const seconds = flag >= 0 ? Number(rest[flag + 1]) : 300;
if (!name || !Number.isFinite(seconds) || seconds <= 0) { console.error('Usage: node scripts/smoke-runner.mjs <name> [--timeout seconds]'); process.exit(2); }
const script = path.join(workspace, 'scripts', name.endsWith('.mjs') ? name : `${name.replace(/-smoke$/, '')}-smoke.mjs`);
if (!existsSync(script)) { console.error(`No such smoke: ${script}`); process.exit(2); }

const startedAt = new Date();
const child = spawn(process.execPath, [script, ...rest.filter((_, index) => index !== flag && index !== flag + 1)], { cwd: workspace, stdio: 'inherit', env: process.env });
let expired = false;
const timer = setTimeout(() => {
  expired = true;
  console.error(`smoke-runner: ${path.basename(script)} exceeded ${seconds} s; ending its own process tree.`);
  if (process.platform === 'win32') { try { execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  else child.kill('SIGKILL');
}, seconds * 1000);
const code = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0))));
clearTimeout(timer);

let leftovers = [];
if (process.platform === 'win32') {
  try {
    const since = startedAt.toISOString();
    const query = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*playwright-core*electron*loader.js*' -and $_.CreationDate -ge [datetime]'${since}' } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToString('s'))" }`;
    leftovers = execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean);
  } catch (error) { leftovers = [`(could not list processes: ${error.message})`]; }
}
console.log(`smoke-runner: ${path.basename(script)} exit=${code}${expired ? ' (deadline)' : ''}; Playwright electron started during this run and still alive: ${leftovers.length ? leftovers.join('; ') : 'none'}`);
process.exit(expired ? 124 : code);
