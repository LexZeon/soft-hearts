// Motion-model spike round 2: the dynamic video for the user (docs/claude/2026-11-14-motion-model-spike.md「第 2 轮」). Builds the
// video page and host, then runs them in Electron with the bundled Gene in one 1280x720 window and a temporary user-data folder.
// Only her own canvas is recorded (soft opaque background, the group's name written on it); webm files land in
// .local/unbound-night/motion-model/video/. A few minutes. Run:
//   node scripts/dev/heavy.mjs --label "idle video" -- node scripts/ml/idle-video.mjs [--seconds 20] [--activity 0.5]
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const valueOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const ml = [process.env.SOFT_HEARTS_ML_DIR, path.join(root, '.local', 'ml'), path.resolve(root, '..', '..', '..', '.local', 'ml')].filter(Boolean).find(d => existsSync(path.join(d, 'work2-wide', 'idle.json')));
if (!ml) { console.error('No .local/ml/work2-wide: run scripts/ml/bvh_idle.py --select wide first.'); process.exit(2); }
// --staystill <model json> (docs/claude/2026-11-14-staystill-idle.md): procedural / 100STYLE model / StayStill model instead, in
// video/staystill/; with --ss-events <dir>, --ss-event-rate <x>, --ss-people <data dir> (the held-out reference), --ss-group.
const staystill = valueOf('--staystill', '');
const out = path.resolve(ml, '..', 'unbound-night', 'motion-model', 'video', ...(args.includes('--unbound') ? ['unbound'] : staystill ? ['staystill'] : []));
const buildDir = path.join(ml, 'video-build');
mkdirSync(out, { recursive: true });
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
await build({ entryPoints: [path.join(root, 'scripts/ml/idle-video-main.ts')], outfile: path.join(buildDir, 'main.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'error' });
await build({ entryPoints: [path.join(root, 'scripts/ml/idle-video-page.ts')], outfile: path.join(buildDir, 'page.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', logLevel: 'error' });
writeFileSync(path.join(buildDir, 'page.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src idlep:; style-src \'unsafe-inline\'; img-src idlep: blob: data:; connect-src idlep: blob: data:; media-src blob:">'
  + '<style>html,body{margin:0;overflow:hidden;background:#f3ede6}</style><body><script src="idlep://app/page.js"></script></body>');
const gene = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03');
const userData = mkdtempSync(path.join(os.tmpdir(), 'idle-video-'));
const planFile = path.join(userData, 'plan.json');
const seconds = Number(valueOf('--seconds', '20')), activity = Number(valueOf('--activity', '0.5'));
const model = valueOf('--model', path.join(ml, 'out2', 'idle-vae.json')), events = valueOf('--events', path.join(ml, 'events'));
const ssEvents = valueOf('--ss-events', ''), ssPeople = valueOf('--ss-people', '');
const ssGroup = valueOf('--ss-group', ssEvents ? 'ss-model+events' : 'ss-model');
// --unbound (docs/claude/2026-11-14-staystill-idle.md「接进 Unbound」): with --staystill and --ss-events pointing at the bundled files
// (assets/bundled/unbound/idle/), procedural / the video version the user chose / Unbound as shipped (leash and soft bounds), in video/unbound/.
const unbound = args.includes('--unbound');
const three = unbound ? ['procedural', 'ss-model-raw+events', 'unbound'] : staystill ? ['procedural', '100style+events', ssGroup] : ['procedural', 'matching', 'model+events'];
const reference = staystill ? (ssPeople ? ['ss-people'] : []) : ['people'];
const ssData = staystill ? {
  'ss-plan.json': path.join(userData, 'ss-plan.json'), 'ss-model.json': staystill,
  ...(ssEvents ? { 'ss-events.json': path.join(ssEvents, 'events.json'), 'ss-events.f32': path.join(ssEvents, 'events.f32') } : {}),
  ...(ssPeople ? { 'ss-people.json': path.join(ssPeople, 'idle.json'), 'ss-people.f32': path.join(ssPeople, 'idle.f32'), 'ss-people-activity.f32': path.join(ssPeople, 'idle-activity.f32') } : {}),
} : {};
if (staystill) writeFileSync(path.join(userData, 'ss-plan.json'), JSON.stringify({ eventRate: Number(valueOf('--ss-event-rate', '1')) }));
writeFileSync(planFile, JSON.stringify({
  out, build: buildDir, gene, userData,
  takes: [
    { file: `side-by-side-a${activity}.webm`, mode: 'side', groups: three, seconds: seconds + 5, activity, warmS: 3 },
    { file: `one-after-another-a${activity}.webm`, mode: 'sequence', groups: [...three, ...reference], seconds, activity, warmS: 3 },
  ],
  data: {
    'wide.json': path.join(ml, 'work2-wide', 'idle.json'), 'wide.f32': path.join(ml, 'work2-wide', 'idle.f32'), 'wide-activity.f32': path.join(ml, 'work2-wide', 'idle-activity.f32'),
    'people.json': path.join(ml, 'work2-curated', 'idle.json'), 'people.f32': path.join(ml, 'work2-curated', 'idle.f32'), 'people-activity.f32': path.join(ml, 'work2-curated', 'idle-activity.f32'),
    'model.json': model, 'events.json': path.join(events, 'events.json'), 'events.f32': path.join(events, 'events.f32'),
    ...ssData,
  },
}));
const electron = createRequire(import.meta.url)('electron');
console.log(`idle video → ${out}`);
const child = spawn(electron, [path.join(buildDir, 'main.cjs'), '--plan', planFile], { stdio: 'inherit', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const timer = setTimeout(() => { console.error('Time cap reached, stopping.'); child.kill(); }, 900_000);
const code = await new Promise(resolve => { child.on('exit', c => resolve(c ?? 1)); child.on('error', () => resolve(1)); });
clearTimeout(timer);
try { rmSync(userData, { recursive: true, force: true }); } catch { /* a temporary folder */ }
console.log(`done (exit ${code}).`);
process.exit(code);
