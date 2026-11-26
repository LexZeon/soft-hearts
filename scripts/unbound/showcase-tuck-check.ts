// Development (round 9): the "hair behind the ear" beat in a recorded choreography (an insertion test) through the real frame
// loop: the fingers' clearance from her head during the beat, and the arm bones' largest per-frame steps in the beat and in the
// whole run (the other hand beats set the range it should stay in).
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-tuck-check.ts <choreography.json> [fps]
import { readFileSync } from 'node:fs';
import { runShowcase, SHOWCASE_TRACKED } from '../../tests/helpers/unbound-showcase';
import { validateBeats } from '../../shared/unbound/showcase';
import { loadIdleEvents, loadIdleModel } from '../ml/idle-data';

const v = JSON.parse(readFileSync(process.argv[2], "utf8")) as { segments: unknown[][]; seed?: number; liveliness?: number };
const fps = Number(process.argv[3] ?? 60);
const beats = validateBeats(v.segments.flat(), { from: 0, to: 62 })!.beats;
const tuck = beats.find(b => b.kind === 'hand-face' && b.where === 'ear');
let weights = null, events = null;
try { weights = loadIdleModel(); events = loadIdleEvents(); } catch { /* procedural */ }
const run = await runShowcase(fps, Math.max(...beats.map(b => b.at + b.dur)) + 2, beats, { seed: v.seed, liveliness: v.liveliness, idle: { weights, events } });
const ARM = ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首'].map(n => SHOWCASE_TRACKED.indexOf(n as (typeof SHOWCASE_TRACKED)[number]));
const step = (from: number, to: number) => {
  let m = 0;
  for (let i = 2; i < run.frames.length; i++) if (run.frames[i].t >= from && run.frames[i].t <= to) for (const b of ARM) m = Math.max(m, run.frames[i].rotations[b].angleTo(run.frames[i - 1].rotations[b]) * 180 / Math.PI);
  return +m.toFixed(2);
};
const inTuck = tuck ? run.frames.filter(f => f.t >= tuck.at && f.t <= tuck.at + tuck.dur && f.clearance !== null) : [];
if (process.env.TUCK_DEBUG) for (const f of inTuck) if (f.clearance! < 0.01) console.log(`  ${(f.t - tuck!.at).toFixed(2)} s into the beat: ${(f.clearance! * 100).toFixed(2)} cm, hand up ${f.handsUp.toFixed(2)}`);
console.log(JSON.stringify({ fps, tuck: tuck ? { at: tuck.at, dur: tuck.dur, side: tuck.side } : null,
  clearanceMinCm: inTuck.length ? +(Math.min(...inTuck.map(f => f.clearance!)) * 100).toFixed(2) : null,
  handUpMax: inTuck.length ? +Math.max(...inTuck.map(f => f.handsUp)).toFixed(2) : null,
  armStepMaxDeg: { inTuck: tuck ? step(tuck.at, tuck.at + tuck.dur + 1) : null, wholeRun: step(0, 1e9) } }));
