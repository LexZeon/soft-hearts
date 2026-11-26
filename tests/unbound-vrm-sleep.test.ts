/**
 * I-164 VRM gaps (docs/claude/2026-11-20-vrm-gaps.md): her sleep on a VRM in the companion window on Unbound's engine, on the real frame loop
 * (WindowLiveliness: the face, the sleep pose and the sleep body as the figure's overlay; the window body; the transfer onto the VRM) at 60
 * and 30 fps on the synthetic full-face VRM (nothing from a real model). The sleep body plans on the standard skeleton (its bones, capsules
 * estimated from the VRM's joints) and the pose reaches the VRM's own bones; its card's 能做睡姿 comes from its own neck and head.
 * Before: no card, so no doze and no sleep body on a VRM at all. VRM_GAPS_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Scene, Vector3 } from 'three';
import { WindowLiveliness } from '../src/unbound/window-mode/window-liveliness';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { hasNeck } from '../src/unbound/window-mode/window-model';
import { standardSleepBones } from '../src/unbound/model/standard-face';
import { loadLivelinessForEngine } from '../src/stage';
import type { FatiguePhase } from '../shared/mood/fatigue';
import { card, faceView } from './helpers/window-face-fixture';
import { frameSteps, surprises } from './helpers/unbound-window';
import { max } from './helpers/unbound-gene';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { windowVrm } from './helpers/unbound-vrm';

const REPORT = process.env.VRM_GAPS_REPORT === '1';
function seeded(seed = 5): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const phaseAt = (t: number): FatiguePhase => t < 3 ? 'awake' : t < 6 ? 'drowsy' : t < 22 ? 'falling-asleep' : t < 32 ? 'asleep' : 'awake';
const SEGMENTS: [string, number, number][] = [['awake', 0.5, 3], ['drowsy', 3, 6], ['going down', 6, 22], ['asleep', 22, 32], ['getting up', 32, 46]];

async function sleepRun(fps: number, own: boolean) {
  const w = await windowVrm(syntheticVrm({ face: 'full' }));
  const rig = windowFaceRig(w.standard.mesh, null, false, w.figure.head, w.standard);
  const face = new WindowFace(); face.attach(rig); w.body.bindFace(slotBindings(rig, face.blushMorph()));
  // `own`: the VRM's own card (能做睡姿 from its neck and head); else the same card without it (what a VRM had before: no card at all).
  if (!own) face.setCard(card(['closeEyes', 'blush', 'mouth', 'drowsyFace']));
  const lively = new WindowLiveliness(() => {}, seeded(9)), scene = new Scene();
  scene.add(w.standard.mesh);
  const lib = await loadLivelinessForEngine(); lively.life.load(lib); lively.sleep.load(lib);
  lively.sleep.attach({ mesh: w.standard.mesh, profile: standardSleepBones(w.standard), baseY: w.measure.bounds.baseY, hasNeck: hasNeck(w.standard.mesh, w.figure.head) });
  const hips = w.standard.model.bone('lowerBody')!, frames: Quaternion[][] = [], heights: number[] = [], roots: number[] = [], progress: number[] = [], props: number[] = [];
  try {
    for (let i = 0; i <= Math.round(fps * 46); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0, phase = phaseAt(t);
      const view = faceView({ primary: 'calm', companion: null, phase, F: phase === 'awake' ? 0.2 : 0.9 });
      face.setMood(view);
      lively.frame(dt, w.body, face, { view, rig, env: { shown: true, adjusting: false, voiced: false, speaking: false }, pointer: { x: 0.4, y: 0.1 }, eyes: { x: 0, y: 0.3 },
        follow: true, pat: false, breath: 0.5, pulled: false, handHeld: false, adjusting: false, thinking: false, camera: w.camera, lift: w.figure.floorUnits,
        width: w.window.width, height: w.window.height, scene });
      frames.push(w.rotations()); heights.push(hips.getWorldPosition(new Vector3()).y); roots.push(Math.hypot(w.figure.placement.xM, w.figure.placement.depthM));
      const state = lively.sleep.getState() as { progress?: number; weight?: number; props?: { pillow: number; desk: number } | null } | null;
      progress.push((state?.progress ?? 0) * (state?.weight ?? 0)); props.push(Math.max(state?.props?.pillow ?? 0, state?.props?.desk ?? 0));
    }
  } finally { w.close(); }
  const span = (from: number, to: number) => frames.slice(Math.round(from * fps), Math.round(to * fps) + 1);
  return { frames, heights, roots, progress, props, span, row: (from: number, to: number) => ({ step: max(frameSteps(span(from, to))), surprise: max(surprises(span(from, to)).perFrame) }) };
}

for (const fps of [60, 30]) {
  test(`VRM, ${fps} fps: she falls asleep, lies down on the VRM's own bones, sleeps and gets up again, every frame eased; she never walks`, async () => {
    const off = await sleepRun(fps, false), on = await sleepRun(fps, true), at = (t: number) => Math.round(t * fps);
    assert.ok(max(off.progress) === 0, 'before (no 能做睡姿): she does not lie down');
    assert.ok(on.progress[at(31)] > 1.5, `asleep: down in her sleep pose (progress ${on.progress[at(31)].toFixed(2)})`);
    assert.ok(on.progress.at(-1)! < 0.1, `awake again: up (progress ${on.progress.at(-1)!.toFixed(2)})`);
    const drop = on.heights[at(1)] - on.heights[at(31)];
    assert.ok(drop > 2, `the VRM's own hips came down ${drop.toFixed(2)} units (of ${on.heights[at(1)].toFixed(2)})`);
    assert.ok(Math.abs(on.heights.at(-1)! - on.heights[at(1)]) < 0.6, 'and back up');
    assert.ok(max(on.props) > 0.5, 'her pillow or desk showed');
    assert.ok(max(on.roots) < 1e-9, 'she never walks');
    const idle = max(surprises(off.span(0.5, 46)).perFrame), limit = fps === 60 ? 0.5 : 1.0;
    const rows = SEGMENTS.map(([name, from, to]) => ({ name, off: off.row(from, to), on: on.row(from, to) }));
    for (const r of rows) assert.ok(r.on.surprise < Math.max(limit, idle * 1.5), `${r.name}: unexpected step ${r.on.surprise.toFixed(3)}° (without the sleep layers ${r.off.surprise.toFixed(3)}°)`);
    const line = `  VRM sleep ${fps} fps · ` + rows.map(r => `${r.name} step ${r.off.step.toFixed(3)}→${r.on.step.toFixed(3)}° surprise ${r.off.surprise.toFixed(3)}→${r.on.surprise.toFixed(3)}°`).join(' · ')
      + ` · hips down ${drop.toFixed(2)} units · props ${max(on.props).toFixed(2)}`;
    if (REPORT) console.log(line); else console.log(line.slice(0, 300));
  });
}
