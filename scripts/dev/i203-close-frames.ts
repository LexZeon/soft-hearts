// I-203 (docs/claude/2026-11-23-i203-kiss-hug-plan.md): measure and draw the full-screen kiss and hug, so they can be compared with the user's
// kiss storyboard and the hug's last frame. Real frame loop (tests/helpers/unbound-arrival.ts: the page's camera, floor framing and near plane
// on the user's 1536 × 960 screen), the public Gene and the synthetic VRM, 60 and 30 fps. Prints the framing at each key frame (head width as
// a share of the screen width, where her eyes, mouth and ear are in the window, the top of her head, which way her face points), the nearest
// any of her comes to the camera, the per-frame unexpected steps and the timings; writes PNGs (a small software renderer, no app) under
// .local/i203/<label>/.
//   node node_modules/tsx/dist/cli.mjs scripts/dev/i203-close-frames.ts [label] [--no-png] [--only Gene|VRM] [--fps 60]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boneSurprises, max, pointSurprises, runArrival, type ArrivalFrame } from '../../tests/helpers/unbound-arrival';
import { encodePng, renderMeshes, type Mark } from '../../tests/helpers/soft-render';
import { closeFraming, type CloseFraming } from '../../tests/helpers/close-framing';
import type { FaceGeometry } from '../../shared/unbound/arrival/face';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2), label = args.find(a => !a.startsWith('--') && !/^(Gene|VRM|kiss|hug|\d+)$/.test(a)) ?? 'now';
const png = !args.includes('--no-png'), only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null, fpsOnly = args.includes('--fps') ? Number(args[args.indexOf('--fps') + 1]) : null, kindOnly = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : null;
const out = path.join(root, '.local', 'i203', label);
mkdirSync(out, { recursive: true });
const GENE_DIR = path.join(root, 'assets/bundled/mmdagent-ex/gene/c7eace43dffaccff6ad0597433ef85fa57c91e03/model');

interface Shot { name: string; t: number }
type Measure = CloseFraming & { eyesAlong: number | null };
const r3 = (v: number | null | undefined) => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
const measure = (frame: ArrivalFrame, face: FaceGeometry | null, heading: number): Measure => ({ ...closeFraming(frame, face, heading), earPoint: null, eyesAlong: r3(frame.eyesAlong) });

