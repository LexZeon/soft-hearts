/**
 * I-154 follow-up, batches D and F (docs/claude/2026-11-21-unbound-full-D.md): her look at you, her reactions to your pose, her shows and the
 * music out in full-screen Unbound, on the page's own HerOut (out-page.ts) in its frame order (her own life → HerOut: her motions' gates,
 * the games, her sleep, the music and the reactions, her face with the look laid over the owners → the idle layer → her frame), through the
 * laptop's real world camera, at 60 and 30 fps, on the bundled public Gene and on the synthetic full-face VRM (nothing from a real model).
 * "Before" is the same script on today's page: the same walks and pulls, nothing of the readings, cues, shows or samples reaching her.
 *
 * D, 24 s: she stands; pose sensing comes on and you face her (readings every 0.2 s); she walks off looking at you; you wave, she waves back;
 *    she walks home and catches your stretch on the way (upper body over her gait); a 惊喜 show; sensing goes off and she lets go.
 * F, 18 s: 和她一起听 with "一直跟着跳" (frames at 30 Hz, the window tests' song samples): she dances; she walks (the dance yields, her gait is untouched); she
 *    dances again; a pull (the dance yields); pose sensing on meanwhile (her look at you stacks on the dance); the music off.
 * Measured: the 17 tracked bones' step and unexpected step (R29c) per segment; her legs against "before" while she walks; what each layer did.
 * FULL_SENSES_REPORT=1 prints the numbers in the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Quaternion, Scene, Vector3, type Bone } from 'three';
import { UNITS_PER_M, UnboundFigure } from '../src/unbound/figure';
import { applyWorldCamera } from '../src/unbound/camera';
import { UnboundIdleLayer, idleWanted } from '../src/unbound/motion/unbound-idle';
import { createBundledIdle } from '../src/unbound/motion/bundled-idle';
import { LifePlayer } from '../src/unbound/life/player';
import { LIFE_ACTION_IDS } from '../shared/unbound/life/registry';
import { HerOut } from '../src/unbound/her/out-page';
import { composeLook } from '../src/unbound/her/out-gaze';
import { measureWindowModel } from '../src/unbound/window-mode/window-model';
import { loadLivelinessForEngine, loadMusicForEngine } from '../src/stage';
import type { MoodView } from '../shared/mood';
import { geneFigure, max, TRACKED } from './helpers/unbound-gene';
import { shippedIdle } from './helpers/unbound-idle-stream';
import { LAPTOP, laptopLens, laptopView } from './helpers/unbound-peek';
import { surprises, frameSteps, DEG } from './helpers/unbound-window';
import { faceView } from './helpers/window-face-fixture';
import { syntheticVrm } from './helpers/synthetic-vrm';
import { syntheticStandardBody, trackedBones } from './helpers/unbound-vrm';
import { songSample } from './helpers/frame-stats';

const REPORT = process.env.FULL_SENSES_REPORT === '1';
const DIP = { width: LAPTOP.workArea.width / LAPTOP.scaleFactor, height: LAPTOP.workArea.height / LAPTOP.scaleFactor };
Object.assign(globalThis, { innerWidth: Math.round(DIP.width), innerHeight: Math.round(DIP.height) }); // HerOut reads the window's size, as the page does
const HOME = { xM: 0.3, depthM: 4 };
// ui-zh-ok: MMD bone names inside the model file, not interface text
const LEGS = ['左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首'];
const READING = { present: true, facing: 'toward', energy: 0.15, point: { x: 0.35, y: 0.2, dx: 1.4, dy: 2.3 }, screen: null };

type Kind = 'gene' | 'vrm';
interface Script { seconds: number; segments: [string, number, number][]; step(t: number, s: Ctl): void }
interface Ctl { walk(xM: number): void; reading(on: boolean): void; cue(kind: 'wave' | 'stretch'): void; show(): void; music(on: boolean): void; pulled: boolean; t: number }

const D: Script = { seconds: 24, segments: [['still', 0.5, 2], ['you come', 2, 5], ['walk, looking at you', 5, 8.5], ['wave back', 9, 13], ['stretch while walking', 13.5, 17], ['surprise', 18, 20], ['sensing off', 20, 24]],
  step(t, s) {
    const at = (x: number) => s.t < x && t >= x;
    if (at(2)) s.reading(true);
    if (at(5)) s.walk(-0.6);
    if (at(9)) s.cue('wave');
    if (at(13.5)) s.walk(HOME.xM);
    if (at(14)) s.cue('stretch');
    if (at(18)) s.show();
    if (at(20)) s.reading(false);
  } };
const F: Script = { seconds: 18, segments: [['still', 0.5, 1], ['dance', 1.5, 6], ['walk: dance yields', 6, 9.5], ['dance again', 10, 11], ['pull: dance yields', 11, 13], ['dance and look', 13, 15], ['music off', 15, 18]],
  step(t, s) {
    const at = (x: number) => s.t < x && t >= x;
    if (at(1)) s.music(true);
    if (at(6)) s.walk(-0.6);
    s.pulled = t >= 11 && t < 13;
    if (at(12)) s.reading(true);
    if (at(15)) s.music(false);
  } };

function laptopCamera(): PerspectiveCamera {
  const view = laptopView(), U = UNITS_PER_M, camera = new PerspectiveCamera(30, DIP.width / DIP.height, 0.05 * U, 400 * U);
  applyWorldCamera(camera, { screen: view.screen, display: LAPTOP.bounds, workArea: LAPTOP.workArea, window: LAPTOP.workArea, mapping: 'physical',
    viewerDistanceM: view.viewerDistanceM, eyeHeightM: view.eyeHeightM, placement: HOME } as never, 0.05);
  return camera;
}

async function model(kind: Kind) {
  if (kind === 'gene') {
    const { fixture, figure } = await geneFigure({ xM: HOME.xM, depthM: HOME.depthM });
    const bones = TRACKED.map(name => fixture.mesh.skeleton.bones.find(b => b.name === name)!);
    return { figure, mesh: fixture.mesh, measure: measureWindowModel(fixture.mesh, null, true), standard: null, bones, close: () => fixture.close() };
  }
  const standard = await syntheticStandardBody('1.0', syntheticVrm({ face: 'full' }));
  const figure = new UnboundFigure(standard.mesh, HOME);
  return { figure, mesh: standard.mesh, measure: measureWindowModel(standard.mesh, standard, false), standard, bones: trackedBones(standard), close: () => standard.dispose() };
}

async function run(kind: Kind, fps: number, script: Script, after: boolean) {
  const m = await model(kind), { figure, mesh, standard } = m;
  figure.faceToward({ x: 0, z: 0.55 });
  const shipped = await shippedIdle();
  const idle = new UnboundIdleLayer(async h => createBundledIdle(h, shipped, 7));
  idle.attach(figure, figure.heightM);
  await new Promise(resolve => setImmediate(resolve));
  let seed = 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const camera = laptopCamera(), lens = laptopLens(), world = new Scene();
  world.add(mesh);
  // No page here (the touch input needs one): the host's events are handed to what the page's callbacks call (out-page.ts onUserGaze, out-senses.ts onDance).
  let clockMs = 0; // the page's clock is this run's frame clock (a slow machine's pauses are not silence)
  const her = new HerOut({} as HTMLElement, null, { camera, pixels: () => 0, canTouch: () => true, scene: world, home: () => HOME, now: () => clockMs }, random);
  const facts: [string, unknown][] = [], on = { gaze: (v: unknown) => her.face.gaze.set(v), dance: (v: unknown) => her.senses.dance(v) };
  her.face.gazeFact = event => facts.push(['gaze', event]);
  her.attach(figure, m.measure, { reviewed: kind === 'gene', url: kind }, standard);
  const lively = await loadLivelinessForEngine();
  her.face.loadLife(lively); her.sleep.load(lively);
  her.senses.music.load(await loadMusicForEngine());
  her.senses.music.setSettings({ alwaysDance: true, strength: 0.7 }); // "让她一直跟着跳": she dances whenever she hears
  const life = new LifePlayer(LIFE_ACTION_IDS, () => {}, () => idle.quickBusy);
  her.yieldLife = () => life.yieldNow();
  const legs = LEGS.map(name => mesh.skeleton.bones.find(b => b.name === name) ?? null).filter((b): b is Bone => !!b);
  let reading = false, music = false, cue: MoodView['pose'] | undefined, beatT = 0, sampleIndex = 0, lastReadingAt = -1, lastSampleAt = -1, walks = 0;
  const out = { times: [] as number[], frames: [] as Quaternion[][], legs: [] as Quaternion[][], walking: [] as boolean[], user: [] as number[], look: [] as number[], reacting: [] as boolean[], showing: [] as boolean[],
    dancing: [] as boolean[], reason: [] as (string | null)[], hearing: [] as boolean[], fresh: [] as boolean[], centreY: [] as number[], facts, root: [] as Vector3[] };
  const ctl: Ctl = { t: -1, pulled: false,
    walk: xM => { walks++; figure.followTo({ x: xM, z: -HOME.depthM }); }, // her gait to a place (as a walk of her own life ends up)
    reading: v => { reading = v; if (after && !v) on.gaze(null); },
    cue: k => { if (after) cue = { attention: 0.8, boost: 2, cue: { id: `${k}-${Math.round(ctl.t * 1000)}`, kind: k, source: 'follow', at: Date.now(), strength: 1 } }; },
    show: () => { if (after) her.senses.playExpression('surprise'); },
    music: v => { music = v; if (after && !v) on.dance(null); } };
  const centre = mesh.skeleton.bones.find(b => b.name === 'センター')!;
  try {
    for (let i = 0; i <= Math.round(fps * script.seconds); i++) {
      const t = i / fps, dt = i ? 1 / fps : 0;
      clockMs = t * 1000;
      script.step(t, ctl); ctl.t = t;
      if (after && reading && t - lastReadingAt >= 0.2) { lastReadingAt = t; on.gaze(READING); }
      if (after && music && t - lastSampleAt >= 1 / 30 - 1e-9) {
        lastSampleAt = t; beatT += 1 / 30;
        const song = songSample(sampleIndex++); // the window's song fixture (the old stage's own samples)
        on.dance({ id: 'cap-system-audio', source: 'system-audio', revision: 1, sample: { time: beatT, rms: song.rms, low: song.low, mid: song.mid, high: song.high } });
      }
      const view = faceView({ primary: 'calm', companion: null });
      if (cue) view.pose = cue;
      (her as unknown as { view: unknown }).view = view; her.face.setMood(view); her.motions.setMood(view);
      const owners = her.wrap(idle.wrap(figure));
      life.frame(dt, { lens }, owners, { walking: figure.walking, moving: figure.moving, heightM: figure.heightM, placement: figure.placement }, false);
      const faced = her.frame(dt, idle.wrap(figure), { shown: true, adjusting: ctl.pulled, voiced: false, speaking: false, walking: figure.walking, pulled: ctl.pulled, breath: 0.5, pointer: null });
      idle.frame(dt, idleWanted({ performing: faced.performing, walking: figure.walking, moving: figure.moving, stance: figure.report?.stance ?? 'both' }), life.idleRate);
      figure.frame(dt);
      standard?.present();
      her.after(DIP.width, DIP.height);
      mesh.updateMatrixWorld(true);
      out.times.push(t); out.frames.push(m.bones.map(b => b.getWorldQuaternion(new Quaternion()))); out.legs.push(legs.map(b => b.quaternion.clone()));
      out.walking.push(figure.walking); out.user.push(her.face.gazeOut?.choice?.user ?? 0);
      const looked = her.face.gazeOut?.choice ? composeLook(null, her.face.gazeOut) : null; out.look.push(looked ? Math.hypot(looked.yaw, looked.pitch) * DEG : 0); out.reacting.push(her.senses.reactions.reacting); out.showing.push(her.senses.reactions.showing);
      out.dancing.push((her.senses.music.getState().dance?.presence ?? 0) > 0.05 && her.senses.music.moving); out.reason.push(her.senses.music.yieldReason);
      out.hearing.push(her.senses.music.getState().hearing); out.fresh.push(her.face.gaze.fresh); out.centreY.push(centre.position.y); out.root.push(mesh.position.clone().multiplyScalar(1 / UNITS_PER_M));
    }
  } finally { her.dispose(); figure.dispose(); m.close(); }
  const span = (from: number, to: number) => out.frames.filter((_, i) => out.times[i] >= from && out.times[i] <= to);
  // The upper body: centre to both elbows, the first 11 tracked bones (her legs' large numbers while she walks are her gait's, the same before and after).
  const row = (from: number, to: number) => ({ step: max(frameSteps(span(from, to))), surprise: max(surprises(span(from, to)).perFrame),
    upper: max(surprises(span(from, to).map(f => f.slice(0, 11))).perFrame) });
  return { ...out, row, at: (x: number) => out.times.findIndex(v => v >= x) };
}

const legGap = (a: Awaited<ReturnType<typeof run>>, b: Awaited<ReturnType<typeof run>>, from: number, to: number) =>
  max(a.legs.flatMap((frame, i) => a.times[i] >= from && a.times[i] <= to && a.walking[i] && b.walking[i] ? frame.map((q, k) => q.angleTo(b.legs[i][k]) * DEG) : []));
/** How far her tracked bones are from "before" in a span (degrees): what the layers visibly did. */
const shownGap = (a: Awaited<ReturnType<typeof run>>, b: Awaited<ReturnType<typeof run>>, from: number, to: number) =>
  max(a.frames.flatMap((frame, i) => a.times[i] >= from && a.times[i] <= to ? frame.map((q, k) => q.angleTo(b.frames[i][k]) * DEG) : []));
