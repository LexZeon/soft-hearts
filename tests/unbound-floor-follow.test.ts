// Full-screen Unbound: the floor follows her (the user's choice A). On the user's display (1536 × 960 DIP, a 48 DIP taskbar,
// the nominal 96 DIP per inch, viewed from 55 cm), through the page's own camera (src/unbound/floor-framing.ts → applyWorldCamera):
//  1. the bands: wherever her whole body fits, her soles are on the floor line (the work area's bottom, 12 DIP above it) at any depth; nearer
//     her head stays inside the work area; nearer still the eye is at her face's height (the close-up); no step anywhere along the depth;
//  2. three models (the bundled Gene as reviewed, Gene as another PMX through the motion fitting, a synthetic VRM) walk between places in the
//     real frame loop with the framing following: standing at each place her lowest drawn point is on the line; while walking the eye never
//     jumps (its unexpected step is no bigger than her root's own), at 60 and 30 fps;
//  3. the close-up: a peek from her home (8 m) brings her eye onto the lens axis with the framing following her walk in (before: the fixed eye
//     was 26 cm above her eyes on this display and she could not reach it);
//  4. a pull toward the camera (the joystick, I-196: the pointer held below the press point): the eye follows her walk continuously.
// `FLOOR_FOLLOW_REPORT=1` prints the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, Vector3, type AnimationClip, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { UnboundFigure, UNITS_PER_M } from '../src/unbound/figure';
import { WorldCamera, applyWorldCamera, placeholderWorld } from '../src/unbound/camera';
import { DIP_MAX_M, FloorFraming } from '../src/unbound/floor-framing';
import { parseVmdWith, type VmdDataTransform } from '../src/foundation/vmd';
import { withKeyframeInterpolation } from '../src/stage/keyframe-interpolation';
import { StageMotionRetarget } from '../src/actions/motion-retarget';
import { StageModelProfile } from '../src/stage/model-profile';
import { Director } from '../src/unbound/director/director';
import { PEEK_LENS } from '../src/unbound/director/peek-lens';
import { ProceduralGenerator } from '../src/unbound/motion/procedural';
import { axisOffset, eyePoint, lensView } from '../src/unbound/motion/lens-align';
import { ARRIVAL_KNOBS } from '../shared/unbound/arrival';
import { UnboundPull } from '../src/unbound/pull-input';
import { clampFollowDepth, parsePullAnswer } from '../shared/unbound/pull';
import { planPeek } from '../shared/unbound/director';
import { FACE_SHARE_FALLBACK, crownEyeHeight, floorEyeHeight, framedEyeHeight, framingBand, framingGeometry } from '../shared/unbound/framing/floor';
import { FLOOR_FRAMING_KNOBS } from '../shared/unbound/framing/knobs';
import { HOME_FEET_MARGIN_DIP, eyeHeightFor, placementAcross, resolvePhysicalScreen, type DisplayFacts, type Frustum } from '../shared/unbound/world';
import type { UnboundWorld } from '../shared/unbound/scene';
import { loadPublicGeneForTargets } from './public-gene-fixture';
import { STAND_VMD } from './helpers/unbound-gene';
import { syntheticStandardBody } from './helpers/unbound-vrm';
import { CURIOUS, LAPTOP } from './helpers/unbound-peek';

const REPORT = process.env.FLOOR_FOLLOW_REPORT === '1';
const U = UNITS_PER_M;
const USER: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
const LINE = USER.workArea.y + USER.workArea.height - HOME_FEET_MARGIN_DIP;

