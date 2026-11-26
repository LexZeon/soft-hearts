/**
 * I-154 batch 3, rows 22 捏脸 and 23 喂食 on the window engine (docs/claude/2026-11-20-unbound-window-batch3.md): the pinch's gates and
 * direction, its cheeks on the window, the snack mouth composed with the speaking mouth, and the pinch on the real Gene frame loop at
 * 60 and 30 fps (pressed, dragged, let go: per-frame step and unexpected step against the same run without a pinch).
 * WINDOW_BATCH3_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { WindowPinch, NO_PINCH } from '../src/unbound/window-mode/window-pinch';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { pinchCheeks, WindowBlush } from '../src/unbound/window-mode/window-blush';
import { WindowView } from '../src/unbound/window-mode/window-view';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { UnboundMouth } from '../src/unbound/mouth';
import { composeMouth } from '../src/stage/channel-compositors';
import type { WindowFaceFrame } from '../src/unbound/window-mode/window-face';
import { EMPTY_CONTACT, type MoodContact } from '../src/mood/mood-feedback';
import { StageModelProfile } from '../src/stage/model-profile';
import { probeHeadContact } from '../src/stage/head-contact';
import { DEFAULT_BLUSH_CALIBRATION } from '../shared/mood';
import { faceView, syntheticRig } from './helpers/window-face-fixture';
import { DEG, frameSteps, surprises, windowGene, WINDOW } from './helpers/unbound-window';
import { max } from './helpers/unbound-gene';

const REPORT = process.env.WINDOW_BATCH3_REPORT === '1';
/** Her picked face for this pinch (I-136, MoodView.touchFace): the table's 眯眼笑. */
const BEAM = { id: 'pinch-1', kind: 'pinch', face: 'beam', at: 0, until: 1e12 };
const pinchAt = (x: number, y = 0, pinching = true): MoodContact => ({ ...EMPTY_CONTACT, pinch: { pinching, x, y, side: 'right' } } as MoodContact);
const run = (pinch: WindowPinch, seconds: number, contact: MoodContact, view = faceView(), blocks = { face: false, head: false }) => {
  let f = NO_PINCH as ReturnType<WindowPinch['frame']>;
  for (let i = 0; i < Math.round(seconds * 60); i++) f = pinch.frame(1 / 60, contact, view, 1.6, blocks);
  return f;
};

test('pinch: her head follows your fingers (right → toward your right), the body a little, the hips shift; let go eases back; no mood view, none', () => {
  const pinch = new WindowPinch();
  const held = run(pinch, 1, pinchAt(1, 0));
  assert.ok(held.active && held.head.yaw > 0.02, `turns toward your right (${held.head.yaw.toFixed(3)})`);
  assert.ok(held.neck.roll > 0.05 && held.head.roll + held.neck.roll > 0, 'the neck carries her head to your right, the net tilt follows');
  assert.ok(held.pelvis.lateral > 0 && held.torso.roll > 0, 'her body a little the same way');
  // Let go: the layer's own springs ease back (never in one frame).
  const first = pinch.frame(1 / 60, pinchAt(0, 0, false), faceView(), 1.6, { face: false, head: false });
  assert.ok(first.head.yaw > held.head.yaw * 0.8, `one frame after letting go she is still nearly there (${first.head.yaw.toFixed(3)})`);
  const later = run(pinch, 2, EMPTY_CONTACT);
  assert.equal(later.active, false, 'settled back to nothing');
  // Without a mood view she is not answered (the companion's animateCheekPinch needs one too).
  const none = new WindowPinch();
  for (let i = 0; i < 60; i++) assert.equal(none.frame(1 / 60, pinchAt(1), null, 1.6, { face: false, head: false }).active, false);
});

