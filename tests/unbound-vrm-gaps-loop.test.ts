/**
 * I-164 VRM gaps (docs/claude/2026-11-20-vrm-gaps.md) on the real window frame loop (window-body.ts with the shipped idle, the face, her
 * own motions; the same code the window stage runs) at 60 and 30 fps, on the synthetic full-face VRM (nothing from a real model):
 *  - her face actions (wink, cheek puff, pout, tongue out) play on the VRM's own shapes, eased in and out, reported "played" (before: "failed");
 *  - a cheek pinch: the VRM's head follows the drag and comes back, every frame at the idle's level;
 *  - her eyes on a VRM whose iris fills its socket turn no further than the lid room allows, the smaller of it and the range map.
 * VRM_GAPS_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion, Vector3, type SkinnedMesh } from 'three';
import type { BodyMotionPlan } from '../shared/actions';
import { HER_ACTION_CUE_MS, HER_ACTION_PACK, HER_ACTION_SPECS, type HerActionCue, type HerActionId, type HerActionOutcome } from '../shared/actions/her-actions';
import { WindowMotions, type WindowMotionEnv } from '../src/unbound/window-mode/window-motions';
import type { WindowStageHost } from '../src/unbound/window-mode/host-ports';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { NO_MOTION_BLOCKS, slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { standardFaceOf } from '../src/unbound/model/standard-face';
import { EMPTY_CONTACT, type MoodContact } from '../src/mood/mood-feedback';
import { faceView } from './helpers/window-face-fixture';
import { frameSteps, surprises } from './helpers/unbound-window';
import { max } from './helpers/unbound-gene';
import { settledVmdBytes } from './helpers/settled-vmd';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { windowVrm } from './helpers/unbound-vrm';
import { catalogMotionFile } from './helpers/frame-stats';

const REPORT = process.env.VRM_GAPS_REPORT === '1';
const DEG = 180 / Math.PI;
const say = (line: string) => { if (REPORT) console.log(line); else console.log(line.slice(0, 300)); };

const env = (): WindowMotionEnv => ({ shown: true, typing: false, behaviorBlocked: false, inputBlocked: false, adjusting: false, pat: false, feeding: false,
  hover: false, pinch: false, pulled: false, asleep: false, rps: false, give: false, hands: false, speaking: false, preparing: false, thinking: false,
  view: faceView(), blocks: NO_MOTION_BLOCKS, showing: false, reacting: false, lidsHeld: 0, blink: 0, mouthOff: false, eyesOff: false });
const host = (over: Partial<WindowStageHost>): WindowStageHost => ({ isBehaviorModelSupported: async () => false,
  resolveChatGesture: async () => { throw Error('none'); }, resolveHerAction: async () => { throw Error('none'); }, reportHerAction: async () => {},
  getBehaviorBodyPlan: async () => ({ mode: 'closed', reason: 'normal-pool-closed', cue: null }) as BodyMotionPlan,
  resolveBehaviorBody: async () => { throw Error('none'); }, resolveBehaviorMotion: async () => { throw Error('none'); },
  resolveHerLifeMotion: async () => { throw Error('none'); }, ...over });

/** The VRM face skin primitive's value of one of its own targets. */
const target = (mesh: SkinnedMesh, name: string) => mesh.morphTargetInfluences![mesh.morphTargetDictionary![name]];
const WATCH: Record<'wink' | 'cheek-puff' | 'pout' | 'tongue-out', string> = { wink: 'Fcl_EYE_Close_L', 'cheek-puff': 'Fcl_MTH_Puff', pout: 'Fcl_MTH_U', 'tongue-out': 'tongueOut' };

