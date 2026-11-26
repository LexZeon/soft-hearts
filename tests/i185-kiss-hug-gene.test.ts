// I-185 on the bundled public Gene, the real frame loops, at 60 and 30 fps (docs/claude/2026-11-22-i185-words-kiss-hug.md):
//  - the window (WindowBody: Unbound's figure, the bundled idle, her face WindowFace): ⟦kiss⟧ in place while she is still speaking (eyes
//    close, a small lean, the pucker only after she stops), then ⟦hug⟧ (arms forward and wrapped, a small lean). Her body's unexpected step
//    (R29c) stays at the idle's own level, compared with the same run without the words; she never walks;
//  - full-screen (the Unbound figure through UnboundSpeechBeats): the lighter hug the page plays when the host says 'lighter' (lean in, arms
//    open a little), compared with her standing; she never walks.
// The full walk-up kiss and hug in full-screen are the I-184 performance itself (tests/unbound-close-moment-gene.test.ts measures it).
// I185_REPORT=1 prints the numbers in the record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { WindowBody } from '../src/unbound/window-mode/window-body';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { UnboundSpeechBeats } from '../src/unbound/speech-beat-player';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { REST_TARGETS, type PoseTargets } from '../src/unbound/motion/generator';
import type { UnboundBubble } from '../shared/unbound/scene';
import { geneFigure, TRACKED, max, surpriseAngles } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { faceView } from './helpers/window-face-fixture';
import { laptopLens } from './helpers/unbound-peek';

const REPORT = process.env.I185_REPORT === '1';
// I-192: each holds as long as she decides now (a few seconds), so the hug comes later and the runs are longer.
const KISS_AT = 1, SPEAK_UNTIL = 2.2, HUG_AT = 14, SECONDS = 26; // the kiss is over (rest) before the hug: one in-place moment at a time

async function windowRun(fps: number, withWords: boolean) {
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 0 });
  const idle = await shippedIdle();
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const body = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random);
  await new Promise(resolve => setImmediate(resolve));
  const mesh = fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  const rig = windowFaceRig(mesh, profile, true, figure.head);
  const face = new WindowFace(); face.beats.closeMoments = true; // 2026-11-24: the window's kiss / hug are behind a knob (off); this is the in-place motion itself
  face.attach(rig);
  body.bindFace(slotBindings(rig, face.blushMorph()));
  const watched = { u: rig.slots.u ?? -1, blink: rig.slots.blink ?? -1 };
  const bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: { t: number; rotations: Quaternion[]; u: number; blink: number; root: number; handsUp: number }[] = [];
  const played: boolean[] = [];
  try {
    for (let frame = 0; frame <= Math.round(fps * SECONDS); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      face.setMood(faceView({ primary: 'calm', companion: null, token: 'beats' }));
      if (withWords && frame === Math.round(fps * KISS_AT)) played.push(face.speechBeat('kiss'));
      if (withWords && frame === Math.round(fps * HUG_AT)) played.push(face.speechBeat('hug'));
      const speaking = t < SPEAK_UNTIL;
      const shown = face.frame(dt, { shown: true, adjusting: false, voiced: false, speaking });
      body.frame(dt, { pointer: { x: 0, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: false, face: shown });
      const influences = mesh.morphTargetInfluences!;
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), u: watched.u >= 0 ? influences[watched.u] ?? 0 : 0,
        blink: watched.blink >= 0 ? influences[watched.blink] ?? 0 : 0, root: Math.hypot(figure.placement.xM, figure.placement.depthM), handsUp: figure.handsUp });
    }
  } finally { body.dispose(); fixture.close(); }
  return { frames, played };
}

const HOME = { x: 0, z: -0.85 };
async function fullRun(fps: number, withHug: boolean) {
  const { fixture, figure } = await geneFigure({ xM: HOME.x, depthM: -HOME.z });
  figure.setGaitLook(false);
  figure.faceToward({ x: 0, z: 0.55 });
  const lens = laptopLens(), player = new UnboundSpeechBeats(new ProceduralGenerator(), () => {}, () => 'lighter');
  const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(bone => bone.name === name)!);
  const frames: { t: number; rotations: Quaternion[]; root: { x: number; z: number }; handsUp: number }[] = [];
  try {
    for (let frame = 0; frame <= fps * 18; frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      if (withHug && frame === fps * 2) {
        player.receive({ id: 'r1', type: 'beats', speechBeats: { beats: [{ word: 'hug', at: 0 }] } } as unknown as UnboundBubble);
        player.receive({ id: 'r1', type: 'delta', text: '来，抱一下。', rev: 1 } as UnboundBubble);
      }
      if (withHug && frame === fps * 3) player.receive({ id: 'r1', type: 'done' } as unknown as UnboundBubble); // I-192: she has said it (the hug holds while she speaks)
      const body = { get sense() { return figure.sense; }, setPoseTargets: (value: PoseTargets) => figure.setPoseTargets(value) };
      if (!player.frame(dt, lens, HOME, body, true, { shown: true, asleep: false, armsHeld: false }) && !player.active && t < 0.05) figure.setPoseTargets({ ...REST_TARGETS });
      figure.frame(dt);
      const p = figure.placement;
      frames.push({ t, rotations: bones.map(bone => bone.getWorldQuaternion(new Quaternion())), root: { x: p.xM, z: p.depthM }, handsUp: figure.handsUp });
    }
    return { frames, played: [...player.played] };
  } finally { figure.dispose(); fixture.close(); }
}

