// I-192: a close pose (look closely, kiss, hug) in her real full-screen Unbound body, on every bundled model (the public Gene, the synthetic
// VRM through the standard body), through the real frame loop: MMDLoader / CCD IK, gait and contact owner, intent layer, the director with the
// peek and close-moment actions, the procedural generator, her arm reach; the page's own camera: the user's display (1536 × 960 DIP, a 48 DIP
// taskbar, viewed from 55 cm) with the floor framing following her (src/unbound/floor-framing.ts, whatever rule it has), and the near plane
// following her nearest point (src/unbound/camera.ts nearPlaneFor). Each frame records what was shown: tracked bones, root, head, eyes, the
// face's distance from the lens, the pucker, and (near the lens) her nearest drawn vertex of head, hair and arms ahead of the camera.
// Uses only what the page had before I-192 (so the same helper measures the code before and after).
import { readFile } from 'node:fs/promises';
import { Quaternion, Vector3, type AnimationClip, type Bone, type SkinnedMesh } from 'three';
import { MMDLoader } from 'three/examples/jsm/loaders/MMDLoader.js';
import { UnboundFigure, UNITS_PER_M } from '../../src/unbound/figure';
import { WorldCamera, nearPlaneFor } from '../../src/unbound/camera';
import { FloorFraming } from '../../src/unbound/floor-framing';
import { parseVmdWith, type VmdDataTransform } from '../../src/foundation/vmd';
import { withKeyframeInterpolation } from '../../src/stage/keyframe-interpolation';
import { capsuleEnds, measureBodyCapsules } from '../../src/foundation/body-capsules';
import { Director } from '../../src/unbound/director/director';
import { PEEK_LENS } from '../../src/unbound/director/peek-lens';
import { closeMomentAction } from '../../src/unbound/director/close-moment';
import { ProceduralGenerator } from '../../src/unbound/motion/procedural';
import { lensView, axisOffset, type LensView, type V3 } from '../../src/unbound/motion/lens-align';
import { faceAimNow } from '../../src/unbound/motion/arrive';
import { nearBodyOf, nearStations } from '../../src/unbound/pull-near';
import { planCloseMoment, type CloseMomentPlan } from '../../shared/unbound/close-moments';
import { NEUTRAL_MOOD, planPeek, type MoodReading, type PeekPhase, type PeekPlan } from '../../shared/unbound/director';
import { eyeHeightFor, resolvePhysicalScreen, type DisplayFacts, type Frustum } from '../../shared/unbound/world';
import { MORPH_ALIASES } from '../../shared/foundation/universal-skeleton';
import type { UnboundWorld } from '../../shared/unbound/scene';
import { loadPmxForTargets, loadPublicGeneForTargets } from '../public-gene-fixture';
import { parseVrmModel } from '../../src/stage/model-adapter/vrm';
import { StandardBody } from '../../src/unbound/model/standard-body';
import { measureWindowModel } from '../../src/unbound/window-mode/window-model';
import { STAND_VMD, TRACKED } from './unbound-gene';
import { inertTextures, syntheticStandardBody } from './unbound-vrm';
import { syntheticVrm } from './synthetic-vrm';

/** A bundled model, or (development only, never in the suite) a model file read from disk: a .vrm through the standard body, a .pmx retargeted as the page does. */
export type ArrivalModel = 'Gene' | 'VRM' | { file: string };
export const USER_DISPLAY: DisplayFacts = { bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 }, scaleFactor: 2.5, internal: true };
export const WARM: MoodReading = { ...NEUTRAL_MOOD, O: 78, E: 65, D: 60 };
export const CURIOUS: MoodReading = { D: 75, O: 62, E: 55, N: 50, C: 45, A: 0.2, B: 40, M: 10 };
const U = UNITS_PER_M;

export function userWorld(home: { xM: number; depthM: number }): UnboundWorld {
  const screen = resolvePhysicalScreen(USER_DISPLAY, null), d = 0.55;
  return { screen, display: { ...USER_DISPLAY.bounds }, workArea: { ...USER_DISPLAY.workArea }, window: { ...USER_DISPLAY.workArea }, mapping: 'physical', viewerDistanceM: d,
    eyeHeightM: eyeHeightFor(screen, USER_DISPLAY, d), placement: { ...home } };
}

