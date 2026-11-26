// Debug (development only): fingers against the face over time for a recorded choreography (frames under 3 mm).
import { readFileSync } from 'node:fs';
import { runShowcase } from '../../tests/helpers/unbound-showcase';
import { validateBeats } from '../../shared/unbound/showcase';
const v = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { segments: unknown[][] };
const beats = validateBeats(v.segments.flat(), { from: 0, to: 62 })!.beats;
const run = await runShowcase(Number(process.argv[3] ?? 60), Math.max(...beats.map(b => b.at + b.dur)) + 2, beats);
for (const f of run.frames) if (f.clearance !== null && f.clearance < 0.003) console.log(f.t.toFixed(2), (f.clearance * 100).toFixed(2), f.handsUp.toFixed(2), f.beats.join(','));
console.log('min', Math.min(...run.frames.map(f => f.clearance ?? 1)) * 100);