function worldOf(display: DisplayFacts = USER, d = 0.55, screen = resolvePhysicalScreen(display, null)): UnboundWorld {
  return { screen, display: { ...display.bounds }, workArea: { ...display.workArea }, window: { ...display.workArea }, mapping: 'physical', viewerDistanceM: d,
    eyeHeightM: eyeHeightFor(screen, display, d), placement: placementAcross({ screen, viewerDistanceM: d }) };
}
/** Screen y (DIP) of a world point (m), the way the page draws it: through the camera onto the window. */
function dipY(camera: WorldCamera, world: UnboundWorld, p: { x: number; y: number; z: number }): number {
  const v = new Vector3(p.x * U, p.y * U, p.z * U).project(camera);
  return world.window.y + (1 - v.y) / 2 * world.window.height;
}
/** The DIP y of a point with the eye at `eye` (the same projection, closed form). */
function dipAt(world: UnboundWorld, eye: number, y: number, depthM: number): number {
  const my = world.screen.heightM / world.display.height, t = world.viewerDistanceM / (world.viewerDistanceM + depthM);
  return world.display.y + world.display.height / 2 - (y - eye) * t / my;
}
const unexpected = (xs: readonly number[]) => { let worst = 0; for (let i = 2; i < xs.length; i++) worst = Math.max(worst, Math.abs(xs[i] - 2 * xs[i - 1] + xs[i - 2])); return worst; };
const steps = (xs: readonly number[]) => { let worst = 0; for (let i = 1; i < xs.length; i++) worst = Math.max(worst, Math.abs(xs[i] - xs[i - 1])); return worst; };

test('the bands: soles on the floor line wherever she fits, her head inside the work area nearer, her face level close; no step along the depth', () => {
  const world = worldOf(), g = framingGeometry(world)!;
  // The floor band is the host's home fit at every depth: at 8 m it IS the eye the host sends (one formula, shared/unbound/world.ts).
  for (const [display, d] of [[USER, 0.55], [USER, 0.3], [USER, 1.2], [LAPTOP, 0.55]] as const) {
    const w = worldOf(display, d), gg = framingGeometry(w)!;
    assert.ok(Math.abs(floorEyeHeight(gg, 8) - w.eyeHeightM) < 1e-9, `the floor band at 8 m is the host's eye (${floorEyeHeight(gg, 8)} vs ${w.eyeHeightM})`);
  }
  const rows: string[] = [];
  for (const heightM of [1.0, 1.597, 1.9]) {
    const body = { heightM, faceM: heightM * FACE_SHARE_FALLBACK }, band = framingBand(g, heightM)!;
    assert.ok(band.fitDepthM > 0.6 && Math.abs(band.closeDepthM - band.fitDepthM * FLOOR_FRAMING_KNOBS.closeShare) < 1e-12);
    let last: number | null = null, maxStep = 0;
    for (let mm = -540; mm <= 15000; mm++) {
      const depth = mm / 1000, eye = framedEyeHeight(g, depth, body);
      if (last !== null) maxStep = Math.max(maxStep, Math.abs(eye - last));
      last = eye;
      if (depth < 0.6) continue; // her own nearest; nearer only her eye comes to the lens (the peek)
      const feet = dipAt(world, eye, 0, depth), crown = dipAt(world, eye, heightM, depth), face = dipAt(world, eye, body.faceM, depth);
      if (depth >= band.fitDepthM + 0.1) assert.ok(Math.abs(feet - LINE) < 0.01, `${heightM} m at ${depth} m: soles on the line (${(feet - LINE).toFixed(3)} DIP)`);
      assert.ok(crown >= USER.workArea.y - 0.5 && face <= USER.workArea.y + USER.workArea.height, `${heightM} m at ${depth} m: her head in the work area (crown ${crown.toFixed(0)}, face ${face.toFixed(0)})`);
      if (depth <= band.closeDepthM) assert.equal(eye, body.faceM, 'close: the eye at her face');
    }
    assert.ok(maxStep < 0.0015, `${heightM} m: no step along the depth (largest per mm ${maxStep})`);
    rows.push(`${heightM} m: fit ${band.fitDepthM.toFixed(2)} m, close ${band.closeDepthM.toFixed(2)} m, largest eye change per mm ${(maxStep * 1000).toFixed(2)} mm`);
  }
  // Before and after for a 1.6 m figure (the floor-line record's table): feet against the line.
  const body = { heightM: 1.597, faceM: 1.468 };
  for (const depth of [0.6, 1.2, 2, 3, 4, 5, 6.6, 7, 8, 10, 12.5]) {
    const before = dipAt(world, world.eyeHeightM, 0, depth) - LINE, eye = framedEyeHeight(g, depth, body), after = dipAt(world, eye, 0, depth) - LINE;
    rows.push(`depth ${depth} m: eye ${world.eyeHeightM.toFixed(2)} → ${eye.toFixed(2)} m; soles ${before.toFixed(0)} → ${after.toFixed(0)} DIP from the line; crown at ${dipAt(world, eye, body.heightM, depth).toFixed(0)} DIP`);
  }
  // The crown band is needed: with only the floor band her head leaves the top nearer than the fit depth.
  const band = framingBand(g, 1.597)!, d2 = (band.fitDepthM + band.closeDepthM) / 2;
  assert.ok(dipAt(world, floorEyeHeight(g, d2), 1.597, d2) < 0, 'feet on the line at 2 m would cut her head off');
  assert.ok(Math.abs(crownEyeHeight(g, band.fitDepthM, 1.597) - floorEyeHeight(g, band.fitDepthM)) < 1e-9, 'the fit depth is where the two meet');
  if (REPORT) console.log(`FLOOR_FOLLOW bands\n${rows.join('\n')}`);
});

