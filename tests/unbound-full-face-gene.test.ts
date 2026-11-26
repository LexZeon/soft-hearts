/**
 * I-154 follow-up, first slice (docs/claude/2026-11-20-unbound-full-shares.md): her face out in full-screen Unbound, on the bundled public Gene
 * in the page's own frame order (owners → her face over them → the idle layer → her frame → her mouth), at 60 and 30 fps.
 *
 * One script, 24 s, she stands out in the world (3 m behind the screen): calm → happy (the mood smile), a long comfortable pat standing, a
 * walk across with a pat while she walks (her face goes with her: the lids close, her head into the hand, her feet keep walking), a cheek
 * pinch, a snack brought to her mouth and bitten, a reply she waits for (her thinking look), then drowsy. Measured per frame against the
 * same run without her face: the TRACKED bones' step and unexpected step (R29c) per segment (her face never makes her body jump, walking
 * included), that she walks the same way, and what shows (smile, lids, mouth).
 * FULL_FACE_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion } from 'three';
import { UnboundFigure } from '../src/unbound/figure';
import { UnboundMouth } from '../src/unbound/mouth';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { REST_TARGETS, type PoseTargets } from '../src/unbound/motion/generator';
import { HerOutFace } from '../src/unbound/her/out-face';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { EMPTY_CONTACT, type MoodContact } from '../src/mood/mood-feedback';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { standClip, TRACKED, max } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { faceView } from './helpers/window-face-fixture';

const REPORT = process.env.FULL_FACE_REPORT === '1';
const DEG = 180 / Math.PI;
const HOME = { xM: 0, depthM: 3 };
const SEGMENTS: [string, number, number][] = [['idle', 0.5, 2], ['mood', 2, 4], ['pat', 4, 7.5], ['walk', 8, 9], ['walk+pat', 9, 11.5], ['back', 11.5, 13],
  ['pinch', 13, 15.5], ['feed', 15.5, 18.5], ['thinking', 18.5, 21], ['drowsy', 21, 24]];
const pinchAt = (x: number, y: number): MoodContact => ({ ...EMPTY_CONTACT, contact: true, pinch: { pinching: true, x, y, side: 'right' } } as MoodContact);

async function run(fps: number, withFace: boolean) {
  const fixture = await loadPublicGeneForTargets(), mesh = fixture.mesh;
  const measured = measureWindowModel(mesh, null, true); // as the page does: measured at rest, before her figure is made
  const figure = new UnboundFigure(mesh, HOME);
  figure.setClips({ pose: await standClip(mesh), gesture: null, expression: null }, false);
  figure.setBreath(0.5);
  figure.faceToward({ x: 0, z: 0.55 });
  const shipped = await shippedIdle();
  const idleLayer = new UnboundIdleLayer(async heightM => createBundledIdle(heightM, shipped, 11));
  idleLayer.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve));
  const mouth = UnboundMouth.forMesh(mesh);
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const her = withFace ? new HerOutFace(random) : null;
  her?.attach({ body: figure, mesh, profile: measured.profile, painter: measured.painter, reviewed: true, standard: false, url: 'gene' });
  const bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const morphIndex = (names: string[]) => names.map(name => mesh.morphTargetDictionary?.[name]).find(index => index !== undefined) ?? -1;
  const watched = { smile: morphIndex(['笑い']), blink: morphIndex(['まばたき']), a: morphIndex(['あ']) };
  const frames: { t: number; rotations: Quaternion[]; morphs: Record<string, number>; x: number; walking: boolean }[] = [];
  let lastOwner = '';
  try {
    for (let frame = 0; frame <= Math.round(fps * 24); frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0;
      // The owners (what a walk of hers would ask), then her face's inputs (what the page's touch input and mood would tell it).
      const owners = her ? her.wrap(idleLayer.wrap(figure)) : idleLayer.wrap(figure);
      const owner = t >= 8 && t < 11.5 ? 'across' : t >= 11.5 && t < 13 ? 'home' : '';
      if (owner !== lastOwner) {
        lastOwner = owner;
        const target: PoseTargets = owner === 'across' ? { ...REST_TARGETS, place: { x: 0.7, z: -HOME.depthM } } : owner === 'home' ? { ...REST_TARGETS, place: { x: HOME.xM, z: -HOME.depthM } } : { ...REST_TARGETS };
        owners.setPoseTargets(target);
      }
      const view = t < 2 ? faceView({ primary: 'calm', companion: null }) : t < 21 ? faceView({ primary: 'happy', companion: 'comfortable' })
        : faceView({ primary: 'calm', companion: null, phase: 'drowsy', F: 0.8 });
      her?.setMood(view);
      const patting = (t >= 4 && t < 7) || (t >= 9.2 && t < 11.2);
      const drag = Math.min(1, Math.max(0, (t - 13.3) / 0.8));
      const contact = patting ? { ...EMPTY_CONTACT, contact: true, hover: 1, x: 0.2 * Math.sin(t * 2), y: 0.3 } as MoodContact
        : t >= 13.3 && t < 15 ? pinchAt(1.2 * drag, 0.4 * drag)
        : t >= 15.5 && t < 16.5 ? { ...EMPTY_CONTACT, feeding: true, prepared: false, near: 0.7 } as MoodContact
        : t >= 16.5 && t < 17.3 ? { ...EMPTY_CONTACT, feeding: true, prepared: true, near: 1 } as MoodContact
        : t >= 17.3 && t < 18.2 ? { ...EMPTY_CONTACT, feeding: true, prepared: true, near: 1, accepted: true } as MoodContact : null;
      her?.setContact(contact as never);
      if (t >= 18.6 && t < 18.6 + 1 / fps) her?.setThinking('reply-1');
      if (t >= 20.4 && t < 20.4 + 1 / fps) her?.setThinking(null);
      const faced = her?.frame(dt, idleLayer.wrap(figure), { shown: true, adjusting: false, voiced: false, speaking: false, walking: figure.walking, nowMs: 1_000_000 + t * 1000 }) ?? null;
      idleLayer.frame(dt, idleWanted({ performing: faced?.performing === true, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }));
      mouth?.restore();
      figure.frame(dt);
      mouth?.apply(dt, faced?.mouth ?? null);
      const influences = mesh.morphTargetInfluences!;
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), x: figure.placement.xM, walking: figure.walking,
        morphs: Object.fromEntries(Object.entries(watched).map(([name, index]) => [name, index >= 0 ? influences[index] ?? 0 : 0])) });
    }
  } finally { her?.attach(null); figure.dispose(); fixture.close(); }
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
  const morphMax = (name: string, from: number, to: number) => max(within(from, to).map(({ f }) => f.morphs[name]));
  const morphSurprise = (name: string, from: number, to: number) => within(from, to).map(({ i }) => Math.abs(frames[i].morphs[name] - 2 * frames[i - 1].morphs[name] + frames[i - 2].morphs[name]));
  return { frames, step, surprise, morphMax, morphSurprise };
}

for (const fps of [60, 30]) {
  test(`full-screen Gene, ${fps} fps: her face (mood, pat, pinch, snack, thinking, drowsy) over her own walk; nothing jumps; she walks as before`, async () => {
    const off = await run(fps, false), on = await run(fps, true);
    // She walks across and back exactly as without her face (her face never takes her place or her gait).
    const xs = (r: typeof on, at: number) => r.frames.find(f => f.t >= at)!.x;
    assert.ok(xs(on, 11.4) > 0.4 && Math.abs(xs(on, 11.4) - xs(off, 11.4)) < 0.03, `walked across (${xs(off, 11.4).toFixed(3)} → ${xs(on, 11.4).toFixed(3)} m)`);
    assert.ok(on.frames.some(f => f.t >= 9.2 && f.t < 11.2 && f.walking), 'patted while walking');
    // What shows: the mood smile, the long pat's lids (standing and walking), the snack mouth.
    assert.ok(on.morphMax('smile', 3, 4) > 0.05 && off.morphMax('smile', 3, 4) === 0, `the mood smile ${on.morphMax('smile', 3, 4).toFixed(3)}`);
    assert.ok(on.morphMax('blink', 6, 7) > 0.6, `a long comfortable pat: lids ${on.morphMax('blink', 6, 7).toFixed(3)}`);
    assert.ok(on.morphMax('blink', 10.5, 11.2) > 0.4, `patted while walking: lids ${on.morphMax('blink', 10.5, 11.2).toFixed(3)}`);
    assert.ok(on.morphMax('a', 16, 17.3) > 0.05 && off.morphMax('a', 16, 17.3) === 0, `the snack mouth opens ${on.morphMax('a', 16, 17.3).toFixed(3)}`);
    // The pinch (while she walks home): her head goes with your fingers, over the gait.
    const HEAD = TRACKED.indexOf('頭'), at = (r: typeof on, t: number) => r.frames.find(f => f.t >= t)!.rotations[HEAD];
    const pinchTurn = at(on, 14.8).angleTo(at(off, 14.8)) * DEG;
    assert.ok(pinchTurn > 1.5, `the pinch turns her head ${pinchTurn.toFixed(2)}°`);
    // Waiting for her reply: the thinking look (a glance up and aside, a tilt) shows on her head and eyes; it eases back after the first words.
    const thinkTurn = Math.max(...[19.4, 19.8, 20.2].map(t => at(on, t).angleTo(at(off, t)) * DEG));
    assert.ok(thinkTurn > 1, `the thinking look turns her head ${thinkTurn.toFixed(2)}°`);
    assert.ok(on.morphMax('blink', 22, 24) > 0.2, `drowsy lids ${on.morphMax('blink', 22, 24).toFixed(3)}`);
    // Her face's expression morphs ease (the smile's change never departs far from the last frame's).
    const smileSurprise = max(on.morphSurprise('smile', 0, 24)), bound = fps === 60 ? 0.015 : 0.05;
    assert.ok(smileSurprise < bound, `smile unexpected step ${smileSurprise.toFixed(4)} (bound ${bound})`);
    // Her body, per segment: the unexpected step stays at the level of the run without her face (R29c).
    const rows = SEGMENTS.map(([name, from, to]) => ({ name, offStep: max(off.step(from, to)), onStep: max(on.step(from, to)), offSurprise: max(off.surprise(from, to)), onSurprise: max(on.surprise(from, to)) }));
    const limit = fps === 60 ? 0.5 : 1.0;
    for (const row of rows) assert.ok(row.onSurprise < Math.max(limit, row.offSurprise * 1.5), `${row.name}: unexpected step ${row.onSurprise.toFixed(3)}° (without her face ${row.offSurprise.toFixed(3)}°)`);
    const line = `  full ${fps} fps · ` + rows.map(r => `${r.name} step ${r.offStep.toFixed(3)}→${r.onStep.toFixed(3)}° surprise ${r.offSurprise.toFixed(3)}→${r.onSurprise.toFixed(3)}°`).join(' · ')
      + ` · pinch head ${pinchTurn.toFixed(1)}° · thinking head ${thinkTurn.toFixed(1)}° · smile ${on.morphMax('smile', 3, 4).toFixed(2)} · lids pat ${on.morphMax('blink', 6, 7).toFixed(2)} walk+pat ${on.morphMax('blink', 10.5, 11.2).toFixed(2)} · mouth ${on.morphMax('a', 16, 17.3).toFixed(2)} · smile surprise ${smileSurprise.toFixed(4)}`;
    if (REPORT) console.log(line); else console.log(line.slice(0, 400));
  });
}