async function faceActionRun(fps: number, action: keyof typeof WATCH, standardFace = true) {
  const bytes = settledVmdBytes(url => catalogMotionFile(HER_ACTION_PACK, /\/([a-z-]+)\.vmd$/.exec(url)![1]), { delayMs: 5 });
  const w = await windowVrm(syntheticVrm({ face: 'full' }));
  const rig = windowFaceRig(w.standard.mesh, null, false, w.figure.head, w.standard);
  const face = new WindowFace(); face.attach(rig); w.body.bindFace(slotBindings(rig, face.blushMorph()));
  let clock = 1_000_000;
  const now = () => clock, outcomes: HerActionOutcome[] = [], cues = new Map<string, HerActionCue>(), e = env();
  const motions = new WindowMotions(host({
    resolveHerAction: async cueId => { const cue = cues.get(cueId)!; return { cueId, action: cue.action, packId: HER_ACTION_PACK, motionId: cue.action, sha256: HER_ACTION_SPECS[cue.action].sha256,
      durationMs: HER_ACTION_SPECS[cue.action].durationFrames / 30 * 1000, url: `mmd-asset://${'d'.repeat(32)}/${cue.action}.vmd` }; },
    reportHerAction: async outcome => { outcomes.push(outcome); } }), () => e, now);
  motions.attach({ figure: w.figure, mesh: w.standard.mesh, reviewed: false, retarget: null, transform: w.standard.transform, profile: null, standard: true,
    standardFace: standardFace ? standardFaceOf(w.standard) : null });
  motions.setMood(e.view);
  const skin = w.standard.model.meshes.find(m => m.morphTargetDictionary?.[WATCH[action]] !== undefined && /SKIN/.test((Array.isArray(m.material) ? m.material[0] : m.material).name))!;
  const values: number[] = [], frames: Quaternion[][] = [];
  try {
    for (let i = 0; i <= Math.round(fps * 5); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      clock += dt * 1000;
      if (i === Math.round(fps)) { const cue: HerActionCue = { id: `vrm-${action}`, action: action as HerActionId, at: now(), expiresAt: now() + HER_ACTION_CUE_MS }; cues.set(cue.id, cue); void motions.playHerAction(cue); }
      face.setMood(e.view);
      motions.frame();
      const goals = face.frame(dt, { shown: true, adjusting: false, voiced: false, speaking: false, heightM: w.figure.heightM });
      w.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: false, pat: false, face: goals });
      motions.afterBody(dt);
      values.push(target(skin, WATCH[action])); frames.push(w.rotations());
      void t;
      await bytes.settle();
    }
  } finally { bytes.restore(); motions.dispose(); w.close(); }
  const deltas = values.slice(1).map((v, k) => Math.abs(v - values[k]));
  return { values, outcomes, peak: max(values), change: max(deltas), frames };
}

for (const fps of [60, 30]) {
  test(`VRM, ${fps} fps: her face actions play on the VRM's own shapes, eased in and out, and she reports them played`, async () => {
    const rows: string[] = [];
    for (const action of Object.keys(WATCH) as (keyof typeof WATCH)[]) {
      const run = await faceActionRun(fps, action);
      assert.deepEqual(run.outcomes.map(o => o.status), ['played'], `${action}: ${JSON.stringify(run.outcomes)}`);
      assert.ok(run.peak > 0.3, `${action}: the VRM's ${WATCH[action]} shows (peak ${run.peak.toFixed(3)})`);
      assert.ok(run.values.at(-1)! < 0.02, `${action}: and goes back (${run.values.at(-1)!.toFixed(3)})`);
      assert.ok(run.values[Math.round(fps) - 1] < 1e-6, `${action}: nothing before it`);
      // Eased: no frame jumps more than the clip's own ramp allows at this rate.
      assert.ok(run.change < (fps === 60 ? 0.35 : 0.6), `${action}: per-frame change ${run.change.toFixed(3)}`);
      rows.push(`${action} peak ${run.peak.toFixed(2)} Δ/frame ${run.change.toFixed(3)} body step ${max(frameSteps(run.frames)).toFixed(3)}° surprise ${max(surprises(run.frames).perFrame).toFixed(3)}°`);
    }
    // Before (a VRM without its face view, as until now): every face action reported failed, nothing moved.
    const before = await faceActionRun(fps, 'wink', false);
    assert.deepEqual(before.outcomes.map(o => o.status), ['failed']);
    assert.equal(before.peak, 0);
    say(`  VRM face actions ${fps} fps · ` + rows.join(' · ') + ' · before: failed, peak 0');
  });
}