test('a jump in where she is (another model, another place, another screen) is bridged, never shown in one frame; a walk is followed exactly', () => {
  const world = worldOf(), camera = new WorldCamera(), framing = new FloorFraming(camera), g = framingGeometry(world)!;
  const body = { heightM: 1.597, faceM: 1.468 }, eyes: number[] = [];
  framing.step(0, world, 8, body.heightM, body.faceM);
  for (let i = 0; i < 60; i++) { framing.step(1 / 60, world, 8 - i * 0.7 / 60, body.heightM, body.faceM); eyes.push(framing.eyeHeightM!); }
  assert.ok(Math.abs(eyes.at(-1)! - framedEyeHeight(g, 8 - 59 * 0.7 / 60, body)) < 1e-9, 'walking: the eye is exactly the band\'s (her feet on the line)');
  framing.step(1 / 60, world, 3, body.heightM, body.faceM); eyes.push(framing.eyeHeightM!); // another place at once
  for (let i = 0; i < 180; i++) { framing.step(1 / 60, world, 3, body.heightM, body.faceM); eyes.push(framing.eyeHeightM!); }
  assert.ok(Math.abs(eyes[60] - eyes[59]) < 0.004 && unexpected(eyes.slice(58)) < 0.004, `the jump eases in (first step ${Math.abs(eyes[60] - eyes[59])} m, unexpected ${unexpected(eyes.slice(58))} m per frame)`);
  assert.ok(Math.abs(eyes.at(-1)! - framedEyeHeight(g, 3, body)) < 0.002, 'and arrives');
  const bigger = { ...world, viewerDistanceM: 0.8 }; // the viewer distance knob: the geometry changes under her
  const before = framing.eyeHeightM!;
  framing.step(1 / 60, bigger, 3, body.heightM, body.faceM);
  assert.ok(Math.abs(framing.eyeHeightM! - before) < 0.01, 'a new world: from where the eye was');
  // Before her first frame the page draws the scene's own eye (the placeholder, then the host's).
  const fresh = new FloorFraming(new WorldCamera());
  assert.equal(fresh.world(placeholderWorld(800, 600)).eyeHeightM, 1.4);
  assert.equal(fresh.eyeHeightM, null);
});

