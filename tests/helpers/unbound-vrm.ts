// I-152 step 2: the synthetic VRM (tests/helpers/synthetic-vrm.ts, nothing from a real model) in Unbound's engine through the
// standard body (src/unbound/model/), the way the companion window's engine builds it: VRM loaded as it is (arms not lowered), the
// standard skeleton, the figure, the window body with the shipped idle. Frames record the VRM's OWN bones (what is drawn).
import { PerspectiveCamera, Quaternion, Texture, Vector3, type Bone } from 'three';
import { parseVrmModel } from '../../src/stage/model-adapter/vrm';
import { StandardBody } from '../../src/unbound/model/standard-body';
import { UnboundFigure } from '../../src/unbound/figure';
import { WindowBody } from '../../src/unbound/window-mode/window-body';
import { measureWindowModel } from '../../src/unbound/window-mode/window-model';
import { createBundledIdle } from '../../src/unbound/motion/bundled-idle';
import { cameraBasis, framingCamera, framingTopBand } from '../../src/stage';
import { shippedIdle } from './unbound-idle-stream';
import { syntheticVrm } from './synthetic-vrm';

/**
 * I-164: her window body on a synthetic VRM (`bytes`: syntheticVrm({ face: 'full' }) …) as the window stage builds it (window-model.ts
 * loadWindowModel): the measure (its painted blush) before her body moves, the figure at the origin, the window body with the shipped idle,
 * settled once (arms down), and the window camera framed on her standing bounds.
 */
export async function windowVrm(bytes: Uint8Array, seed = 7) {
  const standard = await syntheticStandardBody('1.0', bytes);
  const measure = measureWindowModel(standard.mesh, standard, false);
  const figure = new UnboundFigure(standard.mesh, { xM: 0, depthM: 0 });
  const idle = await shippedIdle();
  let s = seed; const random = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const body = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random, standard);
  await new Promise(resolve => setImmediate(resolve)); // the idle is made
  body.settle();
  const bounds = standard.measureShown(), WINDOW = { width: 420, height: 640 };
  const config = framingCamera('full', bounds, { aspect: WINDOW.width / WINDOW.height, fov: 32, topBand: framingTopBand(WINDOW.height, 0) });
  const camera = new PerspectiveCamera(config.fov, WINDOW.width / WINDOW.height, 0.1, 3000);
  const { forward } = cameraBasis(config), lift = figure.floorUnits;
  camera.position.set(config.targetX - forward.x * config.distance, config.targetY + lift - forward.y * config.distance, (config.targetZ ?? 0) - forward.z * config.distance);
  camera.lookAt(config.targetX, config.targetY + lift, config.targetZ ?? 0);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const bones = trackedBones(standard);
  const rotations = () => { standard.mesh.updateMatrixWorld(true); return bones.map(b => b.getWorldQuaternion(new Quaternion())); };
  const close = () => { measure.painter?.dispose(); body.dispose(); };
  return { standard, measure, figure, body, camera, bounds, window: WINDOW, rotations, close };
}

// three's glTF loader reads `self.URL` for embedded images (a browser global); node has the same URL on globalThis.
(globalThis as { self?: unknown }).self ??= globalThis;
const DEG = 180 / Math.PI;

/** No image decoding in node: every texture is an empty one, handed back at once. */
export const inertTextures = () => ({ load: (_url: string, onLoad?: (texture: Texture) => void) => { const texture = new Texture(); onLoad?.(texture); return texture; },
  setCrossOrigin() { return this; }, setRequestHeader() { return this; }, setPath() { return this; } }) as never;

export async function syntheticStandardBody(version: '1.0' | '0.x' = '1.0', bytes?: Uint8Array) {
  const loaded = await parseVrmModel(bytes ?? syntheticVrm({ version }), { textureLoader: inertTextures, relaxArms: false });
  return StandardBody.of(loaded);
}

/** The VRM's own bones the frames track: the same body chain as Gene's TRACKED (tests/helpers/unbound-gene.ts), hips first. */
export const VRM_TRACKED = ['hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm',
  'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'] as const;
