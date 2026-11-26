// 2026-11-20: in Unbound a step back is hard to pull when she stands near the screen; then 2026-11-22 (I-196): too near, pulling away or closer is hard, so the move should follow the pointer's offset from where the pull began.
// Before I-196 a step back near the screen needed a drag of her own height on the window (208 px at 0.6 m); now the pointer's offset from the press point is
// the joystick, in screen pixels, so near the screen is no harder than far away. Here with Gene's real frame loop on the laptop display, near the screen:
// the pointer held a little above the press point walks her back, each frame within her walk, and letting go keeps the place.
// `PULL_BACK_REPORT=1` prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { geneFigure } from './helpers/unbound-gene';
import { LAPTOP, laptopLens, laptopView } from './helpers/unbound-peek';
import { applyWorldCamera } from '../src/unbound/camera';
import { UNITS_PER_M } from '../src/unbound/figure';
import { UnboundPull } from '../src/unbound/pull-input';
import { nearBodyOf, nearStations } from '../src/unbound/pull-near';
import { clampFollowDepth, parsePullAnswer, type UnboundPullMessage } from '../shared/unbound/pull';

const REPORT = process.env.PULL_BACK_REPORT === '1';
const answer = parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 });
const U = UNITS_PER_M;

const DIP = { w: LAPTOP.workArea.width / LAPTOP.scaleFactor, h: LAPTOP.workArea.height / LAPTOP.scaleFactor };
function laptopCamera(): PerspectiveCamera {
  const view = laptopView(), camera = new PerspectiveCamera(30, DIP.w / DIP.h, 0.05 * U, 400 * U);
  const world = { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical' as const,
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: { xM: 0, depthM: 8 } };
  applyWorldCamera(camera, world as never, 0.05);
  return camera;
}

for (const fps of [60, 30]) {
  test(`Gene (real frame loop, ${fps} fps): near the screen, the pointer held 70 px above the press walks her back, each frame within her walk, and letting go keeps the place`, async () => {
    const { fixture, figure } = await geneFigure({ xM: 0, depthM: 1.5 });
    try {
      for (let i = 0; i < 30; i++) figure.frame(1 / 60);
      figure.place({ xM: 0, depthM: 1.5 });
      for (let i = 0; i < 60; i++) figure.frame(1 / 60);
      const camera = laptopCamera(), view = { camera, width: DIP.w, height: DIP.h }, lens = laptopLens();
      const messages: UnboundPullMessage[] = [];
      let clock = 0;
      const stationsNow = () => nearStations(lens, nearBodyOf(figure)!);
      const pulls = new UnboundPull({
        figure: () => figure, view: () => view, eligible: () => true,
        send: async m => { messages.push(m); return m.phase === 'start' ? answer : undefined; },
        clampX: x => Math.min(1.5, Math.max(-1.5, x)), clampDepth: d => clampFollowDepth(d, stationsNow()?.eyeDepthM), clock: () => clock,
        near: stationsNow, viewerDistanceM: () => 0.55, nearEnd: () => {},
      });
      const chest = () => { fixture.mesh.updateMatrixWorld(true); const p = fixture.mesh.skeleton.bones.find(b => b.name === '上半身2')!.getWorldPosition(new Vector3()).project(camera); return { x: (p.x + 1) / 2 * DIP.w, y: (1 - p.y) / 2 * DIP.h }; };
      const from = chest(), startDepth = -figure.rootM.z;
      assert.ok(pulls.down(from.x, from.y), 'the press lands on her');
      const offsetPx = 70; // a short move of the hand, whatever her size on the window
      const steps: number[] = []; let prev = figure.rootM, released = false;
      const total = fps * 14;
      for (let frame = 0; frame < total; frame++) {
        clock = frame * 1000 / fps; const t = frame / fps;
        if (t < 8) { const k = Math.min(1, t / 0.5); pulls.move(from.x, from.y - k * offsetPx); }
        else if (!released) { pulls.up(); released = true; }
        pulls.frame(); await Promise.resolve(); await Promise.resolve();
        figure.frame(1 / fps);
        const root = figure.rootM; steps.push(Math.hypot(root.x - prev.x, root.z - prev.z) * 100); prev = { ...root };
      }
      const end = [...messages].reverse().find(m => m.phase === 'report') as { place?: { depthM: number } } | undefined;
      const endDepth = -figure.rootM.z, walkCap = 0.8 / fps * 100;
      if (REPORT) console.log('PULL_BACK_BODY', fps, JSON.stringify({ startDepth, endDepth, offsetPx, maxStepCm: Math.max(...steps), walkCapCm: walkCap, place: end?.place }));
      assert.ok(endDepth - startDepth >= 1, `holding ${offsetPx} px above took her back ${endDepth - startDepth} m`);
      assert.ok(endDepth <= 12.5 + 1e-6);
      assert.ok(Math.max(...steps) <= walkCap * 1.05, `a frame moved her ${Math.max(...steps)} cm (walk ${walkCap})`);
      assert.ok(end?.place && Math.abs(end.place.depthM - endDepth) < 0.02, `letting go keeps where she stands: ${JSON.stringify(end?.place)} vs ${endDepth}`);
    } finally { figure.dispose(); fixture.close(); }
  });
}
