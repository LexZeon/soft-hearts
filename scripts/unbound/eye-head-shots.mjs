// E1 eye-head screenshots (docs/claude/2026-11-14-eye-head-fix.md): builds a small page with the bundled Gene in her Unbound body
// and saves a close look at her face, from the viewer's eye, at one frame of each scene: standing past the screen's edge looking
// at the lens, turning round to walk away (U1), the peek's way home, the peek's close-up. One window far off every screen, a
// temporary user-data folder; under a minute. Output: .local/unbound-night/eye-fix/ (git-ignored).
//   node scripts/dev/heavy.mjs --label "eye-head shots" -- node scripts/unbound/eye-head-shots.mjs <label> [frames.json]
// frames.json (optional): the frame per scene to draw (e.g. the "before" run's own results, so "after" shows the same moments).
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const label = process.argv[2] ?? 'run';
const framesFile = process.argv[3];
const frames = {};
if (framesFile) for (const [name, value] of Object.entries(JSON.parse(readFileSync(framesFile, 'utf8')))) if (value && typeof value.frame === 'number') frames[name] = value.frame;
// The main repository's .local (a worktree shares it), so every run lands in one place.
const mainRoot = root.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) ? root.slice(0, root.indexOf(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) : root;
const out = path.join(mainRoot, '.local', 'unbound-night', 'eye-fix');
const buildDir = path.join(root, '.local', 'eye-head-shots', 'build');
mkdirSync(out, { recursive: true }); mkdirSync(buildDir, { recursive: true });
await build({ entryPoints: [path.join(here, 'eye-head-shots-main.ts')], outfile: path.join(buildDir, 'main.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
await build({ entryPoints: [path.join(here, 'eye-head-shots-page.ts')], outfile: path.join(buildDir, 'page.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'error' });
writeFileSync(path.join(buildDir, 'page.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src eyeshot: \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src eyeshot: blob: data:; connect-src eyeshot: blob: data:">'
  + '<style>html,body{margin:0;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style><body></body><script src="eyeshot://app/page.js"></script>');
const geneRoot = path.join(root, 'assets/bundled/mmdagent-ex/gene');
const geneDir = path.join(geneRoot, readdirSync(geneRoot)[0]);
const userData = mkdtempSync(path.join(os.tmpdir(), 'eye-head-shots-'));
const planFile = path.join(userData, 'plan.json');
writeFileSync(planFile, JSON.stringify({ out, build: buildDir, geneDir, userData, label, scenes: ['edge', 'walk', 'peek-back', 'peek-hold'], frames }));
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached.'); child.kill(); }, 240_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* temporary */ }
console.log(`done (exit ${code}) → ${out}`);
process.exit(code);