const SLOT_OF: Record<typeof VRM_TRACKED[number], Parameters<StandardBody['model']['bone']>[0]> = {
  hips: 'lowerBody', spine: 'upperBody', chest: 'upperBody2', neck: 'neck', head: 'head', leftShoulder: 'shoulderLeft', rightShoulder: 'shoulderRight',
  leftUpperArm: 'armLeft', rightUpperArm: 'armRight', leftLowerArm: 'elbowLeft', rightLowerArm: 'elbowRight', leftUpperLeg: 'legLeft', rightUpperLeg: 'legRight',
  leftLowerLeg: 'kneeLeft', rightLowerLeg: 'kneeRight', leftFoot: 'ankleLeft', rightFoot: 'ankleRight',
};
export const trackedBones = (body: StandardBody): Bone[] => VRM_TRACKED.map(name => body.model.bone(SLOT_OF[name])!);

export interface VrmFrame { t: number; rotations: Quaternion[]; hips: Vector3; root: { x: number; z: number }; morphs: Record<string, number>; eyes: Quaternion[]; look: { yaw: number; pitch: number } }
export interface WindowScript { pat?: boolean; speaking?: boolean; pointer?: { x: number; y: number }; follow?: boolean }

/** Her window body on the synthetic VRM at `fps` for `seconds`; the morphs read are the synthetic face's (Fcl_*). */
export async function runVrmWindowBody(fps: number, seconds: number, script: (t: number) => WindowScript, options: { version?: '1.0' | '0.x'; seed?: number } = {}) {
  const body = await syntheticStandardBody(options.version ?? '1.0');
  const figure = new UnboundFigure(body.mesh, { xM: 0, depthM: 0 });
  const idle = await shippedIdle();
  let seed = options.seed ?? 7; const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const windowBody = new WindowBody(figure, async heightM => createBundledIdle(heightM, idle, 11), random, body);
  await new Promise(resolve => setImmediate(resolve)); // the idle is made
  const bones = trackedBones(body), eyes = body.eyes;
  const face = body.model.meshes.find(mesh => mesh.morphTargetDictionary?.Fcl_MTH_A !== undefined)!;
  const frames: VrmFrame[] = [];
  try {
    for (let frame = 0; frame <= Math.round(fps * seconds); frame++) {
      const t = frame / fps, input = script(t);
      if (input.speaking !== undefined) windowBody.setSpeaking(input.speaking);
      windowBody.frame(frame ? 1 / fps : 0, { pointer: input.pointer ?? { x: 0, y: 0 }, eyes: { x: 0, y: 0.3 }, follow: input.follow ?? true, pat: input.pat === true });
      body.mesh.updateMatrixWorld(true);
      const values = face.morphTargetInfluences!, dictionary = face.morphTargetDictionary!;
      frames.push({ t, rotations: bones.map(b => b.getWorldQuaternion(new Quaternion())), hips: bones[0].getWorldPosition(new Vector3()),
        root: { x: figure.placement.xM, z: figure.placement.depthM }, morphs: Object.fromEntries(Object.entries(dictionary).map(([name, i]) => [name, values[i]])),
        eyes: eyes.map(e => e.quaternion.clone()), look: { ...body.transfer.look } });
    }
  } finally { windowBody.dispose(); }
  return { frames, ...frameMetrics(frames) };
}

/** Per-frame step (deg, the largest of the tracked bones) and R29c's "unexpected step" over a time window. */
export function frameMetrics(frames: readonly { t: number; rotations: Quaternion[] }[]) {
  const step = (from: number, to: number) => frames.slice(1).flatMap((f, i) => f.t < from || f.t > to ? [] : [Math.max(...f.rotations.map((q, b) => q.angleTo(frames[i].rotations[b]) * DEG))]);
  const surprise = (from: number, to: number) => {
    const out: number[] = [], s = new Quaternion(), l = new Quaternion(), inv = new Quaternion();
    for (let i = 2; i < frames.length; i++) {
      if (frames[i].t < from || frames[i].t > to) continue;
      for (let b = 0; b < frames[i].rotations.length; b++) {
        s.copy(frames[i].rotations[b]).multiply(inv.copy(frames[i - 1].rotations[b]).invert());
        l.copy(frames[i - 1].rotations[b]).multiply(inv.copy(frames[i - 2].rotations[b]).invert());
        out.push(s.angleTo(l) * DEG);
      }
    }
    return out;
  };
  return { step, surprise };
}