// ---- real models in the real frame loop ---------------------------------------------------------------------------------------------
type Kind = 'Gene (reviewed)' | 'Gene as another PMX' | 'a VRM (synthetic)';
async function standClip(mesh: SkinnedMesh, transform?: VmdDataTransform): Promise<AnimationClip> {
  const bytes = await readFile(STAND_VMD);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, transform);
  const clip = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(v: unknown, m: SkinnedMesh): AnimationClip } }).animationBuilder.build(vmd, mesh);
  clip.duration = Math.max(clip.duration, 4); return clip;
}
async function load(kind: Kind) {
  if (kind === 'a VRM (synthetic)') { const b = await syntheticStandardBody('1.0'); return { mesh: b.mesh, transform: b.transform, drawn: b.model.object as { updateMatrixWorld(force: boolean): void }, present: () => b.present(), close: () => b.dispose() }; }
  const fx = await loadPublicGeneForTargets();
  const transform = kind === 'Gene as another PMX' ? new StageMotionRetarget(fx.mesh, new StageModelProfile(fx.mesh, { reviewed: false }).profile, { reviewed: false }).transform : undefined;
  return { mesh: fx.mesh, transform, drawn: fx.mesh as { updateMatrixWorld(force: boolean): void }, present: () => {}, close: () => fx.close() };
}

const STOPS = [6.6, 5, 4, 10] as const;
async function walkAround(kind: Kind, fps: number) {
  const model = await load(kind), world = worldOf(), camera = new WorldCamera(), framing = new FloorFraming(camera);
  const place = world.placement, figure = new UnboundFigure(model.mesh, place);
  const old = new WorldCamera(); applyWorldCamera(old, world); // the fixed eye, as before
  try {
    figure.setClips({ pose: await standClip(model.mesh, model.transform), gesture: null, expression: null }, false);
    figure.setGait({ speedMps: 1.2, stepLengthM: 0.4 });
    framing.apply(world);
    const stands: { depth: number; feet: number; before: number; crown: number }[] = [], eyes: number[] = [], roots: number[] = [], rootLine: number[] = [];
    let stop = -1, arrived: number | null = null;
    const dt = 1 / fps, limit = Math.round(fps * 60);
    for (let frame = 0; frame <= limit; frame++) {
      const t = frame * dt;
      figure.frame(frame ? dt : 0); model.present();
      framing.follow(frame ? dt : 0, world, figure); // as the page: after her body's frame, before anything draws
      eyes.push(framing.eyeHeightM ?? world.eyeHeightM); roots.push(-figure.rootM.z);
      const depth = -figure.rootM.z;
      if (figure.walking) rootLine.push(dipY(camera, world, { x: figure.rootM.x, y: 0, z: figure.rootM.z }) - LINE);
      const target = stop < 0 ? place.depthM : STOPS[stop];
      const still = t > 2.5 && !figure.walking && Math.abs(depth - target) < 0.08;
      if (still) arrived ??= t; else arrived = null;
      if (arrived !== null && t - arrived >= 1.5) {
        model.drawn.updateMatrixWorld(true);
        const box = new Box3().setFromObject(model.drawn as never, true), sole = box.min.y / U, top = box.max.y / U;
        stands.push({ depth, feet: dipY(camera, world, { x: figure.rootM.x, y: sole, z: figure.rootM.z }) - LINE,
          before: dipY(old, world, { x: figure.rootM.x, y: sole, z: figure.rootM.z }) - LINE, crown: dipY(camera, world, { x: figure.rootM.x, y: top, z: figure.rootM.z }) });
        stop++; arrived = null;
        if (stop >= STOPS.length) break;
        figure.followTo({ x: figure.rootM.x, z: -STOPS[stop] });
      }
    }
    return { stands, eyes, roots, rootLine, heightM: figure.heightM };
  } finally { figure.dispose(); model.close(); }
}

