// Motion-model spike preview (docs/claude/2026-11-14-motion-model-spike.md): builds the preview page and host, then runs them in
// Electron with the bundled Gene in one small 540x720 window and a temporary user-data folder. Four groups (rest / procedural /
// motion matching / small model), each a fresh Gene stepped deterministically to the same times; two framings per time. About a
// minute. Run:
//   node scripts/dev/heavy.mjs --label "idle preview" -- node scripts/ml/idle-preview.mjs [--model <idle-vae.json>]
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ml = [process.env.SOFT_HEARTS_ML_DIR, path.join(root, '.local', 'ml'), path.resolve(root, '..', '..', '..', '.local', 'ml')].filter(Boolean).find(d => existsSync(path.join(d, 'work2-wide', 'idle.json')));
if (!ml) { console.error('No .local/ml/work2-wide/idle.json: run scripts/ml/bvh_idle.py --select wide first.'); process.exit(2); }
const out = path.resolve(ml, '..', 'unbound-night', 'motion-model', 'frames2');
const buildDir = path.join(ml, 'preview-build');
mkdirSync(out, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
await build({ entryPoints: [path.join(root, 'scripts/ml/idle-preview-main.ts')], outfile: path.join(buildDir, 'main.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
await build({ entryPoints: [path.join(root, 'scripts/ml/idle-preview-page.ts')], outfile: path.join(buildDir, 'page.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'error' });
writeFileSync(path.join(buildDir, 'page.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src idlep:; style-src \'unsafe-inline\'; img-src idlep: blob: data:; connect-src idlep: blob: data:">'
  + '<style>html,body{margin:0;overflow:hidden;background:#f3ede6}canvas{display:block}</style><body><script src="idlep://app/page.js"></script></body>');
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'idle-preview-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({
  out, build: buildDir, gene, userData, seed: 1, groups: ['rest', 'people', 'procedural', 'matching', 'model+events'], times: [4, 7, 10, 13, 16, 19, 22, 25],
  data: {
    'wide.json': path.join(ml, 'work2-wide', 'idle.json'), 'wide.f32': path.join(ml, 'work2-wide', 'idle.f32'), 'wide-activity.f32': path.join(ml, 'work2-wide', 'idle-activity.f32'),
    'people.json': path.join(ml, 'work2-curated', 'idle.json'), 'people.f32': path.join(ml, 'work2-curated', 'idle.f32'), 'people-activity.f32': path.join(ml, 'work2-curated', 'idle-activity.f32'),
    'model.json': valueOf('--model') ?? path.join(ml, 'out2', 'idle-vae.json'), 'events.json': path.join(ml, 'events', 'events.json'), 'events.f32': path.join(ml, 'events', 'events.f32'),
  },
}));
const electron = createRequire(import.meta.url)('electron');
console.log(`idle preview → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping the preview.'); child.kill(); }, 300_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* a temporary folder */ }
console.log(`done (exit ${code}).`);
process.exit(code);
