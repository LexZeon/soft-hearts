// Development: face close-up sheets of PMX models with chosen morph weights and the stage's procedural blush (hidden window, nothing on
// the screen, a temporary user-data folder; the models are only read). Pictures of a private model belong outside the repository.
//   node scripts/dev/heavy.mjs --label face-shots -- node scripts/unbound/face-shots.mjs <plan.json>
// plan.json: { "jobs": [{ "model": "<abs path .pmx>", "out": "<abs path .png>", "cols": 4, "size": 380,
//                         "shots": [{ "label": "...", "morphs": { "name": weight }, "blush": 0..1, "mark": true }] }] }
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const planPath = process.argv[2];
if (!planPath) { console.error('usage: face-shots.mjs <plan.json>'); process.exit(2); }
const jobs = JSON.parse(readFileSync(planPath, 'utf8')).jobs;
const buildDir = path.join(root, '.local', 'face-shots', 'build');
mkdirSync(buildDir, { recursive: true });
await build({ entryPoints: [path.join(here, 'face-shots-main.ts')], outfile: path.join(buildDir, 'main.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
await build({ entryPoints: [path.join(here, 'face-shots-page.ts')], outfile: path.join(buildDir, 'page.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'error' });
writeFileSync(path.join(buildDir, 'page.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0"></body><script src="page.js"></script>');
const userData = mkdtempSync(path.join(os.tmpdir(), 'face-shots-'));
const plan = path.join(userData, 'plan.json');
writeFileSync(plan, JSON.stringify({ build: buildDir, userData, jobs }));
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', plan], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached.'); child.kill(); }, 180_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* temporary */ }
process.exit(code);