for (const [kind, fpsList] of [['Gene (reviewed)', [60, 30]], ['Gene as another PMX', [60]], ['a VRM (synthetic)', [60, 30]]] as const) {
  for (const fps of fpsList) {
    test(`${kind} (${fps} fps): standing at 8, 6.6, 5, 4 and 10 m her lowest drawn point is on the floor line; walking, the eye never jumps`, async () => {
      const run = await walkAround(kind, fps);
      assert.equal(run.stands.length, STOPS.length + 1, `she reached every place (${run.stands.map(s => s.depth.toFixed(2)).join(', ')})`);
      for (const s of run.stands) {
        assert.ok(Math.abs(s.feet) < 2, `${kind} at ${s.depth.toFixed(2)} m: soles ${s.feet.toFixed(1)} DIP from the line`);
        assert.ok(s.crown > USER.workArea.y, `${kind} at ${s.depth.toFixed(2)} m: her crown is on the screen (${s.crown.toFixed(0)})`);
      }
      const eyeSurprise = unexpected(run.eyes) * 100, rootSurprise = unexpected(run.roots) * 100;
      // The eye is a smooth function of her depth (slope at most 0.25 m per m in the floor band), so it is never rougher than her root.
      assert.ok(eyeSurprise <= rootSurprise * 0.3 + 0.002, `eye unexpected step ${eyeSurprise.toFixed(4)} cm vs her root's ${rootSurprise.toFixed(4)} cm`);
      assert.ok(run.rootLine.every(v => Math.abs(v) < 0.5), `walking, her root stays on the line (worst ${Math.max(...run.rootLine.map(Math.abs)).toFixed(2)} DIP)`);
      if (REPORT) console.log(`FLOOR_FOLLOW ${kind} ${fps} fps: height ${run.heightM.toFixed(3)} m; ` + run.stands.map(s => `${s.depth.toFixed(2)} m: soles ${s.before.toFixed(0)} → ${s.feet.toFixed(1)} DIP, crown ${s.crown.toFixed(0)}`).join('; ') +
        `; eye step max ${(steps(run.eyes) * 100).toFixed(3)} cm, eye unexpected ${eyeSurprise.toFixed(4)} cm (root ${rootSurprise.toFixed(4)} cm)`);
    });
  }
}

// ---- the close-up: a peek from home ---------------------------------------------------------------------------------------------------
async function peekFromHome(fps: number, follow: boolean) {
  const fx = await loadPublicGeneForTargets(), world = worldOf(), camera = new WorldCamera(), framing = new FloorFraming(camera);
  const figure = new UnboundFigure(fx.mesh, world.placement), director = new Director([PEEK_LENS], new ProceduralGenerator(), () => {});
  let r = 0.37; const random = () => { r = (r * 9301 + 49297) % 233280 / 233280; return r; };
  const plan = planPeek(CURIOUS, random), home = { x: world.placement.xM, z: -world.placement.depthM };
  try {
    figure.setClips({ pose: await standClip(fx.mesh), gesture: null, expression: null }, false);
    let frustum: Frustum = follow ? framing.apply(world) : applyWorldCamera(camera, world);
    const held: { off: number; along: number; fill: number }[] = [], eyes: number[] = [], roots: number[] = [];
    for (let frame = 0; frame <= fps * 60; frame++) {
      const dt = frame ? 1 / fps : 0;
      const lens = lensView({ x: camera.position.x / U, y: camera.position.y / U, z: camera.position.z / U }, frustum);
      if (frame === Math.round(fps)) director.command({ type: 'start', id: 'floor-peek', plan, trial: false, armAfterMs: 0 }, { lens, home });
      director.frame(dt, { lens, home }, figure);
      figure.frame(dt);
      if (follow) frustum = framing.follow(dt, world, figure) ?? frustum;
      eyes.push(camera.position.y / U); roots.push(Math.hypot(figure.rootM.x, figure.rootM.z));
      const sense = figure.sense;
      if (director.phase === 'hold' && sense?.eyes.left && sense.eyes.right) {
        // I-192 follow-up: what the peek brings onto the axis (both eyes framed: the point between them; ARRIVAL_KNOBS.peekEyes = 1: the nearer eye).
        const both = eyePoint(sense.eyes, 'both')!, best = ARRIVAL_KNOBS.peekEyes >= 2 ? axisOffset(lens, both)
          : [sense.eyes.left, sense.eyes.right].map(e => axisOffset(lens, e)).sort((a, b) => a.off - b.off)[0];
        held.push({ ...best, fill: (sense.eyeSizeM ?? 0) / ((lens.heightPerM ?? 1) * Math.max(0.01, best.along)) });
      }
      if (frame > fps && !director.active) break;
    }
    return { held, eyes, roots, plan };
  } finally { figure.dispose(); fx.close(); }
}