const steps = (values: number[]) => values.slice(1).map((v, i) => Math.abs(v - values[i]));
const accel = (values: number[]) => values.slice(2).map((v, i) => Math.abs(v - 2 * values[i + 1] + values[i]));

for (const fps of [60, 30]) {
  test(`Gene window ${fps} fps: ⟦kiss⟧ then ⟦hug⟧ in place — eyes close, pucker only after she speaks, arms forward and back; no jolt, no walk`, async () => {
    const off = await windowRun(fps, false), on = await windowRun(fps, true);
    assert.deepEqual(on.played, [true, true]);
    assert.ok(max(on.frames.map(f => f.root)) < 1e-9, 'she never walks');
    const during = (from: number, to: number, pick: (f: typeof on.frames[number]) => number) => max(on.frames.filter(f => f.t >= from && f.t <= to).map(pick));
    const puckerSpeaking = during(0, SPEAK_UNTIL, f => f.u);
    assert.ok(puckerSpeaking < 0.02, `no pucker while she speaks (${puckerSpeaking.toFixed(3)})`);
    assert.ok(during(SPEAK_UNTIL, HUG_AT, f => f.u) > 0.3, `the pucker in the pause (${during(SPEAK_UNTIL, HUG_AT, f => f.u).toFixed(3)})`);
    assert.ok(during(KISS_AT, HUG_AT, f => f.blink) > 0.6, 'her eyes close for the kiss');
    const handsHug = during(HUG_AT, SECONDS, f => f.handsUp);
    assert.ok(handsHug > 0.6, `the hug brings her arms (${handsHug.toFixed(3)})`);
    assert.ok(during(KISS_AT, HUG_AT, f => f.handsUp) < 0.02, 'the kiss does not');
    assert.ok(on.frames.at(-1)!.handsUp < 0.05, 'and lets them go again');
    const k = 60 / fps;
    const surpriseOn = max(surpriseAngles(on.frames as never, Math.round(fps * 0.5))), surpriseOff = max(surpriseAngles(off.frames as never, Math.round(fps * 0.5)));
    const morph = { uStep: max(steps(on.frames.map(f => f.u))), uAccel: max(accel(on.frames.map(f => f.u))), handsStep: max(steps(on.frames.map(f => f.handsUp))) };
    const line = `[I-185 Gene window ${fps} fps] unexpected step ${surpriseOff.toFixed(3)}° → ${surpriseOn.toFixed(3)}° · pucker step ${morph.uStep.toFixed(4)} accel ${morph.uAccel.toFixed(4)} · arms step ${morph.handsStep.toFixed(4)}`;
    if (REPORT) console.log(line);
    // The window face test's bar (tests/unbound-window-face-gene.test.ts): the idle's own level, or 0.5° (60) / 1.0° (30).
    assert.ok(surpriseOn < Math.max(fps === 60 ? 0.5 : 1.0, surpriseOff * 1.5), line);
    assert.ok(morph.uAccel < 0.015 * k * k, line);
  });

  test(`Gene full-screen ${fps} fps: the lighter ⟦hug⟧ (host said lighter) — a lean and arms open a little, where she stands; no jolt`, async () => {
    const control = await fullRun(fps, false), hug = await fullRun(fps, true);
    assert.deepEqual(hug.played, ['hug', 'hug:lighter']);
    const from = Math.round(fps * 1.5);
    const before = max(surpriseAngles(control.frames.slice(from) as never)), after = max(surpriseAngles(hug.frames.slice(from) as never));
    const arms = max(hug.frames.map(f => f.handsUp)), walked = max(hug.frames.map(f => Math.hypot(f.root.x - hug.frames[0].root.x, f.root.z - hug.frames[0].root.z)));
    const line = `[I-185 Gene full-screen lighter hug ${fps} fps] unexpected step ${before.toFixed(3)}° → ${after.toFixed(3)}° · arms ${arms.toFixed(3)} · moved ${(walked * 100).toFixed(2)} cm`;
    if (REPORT) console.log(line);
    assert.ok(arms > 0.1 && arms < 0.5, `her arms open a little (${arms})`);
    assert.ok(walked < 0.01, 'she does not walk');
    assert.ok(hug.frames.at(-1)!.handsUp < 0.05, 'and lets them go');
    // The showcase's bar for a choreographed move on Gene (tests/speech-beats-unbound.test.ts).
    assert.ok(after <= Math.max(before * 1.25, fps === 60 ? 1.2 : 2.4), line);
  });
}
