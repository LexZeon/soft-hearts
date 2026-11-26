// Unbound's bundled idle (docs/claude/2026-11-14-staystill-idle.md「接进 Unbound」): a long simulated run in Gene's real Unbound frame
// loop (headless, as fast as the machine goes), measured as it streams (tests/helpers/unbound-idle-stream.ts): unexpected steps,
// root and ankle drift, steps, the centre of mass to the support edge, head deviation per minute, the idle's head chain, NaN, heap.
//   node scripts/dev/heavy.mjs --label "unbound idle long run" -- node node_modules/tsx/dist/cli.mjs scripts/unbound/idle-long-run.ts [--minutes 30] [--fps 60,30] [--procedural] [--seeds 7] [--leash 12] [--bounds 30,45,0.016,0.025|none]
// Writes JSON to .local/unbound-night/motion-model/ (not committed).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIdleStream, shippedIdle } from '../../tests/helpers/unbound-idle-stream';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const minutes = Number(opt('--minutes', '30'));
const fpsList = opt('--fps', '60,30').split(',').map(Number);
const procedural = args.includes('--procedural');
const seeds = opt('--seeds', '7').split(',').map(Number);
const leashS = args.includes('--leash') ? Number(opt('--leash', '12')) : null;
// --bounds headKneeDeg,headMaxDeg,hipKnee,hipMax (per m of height) or none: try other soft limits than the manifest's.
const boundsArg = args.includes('--bounds') ? opt('--bounds', 'none') : null;
const bounds = boundsArg === null ? undefined : boundsArg === 'none' ? null : (([a, b, c, d]) => ({ headYawKneeDeg: a, headYawMaxDeg: b, hipShiftKnee: c, hipShiftMax: d }))(boundsArg.split(',').map(Number));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainCheckout = root.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) ? path.resolve(root, '..', '..', '..') : root;
const outDir = path.join(mainCheckout, '.local', 'unbound-night', 'motion-model');
mkdirSync(outDir, { recursive: true });

const bundled = procedural ? null : await shippedIdle();
if (!procedural && !bundled) { console.error('the shipped idle model did not load'); process.exit(1); }
const results = [];
for (const fps of fpsList) for (const seed of seeds) {
  const shown = bundled ? { ...bundled, settings: { ...bundled.settings, ...(leashS !== null ? { leashS } : {}), ...(bounds !== undefined ? { bounds } : {}) } } : bundled;
  const result = await runIdleStream({ fps, seed, seconds: minutes * 60, bundled: shown, onMinute: (minute, r) => {
    if (minutes > 2) console.log(`${fps} fps seed ${seed} minute ${minute}: jolt max ${r.jolt.perMinuteMax.at(-1)}°, head p95 ${r.head.perMinuteP95.at(-1)}°, chain yaw mean ${r.chainYaw.perMinuteMean.at(-1)}°, heap ${r.heapMb.max.toFixed(1)} MB`);
  } });
  console.log(JSON.stringify({ seed, ...result, jolt: { ...result.jolt, perMinuteMax: undefined }, head: { ...result.head, perMinuteP95: undefined }, chainYaw: { ...result.chainYaw, perMinuteMean: undefined } }));
  results.push(result);
}
const file = path.join(outDir, `unbound-idle-long-${procedural ? 'procedural' : 'staystill'}${leashS !== null ? `-l${leashS}` : ''}${boundsArg !== null ? `-b${boundsArg}` : ''}-${minutes}min.json`);
writeFileSync(file, JSON.stringify({ minutes, procedural, results }, null, 1));
console.log(file);