test('pinch: a picked expression keeps the pinch face off (the head still follows); a picked head motion keeps her head', () => {
  const view = faceView({ primary: 'happy' });
  (view as { touchFace?: unknown }).touchFace = BEAM;
  const free = run(new WindowPinch(), 1, pinchAt(1), view);
  assert.ok(free.smile > 0.1 && free.lids > 0.05, `her picked pinch face shows (${free.smile.toFixed(2)}, ${free.lids.toFixed(2)})`);
  const faceOwned = run(new WindowPinch(), 1, pinchAt(1), view, { face: true, head: false });
  assert.equal(faceOwned.smile, 0); assert.equal(faceOwned.lids, 0);
  assert.ok(faceOwned.head.yaw > 0.02, 'the head still follows');
  const headOwned = run(new WindowPinch(), 1, pinchAt(1), view, { face: false, head: true });
  assert.deepEqual([headOwned.head.yaw, headOwned.neck.roll], [0, 0]);
});

test('pinch cheeks: the measured anchors over the profile estimate; the reviewed Gene ellipse only with the default calibration', () => {
  const measured = { eyeDistance: 1 } as never, fallback = { eyeDistance: 2 } as never;
  assert.equal(pinchCheeks(measured, fallback, true, null).anchors, measured);
  assert.equal(pinchCheeks(null, fallback, true, null).anchors, fallback);
  assert.equal(pinchCheeks(measured, null, true, null).reviewed, true);
  assert.equal(pinchCheeks(measured, null, true, { ...DEFAULT_BLUSH_CALIBRATION }).reviewed, true);
  const moved = { ...DEFAULT_BLUSH_CALIBRATION, [Object.keys(DEFAULT_BLUSH_CALIBRATION)[0]]: 0.123 } as typeof DEFAULT_BLUSH_CALIBRATION;
  assert.equal(pinchCheeks(measured, null, true, moved).reviewed, false, 'a changed calibration: the plain ellipse');
  assert.equal(pinchCheeks(measured, null, false, null).reviewed, false, 'another model: the plain ellipse');
});

test('Gene in the window: both cheeks are on the head region (measured at rest), on her face', async () => {
  const g = await windowGene();
  try {
    const mesh = g.fixture.mesh, head = g.figure.head!;
    const eyes = ['左目', '右目'].map(n => mesh.skeleton.bones.find(b => b.name === n)!);
    const painter = new WindowBlush(mesh, head, eyes);
    painter.build(null, false);
    for (let i = 0; i < 30; i++) g.frame(1 / 60);
    const view = new WindowView({ clientWidth: WINDOW.width, clientHeight: WINDOW.height } as HTMLElement, {} as never, { cameraSet() {} });
    view.camera.copy(g.camera); view.bounds = { ...view.bounds, height: g.figure.heightUnits };
    const contact = probeHeadContact(mesh, head, eyes, g.figure.heightUnits);
    const region = view.interactionRegion({ head, contact, contactHead: head, cheeks: pinchCheeks(painter.cheeks, null, true, null) })!;
    assert.ok(region, 'a head region');
    assert.equal(region.cheeks.length, 2, 'both cheeks');
    const eyesAt = g.between('左目', '右目');
    for (const cheek of region.cheeks) assert.ok(cheek.y > eyesAt.y && Math.abs(cheek.x - eyesAt.x) < 40, `a cheek below her eyes, on her face (${cheek.x.toFixed(0)}, ${cheek.y.toFixed(0)})`);
    const none = view.interactionRegion({ head, contact, contactHead: head, cheeks: null })!;
    assert.equal(none.cheeks.length, 0);
    painter.dispose();
  } finally { g.close(); }
});

