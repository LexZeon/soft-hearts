// I-209 step 3: two pages on the shared stage through the real frame loop. The
// public Gene twice, each her own UnboundFigure (MMDLoader, CCD IK, gait and contact owner), each with her own page's stage part
// (src/unbound/company/stage-page.ts), the real coordinator's world (electron/unbound/company/stage-world.ts) between them, the reports and
// views delayed like IPC. At 60 and 30 fps:
//  - you pull A across the screen through B: B steps back first and A passes in front; no frame has the two bodies overlapping;
//  - B stands at the screen's edge and you pull A toward you through her: B cannot step aside, A stops where they touch;
//  - nobody's root ever jumps (per-frame step at most her walking pace; the "unexpected step" of R29c small);
//  - before (no stage part): A walks straight into B.
// Each window frames her own body (one floor line): tests/i209-stage-height.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { StagePage } from '../src/unbound/company/stage-page';
import { StageWorld } from '../electron/unbound/company/stage-world';
import { UNITS_PER_M, type UnboundFigure } from '../src/unbound/figure';
import { UNBOUND_BODY_DEFAULTS, type UnboundScene } from '../shared/unbound/scene';
import { placementAcross } from '../shared/unbound/world';
import type { StageBody, StageView } from '../shared/unbound/company';
import { geneFigure } from './helpers/unbound-gene';
import { userWorld } from './helpers/unbound-arrival';

const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
const IPC_MS = 12;

interface Run { minGapCm: number; maxStepCm: number; maxSurpriseCm: number; a: Vector3; b: Vector3; bStartDepth: number; held: number }

async function pullThrough(fps: number, setup: { a: { xM: number; depthM: number }; b: { xM: number; depthM: number }; target: { xM: number; depthM: number } }, staged = true, seconds = 9): Promise<Run> {
  const world = userWorld({ xM: 0, depthM: 8 });
  const scene = { world } as UnboundScene;
  const A = await geneFigure(setup.a), B = await geneFigure(setup.b);
  const figures: Record<string, UnboundFigure> = { a: A.figure, b: B.figure };
  let now = 0;
  const queue: { at: number; run: () => void }[] = [];
  const later = (run: () => void) => queue.push({ at: now + IPC_MS, run });
  const pages: Record<string, StagePage> = {};
  const coordinator = new StageWorld({ ids: () => ['a', 'b'], send: (id, view: StageView) => later(() => pages[id]!.receive(view, now)), raise: () => {}, placement: () => null, leaving: () => false, clock: () => now });
  for (const id of ['a', 'b'] as const) {
    const figure = figures[id]!;
    pages[id] = new StagePage({
      api: { stageBody: async (body: StageBody) => { later(() => coordinator.report(id, body)); }, stageLeft: async () => {}, onStage: () => () => {}, companyGuard: async () => {}, stageFrames: async () => {} },
      figure: () => figure, scene: () => scene, faceM: () => figure.heightM * 0.92, dipM: () => 0, closing: () => false,
      pulled: () => id === 'a', occupied: () => id === 'a', unitsPerM: UNITS_PER_M,
    });
  }
  coordinator.changed();
  const dt = 1 / fps;
  const roots: Record<string, Vector3[]> = { a: [], b: [] };
  let minGap = Infinity;
  const radius = (figure: UnboundFigure) => (pages.a as unknown as { measureRadius(f: unknown): number }).measureRadius.call(pages.a, figure);
  for (let f = 0; f < fps * seconds; f++) {
    now += dt * 1000;
    A.figure.followTo({ x: setup.target.xM, z: -setup.target.depthM }); // your hand: she walks along toward it (the pull's walk-along, pull-input.ts)
    if (staged) for (const id of ['a', 'b'] as const) pages[id]!.frame(now);
    A.figure.frame(dt); B.figure.frame(dt);
    for (const item of queue.splice(0).filter(q => { if (q.at <= now) return true; queue.push(q); return false; })) item.run();
    for (const id of ['a', 'b'] as const) { const r = figures[id]!.rootM; roots[id]!.push(new Vector3(r.x, 0, r.z)); }
    if (f % 4 === 0) { const ra = radius(A.figure), rb = radius(B.figure), pa = A.figure.rootM, pb = B.figure.rootM; minGap = Math.min(minGap, Math.hypot(pa.x - pb.x, pa.z - pb.z) - ra - rb); }
    await yieldLoop();
  }
  let maxStep = 0, maxSurprise = 0;
  for (const list of Object.values(roots)) {
    for (let i = 1; i < list.length; i++) maxStep = Math.max(maxStep, list[i]!.distanceTo(list[i - 1]!) * 100);
    for (let i = 2; i < list.length; i++) maxSurprise = Math.max(maxSurprise, list[i]!.clone().sub(list[i - 1]!).sub(list[i - 1]!.clone().sub(list[i - 2]!)).length() * 100);
  }
  const run = { minGapCm: minGap * 100, maxStepCm: maxStep, maxSurpriseCm: maxSurprise, a: roots.a!.at(-1)!, b: roots.b!.at(-1)!, bStartDepth: setup.b.depthM, held: pages.a!.held };
  for (const fig of [A, B]) { fig.figure.dispose(); fig.fixture.close(); }
  return run;
}