test('the close-up: a peek from her home brings her eye onto the lens and fills the screen with it, the framing following her walk in (60 and 30 fps)', async () => {
  const before = await peekFromHome(60, false);
  for (const fps of [60, 30]) {
    const after = await peekFromHome(fps, true);
    assert.ok(after.held.length > fps, `she held the stare (${after.held.length} frames)`);
    const off = Math.max(...after.held.map(h => h.off)) * 100, fill = Math.min(...after.held.map(h => h.fill));
    assert.ok(off < 2, `${fps} fps: her eye stays on the axis while she stares (${off.toFixed(2)} cm off)`);
    assert.ok(fill > 0.3, `${fps} fps: one eye takes a good share of the screen's height (${fill.toFixed(2)})`);
    const eyeStep = steps(after.eyes) * 100, eyeSurprise = unexpected(after.eyes) * 100, rootSurprise = unexpected(after.roots) * 100;
    // Through the hand-over the eye moves up to about 0.9 m per m she walks: never rougher than her own walk.
    assert.ok(eyeSurprise <= rootSurprise + 0.002, `${fps} fps: the camera never jumps during the peek (unexpected ${eyeSurprise.toFixed(4)} cm vs her root's ${rootSurprise.toFixed(4)} cm, step ${eyeStep.toFixed(3)} cm)`);
    if (REPORT) {
      const b = before.held.length ? `${(Math.max(...before.held.map(h => h.off)) * 100).toFixed(1)} cm off, fill ${Math.min(...before.held.map(h => h.fill)).toFixed(2)}` : 'never held';
      console.log(`FLOOR_FOLLOW peek ${fps} fps: before (fixed eye ${before.eyes[0].toFixed(2)} m): ${b}; after: ${off.toFixed(2)} cm off, fill ${fill.toFixed(2)}, eye ${after.eyes[0].toFixed(2)} → ${Math.min(...after.eyes).toFixed(2)} m, step max ${eyeStep.toFixed(3)} cm, unexpected ${eyeSurprise.toFixed(4)} cm (root ${rootSurprise.toFixed(4)} cm)`);
    }
  }
});

// ---- a pull toward the camera -----------------------------------------------------------------------------------------------------------
async function pullIn(fps: number) {
  const fx = await loadPublicGeneForTargets(), world = worldOf(), camera = new WorldCamera(), framing = new FloorFraming(camera);
  const figure = new UnboundFigure(fx.mesh, world.placement);
  let clock = 0;
  const pulls = new UnboundPull({
    figure: () => figure, view: () => ({ camera, width: world.window.width, height: world.window.height }), eligible: () => true,
    send: async m => m.phase === 'start' ? parsePullAnswer({ accepted: true, stance: { willing: 0.6, compliance: 1, pace: 1, hesitateMs: 0, resist: 0 }, sleepy: 0 }) : undefined,
    clampX: xM => xM, clampDepth: clampFollowDepth, clock: () => clock,
  });
  try {
    figure.setClips({ pose: await standClip(fx.mesh), gesture: null, expression: null }, false);
    framing.apply(world);
    const eyes: number[] = [], roots: number[] = [], line: number[] = [];
    const chest = () => { fx.mesh.updateMatrixWorld(true); const bone = fx.mesh.skeleton.bones.find(b => b.name === '上半身2')!; const p = bone.getWorldPosition(new Vector3()).project(camera); return { x: (p.x + 1) / 2 * world.window.width, y: (1 - p.y) / 2 * world.window.height }; };
    let from: { x: number; y: number } | null = null;
    for (let frame = 0; frame <= fps * 14; frame++) {
      const t = frame / fps, dt = frame ? 1 / fps : 0; clock = t * 1000;
      if (t >= 2 && !from) { from = chest(); assert.ok(pulls.down(from.x, from.y), 'the press lands on her'); }
      if (from && pulls.active) { if (t < 9) pulls.move(from.x, from.y + 260 * Math.min(1, (t - 2) / 0.6)); else pulls.up(); }
      pulls.frame();
      await Promise.resolve(); await Promise.resolve();
      figure.frame(dt);
      framing.follow(dt, world, figure);
      eyes.push(camera.position.y / U); roots.push(-figure.rootM.z);
      line.push(dipY(camera, world, { x: figure.rootM.x, y: 0, z: figure.rootM.z }) - LINE);
    }
    return { eyes, roots, line };
  } finally { figure.dispose(); fx.close(); }
}

