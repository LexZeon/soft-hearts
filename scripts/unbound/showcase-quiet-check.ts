// Development (round 9): a quiet hold (she notices you, then holds your look for 20 s) through the real frame loop with the
// learned idle on, at two liveliness levels. Prints head speed p50 / p90 / p95 / p99 (°/s, the head bone's world rotation, as
// scripts/ml/idle-compare.ts measures people) and the share of time the head is nearly still (< 1°/s), over 4–20 s.
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-quiet-check.ts [fps]
import { runShowcase, SHOWCASE_TRACKED, quantile } from '../../tests/helpers/unbound-showcase';
import { validateBeats } from '../../shared/unbound/showcase';
import { loadIdleEvents, loadIdleModel } from '../ml/idle-data';
import { setLivelierQuiet, setStillWindows } from '../../src/unbound/showcase/performer';

const fps = Number(process.argv[2] ?? 60);
let weights = null, events = null;
try { weights = loadIdleModel(); events = loadIdleEvents(); } catch { /* procedural */ }
const QUIET_HOLD = validateBeats([
  { at: 0, dur: 1.5, kind: 'notice', intensity: 0.5, feel: '—' },
  { at: 1.5, dur: 20, kind: 'hold-gaze', intensity: 0.5, feel: '—' },
], { from: 0, to: 62 })!.beats;
const HEAD = SHOWCASE_TRACKED.indexOf('頭');
for (const round of [8, 9, 10]) for (const liveliness of [0.8, 0.2]) {
  setLivelierQuiet(round >= 9); setStillWindows(round >= 10); // the quiet holds as rounds 8, 9 and 10 play them
  const run = await runShowcase(fps, 22, QUIET_HOLD, { liveliness, seed: 0.42, idle: { weights, events } });
  const shown = run.frames.filter(f => f.t >= 4 && f.t <= 20);
  const speed = shown.slice(1).map((f, i) => f.rotations[HEAD].angleTo(shown[i].rotations[HEAD]) * 180 / Math.PI * fps);
  const r = (v: number) => +v.toFixed(2);
  console.log(JSON.stringify({ round, liveliness, fps, idle: weights ? 'model+events' : 'procedural',
    headSpeed: { p50: r(quantile(speed, 0.5)), p90: r(quantile(speed, 0.9)), p95: r(quantile(speed, 0.95)), p99: r(quantile(speed, 0.99)) },
    stillShare: r(speed.filter(v => v < 1).length / speed.length), quietEvents: run.performer.quietEventsStarted?.length ?? 0 }));
}
