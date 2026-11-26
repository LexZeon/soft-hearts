// 2026-11-23: a small press on her during a hug's hold, on the public Gene in
// the real frame loop (tests/helpers/unbound-arrival.ts), 60 and 30 fps: her body gives toward it through the pull's own body layer, bounded; the
// hug goes on to its own end; her ear stays in the window (I-203: her face is turned outward) and nothing of her comes into the camera; no jolt. ACTION_GENE_REPORT=1 prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ACTION_END_KNOBS, tugTarget } from '../shared/unbound/action-ends';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import { UNITS_PER_M } from '../src/unbound/figure';
import { boneSurprises, inWindow, max, pointSurprises, runArrival, type ArrivalFrame } from './helpers/unbound-arrival';
import { closeFraming } from './helpers/close-framing';

const REPORT = process.env.ACTION_GENE_REPORT === '1';
const W = 1536, H = 912;
const framing = (f: ArrivalFrame) => Math.max(...[f.eyes.left, f.eyes.right, f.mouth].map(p => p ? Math.max(Math.abs(inWindow(f.view, p).u), Math.abs(inWindow(f.view, p).v)) : Infinity));

async function hug(fps: number, tug: boolean) {
  let holdAt: number | null = null, grabbed = false, released = false, anchor: { x: number; y: number } | null = null, heightPx = 0, earWorst = 0;
  const run = await runArrival('Gene', fps, 'hug', {
    inspect: (frame, mesh, camera, figure) => {
      // I-203: the hug's face is turned outward and cut by the right edge (the user's picture): what must stay in the window is her ear.
      if (frame.phase === 'hold') { const ear = closeFraming(frame, figure.sense?.face ?? null, figure.sense?.root.heading ?? 0).ear; earWorst = Math.max(earWorst, ear ? Math.max(Math.abs(ear[0]), Math.abs(ear[1])) : Infinity); }
      if (!tug) return;
      if (frame.phase === 'hold' && holdAt === null) holdAt = frame.t;
      if (holdAt === null) return;
      const view = { camera, width: W, height: H };
      if (!grabbed && frame.t >= holdAt + 0.5) {
        const chest = mesh.skeleton.bones.find(b => b.name === '上半身2')!.getWorldPosition(new Vector3()).project(camera);
        anchor = { x: (chest.x + 1) / 2 * W, y: (1 - chest.y) / 2 * H };
        const hit = figure.pullHit(view, anchor.x, anchor.y);
        assert.ok(hit, 'a press on her chest lands on her');
        figure.setPullStance(null); assert.ok(figure.pullStart(hit!, view)); grabbed = true; heightPx = hit!.heightPx;
      }
      if (grabbed && !released && anchor) {
        const k = Math.min(1, (frame.t - holdAt - 0.5) / 0.4); // a small drag sideways and down over 0.4 s, held inside the tug's size
        const at = tugTarget(anchor, { x: anchor.x + 50 * k, y: anchor.y + 25 * k }, heightPx); // as the page hands it (src/unbound/pull-input.ts)
        figure.pullTo(view, at.x, at.y);
        if (frame.t >= holdAt + 1.6) { figure.pullEnd(); released = true; }
      }
    },
  });
  const hold = run.frames.filter(f => f.phase === 'hold'), near = run.frames.filter(f => f.nearest);
  return {
    holdS: run.holdS, plannedHoldS: (run.plan as { holdS: number }).holdS, holdFrame: max(hold.map(framing)), earWorst,
    nearestView: Math.min(...near.map(f => f.nearest!.view)), viewMargin: Math.min(...near.map(f => f.nearest!.view - f.nearM)),
    headCm: max(pointSurprises(run.frames.map(f => f.head))), upperDeg: max(boneSurprises(run.frames, run.boneNames.flatMap((n, i) => /足|ひざ/.test(n) ? [] : [i]))), // her legs are the gait's (the walk home)
    phases: [...new Set(run.frames.map(f => f.phase).filter(Boolean))], heads: hold.map(f => f.head), turns: hold.map(f => f.rotations), names: run.boneNames, grabbed, released,
  };
}

for (const fps of [60, 30]) {
  test(`Gene ${fps} fps: a small press on her during the hug sways her a little and the hug goes on to its own end (eyes and mouth in, out of the camera, no jolt)`, async () => {
    const [plain, tugged] = [await hug(fps, false), await hug(fps, true)], k = 60 / fps;
    assert.ok(tugged.grabbed && tugged.released, 'pressed, pulled a little, let go');
    assert.deepEqual(tugged.phases, plain.phases, 'every beat as without it: nothing ended');
    assert.ok(Math.abs(tugged.holdS - plain.holdS) < 0.05, `her own hold (${tugged.holdS} s vs ${plain.holdS} s)`);
    const gave = max(tugged.heads.map((h, i) => h && plain.heads[i] ? Math.hypot(h.x - plain.heads[i]!.x, h.y - plain.heads[i]!.y, h.z - plain.heads[i]!.z) * 100 : 0));
    // Her body's give: the largest turn of any tracked bone of her upper body against the same hug without the press (deg).
    const upper = tugged.names.flatMap((n, b) => /足|ひざ/.test(n) ? [] : [b]);
    const bodyDeg = max(tugged.turns.map((rs, i) => plain.turns[i] ? max(upper.map(b => rs[b].angleTo(plain.turns[i][b]) * 180 / Math.PI)) : 0));
    if (REPORT) console.log(`[action-ends gene ${fps}] body ${bodyDeg.toFixed(2)}°, head ${gave.toFixed(2)} cm`);
    assert.ok(bodyDeg > 1, `the physics: her body gave toward the tug (${bodyDeg.toFixed(2)}°)`);
    assert.ok(bodyDeg < 25 && gave < 3, `bounded (${bodyDeg.toFixed(2)}°, her head ${gave.toFixed(2)} cm: the arrival keeps her face where it is)`);
    assert.ok(tugged.earWorst <= 1, `her ear stays in the window (${tugged.earWorst}; I-203: her face is turned outward, cut by the right edge)`);
    assert.ok(tugged.viewMargin > 0.005 && tugged.nearestView > ARRIVAL_KNOBS.minClearM - 0.01, `out of the camera (${tugged.nearestView} m)`);
    assert.ok(tugged.headCm < 0.4 * k * k && tugged.upperDeg < 1.5 * k * k, `no jolt (head ${tugged.headCm} cm, upper ${tugged.upperDeg}°)`);
    if (REPORT) console.log(`[action-ends gene ${fps}]`, JSON.stringify({ largePullPx: ACTION_END_KNOBS.largePullPx, bodyDeg, headCm: gave, plain: { ...plain, heads: undefined, turns: undefined, names: undefined }, tugged: { ...tugged, heads: undefined, turns: undefined, names: undefined } }));
    void UNITS_PER_M;
  });
}
