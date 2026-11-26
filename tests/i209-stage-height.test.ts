// I-209 three on stage, one floor.
// Three pages through the real frame loop: the public Gene three times, each her own UnboundFigure (MMDLoader, CCD IK, gait), her own page's
// stage part (src/unbound/company/stage-page.ts) and her own camera (src/unbound/floor-framing.ts through StagePage.camera, as the page does
// every frame), the real coordinator (electron/unbound/company/stage-world.ts) between them, reports and views 12 ms late like IPC.
// You pull A 1 m nearer (8 m to 7 m, her walk-along); B and C stand. At 60 and 30 fps:
//  - B's and C's feet and heads stay where they were on the screen (within 1 px);
//  - A's feet stay on the floor line (her floor follows her, as alone) and she grows smoothly: no screen jump, small "unexpected step" (R29c);
//  - before (step 3's shared eye, every window framed by the nearest one's body): B and C went up and down by tens of pixels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { StagePage } from '../src/unbound/company/stage-page';
import { StageWorld } from '../electron/unbound/company/stage-world';
import { FloorFraming } from '../src/unbound/floor-framing';
import { WorldCamera } from '../src/unbound/camera';
import { UNITS_PER_M } from '../src/unbound/figure';
import { FACE_SHARE_FALLBACK } from '../shared/unbound/framing/floor';
import { UNBOUND_BODY_DEFAULTS, type UnboundScene } from '../shared/unbound/scene';
import type { StageBody, StageView } from '../shared/unbound/company';
import { geneFigure } from './helpers/unbound-gene';
import { userWorld } from './helpers/unbound-arrival';

const IPC_MS = 12;
const IDS = ['a', 'b', 'c'] as const;
const START = { a: { xM: -0.8, depthM: 8 }, b: { xM: 0, depthM: 8 }, c: { xM: 0.8, depthM: 8 } } as const;

interface Run { othersDriftPx: number; aFeetStepPx: number; aHeadStepPx: number; aHeadSurprisePx: number; aRootStepCm: number; aRootSurpriseCm: number; aDepth: number }

/** `sharedEye`: step 3's rule, emulated (every window framed by the nearest one's body, a change of body bridged on the framing's spring). */
async function pullNearer(fps: number, sharedEye = false): Promise<Run> {
  const world = userWorld({ xM: 0, depthM: 8 }), scene = { world } as UnboundScene;
  const figs = Object.fromEntries(await Promise.all(IDS.map(async id => [id, await geneFigure(START[id])] as const)));
  let now = 0;
  const queue: { at: number; run: () => void }[] = [];
  const later = (run: () => void) => queue.push({ at: now + IPC_MS, run });
  const pages: Record<string, StagePage> = {}, framings: Record<string, FloorFraming> = {}, cams: Record<string, WorldCamera> = {};
  const coordinator = new StageWorld({ ids: () => [...IDS], send: (id, view: StageView) => later(() => pages[id]!.receive(view, now)), raise: () => {}, placement: () => null, leaving: () => false, clock: () => now });
  for (const id of IDS) {
    const figure = figs[id]!.figure;
    cams[id] = new WorldCamera(); framings[id] = new FloorFraming(cams[id]!);
    pages[id] = new StagePage({
      api: { stageBody: async (body: StageBody) => { later(() => coordinator.report(id, body)); }, stageLeft: async () => {}, onStage: () => () => {}, companyGuard: async () => {}, stageFrames: async () => {} },
      figure: () => figure, scene: () => scene, faceM: () => framings[id]!.faceHeightM, dipM: () => 0, closing: () => false,
      pulled: () => id === 'a', occupied: () => id === 'a', unitsPerM: UNITS_PER_M,
    });
  }
  coordinator.changed();
  const dt = 1 / fps, H = world.window.height;
  const screenY = (id: string, yM: number) => { const r = figs[id]!.figure.rootM, v = new Vector3(r.x * UNITS_PER_M, yM * UNITS_PER_M, r.z * UNITS_PER_M).project(cams[id]!); return (1 - v.y) / 2 * H; };
  let eyeOf = 'a';
  const settle = fps, frames = fps * 9, first: Record<string, [number, number]> = {};
  const aFeet: number[] = [], aHead: number[] = [], aRoot: Vector3[] = [];
  let drift = 0;
  for (let f = 0; f < frames; f++) {
    now += dt * 1000;
    if (f >= settle) figs.a!.figure.followTo({ x: START.a.xM, z: -(START.a.depthM - 1) }); // your hand: 1 m nearer (the pull's walk-along)
    for (const id of IDS) pages[id]!.frame(now);
    for (const id of IDS) figs[id]!.figure.frame(dt);
    if (!sharedEye) for (const id of IDS) pages[id]!.camera(dt, framings[id]!, world, figs[id]!.figure, undefined, 0);
    else {
      const nearest = IDS.reduce((best, id) => (-figs[id]!.figure.rootM.z < -figs[best]!.figure.rootM.z - 0.1 ? id : best), eyeOf); // the 0.1 m hysteresis it had
      eyeOf = nearest;
      const n = figs[nearest]!.figure;
      for (const id of IDS) if (framings[id]!.step(dt, world, -n.rootM.z, n.heightM, n.heightM * FACE_SHARE_FALLBACK, 0, nearest)) framings[id]!.apply(world);
    }
    for (const item of queue.splice(0).filter(q => { if (q.at <= now) return true; queue.push(q); return false; })) item.run();
    if (f === settle - 1) for (const id of ['b', 'c']) first[id] = [screenY(id, 0), screenY(id, figs[id]!.figure.heightM)];
    if (f >= settle) {
      for (const id of ['b', 'c']) drift = Math.max(drift, Math.abs(screenY(id, 0) - first[id]![0]), Math.abs(screenY(id, figs[id]!.figure.heightM) - first[id]![1]));
      aFeet.push(screenY('a', 0)); aHead.push(screenY('a', figs.a!.figure.heightM));
      const r = figs.a!.figure.rootM; aRoot.push(new Vector3(r.x, 0, r.z));
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  const step = (list: number[]) => list.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - list[i]!)), 0);
  const surprise = (list: number[]) => list.slice(2).reduce((m, v, i) => Math.max(m, Math.abs(v - 2 * list[i + 1]! + list[i]!)), 0);
  let rootStep = 0, rootSurprise = 0;
  for (let i = 1; i < aRoot.length; i++) rootStep = Math.max(rootStep, aRoot[i]!.distanceTo(aRoot[i - 1]!) * 100);
  for (let i = 2; i < aRoot.length; i++) rootSurprise = Math.max(rootSurprise, aRoot[i]!.clone().sub(aRoot[i - 1]!).sub(aRoot[i - 1]!.clone().sub(aRoot[i - 2]!)).length() * 100);
  const run = { othersDriftPx: drift, aFeetStepPx: step(aFeet), aHeadStepPx: step(aHead), aHeadSurprisePx: surprise(aHead), aRootStepCm: rootStep, aRootSurpriseCm: rootSurprise, aDepth: -figs.a!.figure.rootM.z };
  for (const id of IDS) { figs[id]!.figure.dispose(); figs[id]!.fixture.close(); }
  return run;
}

