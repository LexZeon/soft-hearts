// Development (round 11): every hand beat of a choreography (hand-face, wave, hand-sign) through the real frame loop: the fingers'
// clearance from her surface during the beat and the arm bones' largest per-frame step in it.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-hands-check.ts <choreography.json> [fps]
import { readFileSync } from 'node:fs';
import { runShowcase, SHOWCASE_TRACKED } from '../../tests/helpers/unbound-showcase';
import { validateBeats } from '../../shared/unbound/showcase';
import { loadIdleEvents, loadIdleModel } from '../ml/idle-data';

const v = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { segments: unknown[][]; seed?: number; liveliness?: number };
const fps = Number(process.argv[3] ?? 60);
const beats = validateBeats(v.segments.flat(), { from: 0, to: 62 })!.beats;
let weights = null, events = null;
try { weights = loadIdleModel(); events = loadIdleEvents(); } catch { /* procedural */ }
const run = await runShowcase(fps, Math.max(...beats.map(b => b.at + b.dur)) + 2, beats, { seed: v.seed, liveliness: v.liveliness, idle: { weights, events } });
const ARM = ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首'].map(n => SHOWCASE_TRACKED.indexOf(n as (typeof SHOWCASE_TRACKED)[number]));
for (const b of beats.filter(x => x.kind === 'hand-face' || x.kind === 'wave' || x.kind === 'hand-sign')) {
  const inBeat = run.frames.filter(f => f.t >= b.at && f.t <= b.at + b.dur + 0.8);
  let step = 0;
  for (const f of inBeat) { const i = run.frames.indexOf(f); if (i > 1) for (const a of ARM) step = Math.max(step, f.rotations[a].angleTo(run.frames[i - 1].rotations[a]) * 180 / Math.PI); }
  const c = inBeat.filter(f => f.clearance !== null).map(f => f.clearance!);
  console.log(JSON.stringify({ fps, at: b.at, kind: b.kind, what: b.sign ?? b.where ?? b.size, side: b.side,
    clearanceMinCm: c.length ? +(Math.min(...c) * 100).toFixed(2) : null, handUpMax: +Math.max(0, ...inBeat.map(f => f.handsUp)).toFixed(2), armStepMaxDeg: +step.toFixed(2) }));
}
