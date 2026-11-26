/**
 * I-175 step 4 (docs/claude/2026-11-22-i175-part-mixer.md): the eyelids' one ceiling and the head's one order on the Unbound engine (the
 * companion window and full-screen share the figure's intent layer, the face goals and the idle layer).
 *  - Pure: lidsUnderCeiling never lets the blink plus a lid shape pass shut; at a full blink the eye shuts; continuous. headHeld / idleHeadScale.
 *  - The real Gene window loop at 60 and 30 fps: a laugh and closed eyes asked together (smile eyes + blink): what her writers ask vs what
 *    shows (before I-175 the window wrote what they asked); the lid morphs ease. A beat's tilt: her own idle head sway yields while the tilt
 *    holds her head (measured against the same run without the hold), and her body's unexpected step (R29c) stays at the idle's level.
 * I175_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { HEAD_ORDER, headHeld, idleHeadScale, lidsUnderCeiling } from '../shared/behaviors/part-mix/lids-head';
import { PART_MIX_KNOBS } from '../shared/behaviors/part-mix/knobs';
import { EyelidCompositor } from '../src/stage/channel-compositors';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { layFace } from '../src/unbound/her/face-goals';
import { REST_TARGETS, type PoseTargets } from '../src/unbound/motion/generator';
import { windowGene, surprises, DEG } from './helpers/unbound-window';
import { faceView } from './helpers/window-face-fixture';

const REPORT = process.env.I175_REPORT === '1';

test('the lid ceiling: blink + the larger lid shape never pass shut on a model where they overlap; the shapes stay as asked; continuous; the old stage\'s rule holds the same bound', () => {
  let last = lidsUnderCeiling(0, 1, 0);
  for (let a = 0; a <= 40; a++) for (let b = 0; b <= 40; b++) {
    const c = a / 40, s = b / 40, out = lidsUnderCeiling(c, s, s / 2);
    assert.ok(out.blink + Math.max(out.smileEyes, out.jitome) <= PART_MIX_KNOBS.lidCeiling + 1e-12, `${c} ${s}`);
    assert.equal(out.smileEyes, s, 'the smile eyes are never moved (they stay eased: no dip for a crisp blink)');
    if (b > 0) assert.ok(Math.abs(out.blink - last.blink) <= 0.05, 'continuous');
    last = out;
  }
  assert.deepEqual(lidsUnderCeiling(1, 0.6, 0), { blink: 0.4, smileEyes: 0.6, jitome: 0 }, 'a full blink with smile eyes: together exactly shut');
  assert.deepEqual(lidsUnderCeiling(1, 0, 0), { blink: 1, smileEyes: 0, jitome: 0 }, 'a full blink alone shuts the eye');
  assert.deepEqual(lidsUnderCeiling(1, 0.6, 0, PART_MIX_KNOBS, undefined, false), { blink: 1, smileEyes: 0.6, jitome: 0 }, 'shapes that do not share the lid: nothing capped (no gap)');
  const narrower = lidsUnderCeiling(1, 0.5, 0, { ...PART_MIX_KNOBS, lidCeiling: 0.9 });
  assert.ok(Math.abs(narrower.blink + narrower.smileEyes - 0.9) < 1e-12, 'the knob is the ceiling');
  // The old stage's compositor keeps the same bound on its blink (its shapes yield only to the natural blink; the cap is the same idea).
  const old = new EyelidCompositor().frame(1 / 60, { contact: 0, cheek: 0, fatigue: 0, naturalBlink: 0.7, smileEyes: 0.9, lidShapesOverlap: true });
  assert.ok(old.blink + old.smileEyes <= 1 + 1e-12);
});

test('who holds the head: the order, a deliberate head action holds it, the idle sway yields but never to 0, talk-calm still applies', () => {
  assert.deepEqual([...HEAD_ORDER], ['gaze', 'nod', 'beatTilt', 'talkCalm', 'idleSway']);
  assert.equal(headHeld({ pitch: 0, yaw: 0, roll: 0 }), 0);
  assert.equal(headHeld({ pitch: 0, yaw: 0, roll: 0.2 }), 1, 'a beat\'s tilt holds the head');
  assert.ok(headHeld({ pitch: 0.04, yaw: 0, roll: 0 }) > 0 && headHeld({ pitch: 0.04, yaw: 0, roll: 0 }) < 1, 'continuous in between');
  assert.equal(idleHeadScale(1, 0), 1, 'nothing holds the head: the idle as before');
  assert.ok(Math.abs(idleHeadScale(1, 1) - PART_MIX_KNOBS.idleUnderHeld) < 1e-12, 'held: the idle keeps a little of its sway');
  assert.ok(Math.abs(idleHeadScale(0.3, 1) - 0.3 * PART_MIX_KNOBS.idleUnderHeld) < 1e-12, 'talk-calm and the hold multiply');
  // The face goals carry the hold to the idle layer (both modes lay her face with layFace).
  const face = { expr: {}, exprNamed: {}, head: { pitch: 0, yaw: 0, roll: 0.17 }, torso: { pitch: 0, yaw: 0, roll: 0 }, neck: undefined, pelvis: undefined, hands: null } as never;
  assert.equal(layFace({ ...REST_TARGETS } as PoseTargets, face).headHeld, 1);
  assert.equal(layFace({ ...REST_TARGETS } as PoseTargets, { ...(face as object), head: { pitch: 0, yaw: 0, roll: 0 } } as never).headHeld, undefined, 'no hold: the targets are as before');
});

async function geneRun(fps: number, opts: { lids?: boolean; tilt?: boolean; ignoreHold?: boolean }) {
  const g = await windowGene();
  const mesh = g.fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  const rig = windowFaceRig(mesh, profile, true, g.figure.head);
  const face = new WindowFace(); face.attach(rig); face.setMood(faceView({ primary: 'calm', companion: null }));
  g.body.bindFace(slotBindings(rig, face.blushMorph()));
  if (opts.ignoreHold) { // "before": the idle layer never hears the hold
    const proxy = g.body.idle.wrap(g.figure) as { setPoseTargets(t: PoseTargets): void };
    const set = proxy.setPoseTargets;
    proxy.setPoseTargets = t => set({ ...t, headHeld: undefined });
  }
  const inf = mesh.morphTargetInfluences!, blinkIdx = rig.slots.blink!, smileIdx = rig.slots.smileEyes!;
  const intent = (g.figure as unknown as { intent: { lids: { asked: number; shown: number } } }).intent;
  const head = mesh.skeleton.bones.find(b => b.name === '頭')!;
  const rows: { t: number; asked: number; shown: number; morphs: number; blink: number; smile: number; head: Quaternion; rot: Quaternion[] }[] = [];
  let shown = false, beats = 0;
  try {
    for (let k = 0; k <= Math.round(fps * 9); k++) {
      const t = k / fps, dt = k ? 1 / fps : 0;
      if (opts.lids && t >= 1 && !shown) { shown = true; face.show('laugh', { holdS: 5, intensity: 1 }); face.show('content', { holdS: 5, intensity: 1 }); }
      if (opts.tilt) for (const at of [2, 4, 6]) if (t >= at && beats < [2, 4, 6].indexOf(at) + 1) { beats++; face.speechBeat('tilt'); }
      const f = face.frame(dt, { shown: true, adjusting: false, voiced: false, speaking: false });
      g.body.frame(dt, { pointer: { x: 0.1, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: f });
      g.fixture.mesh.updateMatrixWorld(true);
      rows.push({ t, asked: intent.lids.asked, shown: intent.lids.shown, morphs: (inf[blinkIdx] ?? 0) + (inf[smileIdx] ?? 0), blink: inf[blinkIdx] ?? 0, smile: inf[smileIdx] ?? 0,
        head: head.quaternion.clone(), rot: g.rotations() });
    }
  } finally { g.close(); }
  return rows;
}

for (const fps of [60, 30]) {
  test(`Gene window, ${fps} fps: smile eyes and closed eyes asked together never close past shut; the lids ease`, async () => {
    const rows = await geneRun(fps, { lids: true });
    const asked = Math.max(...rows.map(r => r.asked)), shownMax = Math.max(...rows.map(r => r.morphs));
    assert.ok(asked > 1.2, `her writers ask past shut (${asked.toFixed(3)}): the window wrote this before I-175`);
    assert.ok(shownMax <= PART_MIX_KNOBS.lidCeiling + 1e-6, `what shows stays at or under shut (${shownMax.toFixed(3)})`);
    const step = (key: 'blink' | 'smile' | 'shown' | 'asked') => Math.max(...rows.slice(1).map((r, i) => Math.abs(r[key] - rows[i][key])));
    const surprise = (key: 'blink' | 'smile' | 'shown' | 'asked') => Math.max(...rows.slice(2).map((r, i) => Math.abs(r[key] - 2 * rows[i + 1][key] + rows[i][key])));
    // Natural blinks are crisp on purpose (Unbound's blink shape: 70 ms closing), and the smile eyes give way to them as on the old stage;
    // how closed her eyes look (blink + smile eyes) never moves more abruptly than what her writers asked (that blink's own crispness).
    console.log(`${fps} fps lids: asked max ${asked.toFixed(3)} → shown max ${shownMax.toFixed(3)}; closure step asked ${step('asked').toFixed(3)} / shown ${step('shown').toFixed(3)}; unexpected asked ${surprise('asked').toFixed(3)} / shown ${surprise('shown').toFixed(3)}`);
    assert.ok(surprise('shown') <= surprise('asked') + 1e-6 && step('shown') <= step('asked') + 1e-6, 'the shown closure is never more abrupt than the asked one');
  });

  test(`Gene window, ${fps} fps: while a beat's tilt holds her head, her own idle sway yields; no jump`, async () => {
    const before = await geneRun(fps, { tilt: true, ignoreHold: true }), after = await geneRun(fps, { tilt: true });
    // How far her head wanders from the tilt run's own path: the two runs differ only by the idle's head sway during the holds.
    const window = (rows: typeof before) => rows.filter(r => (r.t > 2.4 && r.t < 3.4) || (r.t > 4.4 && r.t < 5.4) || (r.t > 6.4 && r.t < 7.4));
    const wander = (rows: typeof before) => { const w = window(rows); let m = 0; for (let i = 1; i < w.length; i++) m += w[i].head.angleTo(w[i - 1].head) * DEG; return m; };
    const a = wander(after), b = wander(before);
    const r29 = (rows: typeof before) => Math.max(...surprises(rows.map(r => r.rot)).perFrame);
    console.log(`${fps} fps head: idle head travel during the tilts ${b.toFixed(3)}° → ${a.toFixed(3)}°; unexpected step ${r29(before).toFixed(3)}° → ${r29(after).toFixed(3)}°`);
    assert.ok(a < b, 'her own sway moves her head less while the tilt holds it');
    assert.ok(r29(after) <= Math.max(fps === 60 ? 0.5 : 1.0, r29(before) * 1.2), 'no jump (R29c)');
    if (REPORT) console.log(JSON.stringify({ fps, a, b }));
  });
}