for (const fps of [60, 30]) {
  test(`pulling one 1 m nearer leaves the others standing where they are on the screen; she moves smoothly (${fps} fps)`, async () => {
    const before = await pullNearer(fps, true), after = await pullNearer(fps);
    const pace = UNBOUND_BODY_DEFAULTS.walkSpeedMps * 100 / fps;
    console.log(`[stage height] ${fps} fps, A pulled 8 m -> ${after.aDepth.toFixed(2)} m: the others moved up to ${before.othersDriftPx.toFixed(1)} px before (shared eye), ${after.othersDriftPx.toFixed(2)} px after; `
      + `A's feet per-frame ${after.aFeetStepPx.toFixed(2)} px, head per-frame ${after.aHeadStepPx.toFixed(2)} px (unexpected ${after.aHeadSurprisePx.toFixed(3)} px, before ${before.aHeadSurprisePx.toFixed(3)}); `
      + `root step ${after.aRootStepCm.toFixed(2)} cm (walking pace ${pace.toFixed(2)}), unexpected ${after.aRootSurpriseCm.toFixed(3)} cm`);
    assert.ok(Math.abs(after.aDepth - 7) < 0.05, `she was pulled 1 m nearer (${after.aDepth.toFixed(2)} m)`);
    assert.ok(before.othersDriftPx > 10, `before: the others went up and down (${before.othersDriftPx.toFixed(1)} px)`);
    assert.ok(after.othersDriftPx < 1, `the others' feet and heads stay put (${after.othersDriftPx.toFixed(2)} px)`);
    assert.ok(after.aFeetStepPx < 1, `her feet stay on the floor line while she comes (${after.aFeetStepPx.toFixed(2)} px per frame)`);
    assert.ok(after.aHeadStepPx < 3, `she grows smoothly, no jump (${after.aHeadStepPx.toFixed(2)} px per frame)`);
    assert.ok(after.aHeadSurprisePx < 1, `no sudden change on screen (unexpected ${after.aHeadSurprisePx.toFixed(3)} px)`);
    assert.ok(after.aRootStepCm <= pace * 1.6 && after.aRootSurpriseCm < 1, 'her root walks, never jumps');
  });
}