test('a pull toward the camera: she walks in, her feet stay on the line, the eye follows without a jump (60 and 30 fps)', async () => {
  for (const fps of [60, 30]) {
    const run = await pullIn(fps);
    const nearest = Math.min(...run.roots);
    assert.ok(nearest < 7, `${fps} fps: she came nearer (${nearest.toFixed(2)} m)`);
    assert.ok(run.line.every(v => Math.abs(v) < 0.5), `${fps} fps: her root on the line all the way (worst ${Math.max(...run.line.map(Math.abs)).toFixed(2)} DIP)`);
    const eyeSurprise = unexpected(run.eyes) * 100, rootSurprise = unexpected(run.roots) * 100;
    assert.ok(eyeSurprise <= rootSurprise * 0.3 + 0.002, `${fps} fps: eye unexpected ${eyeSurprise.toFixed(4)} cm vs root ${rootSurprise.toFixed(4)} cm`);
    if (REPORT) console.log(`FLOOR_FOLLOW pull ${fps} fps: 8 → ${nearest.toFixed(2)} m, eye ${run.eyes[0].toFixed(2)} → ${Math.min(...run.eyes).toFixed(2)} m, eye step max ${(steps(run.eyes) * 100).toFixed(3)} cm, unexpected ${eyeSurprise.toFixed(4)} cm (root ${rootSurprise.toFixed(4)} cm)`);
  }
});

test('I-203: a kiss may dip the eye a few centimetres (the viewer leaning in to meet her): eased in and out, never more than DIP_MAX_M, never upward', () => {
  const world = worldOf(), camera = new WorldCamera(), framing = new FloorFraming(camera), body = { heightM: 1.597, faceM: 1.468 }, eyes: number[] = [];
  framing.step(0, world, 0.6, body.heightM, body.faceM);
  const base = framing.eyeHeightM!;
  const run = (frames: number, dip: number) => { for (let i = 0; i < frames; i++) { framing.step(1 / 60, world, 0.6, body.heightM, body.faceM, dip); eyes.push(framing.eyeHeightM!); } };
  run(10, 0); run(120, 0.03); const held = framing.eyeHeightM!;
  assert.ok(Math.abs(base - held - 0.03) < 0.001, `the eye dips by what is asked (${base - held} m)`);
  run(120, 0.5); assert.ok(base - framing.eyeHeightM! <= DIP_MAX_M + 1e-9 && base - framing.eyeHeightM! > DIP_MAX_M - 0.002, 'never more than DIP_MAX_M');
  run(120, -1); assert.ok(Math.abs(framing.eyeHeightM! - base) < 0.001, 'never upward: a negative ask is none');
  run(1, 0.06); run(150, 0); // asked and dropped at once (a performance that ends mid-dip)
  const steps = eyes.slice(1).map((e, i) => Math.abs(e - eyes[i]));
  // The page asks rate-limited (close-moment.ts dipRateMps); even an ask that jumps 8 cm at once moves the eye a few mm per frame, eased.
  assert.ok(Math.max(...steps) < 0.006 && unexpected(eyes) < 0.003, `eased: never a jump (${Math.max(...steps)} m per frame, unexpected ${unexpected(eyes)} m)`);
});