// ---- the pinch -------------------------------------------------------------------------------------------------------------------

const BEAM = { id: 'pinch-1', kind: 'pinch', face: 'beam', at: 0, until: 1e12 };
const pinchAt = (x: number, y = 0, pinching = true): MoodContact => ({ ...EMPTY_CONTACT, pinch: { pinching, x, y, side: 'right' } } as MoodContact);

async function pinchRun(fps: number, withPinch: boolean) {
  const w = await windowVrm(syntheticVrm({ face: 'full' }));
  const rig = windowFaceRig(w.standard.mesh, null, false, w.figure.head, w.standard);
  const face = new WindowFace(); face.attach(rig); w.body.bindFace(slotBindings(rig, face.blushMorph()));
  const view = faceView({ primary: 'happy' }); (view as { touchFace?: unknown }).touchFace = BEAM;
  face.setMood(view);
  const head = w.standard.head!, frames: Quaternion[][] = [], heads: number[] = [], roots: number[] = [];
  const screenX = () => { w.standard.mesh.updateMatrixWorld(true); const p = head.getWorldPosition(new Vector3()).project(w.camera); return (p.x + 1) / 2 * w.window.width; };
  try {
    for (let i = 0; i <= Math.round(fps * 8); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0, drag = Math.min(1, Math.max(0, t - 2.2));
      face.setContact(withPinch && t >= 2 && t < 5 ? pinchAt(1.2 * drag, 0.4 * drag) : EMPTY_CONTACT);
      const goals = face.frame(dt, { shown: true, adjusting: false, voiced: false, speaking: false, heightM: w.figure.heightM });
      w.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: goals });
      frames.push(w.rotations()); heads.push(screenX()); roots.push(Math.hypot(w.figure.placement.xM, w.figure.placement.depthM));
    }
  } finally { w.close(); }
  return { frames, heads, roots, span: (from: number, to: number) => frames.slice(Math.round(from * fps), Math.round(to * fps) + 1) };
}

for (const fps of [60, 30]) {
  test(`VRM, ${fps} fps: a cheek pinch moves the VRM's own head toward your drag and back, every frame at the idle's level; she never walks`, async () => {
    const off = await pinchRun(fps, false), on = await pinchRun(fps, true), at = (t: number) => Math.round(t * fps);
    const moved = on.heads[at(4.8)] - off.heads[at(4.8)];
    assert.ok(moved > 2, `her head moved toward your right (${moved.toFixed(1)} px)`);
    const sway = max(off.heads.slice(at(5))) - Math.min(...off.heads.slice(at(5))), back = on.heads[at(7.9)] - off.heads[at(7.9)];
    // Her learned idle stepped aside during the pinch and comes back on its own phase, so the two runs differ by about its sway.
    assert.ok(Math.abs(back) < Math.max(2, sway) * 1.5, `and came back (${back.toFixed(1)} px; her idle's own sway ${sway.toFixed(1)} px; moved ${moved.toFixed(1)} px)`);
    assert.ok(max(on.roots) < 1e-9, 'she never walks');
    const idle = max(surprises(off.span(0.5, 8)).perFrame), limit = fps === 60 ? 0.5 : 1.0;
    const rows = ([['press', 1.9, 2.6], ['drag', 2.2, 3.4], ['hold', 3.4, 5], ['release', 5, 7]] as const).map(([name, from, to]) => ({ name,
      offStep: max(frameSteps(off.span(from, to))), onStep: max(frameSteps(on.span(from, to))), offSurprise: max(surprises(off.span(from, to)).perFrame), onSurprise: max(surprises(on.span(from, to)).perFrame) }));
    for (const r of rows) assert.ok(r.onSurprise < Math.max(limit, idle * 1.5), `${r.name}: unexpected step ${r.onSurprise.toFixed(3)}°`);
    say(`  VRM pinch ${fps} fps · ` + rows.map(r => `${r.name} step ${r.offStep.toFixed(3)}→${r.onStep.toFixed(3)}° surprise ${r.offSurprise.toFixed(3)}→${r.onSurprise.toFixed(3)}°`).join(' · ') + ` · head moved ${moved.toFixed(1)} px`);
  });
}

