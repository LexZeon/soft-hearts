/**
 * I-154 follow-up, batch G (docs/claude/2026-11-21-unbound-full-BG.md): her sleep out in full-screen Unbound, on the bundled public Gene in
 * the page's own frame order (her own life → her sleep (the doze as goals laid over the owners with her face, the sleep body as the figure's
 * overlay) → her place (held while she is down; a walk to a sleep spot) → the idle layer → her frame), through the laptop's real world
 * camera, at 60 and 30 fps. "Before" is today's full-screen page (no sleep layers: the drowsy face only).
 *
 * Two places:
 *  - near the screen (4 m): the floor is below the screen there, so no sleep pose fits where she stands. She has walked off to the side
 *    (her own life); falling asleep, she walks straight back and brakes at the first place a pose fits, sleeps there (a walk of her own
 *    asked for meanwhile does not move her), wakes, gets up and walks back to her place;
 *  - far back (9.5 m): a desk or a pillow fits where she stands; it stands beside her at world scale; she never walks.
 * Measured: the 17 tracked bones' step and unexpected step (R29c) per segment, her root while she is down, her planted feet, the pose chosen,
 * the props. FULL_SLEEP_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { UNITS_PER_M } from '../src/unbound/figure';
import { applyWorldCamera } from '../src/unbound/camera';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { LifePlayer } from '../src/unbound/life/player';
import { LIFE_ACTION_IDS } from '../shared/unbound/life/registry';
import type { LifePlan } from '../shared/unbound/life/types';
import { HerOutFace } from '../src/unbound/her/out-face';
import { HerOut } from '../src/unbound/her/out-page';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { loadLivelinessForEngine } from '../src/stage';
import type { FatiguePhase } from '../shared/mood/fatigue';
import { geneFigure, max, plantedDrift, TRACKED, type FootShown } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { LAPTOP, laptopLens, laptopView } from './helpers/unbound-peek';
import { surprises, frameSteps } from './helpers/unbound-window';
import { card, faceView } from './helpers/window-face-fixture';

const REPORT = process.env.FULL_SLEEP_REPORT === '1';
// The page's size (HerOut reads the window's, as the page does).
Object.assign(globalThis, { innerWidth: 1706, innerHeight: 1013 });
const DIP = { width: LAPTOP.workArea.width / LAPTOP.scaleFactor, height: LAPTOP.workArea.height / LAPTOP.scaleFactor };
const SECONDS = 56;
const phaseAt = (t: number): FatiguePhase => t < 5 ? 'awake' : t < 8 ? 'drowsy' : t < 26 ? 'falling-asleep' : t < 36 ? 'asleep' : 'awake';
const SEGMENTS: [string, number, number][] = [['walk off', 1, 4.5], ['drowsy', 5, 8], ['going down', 8, 26], ['asleep', 26, 36], ['getting up', 36, 44], ['walk back', 44, SECONDS]];

interface Place { name: string; home: { xM: number; depthM: number }; away: number | null }
const NEAR: Place = { name: 'near', home: { xM: 0.3, depthM: 4 }, away: -0.5 };
const FAR: Place = { name: 'far', home: { xM: 0.3, depthM: 9.5 }, away: null };

function laptopCamera(home: Place['home']): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M, camera = new PerspectiveCamera(30, DIP.width / DIP.height, 0.05 * U, 400 * U);
  applyWorldCamera(camera, { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical',
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: home } as never, 0.05);
  return camera;
}

interface Run { times: number[]; frames: Quaternion[][]; root: Vector3[]; feet: FootShown[][]; held: boolean[]; head: number[]; seeking: boolean[]; progress: number[]; props: number[];
  propFrom: number; choice: string | null; murmurs: number }

async function run(fps: number, place: Place, withSleep_: boolean, control: { at: number; xM: number; depthM: number } | null = null): Promise<Run> {
  const home = place.home, { fixture, figure } = await geneFigure({ xM: home.xM, depthM: home.depthM });
  const mesh = fixture.mesh, measured = measureWindowModel(mesh, null, true);
  figure.faceToward({ x: 0, z: 0.55 });
  const shipped = await shippedIdle();
  const idle = new UnboundIdleLayer(async h => createBundledIdle(h, shipped, 7));
  idle.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve));
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const camera = laptopCamera(home), lens = laptopLens(), world = new Scene();
  world.add(mesh);
  const life = new LifePlayer(LIFE_ACTION_IDS, () => {}, () => idle.quickBusy);
  const SLEEP_CARD = card(['closeEyes', 'blush', 'mouth', 'sleepPose', 'drowsyFace']);
  // Before: today's page (her face only). After: the page's own HerOut (out-page.ts), so this runs exactly its frame (the games, the sleep,
  // the overlay and breath, her face with both laid over the owners, her place, her own life told to give way).
  let murmurs = 0;
  const face = withSleep_ ? null : new HerOutFace(random);
  face?.attach({ body: figure, mesh, profile: measured.profile, painter: measured.painter, reviewed: true, standard: false, url: 'gene' });
  face?.setCard(SLEEP_CARD);
  const her = withSleep_ ? new HerOut({} as HTMLElement, null, { camera, pixels: () => 0, canTouch: () => true, scene: world, home: () => home,
    bubble: { shown: false, receive: value => { if (value.type === 'delta' && value.id.startsWith('sleep-murmur:')) murmurs++; } } }, random) : null;
  if (her) {
    her.attach(figure, measured, { reviewed: true, url: 'gene' }, null);
    her.sleep.load(await loadLivelinessForEngine());
    her.face.setCard(SLEEP_CARD);
    her.yieldLife = () => life.yieldNow();
  }
  const walk = (xM: number, depthM: number): LifePlan => ({ action: 'place', level: 'place', keys: [{ t: 0 }], walk: { xM, depthM, speedMps: 0.5 }, amplitude: 1, easeS: 1, waitQuickS: 0 });
  const bones = TRACKED.map(name => mesh.skeleton.bones.find(b => b.name === name)!);
  const out: Run = { times: [], frames: [], root: [], feet: [], held: [], head: [], seeking: [], progress: [], props: [], propFrom: Infinity, choice: null, murmurs: 0 };
  const m = 1 / UNITS_PER_M;
  try {
    for (let i = 0; i <= Math.round(fps * SECONDS); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      if (place.away !== null && Math.abs(t - 1) < 0.5 / fps) life.command({ type: 'start', id: 'off', plan: walk(place.away, home.depthM), trial: false });
      if (Math.abs(t - 30) < 0.5 / fps) life.command({ type: 'start', id: 'stray', plan: walk(1.2, home.depthM), trial: false }); // asked for while she sleeps
      if (Math.abs(t - 35) < 0.5 / fps) figure.place({ xM: 1.2, depthM: home.depthM }); // a new place from the scene while she sleeps (the page's applyScene)
      const phase = phaseAt(t), view = faceView({ primary: 'calm', companion: null, phase, F: phase === 'awake' ? 0.2 : 0.9 });
      if (her) { (her as unknown as { view: unknown }).view = view; her.face.setMood(view); } else face!.setMood(view); // as the touch input hands the page her mood
      const owners = her ? her.wrap(idle.wrap(figure)) : face!.wrap(idle.wrap(figure));
      life.frame(dt, { lens }, owners, { walking: figure.walking, moving: figure.moving, heightM: figure.heightM, placement: figure.placement }, false);
      const env = { shown: true, adjusting: false, voiced: false, speaking: false, walking: figure.walking };
      const faced = her ? her.frame(dt, idle.wrap(figure), { ...env, breath: 0.5, pointer: null }) : face!.frame(dt, idle.wrap(figure), { ...env, nowMs: 1e6 + t * 1000 });
      if (control && t >= control.at) figure.followTo({ x: control.xM, z: -control.depthM }); // the same walk back, by her gait alone (no sleep): its own turn and start
      idle.frame(dt, idleWanted({ performing: faced.performing, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }), life.idleRate);
      figure.frame(dt);
      out.murmurs = murmurs;
      const sleep = her?.sleep ?? null;
      const report = figure.report!;
      out.times.push(t); out.frames.push(bones.map(b => b.getWorldQuaternion(new Quaternion()))); out.root.push(mesh.position.clone().multiplyScalar(m));
      out.held.push(sleep?.holdsPlace === true); out.seeking.push(sleep?.seekingSpot === true); out.head.push(mesh.skeleton.bones.find(b => b.name === "頭")!.getWorldPosition(new Vector3()).y / UNITS_PER_M);
      out.feet.push(report.feet.map(f => ({ planted: f.planted, pitch: f.pitch, ankle: f.ankle.clone().multiplyScalar(m), toe: f.toe?.clone().multiplyScalar(m) ?? null, target: f.target.clone().multiplyScalar(m), ik: f.ikWorld.clone().multiplyScalar(m) })));
      const state = sleep?.sleep.getState() as { progress?: number; weight?: number; props?: { pillow: number; desk: number } | null; choice?: string } | null;
      out.progress.push((state?.progress ?? 0) * (state?.weight ?? 0));
      const shown = Math.max(state?.props?.pillow ?? 0, state?.props?.desk ?? 0);
      out.props.push(shown);
      if (shown > 0.5) {
        const prop = world.getObjectByName('sleep-pillow') ?? world.getObjectByName('sleep-desk');
        if (prop) out.propFrom = Math.min(out.propFrom, prop.getWorldPosition(new Vector3()).multiplyScalar(m).setY(0).distanceTo(out.root.at(-1)!.clone().setY(0)));
      }
      if (state?.choice && state.choice !== 'stand') out.choice = state.choice;
    }
  } finally { her?.dispose(); face?.attach(null); figure.dispose(); fixture.close(); }
  return out;
}

function row(r: Run, from: number, to: number) {
  const frames = r.frames.filter((_, i) => r.times[i] >= from && r.times[i] <= to);
  return { step: max(frameSteps(frames)), surprise: max(surprises(frames).perFrame) };
}
const spans = (flags: readonly boolean[]) => flags.flatMap((f, i) => f && !flags[i - 1] ? [i] : []).map(start => { let end = start; while (flags[end + 1]) end++; return [start, end] as const; });

for (const fps of [60, 30]) {
  for (const place of [NEAR, FAR]) {
    test(`full-screen Gene, ${fps} fps, ${place.name}: she falls asleep where a pose fits from the world camera, sleeps without sliding, gets up and walks back`, async () => {
      const before = await run(fps, place, false), after = await run(fps, place, true), home = place.home;
      const at = (t: number) => after.times.findIndex(x => x >= t);
      assert.ok(after.progress[at(35)] > 0.5, `asleep: down in her sleep pose (progress ${after.progress[at(35)].toFixed(2)}, ${after.choice})`);
      assert.ok(after.progress.at(-1)! < 0.1, `awake: up again (progress ${after.progress.at(-1)!.toFixed(2)})`);
      assert.ok(after.head[at(35)] < 0.75 * after.head[at(4)], `her body shows the pose: her head is down (${after.head[at(35)].toFixed(2)} m, standing ${after.head[at(4)].toFixed(2)} m)`);
      assert.equal(max(before.progress), 0, 'before: no sleep body out here');
      // Her place: held while she is down (the walk asked for at 30 s never moves her).
      const held = spans(after.held);
      assert.equal(held.length, 1, `held once (${held.map(([a, b]) => `${after.times[a].toFixed(1)}–${after.times[b].toFixed(1)}`).join(', ')})`);
      const [first, last] = held[0];
      const heldMove = max(after.root.slice(first, last + 1).map(p => p.distanceTo(after.root[first]) * 100));
      assert.ok(heldMove < 2, `she does not move while she is down (${heldMove.toFixed(2)} cm)`);
      assert.ok(Math.abs(before.root[at(38)].x - 1.2) < 0.3, 'before: the walk asked for while asleep took her away');
      const slept = after.root[first], seek = spans(after.seeking);
      if (place === NEAR) {
        assert.equal(seek.length, 1, 'no pose fits near the screen: she walked back once to find a place');
        assert.ok(-slept.z > home.depthM + 0.5 && Math.abs(slept.x - (place.away ?? 0)) < 0.25, `she slept farther back, where she had walked to (${slept.x.toFixed(2)}, ${(-slept.z).toFixed(2)} m)`);
      } else {
        assert.equal(seek.length, 0, 'a pose fits where she stands: no walk');
        assert.ok(slept.distanceTo(new Vector3(home.xM, slept.y, -home.depthM)) < 0.1, 'she slept at her place');
        assert.ok(after.choice?.startsWith('desk') || after.choice?.startsWith('lie'), `a desk or a pillow (${after.choice})`);
        assert.ok(max(after.props) > 0.9 && after.propFrom < 1.2, `her ${after.choice} stands beside her at world scale (${after.propFrom.toFixed(2)} m from her)`);
      }
      assert.ok(Math.abs(after.root.at(-1)!.x - home.xM) < 0.15 && Math.abs(-after.root.at(-1)!.z - home.depthM) < 0.15,
        `then she walked back to her place (${after.root.at(-1)!.x.toFixed(2)}, ${(-after.root.at(-1)!.z).toFixed(2)} m)`);
      // Planted feet while she stands still before going down.
      const standing = after.feet.slice(at(5), at(7.5)).map((feet, i) => ({ feet, root: after.root[at(5) + i] })) as unknown as Parameters<typeof plantedDrift>[0];
      const drift = plantedDrift(standing, after.feet[0][0].ankle.y).toeDrift;
      assert.ok(drift < 1.5, `planted feet stay put while she stands (${drift.toFixed(2)} cm)`);
      // Every segment eases (R29c): at most her own walk's level, or the floor.
      // Near: the same walk back done by her own life (no sleep), from the moment she set off: her gait's own turn and start, the level her walk to the sleep spot is held to.
      const seekAt = seek.length ? after.times[seek[0][0]] : null;
      const control = seekAt !== null ? await run(fps, place, false, { at: seekAt, xM: slept.x, depthM: -slept.z }) : null;
      const controlLevel = control && seekAt !== null ? row(control, seekAt - 0.2, seekAt + 4).surprise : 0;
      const limit = fps === 60 ? 0.5 : 1.0, walkLevel = Math.max(row(before, 1, 4.5).surprise, row(before, 30, 34).surprise, row(after, 1, 4.5).surprise, controlLevel);
      const rows = SEGMENTS.map(([name, from, to]) => ({ name, before: row(before, from, to), after: row(after, from, to) }));
      for (const r of rows) assert.ok(r.after.surprise < Math.max(limit, walkLevel * 1.25, r.before.surprise * 1.5), `${r.name}: unexpected step ${r.after.surprise.toFixed(3)}° (before ${r.before.surprise.toFixed(3)}°, her walk ${walkLevel.toFixed(3)}°, the same walk back by her gait alone ${controlLevel.toFixed(3)}°)`);
      const line = `  full sleep ${place.name} ${fps} fps · ` + (control ? `the same walk back by her gait alone: surprise ${controlLevel.toFixed(3)}° · ` : "") + rows.map(r => `${r.name} step ${r.before.step.toFixed(3)}→${r.after.step.toFixed(3)}° surprise ${r.before.surprise.toFixed(3)}→${r.after.surprise.toFixed(3)}°`).join(' · ')
        + ` · choice ${after.choice} · props ${max(after.props).toFixed(2)}${Number.isFinite(after.propFrom) ? ` at ${after.propFrom.toFixed(2)} m` : ''} · slept at ${slept.x.toFixed(2)},${(-slept.z).toFixed(2)} m · held ${heldMove.toFixed(2)} cm over ${((last - first) / fps).toFixed(1)} s · back at ${after.root.at(-1)!.x.toFixed(2)},${(-after.root.at(-1)!.z).toFixed(2)} m · feet ${drift.toFixed(2)} cm · murmurs ${after.murmurs}`;
      console.log(REPORT ? line : line.slice(0, 400));
    });
  }
}