async function standClip(mesh: SkinnedMesh, transform?: VmdDataTransform): Promise<AnimationClip> {
  const bytes = await readFile(STAND_VMD);
  const vmd = parseVmdWith(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, transform);
  const clip = (withKeyframeInterpolation(new MMDLoader()) as unknown as { animationBuilder: { build(v: unknown, m: SkinnedMesh): AnimationClip } }).animationBuilder.build(vmd, mesh);
  clip.duration = Math.max(clip.duration, 4); return clip;
}

/** Vertices to watch near the lens: each own mesh's vertices whose strongest bone is under her head (hair: under it but not the head or an eye) or her arms. */
interface Watched { mesh: SkinnedMesh; indices: Int32Array; hair: Uint8Array; arm: Uint8Array }
function watched(meshes: readonly SkinnedMesh[], head: Bone, eyes: readonly Bone[], shoulders: readonly Bone[]): Watched[] {
  const under = (root: Bone) => { const s = new Set<Bone>(); root.traverse(n => { if ((n as Bone).isBone) s.add(n as Bone); }); return s; };
  const headSet = under(head), arms = new Set<Bone>(shoulders.flatMap(b => [...under(b)])), own = new Set<Bone>([head, ...eyes]);
  return meshes.map(mesh => {
    const g = mesh.geometry, si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight'), out: number[] = [], hair: number[] = [], arm: number[] = [];
    if (si && sw && mesh.skeleton) for (let i = 0; i < si.count; i++) {
      let best = -1, w = 0;
      for (let k = 0; k < si.itemSize; k++) { const v = sw.getComponent(i, k); if (v > w) { w = v; best = si.getComponent(i, k); } }
      const bone = mesh.skeleton.bones[best];
      if (!bone) continue;
      if (headSet.has(bone)) { out.push(i); hair.push(own.has(bone) ? 0 : 1); arm.push(0); } else if (arms.has(bone)) { out.push(i); hair.push(0); arm.push(1); }
    }
    return { mesh, indices: Int32Array.from(out), hair: Uint8Array.from(hair), arm: Uint8Array.from(arm) };
  });
}

/**
 * Her nearest watched vertex ahead of the camera (m along −z), hair counted `hairSwingM` nearer (its physics may swing it forward); her arms'
 * alone, her head's alone, and the nearest of those inside the view (projected into the window, 5% padded): only those could be cut by the near plane.
 */
export interface Nearest { all: number; arms: number; face: number; view: number }
function nearestAhead(list: readonly Watched[], camera: WorldCamera, hairSwingM: number): Nearest {
  const p = new Vector3(), q = new Vector3(), cameraZ = camera.position.z;
  camera.updateMatrixWorld(true);
  let all = Infinity, arms = Infinity, face = Infinity, view = Infinity;
  for (const w of list) {
    for (let k = 0; k < w.indices.length; k++) {
      w.mesh.getVertexPosition(w.indices[k], p); w.mesh.localToWorld(p);
      const ahead = (cameraZ - p.z) / U - (w.hair[k] ? hairSwingM : 0);
      if (ahead < all) all = ahead;
      if (w.arm[k]) { if (ahead < arms) arms = ahead; } else if (ahead < face) face = ahead;
      if (ahead < view && cameraZ - p.z > 0) { q.copy(p).project(camera); if (Math.abs(q.x) <= 1.05 && Math.abs(q.y) <= 1.05) view = ahead; }
    }
  }
  return { all, arms, face, view };
}

export async function arrivalModel(kind: ArrivalModel) {
  if (typeof kind === 'object') return fileModel(kind.file);
  if (kind === 'VRM') {
    const b = await syntheticStandardBody('1.0', syntheticVrm({ face: 'full', lips: true, body: 'full' })); // a VRoid-like face and a body with volume
    const bone = (s: Parameters<typeof b.model.bone>[0]) => b.model.bone(s)!;
    return { mesh: b.mesh, transform: b.transform as VmdDataTransform | undefined, present: () => b.present(), close: () => b.dispose(), meshes: () => b.model.meshes as readonly SkinnedMesh[],
      watch: () => watched(b.model.meshes, bone('head'), [bone('eyeLeft'), bone('eyeRight')].filter(Boolean), [bone('shoulderLeft') ?? bone('armLeft'), bone('shoulderRight') ?? bone('armRight')].filter(Boolean)) };
  }
  const fx = await loadPublicGeneForTargets(), find = (n: string) => fx.mesh.skeleton.bones.find(b => b.name === n)!;
  return { mesh: fx.mesh, transform: undefined as VmdDataTransform | undefined, present: () => {}, close: () => fx.close(), meshes: () => [fx.mesh] as readonly SkinnedMesh[],
    watch: () => watched([fx.mesh], find('頭'), [find('左目'), find('右目')], [find('左肩'), find('右肩')]) };
}

