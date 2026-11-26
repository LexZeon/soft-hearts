// Debug dump for the showcase bench (development only): frames where any tracked bone steps more than a limit, and where the
// fingers come close to her face. Usage: tsx scripts/unbound/showcase-debug.ts [a|b] [seconds] [deg]
import { runShowcase, fakeBeats, SHOWCASE_TRACKED } from '../../tests/helpers/unbound-showcase';
const run = await runShowcase(30, Number(process.argv[3] ?? 51), fakeBeats((process.argv[2] ?? 'a') as 'a'));
const limit = Number(process.argv[4] ?? 6);
for (let i = 1; i < run.frames.length; i++) {
  const f = run.frames[i], p = run.frames[i - 1];
  const steps = SHOWCASE_TRACKED.map((_, b) => f.rotations[b].angleTo(p.rotations[b]) * 180 / Math.PI);
  const big = Math.max(...steps);
  if (big > limit || (f.clearance !== null && f.clearance < 0.003))
    console.log(f.t.toFixed(2), 'step', big.toFixed(1), SHOWCASE_TRACKED[steps.indexOf(big)], 'clr', f.clearance === null ? '-' : (f.clearance * 100).toFixed(1), 'up', f.handsUp.toFixed(2), f.beats.join(','));
}
