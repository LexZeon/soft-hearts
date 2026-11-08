// I-030: the full test suite under the "我在用电脑" cap. Use this instead of calling tsx --test on everything directly:
//   node scripts/dev/test-all.mjs            (all of tests/*.test.ts and tests/*.test.mjs)
//   node scripts/dev/test-all.mjs <files...> (just these)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { gateHeavy } from './presence.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const files = process.argv.slice(2);
const release = await gateHeavy(files.length ? `tests: ${files.length} files` : 'full test suite');
const child = spawn(process.execPath, [tsx, '--test', ...(files.length ? files : ['tests/*.test.ts', 'tests/*.test.mjs'])],
  { cwd: root, stdio: 'inherit', env: process.env });
child.on('exit', (code, signal) => { release(); process.exit(code ?? (signal ? 1 : 0)); });
