// E1 eye-head measurement (docs/claude/2026-11-14-eye-head-fix.md): eye-in-head angles of the bundled Gene in each scene, at 60
// and 30 fps, through the real frame loops (tests/helpers/eye-head-scenes.ts). Prints one JSON line per scene and rate.
//   node scripts/dev/heavy.mjs --label "eye-head measure" -- node node_modules/tsx/dist/cli.mjs scripts/unbound/eye-head-measure.ts [label]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { axisMm, backFrames, edgeScene, eyeStats, holdFrames, peekScene, walkBackScene } from '../../tests/helpers/eye-head-scenes';

const label = process.argv[2] ?? 'run';
const out: Record<string, unknown> = {};
for (const fps of [60, 30]) {
  const edge = await edgeScene(fps);
  out[`edge@${fps}`] = { laptop: eyeStats(edge.filter(f => f.phase === 'edge-laptop'), fps), wide: eyeStats(edge.filter(f => f.phase === 'edge-wide'), fps) };
  const walk = await walkBackScene(fps);
  out[`u1-walk-back@${fps}`] = { away: eyeStats(walk.filter(f => f.phase === 'away'), fps), return: eyeStats(walk.filter(f => f.phase === 'return'), fps), all: eyeStats(walk, fps) };
  const peek = await peekScene(fps);
  const hold = holdFrames(peek.frames, fps);
  out[`peek@${fps}`] = { whole: eyeStats(peek.frames, fps), back: eyeStats(backFrames(peek.frames), fps), hold: { ...eyeStats(hold, fps), axisMm: axisMm(hold) },
    phases: [...new Set(peek.frames.map(f => f.phase))] };
  for (const [key, value] of Object.entries(out)) if (key.endsWith(`@${fps}`)) console.log(key, JSON.stringify(value));
}
const dir = path.resolve('.local', 'eye-head');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(out, null, 2));
