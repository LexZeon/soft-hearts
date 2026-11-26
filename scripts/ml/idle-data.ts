// Motion-model spike (docs/claude/2026-11-14-motion-model-spike.md): loads what scripts/ml/bvh_idle.py, train_idle_vae.py and
// idle_events.py write under .local/ml/ (never in the repository) into the spike's idle sources.
//   work2-wide/     round 2 training set (standing stretches of every take but the 20 curated idles), also the matching database
//   work2-curated/  the 20 curated idle takes (held out: the human reference)
//   out2/           the round 2 model; events/  the quick-move library
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IdleDatabase } from '../../src/unbound/motion/idle-matching';
import type { IdleModelWeights } from '../../src/unbound/motion/idle-model';
import type { IdleEventLibrary } from '../../src/unbound/motion/idle-events';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The main checkout's .local/ml (worktrees share it). */
export function mlRoot(): string {
  const candidates = [process.env.SOFT_HEARTS_ML_DIR, path.resolve(here, '../../.local/ml'), path.resolve(here, '../../../../../.local/ml')].filter(Boolean) as string[];
  return candidates.find(dir => existsSync(path.join(dir, 'work2-wide', 'idle.json'))) ?? candidates[candidates.length - 1];
}

const f32 = (file: string) => { const b = readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

export type LoadedDatabase = IdleDatabase & { meta: { channels: string[]; keptSeconds?: number; segments: { style: string; kind?: string; start: number; length: number }[] } };
export function loadIdleDatabase(dir = path.join(mlRoot(), 'work2-wide')): LoadedDatabase {
  const meta = JSON.parse(readFileSync(path.join(dir, 'idle.json'), 'utf8'));
  return { frames: f32(path.join(dir, 'idle.f32')), activity: f32(path.join(dir, 'idle-activity.f32')), segments: meta.segments, std: meta.std, meta };
}

export function loadIdleModel(file = path.join(mlRoot(), 'out2', 'idle-vae.json')): IdleModelWeights {
  return JSON.parse(readFileSync(file, 'utf8')) as IdleModelWeights;
}

export function loadIdleEvents(dir = path.join(mlRoot(), 'events')): IdleEventLibrary & { count: number } {
  const meta = JSON.parse(readFileSync(path.join(dir, 'events.json'), 'utf8'));
  return { events: f32(path.join(dir, 'events.f32')), frames: meta.frames, perMinuteByActivityFifth: meta.perMinuteByActivityFifth, count: meta.count };
}
