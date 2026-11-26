// Development: how the blush rises and fades in a showcase run through the real frame loop (the bundled Gene unless SHOWCASE_MODEL
// names another PMX; the learned idle on as on the page; the run's own seed and liveliness). For each blush episode: its peak,
// the time from below 0.1 to above 0.6, the 10→90% rise and the 90→10% fade of its own peak, and the largest one-frame step.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-blush-measure.ts <choreography.json> [fps]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MORPH_ALIASES } from '../../shared/foundation/universal-skeleton';

export interface BlushEpisode { from: number; peakAt: number; peak: number; lowToHighS: number | null; rise10to90S: number | null; fade90to10S: number | null; maxStep: number }

/** Episodes of a sampled blush curve (an episode: from leaving 0.02 to coming back under it, or the end). */
export function blushEpisodes(t: readonly number[], v: readonly number[]): BlushEpisode[] {
  const out: BlushEpisode[] = [];
  let i = 0;
  while (i < v.length) {
    while (i < v.length && v[i] <= 0.02) i++;
    if (i >= v.length) break;
    const start = i;
    while (i < v.length && v[i] > 0.02) i++;
    const end = i; // exclusive
    let peakI = start;
    for (let k = start; k < end; k++) if (v[k] > v[peakI]) peakI = k;
    const peak = v[peakI];
    const firstAbove = (from: number, to: number, x: number) => { for (let k = from; k <= to; k++) if (v[k] >= x) return k; return -1; };
    const firstBelowAfter = (from: number, x: number) => { for (let k = from; k < end; k++) if (v[k] <= x) return k; return -1; };
    let lowToHighS: number | null = null;
    const high = firstAbove(start, peakI, 0.6);
    if (high >= 0) { let low = high; while (low > 0 && v[low] >= 0.1) low--; lowToHighS = +(t[high] - t[low]).toFixed(3); }
    const r10 = firstAbove(start, peakI, 0.1 * peak), r90 = firstAbove(start, peakI, 0.9 * peak);
    const f90 = firstBelowAfter(peakI, 0.9 * peak), f10 = firstBelowAfter(peakI, 0.1 * peak);
    let maxStep = 0;
    for (let k = Math.max(1, start); k < Math.min(v.length, end + 1); k++) maxStep = Math.max(maxStep, Math.abs(v[k] - v[k - 1]));
    out.push({ from: +t[start].toFixed(3), peakAt: +t[peakI].toFixed(3), peak: +peak.toFixed(3), lowToHighS,
      rise10to90S: r10 >= 0 && r90 >= 0 ? +(t[r90] - t[r10]).toFixed(3) : null,
      fade90to10S: f90 >= 0 && f10 >= 0 ? +(t[f10] - t[f90]).toFixed(3) : null, maxStep: +maxStep.toFixed(3) });
  }
  return out;
}

const isBlush = (name: string) => MORPH_ALIASES.shy.some(a => a.toLowerCase() === name.toLowerCase());

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { runShowcase } = await import('../../tests/helpers/unbound-showcase');
  const { validateBeats } = await import('../../shared/unbound/showcase');
  const { loadIdleEvents, loadIdleModel } = await import('../ml/idle-data');
  const v = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { segments: unknown[][]; seed?: number; liveliness?: number };
  const fps = Number(process.argv[3] ?? 60);
  if (process.env.SHOWCASE_BLUSH_OLD) (await import('../../src/unbound/showcase/blush-envelope')).setSlowBlush(false); // the old blush, for a comparison
  const beats = validateBeats(v.segments.flat(), { from: 0, to: 62 })!.beats;
  let weights = null, events = null;
  try { weights = loadIdleModel(); events = loadIdleEvents(); } catch { /* procedural */ }
  const t: number[] = [], value: number[] = [];
  await runShowcase(fps, Math.max(...beats.map(b => b.at + b.dur)) + 4, beats, { seed: v.seed, liveliness: v.liveliness, idle: { weights, events }, modelPath: process.env.SHOWCASE_MODEL || undefined,
    onFrame: (mesh, at) => {
      const dict = mesh.morphTargetDictionary ?? {}, inf = mesh.morphTargetInfluences ?? [];
      let top = 0;
      for (const [name, index] of Object.entries(dict)) if (isBlush(name)) top = Math.max(top, inf[index] ?? 0);
      t.push(at); value.push(top);
    } });
  const shy = beats.filter(b => b.kind === 'expression').map(b => `${b.name}@${b.at}`);
  console.log(JSON.stringify({ file: process.argv[2], fps, expressions: shy }));
  for (const e of blushEpisodes(t, value)) console.log(JSON.stringify(e));
}