test('feeding: the snack mouth opens as it nears, owns the mouth, chews after the bite; the speaking mouth fades under it', () => {
  const face = new WindowFace(); face.attach(syntheticRig()); face.setMood(faceView());
  const env = { shown: true, adjusting: false, voiced: false, speaking: false };
  face.setContact({ ...EMPTY_CONTACT, feeding: true, prepared: false, near: 0.6 } as MoodContact);
  let f = face.frame(1 / 60, env);
  for (let i = 0; i < 60; i++) f = face.frame(1 / 60, env);
  assert.ok(f.mouth && f.mouth.value > 0.05 && f.mouth.owner > 0.3, `opens as the snack nears (${f.mouth?.value.toFixed(3)}, owner ${f.mouth?.owner.toFixed(2)})`);
  face.setContact({ ...EMPTY_CONTACT, feeding: true, prepared: true, near: 1 } as MoodContact);
  for (let i = 0; i < 60; i++) f = face.frame(1 / 60, env);
  const open = f.mouth!.value;
  face.setContact({ ...EMPTY_CONTACT, feeding: true, prepared: true, near: 1, accepted: true } as MoodContact);
  const chew: number[] = [];
  for (let i = 0; i < 120; i++) chew.push(face.frame(1 / 60, env).mouth?.value ?? 0);
  assert.ok(max(chew.slice(60)) < open, 'after the bite: a nearly closed "mm" mouth');
  assert.ok(max(chew.slice(60)) - Math.min(...chew.slice(60)) > 0.005, 'that chews');
  // The mouth itself: speaking alone flaps; the snack owning it fully, the flap fades under it (composeMouth).
  const influences = [0, 0], speaking = new UnboundMouth(influences, 1), fed = new UnboundMouth([0, 0], 1);
  speaking.speaking(true); fed.speaking(true);
  const s: number[] = [], m: number[] = [];
  for (let i = 0; i < 90; i++) { speaking.apply(1 / 60); fed.apply(1 / 60, lip => composeMouth(lip, 0.1, 1)); s.push(speaking.shownOpen); m.push(fed.shownOpen); speaking.restore(); fed.restore(); }
  assert.ok(max(s.slice(30)) > 0.3, 'speaking alone flaps open');
  assert.ok(max(m.slice(30)) < 0.12, `the snack owns the mouth: the flap fades under it (${max(m.slice(30)).toFixed(3)})`);
  // Not feeding: exactly the speaking mouth.
  const plain = new UnboundMouth([0, 0], 1); plain.speaking(true);
  const p: number[] = [];
  for (let i = 0; i < 90; i++) { plain.apply(1 / 60, null); p.push(plain.shownOpen); plain.restore(); }
  assert.deepEqual(p, s);
});

test('Gene in the window: while she speaks, a snack that owns her mouth takes it over through her body\'s frame (the speaking flap fades under it)', async () => {
  const g = await windowGene();
  try {
    const Z = { pitch: 0, yaw: 0, roll: 0 };
    const goals = (mouth: WindowFaceFrame['mouth']): WindowFaceFrame => ({ expr: {}, exprNamed: {}, head: Z, torso: Z, hands: null, lids: 0, softLids: 0, ownsPat: false,
      blush: 0, blushPath: 'none', blushSize: 50, gaze: { pull: 1, x: 0, y: 0, strength: 1, allowed: true, eyeYaw: 0, eyePitch: 0 }, mouth });
    g.body.setSpeaking(true);
    const shown = (mouth: WindowFaceFrame['mouth']) => { const out: number[] = []; for (let i = 0; i < 60; i++) { g.body.frame(1 / 60, { pointer: { x: 0, y: 0 }, eyes: null, follow: false, pat: false, face: goals(mouth) }); out.push(g.body.mouth!.shownOpen); } return out; };
    const talking = shown(null), fed = shown({ value: 0.1, owner: 1 });
    assert.ok(max(talking.slice(20)) > 0.3, 'speaking: the flap');
    assert.ok(max(fed.slice(20)) < 0.12, `a snack owning her mouth: the flap fades under it (${max(fed.slice(20)).toFixed(3)})`);
  } finally { g.close(); }
});