const report = (label: string, rows: { name: string; before: { step: number; surprise: number; upper: number }; after: { step: number; surprise: number; upper: number } }[], extra: string) => {
  const line = `  ${label} · ` + rows.map(r => `${r.name} step ${r.before.step.toFixed(3)}→${r.after.step.toFixed(3)}° surprise ${r.before.surprise.toFixed(3)}→${r.after.surprise.toFixed(3)}° upper ${r.before.upper.toFixed(3)}→${r.after.upper.toFixed(3)}°`).join(' · ') + ` · ${extra}`;
  console.log(REPORT ? line : line.slice(0, 500));
};

for (const kind of ['gene', 'vrm'] as const) {
  for (const fps of [60, 30]) {
    test(`full-screen ${kind}, ${fps} fps, D: she looks at you (walking too), waves back, catches your stretch over her gait, a 惊喜 show, lets go when sensing stops; all eased`, async () => {
      const before = await run(kind, fps, D, false), after = await run(kind, fps, D, true);
      const seg = (a: number, b: number, flags: boolean[] | number[]) => flags.filter((_, i) => after.times[i] >= a && after.times[i] <= b);
      assert.ok(max(seg(2, 8.5, after.user) as number[]) > 0.5, 'with you facing her she looks at you');
      assert.ok(after.user.some((u, i) => u > 0.5 && after.walking[i]), 'while she walks too');
      assert.equal(max(before.user), 0, 'before: nothing of it');
      assert.ok((seg(9, 13, after.reacting) as boolean[]).some(Boolean), 'she waves back');
      assert.ok(after.reacting.some((r, i) => r && after.walking[i] && after.times[i] >= 13.5), 'she catches your stretch while she walks');
      assert.ok((seg(18, 20, after.showing) as boolean[]).some(Boolean), 'the 惊喜 show plays');
      assert.equal(after.fresh[after.at(20) + 1], false, 'sensing off: the reading is gone at once');
      assert.ok(after.user.at(-1)! < 0.05, `she let go (${after.user.at(-1)!.toFixed(3)})`);
      const starts = after.facts.filter(([k, v]) => k === 'gaze' && (v as { kind: string }).kind === 'start').length;
      assert.equal(starts, 1, 'one start told to the host');
      assert.ok(after.facts.some(([k, v]) => k === 'gaze' && (v as { kind: string; why?: string }).why === 'off'), 'and the stop when sensing went off');
      const legs = legGap(after, before, 13.5, 17);
      assert.ok(legs < 2, `her legs while she walks and reacts are her gait's (${legs.toFixed(3)}° from before)`);
      const limit = fps === 60 ? 0.6 : 1.4, walkLevel = Math.max(before.row(5, 8.5).surprise, before.row(13.5, 17).surprise);
      const rows = D.segments.map(([name, from, to]) => ({ name, before: before.row(from, to), after: after.row(from, to) }));
      for (const r of rows) assert.ok(r.after.surprise < Math.max(limit, walkLevel * 1.25, r.before.surprise * 1.5), `${r.name}: unexpected step ${r.after.surprise.toFixed(3)}° (before ${r.before.surprise.toFixed(3)}°, her walk ${walkLevel.toFixed(3)}°)`);
      report(`full D ${kind} ${fps} fps`, rows, `look at you max ${max(after.user).toFixed(2)} (her look toward you up to ${max(after.look).toFixed(1)}° from where she faces) · shown vs before: ${D.segments.map(([n, a, b]) => `${n} ${shownGap(after, before, a, b).toFixed(1)}°`).join(', ')} · legs vs before while walking ${legs.toFixed(3)}° · gaze facts ${after.facts.map(([, v]) => (v as { kind: string }).kind).join(',')}`);
    });

    test(`full-screen ${kind}, ${fps} fps, F: she dances to the music, the dance yields to her walk (gait untouched) and to a pull, her look at you stacks on it, it stops when the music does; all eased`, async () => {
      const before = await run(kind, fps, F, false), after = await run(kind, fps, F, true);
      const seg = <T>(a: number, b: number, list: T[]) => list.filter((_, i) => after.times[i] >= a && after.times[i] <= b);
      assert.ok(seg(2, 6, after.dancing).some(Boolean), 'she dances');
      assert.equal(before.dancing.some(Boolean), false, 'before: no music out here');
      assert.ok(after.reason.some((r, i) => r === 'walking' && after.walking[i]), 'her walk takes the dance');
      assert.ok(seg(11.5, 12.9, after.reason).every(r => r !== null && r !== 'disabled'), 'a pull takes the dance');
      assert.ok(seg(10, 11, after.dancing).some(Boolean), 'she dances again after the walk');
      assert.ok(after.user.some((u, i) => u > 0.5 && after.dancing[i]), 'her look at you stacks on the dance');
      assert.equal(after.hearing[after.at(15) + 1], false, 'the music off: she stops hearing at once');
      assert.equal(after.dancing.at(-1), false, 'and the dance has faded by the end');
      const legs = legGap(after, before, 6.5, 9.5);
      assert.ok(legs < 2, `her legs while she walks are her gait's (${legs.toFixed(3)}° from before)`);
      const limit = fps === 60 ? 0.6 : 1.4, walkLevel = before.row(6, 9.5).surprise;
      const rows = F.segments.map(([name, from, to]) => ({ name, before: before.row(from, to), after: after.row(from, to) }));
      for (const r of rows) assert.ok(r.after.surprise < Math.max(limit, walkLevel * 1.25, r.before.surprise * 1.5), `${r.name}: unexpected step ${r.after.surprise.toFixed(3)}° (before ${r.before.surprise.toFixed(3)}°, her walk ${walkLevel.toFixed(3)}°)`);
      const bounce = max(seg(2, 6, after.centreY).map(y => Math.abs(y - after.centreY[after.at(1)]))) / UNITS_PER_M * 100;
      report(`full F ${kind} ${fps} fps`, rows, `shown vs before: ${F.segments.map(([n, a, b]) => `${n} ${shownGap(after, before, a, b).toFixed(1)}°`).join(', ')} · centre bounce ${bounce.toFixed(2)} cm · legs vs before while walking ${legs.toFixed(3)}°`);
    });
  }
}
