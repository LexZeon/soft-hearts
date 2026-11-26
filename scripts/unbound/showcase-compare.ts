// Unbound showcase self-check across runs (docs/claude/2026-11-14-lapwing-showcase.md): reads each run's choreography.json and
// prints how different the runs are (beat order as an edit distance, timing, intensities) and, for beat types they share, the
// parameters each instance actually played with (Claude's and the performer's own variation), side by side.
//   tsx scripts/unbound/showcase-compare.ts <run dir> <run dir> [...]
import { readFileSync } from 'node:fs';
import path from 'node:path';

interface Played { at: number; dur: number; kind: string; intensity: number; name?: string; side?: string; deg?: number; size?: string; where?: string; amount?: number; lean?: number; vary?: Record<string, number> }
const runs = process.argv.slice(2).map(dir => {
  const v = JSON.parse(readFileSync(path.join(dir, 'choreography.json'), 'utf8')) as { mood: Record<string, number>; situation: string; result: { played: Played[]; eyeInHeadDeg: unknown; handClearanceCm: number | null } };
  return { name: path.basename(dir), mood: v.mood, situation: v.situation, played: v.result.played, eye: v.result.eyeInHeadDeg, clearance: v.result.handClearanceCm };
});
const label = (b: Played) => `${b.kind}${b.name ? `:${b.name}` : ''}`;
function edit(a: string[], b: string[]): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
for (const r of runs) console.log(`${r.name}: mood ${JSON.stringify(r.mood)}; ${r.played.length} beats; ${r.situation}`);
for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
  const a = runs[i].played.map(label), b = runs[j].played.map(label);
  const firstNotice = (r: typeof runs[number]) => r.played.find(x => x.kind === 'notice')?.at ?? null;
  console.log(`${runs[i].name} vs ${runs[j].name}: beat-order edit distance ${edit(a, b)} of ${Math.max(a.length, b.length)}; notice at ${firstNotice(runs[i])} / ${firstNotice(runs[j])} s`);
}
const kinds = ['tilt', 'wave', 'hand-face', 'approach', 'glance', 'expression'];
for (const kind of kinds) {
  console.log(`\n== ${kind}`);
  for (const r of runs) for (const b of r.played.filter(x => x.kind === kind)) {
    const params = [b.side, b.deg !== undefined ? `${b.deg}°` : '', b.size, b.where, b.name, b.amount !== undefined ? `amount ${b.amount}` : '', b.lean !== undefined ? `lean ${b.lean}` : ''].filter(Boolean).join(' ');
    const vary = b.vary ? Object.entries(b.vary).map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(' ') : '(no variation recorded)';
    console.log(`  ${r.name} @${b.at.toFixed(1)}s ${b.dur.toFixed(1)}s i${b.intensity} ${params} | ${vary}`);
  }
}