/** Development (scripts and a local check, never the suite): a model file read only, inert textures. */
async function fileModel(file: string) {
  if (/\.vrm$/i.test(file)) {
    const b = StandardBody.of(await parseVrmModel(new Uint8Array(await readFile(file)), { textureLoader: inertTextures, relaxArms: false }));
    const bone = (s: Parameters<typeof b.model.bone>[0]) => b.model.bone(s)!;
    return { mesh: b.mesh, transform: b.transform as VmdDataTransform | undefined, present: () => b.present(), close: () => b.dispose(), meshes: () => b.model.meshes as readonly SkinnedMesh[],
      watch: () => watched(b.model.meshes, bone('head'), [bone('eyeLeft'), bone('eyeRight')].filter(Boolean), [bone('shoulderLeft') ?? bone('armLeft'), bone('shoulderRight') ?? bone('armRight')].filter(Boolean)) };
  }
  const fx = await loadPmxForTargets(file), find = (n: string) => fx.mesh.skeleton.bones.find(b => b.name === n) ?? null;
  const transform = measureWindowModel(fx.mesh, null, false).transform as VmdDataTransform | undefined;
  const head = find('頭')!, eyes = [find('左目'), find('右目')].filter((b): b is Bone => !!b), shoulders = [find('左肩') ?? find('左腕'), find('右肩') ?? find('右腕')].filter((b): b is Bone => !!b);
  return { mesh: fx.mesh, transform, present: () => {}, close: () => fx.close(), meshes: () => [fx.mesh] as readonly SkinnedMesh[], watch: () => watched([fx.mesh], head, eyes, shoulders) };
}

/** The pucker as her figure's mesh shows it: the largest of the 'u' and 'mouthPucker' slots' morphs (by the universal aliases). */
function puckerReader(mesh: SkinnedMesh): () => number {
  const dictionary = mesh.morphTargetDictionary ?? {}, keys = Object.keys(dictionary);
  const indices = (['u', 'mouthPucker'] as const).flatMap(slot => MORPH_ALIASES[slot].map(a => keys.find(k => k.toLowerCase() === a.toLowerCase())).filter((k): k is string => !!k).slice(0, 1).map(k => dictionary[k]));
  return () => Math.max(0, ...indices.map(i => mesh.morphTargetInfluences?.[i] ?? 0));
}

export interface ArrivalFrame {
  t: number; phase: PeekPhase | null; rotations: Quaternion[]; root: V3; head: V3 | null; eyes: { left: V3 | null; right: V3 | null };
  /** Lens to the midpoint of her eyes along the axis, and how far off it (m). */
  eyesAlong: number | null; eyesOff: number | null;
  /** Lens to her nearer eye (m), as the peek measures it. */
  eyeAlong: number | null;
  pucker: number; nearM: number; nearest: Nearest | null; cameraY: number;
  /** The lens this frame (the floor framing moves the camera with her). */
  lens: LensView;
  /** The window this frame per metre ahead of the camera (it looks straight down −z: x, y over the depth), and the camera (m). */
  view: { left: number; right: number; top: number; bottom: number; camera: V3 };
  /** Her mouth (the face measure's drop below her eyes, along her head's down), null when unknown. */
  mouth: V3 | null;
  /** I-203: how far the viewer's eye (the camera) has dipped for a kiss this frame (m). */
  cameraDipM: number;
}

/** Where a point is in the window: −1..1 across and up (inside when both are within ±1), and its depth ahead (m). */
export function inWindow(view: ArrivalFrame['view'], p: V3): { u: number; v: number; depth: number } {
  const depth = view.camera.z - p.z, x = (p.x - view.camera.x) / depth, y = (p.y - view.camera.y) / depth;
  return { u: (2 * x - view.left - view.right) / (view.right - view.left), v: (2 * y - view.top - view.bottom) / (view.top - view.bottom), depth };
}

/** The performance's own target (I-192; `framedM`, `arrived`, `waitS` from the follow-up: before them, absent). */
export interface ArrivalTarget { distanceM: number; clipped: boolean; framedM?: number; arrived?: boolean | null; waitS?: number }
export interface ArrivalRun { frames: ArrivalFrame[]; boneNames: string[]; plan: CloseMomentPlan | PeekPlan; heightM: number; holdS: number; target: ArrivalTarget | null; faceStationM: number | null }

