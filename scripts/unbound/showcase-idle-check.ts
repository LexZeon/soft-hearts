// Development (round 7): one recorded choreography through the real frame loop with the learned idle off and on (weights from
// .local/ml; none there: the procedural idle). Prints the numbers the iteration log quotes.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-idle-check.ts <choreography.json> [fps]
import { readFileSync } from 'node:fs';
import { Quaternion } from 'three';
import { boneOf, eyeAngles, maxOf, pointSurprisesOf, quantile, runShowcase, SHOWCASE_TRACKED, steps, surprises, type ShowcaseFrame } from '../../tests/helpers/unbound-showcase';
import { validateBeats } from '../../shared/unbound/showcase';
import { loadIdleEvents, loadIdleModel } from '../ml/idle-data';

const v = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { segments: unknown[][] };
const fps = Number(process.argv[3] ?? 60);
const beats = validateBeats(v.segments.flat(), { from: 0, to: 62 })!.beats;
const seconds = Math.max(...beats.map(b => b.at + b.dur)) + 2;
let weights = null, events = null;
try { weights = loadIdleModel(); events = loadIdleEvents(); } catch { /* procedural */ }

const DEG = 180 / Math.PI;
const quiet = (f: ShowcaseFrame) => (f.beats.includes('hold-gaze') || f.beats.includes('own-world')) && !f.beats.some(b => b === 'hand-face' || b === 'wave');
/** How far a bone wanders over a quiet stretch: the angle from its 1-s-earlier pose, mean over quiet frames (deg). */
function wander(frames: readonly ShowcaseFrame[], name: (typeof SHOWCASE_TRACKED)[number]): number {
  const b = boneOf(name), lag = fps, out: number[] = [], q = new Quaternion();
  for (let i = lag; i < frames.length; i++) if (quiet(frames[i]) && quiet(frames[i - lag])) out.push(q.copy(frames[i].rotations[b]).angleTo(frames[i - lag].rotations[b]) * DEG);
  return out.length ? out.reduce((s, x) => s + x, 0) / out.length : 0;
}
for (const on of [false, true]) {
  const run = await runShowcase(fps, seconds, beats, on ? { idle: { weights, events } } : {});
  const f = run.frames.slice(Math.round(fps));
  const all = SHOWCASE_TRACKED.map((_, i) => i);
  const eyes = eyeAngles(f);
  console.log(JSON.stringify({
    idle: on ? (weights ? 'model+events' : 'procedural') : 'off', fps,
    eyeP95: +quantile(eyes, 0.95).toFixed(2),
    handMinCm: +(Math.min(...f.map(x => x.clearance ?? 1)) * 100).toFixed(2),
    stepMaxDeg: +maxOf(steps(f, all)).toFixed(2),
    surpriseP99Deg: +quantile(surprises(f, all), 0.99).toFixed(3),
    rootJumpMaxM: +maxOf(pointSurprisesOf(f.map(x => x.root))).toFixed(4),
    quietFrames: f.filter(quiet).length,
    wanderDeg: { chest: +wander(f, '上半身2').toFixed(2), head: +wander(f, '頭').toFixed(2), leftArm: +wander(f, '左腕').toFixed(2), center: +wander(f, 'センター').toFixed(2) },
  }));
}
