// Unbound showcase bench (docs/claude/2026-11-14-lapwing-showcase.md): runs a choreography (a fake one, or a JSON file Claude
// wrote) on the bundled Gene at 60 and 30 fps through the real frame loop and prints the self-check numbers, with the peek
// (凑镜头) as the reference for the unexpected step. Usage:
//   node node_modules/tsx/dist/cli.mjs scripts/unbound/showcase-bench.ts [a|b|path/to/choreography.json] [--no-peek]
import { readFileSync } from 'node:fs';
import { runShowcase, fakeBeats, surprises, steps, pointSurprisesOf, quantile, maxOf, eyeAngles, longestQuiet, boneOf, SHOWCASE_TRACKED } from '../../tests/helpers/unbound-showcase';
import { runPeek, pointSurprises } from '../../tests/helpers/unbound-peek';
import { surpriseAngles, TRACKED, max } from '../../tests/helpers/unbound-gene';
import { validateBeats, type ShowcaseBeat } from '../../shared/unbound/showcase';

const arg = process.argv[2] ?? 'a';
let beats: ShowcaseBeat[];
if (arg === 'a' || arg === 'b') beats = fakeBeats(arg);
else {
  const value = JSON.parse(readFileSync(arg, 'utf8')) as { beats?: unknown[]; segments?: unknown[][] };
  const raw = value.beats ?? (value.segments ?? []).flat();
  beats = validateBeats(raw, { from: 0, to: 62 })!.beats;
}
const seconds = Math.min(62, Math.max(...beats.map(b => b.at + b.dur)) + 2);
const UPPER = ['上半身', '上半身2', '首', '頭'].map(n => boneOf(n as never));
const ARMS = ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首'].map(n => boneOf(n as never));
const ALL = SHOWCASE_TRACKED.map((_, i) => i);
const out: Record<string, unknown> = { choreography: arg, seconds: Number(seconds.toFixed(1)), beats: beats.length };
for (const fps of [60, 30]) {
  const run = await runShowcase(fps, seconds, beats);
  const eyes = eyeAngles(run.frames);
  const clear = run.frames.map(f => f.clearance).filter((c): c is number => c !== null);
  out[`fps${fps}`] = {
    eyeInHeadDeg: { p95: +quantile(eyes, 0.95).toFixed(2), max: +maxOf(eyes).toFixed(2) },
    upperSurpriseDeg: { p99: +quantile(surprises(run.frames, UPPER), 0.99).toFixed(3), max: +maxOf(surprises(run.frames, UPPER)).toFixed(3) },
    armSurpriseDeg: { p99: +quantile(surprises(run.frames, ARMS), 0.99).toFixed(3), max: +maxOf(surprises(run.frames, ARMS)).toFixed(3) },
    headPointSurpriseCm: +maxOf(pointSurprisesOf(run.frames.map(f => f.head))).toFixed(3),
    rootSurpriseCm: +maxOf(pointSurprisesOf(run.frames.map(f => f.root))).toFixed(3),
    maxBoneStepDeg: +maxOf(steps(run.frames, ALL)).toFixed(2),
    armStepDegMax: +maxOf(steps(run.frames, ARMS)).toFixed(2),
    handClearanceCm: clear.length ? +(Math.min(...clear) * 100).toFixed(2) : null,
    longestQuietS: +longestQuiet(run.frames, fps).toFixed(2),
    blinksPerMin: +(run.performer.blinkTimes.length / seconds * 60).toFixed(1),
  };
}
if (!process.argv.includes('--no-peek')) {
  const UP = ['上半身', '上半身2', '首', '頭'].map(n => TRACKED.indexOf(n as never));
  for (const fps of [60, 30]) {
    const peek = await runPeek(fps, 14);
    out[`peek${fps}`] = { upperSurpriseDeg: +max(surpriseAngles(peek.frames as never, 0, UP)).toFixed(3), headPointSurpriseCm: +max(pointSurprises(peek.frames.map(f => f.head))).toFixed(3) };
  }
}
console.log(JSON.stringify(out, null, 1));