/**
 * One close pose from her home (default 2 m back, 0.25 m right). `speaking(t)`: the held "she is speaking"; `inputAt`: a large pull at
 * that time (2026-11-23: the only input that ends a close pose; the mouse moving never does). `hairSwingM`: the allowance counted on her hair.
 */
export async function runArrival(model: ArrivalModel, fps: number, kind: 'kiss' | 'hug' | 'look', options: {
  seconds?: number; speaking?: (t: number) => boolean; inputAt?: number; home?: { xM: number; depthM: number }; hairSwingM?: number; measureNear?: boolean;
  /** Whether her arms can move (default: what the engine says for this model). */
  armsCan?: boolean;
  /** The reports the director sends (the host's view). */
  reports?: unknown[];
  /** The lens the director is handed (a test may make its window one she cannot fill); frames still record the real one. */
  lensPatch?: (lens: LensView) => LensView;
  /** The look's plan, changed (e.g. `{ eyeFill: 2 }`: the nearest the director ever asks). */
  peekPatch?: Partial<PeekPlan>;
  /** After each frame (a test can look at her posed mesh). */
  inspect?: (frame: ArrivalFrame, mesh: SkinnedMesh, camera: WorldCamera, figure: UnboundFigure, meshes: readonly SkinnedMesh[]) => void;
  /** I-203: a frame of her reply the host relays now (a let-go, a pause), asked after each frame; null: none. */
  relay?: (frame: ArrivalFrame) => { frame: 'let-go' | 'pause'; seconds: number } | null;
  /** 2026-11-25: whether her arms are free at `t` (default: always; her hand reach letting go keeps them a moment). */
  armsFree?: (t: number) => boolean;
} = {}): Promise<ArrivalRun> {
  const m = await arrivalModel(model), home = options.home ?? { xM: 0.25, depthM: 2 }, world = userWorld(home);
  const figure = new UnboundFigure(m.mesh, world.placement), camera = new WorldCamera(), framing = new FloorFraming(camera);
  let t = 0, lens: LensView | null = null;
  const hooks = {
    near: () => { const body = nearBodyOf(figure); return body && lens ? nearStations(lens, body) : null; },
    mouth: () => { const speaking = options.speaking?.(t) ?? false; return { mayStart: !speaking, speaking }; },
    armsFree: () => options.armsFree?.(t) ?? true,
    // As the page (her/out-page.ts armsCan): whether the engine can move her arms on this model; a test may say otherwise.
    armsCan: () => options.armsCan ?? (figure as { armsCan?: boolean }).armsCan ?? true,
  };
  const director = new Director([PEEK_LENS, closeMomentAction(hooks)], new ProceduralGenerator(), report => { options.reports?.push(report); });
  let r = 0.37; const random = () => { r = (r * 9301 + 49297) % 233280 / 233280; return r; };
  const plan = kind === 'look' ? { ...planPeek(CURIOUS, random), ...options.peekPatch } : planCloseMoment({ kind, after: 'grin', via: 'own', mood: WARM, label: 'close' }, () => 0.5);
  const capsules = measureBodyCapsules(m.mesh), ends: Vector3[] = [], watch = options.measureNear === false ? [] : m.watch(), pucker = puckerReader(m.mesh);
  const bones = TRACKED.map(name => m.mesh.skeleton.bones.find(b => b.name === name)).filter((b): b is Bone => !!b);
  const frames: ArrivalFrame[] = [], homeXZ = { x: home.xM, z: -home.depthM };
  let target: ArrivalTarget | null = null;
  try {
    figure.setClips({ pose: await standClip(m.mesh, m.transform), gesture: null, expression: null }, false);
    let frustum: Frustum = framing.apply(world), nearM = 0.05, faceStationM: number | null = null;
    for (let frame = 0; frame <= Math.round(fps * (options.seconds ?? 50)); frame++) {
      t = frame / fps;
      const dt = frame ? 1 / fps : 0;
      lens = lensView({ x: camera.position.x / U, y: camera.position.y / U, z: camera.position.z / U }, frustum);
      if (frame === 30) { faceStationM = hooks.near()?.faceDepthM ?? null; director.command({ type: 'start', id: 'arrival-test', plan, trial: false, armAfterMs: 0 }, { lens, home: homeXZ }); }
      if (options.inputAt !== undefined && t >= options.inputAt && t < options.inputAt + 1.5 / fps) director.yieldTo('pull'); // 2026-11-23: a large pull (the mouse moving never ends it)
      director.frame(dt, { lens: options.lensPatch?.(lens) ?? lens, home: homeXZ }, figure);
      figure.frame(dt); m.present();
      frustum = framing.follow(dt, world, figure, nearM, director.cameraDipM) ?? frustum; // I-203: as the page (a kiss may dip the eye)
      m.mesh.updateMatrixWorld(true); capsuleEnds(m.mesh, capsules, ends); // as the page's silhouette: a VRM's capsules ride its own bones
      const next = nearPlaneFor(ends, capsules.map(c => c.r), camera.position.z);
      if (Math.abs(next - nearM) > 1e-5) { nearM = next; frustum = framing.apply(world, nearM); }
      const sense = figure.sense!, phase = director.phase;
      const eyes = sense.eyes, mid = eyes.left && eyes.right ? { x: (eyes.left.x + eyes.right.x) / 2, y: (eyes.left.y + eyes.right.y) / 2, z: (eyes.left.z + eyes.right.z) / 2 } : null;
      const place = mid ? axisOffset(lens, mid) : null;
      const near1 = [eyes.left, eyes.right].filter((e): e is V3 => !!e).map(e => axisOffset(lens!, e).along);
      const close = phase === 'lean' || phase === 'hold' || phase === 'back';
      if (close) m.mesh.updateMatrixWorld(true); // every bone of hers (a VRM's own skeleton hangs under the standard mesh)
      frames.push({ t, phase, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), root: { x: figure.rootM.x, y: 0, z: figure.rootM.z }, head: sense.head, eyes: { ...eyes },
        eyesAlong: place?.along ?? null, eyesOff: place?.off ?? null, eyeAlong: near1.length ? Math.min(...near1) : null, pucker: pucker(), nearM,
        nearest: close && watch.length ? nearestAhead(watch, camera, options.hairSwingM ?? 0.025) : null, cameraY: camera.position.y / U, lens,
        view: { left: frustum.left / frustum.near, right: frustum.right / frustum.near, top: frustum.top / frustum.near, bottom: frustum.bottom / frustum.near, camera: { x: camera.position.x / U, y: camera.position.y / U, z: camera.position.z / U } },
        mouth: sense.face ? faceAimNow(eyes, sense.face.mouthDropM) : null, cameraDipM: framing.dipM });
      options.inspect?.(frames[frames.length - 1], m.mesh, camera, figure, m.meshes());
      const relayed = options.relay?.(frames[frames.length - 1]) ?? null; // I-203: as the host's frame command reaches the page
      if (relayed) director.command({ type: 'frame', id: 'arrival-test', frame: relayed.frame, seconds: relayed.seconds }, { lens, home: homeXZ });
      // The performance's own target (I-192 adds it; before, none): kept from the last frame it was there.
      target = (director as unknown as { performance: { target?: ArrivalTarget | null } | null }).performance?.target ?? target;
      if (frame > 30 && !director.active && t > 3) break;
    }
    return { frames, boneNames: bones.map(b => b.name), plan, heightM: figure.heightM, holdS: frames.filter(f => f.phase === 'hold').length / fps, target, faceStationM };
  } finally { figure.dispose(); m.close(); }
}

