/**
 * I-154 batch 2 on the bundled public Gene, the real window frame loop (WindowBody: Unbound's figure, the bundled idle, the mouth) with
 * her face (WindowFace, the reviewed Gene's profile slots), at 60 and 30 fps (docs/claude/2026-11-20-unbound-window-batch2.md).
 *
 * One script, 19 s: calm → happy (the mood smile), a long comfortable pat (her eyes nearly shut, her head following the hand), a reply
 * she waits for (her thinking look), she speaks with cues (accents) and an expression asked for (a warm smile) meets the speech, a blush
 * cue, then she gets drowsy. Measured per frame: every expression morph's step (the face eases: no step bigger than the bound), the
 * TRACKED bones' step and "unexpected step" (R29c) against the same run without her face (her face never makes her body jump), and
 * the mouth: lip-sync's あ is never pushed by an expression while she speaks.
 * WINDOW_FACE_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { WindowBody } from '../src/unbound/window-mode/window-body';
import { WindowFace } from '../src/unbound/window-mode/window-face';
import { slotBindings, windowFaceRig } from '../src/unbound/window-mode/window-face-rig';
import { StageModelProfile } from '../src/stage/model-profile';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { EMPTY_CONTACT } from '../src/mood/mood-feedback';
import { geneFigure, TRACKED, max } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { faceView } from './helpers/window-face-fixture';

const REPORT = process.env.WINDOW_FACE_REPORT === '1';
const DEG = 180 / Math.PI;
const BEATS: [number, string][] = [[19.3, 'smile-warm'], [20.3, 'tilt'], [21.3, 'v'], [22.6, 'look-away-left'], [23.4, 'surprise']];
const SEGMENTS: [string, number, number][] = [['idle', 0.5, 2], ['mood', 2, 3.5], ['pat', 3.5, 7.5], ['thinking', 7.5, 10], ['speaking', 10, 13.5], ['blush', 13.5, 15], ['drowsy', 15, 19], ['beats', 19, 25]];

async function run(fps: number, withFace: boolean) {
  const { fixture, figure } = await geneFigure({ xM: 0, depthM: 0 });
  const idle = await shippedIdle();
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const body = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random);
  await new Promise(resolve => setImmediate(resolve));
  const mesh = fixture.mesh, profile = new StageModelProfile(mesh, { reviewed: true });
  const rig = windowFaceRig(mesh, profile, true, figure.head);
  const face = new WindowFace();
  face.attach(rig);
  body.bindFace(slotBindings(rig, face.blushMorph()));
  const watched = { smile: rig.slots[rig.smile!]!, sad: rig.slots.sad!, jitome: rig.slots.jitome!, browUp: rig.slots.browUp ?? -1, surprise: rig.slots.surprise ?? -1,
    mouthSmile: rig.slots.mouthSmile ?? -1, blush: face.blushMorph(), blink: rig.slots.blink!, a: profile.indices.mouth };
  const bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const frames: { t: number; rotations: Quaternion[]; morphs: Record<string, number>; root: number }[] = [];
  let speaking = false, cues = 0;
  const beatsPlayed: boolean[] = [], fired = new Set<string>();
  try {
    for (let frame = 0; frame <= Math.round(fps * 25); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      // the script (what the wiring would tell the stage)
      const view = t < 2 ? faceView({ primary: 'calm', companion: null }) : t < 13.5 ? faceView({ primary: 'happy', companion: 'comfortable' })
        : t < 15 ? faceView({ primary: 'happy', companion: 'comfortable', blushCue: { id: 'blush-1', amount: 1 } })
        : t < 19 ? faceView({ primary: 'calm', companion: null, phase: 'drowsy', F: 0.8 }) : faceView({ primary: 'calm', companion: null, token: 'beats' });
      face.setMood(view);
      face.setContact(t >= 3.5 && t < 7 ? { ...EMPTY_CONTACT, contact: true, x: 0.2 * Math.sin(t * 2), y: 0.3 } : EMPTY_CONTACT);
      if (t >= 7.5 && t < 7.5 + 1 / fps) face.setThinking('reply-1');
      if (t >= 9.5 && t < 9.5 + 1 / fps) face.setThinking(null);
      const talking = t >= 10 && t < 13;
      if (talking && !speaking) {
        face.setPreparing(true);
        face.speechCue({ kind: 'levels', key: `r${cues}#0`, aheadMs: 0, stepMs: 40, levels: Array.from({ length: 75 }, (_, i) => 0.2 + 0.5 * Math.abs(Math.sin(i * 0.37))) });
        face.speechCue({ kind: 'start', key: `r${cues}#0`, text: '真的超级好看！我们去看看吧。哈哈，好开心～你说是不是？', voiced: true });
        cues++;
      }
      if (talking !== speaking) { speaking = talking; body.setSpeaking(talking); if (!talking) face.setPreparing(false); }
      if (t >= 10.8 && t < 10.8 + 1 / fps) face.show('laugh', { holdS: 1.5 });
      // 边说边演 on the window engine: a word at a time, as the wiring calls speechBeat.
      for (const [at, word] of BEATS) if (t >= at && !fired.has(word)) { fired.add(word); beatsPlayed.push(face.speechBeat(word)); }
      const shown = withFace ? face.frame(dt, { shown: true, adjusting: false, voiced: body.mouth?.voiced === true, speaking }) : null;
      body.frame(dt, { pointer: { x: Math.sin(t * 0.7) * 0.5, y: 0.1 }, eyes: { x: 0, y: 0.3 }, follow: true, pat: t >= 3.5 && t < 7, face: shown });
      const influences = mesh.morphTargetInfluences!;
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())),
        morphs: Object.fromEntries(Object.entries(watched).map(([name, index]) => [name, index >= 0 ? influences[index] ?? 0 : 0])), root: Math.hypot(figure.placement.xM, figure.placement.depthM) });
    }
  } finally { body.dispose(); fixture.close(); }
  const within = (from: number, to: number) => frames.map((f, i) => ({ f, i })).filter(({ f, i }) => i >= 2 && f.t >= from && f.t <= to);
  const step = (from: number, to: number) => within(from, to).map(({ i }) => Math.max(...frames[i].rotations.map((q, b) => q.angleTo(frames[i - 1].rotations[b]) * DEG)));
  const surprise = (from: number, to: number) => {
    const out: number[] = [], s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
    for (const { i } of within(from, to)) for (let b = 0; b < bones.length; b++) {
      s.copy(frames[i].rotations[b]).multiply(inv.copy(frames[i - 1].rotations[b]).invert());
      l.copy(frames[i - 1].rotations[b]).multiply(inv.copy(frames[i - 2].rotations[b]).invert());
      out.push(s.angleTo(l) * DEG);
    }
    return out;
  };
  const morphStep = (name: string, from: number, to: number) => within(from, to).map(({ i }) => Math.abs(frames[i].morphs[name] - frames[i - 1].morphs[name]));
  /** How much a frame's change departs from the last frame's (the morph's "unexpected step": a jump or a hitch shows here, an eased curve does not). */
  const morphSurprise = (name: string, from: number, to: number) => within(from, to).map(({ i }) => Math.abs(frames[i].morphs[name] - 2 * frames[i - 1].morphs[name] + frames[i - 2].morphs[name]));
  const morphMax = (name: string, from: number, to: number) => max(within(from, to).map(({ f }) => f.morphs[name]));
  return { frames, step, surprise, morphStep, morphSurprise, morphMax, watched, beatsPlayed };
}

