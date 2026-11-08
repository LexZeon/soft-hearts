// I-030: run any heavy command under the "我在用电脑" cap (scripts/dev/presence.mjs).
//   node scripts/dev/heavy.mjs [--label 名字] -- <command> [args...]
// Waits for a slot while the user is at the computer and another heavy job runs, then starts the command at below-normal
// priority on half the cores (it and its children inherit that), and follows the tray check box until the command ends.
// Exits with the command's exit code.
import { spawn } from 'node:child_process';
import { gateHeavy } from './presence.mjs';

const args = process.argv.slice(2);
let label = '';
const split = args.indexOf('--');
if (split < 0 || split === args.length - 1) {
  console.error('用法：node scripts/dev/heavy.mjs [--label 名字] -- <命令> [参数...]');
  process.exit(2);
}
for (let i = 0; i < split; i++) if (args[i] === '--label') label = args[++i] ?? '';
const [command, ...rest] = args.slice(split + 1);
label ||= [command, ...rest].join(' ').slice(0, 80);

const release = await gateHeavy(label);
const child = spawn(command, rest, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command) });
const forward = signal => { try { child.kill(signal); } catch { /* Already gone. */ } };
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
child.on('error', error => { console.error(`启动失败：${error.message}`); release(); process.exit(127); });
child.on('exit', (code, signal) => { release(); process.exit(code ?? (signal ? 1 : 0)); });