export const max = (xs: readonly number[]) => xs.reduce((a, b) => Math.max(a, b), 0);
/** Per-frame unexpected step (cm) of a tracked point. */
export function pointSurprises(points: readonly (V3 | null)[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < points.length; i++) {
    const a = points[i - 2], b = points[i - 1], c = points[i];
    if (a && b && c) out.push(Math.hypot(c.x - 2 * b.x + a.x, c.y - 2 * b.y + a.y, c.z - 2 * b.z + a.z) * 100);
  }
  return out;
}
/** R29c's unexpected step (deg) of every tracked bone, the largest per frame. */
export function boneSurprises(frames: readonly { rotations: Quaternion[] }[], only?: readonly number[]): number[] {
  const out: number[] = [], s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
  for (let i = 2; i < frames.length; i++) {
    let worst = 0;
    for (const b of only ?? frames[i].rotations.map((_, k) => k)) {
      s.copy(frames[i].rotations[b]).multiply(inv.copy(frames[i - 1].rotations[b]).invert());
      l.copy(frames[i - 1].rotations[b]).multiply(inv.copy(frames[i - 2].rotations[b]).invert());
      worst = Math.max(worst, s.angleTo(l) * 180 / Math.PI);
    }
    out.push(worst);
  }
  return out;
}