for (const fps of [60, 30]) {
  test(`pulled across the screen through B: B steps back first, A passes in front, never overlapping, never jumping (${fps} fps)`, async () => {
    const before = await pullThrough(fps, { a: { xM: -1.4, depthM: 8 }, b: { xM: 0, depthM: 8 }, target: { xM: 1.6, depthM: 8 } }, false);
    const after = await pullThrough(fps, { a: { xM: -1.4, depthM: 8 }, b: { xM: 0, depthM: 8 }, target: { xM: 1.6, depthM: 8 } });
    const pace = UNBOUND_BODY_DEFAULTS.walkSpeedMps * 100 / fps;
    console.log(`[i209 step 3] ${fps} fps pull through: before (no stage) closest gap ${before.minGapCm.toFixed(1)} cm; after ${after.minGapCm.toFixed(1)} cm, B stepped back to ${(-after.b.z).toFixed(2)} m (from ${after.bStartDepth} m), A reached x ${after.a.x.toFixed(2)} m; root step max ${after.maxStepCm.toFixed(2)} cm (walking pace ${pace.toFixed(2)}), unexpected step max ${after.maxSurpriseCm.toFixed(3)} cm (before ${before.maxSurpriseCm.toFixed(3)})`);
    assert.ok(before.minGapCm < 0, 'before: A walks straight into B (the two bodies overlap)');
    assert.ok(after.minGapCm >= 0, `after: never overlapping (closest gap ${after.minGapCm.toFixed(1)} cm)`);
    assert.ok(-after.b.z > after.bStartDepth + 0.3, 'B stepped back out of the way');
    assert.ok(after.a.x > 1.2, `A got through (x ${after.a.x.toFixed(2)})`);
    assert.ok(after.maxStepCm <= pace * 1.6, `no jump: largest per-frame root step ${after.maxStepCm.toFixed(2)} cm`);
    assert.ok(after.maxSurpriseCm < 1.0, `smooth: largest unexpected step ${after.maxSurpriseCm.toFixed(3)} cm`);
  });

  test(`at the screen's edge B cannot step aside: A, pulled toward you through her, stops where they touch (${fps} fps)`, async () => {
    const world = userWorld({ xM: 0, depthM: 8 });
    const edge = placementAcross(world, 0.93, 7).xM;
    const run = await pullThrough(fps, { a: { xM: edge - 0.08, depthM: 10 }, b: { xM: edge, depthM: 7 }, target: { xM: edge - 0.08, depthM: 4 } });
    console.log(`[i209 step 3] ${fps} fps at the edge: A stopped at depth ${(-run.a.z).toFixed(2)} m behind B at ${(-run.b.z).toFixed(2)} m; closest gap ${run.minGapCm.toFixed(1)} cm; her goal held ${run.held} frames; unexpected step max ${run.maxSurpriseCm.toFixed(3)} cm`);
    assert.ok(Math.abs(run.b.x - edge) < 0.05 && Math.abs(-run.b.z - 7) < 0.05, 'B stayed where she was');
    assert.ok(-run.a.z > 7, 'A did not pass through her');
    assert.ok(run.minGapCm >= 0, `never overlapping (closest gap ${run.minGapCm.toFixed(1)} cm)`);
    assert.ok(run.minGapCm < 12, `she stopped where they touch, not far short (gap ${run.minGapCm.toFixed(1)} cm)`);
    assert.ok(run.held > 0, 'her goal was held short of B');
    assert.ok(run.maxSurpriseCm < 1.0, `smooth stop: largest unexpected step ${run.maxSurpriseCm.toFixed(3)} cm`);
  });
}