// ---- the eyes --------------------------------------------------------------------------------------------------------------------

/** A range map that would let the eye bones take the whole look (input 18°, output 18°): the room has to be what holds them back. */
const GENEROUS = { type: 'bone', offsetFromHeadBone: [0, 0.06, 0], rangeMapHorizontalInner: { inputMaxValue: 18, outputScale: 18 }, rangeMapHorizontalOuter: { inputMaxValue: 18, outputScale: 18 },
  rangeMapVerticalDown: { inputMaxValue: 20, outputScale: 20 }, rangeMapVerticalUp: { inputMaxValue: 14, outputScale: 14 } };
/** One's own maps (input 90°: her eye bones take a small share of the look). */
const ONE_LIKE = { type: 'bone', offsetFromHeadBone: [0, 0.06, 0], rangeMapHorizontalInner: { inputMaxValue: 90, outputScale: 8 }, rangeMapHorizontalOuter: { inputMaxValue: 90, outputScale: 12 },
  rangeMapVerticalDown: { inputMaxValue: 90, outputScale: 10 }, rangeMapVerticalUp: { inputMaxValue: 90, outputScale: 10 } };

async function eyeRun(fps: number, irisFill: boolean, lookAt: Record<string, unknown>) {
  const w = await windowVrm(syntheticVrm({ face: 'full', irisFill, lookAt }));
  const eye = w.standard.eyes[0], rest = eye.quaternion.clone(), turns: number[] = [], looks: number[] = [], frames: Quaternion[][] = [];
  try {
    for (let i = 0; i <= Math.round(fps * 8); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      // The cursor far to one side, then far up, then far down.
      const pointer = t < 2.5 ? { x: 1, y: 0 } : t < 5 ? { x: 0, y: 1 } : { x: 0, y: -1 };
      w.body.frame(dt, { pointer, eyes: { x: 0, y: 0.3 }, follow: true, pat: false });
      turns.push(eye.quaternion.angleTo(rest) * DEG); looks.push(Math.hypot(w.standard.transfer.look.yaw, w.standard.transfer.look.pitch)); frames.push([eye.quaternion.clone()]);
    }
  } finally { w.close(); }
  return { turns, looks, room: w.standard.transfer.eyeRoom, step: max(frameSteps(frames)) };
}

for (const fps of [60, 30]) {
  test(`VRM, ${fps} fps: an iris that fills its socket turns only as far as the lid leaves room (the smaller of that and the range map), eased`, async () => {
    const roomy = await eyeRun(fps, false, GENEROUS), filled = await eyeRun(fps, true, GENEROUS), one = await eyeRun(fps, true, ONE_LIKE);
    assert.equal(roomy.room, 1);
    assert.ok(filled.room < 0.6, `room ${filled.room.toFixed(3)}`);
    const most = (r: typeof roomy) => max(r.turns);
    assert.ok(most(filled) < most(roomy) * (filled.room + 0.05), `filled ${most(filled).toFixed(2)}° vs roomy ${most(roomy).toFixed(2)}°`);
    // Every frame the eye bone turns no more than the room's share of the look, and with One's maps no more than the map.
    for (let k = 0; k < filled.turns.length; k++) assert.ok(filled.turns[k] <= filled.looks[k] * filled.room + 0.2, `frame ${k}: ${filled.turns[k].toFixed(2)}° for a ${filled.looks[k].toFixed(2)}° look`);
    assert.ok(most(one) <= 12 * max(one.looks) / 90 + 0.2, `One's maps: ${most(one).toFixed(2)}° (the map is the smaller there)`);
    assert.ok(filled.step < (fps === 60 ? 1 : 2), `eased: eye step ${filled.step.toFixed(3)}°/frame`);
    say(`  VRM eyes ${fps} fps · room ${filled.room.toFixed(3)} · largest eye turn roomy ${most(roomy).toFixed(2)}° → filled ${most(filled).toFixed(2)}° · One-like maps ${most(one).toFixed(2)}° · eye step roomy ${roomy.step.toFixed(3)}° filled ${filled.step.toFixed(3)}°`);
    void Euler;
  });
}