for (const fps of [60, 30]) {
  test(`Gene, ${fps} fps: her face shows mood, touch, thinking, speaking, blush and drowsiness; every expression eases; her body never jumps`, async () => {
    const off = await run(fps, false), on = await run(fps, true);
    assert.ok(max(on.frames.map(f => f.root)) < 1e-9, 'she never walks');
    assert.deepEqual(on.beatsPlayed, [true, true, true, true, true], 'every beat word played');
    assert.ok(on.morphMax('smile', 19.3, 21) > 0.2, `the warm smile beat (${on.morphMax('smile', 19.3, 21).toFixed(3)})`);
    // What shows (and did not before: the window face read no mood).
    assert.ok(on.morphMax('smile', 2.5, 3.5) > 0.05 && off.morphMax('smile', 2.5, 3.5) === 0, `the mood smile ${on.morphMax('smile', 2.5, 3.5).toFixed(3)}`);
    const patLids = on.morphMax('blink', 6, 7), simpleLids = off.morphMax('blink', 6, 7);
    assert.ok(patLids > 0.6, `a long comfortable pat: lids ${patLids.toFixed(3)} (simple pat ${simpleLids.toFixed(3)})`);
    assert.ok(on.morphMax('blush', 13.5, 15) > 0.15, `the blush ${on.morphMax('blush', 13.5, 15).toFixed(3)}`);
    // Drowsy: the troubled brow and the tired lids (the half-lid shape waits until the earlier smile has fully gone, the companion's rule).
    assert.ok(on.morphMax('sad', 16, 19) > 0.02 && on.morphMax('blink', 17, 19) > 0.2, `the drowsy face: brow ${on.morphMax('sad', 16, 19).toFixed(3)}, lids ${on.morphMax('blink', 17, 19).toFixed(3)}`);
    // Every expression morph eases (blink excluded: a natural blink is crisp on purpose): its speed builds up and dies down, so a
    // frame's change never departs far from the last frame's (a quick laugh may still move fast, but along a curve).
    const names = ['smile', 'sad', 'jitome', 'browUp', 'surprise', 'mouthSmile', 'blush'];
    const morphSteps = Object.fromEntries(names.map(name => [name, max(on.morphStep(name, 0, 25))]));
    const morphSurprises = Object.fromEntries(names.map(name => [name, max(on.morphSurprise(name, 0, 25))]));
    // A cut would make a frame's unexpected step about as big as the step itself; an eased curve keeps it a small share of it.
    const bound = fps === 60 ? 0.015 : 0.05;
    for (const name of names) assert.ok(morphSurprises[name] < bound && morphSurprises[name] <= 0.4 * morphSteps[name] + 1e-6,
      `${name}: largest unexpected step ${morphSurprises[name].toFixed(4)} (bound ${bound}; largest step ${morphSteps[name].toFixed(4)})`);
    // The mouth: while she speaks, the laugh's open mouth stepped aside (lip-sync's あ is the same as without her face, within the flap's own noise).
    const mouthOn = on.frames.filter(f => f.t > 11.2 && f.t < 12.3).map(f => f.morphs.a), mouthOff = off.frames.filter(f => f.t > 11.2 && f.t < 12.3).map(f => f.morphs.a);
    const pushed = max(mouthOn.map((v, i) => v - mouthOff[i]));
    assert.ok(pushed < 0.05, `the laugh does not open her mouth over the speech (${pushed.toFixed(3)})`);
    // Her body: per segment, the unexpected step stays at the idle's own level (R29c).
    const idleSurprise = max(off.surprise(0.5, 25));
    const rows = SEGMENTS.map(([name, from, to]) => ({ name, offStep: max(off.step(from, to)), onStep: max(on.step(from, to)), offSurprise: max(off.surprise(from, to)), onSurprise: max(on.surprise(from, to)) }));
    const limit = fps === 60 ? 0.5 : 1.0;
    for (const row of rows) assert.ok(row.onSurprise < Math.max(limit, idleSurprise * 1.5), `${row.name}: unexpected step ${row.onSurprise.toFixed(3)}° (without her face ${row.offSurprise.toFixed(3)}°)`);
    const line = `  ${fps} fps · ` + rows.map(r => `${r.name} step ${r.offStep.toFixed(3)}→${r.onStep.toFixed(3)}° surprise ${r.offSurprise.toFixed(3)}→${r.onSurprise.toFixed(3)}°`).join(' · ')
      + ` · morph step / unexpected ${names.map(n => `${n} ${morphSteps[n].toFixed(4)}/${morphSurprises[n].toFixed(4)}`).join(' ')} · pat lids ${simpleLids.toFixed(2)}→${patLids.toFixed(2)} · mouth pushed ${pushed.toFixed(3)}`;
    if (REPORT) console.log(line); else console.log(line.slice(0, 400));
  });
}
