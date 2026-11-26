// K14「拉她：往旁边拉她跟着挪，没有一下跳过去」as a unit test on the page's own code (docs/claude/2026-11-24-pull-regression.md): the full-screen
// pull controller (src/unbound/pull-input.ts) on Gene's real body and gait (src/unbound/figure.ts), driven exactly as the card drives the app
// (press her chest, 150 px sideways in 12 moves 70 ms apart, hold 1.5 s, let go, 2 s more), at 60 and 30 fps, with the host's answer at the
// night stance the failing pretrial read (compliance 0.775, sleepy 0.25) and a daytime one. She moves at least the card's 0.05 m and never more
// than its 0.1 m between two drawn frames. Also: a pointer that jumps far the other way mid-pull (what a second mouse did to the pretrial) turns
// her around through her gait, never a jump. `PULL_REPORT=1` prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { UnboundPull } from '../src/unbound/pull-input';
import { applyWorldCamera } from '../src/unbound/camera';
import { UNITS_PER_M } from '../src/unbound/figure';
import { clampFollowDepth, clampFollowX, parsePullAnswer } from '../shared/unbound/pull';
import { geneFigure } from './helpers/unbound-gene';
import { LAPTOP, laptopView } from './helpers/unbound-peek';

const REPORT = process.env.PULL_REPORT === '1';
/** The card's lines (scripts/pretrial/unbound-day-judge.mjs K14_LINES). */
const PULL_MIN_M = 0.05, PULL_MAX_STEP_M = 0.1;
const DIP = { w: LAPTOP.workArea.width / LAPTOP.scaleFactor, h: LAPTOP.workArea.height / LAPTOP.scaleFactor };
const NIGHT = parsePullAnswer({ accepted: true, stance: { willing: 0.5, compliance: 0.775, pace: 0.8745, hesitateMs: 0, resist: 0 }, sleepy: 0.25 });
const DAY = parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 0.85, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 });

function camera(): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M, cam = new PerspectiveCamera(30, DIP.w / DIP.h, 0.05 * U, 400 * U);
  applyWorldCamera(cam, { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical',
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: { xM: 0, depthM: 8 } } as never, 0.05);
  return cam;
}

/** One K14 pull at `fps`; `jumpTo`: at 0.6 s into the drag the pointer is suddenly this many px from the press point instead (a second mouse). */
async function k14Pull(fps: number, answer: ReturnType<typeof parsePullAnswer>, jumpTo: number | null = null) {
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 8 });
  try {
    const cam = camera(), view = { camera: cam, width: DIP.w, height: DIP.h }, world = laptopView();
    for (let i = 0; i < fps; i++) figure.frame(1 / fps);
    let clock = 0;
    const pulls = new UnboundPull({
      figure: () => figure, view: () => view, eligible: () => true, send: async m => (m.phase === 'start' ? answer : undefined),
      clampX: (x, depth) => clampFollowX(world, x, depth ?? -figure.rootM.z), clampDepth: d => clampFollowDepth(d, null), clock: () => clock,
      viewerDistanceM: () => world.viewerDistanceM,
    });
    fixture.mesh.updateMatrixWorld(true);
    const p = fixture.mesh.skeleton.bones.find(b => b.name === '上半身2')!.getWorldPosition(new Vector3()).project(cam);
    const chest = { x: (p.x + 1) / 2 * DIP.w, y: (1 - p.y) / 2 * DIP.h };
    // The card's schedule (scripts/pretrial/scenarios/unbound-day.mjs): ms from the press.
    const moves = Array.from({ length: 12 }, (_, i) => ({ at: 150 + 70 * i, x: chest.x + 150 * (i + 1) / 12 }));
    const upAt = 150 + 70 * 12 + 1_500, endAt = upAt + 2_000;
    const placements: { xM: number; depthM: number }[] = [];
    assert.ok(pulls.down(chest.x, chest.y), 'the press lands on her chest');
    let next = 0, released = false;
    for (let frame = 1; frame * 1000 / fps <= endAt; frame++) {
      clock = frame * 1000 / fps;
      while (next < moves.length && moves[next]!.at <= clock) {
        const x = jumpTo !== null && moves[next]!.at >= 600 ? chest.x + jumpTo : moves[next]!.x;
        pulls.move(x, chest.y); next++;
      }
      if (!released && clock >= upAt) { pulls.up(); released = true; }
      pulls.frame();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      figure.frame(1 / fps);
      placements.push({ ...figure.placement });
    }
    let maxStep = 0;
    for (let i = 1; i < placements.length; i++) maxStep = Math.max(maxStep, Math.hypot(placements[i]!.xM - placements[i - 1]!.xM, placements[i]!.depthM - placements[i - 1]!.depthM));
    const first = placements[0]!, last = placements.at(-1)!;
    return { movedM: Math.hypot(last.xM - first.xM, last.depthM - first.depthM), dxM: last.xM - first.xM, maxStepM: maxStep, frames: placements.length };
  } finally { figure.dispose(); fixture.close(); }
}

for (const fps of [60, 30]) {
  test(`K14 pull (${fps} fps): 150 px sideways moves her at least ${PULL_MIN_M} m that way, never more than ${PULL_MAX_STEP_M} m between two frames`, async () => {
    for (const [name, answer] of [['night', NIGHT], ['day', DAY]] as const) {
      const r = await k14Pull(fps, answer);
      if (REPORT) console.log(`K14 pull ${fps} fps ${name}: moved ${r.movedM.toFixed(3)} m (dx ${r.dxM.toFixed(3)}), max step ${r.maxStepM.toFixed(4)} m, ${r.frames} frames`);
      assert.ok(r.dxM >= PULL_MIN_M, `${name}: she follows to the right (${r.dxM} m)`);
      assert.ok(r.maxStepM <= PULL_MAX_STEP_M, `${name}: no jump (${r.maxStepM} m)`);
      // Her gait's own pace: never more than a brisk walk per frame (1.6 m/s), so "no jump" holds well inside the card's line.
      assert.ok(r.maxStepM <= 1.6 / fps, `${name}: within a walk's step per frame (${r.maxStepM} m)`);
    }
  });
  test(`K14 pull (${fps} fps): a pointer that jumps 400 px the other way mid-pull turns her through her gait, never a jump`, async () => {
    const r = await k14Pull(fps, NIGHT, -400);
    if (REPORT) console.log(`K14 pull ${fps} fps, pointer jump: moved ${r.movedM.toFixed(3)} m (dx ${r.dxM.toFixed(3)}), max step ${r.maxStepM.toFixed(4)} m`);
    assert.ok(r.maxStepM <= 1.6 / fps, `no jump (${r.maxStepM} m)`);
    assert.ok(r.dxM < 0, `she ends up following the pointer to the left (${r.dxM} m)`);
  });
}
