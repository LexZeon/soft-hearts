// Unbound U0 measurement (docs/claude/2026-11-12-unbound-u0.md). Measures only; changes nothing in the app.
//
//   node scripts/dev/heavy.mjs --label "unbound u0" -- node scripts/unbound/u0-probe.mjs --dry-run     (small 400x300 window, a few seconds)
//   node scripts/dev/heavy.mjs --label "unbound u0" -- node scripts/unbound/u0-probe.mjs --parts a,geometry,display,closeup,click
//   node scripts/unbound/u0-probe.mjs --full      (needs the user away: a transparent layer and Gene over the whole primary screen, ~2 min)
//
// --full registers itself on the bridge occupancy sign (registerHeavyOccupancy, like the pretrial) and does not go through
// heavy.mjs: that would put the probe at below-normal priority on 10 cores, which would change what is measured. It refuses to
// start while the tray says the user is at the computer (--ignore-presence overrides, for the user's own run).
// Everything runs in an isolated temporary user-data directory; the app's profiles are never touched.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPresence, registerHeavyOccupancy } from '../dev/presence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const full = flag('--full'), dry = flag('--dry-run');
const parts = new Set((valueOf('--parts') ?? '').split(',').filter(Boolean));
if (!full && !dry && !parts.size) { console.error('Use --dry-run, --parts a,geometry,display,closeup,click or --full (see the top of this file).'); process.exit(2); }

const SEC = { a: 12, b: 20, c: 20, d: 20 };
const steps = [];
if (dry) {
  steps.push({ kind: 'render', name: 'dry-run 400x300', framing: 'pet', idle: false, seconds: 3, size: 'dry' },
    { kind: 'geometry', rates: [1, 5, 10], seconds: 3 }, { kind: 'display' }, { kind: 'click', size: 'small' }, { kind: 'closeup' });
} else if (full) {
  const s = SEC;
  steps.push({ kind: 'render', name: 'a pet window 400x560 (baseline)', framing: 'pet', idle: false, seconds: s.a, size: 'pet' },
    { kind: 'render', name: 'b full screen, her small in a corner', framing: 'corner', idle: false, seconds: s.b, size: 'full' },
    { kind: 'render', name: 'c full screen, face close, half the screen', framing: 'face', idle: false, seconds: s.c, size: 'full' },
    { kind: 'render', name: 'd full screen, her small, idle (breath only)', framing: 'corner', idle: true, seconds: s.d, size: 'full' },
    { kind: 'click', size: 'full' });
} else {
  const secondsOf = Number(valueOf('--seconds') ?? 25);
  if (parts.has('a')) steps.push({ kind: 'render', name: 'a pet window 400x560', framing: 'pet', idle: false, seconds: secondsOf, size: 'pet' });
  if (parts.has('geometry')) steps.push({ kind: 'geometry', rates: [1, 5, 10], seconds: Number(valueOf('--geometry-seconds') ?? 10) });
  if (parts.has('display')) steps.push({ kind: 'display' });
  if (parts.has('click')) steps.push({ kind: 'click', size: 'small' });
  if (parts.has('closeup')) steps.push({ kind: 'closeup' });
}

if (full && !flag('--ignore-presence')) {
  const presence = readPresence();
  if (presence.present) { console.error(`The tray says the user is at the computer (${presence.reason}). --full covers the whole screen; run it when they are away, or pass --ignore-presence for the user's own run.`); process.exit(3); }
}

const local = path.join(root, '.local', 'unbound-u0');
const build_ = path.join(local, 'build');
mkdirSync(build_, { recursive: true });
await build({ entryPoints: [path.join(root, 'scripts/unbound/u0-main.ts')], outfile: path.join(build_, 'main.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
await build({ entryPoints: [path.join(root, 'scripts/unbound/u0-page.ts')], outfile: path.join(build_, 'page.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'error', minify: false });
writeFileSync(path.join(build_, 'page.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src u0: \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src u0: blob: data:; connect-src u0: blob: data:">'
  + '<style>html,body{margin:0;background:transparent;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style><canvas id="c"></canvas><script src="u0://app/page.js"></script>');

const geneRoot = path.join(root, 'assets/bundled/mmdagent-ex/gene');
const geneDir = path.join(geneRoot, readdirSync(geneRoot)[0]);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(local, full ? `full-${runId}` : dry ? `dry-${runId}` : `parts-${runId}`);
const userData = mkdtempSync(path.join(os.tmpdir(), 'u0-probe-profile-'));
const plan = path.join(userData, 'plan.json');
writeFileSync(plan, JSON.stringify({ out, build: build_, geneDir, userData, steps }));

const unregister = full ? await registerHeavyOccupancy('unbound u0 full-screen overlay measurement (transparent layer over the whole screen, about 2 minutes)', { log: line => console.log(line) }) : () => {};
const electronExe = (await import('node:module')).createRequire(import.meta.url)('electron');
const capMs = (full ? 170 : 150) * 1000;
console.log(`U0 probe: ${steps.length} step(s), output ${out}`);
const child = spawn(electronExe, [path.join(build_, 'main.cjs'), '--plan', plan], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping the probe.'); child.kill(); }, capMs);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer); unregister();
try { rmSync(userData, { recursive: true, force: true }); } catch { /* temp profile; the OS cleans it later */ }
console.log(`done (exit ${code}). Results: ${path.join(out, 'results.json')}`);
process.exit(code);