async function one(model: 'Gene' | 'VRM', kind: 'kiss' | 'hug', fps: number) {
  // First pass: the timings (where each beat begins), so the second pass knows when to draw.
  const first = await runArrival(model, fps, kind, { measureNear: false });
  const at = (p: string) => first.frames.find(f => f.phase === p)?.t ?? null, last = (p: string) => [...first.frames].reverse().find(f => f.phase === p)?.t ?? null;
  const lean = at('lean'), hold = at('hold'), holdEnd = last('hold'), settle = at('settle'), end = first.frames.at(-1)!.t;
  const shots: Shot[] = lean === null ? [] : kind === 'kiss'
    ? [{ name: '01', t: lean }, { name: '02', t: lean + 0.9 }, { name: '03', t: hold ?? lean + 1.7 }, { name: '04', t: holdEnd ?? lean + 3.2 }, { name: '05', t: (holdEnd ?? lean + 3.2) + 1.2 }]
    : [{ name: 'approach', t: lean + 0.9 }, { name: 'hold', t: (hold ?? lean + 1.7) + 0.5 }, { name: 'leave', t: (holdEnd ?? lean + 3.2) + 0.6 }];
  const taken = new Map<string, Measure>(), holdMeasures: Measure[] = [];
  const run = await runArrival(model, fps, kind, {
    inspect: (frame, _mesh, camera, figure, meshes) => {
      const sense = figure.sense, face = sense?.face ?? null, heading = sense?.root.heading ?? 0;
      if (frame.phase === 'hold') holdMeasures.push(measure(frame, face, heading));
      for (const shot of shots) if (!taken.has(shot.name) && frame.t >= shot.t - 1e-6) {
        const m = measure(frame, face, heading);
        taken.set(shot.name, m);
        if (png && fps === 60) {
          const marks: Mark[] = [];
          if (frame.eyes.left) marks.push({ ...frame.eyes.left, color: [40, 90, 230] });
          if (frame.eyes.right) marks.push({ ...frame.eyes.right, color: [40, 90, 230] });
          if (frame.mouth) marks.push({ ...frame.mouth, color: [230, 50, 60] });
          const ear = closeFraming(frame, face, heading).earPoint;
          if (ear && kind === 'hug') marks.push({ ...ear, color: [30, 170, 70] });
          const picture = renderMeshes(meshes, camera, 768, 480, { modelDir: model === 'Gene' ? GENE_DIR : null, marks, grid: true });
          writeFileSync(path.join(out, `${model}-${kind}-${shot.name}.png`), encodePng(picture));
        }
      }
    },
  });
  const close = run.frames.filter(f => f.nearest), names = run.boneNames;
  const pick = (test: (n: string) => boolean) => names.flatMap((n, i) => test(n) ? [i] : []);
  const k = 60 / fps;
  const holdAgg = (get: (m: Measure) => number | null) => { const v = holdMeasures.map(get).filter((x): x is number => x !== null); return v.length ? [r3(Math.min(...v)), r3(Math.max(...v))] : null; };
  return {
    model, kind, fps,
    timings: { leanStart: r3(lean), stepAt: r3(lean === null ? null : lean + 0.9), holdStart: r3(hold), arriveS: r3(hold !== null && lean !== null ? hold - lean : null), holdS: r3(run.holdS), plannedHoldS: r3((run.plan as { holdS: number }).holdS), backS: r3(settle !== null && holdEnd !== null ? settle - holdEnd : null), total: r3(end) },
    shots: Object.fromEntries(taken),
    hold: { headShare: holdAgg(m => m.headShare), eyesV: holdAgg(m => m.eyes?.[1] ?? null), mouthV: holdAgg(m => m.mouth?.[1] ?? null), eyesU: holdAgg(m => m.eyes?.[0] ?? null), earU: holdAgg(m => m.ear?.[0] ?? null), earV: holdAgg(m => m.ear?.[1] ?? null), crownV: holdAgg(m => m.crownV), turnDeg: holdAgg(m => m.turnDeg) },
    nearest: { viewMargin: close.length ? r3(Math.min(...close.map(f => f.nearest!.view - f.nearM))) : null, all: close.length ? r3(Math.min(...close.map(f => f.nearest!.all))) : null, arms: close.length ? r3(Math.min(...close.map(f => f.nearest!.arms))) : null },
    steps: { rootCm: r3(max(pointSurprises(run.frames.map(f => f.root)))), headCm: r3(max(pointSurprises(run.frames.map(f => f.head)))),
      torsoDeg: r3(max(boneSurprises(run.frames, pick(n => /^(センター|上半身2?|首|頭|hips|spine|chest|neck|head)$/.test(n))))), upperDeg: r3(max(boneSurprises(run.frames, pick(n => !/足|ひざ|Leg|Foot/.test(n))))), limits: { root: r3(0.1 * k * k), head: r3(0.35 * k * k), torso: r3(0.3 * k * k) } },
    target: run.target,
  };
}

const results = [];
for (const model of ['Gene', 'VRM'] as const) for (const kind of ['kiss', 'hug'] as const) for (const fps of [60, 30]) {
  if (only && only !== model) continue;
  if (fpsOnly && fpsOnly !== fps) continue;
  if (kindOnly && kindOnly !== kind) continue;
  const r = await one(model, kind, fps);
  results.push(r);
  console.log(JSON.stringify(r));
}
writeFileSync(path.join(out, 'numbers.json'), JSON.stringify(results, null, 1));
console.log(`wrote ${out}`);