async function pinchRun(fps: number, withPinch: boolean) {
  const g = await windowGene();
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); g.body.bindFace(slotBindings(rig, face.blushMorph()));
  const view = faceView({ primary: 'happy' }); (view as { touchFace?: unknown }).touchFace = BEAM;
  face.setMood(view);
  const frames: Quaternion[][] = [], heads: number[] = [], roots: number[] = [], held: boolean[] = [];
  try {
    for (let i = 0; i <= Math.round(fps * 8); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      // Pressed at 2 s, dragged right and down over a second, held, let go at 5 s.
      const drag = Math.min(1, Math.max(0, t - 2.2));
      face.setContact(withPinch && t >= 2 && t < 5 ? pinchAt(1.2 * drag, 0.4 * drag) : EMPTY_CONTACT);
      const goals = face.frame(dt, { shown: true, adjusting: false, voiced: false, speaking: false, heightM: g.figure.heightM });
      g.body.frame(dt, { pointer: { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: goals });
      frames.push(g.rotations()); heads.push(g.screenOf('頭').x); roots.push(Math.hypot(g.figure.placement.xM, g.figure.placement.depthM)); held.push(goals.performing === true);
    }
  } finally { g.close(); }
  const span = (from: number, to: number) => frames.slice(Math.round(from * fps), Math.round(to * fps) + 1);
  return { frames, heads, roots, span, held };
}

for (const fps of [60, 30]) {
  test(`Gene, ${fps} fps: a cheek pinch and its release ease (step and unexpected step at the idle's level); her head follows the drag; she never walks`, async () => {
    const off = await pinchRun(fps, false), on = await pinchRun(fps, true);
    const at = (t: number) => Math.round(t * fps);
    assert.ok(on.heads[at(4.8)] - off.heads[at(4.8)] > 3, `her head moved toward your right (${(on.heads[at(4.8)] - off.heads[at(4.8)]).toFixed(1)} px)`);
    if (REPORT) console.log([2, 3, 4, 4.8, 5.2, 5.6, 6, 7, 7.9].map(t => `${t}:${(on.heads[at(t)] - off.heads[at(t)]).toFixed(1)}`).join(' '));
    const sway = max(off.heads.slice(at(5))) - Math.min(...off.heads.slice(at(5)));
    assert.equal(on.held[at(7.9)], false, 'the pinch has let go of her (its springs settled)');
    assert.ok(Math.abs(on.heads[at(7.9)] - off.heads[at(7.9)]) < Math.max(2, sway), `and came back after the release, within her idle's own sway (${sway.toFixed(1)} px)`);
    assert.ok(max(on.roots) < 1e-9, 'she never walks');
    const segments: [string, number, number][] = [['press', 1.9, 2.6], ['drag', 2.2, 3.4], ['hold', 3.4, 5], ['release', 5, 7]];
    const idle = max(surprises(off.span(0.5, 8)).perFrame);
    const limit = fps === 60 ? 0.5 : 1.0;
    const rows = segments.map(([name, from, to]) => ({ name, offStep: max(frameSteps(off.span(from, to))), onStep: max(frameSteps(on.span(from, to))),
      offSurprise: max(surprises(off.span(from, to)).perFrame), onSurprise: max(surprises(on.span(from, to)).perFrame) }));
    for (const row of rows) assert.ok(row.onSurprise < Math.max(limit, idle * 1.5), `${row.name}: unexpected step ${row.onSurprise.toFixed(3)}° (without the pinch ${row.offSurprise.toFixed(3)}°)`);
    const line = `  pinch ${fps} fps · ` + rows.map(r => `${r.name} step ${r.offStep.toFixed(3)}→${r.onStep.toFixed(3)}° surprise ${r.offSurprise.toFixed(3)}→${r.onSurprise.toFixed(3)}°`).join(' · ')
      + ` · head moved ${(on.heads[at(4.8)] - off.heads[at(4.8)]).toFixed(1)} px`;
    if (REPORT) console.log(line); else console.log(line.slice(0, 300));
    void DEG;
  });
}
